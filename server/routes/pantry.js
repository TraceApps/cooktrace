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
import { localizeDataUrl } from '../lib/image-localizer.js';
import db from '../db.js';
import { stampFields } from '../lib/field-stamps.js';
import { saveRow } from '../lib/rest-merge.js';
import { repairVariantTree } from '../lib/pantry-tree.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { deriveSodiumSalt } from '../lib/nutrition-derive.js';
import { dispatchWebhookEvent } from '../lib/webhooks.js';
import { foldText } from '../lib/search-text.js';
import { cleanCreateKey, findByCreateKey, setCreateKey } from '../lib/create-keys.js';
import { ownId } from '../lib/link-checks.js';
import { ingredientKey } from '../lib/quantity.js';
import { cleanCodes, knownCodes } from '../lib/allergens.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const userClause = (u) => u == null ? 'user_id IS NULL' : 'user_id = ?';
const userArgs   = (u) => u == null ? [] : [u];

// Allergens as sent: a list of codes, or null for "not known"
// (lib/allergens.js). Stored as JSON text.
function _codesText(value) {
  if (value == null || value === '') return null;
  return JSON.stringify(cleanCodes(value));
}
// Where they came from: the label (a scan or a lookup) or the user.
const _source = v => (v === 'label' || v === 'user' ? v : null);

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
    allergens: knownCodes(row.allergens),
    traces: knownCodes(row.traces),
    category,
  };
}

// Resolve a category_id from a body, accepting either:
//   - an explicit numeric category_id
//   - a string `category` slug (legacy clients) — auto-looked-up against
//     pantry_categories for the user; unknown slug → null (cleanly drops)
function _resolveCategoryId(u, body) {
  if (body.category_id != null && body.category_id !== '') {
    // Only the account's own category (lib/link-checks.js).
    return ownId('pantry_categories', body.category_id, u, { softDelete: false });
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
    `SELECT c.id, c.name, c.slug, c.icon, c.color, c.sort_order, c.default_aisle, c.synced_at,
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
  const defaultAisle = req.body?.default_aisle != null && String(req.body.default_aisle).trim()
    ? String(req.body.default_aisle).trim().slice(0, 40) : null;
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
    `INSERT INTO pantry_categories (user_id, name, slug, icon, color, sort_order, default_aisle)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(u, name, slug, icon, color, maxOrder + 1, defaultAisle);
  const row = db.prepare(
    `SELECT id, name, slug, icon, color, sort_order, default_aisle, synced_at FROM pantry_categories WHERE id = ?`
  ).get(result.lastInsertRowid);
  res.status(201).json(row);
}));

// Before '/categories/:id', which would otherwise take 'order' for an id
// (and answer 400): the new order never got saved.
router.put('/categories/order', wrap((req, res) => {
  const u = uid(req);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : null;
  if (!ids) return res.status(400).json({ error: 'ids array required' });
  // A new order isn't an edit of the categories: updated_at stays, and
  // only sort_order is stamped as changed now (lib/field-merge.js).
  const upd = db.prepare(
    `UPDATE pantry_categories
        SET sort_order = ?
      WHERE id = ? AND ${userClause(u)} AND sort_order IS NOT ?`
  );
  const tx = db.transaction(() => {
    ids.forEach((id, idx) => { if (upd.run(idx, id, ...userArgs(u), idx).changes) stampFields('pantry_categories', id, ['sort_order']); });
  });
  tx();
  res.json({ ok: true });
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
  // default_aisle: null clears, non-empty string sets, undefined keeps
  const defaultAisle = req.body?.default_aisle !== undefined
    ? (req.body.default_aisle && String(req.body.default_aisle).trim()
        ? String(req.body.default_aisle).trim().slice(0, 40) : null)
    : existing.default_aisle;

  saveRow('pantry_categories', id, existing, { name, icon, color, sort_order: sort, default_aisle: defaultAisle }, req.body?._sync);
  const row = db.prepare(
    `SELECT id, name, slug, icon, color, sort_order, default_aisle, synced_at FROM pantry_categories WHERE id = ?`
  ).get(id);
  res.json(row);
}));

// ── PUT /categories/order — bulk reorder ──────────────────────────────
// Same shape as the recipe-categories order endpoint.

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
  const q = req.query.q ? foldText(req.query.q).trim() : '';

  let sql = `SELECT * FROM pantry_items WHERE ${userClause(u)} AND deleted_at IS NULL`;
  const args = [...userArgs(u)];
  if (stockOnly) sql += ` AND in_stock = 1`;
  if (q) { sql += ` AND fold(name) LIKE ?`; args.push(`%${q}%`); }
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
  // Sent before (Connect > Upload again, or an answer lost): the row made
  // then, not a second one (lib/create-keys.js).
  const createKey = cleanCreateKey(req.body?.client_key);
  const made = findByCreateKey('pantry_items', u, createKey);
  if (made) return res.json(_hydrate(made));
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
  // Only the account's own top-level item can be the parent. A new item
  // has no variants yet, so it has no nutrition source either: one is
  // set once its variants exist (PUT, which checks it is one of them).
  const parentId = ownId('pantry_items', body.generic_parent_id, u);
  const parentRow = parentId != null ? db.prepare(`SELECT generic_parent_id FROM pantry_items WHERE id = ?`).get(parentId) : null;
  const genericParentId = parentRow && parentRow.generic_parent_id == null ? parentId : null;
  const nutritionSourceVariantId = null;
  const result = db.prepare(
    `INSERT INTO pantry_items
       (user_id, name, brand, barcode, in_stock, quantity, unit, expires_on, nt_food_id,
        img_url, notes, category, category_id, serving_size, serving_unit, serving_label,
        nutrition, g_per_cup, generic_parent_id, nutrition_source_variant_id,
        allergens, traces, allergens_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    u, name,
    body.brand?.toString().trim() || null,
    body.barcode?.toString().trim() || null,
    body.in_stock ? 1 : 0,
    body.quantity == null ? null : Number(body.quantity),
    body.unit || null,
    body.expires_on || null,
    body.nt_food_id || null,
    // A photo taken with no connection arrives embedded; it becomes a file here.
    localizeDataUrl(body.img_url || body.imgUrl || null),
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
    _codesText(body.allergens),
    _codesText(body.traces),
    body.allergens != null || body.traces != null ? _source(body.allergens_source) : null,
  );
  setCreateKey('pantry_items', result.lastInsertRowid, createKey);
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
      const parent = ownId('pantry_items', candidate, u) != null && db.prepare(
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
      const source = ownId('pantry_items', candidate, u) != null && db.prepare(
        `SELECT id, generic_parent_id FROM pantry_items WHERE id = ? AND deleted_at IS NULL`
      ).get(candidate);
      if (!source)                                return res.status(400).json({ error: 'Nutrition source variant not found' });
      if (source.generic_parent_id !== id)        return res.status(400).json({ error: 'Nutrition source must be a child of this item' });
      nextNutritionSourceVariantId = candidate;
    }
  }
  // A row that is itself a variant can never own a nutrition source.
  if (nextGenericParentId != null) nextNutritionSourceVariantId = null;

  const nextInStock = body.in_stock != null ? (body.in_stock ? 1 : 0) : existing.in_stock;

  // With _sync, merged with changes made elsewhere (lib/rest-merge.js).
  const { kept } = saveRow('pantry_items', id, existing, {
    name,
    brand: body.brand !== undefined ? (body.brand?.toString().trim() || null) : existing.brand,
    barcode: body.barcode !== undefined ? (body.barcode?.toString().trim() || null) : existing.barcode,
    in_stock: nextInStock,
    // An explicit null or '' clears the quantity; only an absent key keeps
    // the stored one. Sending null used to fall through to "keep", so
    // marking an item back in stock left quantity 0, which still reads as
    // out of stock everywhere quantity is the source of truth.
    quantity: body.quantity !== undefined ? (body.quantity === '' || body.quantity === null ? null : Number(body.quantity)) : existing.quantity,
    unit: body.unit !== undefined ? (body.unit || null) : existing.unit,
    expires_on: body.expires_on !== undefined ? (body.expires_on || null) : existing.expires_on,
    nt_food_id: body.nt_food_id !== undefined ? (body.nt_food_id || null) : existing.nt_food_id,
    img_url: body.img_url !== undefined ? localizeDataUrl(body.img_url || body.imgUrl || null) : existing.img_url,
    notes: body.notes !== undefined ? (body.notes || null) : existing.notes,
    category: nextCategorySlug,
    category_id: nextCategoryId,
    serving_size: body.serving_size !== undefined ? (body.serving_size === '' || body.serving_size == null ? null : Number(body.serving_size)) : existing.serving_size,
    serving_unit: body.serving_unit !== undefined ? (body.serving_unit || null) : existing.serving_unit,
    serving_label: body.serving_label !== undefined ? (body.serving_label || null) : existing.serving_label,
    nutrition: body.nutrition !== undefined ? _stringifyNutrition(body.nutrition) : existing.nutrition,
    g_per_cup: body.g_per_cup !== undefined ? (body.g_per_cup === '' || body.g_per_cup == null ? null : Number(body.g_per_cup)) : existing.g_per_cup,
    generic_parent_id: nextGenericParentId,
    nutrition_source_variant_id: nextNutritionSourceVariantId,
    allergens: body.allergens !== undefined ? _codesText(body.allergens) : existing.allergens,
    traces: body.traces !== undefined ? _codesText(body.traces) : existing.traces,
    allergens_source: body.allergens_source !== undefined ? _source(body.allergens_source) : existing.allergens_source,
  }, body._sync);
  // A merge can't leave the variant tree in a shape the checks above refuse.
  if (body._sync) repairVariantTree([id]);

  if (existing.in_stock === 1 && nextInStock === 0) {
    try {
      dispatchWebhookEvent(u, 'pantry.out_of_stock', { pantry_item_id: id, name });
    } catch (e) { /* never let a webhook failure block the save */ }
  }

  const row = db.prepare(`SELECT * FROM pantry_items WHERE id = ?`).get(id);
  res.json({ ..._hydrate(row), ...(kept ? { kept: 'server' } : {}) });
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
  saveRow('pantry_items', id, existing, { in_stock: req.body?.in_stock ? 1 : 0 }, req.body?._sync);
  const next = db.prepare(`SELECT in_stock FROM pantry_items WHERE id = ?`).get(id).in_stock;

  if (existing.in_stock === 1 && next === 0) {
    try {
      dispatchWebhookEvent(u, 'pantry.out_of_stock', { pantry_item_id: id, name: existing.name });
    } catch (e) { /* never let a webhook failure block the save */ }
  }

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
  // A name that differs only by plural or case ("tomato" and "Tomatoes")
  // is the same item: the one there, or the one made for an earlier name.
  const byKey = new Map();
  for (const r of db.prepare(
    `SELECT * FROM pantry_items WHERE ${userExpr} AND deleted_at IS NULL AND generic_parent_id IS NULL ORDER BY id`
  ).all(...userArg)) {
    const k = ingredientKey(r.name);
    if (k && !byKey.has(k)) byKey.set(k, r);
  }

  const tx = db.transaction(() => {
    for (const lname of cleaned) {
      const existing = findByName.get(...userArg, lname) || byKey.get(ingredientKey(lname));
      if (existing) { out.set(lname, existing); continue; }
      const result = insert.run(userId, _properCase(lname));
      const row = findById.get(result.lastInsertRowid);
      out.set(lname, row);
      const k = ingredientKey(lname);
      if (k) byKey.set(k, row);
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
