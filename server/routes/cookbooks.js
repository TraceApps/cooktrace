/**
 * cookbooks.js — user-curated recipe collections.
 *
 * A recipe lives in N cookbooks via the recipe_cookbook_links join.
 * Cookbooks are user-scoped, soft-deleted, and ordered by sort_order
 * (with insertion order as the tiebreaker).
 */
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
// Same recipe-card hydration the Recipes tab uses (category, tags,
// rating, pantry_match) — cookbook recipe rows were previously pulled
// with a much narrower SELECT and no hydration step, so a recipe's
// card looked materially thinner inside a cookbook than on the
// Recipes tab. See server/lib/recipe-hydrate.js for why this is
// shared rather than a second, thinner copy.
import {
  hydrateRecipe,
  matchSummary,
  buildStockSet,
  buildCategoryMap,
} from '../lib/recipe-hydrate.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const userClause = (u) => u == null ? 'user_id IS NULL' : 'user_id = ?';
const userArgs   = (u) => u == null ? [] : [u];

function _slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'cookbook';
}

function _hydrate(row, recipeCount = null) {
  if (!row) return null;
  let smart_filter = null;
  if (row.smart_filter_json) {
    try { smart_filter = JSON.parse(row.smart_filter_json); } catch {}
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    cover_image_url: row.cover_image_url,
    is_smart: !!row.is_smart,
    smart_filter,
    sort_order: row.sort_order,
    recipe_count: recipeCount,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Evaluate a smart-filter JSON against the user's recipes and return
// the matching rows. Supported criteria:
//   { category_id, tags: [], favorites_only, min_rating, max_total_minutes }
// Tags use AND matching (every listed tag must be present).
function _evalSmartFilter(userId, filter) {
  if (!filter || typeof filter !== 'object') return [];
  const where = [`r.deleted_at IS NULL`];
  const args = [];
  if (userId == null) where.push(`r.user_id IS NULL`);
  else { where.push(`r.user_id = ?`); args.push(userId); }
  if (Number.isFinite(filter.category_id)) {
    where.push(`r.category_id = ?`); args.push(filter.category_id);
  }
  if (filter.favorites_only) where.push(`r.favorite = 1`);
  if (Number.isFinite(filter.min_rating)) {
    where.push(`r.rating >= ?`); args.push(filter.min_rating);
  }
  if (Number.isFinite(filter.max_total_minutes)) {
    where.push(`COALESCE(r.prep_minutes, 0) + COALESCE(r.cook_minutes, 0) <= ?`);
    args.push(filter.max_total_minutes);
  }
  // Full row (not a narrow column list) — the caller runs every row
  // through hydrateRecipe/matchSummary just like the non-smart branch,
  // so a smart cookbook's cards get the same category/tags/rating/
  // pantry_match as everywhere else recipe cards render.
  const sql = `
    SELECT r.*
      FROM recipes r
     WHERE ${where.join(' AND ')}
     ORDER BY r.updated_at DESC
  `;
  let rows = db.prepare(sql).all(...args);
  // Tag AND-match runs in JS (recipes.tags is JSON-encoded). Cheap
  // enough for any household-scale library.
  const tagFilter = Array.isArray(filter.tags) ? filter.tags.map(s => String(s).toLowerCase()) : [];
  if (tagFilter.length > 0) {
    rows = rows.filter(r => {
      let arr;
      try { arr = JSON.parse(r.tags || '[]'); } catch { arr = []; }
      const have = new Set((Array.isArray(arr) ? arr : []).map(t => String(t).toLowerCase()));
      return tagFilter.every(t => have.has(t));
    });
  }
  return rows;
}

// userClause variant for an aliased table (the JOIN paths below).
const userClauseAliased = (u, alias) => u == null ? `${alias}.user_id IS NULL` : `${alias}.user_id = ?`;

// ── GET / — list cookbooks with recipe counts ──────────────────────────
router.get('/', wrap((req, res) => {
  const u = uid(req);
  const rows = db.prepare(
    `SELECT c.*, (
        SELECT COUNT(*) FROM recipe_cookbook_links l
         WHERE l.cookbook_id = c.id
       ) AS recipe_count
       FROM cookbooks c
      WHERE ${userClauseAliased(u, 'c')} AND c.deleted_at IS NULL
      ORDER BY c.sort_order ASC, c.name ASC`
  ).all(...userArgs(u));
  res.json(rows.map(r => _hydrate(r, r.recipe_count)));
}));

// ── PUT /order — rewrite the global cookbook display order ─────────────
// body: { cookbook_ids: [...] } in the desired order.
// Declared before /:id so the static path doesn't get matched as :id.
router.put('/order', wrap((req, res) => {
  const u = uid(req);
  const ids = Array.isArray(req.body?.cookbook_ids)
    ? req.body.cookbook_ids.map(n => parseInt(n, 10)).filter(Number.isFinite)
    : [];
  if (ids.length === 0) return res.status(400).json({ error: 'cookbook_ids required' });
  const own = db.prepare(`SELECT id FROM cookbooks WHERE id = ? AND ${userClause(u)} AND deleted_at IS NULL`);
  const upd = db.prepare(`UPDATE cookbooks SET sort_order = ?, updated_at = datetime('now') WHERE id = ?`);
  const tx = db.transaction(() => {
    ids.forEach((cid, i) => {
      const r = own.get(cid, ...userArgs(u));
      if (r) upd.run(i, cid);
    });
  });
  tx();
  res.json({ ok: true });
}));

// ── GET /shared-with-me — cookbooks others have shared with me ────────
// Static route declared BEFORE /:id so the string 'shared-with-me'
// doesn't get matched as an :id. Mirrors /api/recipes/shared-with-me
// including the via_kitchen_name enrichment so the client can badge
// each card with "Shared by X" + a Kitchen chip.
router.get('/shared-with-me', wrap((req, res) => {
  const u = uid(req);
  if (u == null) return res.json([]);
  const rows = db.prepare(
    `SELECT c.*,
            (SELECT COUNT(*) FROM recipe_cookbook_links l WHERE l.cookbook_id = c.id) AS recipe_count,
            gu.username AS shared_by_username,
            s.via_kitchen_id,
            k.name AS via_kitchen_name
       FROM cookbook_shares s
       JOIN cookbooks c ON c.id = s.cookbook_id
       LEFT JOIN users    gu ON gu.id = s.granted_by
       LEFT JOIN kitchens k  ON k.id  = s.via_kitchen_id
      WHERE s.grantee_id = ? AND c.deleted_at IS NULL
      ORDER BY s.granted_at DESC`
  ).all(u);
  res.json(rows.map(r => ({
    ..._hydrate(r, r.recipe_count),
    shared_with_me: true,
    shared_by: r.shared_by_username || null,
    via_kitchen_id: r.via_kitchen_id ?? null,
    via_kitchen_name: r.via_kitchen_name ?? null,
  })));
}));

// ── GET /:id — single cookbook + the recipes inside ─────────────────────
// Accessible to the owner OR anyone the cookbook has been shared with
// (per-user grant or Kitchen fanout). Non-owner reads are read-only;
// recipes inside the cookbook that the reader doesn't have their own
// access to are flagged `locked: true` with everything but id/name
// scrubbed, so the shared cookbook doesn't become a discovery
// mechanism that bypasses recipe-level permissions.
router.get('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const cb = db.prepare(
    `SELECT * FROM cookbooks WHERE id = ? AND deleted_at IS NULL`
  ).get(id);
  if (!cb) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && cb.user_id == null) || cb.user_id === u;

  let sharedRow = null;
  if (!isOwner && u != null) {
    sharedRow = db.prepare(
      `SELECT s.granted_by, s.via_kitchen_id,
              gu.username AS shared_by_username,
              k.name AS via_kitchen_name
         FROM cookbook_shares s
         LEFT JOIN users    gu ON gu.id = s.granted_by
         LEFT JOIN kitchens k  ON k.id  = s.via_kitchen_id
        WHERE s.cookbook_id = ? AND s.grantee_id = ?`
    ).get(id, u);
  }
  if (!isOwner && !sharedRow) return res.status(403).json({ error: 'Forbidden' });

  let recipes;
  if (cb.is_smart) {
    // Smart cookbook: re-evaluate the filter every read. Smart filters
    // always target the OWNER's recipes — the reader sees exactly
    // what the owner sees. Recipes the reader can't independently
    // access get locked below.
    let filter = null;
    try { filter = cb.smart_filter_json ? JSON.parse(cb.smart_filter_json) : null; } catch {}
    recipes = _evalSmartFilter(cb.user_id, filter || {});
  } else {
    // Full row (not the old narrow column list) so hydrateRecipe below
    // can resolve category / tags / ingredients the same as every
    // other recipe-card surface. link_order still rides along for
    // locked-placeholder sort stability.
    recipes = db.prepare(
      `SELECT r.*, l.sort_order AS link_order
         FROM recipe_cookbook_links l
         JOIN recipes r ON r.id = l.recipe_id
        WHERE l.cookbook_id = ? AND r.deleted_at IS NULL
        ORDER BY l.sort_order ASC, l.added_at ASC`
    ).all(id);
  }

  // Access filter for non-owner reads: owned by them OR shared to
  // them via recipe_shares. Owners see everything they added.
  let accessible = null;
  if (!isOwner && u != null) {
    const ids = recipes.map(r => r.id);
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      accessible = new Set(
        db.prepare(
          `SELECT r.id FROM recipes r
            WHERE r.id IN (${ph}) AND r.deleted_at IS NULL
              AND (r.user_id = ?
                   OR EXISTS (SELECT 1 FROM recipe_shares s
                               WHERE s.recipe_id = r.id AND s.grantee_id = ?))`
        ).all(...ids, u, u).map(r => r.id)
      );
    } else {
      accessible = new Set();
    }
  }

  // Category map is scoped to the cookbook OWNER (cb.user_id), not the
  // current viewer — recipe.category_id always points into the
  // owner's own recipe_categories table, regardless of who's reading.
  // pantry_match only makes sense for the owner's own read: "N of M
  // ingredients you have" needs to mean the current viewer's pantry,
  // and for a shared-cookbook read that's a different person's pantry
  // than the recipe owner's — so, matching how /recipes/shared-with-me
  // already handles this (it omits pantry_match entirely rather than
  // guess whose stock to check), only compute it when isOwner.
  const catMap = buildCategoryMap(cb.user_id);
  const stockSet = isOwner ? buildStockSet(cb.user_id) : null;

  const hydratedRecipes = recipes.map(r => {
    if (accessible && !accessible.has(r.id)) {
      // Locked — expose enough to render a placeholder row (name + id
      // + link_order for sort stability) but strip everything else.
      return {
        id: r.id,
        name: r.name,
        link_order: r.link_order ?? null,
        locked: true,
      };
    }
    const hydrated = hydrateRecipe(r, catMap);
    if (stockSet) hydrated.pantry_match = matchSummary(hydrated.ingredients, stockSet);
    return hydrated;
  });

  res.json({
    ..._hydrate(cb, hydratedRecipes.length),
    recipes: hydratedRecipes,
    ...(sharedRow ? {
      shared_with_me: true,
      shared_by: sharedRow.shared_by_username || null,
      via_kitchen_id: sharedRow.via_kitchen_id ?? null,
      via_kitchen_name: sharedRow.via_kitchen_name ?? null,
    } : {}),
  });
}));

// ── POST / — create ─────────────────────────────────────────────────────
router.post('/', wrap((req, res) => {
  const u = uid(req);
  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const description = req.body?.description ? String(req.body.description).trim() || null : null;
  const cover_image_url = req.body?.cover_image_url ? String(req.body.cover_image_url).trim() || null : null;
  const is_smart = req.body?.is_smart ? 1 : 0;
  // Validate + minify the smart filter. Drop unknown keys so the JSON
  // we store stays clean across schema iterations.
  let smart_filter_json = null;
  if (is_smart && req.body?.smart_filter && typeof req.body.smart_filter === 'object') {
    const f = req.body.smart_filter;
    const clean = {};
    if (Number.isFinite(parseInt(f.category_id, 10))) clean.category_id = parseInt(f.category_id, 10);
    if (Array.isArray(f.tags)) clean.tags = f.tags.map(s => String(s).trim()).filter(Boolean);
    if (f.favorites_only === true) clean.favorites_only = true;
    if (Number.isFinite(parseInt(f.min_rating, 10))) clean.min_rating = parseInt(f.min_rating, 10);
    if (Number.isFinite(parseInt(f.max_total_minutes, 10))) clean.max_total_minutes = parseInt(f.max_total_minutes, 10);
    smart_filter_json = JSON.stringify(clean);
  }
  let slug = _slugify(name);
  let n = 2;
  while (db.prepare(
    `SELECT 1 FROM cookbooks WHERE ${userClause(u)} AND slug = ?`
  ).get(...userArgs(u), slug)) {
    slug = `${_slugify(name)}-${n++}`;
  }
  const maxOrder = db.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) AS m FROM cookbooks WHERE ${userClause(u)} AND deleted_at IS NULL`
  ).get(...userArgs(u)).m;
  const result = db.prepare(
    `INSERT INTO cookbooks (user_id, name, slug, description, cover_image_url, is_smart, smart_filter_json, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(u, name, slug, description, cover_image_url, is_smart, smart_filter_json, maxOrder + 1);
  const row = db.prepare(`SELECT * FROM cookbooks WHERE id = ?`).get(result.lastInsertRowid);
  res.status(201).json(_hydrate(row, 0));
}));

// ── PUT /:id — update ───────────────────────────────────────────────────
router.put('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(`SELECT * FROM cookbooks WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && existing.user_id == null) || existing.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

  const name        = req.body?.name != null ? (String(req.body.name).trim() || existing.name) : existing.name;
  const description = req.body?.description !== undefined
    ? (req.body.description ? String(req.body.description).trim() : null)
    : existing.description;
  const cover_image_url = req.body?.cover_image_url !== undefined
    ? (req.body.cover_image_url ? String(req.body.cover_image_url).trim() : null)
    : existing.cover_image_url;
  const sort_order  = req.body?.sort_order != null && Number.isFinite(parseInt(req.body.sort_order, 10))
    ? parseInt(req.body.sort_order, 10) : existing.sort_order;

  // smart_filter passes through if explicitly provided; otherwise keep
  // existing. Toggling is_smart off blanks the filter so the cookbook
  // becomes a regular link-table one (its existing links, if any,
  // resume control of contents).
  let nextIsSmart = existing.is_smart;
  let nextFilterJson = existing.smart_filter_json;
  if (req.body?.is_smart !== undefined) nextIsSmart = req.body.is_smart ? 1 : 0;
  if (nextIsSmart && req.body?.smart_filter && typeof req.body.smart_filter === 'object') {
    const f = req.body.smart_filter;
    const clean = {};
    if (Number.isFinite(parseInt(f.category_id, 10))) clean.category_id = parseInt(f.category_id, 10);
    if (Array.isArray(f.tags)) clean.tags = f.tags.map(s => String(s).trim()).filter(Boolean);
    if (f.favorites_only === true) clean.favorites_only = true;
    if (Number.isFinite(parseInt(f.min_rating, 10))) clean.min_rating = parseInt(f.min_rating, 10);
    if (Number.isFinite(parseInt(f.max_total_minutes, 10))) clean.max_total_minutes = parseInt(f.max_total_minutes, 10);
    nextFilterJson = JSON.stringify(clean);
  }
  if (!nextIsSmart) nextFilterJson = null;

  db.prepare(
    `UPDATE cookbooks
        SET name = ?, description = ?, cover_image_url = ?, sort_order = ?,
            is_smart = ?, smart_filter_json = ?,
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(name, description, cover_image_url, sort_order, nextIsSmart, nextFilterJson, id);
  const row = db.prepare(`SELECT * FROM cookbooks WHERE id = ?`).get(id);
  const cnt = db.prepare(`SELECT COUNT(*) AS n FROM recipe_cookbook_links WHERE cookbook_id = ?`).get(id).n;
  res.json(_hydrate(row, cnt));
}));

// ── DELETE /:id — soft delete ───────────────────────────────────────────
router.delete('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(`SELECT * FROM cookbooks WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && existing.user_id == null) || existing.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

  db.prepare(
    `UPDATE cookbooks SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(id);
  // Hard-delete the join rows so a future cookbook with a recycled id
  // doesn't unexpectedly inherit recipes. (Schema FK is ON DELETE
  // CASCADE; the soft-delete on the parent doesn't trigger that, so
  // do it explicitly.)
  db.prepare(`DELETE FROM recipe_cookbook_links WHERE cookbook_id = ?`).run(id);
  res.json({ ok: true });
}));

// ── POST /:id/recipes — add recipes ─────────────────────────────────────
// body: { recipe_ids: [1,2,3] }
router.post('/:id/recipes', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const cb = db.prepare(`SELECT * FROM cookbooks WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!cb) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && cb.user_id == null) || cb.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

  const ids = Array.isArray(req.body?.recipe_ids) ? req.body.recipe_ids.map(n => parseInt(n, 10)).filter(Number.isFinite) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'recipe_ids required' });

  // Filter to recipes the user can actually see: their own OR recipes
  // that have been shared with them via recipe_shares (per-user grant
  // or fanned out from a Kitchen). Non-accessible ids are silently
  // dropped so an accidental include doesn't 400 the whole batch.
  const placeholders = ids.map(() => '?').join(',');
  const accessibleIds = new Set(
    db.prepare(
      u == null
        ? `SELECT id FROM recipes
             WHERE id IN (${placeholders})
               AND user_id IS NULL AND deleted_at IS NULL`
        : `SELECT r.id FROM recipes r
             WHERE r.id IN (${placeholders})
               AND r.deleted_at IS NULL
               AND (r.user_id = ?
                    OR EXISTS (SELECT 1 FROM recipe_shares s
                                WHERE s.recipe_id = r.id AND s.grantee_id = ?))`
    ).all(...ids, ...(u == null ? [] : [u, u])).map(r => r.id)
  );

  const maxOrder = db.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) AS m FROM recipe_cookbook_links WHERE cookbook_id = ?`
  ).get(id).m;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO recipe_cookbook_links (cookbook_id, recipe_id, sort_order)
     VALUES (?, ?, ?)`
  );
  let added = 0;
  let order = maxOrder + 1;
  const tx = db.transaction(() => {
    for (const rid of ids) {
      if (!accessibleIds.has(rid)) continue;
      const r = ins.run(id, rid, order++);
      if (r.changes > 0) added++;
    }
  });
  tx();
  res.json({ ok: true, added });
}));

// ── PUT /:id/recipes/order — rewrite the recipe order inside a cookbook
// body: { recipe_ids: [123, 99, 42, ...] } in the desired display order.
// Path is 3 segments so it doesn't collide with the 1-segment PUT /:id.
router.put('/:id/recipes/order', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const cb = db.prepare(`SELECT * FROM cookbooks WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!cb) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && cb.user_id == null) || cb.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });
  const ids = Array.isArray(req.body?.recipe_ids)
    ? req.body.recipe_ids.map(n => parseInt(n, 10)).filter(Number.isFinite)
    : [];
  if (ids.length === 0) return res.status(400).json({ error: 'recipe_ids required' });
  const upd = db.prepare(`UPDATE recipe_cookbook_links SET sort_order = ? WHERE cookbook_id = ? AND recipe_id = ?`);
  const tx = db.transaction(() => { ids.forEach((rid, i) => upd.run(i, id, rid)); });
  tx();
  res.json({ ok: true });
}));

// ── DELETE /:id/recipes/:recipeId — remove a recipe link ────────────────
router.delete('/:id/recipes/:recipeId', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  const recipeId = parseInt(req.params.recipeId, 10);
  if (!Number.isFinite(id) || !Number.isFinite(recipeId)) return res.status(400).json({ error: 'Invalid id' });
  const cb = db.prepare(`SELECT * FROM cookbooks WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!cb) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && cb.user_id == null) || cb.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

  db.prepare(`DELETE FROM recipe_cookbook_links WHERE cookbook_id = ? AND recipe_id = ?`).run(id, recipeId);
  res.json({ ok: true });
}));

// ── GET /by-recipe/:recipeId — which cookbooks contain this recipe ──────
// Used by the recipe-edit / recipe-view "in cookbooks" pill row.
router.get('/by-recipe/:recipeId', wrap((req, res) => {
  const u = uid(req);
  const recipeId = parseInt(req.params.recipeId, 10);
  if (!Number.isFinite(recipeId)) return res.status(400).json({ error: 'Invalid id' });
  // Permission: the user must own (or be able to view) the recipe.
  const r = db.prepare(`SELECT user_id, visibility FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(recipeId);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && r.user_id == null) || r.user_id === u;
  if (!isOwner && r.visibility !== 'group') return res.status(403).json({ error: 'Forbidden' });

  const rows = db.prepare(
    `SELECT c.id, c.name, c.slug
       FROM recipe_cookbook_links l
       JOIN cookbooks c ON c.id = l.cookbook_id
      WHERE l.recipe_id = ? AND c.deleted_at IS NULL AND ${userClauseAliased(u, 'c')}`
  ).all(recipeId, ...userArgs(u));
  res.json(rows);
}));

// ── GET /:id/shares — list current grantees (owner-only) ──────────────
router.get('/:id/shares', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const cb = db.prepare(`SELECT user_id FROM cookbooks WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!cb) return res.status(404).json({ error: 'Not found' });
  if (cb.user_id !== u) return res.status(403).json({ error: 'Forbidden' });
  const rows = db.prepare(
    `SELECT s.grantee_id AS user_id, u.username, u.full_name,
            s.via_kitchen_id, k.name AS via_kitchen_name, s.granted_at
       FROM cookbook_shares s
       JOIN users    u ON u.id = s.grantee_id
       LEFT JOIN kitchens k ON k.id = s.via_kitchen_id
      WHERE s.cookbook_id = ?
      ORDER BY u.username COLLATE NOCASE ASC`
  ).all(id);
  res.json(rows);
}));

// ── POST /:id/shares — grant N users read access (owner-only) ────────
// body: { user_ids: [1, 2, 3] } — silently drops ids that don't exist
// or already have access. Returns { added } for a toastable summary.
router.post('/:id/shares', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const cb = db.prepare(`SELECT user_id FROM cookbooks WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!cb) return res.status(404).json({ error: 'Not found' });
  if (cb.user_id !== u) return res.status(403).json({ error: 'Forbidden' });
  const rawIds = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
  const ids = rawIds.map(n => parseInt(n, 10)).filter(Number.isFinite);
  if (ids.length === 0) return res.status(400).json({ error: 'user_ids required' });
  const ins = db.prepare(
    `INSERT OR IGNORE INTO cookbook_shares (cookbook_id, grantee_id, granted_by) VALUES (?, ?, ?)`
  );
  let added = 0;
  const tx = db.transaction(() => {
    for (const gid of ids) {
      if (gid === u) continue;
      const exists = db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(gid);
      if (!exists) continue;
      const r = ins.run(id, gid, u);
      if (r.changes > 0) added++;
    }
  });
  tx();
  res.json({ ok: true, added });
}));

// ── DELETE /:id/shares/:userId — revoke a single grantee ──────────────
router.delete('/:id/shares/:userId', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  const target = parseInt(req.params.userId, 10);
  if (!Number.isFinite(id) || !Number.isFinite(target)) return res.status(400).json({ error: 'Invalid id' });
  const cb = db.prepare(`SELECT user_id FROM cookbooks WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!cb) return res.status(404).json({ error: 'Not found' });
  if (cb.user_id !== u) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`DELETE FROM cookbook_shares WHERE cookbook_id = ? AND grantee_id = ?`).run(id, target);
  res.json({ ok: true });
}));

export default router;
