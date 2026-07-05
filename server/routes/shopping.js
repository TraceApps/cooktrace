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
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const userClause = (u) => u == null ? 'user_id IS NULL' : 'user_id = ?';
const userArgs   = (u) => u == null ? [] : [u];

function _hydrate(row) {
  if (!row) return null;
  return { ...row, checked: !!row.checked };
}

// Title-case a shopping item name. Mealie stores its canonical food
// names lowercase ("fresh lemon juice"), so anything copied from a
// recipe's stored ingredient JSON arrives that way. This normalises at
// the shopping-list write boundary so every row in the user's list
// follows the project's caps rule regardless of upstream source.
//
// Chicago-style minor-word exceptions: keep articles, short conjunctions,
// and short prepositions lowercase UNLESS they're the first word. Already
// uppercase words (acronyms, brand names) pass through.
const _MINOR_WORDS = new Set([
  'a','an','and','as','at','but','by','for','if','in','nor','of','on','or','the','to','up','via',
]);
function _titleCaseName(raw) {
  if (raw == null) return raw;
  const s = String(raw).trim();
  if (!s) return s;
  // Don't touch strings already mixed-case (likely user-typed manual entry).
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s;
  // Split on whitespace but preserve internal punctuation (hyphens etc.)
  // by mapping word-by-word.
  return s.split(/(\s+)/).map((tok, i, arr) => {
    if (!tok.trim()) return tok;
    // Hyphenated word: title-case each segment ("all-purpose" → "All-Purpose").
    return tok.split('-').map((seg, segIdx) => {
      const lower = seg.toLowerCase();
      const isFirstToken = arr.slice(0, i).every(t => !t.trim());
      const isFirstSeg   = segIdx === 0;
      // Lowercase minor words except when they start the whole string.
      if (_MINOR_WORDS.has(lower) && !(isFirstToken && isFirstSeg)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join('-');
  }).join('');
}

// Aisle auto-lookup: linked pantry item → its category's default_aisle,
// falling back to the category name, then null. Used by every insert path
// (single-item POST, /from-recipe, /from-plan) so the shopping list groups
// itself without the user having to tag each row.
function _aisleForPantry(pantryId) {
  if (!pantryId) return null;
  const cat = db.prepare(
    `SELECT c.default_aisle, c.name
       FROM pantry_items p
       LEFT JOIN pantry_categories c ON c.id = p.category_id
      WHERE p.id = ?`
  ).get(pantryId);
  if (!cat) return null;
  return (cat.default_aisle && cat.default_aisle.trim()) || cat.name || null;
}

// ── GET / — list shopping items ────────────────────────────────────────
router.get('/', wrap((req, res) => {
  const u = uid(req);
  const rows = db.prepare(
    `SELECT s.*, p.name AS pantry_name, p.img_url AS pantry_img_url,
            r.name AS recipe_name
     FROM shopping_list s
     LEFT JOIN pantry_items p ON p.id = s.pantry_id
     LEFT JOIN recipes      r ON r.id = s.recipe_id AND r.deleted_at IS NULL
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
  const body = req.body || {};
  const name = (body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });

  // Auto-populate aisle when the caller didn't provide one but linked
  // a pantry item. Explicit body.aisle always wins so callers can force
  // a specific value; see _aisleForPantry for the fallback chain.
  let aisle = body.aisle && String(body.aisle).trim() ? String(body.aisle).trim() : null;
  if (aisle == null && body.pantry_id) aisle = _aisleForPantry(body.pantry_id);

  const result = db.prepare(
    `INSERT INTO shopping_list (user_id, name, quantity, unit, aisle, checked, pantry_id, recipe_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    u, _titleCaseName(name),
    body.quantity == null || body.quantity === '' ? null : Number(body.quantity),
    body.unit || null,
    aisle,
    body.checked ? 1 : 0,
    body.pantry_id || null,
    body.recipe_id || null,
  );
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
  db.prepare(
    `UPDATE shopping_list SET
       name = ?, quantity = ?, unit = ?, aisle = ?, checked = ?, pantry_id = ?, sort_order = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    body.name != null ? String(body.name).trim() || existing.name : existing.name,
    body.quantity !== undefined ? (body.quantity === '' || body.quantity == null ? null : Number(body.quantity)) : existing.quantity,
    body.unit !== undefined ? (body.unit || null) : existing.unit,
    body.aisle !== undefined ? (body.aisle && String(body.aisle).trim() ? String(body.aisle).trim() : null) : existing.aisle,
    body.checked !== undefined ? (body.checked ? 1 : 0) : existing.checked,
    body.pantry_id !== undefined ? (body.pantry_id || null) : existing.pantry_id,
    body.sort_order !== undefined ? (body.sort_order == null ? null : Number(body.sort_order)) : existing.sort_order,
    id,
  );
  const row = db.prepare(`SELECT * FROM shopping_list WHERE id = ?`).get(id);
  res.json(_hydrate(row));
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
      db.prepare(
        `UPDATE shopping_list
            SET sort_order = ?, aisle = ?, updated_at = datetime('now')
          WHERE id = ?`
      ).run(nextSort, nextAisle, id);
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
  const next = req.body?.checked ? 1 : 0;
  db.prepare(`UPDATE shopping_list SET checked = ?, updated_at = datetime('now') WHERE id = ?`).run(next, id);
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
      const aisle = _aisleForPantry(row.pantry_id);
      insert.run(u, _titleCaseName(row.name), row.qty, row.unit, aisle, row.pantry_id, row.recipe_id);
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
      const aisle = _aisleForPantry(it.pantry_item_id);
      insert.run(u, _titleCaseName(it.name), it.qty || null, it.unit || null, aisle, it.pantry_item_id || null, recipeId);
      added++;
    }
  });
  tx();
  res.json({ added });
}));

export default router;
