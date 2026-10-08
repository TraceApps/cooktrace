/**
 * shopping.js — Shopping list endpoints.
 *
 * Items are user-scoped, optionally linked to a pantry_item. Adding a
 * recipe's missing ingredients (POST /from-recipe/:id) is the killer
 * flow; `/from-plan?from=X&to=Y` does the same for everything in the
 * planned cook diary in a date range.
 */
import { Router } from 'express';
import db from '../db.js';
import { stampFields } from '../lib/field-stamps.js';
import { saveRow } from '../lib/rest-merge.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { dispatchWebhookEvent } from '../lib/webhooks.js';
import { titleCaseName as _titleCaseName, aisleForPantry as _aisleForPantry } from '../lib/shopping-items.js';
import { ownId, linkableRecipeId } from '../lib/link-checks.js';
import { cleanCreateKey, findByCreateKey, setCreateKey } from '../lib/create-keys.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const userClause = (u) => u == null ? 'user_id IS NULL' : 'user_id = ?';
const userArgs   = (u) => u == null ? [] : [u];

function _hydrate(row) {
  if (!row) return null;
  return { ...row, checked: !!row.checked };
}

// ── GET / — list shopping items ────────────────────────────────────────
router.get('/', wrap((req, res) => {
  const u = uid(req);
  const rows = db.prepare(
    `SELECT s.*, p.name AS pantry_name, p.img_url AS pantry_img_url,
            r.name AS recipe_name
     FROM shopping_list s
     LEFT JOIN pantry_items p ON p.id = s.pantry_id AND p.user_id IS s.user_id
     LEFT JOIN recipes      r ON r.id = s.recipe_id AND r.deleted_at IS NULL
                           AND (r.user_id IS s.user_id OR EXISTS (SELECT 1 FROM recipe_shares rs WHERE rs.recipe_id = r.id AND rs.grantee_id = s.user_id))
     WHERE ${userClause(u).replace(/user_id/g, 's.user_id')} AND s.deleted_at IS NULL
     ORDER BY s.checked ASC,
              COALESCE(s.aisle, 'zzz') ASC,
              CASE WHEN s.sort_order IS NULL THEN 1 ELSE 0 END,
              s.sort_order ASC,
              s.name COLLATE NOCASE ASC`
  ).all(...userArgs(u));
  res.json(rows.map(_hydrate));
}));

// ── POST / — add an item ───────────────────────────────────────────────
router.post('/', wrap((req, res) => {
  const u = uid(req);
  // Sent before (Connect > Upload again, or an answer lost): the row made
  // then, not a second one (lib/create-keys.js).
  const createKey = cleanCreateKey(req.body?.client_key);
  const made = findByCreateKey('shopping_list', u, createKey);
  if (made) return res.json(_hydrate(made));
  const body = req.body || {};
  const name = (body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });

  // Auto-populate aisle when the caller didn't provide one but linked
  // a pantry item. Explicit body.aisle always wins so callers can force
  // a specific value; see _aisleForPantry for the fallback chain.
  let aisle = body.aisle && String(body.aisle).trim() ? String(body.aisle).trim() : null;
  // Links only to the account's own pantry item, and its own or a shared
  // recipe (lib/link-checks.js): anything else is no link.
  const pantryId = ownId('pantry_items', body.pantry_id, u);
  const recipeId = linkableRecipeId(body.recipe_id, u);
  if (aisle == null && pantryId) aisle = _aisleForPantry(pantryId, u);

  const result = db.prepare(
    `INSERT INTO shopping_list (user_id, name, quantity, unit, aisle, checked, pantry_id, recipe_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    u, _titleCaseName(name),
    body.quantity == null || body.quantity === '' ? null : Number(body.quantity),
    body.unit || null,
    aisle,
    body.checked ? 1 : 0,
    pantryId,
    recipeId,
  );
  setCreateKey('shopping_list', result.lastInsertRowid, createKey);
  const row = db.prepare(`SELECT * FROM shopping_list WHERE id = ?`).get(result.lastInsertRowid);
  res.status(201).json(_hydrate(row));
}));

// ── PUT /:id — update ──────────────────────────────────────────────────
router.put('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(`SELECT * FROM shopping_list WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if ((u == null && existing.user_id != null) || (u != null && existing.user_id !== u)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const body = req.body || {};
  // With _sync, merged with changes made elsewhere (lib/rest-merge.js).
  const { kept } = saveRow('shopping_list', id, existing, {
    name: body.name != null ? String(body.name).trim() || existing.name : existing.name,
    quantity: body.quantity !== undefined ? (body.quantity === '' || body.quantity == null ? null : Number(body.quantity)) : existing.quantity,
    unit: body.unit !== undefined ? (body.unit || null) : existing.unit,
    aisle: body.aisle !== undefined ? (body.aisle && String(body.aisle).trim() ? String(body.aisle).trim() : null) : existing.aisle,
    checked: body.checked !== undefined ? (body.checked ? 1 : 0) : existing.checked,
    pantry_id: body.pantry_id !== undefined ? ownId('pantry_items', body.pantry_id, u) : existing.pantry_id,
    sort_order: body.sort_order !== undefined ? (body.sort_order == null ? null : Number(body.sort_order)) : existing.sort_order,
  }, body._sync);
  const row = db.prepare(`SELECT * FROM shopping_list WHERE id = ?`).get(id);
  res.json({ ..._hydrate(row), ...(kept ? { kept: 'server' } : {}) });
}));

// ── DELETE /checked — clear all checked items at once ──────────────────
// MUST be declared before DELETE /:id, otherwise Express matches /:id
// with id='checked' and returns 'Invalid id' on the parseInt check.
router.delete('/checked', wrap((req, res) => {
  const u = uid(req);
  db.prepare(
    `UPDATE shopping_list SET deleted_at = datetime('now'), updated_at = datetime('now')
     WHERE ${userClause(u)} AND checked = 1 AND deleted_at IS NULL`
  ).run(...userArgs(u));
  res.json({ ok: true });
}));

// ── DELETE /by-recipe/:id — wipe every row from one recipe ──────────────
// Same static-before-:id ordering as /checked above. The Shopping UI's
// per-recipe trash icon hits this so the user can clear an entire
// recipe block in one shot. Returns `{ removed }` for the toast.
router.delete('/by-recipe/:id', wrap((req, res) => {
  const u = uid(req);
  const recipeId = parseInt(req.params.id, 10);
  if (!Number.isFinite(recipeId)) return res.status(400).json({ error: 'Invalid id' });
  const result = db.prepare(
    `UPDATE shopping_list
        SET deleted_at = datetime('now'), updated_at = datetime('now')
      WHERE ${userClause(u)} AND deleted_at IS NULL AND recipe_id = ?`
  ).run(...userArgs(u), recipeId);
  res.json({ removed: result.changes });
}));

// ── POST /reorder — bulk drag-drop apply ──────────────────────────────
// Client posts { items: [{id, aisle?, sort_order}, ...] } after a drag
// gesture. One transaction so a partial failure doesn't leave the list
// half-reordered. sort_order is the required primary field; aisle is
// optional so callers can also cross-group drag (drop into a different
// aisle) without a second round-trip.
router.post('/reorder', wrap((req, res) => {
  const u = uid(req);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.json({ updated: 0 });
  const txn = db.transaction(() => {
    let n = 0;
    for (const it of items) {
      const id = parseInt(it.id, 10);
      if (!Number.isFinite(id)) continue;
      const existing = db.prepare(
        `SELECT * FROM shopping_list WHERE id = ? AND ${userClause(u)} AND deleted_at IS NULL`
      ).get(id, ...userArgs(u));
      if (!existing) continue;
      const nextSort = it.sort_order == null ? null : Number(it.sort_order);
      const nextAisle = it.aisle !== undefined
        ? (it.aisle && String(it.aisle).trim() ? String(it.aisle).trim() : null)
        : existing.aisle;
      // Moving an item is an edit only when its aisle changes: a new place
      // in the list moves sort_order alone, stamped as changed now, and
      // leaves updated_at (lib/field-merge.js merges field by field).
      const aisleMoved = (existing.aisle ?? null) !== (nextAisle ?? null);
      const sortMoved = (existing.sort_order ?? null) !== (nextSort ?? null);
      if (!aisleMoved && !sortMoved) { n++; continue; }
      db.prepare(
        `UPDATE shopping_list
            SET sort_order = ?, aisle = ?${aisleMoved ? `, updated_at = datetime('now')` : ''}
          WHERE id = ?`
      ).run(nextSort, nextAisle, id);
      if (sortMoved && !aisleMoved) stampFields('shopping_list', id, ['sort_order']);
      n++;
    }
    return n;
  });
  const updated = txn();
  res.json({ updated });
}));

// ── DELETE /:id — soft delete ──────────────────────────────────────────
router.delete('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(`SELECT * FROM shopping_list WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if ((u == null && existing.user_id != null) || (u != null && existing.user_id !== u)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.prepare(`UPDATE shopping_list SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  res.json({ ok: true });
}));

// ── PATCH /:id/check — quick toggle ────────────────────────────────────
router.patch('/:id/check', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(`SELECT * FROM shopping_list WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if ((u == null && existing.user_id != null) || (u != null && existing.user_id !== u)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  saveRow('shopping_list', id, existing, { checked: req.body?.checked ? 1 : 0 }, req.body?._sync);
  const next = db.prepare(`SELECT checked FROM shopping_list WHERE id = ?`).get(id).checked;

  // Only a genuine 0-to-1 transition can newly complete the list; a
  // redundant re-check of an already-checked item (double-click, retry,
  // multi-tab) must not re-fire the webhook even though the aggregate
  // "fully checked" state still holds.
  if (next === 1 && existing.checked !== 1) {
    try {
      const where = u == null ? 'user_id IS NULL' : 'user_id = ?';
      const args = u == null ? [] : [u];
      const remaining = db.prepare(
        `SELECT COUNT(*) AS n FROM shopping_list WHERE ${where} AND deleted_at IS NULL AND checked = 0`
      ).get(...args);
      const total = db.prepare(
        `SELECT COUNT(*) AS n FROM shopping_list WHERE ${where} AND deleted_at IS NULL`
      ).get(...args);
      if (remaining.n === 0 && total.n > 0) {
        dispatchWebhookEvent(u, 'shopping_list.completed', { items_count: total.n });
      }
    } catch (e) { /* never let a webhook failure block the save */ }
  }

  res.json({ ok: true, checked: !!next });
}));

// ── POST /from-plan — bulk-add ingredients across a window of planned cooks ──
// Sweeps every cook_diary row with kind='planned' in the given date
// range (defaults: today → +7d), pulls each recipe's ingredient list,
// dedupes by name + unit (summing numeric qty when both sides have
// one), and inserts one shopping row per unique ingredient. Mirrors
// the optional `only_missing` filter on /from-recipe — skip any
// ingredient whose linked pantry_item is currently in stock.
router.post('/from-plan', wrap((req, res) => {
  const u = uid(req);
  // Date window — query params for parity with /from-recipe.
  const todayIso = new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : todayIso;
  let to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null;
  if (!to) {
    const d = new Date(); d.setDate(d.getDate() + 7);
    to = d.toISOString().slice(0, 10);
  }
  const onlyMissing = req.query.only_missing !== '0';

  // All planned cook_diary entries in the window — with their recipes.
  const userClauseDiary = userClause(u).replace(/user_id/g, 'cd.user_id');
  const planned = db.prepare(
    `SELECT cd.id AS diary_id, cd.recipe_id, r.name AS recipe_name, r.ingredients
     FROM cook_diary cd
     JOIN recipes r ON r.id = cd.recipe_id AND r.deleted_at IS NULL
     WHERE ${userClauseDiary} AND cd.deleted_at IS NULL
       AND cd.kind = 'planned'
       AND cd.date >= ? AND cd.date <= ?`
  ).all(...userArgs(u), from, to);

  if (planned.length === 0) {
    return res.json({ added: 0, planned_cooks: 0, from, to });
  }

  // Pantry in-stock set — same gate as /from-recipe.
  const stockSet = new Set(
    db.prepare(
      `SELECT id FROM pantry_items WHERE ${userClause(u)} AND in_stock = 1 AND deleted_at IS NULL`
    ).all(...userArgs(u)).map(r => r.id)
  );

  // Dedupe map. Key = lowercased name + '|' + (unit ?? '').
  // Value carries the running sum (or null if any contributor was
  // qty-less — can't meaningfully sum) and the first recipe_id we saw
  // so the grouped UI still slots the row under a recognisable recipe.
  const merged = new Map();
  for (const row of planned) {
    let groups = [];
    try { groups = JSON.parse(row.ingredients || '[]'); } catch {}
    for (const g of groups) {
      for (const it of (g.items || [])) {
        if (!it.name) continue;
        if (onlyMissing && it.pantry_item_id && stockSet.has(it.pantry_item_id)) continue;
        const name = String(it.name).trim();
        const unit = it.unit ? String(it.unit).trim() : '';
        const key = `${name.toLowerCase()}|${unit.toLowerCase()}`;
        const qtyN = Number(it.qty);
        const hasQty = it.qty != null && it.qty !== '' && Number.isFinite(qtyN);

        const prev = merged.get(key);
        if (!prev) {
          merged.set(key, {
            name,
            unit: unit || null,
            qty: hasQty ? qtyN : null,
            qtyHadNull: !hasQty,
            pantry_id: it.pantry_item_id || null,
            recipe_id: row.recipe_id,
          });
        } else {
          // Sum quantities only when every contributor has one. Once
          // any contributor lacks a qty the merged row becomes qty-less
          // ("flour" without a number is more honest than a wrong sum).
          if (prev.qtyHadNull || !hasQty) {
            prev.qty = null;
            prev.qtyHadNull = true;
          } else {
            prev.qty = (prev.qty || 0) + qtyN;
          }
          if (!prev.pantry_id && it.pantry_item_id) prev.pantry_id = it.pantry_item_id;
        }
      }
    }
  }

  if (merged.size === 0) {
    return res.json({ added: 0, planned_cooks: planned.length, from, to });
  }

  const insert = db.prepare(
    `INSERT INTO shopping_list (user_id, name, quantity, unit, aisle, pantry_id, recipe_id, checked)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  );
  let added = 0;
  const tx = db.transaction(() => {
    for (const row of merged.values()) {
      // A shared recipe's ingredients point at its owner's pantry: no link.
      const pantryId = ownId('pantry_items', row.pantry_id, u);
      const aisle = _aisleForPantry(pantryId, u);
      insert.run(u, _titleCaseName(row.name), row.qty, row.unit, aisle, pantryId, row.recipe_id);
      added++;
    }
  });
  tx();
  res.json({ added, planned_cooks: planned.length, from, to });
}));

// ── POST /from-recipe/:id — add this recipe's "out of stock" ingredients ──
router.post('/from-recipe/:id', wrap((req, res) => {
  const u = uid(req);
  const recipeId = parseInt(req.params.id, 10);
  if (!Number.isFinite(recipeId)) return res.status(400).json({ error: 'Invalid id' });

  const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(recipeId);
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });

  let ingredients = [];
  try { ingredients = JSON.parse(recipe.ingredients || '[]'); } catch {}
  // Flatten grouped ingredient JSON down to one list.
  const flat = [];
  for (const g of ingredients) for (const it of (g.items || [])) flat.push(it);

  const onlyMissing = req.query.only_missing !== '0';
  const stockSet = new Set(
    db.prepare(
      `SELECT id FROM pantry_items WHERE ${userClause(u)} AND in_stock = 1 AND deleted_at IS NULL`
    ).all(...userArgs(u)).map(r => r.id)
  );

  let added = 0;
  // Stamp recipe_id on every row so the client can render a small
  // recipe chip next to it and offer "remove all from this recipe".
  const insert = db.prepare(
    `INSERT INTO shopping_list (user_id, name, quantity, unit, aisle, pantry_id, recipe_id, checked)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  );
  const tx = db.transaction(() => {
    for (const it of flat) {
      if (!it.name) continue;
      if (onlyMissing && it.pantry_item_id && stockSet.has(it.pantry_item_id)) continue;
      // A shared recipe's ingredients point at its owner's pantry: no link.
      const pantryId = ownId('pantry_items', it.pantry_item_id, u);
      const aisle = _aisleForPantry(pantryId, u);
      insert.run(u, _titleCaseName(it.name), it.qty || null, it.unit || null, aisle, pantryId, recipeId);
      added++;
    }
  });
  tx();
  res.json({ added });
}));

export default router;
