/**
 * /api/v1/pantry
 *
 * Read-only pantry access for authorized federation clients (today,
 * NutriTrace: bulk-import CT pantry items into NT's foods library from
 * Settings, Connected Services, CookTrace, Import All Pantry Items).
 *
 * Design notes:
 *
 *   1. Generic parents with variants are SKIPPED. The user's mental model
 *      is that "Flour" (generic) with "Bread Flour" and "All-Purpose"
 *      variants is one abstract row, not a third pantry item. Only
 *      leaves (standalone items and variants) come across. Standalone =
 *      generic_parent_id IS NULL AND NOT referenced as a parent by any
 *      other row.
 *
 *   2. Nutrition per row uses the same resolver the recipes route uses
 *      (variant own -> variant fallback to parent's designated variant
 *      -> parent's own). Rows that resolve to nothing still ship with
 *      empty nutrition so the user has the shell in their NT library to
 *      link or fill in on the NT side.
 *
 *   3. Calorie derivation via Atwater factors mirrors the recipes route:
 *      when carbs/protein/fat are populated but calories is missing, we
 *      fill calories in (never overriding an explicit value).
 *
 *   4. Portion / unit map to serving_size / serving_unit on the pantry
 *      row when present, else default to 100 g. NT foods use portion +
 *      unit + a per-portion nutrition object.
 */
import { Router } from 'express';
import db from '../../../db.js';
import { wrap } from '../../../logger.js';
import { requireScope } from '../../../middleware/bearer-auth.js';

const router = Router();

router.use(requireScope('read:pantry'));

function _selfOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host  = req.headers['x-forwarded-host'] || req.get('host') || '';
  return host ? `${proto}://${host}` : '';
}

function _absImg(req, u) {
  if (!u) return null;
  const s = String(u);
  if (/^https?:\/\//i.test(s) || /^data:/i.test(s)) return s;
  const origin = _selfOrigin(req);
  if (!origin) return s;
  return origin + (s.startsWith('/') ? '' : '/') + s;
}

function _hasRealNutrition(row) {
  if (!row?.nutrition) return false;
  try {
    const n = JSON.parse(row.nutrition);
    if (!n || typeof n !== 'object') return false;
    for (const [k, v] of Object.entries(n)) {
      if (k === '_derived') continue;
      if (v != null && !(typeof v === 'object' && Object.keys(v).length === 0)) return true;
    }
    return false;
  } catch { return false; }
}

function _deriveCalories(n) {
  if (!n || typeof n !== 'object') return n;
  if (n.calories != null && Number.isFinite(Number(n.calories))) return n;
  const p = Number(n.proteins) || 0;
  const c = Number(n.carbohydrates) || 0;
  const f = Number(n.fat) || 0;
  if (p === 0 && c === 0 && f === 0) return n;
  const kcal = Math.round((p * 4 + c * 4 + f * 9) * 10) / 10;
  return { ...n, calories: kcal };
}

// Same 4-level resolver used by /api/v1/recipes so item-level nutrition
// stays consistent whether the row ships in a recipe or here.
function _makeResolver(pantryById) {
  return function resolve(pantryItemId) {
    if (pantryItemId == null) return null;
    const own = pantryById.get(Number(pantryItemId));
    if (!own) return null;
    const sourceId = own.nutrition_source_variant_id;
    if (sourceId != null) {
      const sourceRow = pantryById.get(sourceId);
      if (sourceRow && sourceRow.generic_parent_id === own.id && _hasRealNutrition(sourceRow)) {
        return sourceRow;
      }
    }
    if (_hasRealNutrition(own)) return own;
    if (own.generic_parent_id != null) {
      const parent = pantryById.get(own.generic_parent_id);
      if (parent && _hasRealNutrition(parent)) return parent;
      if (parent?.nutrition_source_variant_id != null) {
        const sibling = pantryById.get(parent.nutrition_source_variant_id);
        if (sibling && sibling.generic_parent_id === parent.id && _hasRealNutrition(sibling)) {
          return sibling;
        }
      }
    }
    return own;
  };
}

// GET /api/v1/pantry?q=&limit=&offset=
// Returns { items: [...], total } shaped for direct POST to NutriTrace's
// /api/foods endpoint. NT dedups on (source_app, source_external_id)
// so re-runs are safe.
//
// `q` powers NT's Foods-tab CookTrace source chip (search-and-pick a
// single pantry row); omitting it returns everything, which is what the
// bulk Import Pantry action uses. Filtering and paging both happen after
// the leaf-only pass below, because whether a row is a leaf depends on
// the whole set, so `total` always reflects importable rows only.
router.get('/', wrap((req, res) => {
  const userId = req.apiUser.id;
  const q = String(req.query.q || '').trim().toLowerCase();
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : null;
  const rawOffset = Number(req.query.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  const all = db.prepare(`
    SELECT id, name, brand, category, barcode, in_stock, quantity, unit,
           serving_size, serving_unit, serving_label, nutrition, img_url,
           notes, g_per_cup, generic_parent_id, nutrition_source_variant_id,
           updated_at
      FROM pantry_items
     WHERE user_id = ? AND deleted_at IS NULL
     ORDER BY name COLLATE NOCASE
  `).all(userId);

  const pantryById = new Map(all.map(r => [r.id, r]));
  const parentIds = new Set();
  for (const r of all) {
    if (r.generic_parent_id != null) parentIds.add(r.generic_parent_id);
  }
  const resolve = _makeResolver(pantryById);
  const origin = _selfOrigin(req);

  const items = [];
  for (const row of all) {
    // Skip generic parents that have variants. Their leaves already ship.
    if (parentIds.has(row.id)) continue;

    const nutritionRow = resolve(row.id);
    let nutrition = {};
    if (nutritionRow && _hasRealNutrition(nutritionRow)) {
      try {
        const raw = JSON.parse(nutritionRow.nutrition) || {};
        // Drop the derived-marker key CT stores; NT does not use it.
        const { _derived, ...clean } = raw;
        nutrition = _deriveCalories(clean);
      } catch { nutrition = {}; }
    }

    // Pantry-item name for variants includes the parent's noun so NT
    // shows "Flour, Bread" instead of just "Bread". Parent lookup uses
    // pantryById so an orphaned variant (broken FK) still ships.
    let displayName = row.name;
    if (row.generic_parent_id != null) {
      const parent = pantryById.get(row.generic_parent_id);
      if (parent?.name && !row.name.toLowerCase().includes(parent.name.toLowerCase())) {
        displayName = `${parent.name}, ${row.name}`;
      }
    }

    const portion = Number.isFinite(Number(row.serving_size)) && Number(row.serving_size) > 0
      ? Number(row.serving_size) : 100;
    const unit = row.serving_unit || 'g';

    items.push({
      // NT foods shape:
      name: displayName,
      brand: row.brand || null,
      category: row.category || null,
      barcode: row.barcode || null,
      portion,
      unit,
      nutrition,
      img_url: _absImg(req, row.img_url),
      notes: row.notes || null,
      density_g_ml: row.g_per_cup != null ? Number(row.g_per_cup) / 236.588 : null,
      // Federation stamps: dedup + back-link.
      source_app: 'cooktrace',
      source_external_id: `pantry:${row.id}`,
      source_url: origin ? `${origin}/#/pantry/${row.id}` : null,
      updated_at: row.updated_at,
      // Local-only search haystack, stripped before the response. Includes
      // the composed display name, so a variant literally named "Bread"
      // under a "Flour" generic is still found by typing "flour". Without
      // that, hiding the generic parent would make its variants
      // unreachable by the word people actually search for.
      _haystack: [displayName, row.name, row.brand, row.category]
        .filter(Boolean).join(' ').toLowerCase(),
    });
  }

  const matched = q ? items.filter(it => it._haystack.includes(q)) : items;
  const total = matched.length;
  const page = limit != null ? matched.slice(offset, offset + limit) : matched.slice(offset);
  res.json({
    items: page.map(({ _haystack, ...rest }) => rest),
    total,
  });
}));

export default router;
