/**
 * server/lib/api-tokens.js
 *
 * Personal access token management. Currently the sole consumer is the
 * MCP endpoint (/api/mcp) — tokens are SHA-256 hashed at rest. Raw
 * values are returned to the caller exactly once at creation; lookup
 * is hash-based.
 *
 * Token format: `ct_pat_<43 base64url chars>`. The `ct_pat_` prefix
 * makes leaked tokens recognizable in logs and credential scanners.
 */
import { randomBytes, createHash } from 'crypto';
import db from '../db.js';

const TOKEN_PREFIX = 'ct_pat_';
const TOKEN_BYTES = 32;  // 256-bit secret

/**
 * One-line human descriptions per scope, surfaced to the Settings UI so
 * admins picking scopes at token-creation time don't have to guess what
 * each grants. Kept next to KNOWN_SCOPES so the two stay in sync — a
 * scope registered here but missing from KNOWN_SCOPES (or vice versa)
 * is a bug the wiring test catches on load.
 */
export const SCOPE_DESCRIPTIONS = {
  'read:recipes': "Read the token owner's recipes catalog. Used by NutriTrace federation to search and import CookTrace recipes into NT's meals catalog.",
  'mcp:read':    'MCP: read recipes, pantry, shopping list, and cook diary (6 tools).',
  'mcp:write':   'MCP: log a cook, manage the shopping list, update pantry stock (4 additive tools). Requires MCP_WRITE_ENABLED=1 on the server.',
  'mcp:destroy': 'MCP: create recipes, add pantry items, delete diary entries and shopping items (4 tools). Requires MCP_DESTROY_ENABLED=1 AND every call to include confirm=true.',
};

export const KNOWN_SCOPES = new Set([
  // read:recipes unlocks GET /api/v1/recipes and GET /api/v1/recipes/:id.
  // Used by NutriTrace federation so NT can search and import CT recipes
  // into its meals catalog (same shape as NT's Mealie integration:
  // client-initiated pull, opens the picked recipe in NT's MealEditor as
  // is_recipe=1 with per-ingredient nutrition snapshots + rollup totals).
  'read:recipes',
  // mcp:read unlocks the Model Context Protocol read tools, exposed
  // under /api/mcp when MCP_ENABLED=1. Lets a user's own agent (Claude
  // Desktop / Cursor / Codex / etc.) inspect their recipes, pantry,
  // shopping list, and cook diary through the MCP standard interface.
  'mcp:read',
  // mcp:write unlocks MCP write tools (log_cook, add_shopping_item,
  // check_shopping_item, update_pantry_stock). Independent of mcp:read
  // but tokens typically hold both. Requires MCP_WRITE_ENABLED=1 on
  // the server for any effect.
  'mcp:write',
  // mcp:destroy unlocks MCP destructive tools (create_recipe,
  // add_pantry_item, delete_diary_entry, remove_shopping_item).
  // Requires MCP_DESTROY_ENABLED=1 on the server AND each destructive
  // tool call to include an explicit `confirm: true` argument. Kept
  // separate from mcp:write so an admin can grant "log stuff" without
  // granting "create/delete stuff".
  'mcp:destroy',
]);

function _hash(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function _generateRaw() {
  // base64url is URL-safe and slightly shorter than hex
  const bytes = randomBytes(TOKEN_BYTES);
  const b64 = bytes.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return TOKEN_PREFIX + b64;
}

/**
 * Create a new token for a user.
 *
 * Returns { row, raw } where `raw` is the only place the plaintext
 * token ever exists. The caller is responsible for displaying it to
 * the user once and never logging it.
 */
export function createToken({ userId, name, scopes, expiresAt = null }) {
  if (!userId) throw new Error('userId required');
  const trimmedName = String(name || '').trim().slice(0, 80);
  if (!trimmedName) throw new Error('name required');

  // Validate scopes against known list. Drop unknowns silently rather
  // than throwing — forward-compatibility for clients that try to
  // request scopes from a future version.
  const requested = Array.isArray(scopes) ? scopes : [];
  const validScopes = requested.filter(s => KNOWN_SCOPES.has(String(s)));
  if (validScopes.length === 0) throw new Error('At least one valid scope required');

  const raw = _generateRaw();
  const hash = _hash(raw);
  const r = db.prepare(
    `INSERT INTO api_tokens (user_id, name, token_hash, scopes, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, trimmedName, hash, JSON.stringify(validScopes), expiresAt);

  const row = db.prepare(
    `SELECT id, user_id, name, scopes, expires_at, last_used_at, created_at
       FROM api_tokens WHERE id = ?`
  ).get(r.lastInsertRowid);
  return { row: _parseRow(row), raw };
}

/** List tokens for a user. Never returns the hash or raw value. */
export function listTokens(userId) {
  return db.prepare(
    `SELECT id, user_id, name, scopes, expires_at, last_used_at, created_at
       FROM api_tokens
      WHERE user_id = ?
      ORDER BY created_at DESC`
  ).all(userId).map(_parseRow);
}

/** Revoke a token. Returns true if a row was removed. */
export function revokeToken({ userId, id }) {
  const r = db.prepare(
    `DELETE FROM api_tokens WHERE id = ? AND user_id = ?`
  ).run(id, userId);
  return r.changes > 0;
}

/**
 * Look up a token by its raw value. Returns the joined { token, user }
 * row or null. Updates last_used_at on a successful match.
 */
export function lookupRawToken(raw) {
  if (!raw || typeof raw !== 'string' || !raw.startsWith(TOKEN_PREFIX)) return null;
  const hash = _hash(raw);
  const row = db.prepare(
    `SELECT t.id, t.user_id, t.name, t.scopes, t.expires_at, t.last_used_at, t.created_at,
            u.username, u.full_name, u.role
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`
  ).get(hash);
  if (!row) return null;

  // Expiry check
  if (row.expires_at) {
    const expiresMs = new Date(row.expires_at + 'Z').getTime();
    if (Number.isFinite(expiresMs) && expiresMs < Date.now()) return null;
  }

  // Touch last_used_at (best-effort; not in a transaction with the read)
  try {
    db.prepare(`UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
  } catch {}

  return {
    token: {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      scopes: _parseScopes(row.scopes),
      expires_at: row.expires_at,
      last_used_at: row.last_used_at,
      created_at: row.created_at,
    },
    user: {
      id: row.user_id,
      username: row.username,
      full_name: row.full_name,
      role: row.role,
    },
  };
}

function _parseRow(row) {
  if (!row) return null;
  return { ...row, scopes: _parseScopes(row.scopes) };
}

function _parseScopes(s) {
  try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
