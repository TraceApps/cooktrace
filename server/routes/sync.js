/**
 * sync.js — Differential push / pull for the Capacitor native app.
 *
 * The native app keeps a full local SQLite copy of every domain table
 * (db-native.js + api-native.js). When a server URL is configured,
 * local writes mark rows sync_status='pending' and the client-side
 * orchestrator (src/lib/sync.js) periodically reconciles via these
 * endpoints.
 *
 * Contract (kept close to NutriTrace's so the orchestrator pattern
 * ports without surgery):
 *
 *   POST /api/sync/push
 *     body: { tables: { [name]: [row, ...] }, settings: [{ key, value, updated_at }] }
 *     row shape: { client_id, server_id?, ...table-columns, updated_at, deleted_at }
 *     response: { tables: { [name]: [{ client_id, server_id }] } }
 *
 *   GET /api/sync/pull?since=<ISO>
 *     response: { now: 'ISO', tables: { [name]: [{ id, ...cols, updated_at, deleted_at }] } }
 *
 * Tables handled: recipes, pantry_items, cook_diary, shopping_list,
 * recipe_categories, pantry_categories, custom_units, cookbooks,
 * recipe_comments, ai_chat_history (structural) plus disabled_units +
 * recipe_cookbook_links (replace-by-set) plus user_settings (key-value).
 *
 * FK translation on push: tables process in dependency order so parent
 * client_id → server_id mappings are available by the time child rows
 * (cook_diary.recipe_id, shopping_list.pantry_id, etc.) are written.
 * On pull, parent tables arrive before children and the client side
 * translates FKs via `WHERE server_id = ?` lookups in db-native.
 */

import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const userClause = (u) => u == null ? 'user_id IS NULL' : 'user_id = ?';
const userArgs   = (u) => u == null ? [] : [u];

// ── Table specs ──────────────────────────────────────────────────────
// `cols` — columns the client may write. id / user_id / created_at /
//          sync_status / server_id are server-managed.
// `parents` — FK columns + the table they reference, used to rewrite
//             client-local ids into server ids during a push.
// `softDelete` — uses deleted_at instead of hard delete.
const TABLES = {
  recipe_categories: {
    cols: ['name', 'slug', 'color', 'sort_order'],
    parents: {},
    softDelete: false,
  },
  pantry_categories: {
    cols: ['name', 'slug', 'icon', 'color', 'sort_order', 'default_aisle'],
    parents: {},
    softDelete: false,
  },
  custom_units: {
    cols: ['abbr', 'full_name', 'category', 'sort_order'],
    parents: {},
    softDelete: false,
  },
  cookbooks: {
    cols: ['name', 'slug', 'description', 'cover_image_url', 'is_smart', 'smart_filter_json', 'sort_order'],
    parents: {},
    softDelete: true,
  },
  recipes: {
    cols: [
      'name', 'description', 'img_url', 'servings', 'prep_minutes', 'cook_minutes', 'total_minutes', 'rest_minutes',
      'ingredients', 'steps', 'tags', 'tools', 'source_url', 'video_url', 'notes',
      'visibility', 'rating', 'yield_text', 'last_cooked_at', 'cook_count',
      'nutrition', 'favorite', 'category_id', 'share_token',
    ],
    parents: { category_id: 'recipe_categories' },
    softDelete: true,
  },
  pantry_items: {
    cols: [
      'name', 'brand', 'barcode', 'in_stock', 'quantity', 'unit', 'expires_on',
      'nt_food_id', 'img_url', 'notes', 'category', 'category_id',
      'serving_size', 'serving_unit', 'serving_label', 'nutrition', 'g_per_cup',
      // Variant feature (Issue #4). Both are FKs back into pantry_items;
      // declared here so the differential sync push includes them and
      // pull translates the server ids to local ids via the same
      // pantry_items lookup the shopping_list uses for pantry_id.
      'generic_parent_id', 'nutrition_source_variant_id',
    ],
    parents: {
      category_id: 'pantry_categories',
      generic_parent_id: 'pantry_items',
      nutrition_source_variant_id: 'pantry_items',
    },
    softDelete: true,
  },
  cook_diary: {
    cols: ['recipe_id', 'date', 'kind', 'servings', 'notes', 'photo_url', 'photos', 'meal_type', 'rating'],
    parents: { recipe_id: 'recipes' },
    softDelete: true,
  },
  shopping_list: {
    cols: ['name', 'quantity', 'unit', 'aisle', 'checked', 'pantry_id', 'recipe_id', 'sort_order'],
    parents: { pantry_id: 'pantry_items', recipe_id: 'recipes' },
    softDelete: true,
  },
  recipe_comments: {
    cols: ['recipe_id', 'parent_id', 'body'],
    parents: { recipe_id: 'recipes' },
    softDelete: true,
  },
  ai_chat_history: {
    cols: ['role', 'content'],
    parents: {},
    softDelete: false,
  },
};

// Process tables in dependency order so parents land first within a
// single push and child FKs can resolve against the freshly-minted ids.
const PUSH_ORDER = [
  'recipe_categories', 'pantry_categories', 'custom_units', 'cookbooks',
  'recipes', 'pantry_items',
  'cook_diary', 'shopping_list', 'recipe_comments',
  'ai_chat_history',
];

// ── POST /push ────────────────────────────────────────────────────────
router.post('/push', wrap((req, res) => {
  const u = uid(req);
  const tables = req.body?.tables || {};

  const idMaps = {};       // tableName → { client_id: server_id }
  const results = {};

  for (const name of PUSH_ORDER) {
    if (!Array.isArray(tables[name])) { results[name] = []; continue; }
    const spec = TABLES[name];
    const rows = tables[name];
    idMaps[name] = idMaps[name] || {};
    results[name] = [];

    const insertSql = _buildInsertSql(name, spec);
    const updateSql = _buildUpdateSql(name, spec);

    const txn = db.transaction(() => {
      for (const row of rows) {
        const translated = _translateParents(row, spec, idMaps);
        const values = spec.cols.map(c => _coerce(translated[c]));

        if (row.server_id) {
          const existing = db.prepare(
            `SELECT id, user_id FROM ${name} WHERE id = ?`
          ).get(row.server_id);
          if (!existing) continue;
          if ((u == null && existing.user_id != null) || (u != null && existing.user_id !== u)) continue;
          db.prepare(updateSql).run(
            ...values,
            translated.updated_at || _now(),
            spec.softDelete ? (translated.deleted_at ?? null) : null,
            row.server_id
          );
          results[name].push({ client_id: row.client_id, server_id: row.server_id });
          idMaps[name][row.client_id] = row.server_id;
        } else {
          const info = db.prepare(insertSql).run(
            u,
            ...values,
            translated.updated_at || _now(),
            spec.softDelete ? (translated.deleted_at ?? null) : null
          );
          const serverId = info.lastInsertRowid;
          results[name].push({ client_id: row.client_id, server_id: serverId });
          idMaps[name][row.client_id] = serverId;
        }
      }
    });
    try { txn(); }
    catch (e) { results[name] = { error: e.message || 'push failed' }; }
  }

  // ── disabled_units: replace-by-set ────────────────────────────────
  if (Array.isArray(tables.disabled_units)) {
    const txn = db.transaction(() => {
      db.prepare(`DELETE FROM disabled_units WHERE ${userClause(u)}`).run(...userArgs(u));
      const ins = db.prepare(`INSERT OR IGNORE INTO disabled_units (user_id, abbr) VALUES (?, ?)`);
      for (const r of tables.disabled_units) ins.run(u, r.abbr);
    });
    try { txn(); } catch {}
  }

  // ── recipe_cookbook_links: translate FKs, replace per cookbook ────
  if (Array.isArray(tables.recipe_cookbook_links)) {
    const translated = tables.recipe_cookbook_links.map(r => ({
      cookbook_id: idMaps.cookbooks?.[r.cookbook_id] || r.cookbook_id,
      recipe_id:   idMaps.recipes?.[r.recipe_id]   || r.recipe_id,
      sort_order:  r.sort_order ?? 0,
    })).filter(r => r.cookbook_id && r.recipe_id);
    const cookbookIds = [...new Set(translated.map(r => r.cookbook_id))];
    const txn = db.transaction(() => {
      if (cookbookIds.length) {
        const ph = cookbookIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM recipe_cookbook_links WHERE cookbook_id IN (${ph})`).run(...cookbookIds);
      }
      const ins = db.prepare(
        `INSERT OR IGNORE INTO recipe_cookbook_links (cookbook_id, recipe_id, sort_order) VALUES (?, ?, ?)`
      );
      for (const r of translated) ins.run(r.cookbook_id, r.recipe_id, r.sort_order);
    });
    try { txn(); } catch {}
  }

  // ── user_settings: key-value, server-side already has its own table.
  if (Array.isArray(req.body?.settings)) {
    const ins = db.prepare(
      `INSERT INTO user_settings (user_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    );
    const txn = db.transaction(() => {
      for (const s of req.body.settings) {
        ins.run(u, s.key, typeof s.value === 'string' ? s.value : JSON.stringify(s.value), s.updated_at || _now());
      }
    });
    try { txn(); } catch {}
  }

  res.json({ tables: results });
}));

// ── GET /pull ─────────────────────────────────────────────────────────
router.get('/pull', wrap((req, res) => {
  const u = uid(req);
  const since = (typeof req.query.since === 'string' && req.query.since) || '1970-01-01T00:00:00';
  const now = _now();

  const out = {};
  for (const [name, spec] of Object.entries(TABLES)) {
    const cols = ['id', ...spec.cols, 'updated_at'];
    if (spec.softDelete) cols.push('deleted_at');
    // Sort self-referencing tables so parents come before children in
    // the pull payload. The client's dbApplyPull scans server_id →
    // local_id fresh for each row, so a parent that arrives before its
    // child is available for FK translation on the child. Without
    // this ordering, a variant row that lands before its generic
    // parent in the payload would translate the parent FK to null and
    // the relationship silently disappears on the first sync after
    // it was attached (SQLite orders NULLs first in ASC by default,
    // so top-level parents naturally lead).
    const selfRef = Object.entries(spec.parents || {})
      .find(([, parentTable]) => parentTable === name);
    const orderBy = selfRef ? ` ORDER BY ${selfRef[0]} ASC, id ASC` : '';
    out[name] = db.prepare(
      `SELECT ${cols.join(', ')} FROM ${name}
        WHERE ${userClause(u)} AND updated_at > ?${orderBy}`
    ).all(...userArgs(u), since);
  }

  // Replace-sets: small enough to ship in full every pull.
  out.disabled_units = db.prepare(
    `SELECT abbr FROM disabled_units WHERE ${userClause(u)}`
  ).all(...userArgs(u));
  out.recipe_cookbook_links = db.prepare(
    `SELECT l.cookbook_id, l.recipe_id, l.sort_order
       FROM recipe_cookbook_links l
       JOIN cookbooks c ON c.id = l.cookbook_id
      WHERE ${userClause(u).replace(/user_id/g, 'c.user_id')}`
  ).all(...userArgs(u));

  // Settings: only the keys that changed since the last pull.
  out.settings = db.prepare(
    `SELECT key, value, updated_at FROM user_settings
      WHERE ${userClause(u)} AND updated_at > ?`
  ).all(...userArgs(u), since);

  res.json({ now, tables: out });
}));

// ── Helpers ──────────────────────────────────────────────────────────

function _now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function _coerce(v) {
  if (v === undefined) return null;
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return v;
}

function _translateParents(row, spec, idMaps) {
  if (!spec.parents) return row;
  const out = { ...row };
  for (const [fk, parentTable] of Object.entries(spec.parents)) {
    const raw = out[fk];
    if (raw == null) continue;
    const map = idMaps[parentTable];
    if (map && map[raw]) out[fk] = map[raw];
    // else: leave as-is. If the FK matches an existing server row it'll
    // resolve; otherwise the column either accepts NULL via ON DELETE
    // SET NULL semantics or surfaces a constraint error the client
    // retries on next sync.
  }
  return out;
}

function _buildInsertSql(table, spec) {
  const cols = ['user_id', ...spec.cols, 'updated_at'];
  if (spec.softDelete) cols.push('deleted_at');
  const ph = cols.map(() => '?').join(', ');
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph})`;
}

function _buildUpdateSql(table, spec) {
  // FK columns keep the server's value when the client pushes NULL.
  // The client always sends its full row (SELECT * on pending rows),
  // so a mobile push whose local row hasn't yet picked up a PWA-side
  // attach would clobber the server's newly-set FK with NULL. COALESCE
  // preserves the server's value unless the client explicitly sends a
  // non-null. Detaches still go through the explicit PUT route
  // (server/routes/pantry.js), which uses body.X !== undefined
  // semantics and correctly writes NULL when asked.
  const fkCols = new Set(Object.keys(spec.parents || {}));
  const setCols = spec.cols.map(c => (
    fkCols.has(c) ? `${c} = COALESCE(?, ${c})` : `${c} = ?`
  ));
  setCols.push('updated_at = ?');
  if (spec.softDelete) setCols.push('deleted_at = ?');
  return `UPDATE ${table} SET ${setCols.join(', ')} WHERE id = ?`;
}

export default router;
