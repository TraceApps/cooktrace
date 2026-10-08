/**
 * units.js — server-side units catalog management.
 *
 * The 37 built-in cooking units live client-side in src/lib/units.js
 * and never change. This route surfaces just the per-user overlays:
 *   - which built-ins the user has hidden
 *   - which custom units the user has added
 *
 * Client merges the overlay into the built-in catalog at render time.
 */
import { Router } from 'express';
import db from '../db.js';
import { saveRow } from '../lib/rest-merge.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const userClause = (u) => u == null ? 'user_id IS NULL' : 'user_id = ?';
const userArgs   = (u) => u == null ? [] : [u];

// ── GET / — return the user's overlay ──────────────────────────────────
//   { disabled: ['tsp', 'gal', ...], custom: [{ id, abbr, full_name, category, sort_order }] }
router.get('/', wrap((req, res) => {
  const u = uid(req);
  const disabled = db.prepare(
    `SELECT abbr FROM disabled_units WHERE ${userClause(u)}`
  ).all(...userArgs(u)).map(r => r.abbr);
  const custom = db.prepare(
    `SELECT id, abbr, full_name, category, sort_order, synced_at
       FROM custom_units
      WHERE ${userClause(u)}
      ORDER BY sort_order ASC, abbr ASC`
  ).all(...userArgs(u));

  // Usage map — counts how many recipe ingredients reference each unit.
  // Keyed by lowercased abbr so the Manage hub can render a "12 uses"
  // pill next to any built-in OR custom unit. Stored as text on
  // recipe.ingredients JSON, so we parse once in a single pass.
  const usage = {};
  const recipeRows = db.prepare(
    `SELECT ingredients FROM recipes WHERE ${userClause(u)} AND deleted_at IS NULL`
  ).all(...userArgs(u));
  for (const row of recipeRows) {
    let groups = [];
    try { groups = JSON.parse(row.ingredients || '[]'); } catch {}
    for (const g of groups) {
      for (const it of (g.items || [])) {
        if (!it || !it.unit) continue;
        const k = String(it.unit).toLowerCase().trim();
        if (!k) continue;
        usage[k] = (usage[k] || 0) + 1;
      }
    }
  }

  res.json({ disabled, custom, usage });
}));

// ── PATCH /builtin/:abbr — toggle a built-in unit on/off ───────────────
// body: { disabled: true|false }
router.patch('/builtin/:abbr', wrap((req, res) => {
  const u = uid(req);
  const abbr = String(req.params.abbr || '').trim();
  if (!abbr) return res.status(400).json({ error: 'abbr required' });
  const disabled = req.body?.disabled === true;
  if (disabled) {
    db.prepare(
      `INSERT OR IGNORE INTO disabled_units (user_id, abbr) VALUES (?, ?)`
    ).run(u, abbr);
  } else {
    // user_id IS NULL needs a separate code path because parameterised
    // null doesn't equal-match in sqlite without IS.
    if (u == null) {
      db.prepare(`DELETE FROM disabled_units WHERE user_id IS NULL AND abbr = ?`).run(abbr);
    } else {
      db.prepare(`DELETE FROM disabled_units WHERE user_id = ? AND abbr = ?`).run(u, abbr);
    }
  }
  res.json({ ok: true, abbr, disabled });
}));

// ── POST / — create a custom unit ──────────────────────────────────────
router.post('/', wrap((req, res) => {
  const u = uid(req);
  const abbr      = (req.body?.abbr || '').toString().trim();
  const full_name = (req.body?.full_name || abbr).toString().trim();
  const category  = (req.body?.category || '').toString().trim() || null;
  if (!abbr) return res.status(400).json({ error: 'abbr required' });
  // Reject collisions with built-in abbreviations on the client side
  // would be cleaner, but defend here too — a custom unit with the same
  // abbr as a built-in would shadow it ambiguously.
  if (typeof req.body?.builtinAbbrs === 'string'
      && req.body.builtinAbbrs.split(',').includes(abbr)) {
    return res.status(409).json({ error: `"${abbr}" is already a built-in unit. Pick a different abbreviation.` });
  }
  const exists = db.prepare(
    `SELECT 1 FROM custom_units WHERE ${userClause(u)} AND abbr = ?`
  ).get(...userArgs(u), abbr);
  if (exists) return res.status(409).json({ error: `Custom unit "${abbr}" already exists.` });

  const maxOrder = db.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) AS m FROM custom_units WHERE ${userClause(u)}`
  ).get(...userArgs(u)).m;
  const result = db.prepare(
    `INSERT INTO custom_units (user_id, abbr, full_name, category, sort_order)
     VALUES (?, ?, ?, ?, ?)`
  ).run(u, abbr, full_name, category, maxOrder + 1);
  const row = db.prepare(
    `SELECT id, abbr, full_name, category, sort_order, synced_at FROM custom_units WHERE id = ?`
  ).get(result.lastInsertRowid);
  res.status(201).json(row);
}));

// ── PUT /:id — update a custom unit ────────────────────────────────────
router.put('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(
    `SELECT * FROM custom_units WHERE id = ? AND ${userClause(u)}`
  ).get(id, ...userArgs(u));
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const abbr      = req.body?.abbr      != null ? (String(req.body.abbr).trim()      || existing.abbr)      : existing.abbr;
  const full_name = req.body?.full_name != null ? (String(req.body.full_name).trim() || existing.full_name) : existing.full_name;
  const category  = req.body?.category  !== undefined
    ? (req.body.category ? String(req.body.category).trim() : null)
    : existing.category;

  saveRow('custom_units', id, existing, { abbr, full_name, category }, req.body?._sync);
  const row = db.prepare(
    `SELECT id, abbr, full_name, category, sort_order, synced_at FROM custom_units WHERE id = ?`
  ).get(id);
  res.json(row);
}));

// ── DELETE /:id — delete a custom unit ─────────────────────────────────
router.delete('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(
    `SELECT id FROM custom_units WHERE id = ? AND ${userClause(u)}`
  ).get(id, ...userArgs(u));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM custom_units WHERE id = ?`).run(id);
  res.json({ ok: true });
}));

export default router;
