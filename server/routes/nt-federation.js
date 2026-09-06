/**
 * nt-federation.js — proxy layer to a configured NutriTrace instance.
 *
 * The user's NT URL + bearer token are stored in user_settings (per-user).
 * All requests come through this server (never directly browser → NT) so
 * the bearer token isn't shipped to the WebView and the user's NT
 * instance can be on a private network.
 *
 * Endpoints (all require auth on this app):
 *   POST   /test         — verify URL + token by hitting NT /api/auth/me
 *   GET    /foods?q=     — proxy NT /api/foods?q=
 *   POST   /log-meal     — proxy POST to NT /api/diary entry creation
 */
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

function _getSetting(userId, key) {
  const row = db.prepare(
    `SELECT value FROM user_settings WHERE ${userId == null ? 'user_id IS NULL' : 'user_id = ?'} AND key = ?`
  ).get(...(userId == null ? [key] : [userId, key]));
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function _config(userId) {
  const url = _getSetting(userId, 'ntInstanceUrl');
  const token = _getSetting(userId, 'ntInstanceToken');
  const enabled = _getSetting(userId, 'ntFederationEnabled');
  if (!url || !token) return null;
  if (!/^https?:\/\//.test(url)) return null;
  return { url: url.replace(/\/$/, ''), token, enabled: !!enabled };
}

// Resolve a possibly-relative image path against the NT origin so the
// picker can load it directly. Pass-through for already-absolute URLs
// (so an external image URL from a third-party scrape stays as-is).
function _absoluteUrl(origin, urlPath) {
  if (!urlPath) return null;
  if (/^https?:\/\//i.test(urlPath)) return urlPath;
  if (urlPath.startsWith('//')) return 'https:' + urlPath;
  return origin.replace(/\/$/, '') + (urlPath.startsWith('/') ? urlPath : '/' + urlPath);
}

async function _ntFetch(cfg, path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(cfg.url + path, {
      ...opts,
      headers: {
        'Authorization': `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      signal: ctrl.signal,
    });
    return res;
  } finally { clearTimeout(t); }
}

router.post('/test', wrap(async (req, res) => {
  const u = uid(req);
  // Allow inline override so the Settings page can test before saving.
  const url = (req.body?.url || _getSetting(u, 'ntInstanceUrl') || '').replace(/\/$/, '');
  const token = req.body?.token || _getSetting(u, 'ntInstanceToken');
  if (!url || !token) return res.status(400).json({ ok: false, error: 'URL and token required' });
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ ok: false, error: 'URL must start with http(s)://' });
  try {
    const ntRes = await _ntFetch({ url, token }, '/api/auth/me');
    if (!ntRes.ok) return res.json({ ok: false, error: `NutriTrace returned ${ntRes.status}` });
    const body = await ntRes.json().catch(() => ({}));
    return res.json({ ok: true, user: body.user || null });
  } catch (e) {
    return res.json({ ok: false, error: e.message || 'Connection failed' });
  }
}));

router.get('/foods', wrap(async (req, res) => {
  const u = uid(req);
  const cfg = _config(u);
  if (!cfg || !cfg.enabled) return res.status(503).json({ error: 'Federation not enabled' });
  const q = (req.query.q || '').toString();
  try {
    // NT's federation endpoint lives at /api/v1/foods (bearer-auth +
    // read:foods scope). The legacy /api/foods is cookie-auth only and
    // 401's any bearer token regardless of validity.
    const ntRes = await _ntFetch(cfg, '/api/v1/foods' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (!ntRes.ok) {
      const text = await ntRes.text().catch(() => '');
      return res.status(502).json({
        error: `NutriTrace returned ${ntRes.status} ${ntRes.statusText || ''}`.trim()
          + (text && text.length < 240 ? `: ${text}` : ''),
      });
    }
    const body = await ntRes.json();
    // v1 wire shape: { items: [...], total, limit, offset } with
    // portion/unit instead of serving_size/serving_unit. Normalize to
    // the flat array + legacy field names the client + /import-foods
    // already consume so neither needs to know about wire-version
    // differences.
    const items = Array.isArray(body?.items) ? body.items : (Array.isArray(body) ? body : []);
    res.json(items.map(f => ({
      ...f,
      serving_size: f.serving_size != null ? f.serving_size : f.portion,
      serving_unit: f.serving_unit || f.unit || null,
      // Rewrite NT's relative `/uploads/...` image paths to absolute
      // URLs against the NT origin. Without this the picker's <img>
      // resolves them against cooktrace's own origin and 404's.
      img_url: _absoluteUrl(cfg.url, f.img_url || f.image_url || null),
    })));
  } catch (e) { res.status(502).json({ error: e.message || 'Federation request failed' }); }
}));

// ── POST /import-foods — bulk-import NT foods into the pantry ─────────
// Body: { foods: [<NT food object>, ...], inStock: bool }
// We don't re-fetch from NT here; the client already has the food
// objects from a previous /foods search. Server-side we only check
// federation is enabled (so users can't bulk-stuff the pantry from
// arbitrary JSON outside the federation flow) and then write rows.
//
// Image proxying: NT image URLs typically point at the NT server's
// /uploads. We keep the URL as-is — image-localizer.js will pull and
// re-host on first display via resolveAssetUrl on the recipe view.
router.post('/import-foods', wrap(async (req, res) => {
  const u = uid(req);
  const cfg = _config(u);
  if (!cfg || !cfg.enabled) return res.status(503).json({ error: 'Federation not enabled' });
  const foods = Array.isArray(req.body?.foods) ? req.body.foods : null;
  if (!foods || foods.length === 0) return res.status(400).json({ error: 'foods array required' });
  const inStock = req.body?.inStock !== false ? 1 : 0;

  // Variant import mode (Issue #4 commit 4). Three options:
  //   'flat'                 standalone rows (default).
  //   'variant-of-existing'  all imports become children of the named
  //                          existing pantry item (`parentId`).
  //   'variant-of-new'       a new generic is created from `newGenericName`
  //                          first, then all imports become its children.
  const variantMode = req.body?.variantMode || 'flat';
  let parentId = null;
  if (variantMode === 'variant-of-existing') {
    const requested = parseInt(req.body?.parentId, 10);
    if (!Number.isFinite(requested)) return res.status(400).json({ error: 'parentId required when variantMode is variant-of-existing' });
    const parent = db.prepare(
      `SELECT id, generic_parent_id, deleted_at FROM pantry_items WHERE id = ? AND ${u == null ? 'user_id IS NULL' : 'user_id = ?'}`
    ).get(...(u == null ? [requested] : [requested, u]));
    if (!parent || parent.deleted_at) return res.status(400).json({ error: 'Parent pantry item not found' });
    if (parent.generic_parent_id != null) return res.status(400).json({ error: 'Picked parent is itself a variant; pick a flat or generic item' });
    parentId = parent.id;
  } else if (variantMode === 'variant-of-new') {
    const newName = (req.body?.newGenericName || '').toString().trim();
    if (!newName) return res.status(400).json({ error: 'newGenericName required when variantMode is variant-of-new' });
    // Pick a sensible default photo + category from the first food
    // that has them so the new generic isn't a bare row. The generic
    // is created out-of-stock; child stock drives the aggregate pill.
    const first = foods[0] || {};
    const seed = db.prepare(
      `INSERT INTO pantry_items
         (user_id, name, brand, in_stock, img_url, serving_size, serving_unit, nutrition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      u, newName, null, 0,
      first.image_url || first.img_url || first.imgUrl || null,
      first.serving_size != null ? Number(first.serving_size) : null,
      first.serving_unit || null,
      first.nutrition ? JSON.stringify(first.nutrition) : null,
    );
    parentId = Number(seed.lastInsertRowid);
  }

  const insert = db.prepare(
    `INSERT INTO pantry_items
       (user_id, name, brand, barcode, in_stock, nt_food_id,
        img_url, serving_size, serving_unit, nutrition, generic_parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const created = [];
  const skipped = [];

  // Look up an existing pantry row by case-insensitive name, including
  // soft-deleted ones. Active duplicates → skipped with reason. Soft-
  // deleted matches → resurrected (deleted_at cleared) and refreshed
  // from the NT food so the user gets the latest brand / nutrition /
  // image instead of a duplicate row alongside the tombstone.
  //
  // Variant import: the dedup check is scoped per-parent so the same
  // food can be a flat row AND a variant of a generic at the same time
  // without colliding. The resurrect path preserves whatever parent
  // the existing row had.
  const findExisting = db.prepare(
    `SELECT id, deleted_at FROM pantry_items
     WHERE ${u == null ? 'user_id IS NULL' : 'user_id = ?'}
     AND lower(name) = lower(?)
     AND ${parentId == null ? 'generic_parent_id IS NULL' : 'generic_parent_id = ?'} LIMIT 1`
  );
  const resurrect = db.prepare(
    `UPDATE pantry_items
     SET deleted_at = NULL, updated_at = datetime('now'),
         brand = ?, barcode = ?, in_stock = ?, nt_food_id = ?,
         img_url = ?, serving_size = ?, serving_unit = ?, nutrition = ?,
         generic_parent_id = ?
     WHERE id = ?`
  );

  const tx = db.transaction(() => {
    for (const f of foods) {
      const name = (f.name || '').toString().trim();
      if (!name) { skipped.push({ name: f.name, reason: 'no name' }); continue; }
      const lookupArgs = u == null
        ? (parentId == null ? [name] : [name, parentId])
        : (parentId == null ? [u, name] : [u, name, parentId]);
      const existing = findExisting.get(...lookupArgs);
      if (existing && !existing.deleted_at) {
        skipped.push({ name, reason: 'already in pantry' });
        continue;
      }
      if (existing && existing.deleted_at) {
        resurrect.run(
          f.brand || null,
          f.barcode || null,
          inStock,
          f.id != null ? String(f.id) : null,
          f.image_url || f.img_url || f.imgUrl || null,
          f.serving_size != null ? Number(f.serving_size) : null,
          f.serving_unit || null,
          f.nutrition ? JSON.stringify(f.nutrition) : null,
          parentId,
          existing.id,
        );
        created.push({ id: existing.id, name, restored: true });
        continue;
      }
      const result = insert.run(
        u, name,
        f.brand || null,
        f.barcode || null,
        inStock,
        f.id != null ? String(f.id) : null,
        f.image_url || f.img_url || f.imgUrl || null,
        f.serving_size != null ? Number(f.serving_size) : null,
        f.serving_unit || null,
        f.nutrition ? JSON.stringify(f.nutrition) : null,
        parentId,
      );
      created.push({ id: result.lastInsertRowid, name });
    }
  });
  tx();

  res.status(201).json({ count: created.length, created, skipped });
}));

/**
 * POST /push-recipe
 *
 * Push a completed CT recipe into NT as an is_recipe=1 meals row.
 *
 * Client sends a pre-computed rollup because computeRecipeNutrition
 * lives in src/lib/recipe-nutrition.js on the client and already
 * knows how to resolve variants-of-generics + unit conversions + the
 * skipped-ingredients bookkeeping. Server just:
 *   1. Verifies the recipe belongs to the caller.
 *   2. Loads referenced pantry items to pick up nt_food_id linkage
 *      per ingredient (so imported NT foods get freshened on the NT
 *      side rather than living as stale snapshots).
 *   3. Builds the NT /api/v1/recipes wire payload.
 *   4. POSTs to NT with the stored bearer token.
 *   5. Records the returned NT meal_id on the CT recipes row so a
 *      re-push updates the same row instead of duplicating.
 *
 * Request:
 *   {
 *     recipe_id: 42,                              // required
 *     skipped_ingredients: [                      // optional, from client rollup
 *       { name: "Turmeric", reason: "no nutrition data" }
 *     ]
 *   }
 *
 * Response:
 *   { ok: true, nt_meal_id: 87, updated: false }
 */
router.post('/push-recipe', wrap(async (req, res) => {
  const u = uid(req);
  const cfg = _config(u);
  if (!cfg || !cfg.enabled) {
    return res.status(503).json({ error: 'NutriTrace federation is not enabled. Configure it in Settings > Integrations.' });
  }
  const recipeId = Number(req.body?.recipe_id);
  if (!Number.isFinite(recipeId) || recipeId <= 0) {
    return res.status(400).json({ error: 'recipe_id required' });
  }

  // Ownership check + load.
  const recipe = u == null
    ? db.prepare(`SELECT * FROM recipes WHERE id = ? AND user_id IS NULL AND deleted_at IS NULL`).get(recipeId)
    : db.prepare(`SELECT * FROM recipes WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(recipeId, u);
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });

  let ingredients = [];
  try { ingredients = JSON.parse(recipe.ingredients || '[]'); } catch { ingredients = []; }
  let recipeNutrition = {};
  try { recipeNutrition = JSON.parse(recipe.nutrition || '{}'); } catch { recipeNutrition = {}; }

  // Collect pantry ids referenced so we can batch-load with nt_food_id.
  const pantryIds = new Set();
  for (const group of ingredients) {
    for (const it of (group?.items || [])) {
      if (Number.isFinite(Number(it?.pantry_item_id))) {
        pantryIds.add(Number(it.pantry_item_id));
      }
    }
  }
  let pantryById = new Map();
  if (pantryIds.size) {
    const placeholders = Array.from(pantryIds).map(() => '?').join(',');
    const rows = u == null
      ? db.prepare(`SELECT id, name, brand, serving_size, serving_unit, nutrition, nt_food_id, generic_parent_id, nutrition_source_variant_id FROM pantry_items WHERE id IN (${placeholders}) AND user_id IS NULL AND deleted_at IS NULL`).all(...Array.from(pantryIds))
      : db.prepare(`SELECT id, name, brand, serving_size, serving_unit, nutrition, nt_food_id, generic_parent_id, nutrition_source_variant_id FROM pantry_items WHERE id IN (${placeholders}) AND user_id = ? AND deleted_at IS NULL`).all(...Array.from(pantryIds), u);
    for (const r of rows) pantryById.set(r.id, r);
  }

  // Flatten to per-ingredient item entries for NT. NT's items[] is
  // display data on the recipe row (not the diary log), so we prefer
  // richer names/brands from the pantry row when a pantry link exists
  // and fall back to the free-text ingredient name otherwise.
  const items = [];
  for (const group of ingredients) {
    for (const it of (group?.items || [])) {
      if (!it || !it.name) continue;
      const pantry = pantryById.get(Number(it.pantry_item_id));
      const item = {
        name: pantry?.name || String(it.name).slice(0, 200),
        brand: pantry?.brand || '',
        quantity: Number.isFinite(Number(it.qty)) ? Number(it.qty) : 1,
        unit: String(it.unit || pantry?.serving_unit || 'g').slice(0, 16),
        portion: Number.isFinite(Number(pantry?.serving_size)) ? Number(pantry.serving_size) : 100,
      };
      if (pantry?.nt_food_id != null) {
        item.food_server_id = Number(pantry.nt_food_id);
      }
      if (pantry?.nutrition) {
        let n;
        try { n = JSON.parse(pantry.nutrition); } catch { n = null; }
        if (n && typeof n === 'object') item.nutrition = n;
      }
      items.push(item);
    }
  }

  if (items.length === 0) {
    return res.status(400).json({ error: 'Recipe has no ingredients to push' });
  }

  // Client-supplied skipped-ingredient list (from computeRecipeNutrition
  // on RecipeView). Convert to a compact string list for NT's
  // import_warnings column.
  const skipped = Array.isArray(req.body?.skipped_ingredients) ? req.body.skipped_ingredients : [];
  const warnings = [];
  if (skipped.length) {
    const names = skipped.map(s => s?.name).filter(Boolean).slice(0, 5).join(', ');
    const remainder = skipped.length > 5 ? ` (+${skipped.length - 5} more)` : '';
    warnings.push(
      `${skipped.length} ingredient${skipped.length === 1 ? '' : 's'} without nutrition data: ${names}${remainder}. Totals may be underestimated.`
    );
  }

  // Absolute self-URL for the source_url so the NT side can deep-link
  // back to this recipe. Best-effort: origin comes from the config we
  // already know CT is reachable at, taken from the request headers.
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host  = req.headers['x-forwarded-host'] || req.get('host') || '';
  const sourceUrl = host ? `${proto}://${host}/#/recipes/${recipeId}` : null;

  const wire = {
    source_app: 'cooktrace',
    source_external_id: `recipe:${recipeId}`,
    source_url: sourceUrl,
    name: recipe.name,
    items,
    nutrition: recipeNutrition,
    servings: Number.isFinite(Number(recipe.servings)) ? Number(recipe.servings) : 1,
    img_url: recipe.img_url || null,
    import_warnings: warnings,
  };

  let ntRes;
  try {
    ntRes = await _ntFetch(cfg, '/api/v1/recipes', {
      method: 'POST',
      body: JSON.stringify(wire),
    });
  } catch (e) {
    return res.status(502).json({ error: e.message || 'Federation request failed' });
  }

  if (!ntRes.ok) {
    const text = await ntRes.text().catch(() => '');
    return res.status(502).json({
      error: `NutriTrace returned ${ntRes.status} ${ntRes.statusText || ''}`.trim()
        + (text && text.length < 240 ? `: ${text}` : ''),
    });
  }

  const body = await ntRes.json().catch(() => ({}));
  const ntMealId = Number(body?.meal_id);
  if (Number.isFinite(ntMealId) && ntMealId > 0) {
    db.prepare(`UPDATE recipes SET nt_meal_id = ? WHERE id = ?`).run(ntMealId, recipe.id);
  }

  res.json({
    ok: true,
    nt_meal_id: ntMealId || null,
    updated: !!body?.updated,
    warnings_sent: warnings.length,
  });
}));

router.post('/log-meal', wrap(async (req, res) => {
  const u = uid(req);
  const cfg = _config(u);
  if (!cfg || !cfg.enabled) return res.status(503).json({ error: 'Federation not enabled' });
  // Body shape: { date, items: [{ food_id, quantity, name, ... }], meal: 'breakfast'|... }
  try {
    const ntRes = await _ntFetch(cfg, `/api/diary/${encodeURIComponent(req.body?.date || '')}`, {
      method: 'PUT',
      body: JSON.stringify(req.body || {}),
    });
    if (!ntRes.ok) return res.status(502).json({ error: `NutriTrace returned ${ntRes.status}` });
    res.json(await ntRes.json());
  } catch (e) { res.status(502).json({ error: e.message || 'Federation request failed' }); }
}));

export default router;
