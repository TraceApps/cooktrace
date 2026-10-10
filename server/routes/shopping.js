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
import { recipeContributions, mergeIntoList, parseSources } from '../lib/shopping-plan.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const userClause = (u) => u == null ? 'user_id IS NULL' : 'user_id = ?';
const userArgs   = (u) => u == null ? [] : [u];

// A note on an item: trimmed text, at most 500 characters, or none.
function _note(v) {
  const s = v == null ? '' : String(v).trim();
  return s ? s.slice(0, 500) : null;
}

function _hydrate(row) {
  if (!row) return null;
  return { ...row, checked: !!row.checked, sources: parseSources(row.sources) };
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
    `INSERT INTO shopping_list (user_id, name, quantity, unit, aisle, checked, pantry_id, recipe_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    u, _titleCaseName(name),
    body.quantity == null || body.quantity === '' ? null : Number(body.quantity),
    body.unit || null,
    aisle,
    body.checked ? 1 : 0,
    pantryId,
    recipeId,
    _note(body.notes),
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
    notes: body.notes !== undefined ? _note(body.notes) : existing.notes,
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

// Folds what a plan or a recipe adds into the account's list: amounts of the
// same ingredient add up across recipes and units of one kind (1 cup + 120
// ml), and each row keeps where its amount came from (lib/shopping-plan.js).
function _applyToList(u, contributions, opts) {
  const rows = db.prepare(
    `SELECT id, name, quantity, unit, checked, pantry_id, recipe_id, sources
       FROM shopping_list WHERE ${userClause(u)} AND deleted_at IS NULL`
  ).all(...userArgs(u));
  const plan = mergeIntoList(rows, contributions, opts);
  const insert = db.prepare(
    `INSERT INTO shopping_list (user_id, name, quantity, unit, aisle, pantry_id, recipe_id, sources, checked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
  );
  const update = db.prepare(
    `UPDATE shopping_list SET quantity = ?, unit = ?, sources = ?, pantry_id = COALESCE(?, pantry_id),
            updated_at = datetime('now') WHERE id = ?`
  );
  const remove = db.prepare(
    `UPDATE shopping_list SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  );
  db.transaction(() => {
    for (const r of plan.inserts) {
      // A shared recipe's ingredients point at its owner's pantry: no link.
      const pantryId = ownId('pantry_items', r.pantry_id, u);
      insert.run(u, _titleCaseName(r.name), r.quantity, r.unit, _aisleForPantry(pantryId, u),
        pantryId, linkableRecipeId(r.recipe_id, u), r.sources);
    }
    for (const r of plan.updates) {
      update.run(r.quantity, r.unit, r.sources, ownId('pantry_items', r.pantry_id, u), r.id);
    }
    for (const id of plan.deletes) remove.run(id);
  })();
  return { added: plan.inserts.length, updated: plan.updates.length, removed: plan.deletes.length };
}

function _inStockSet(u) {
  return new Set(
    db.prepare(
      `SELECT id FROM pantry_items WHERE ${userClause(u)} AND in_stock = 1 AND deleted_at IS NULL`
    ).all(...userArgs(u)).map(r => r.id)
  );
}

// ── POST /from-plan: the planned cooks of a date range onto the list ────
// Every cook_diary row with kind='planned' in the range (defaults: today
// to +7 days), each recipe scaled to the cook's servings. Building the
// same range again replaces its cooks' share instead of adding it twice;
// a cook no longer planned takes its share out. `only_missing` (default
// on) leaves out ingredients whose pantry item is in stock.
router.post('/from-plan', wrap((req, res) => {
  const u = uid(req);
  const todayIso = new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : todayIso;
  let to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null;
  if (!to) {
    const d = new Date(); d.setDate(d.getDate() + 7);
    to = d.toISOString().slice(0, 10);
  }
  const onlyMissing = req.query.only_missing !== '0';

  const planned = db.prepare(
    `SELECT cd.id AS diary_id, cd.date, cd.servings AS planned_servings,
            r.id, r.servings, r.ingredients
       FROM cook_diary cd
       JOIN recipes r ON r.id = cd.recipe_id AND r.deleted_at IS NULL
      WHERE ${userClause(u).replace(/user_id/g, 'cd.user_id')} AND cd.deleted_at IS NULL
        AND cd.kind = 'planned'
        AND cd.date >= ? AND cd.date <= ?`
  ).all(...userArgs(u), from, to);

  const stock = _inStockSet(u);
  const skip = it => onlyMissing && it.pantry_item_id && stock.has(it.pantry_item_id);
  const contributions = planned.flatMap(p => recipeContributions(p, {
    diaryId: p.diary_id, date: p.date, servings: p.planned_servings, skip,
  }));
  // Run even with nothing planned: cooks taken off the plan leave the list.
  const result = _applyToList(u, contributions, { window: { from, to } });
  res.json({ ...result, planned_cooks: planned.length, from, to });
}));

// ── POST /from-recipe/:id: a recipe's ingredients onto the list ─────────
// Scaled to ?servings= when given. `only_missing` (default on) leaves out
// ingredients whose pantry item is in stock.
router.post('/from-recipe/:id', wrap((req, res) => {
  const u = uid(req);
  const recipeId = parseInt(req.params.id, 10);
  if (!Number.isFinite(recipeId)) return res.status(400).json({ error: 'Invalid id' });
  if (linkableRecipeId(recipeId, u) == null) return res.status(404).json({ error: 'Recipe not found' });
  const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(recipeId);
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });

  const onlyMissing = req.query.only_missing !== '0';
  const stock = _inStockSet(u);
  const servings = Number(req.query.servings);
  const contributions = recipeContributions(recipe, {
    servings: Number.isFinite(servings) && servings > 0 ? servings : null,
    skip: it => onlyMissing && it.pantry_item_id && stock.has(it.pantry_item_id),
  });
  const result = _applyToList(u, contributions, {});
  res.json({ ...result, added: result.added + result.updated });
}));

export default router;
