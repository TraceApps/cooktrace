/**
 * pantry.js — Pantry library CRUD + ingredient resolution.
 *
 * Pantry rows are user-scoped. They double as both:
 *   - the user's known-ingredient catalog (every name they've ever used)
 *   - their current inventory (in_stock = 1 / 0)
 *
 * Recipe ingredients reference pantry_items by id (`pantry_item_id` field
 * on each ingredient JSON entry). On recipe save, ensurePantryItems()
 * resolves names to ids, auto-creating any new ones (case-insensitive
 * match so "Flour" and "flour" share one row).
 */
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { deriveSodiumSalt } from '../lib/nutrition-derive.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const userClause = (u) => u == null ? 'user_id IS NULL' : 'user_id = ?';
const userArgs   = (u) => u == null ? [] : [u];

function _hydrate(row, categoryMap = null) {
  if (!row) return null;
  let nutrition = {};
  if (row.nutrition) {
    try { nutrition = JSON.parse(row.nutrition) || {}; } catch { nutrition = {}; }
  }
  // Resolve category — same pattern as recipes._hydrate. List path
  // passes a Map to avoid N+1; single-item path falls back to a one-shot
  // SELECT.
  let category = null;
  if (row.category_id != null) {
    if (categoryMap) {
      category = categoryMap.get(row.category_id) || null;
    } else {
      category = db.prepare(
        `SELECT id, name, slug, icon, color FROM pantry_categories WHERE id = ?`
      ).get(row.category_id) || null;
    }
  }
  return {
    ...row,
    in_stock: !!row.in_stock,
    nutrition,
    category,
  };
}

// Resolve a category_id from a body, accepting either:
//   - an explicit numeric category_id
//   - a string `category` slug (legacy clients) — auto-looked-up against
//     pantry_categories for the user; unknown slug → null (cleanly drops)
function _resolveCategoryId(u, body) {
  if (body.category_id != null && body.category_id !== '') {
    const n = parseInt(body.category_id, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof body.category === 'string' && body.category.trim()) {
    const row = db.prepare(
      `SELECT id FROM pantry_categories WHERE ${userClause(u)} AND slug = ? LIMIT 1`
    ).get(...userArgs(u), body.category.trim());
    return row?.id ?? null;
  }
  return null;
}

function _stringifyNutrition(n) {
  if (!n) return null;
  // Accept either a JSON string (from a passthrough import) or an
  // object. Run sodium↔salt derivation on objects so a user who
  // entered only one of the pair gets the other auto-filled, with
  // `_derived.sodium|salt` tagged for the calculator-icon UI badge.
  let obj = n;
  if (typeof n === 'string') {
    try { obj = JSON.parse(n); } catch { return n; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const derived = deriveSodiumSalt({ ...obj });
  try { return JSON.stringify(derived); } catch { return null; }
}

// ── Pantry categories ───────────────────────────────────────────────────
// Declared BEFORE /:id so the static "/categories" prefix isn't matched
// as :id. Per-user catalog; mirror the recipe-categories shape.
function _slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'category';
}

router.get('/categories', wrap((req, res) => {
  const u = uid(req);
  // Include the count of non-deleted pantry items that point at each
  // category so the Manage hub can surface a usage pill.
  const rows = db.prepare(
    `SELECT c.id, c.name, c.slug, c.icon, c.color, c.sort_order,
            (SELECT COUNT(*) FROM pantry_items p
              WHERE p.category_id = c.id AND p.deleted_at IS NULL
                AND ${userClause(u).replace(/user_id/g, 'p.user_id')}) AS pantry_count
       FROM pantry_categories c
      WHERE ${userClause(u).replace(/user_id/g, 'c.user_id')}
      ORDER BY c.sort_order ASC, c.name ASC`
  ).all(...userArgs(u), ...userArgs(u));
  res.json(rows);
}));

router.post('/categories', wrap((req, res) => {
  const u = uid(req);
  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const icon  = req.body?.icon  ? String(req.body.icon).slice(0, 32)  : null;
  const color = req.body?.color ? String(req.body.color).slice(0, 16) : null;
  let slug = _slugify(name);
  let n = 2;
  while (db.prepare(
    `SELECT 1 FROM pantry_categories WHERE ${userClause(u)} AND slug = ?`
  ).get(...userArgs(u), slug)) {
    slug = `${_slugify(name)}-${n++}`;
  }
  const maxOrder = db.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) AS m FROM pantry_categories WHERE ${userClause(u)}`
  ).get(...userArgs(u)).m;
  const result = db.prepare(
    `INSERT INTO pantry_categories (user_id, name, slug, icon, color, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(u, name, slug, icon, color, maxOrder + 1);
  const row = db.prepare(
    `SELECT id, name, slug, icon, color, sort_order FROM pantry_categories WHERE id = ?`
  ).get(result.lastInsertRowid);
  res.status(201).json(row);
}));

router.put('/categories/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(
    `SELECT * FROM pantry_categories WHERE id = ? AND ${userClause(u)}`
  ).get(id, ...userArgs(u));
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const name  = req.body?.name != null ? (String(req.body.name).trim() || existing.name) : existing.name;
  const icon  = req.body?.icon  !== undefined ? (req.body.icon  ? String(req.body.icon).slice(0, 32)  : null) : existing.icon;
  const color = req.body?.color !== undefined ? (req.body.color ? String(req.body.color).slice(0, 16) : null) : existing.color;
  const sort  = req.body?.sort_order != null && Number.isFinite(parseInt(req.body.sort_order, 10))
    ? parseInt(req.body.sort_order, 10) : existing.sort_order;

  db.prepare(
    `UPDATE pantry_categories
        SET name = ?, icon = ?, color = ?, sort_order = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(name, icon, color, sort, id);
  const row = db.prepare(
    `SELECT id, name, slug, icon, color, sort_order FROM pantry_categories WHERE id = ?`
  ).get(id);
  res.json(row);
}));

// ── PUT /categories/order — bulk reorder ──────────────────────────────
// Same shape as the recipe-categories order endpoint.
router.put('/categories/order', wrap((req, res) => {
  const u = uid(req);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : null;
  if (!ids) return res.status(400).json({ error: 'ids array required' });
  const upd = db.prepare(
    `UPDATE pantry_categories
        SET sort_order = ?, updated_at = datetime('now')
      WHERE id = ? AND ${userClause(u)}`
  );
  const tx = db.transaction(() => {
    ids.forEach((id, idx) => upd.run(idx, id, ...userArgs(u)));
  });
  tx();
  res.json({ ok: true });
}));

router.delete('/categories/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(
    `SELECT id FROM pantry_categories WHERE id = ? AND ${userClause(u)}`
  ).get(id, ...userArgs(u));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare(`DELETE FROM pantry_categories WHERE id = ?`).run(id);
  res.json({ ok: true });
}));

// ── GET / — list pantry items ───────────────────────────────────────────
router.get('/', wrap((req, res) => {
  const u = uid(req);
  const stockOnly = req.query.in_stock === '1';
  const q = req.query.q ? String(req.query.q).trim().toLowerCase() : '';

  let sql = `SELECT * FROM pantry_items WHERE ${userClause(u)} AND deleted_at IS NULL`;
  const args = [...userArgs(u)];
  if (stockOnly) sql += ` AND in_stock = 1`;
  if (q) { sql += ` AND LOWER(name) LIKE ?`; args.push(`%${q}%`); }
  sql += ` ORDER BY name COLLATE NOCASE ASC`;

  const rows = db.prepare(sql).all(...args);
  // Bulk-prefetch categories for the user once and pass through, so
  // _hydrate doesn't fire one SELECT per row.
  const catMap = new Map();
  for (const c of db.prepare(
    `SELECT id, name, slug, icon, color FROM pantry_categories WHERE ${userClause(u)}`
  ).all(...userArgs(u))) {
    catMap.set(c.id, c);
  }

  // Recipe-usage map — single pass through every recipe's ingredients
  // JSON, counting how many recipes reference each pantry_item_id.
  // Powers the "Used in N" pill on every pantry card.
  const recipeCount = new Map();
  const recipeRows = db.prepare(
    `SELECT ingredients FROM recipes WHERE ${userClause(u)} AND deleted_at IS NULL`
  ).all(...userArgs(u));
  for (const r of recipeRows) {
    let groups = [];
    try { groups = JSON.parse(r.ingredients || '[]'); } catch {}
    const seen = new Set();
    for (const g of groups) {
      for (const it of (g.items || [])) {
        const pid = it && it.pantry_item_id;
        if (pid && !seen.has(pid)) {
          seen.add(pid);
          recipeCount.set(pid, (recipeCount.get(pid) || 0) + 1);
        }
      }
    }
  }

  res.json(rows.map(r => ({ ..._hydrate(r, catMap), recipe_count: recipeCount.get(r.id) || 0 })));
}));

// ── GET /:id/recipes — recipes that use this pantry item ───────────────
// Scans recipes.ingredients (JSON-encoded grouped list) and returns the
// minimal fields the pantry view's "Used in" section needs. Server-side
// scan keeps the client from loading every recipe just to filter.
router.get('/:id/recipes', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  // Confirm the pantry row exists + is the user's. (Same auth shape as
  // the other /pantry endpoints.)
  const item = db.prepare(`SELECT * FROM pantry_items WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if ((u == null && item.user_id != null) || (u != null && item.user_id !== u)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const rows = db.prepare(
    `SELECT id, name, img_url, ingredients FROM recipes
     WHERE ${userClause(u)} AND deleted_at IS NULL
     ORDER BY name COLLATE NOCASE ASC`
  ).all(...userArgs(u));
  const matches = [];
  for (const r of rows) {
    let groups = [];
    try { groups = JSON.parse(r.ingredients || '[]') || []; } catch { groups = []; }
    let used = false;
    for (const g of groups) {
      for (const it of (g.items || [])) {
        if (it && it.pantry_item_id === id) { used = true; break; }
      }
      if (used) break;
    }
    if (used) matches.push({ id: r.id, name: r.name, img_url: r.img_url });
  }
  res.json(matches);
}));

// ── GET /by-barcode/:code — look up an existing pantry item by barcode ─
router.get('/by-barcode/:code', wrap((req, res) => {
  const u = uid(req);
  const code = (req.params.code || '').toString().trim();
  if (!code) return res.status(400).json({ error: 'Barcode required' });
  const row = db.prepare(
    `SELECT * FROM pantry_items WHERE ${userClause(u)} AND barcode = ? AND deleted_at IS NULL LIMIT 1`
  ).get(...userArgs(u), code);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(_hydrate(row));
}));

// ── GET /:id — single item ──────────────────────────────────────────────
router.get('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const row = db.prepare(`SELECT * FROM pantry_items WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if ((u == null && row.user_id != null) || (u != null && row.user_id !== u)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(_hydrate(row));
}));

// ── POST / — create ─────────────────────────────────────────────────────
router.post('/', wrap((req, res) => {
  const u = uid(req);
  const body = req.body || {};
  const name = (body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });

  // Dedupe by case-insensitive name within the same user. Variants
  // are excluded from the dedupe scope (Issue #4): when a user has
  // "GreenWise Whole Milk" as a variant of a different generic and
  // types "Whole Milk" into Create, they want a brand-new top-level
  // row, not to silently match into the unrelated variant. Generic
  // and flat rows (generic_parent_id IS NULL) still dedupe so users
  // can't double-create a top-level item with the same name.
  const dup = db.prepare(
    `SELECT * FROM pantry_items
       WHERE ${userClause(u)}
       AND LOWER(name) = LOWER(?)
       AND deleted_at IS NULL
       AND generic_parent_id IS NULL`
  ).get(...userArgs(u), name);
  if (dup) return res.status(200).json(_hydrate(dup));

  const categoryId = _resolveCategoryId(u, body);
  // Keep `category` text column in sync — it's still the source of truth
  // for legacy clients / sync paths. New rows write the slug derived
  // from the resolved category_id (matches what backfill produced).
  let categorySlug = body.category || null;
  if (categoryId && !categorySlug) {
    const c = db.prepare(`SELECT slug FROM pantry_categories WHERE id = ?`).get(categoryId);
    categorySlug = c?.slug || null;
  }
  // Variant fields (Issue #4). generic_parent_id sets this row as a
  // child variant of the given pantry item. nutrition_source_variant_id
  // is only meaningful when this row is itself a generic (i.e. has at
  // least one child) and points at one of its children. Validation that
  // both stay in range is done at update / promote time; create-time
  // values are trusted (caller is the editor flow which already picked
  // valid IDs).
  const genericParentId = body.generic_parent_id != null && body.generic_parent_id !== ''
    ? parseInt(body.generic_parent_id, 10) : null;
  const nutritionSourceVariantId = body.nutrition_source_variant_id != null && body.nutrition_source_variant_id !== ''
    ? parseInt(body.nutrition_source_variant_id, 10) : null;
  const result = db.prepare(
    `INSERT INTO pantry_items
       (user_id, name, brand, barcode, in_stock, quantity, unit, expires_on, nt_food_id,
        img_url, notes, category, category_id, serving_size, serving_unit, serving_label,
        nutrition, g_per_cup, generic_parent_id, nutrition_source_variant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    u, name,
    body.brand?.toString().trim() || null,
    body.barcode?.toString().trim() || null,
    body.in_stock ? 1 : 0,
    body.quantity == null ? null : Number(body.quantity),
    body.unit || null,
    body.expires_on || null,
    body.nt_food_id || null,
    body.img_url || body.imgUrl || null,
    body.notes || null,
    categorySlug,
    categoryId,
    body.serving_size != null && body.serving_size !== '' ? Number(body.serving_size) : null,
    body.serving_unit || null,
    body.serving_label || null,
    _stringifyNutrition(body.nutrition),
    body.g_per_cup != null && body.g_per_cup !== '' ? Number(body.g_per_cup) : null,
    Number.isFinite(genericParentId) ? genericParentId : null,
    Number.isFinite(nutritionSourceVariantId) ? nutritionSourceVariantId : null,
  );
  const row = db.prepare(`SELECT * FROM pantry_items WHERE id = ?`).get(result.lastInsertRowid);
  res.status(201).json(_hydrate(row));
}));

// ── PUT /:id — update ───────────────────────────────────────────────────
router.put('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(`SELECT * FROM pantry_items WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if ((u == null && existing.user_id != null) || (u != null && existing.user_id !== u)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const body = req.body || {};
  const name = body.name != null ? (String(body.name).trim() || existing.name) : existing.name;

  // Resolve the next category. If the body explicitly passes either
  // category_id or category, recompute; otherwise keep what's there.
  let nextCategoryId = existing.category_id;
  let nextCategorySlug = existing.category;
  if (body.category_id !== undefined || body.category !== undefined) {
    nextCategoryId = _resolveCategoryId(u, body);
    if (nextCategoryId) {
      const c = db.prepare(`SELECT slug FROM pantry_categories WHERE id = ?`).get(nextCategoryId);
      nextCategorySlug = c?.slug || null;
    } else {
      nextCategorySlug = typeof body.category === 'string' && body.category.trim() ? body.category.trim() : null;
    }
  }

  // Variant fields (Issue #4). Both are validated below so we can't
  // create cycles (item points at itself) or three-level hierarchies
  // (a child cannot also be a generic). nutrition_source_variant_id
  // is additionally constrained to a row that is a child of this item.
  let nextGenericParentId = existing.generic_parent_id;
  if (body.generic_parent_id !== undefined) {
    if (body.generic_parent_id === null || body.generic_parent_id === '') {
      nextGenericParentId = null;
    } else {
      const candidate = parseInt(body.generic_parent_id, 10);
      if (!Number.isFinite(candidate))            return res.status(400).json({ error: 'generic_parent_id must be a number or null' });
      if (candidate === id)                       return res.status(400).json({ error: "An item can't be its own generic parent" });
      const parent = db.prepare(
        `SELECT id, generic_parent_id FROM pantry_items WHERE id = ? AND deleted_at IS NULL`
      ).get(candidate);
      if (!parent)                                return res.status(400).json({ error: 'Generic parent not found' });
      if (parent.generic_parent_id != null)       return res.status(400).json({ error: "Can't nest variants under another variant" });
      const ownChildren = db.prepare(
        `SELECT COUNT(*) AS n FROM pantry_items WHERE generic_parent_id = ? AND deleted_at IS NULL`
      ).get(id);
      if (ownChildren.n > 0)                      return res.status(400).json({ error: "Can't move a generic with its own variants under another generic" });
      nextGenericParentId = candidate;
    }
  }

  let nextNutritionSourceVariantId = existing.nutrition_source_variant_id;
  if (body.nutrition_source_variant_id !== undefined) {
    if (body.nutrition_source_variant_id === null || body.nutrition_source_variant_id === '') {
      nextNutritionSourceVariantId = null;
    } else {
      const candidate = parseInt(body.nutrition_source_variant_id, 10);
      if (!Number.isFinite(candidate))            return res.status(400).json({ error: 'nutrition_source_variant_id must be a number or null' });
      const source = db.prepare(
        `SELECT id, generic_parent_id FROM pantry_items WHERE id = ? AND deleted_at IS NULL`
      ).get(candidate);
      if (!source)                                return res.status(400).json({ error: 'Nutrition source variant not found' });
      if (source.generic_parent_id !== id)        return res.status(400).json({ error: 'Nutrition source must be a child of this item' });
      nextNutritionSourceVariantId = candidate;
    }
  }
  // A row that is itself a variant can never own a nutrition source.
  if (nextGenericParentId != null) nextNutritionSourceVariantId = null;

  db.prepare(
    `UPDATE pantry_items SET
       name = ?, brand = ?, barcode = ?, in_stock = ?, quantity = ?, unit = ?, expires_on = ?,
       nt_food_id = ?, img_url = ?, notes = ?,
       category = ?, category_id = ?, serving_size = ?, serving_unit = ?, serving_label = ?,
       nutrition = ?, g_per_cup = ?,
       generic_parent_id = ?, nutrition_source_variant_id = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    name,
    body.brand !== undefined ? (body.brand?.toString().trim() || null) : existing.brand,
    body.barcode !== undefined ? (body.barcode?.toString().trim() || null) : existing.barcode,
    body.in_stock != null ? (body.in_stock ? 1 : 0) : existing.in_stock,
    body.quantity != null ? (body.quantity === '' ? null : Number(body.quantity)) : existing.quantity,
    body.unit !== undefined ? (body.unit || null) : existing.unit,
    body.expires_on !== undefined ? (body.expires_on || null) : existing.expires_on,
    body.nt_food_id !== undefined ? (body.nt_food_id || null) : existing.nt_food_id,
    body.img_url !== undefined ? (body.img_url || body.imgUrl || null) : existing.img_url,
    body.notes !== undefined ? (body.notes || null) : existing.notes,
    nextCategorySlug,
    nextCategoryId,
    body.serving_size !== undefined ? (body.serving_size === '' || body.serving_size == null ? null : Number(body.serving_size)) : existing.serving_size,
    body.serving_unit !== undefined ? (body.serving_unit || null) : existing.serving_unit,
    body.serving_label !== undefined ? (body.serving_label || null) : existing.serving_label,
    body.nutrition !== undefined ? _stringifyNutrition(body.nutrition) : existing.nutrition,
    body.g_per_cup !== undefined ? (body.g_per_cup === '' || body.g_per_cup == null ? null : Number(body.g_per_cup)) : existing.g_per_cup,
    nextGenericParentId,
    nextNutritionSourceVariantId,
    id,
  );
  const row = db.prepare(`SELECT * FROM pantry_items WHERE id = ?`).get(id);
  res.json(_hydrate(row));
}));

// ── DELETE /:id — soft delete ───────────────────────────────────────────
router.delete('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(`SELECT * FROM pantry_items WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if ((u == null && existing.user_id != null) || (u != null && existing.user_id !== u)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // Variant handling on parent delete. Soft-delete sets deleted_at;
  // the FK `ON DELETE SET NULL` only fires on hard deletes, so without
  // this block children would keep pointing at a now-hidden parent
  // and become invisible in both the list (excluded by generic_parent_id
  // filter) and the parent's expand (parent itself is gone).
  //   ?cascade=1  → soft-delete every child too.
  //   otherwise   → promote children to standalone flat items
  //                 (generic_parent_id cleared, nutrition_source ref
  //                 unwound on the parent which is going away anyway).
  const cascade = req.query.cascade === '1' || req.query.cascade === 'true';
  const variantIds = db.prepare(
    `SELECT id FROM pantry_items WHERE generic_parent_id = ? AND deleted_at IS NULL`
  ).all(id).map(r => r.id);
  const tx = db.transaction(() => {
    if (variantIds.length) {
      if (cascade) {
        db.prepare(
          `UPDATE pantry_items
              SET deleted_at = datetime('now'), updated_at = datetime('now')
            WHERE id IN (${variantIds.map(() => '?').join(',')})`
        ).run(...variantIds);
      } else {
        db.prepare(
          `UPDATE pantry_items
              SET generic_parent_id = NULL, updated_at = datetime('now')
            WHERE id IN (${variantIds.map(() => '?').join(',')})`
        ).run(...variantIds);
      }
    }
    db.prepare(
      `UPDATE pantry_items SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(id);
  });
  tx();
  res.json({ ok: true, cascade, affected_variants: variantIds.length });
}));

// ── PATCH /:id/stock — quick toggle ─────────────────────────────────────
router.patch('/:id/stock', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(`SELECT * FROM pantry_items WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if ((u == null && existing.user_id != null) || (u != null && existing.user_id !== u)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const next = req.body?.in_stock ? 1 : 0;
  db.prepare(`UPDATE pantry_items SET in_stock = ?, updated_at = datetime('now') WHERE id = ?`).run(next, id);
  res.json({ ok: true, in_stock: !!next });
}));

/**
 * Resolve an array of ingredient names to pantry_item rows for the given
 * user, auto-creating any names that don't yet exist. Names match case-
 * insensitively, so "Flour" / "flour" / "FLOUR" share one row.
 *
 * Used by the recipes route on save to populate ingredient.pantry_item_id.
 * Returns a Map keyed by lowercased name → row.
 */
export function ensurePantryItems(userId, names) {
  const cleaned = [...new Set(
    (names || [])
      .map(n => (n ?? '').toString().trim())
      .filter(Boolean)
      .map(n => n.toLowerCase())
  )];
  if (cleaned.length === 0) return new Map();

  const userExpr = userId == null ? 'user_id IS NULL' : 'user_id = ?';
  const userArg  = userId == null ? [] : [userId];

  const out = new Map();
  const insert = db.prepare(
    `INSERT INTO pantry_items (user_id, name, in_stock) VALUES (?, ?, 0)`
  );
  // Same variant-aware dedupe as POST /pantry: ensurePantryItems used by
  // recipe-save linking should match top-level rows only. A variant
  // that happens to share a name with a recipe ingredient shouldn't
  // intercept the link.
  const findByName = db.prepare(
    `SELECT * FROM pantry_items WHERE ${userExpr} AND LOWER(name) = ? AND deleted_at IS NULL AND generic_parent_id IS NULL`
  );
  const findById = db.prepare(`SELECT * FROM pantry_items WHERE id = ?`);

  const tx = db.transaction(() => {
    for (const lname of cleaned) {
      const existing = findByName.get(...userArg, lname);
      if (existing) { out.set(lname, existing); continue; }
      const result = insert.run(userId, _properCase(lname));
      const row = findById.get(result.lastInsertRowid);
      out.set(lname, row);
    }
  });
  tx();
  return out;
}

// "all-purpose flour" → "All-purpose flour"
function _properCase(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default router;
