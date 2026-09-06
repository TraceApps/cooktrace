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
    img_url: r.img_url || null,
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
      `SELECT id, name, brand, serving_size, serving_unit, nutrition, barcode
         FROM pantry_items
        WHERE id IN (${placeholders}) AND ${_whereUser(u)} AND deleted_at IS NULL`
    ).all(...Array.from(pantryIds), ..._userArgs(u));
    for (const r of rows) pantryById.set(r.id, r);
  }

  const items = [];
  for (const g of ingredients) {
    for (const it of (g?.items || [])) {
      if (!it || !it.name) continue;
      const pantry = pantryById.get(Number(it.pantry_item_id));
      const item = {
        name: pantry?.name || String(it.name).slice(0, 200),
        brand: pantry?.brand || '',
        quantity: Number.isFinite(Number(it.qty)) ? Number(it.qty) : 1,
        unit: String(it.unit || pantry?.serving_unit || 'g').slice(0, 16),
        portion: Number.isFinite(Number(pantry?.serving_size)) ? Number(pantry.serving_size) : 100,
      };
      if (pantry?.barcode) item.barcode = String(pantry.barcode);
      if (pantry?.nutrition) {
        const n = _safeJson(pantry.nutrition, null);
        if (n && typeof n === 'object' && !Array.isArray(n)) item.nutrition = n;
      }
      items.push(item);
    }
  }

  res.json({
    id: row.id,
    name: row.name,
    img_url: row.img_url || null,
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
