/**
 * /api/v1/recipes
 *
 * Read-only recipe access for authorized federation clients (today,
 * NutriTrace: source-chip pull into NT's Foods search, then opens the
 * picked recipe in NT's MealEditor as an is_recipe=1 meal). Every
 * query is scoped to the token owner (req.apiUser.id) so a token
 * cannot walk another user's catalog.
 *
 * Endpoints:
 *   GET /api/v1/recipes?q=&limit=&offset=
 *     Search summaries (id, name, img_url, servings, nutrition, updated_at).
 *   GET /api/v1/recipes/:id
 *     Full recipe: name, servings, portion, unit, image, rollup nutrition,
 *     source_url (deep-link back to CT), and flattened items[] with
 *     per-ingredient name / quantity / unit / portion + a nutrition
 *     snapshot copied from the linked pantry row when available.
 *
 * Design notes:
 *
 *   1. Nutrition on items[] is copied from the linked pantry row at
 *      pull time. NT stores it verbatim: it is a snapshot, not a live
 *      link. If the CT pantry entry gets edited later, the NT copy
 *      does not follow. This matches how NT's Mealie import already
 *      works: the pulled data becomes an NT-owned meal.
 *
 *   2. Ingredients without a resolvable pantry link (or with pantry
 *      rows that have no nutrition data) still ship, just without a
 *      nutrition object. NT surfaces those as loose items the user
 *      can fill in on the NT side. This mirrors NT's MealEditor's
 *      existing tolerance for hand-typed items.
 *
 *   3. The rollup `nutrition` on the recipe row is whatever CT has
 *      stored (from the client-side computeRecipeNutrition run via
 *      Recompute). CT does not re-compute at pull time. If the row
 *      has never been Recomputed, `nutrition` may be empty; NT lets
 *      the user run its own recompute after import.
 */
import { Router } from 'express';
import db from '../../../db.js';
import { wrap } from '../../../logger.js';
import { requireScope } from '../../../middleware/bearer-auth.js';

const router = Router();

router.use(requireScope('read:recipes'));

function _selfOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host  = req.headers['x-forwarded-host'] || req.get('host') || '';
  return host ? `${proto}://${host}` : '';
}

function _sourceUrl(req, id) {
  const origin = _selfOrigin(req);
  return origin ? `${origin}/#/recipes/${id}` : null;
}

// Absolutize a possibly-relative CT img_url so NT (on a different origin)
// can load it directly via <img>. Absolute URLs pass through unchanged.
function _absImg(req, u) {
  if (!u) return null;
  const s = String(u);
  if (/^https?:\/\//i.test(s) || /^data:/i.test(s)) return s;
  const origin = _selfOrigin(req);
  if (!origin) return s;
  return origin + (s.startsWith('/') ? '' : '/') + s;
}

// Parse CT ingredient qty strings: '2', '1/2', '1 1/2', '0.75', 'to taste'.
// Returns a positive Number or null. Whole-plus-fraction and pure fraction
// forms both handled since CT stores freeform text.
function _parseQty(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  const mMixed = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mMixed) {
    const n = Number(mMixed[1]) + Number(mMixed[2]) / Number(mMixed[3]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const mFrac = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (mFrac) {
    const n = Number(mFrac[1]) / Number(mFrac[2]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function _uidFor(req) {
  const id = req.apiUser?.id;
  return id == null || id === 0 ? null : id;
}

function _whereUser(u) {
  return u == null ? 'user_id IS NULL' : 'user_id = ?';
}
function _userArgs(u) {
  return u == null ? [] : [u];
}

function _safeJson(txt, fallback) {
  try { return JSON.parse(txt || 'null') ?? fallback; }
  catch { return fallback; }
}

// GET /api/v1/recipes: list + optional search
router.get('/', wrap((req, res) => {
  const u = _uidFor(req);
  const q = String(req.query.q || '').trim().slice(0, 200);
  const limit = (() => {
    const n = Number(req.query.limit);
    if (!Number.isFinite(n)) return 25;
    return Math.min(Math.max(1, Math.floor(n)), 100);
  })();
  const offset = (() => {
    const n = Number(req.query.offset);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  })();

  const where = [`${_whereUser(u)}`, `deleted_at IS NULL`];
  const args = [..._userArgs(u)];
  if (q) {
    where.push(`(LOWER(name) LIKE ? OR LOWER(COALESCE(description, '')) LIKE ?)`);
    const like = `%${q.toLowerCase()}%`;
    args.push(like, like);
  }
  const whereSql = where.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) AS n FROM recipes WHERE ${whereSql}`).get(...args).n;

  const rows = db.prepare(
    `SELECT id, name, img_url, servings, nutrition, updated_at
       FROM recipes WHERE ${whereSql}
       ORDER BY updated_at DESC, id DESC
       LIMIT ? OFFSET ?`
  ).all(...args, limit, offset);

  const items = rows.map(r => ({
    id: r.id,
    name: r.name,
    img_url: _absImg(req, r.img_url),
    servings: Number.isFinite(Number(r.servings)) ? Number(r.servings) : 1,
    portion: null,
    unit: 'g',
    nutrition: _safeJson(r.nutrition, {}),
    source_url: _sourceUrl(req, r.id),
    updated_at: r.updated_at || null,
  }));

  res.json({ items, total, limit, offset });
}));

// GET /api/v1/recipes/:id: single recipe with flattened items
router.get('/:id', wrap((req, res) => {
  const u = _uidFor(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(404).json({ error: 'not_found', code: 'not_found' });
  }

  const row = db.prepare(
    `SELECT * FROM recipes WHERE id = ? AND ${_whereUser(u)} AND deleted_at IS NULL`
  ).get(id, ..._userArgs(u));
  if (!row) {
    return res.status(404).json({ error: 'not_found', code: 'not_found' });
  }

  const ingredients = _safeJson(row.ingredients, []);
  const nutrition = _safeJson(row.nutrition, {});

  // Batch-load referenced pantry items so per-ingredient nutrition
  // snapshots and richer names / brands can ride along with the pull.
  const pantryIds = new Set();
  for (const g of ingredients) {
    for (const it of (g?.items || [])) {
      if (Number.isFinite(Number(it?.pantry_item_id))) {
        pantryIds.add(Number(it.pantry_item_id));
      }
    }
  }
  const pantryById = new Map();
  if (pantryIds.size) {
    const placeholders = Array.from(pantryIds).map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, name, brand, serving_size, serving_unit, nutrition, barcode, img_url,
              generic_parent_id, nutrition_source_variant_id
         FROM pantry_items
        WHERE id IN (${placeholders}) AND ${_whereUser(u)} AND deleted_at IS NULL`
    ).all(...Array.from(pantryIds), ..._userArgs(u));
    for (const r of rows) pantryById.set(r.id, r);
    // Variant follow-up: any pantry row that inherits nutrition from a
    // child variant (nutrition_source_variant_id) needs the variant row
    // loaded too, or the resolver below cannot follow the chain. Query
    // the missing ids in a second batch and add them to the same map.
    const variantIds = [];
    for (const r of rows) {
      if (r.nutrition_source_variant_id != null && !pantryById.has(r.nutrition_source_variant_id)) {
        variantIds.push(r.nutrition_source_variant_id);
      }
    }
    if (variantIds.length) {
      const p2 = variantIds.map(() => '?').join(',');
      const more = db.prepare(
        `SELECT id, name, brand, serving_size, serving_unit, nutrition, barcode, img_url,
                generic_parent_id, nutrition_source_variant_id
           FROM pantry_items
          WHERE id IN (${p2}) AND ${_whereUser(u)} AND deleted_at IS NULL`
      ).all(...variantIds, ..._userArgs(u));
      for (const r of more) pantryById.set(r.id, r);
    }
  }

  // Derive calories from macros (Atwater factors: 4/4/9 kcal per gram
  // of protein / carbs / fat) when a nutrition blob has usable macros
  // but no stored calories field. Honey and similar pantry entries that
  // only carry carbs + sugars would otherwise ship as 0 kcal on the NT
  // side even though the caloric value is unambiguously computable.
  // Never overrides an explicit calories value; only fills the gap.
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

  // Cheap non-empty check for a stored nutrition JSON blob. "{}" and
  // NULL both count as empty; a blob with any populated key wins.
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

  // Resolve which pantry row supplies nutrition for a given linked item.
  // The explicit designation (nutrition_source_variant_id on a generic)
  // ALWAYS wins over the generic's own partial nutrition, because the
  // user set that field precisely to say "the variant is authoritative,
  // ignore anything I typed on the parent". Without this priority a
  // generic with a stray carb value would short-circuit the walk and
  // ship partial nutrition instead of the variant's full profile.
  //
  // Order:
  //   1. Generic -> designated variant (explicit source wins).
  //   2. Own row's nutrition (variant or flat with populated values).
  //   3. Variant -> generic parent fallback (variant has no own values,
  //      but the parent generic holds them, or points at a different
  //      variant whose values fill in).
  //   4. Nothing usable: return own so the caller can decide to omit.
  function _resolveNutritionSource(pantryItemId) {
    if (pantryItemId == null) return null;
    const own = pantryById.get(Number(pantryItemId));
    if (!own) return null;
    // Generic -> designated variant, before falling back to own.
    const sourceId = own.nutrition_source_variant_id;
    if (sourceId != null) {
      const sourceRow = pantryById.get(sourceId);
      if (sourceRow && sourceRow.generic_parent_id === own.id && _hasRealNutrition(sourceRow)) {
        return sourceRow;
      }
    }
    if (_hasRealNutrition(own)) return own;
    // Variant -> generic parent fallback.
    if (own.generic_parent_id != null) {
      const parent = pantryById.get(own.generic_parent_id);
      if (parent && _hasRealNutrition(parent)) return parent;
      // The generic might itself inherit from a different variant; follow
      // one more hop so a recipe linking to variant A of generic G whose
      // designated source is variant B still picks up B's values.
      if (parent?.nutrition_source_variant_id != null) {
        const sibling = pantryById.get(parent.nutrition_source_variant_id);
        if (sibling && sibling.generic_parent_id === parent.id && _hasRealNutrition(sibling)) {
          return sibling;
        }
      }
    }
    return own;
  }

  // Name fallback map. Imported recipes (Mealie/Paprika/text/URL) and
  // freshly typed ingredients often have no pantry_item_id, but the
  // user's pantry usually has an entry with the same name. Load EVERY
  // non-deleted pantry row (including generics whose own nutrition is
  // empty because they inherit from a variant, and including variants
  // whose own nutrition is empty because their generic holds the
  // values) so the resolver below can walk the chain in either
  // direction. Filtering by nutrition IS NOT NULL here would drop
  // exactly those inheriting rows and mask the fix.
  const pantryByName = new Map();
  try {
    const nameRows = db.prepare(
      `SELECT id, name, brand, serving_size, serving_unit, nutrition, barcode, img_url,
              generic_parent_id, nutrition_source_variant_id
         FROM pantry_items
        WHERE ${_whereUser(u)} AND deleted_at IS NULL`
    ).all(..._userArgs(u));
    for (const r of nameRows) {
      // Fold every row into the byId map too so the resolver can walk
      // generic->variant and variant->generic without needing another
      // round trip. Duplicate loads are harmless (Map dedups by key).
      pantryById.set(r.id, r);
      const key = String(r.name || '').trim().toLowerCase();
      if (key && !pantryByName.has(key)) pantryByName.set(key, r);
    }
  } catch { /* absent-table safety, though pantry_items always exists */ }

  const items = [];
  for (const g of ingredients) {
    for (const it of (g?.items || [])) {
      if (!it || !it.name) continue;
      // Drop section headers: entries with no qty AND no unit AND no
      // pantry link. Users type these as free-text separators ("FOR THE
      // PASTRY:") inside the ingredient list; they carry no measurement
      // and would look wrong showing as 100g rows on the NT side.
      const rawQty = it.qty == null ? '' : String(it.qty).trim();
      const rawUnit = it.unit == null ? '' : String(it.unit).trim();
      const hasPantry = pantryById.has(Number(it.pantry_item_id));
      if (!rawQty && !rawUnit && !hasPantry) continue;

      // Prefer explicit pantry_item_id link; fall back to name match
      // so recipes with un-linked ingredients still get nutrition.
      let pantry = pantryById.get(Number(it.pantry_item_id));
      if (!pantry) {
        const nameKey = String(it.name || '').trim().toLowerCase();
        if (nameKey) pantry = pantryByName.get(nameKey) || null;
      }
      // Variant resolver: a generic pantry item with no own nutrition
      // may inherit from a specific variant. Do this AFTER the pantry
      // row is chosen so both id-based and name-based hits get the
      // variant follow-up. Nutrition falls through if the linked row
      // already has its own nutrition (sourceId will be null).
      const nutritionRow = pantry ? _resolveNutritionSource(pantry.id) : null;
      const parsedQty = _parseQty(rawQty);
      const unit = rawUnit || pantry?.serving_unit || '';

      const item = {
        name: pantry?.name || String(it.name).slice(0, 200),
        brand: pantry?.brand || '',
        // quantity = numeric factor NT MealEditor multiplies nutrition by.
        // portion + unit = the ingredient's own serving size, shown as
        // the row's "portion" text. Prefer parsed qty and CT unit so the
        // NT row reads e.g. "2 cup" or "0.5 tsp" instead of "100 g".
        quantity: 1,
        portion: parsedQty ?? 1,
        unit: String(unit).slice(0, 16),
      };
      if (rawQty && !parsedQty) item.qty_text = rawQty.slice(0, 40);
      if (pantry?.barcode) item.barcode = String(pantry.barcode);
      // Per-ingredient thumbnail from the linked pantry row. Absolutized
      // so NT (a different origin) can fetch it server-side and self-host
      // it. Without this every imported ingredient renders as NT's grey
      // placeholder icon even when the CT pantry row has a photo.
      if (pantry?.img_url) item.img_url = _absImg(req, pantry.img_url);
      // Nutrition comes from the resolved row (variant when applicable),
      // then falls through to the linked row's own nutrition if the
      // resolver returned the same row (no inheritance in play).
      const nutritionSrc = nutritionRow || pantry;
      if (nutritionSrc?.nutrition) {
        const raw = _safeJson(nutritionSrc.nutrition, null);
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          // Fill missing calories from macros so pantry entries with
          // partial nutrition (e.g. Honey with just carbs + sugars) do
          // not ship as 0 kcal to NT even when the caloric value is
          // trivially derivable.
          item.nutrition = _deriveCalories(raw);
        }
      }
      items.push(item);
    }
  }

  res.json({
    id: row.id,
    name: row.name,
    img_url: _absImg(req, row.img_url),
    servings: Number.isFinite(Number(row.servings)) ? Number(row.servings) : 1,
    portion: null,
    unit: 'g',
    nutrition,
    items,
    source_url: _sourceUrl(req, row.id),
    updated_at: row.updated_at || null,
  });
}));

export default router;
