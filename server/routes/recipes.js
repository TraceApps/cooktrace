/**
 * recipes.js — Recipe CRUD endpoints.
 *
 * Schema lives in server/db.js (`recipes` table). Ingredients, steps, tags,
 * tools, and nutrition are stored as JSON-encoded TEXT columns so we can
 * iterate the data shape without migrations.
 *
 * Multi-user: every query is scoped by user_id. Single-user mode (no user
 * management) leaves user_id NULL.
 */
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { ensurePantryItems } from './pantry.js';
import { scrapeRecipe, fetchRecipeHtml, extractFromHtml } from '../lib/recipe-scraper.js';
import { aiExtractRecipe } from '../lib/recipe-ai-fallback.js';
import { scrapeWithRecipeScrapers, isRecipeScrapersAvailable } from '../lib/recipe-scrapers-bridge.js';
import { importRecipeFromText, importPaprikaArchive, scanRecipeZip, scanLoadedZip, loadRecipeZip, readImageFromLoadedZip, readZipImageBytes, mealieEventImagePaths } from '../lib/recipe-importers.js';
import { extractText, detectFileType } from '../lib/text-extractors.js';
import { parseRecipeText, HIGH_CONFIDENCE_THRESHOLD } from '../lib/heuristic-recipe-parser.js';
import JSZip from 'jszip';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { deriveSodiumSalt } from '../lib/nutrition-derive.js';
import { notifyCommentReply } from '../lib/push-notify.js';
import { sendRecipeShared, isEmailConfigured } from '../email.js';
import { logger } from '../logger.js';
import multer from 'multer';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

function _whereUser(u) {
  return u == null ? 'user_id IS NULL' : 'user_id = ?';
}
function _userArgs(u) {
  return u == null ? [] : [u];
}

// Tack the creator's current avatar onto a hydrated recipe so the
// byline can render their photo. Live lookup (cheap PK fetch) keeps
// avatars current without rewriting recipe rows. Used by GET/POST/PUT
// so every recipe response has the same shape — the client can
// overwrite `recipe` with the response without losing display fields.
function _withCreatorAvatar(hydrated, row) {
  if (!hydrated || !row) return hydrated;
  let creatorAvatar = null;
  let creatorFullName = null;
  if (row.user_id != null) {
    const u2 = db.prepare(`SELECT avatar_url, full_name FROM users WHERE id = ?`).get(row.user_id);
    creatorAvatar = u2?.avatar_url || null;
    creatorFullName = u2?.full_name || null;
  }
  return {
    ...hydrated,
    creator_avatar_url: creatorAvatar,
    // Live full_name so renames propagate to old recipes. UI prefers
    // this over the denormalized created_by_username (username column
    // is the email in most installs).
    created_by_full_name: creatorFullName,
  };
}

function _hydrate(row, categoryMap = null) {
  if (!row) return null;
  // Resolve the recipe's category. Single-recipe path passes no map and
  // we fall back to a per-row SELECT (cheap, one query). The list path
  // builds a Map up-front and passes it in to avoid N+1.
  let category = null;
  if (row.category_id != null) {
    if (categoryMap) {
      category = categoryMap.get(row.category_id) || null;
    } else {
      category = db.prepare(
        `SELECT id, name, slug, color FROM recipe_categories WHERE id = ?`
      ).get(row.category_id) || null;
    }
  }
  return {
    ...row,
    // Always return ingredients in the new grouped shape:
    //   [{ name: '', items: [{ qty, unit, name, note }, ...] }, ...]
    // Old flat-array recipes get hoisted into a single unnamed group on read.
    ingredients: _normaliseIngredientGroups(_safeJson(row.ingredients, [])),
    steps:       _safeJson(row.steps, []),
    tags:        _safeJson(row.tags, []),
    tools:       _safeJson(row.tools, []),
    nutrition:   _safeJson(row.nutrition, {}),
    favorite:    !!row.favorite,
    category,
  };
}

function _normaliseIngredientGroups(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  // Detect old flat shape: items have qty/unit/name at the top level rather
  // than an `items` array. Wrap in a single empty-name group.
  const looksFlat = raw.every(r => r && typeof r === 'object' && !Array.isArray(r.items));
  if (looksFlat) return [{ name: '', items: raw }];
  // Already grouped — make sure each entry has the expected shape.
  return raw.map(g => ({
    name:  (g && g.name) || '',
    items: Array.isArray(g && g.items) ? g.items : [],
  }));
}
function _safeJson(text, fallback) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

// Sodium ↔ salt derivation lives in server/lib/nutrition-derive.js so
// the pantry route can share the same logic. Local alias keeps the
// _toStorage call site below readable.
const _deriveSodiumSalt = deriveSodiumSalt;

// Walk the grouped-ingredients structure and stamp each item with its
// pantry_item_id (auto-creating pantry rows for any names not yet in the
// catalog). Mutates the structure in place and returns it.
function _linkIngredientsToPantry(userId, ingredients) {
  if (!Array.isArray(ingredients)) return ingredients;
  // Only auto-create / auto-link rows that aren't already manually
  // linked. Skipping items with an explicit pantry_item_id preserves
  // the "salt" → "Iodized Salt" decoupling: the user keeps the recipe
  // display name they typed AND the link to the brand/nutrition row
  // they picked, without the auto-linker resolving "salt" against a
  // (non-existent) "Salt" pantry row and overwriting their pick with
  // a new orphan duplicate.
  const allNames = [];
  for (const g of ingredients) {
    for (const it of (g.items || [])) {
      if (it && it.name && it.pantry_item_id == null) allNames.push(it.name);
    }
  }
  const map = ensurePantryItems(userId, allNames);
  for (const g of ingredients) {
    for (const it of (g.items || [])) {
      if (!it || !it.name) continue;
      if (it.pantry_item_id != null) continue; // respect manual link
      const row = map.get(it.name.toLowerCase());
      if (row) it.pantry_item_id = row.id;
    }
  }
  return ingredients;
}

function _toStorage(body) {
  // Rating is 0..5 (or null when unrated). Anything else gets clamped or nulled.
  let rating = null;
  if (body.rating != null && body.rating !== '') {
    const n = parseInt(body.rating, 10);
    if (Number.isFinite(n)) rating = Math.max(0, Math.min(5, n));
  }
  return {
    name:         (body.name || '').toString().trim(),
    description:  body.description ?? null,
    img_url:      body.img_url ?? body.imgUrl ?? null,
    servings:     body.servings != null ? Math.max(1, parseInt(body.servings, 10) || 1) : null,
    yield_text:   body.yield_text ? String(body.yield_text).trim() || null : null,
    prep_minutes:  body.prep_minutes  != null ? Math.max(0, parseInt(body.prep_minutes,  10) || 0) : null,
    cook_minutes:  body.cook_minutes  != null ? Math.max(0, parseInt(body.cook_minutes,  10) || 0) : null,
    // Rest / rise / marinate / chill — the generic hands-off slot.
    // Rolls into auto-calc for total_minutes when the manual
    // override is null.
    rest_minutes:  body.rest_minutes  != null && body.rest_minutes  !== ''
      ? Math.max(0, parseInt(body.rest_minutes,  10) || 0)
      : null,
    // Optional manual override. NULL means "auto = prep + cook +
    // rest"; a value here wins downstream.
    total_minutes: body.total_minutes != null && body.total_minutes !== ''
      ? Math.max(0, parseInt(body.total_minutes, 10) || 0)
      : null,
    rating,
    ingredients:  JSON.stringify(Array.isArray(body.ingredients) ? body.ingredients : []),
    steps:        JSON.stringify(Array.isArray(body.steps) ? body.steps : []),
    tags:         JSON.stringify(Array.isArray(body.tags)  ? body.tags  : []),
    tools:        JSON.stringify(Array.isArray(body.tools) ? body.tools : []),
    nutrition:    JSON.stringify(_deriveSodiumSalt(
      body.nutrition && typeof body.nutrition === 'object' ? { ...body.nutrition } : {}
    )),
    source_url:   body.source_url ?? null,
    notes:        body.notes ?? null,
    visibility:   body.visibility === 'group' ? 'group' : 'private',
    favorite:     body.favorite ? 1 : 0,
    category_id:  body.category_id != null && Number.isFinite(parseInt(body.category_id, 10))
                    ? parseInt(body.category_id, 10) : null,
    video_url:    body.video_url ? String(body.video_url).trim() || null : null,
  };
}

// ── GET / — list recipes (with pantry-match counts on each) ────────────
router.get('/', wrap((req, res) => {
  const u = uid(req);
  const ownRows = db.prepare(
    `SELECT * FROM recipes WHERE ${_whereUser(u)} AND deleted_at IS NULL ORDER BY updated_at DESC`
  ).all(..._userArgs(u));

  // Build a Set of "effectively in-stock" pantry_item_ids once for the
  // whole list, so the pantry-match summary on each card is
  // O(ingredients) per recipe.
  //
  // Variant-aware (Issue #4): a row counts as in-stock when its own
  // in_stock = 1, OR when it is a generic with at least one in-stock
  // child variant. Recipes whose ingredient links to either the parent
  // or a specific child get a correct match either way.
  const allStock = db.prepare(
    `SELECT id, generic_parent_id, in_stock FROM pantry_items
       WHERE ${_whereUser(u)} AND deleted_at IS NULL`
  ).all(..._userArgs(u));
  const stockSet = new Set();
  const stockedByParent = new Set();
  for (const r of allStock) {
    if (r.in_stock) {
      stockSet.add(r.id);
      if (r.generic_parent_id != null) stockedByParent.add(r.generic_parent_id);
    }
  }
  // Promote every generic whose any child is in stock.
  for (const r of allStock) {
    if (stockedByParent.has(r.id)) stockSet.add(r.id);
  }

  // Bulk-prefetch categories for the user once, then index by id. Avoids
  // an N+1 SELECT inside _hydrate.
  const catMap = new Map();
  for (const c of db.prepare(
    `SELECT id, name, slug, color FROM recipe_categories WHERE ${_whereUser(u)}`
  ).all(..._userArgs(u))) {
    catMap.set(c.id, c);
  }

  const out = ownRows.map(r => _hydrate(r, catMap)).map(r => ({ ...r, pantry_match: _matchSummary(r.ingredients, stockSet) }));
  res.json(out);
}));

// Count "X of Y ingredients you have in stock" given the recipe's grouped
// ingredient JSON + a Set of in-stock pantry_item_ids.
function _matchSummary(grouped, stockSet) {
  if (!Array.isArray(grouped)) return { have: 0, need: 0 };
  let have = 0, need = 0;
  for (const g of grouped) {
    for (const it of (g.items || [])) {
      need++;
      if (it.pantry_item_id && stockSet.has(it.pantry_item_id)) have++;
    }
  }
  return { have, need };
}

// ── Categories ──────────────────────────────────────────────────────────
// Per-user catalog. Declared BEFORE /:id handlers so the static prefix
// "/categories" doesn't get matched as :id.
function _slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'category';
}

router.get('/categories', wrap((req, res) => {
  const u = uid(req);
  // Pull every category plus the count of non-deleted recipes that
  // reference it. The count powers the "Italian · 8 recipes" usage
  // pill in the Manage hub so users can see at a glance which
  // taxonomies are stale.
  const rows = db.prepare(
    `SELECT c.id, c.name, c.slug, c.color, c.sort_order,
            (SELECT COUNT(*) FROM recipes r
              WHERE r.category_id = c.id AND r.deleted_at IS NULL
                AND ${_whereUser(u).replace(/user_id/g, 'r.user_id')}) AS recipe_count
       FROM recipe_categories c
      WHERE ${_whereUser(u).replace(/user_id/g, 'c.user_id')}
      ORDER BY c.sort_order ASC, c.name ASC`
  ).all(..._userArgs(u), ..._userArgs(u));
  res.json(rows);
}));

router.post('/categories', wrap((req, res) => {
  const u = uid(req);
  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const color = req.body?.color ? String(req.body.color).slice(0, 16) : null;
  let slug = _slugify(name);
  let n = 2;
  while (db.prepare(
    `SELECT 1 FROM recipe_categories WHERE ${_whereUser(u)} AND slug = ?`
  ).get(...[..._userArgs(u), slug])) {
    slug = `${_slugify(name)}-${n++}`;
  }
  const maxOrder = db.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) AS m FROM recipe_categories WHERE ${_whereUser(u)}`
  ).get(..._userArgs(u)).m;
  const result = db.prepare(
    `INSERT INTO recipe_categories (user_id, name, slug, color, sort_order) VALUES (?, ?, ?, ?, ?)`
  ).run(u, name, slug, color, maxOrder + 1);
  const row = db.prepare(`SELECT id, name, slug, color, sort_order FROM recipe_categories WHERE id = ?`).get(result.lastInsertRowid);
  res.status(201).json(row);
}));

router.put('/categories/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(
    `SELECT * FROM recipe_categories WHERE id = ? AND ${_whereUser(u)}`
  ).get(id, ..._userArgs(u));
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const name  = req.body?.name != null ? String(req.body.name).trim() || existing.name : existing.name;
  const color = req.body?.color !== undefined
    ? (req.body.color ? String(req.body.color).slice(0, 16) : null)
    : existing.color;
  const sort  = req.body?.sort_order != null && Number.isFinite(parseInt(req.body.sort_order, 10))
    ? parseInt(req.body.sort_order, 10)
    : existing.sort_order;

  db.prepare(
    `UPDATE recipe_categories
        SET name = ?, color = ?, sort_order = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(name, color, sort, id);
  const row = db.prepare(`SELECT id, name, slug, color, sort_order FROM recipe_categories WHERE id = ?`).get(id);
  res.json(row);
}));

// ── PUT /categories/order — bulk reorder ──────────────────────────────
// Body: { ids: [42, 17, 9, ...] } — applies sort_order = index to each
// id in the given sequence. Used by the drag-and-drop reorder in the
// Manage hub; mirrors the same pattern as cookbooks order.
router.put('/categories/order', wrap((req, res) => {
  const u = uid(req);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : null;
  if (!ids) return res.status(400).json({ error: 'ids array required' });
  const upd = db.prepare(
    `UPDATE recipe_categories
        SET sort_order = ?, updated_at = datetime('now')
      WHERE id = ? AND ${_whereUser(u)}`
  );
  const tx = db.transaction(() => {
    ids.forEach((id, idx) => upd.run(idx, id, ..._userArgs(u)));
  });
  tx();
  res.json({ ok: true });
}));

router.delete('/categories/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(
    `SELECT id FROM recipe_categories WHERE id = ? AND ${_whereUser(u)}`
  ).get(id, ..._userArgs(u));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  // ON DELETE SET NULL on recipes.category_id — recipes survive.
  db.prepare(`DELETE FROM recipe_categories WHERE id = ?`).run(id);
  res.json({ ok: true });
}));

// ── Tags + Tools (Kitchen Gear) taxonomy ────────────────────────────────
// Tags + tools are stored as JSON arrays on each recipe row, so the
// "catalog" is computed by scanning all of the user's recipes. Rename
// and delete cascade the same way: rewrite every matching row.
//
// Names are lowercase-compared but case-preserved on display. URL
// segments are decoded by Express via decodeURIComponent.

function _enumerateField(u, field) {
  const rows = db.prepare(
    `SELECT ${field} AS data FROM recipes
      WHERE ${_whereUser(u)} AND deleted_at IS NULL`
  ).all(..._userArgs(u));
  const counts = new Map(); // lower → { name, count }
  for (const r of rows) {
    if (!r.data) continue;
    let arr;
    try { arr = JSON.parse(r.data); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const v of arr) {
      const name = typeof v === 'string' ? v.trim() : '';
      if (!name) continue;
      const key = name.toLowerCase();
      const cur = counts.get(key);
      if (cur) cur.count += 1;
      else counts.set(key, { name, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function _renameField(u, field, oldName, newName) {
  const oldLower = String(oldName).toLowerCase().trim();
  const next = String(newName).trim();
  if (!oldLower || !next) throw Object.assign(new Error('name required'), { status: 400 });
  // Pull every recipe that has the old name and rewrite the array.
  const rows = db.prepare(
    `SELECT id, ${field} AS data FROM recipes
      WHERE ${_whereUser(u)} AND deleted_at IS NULL`
  ).all(..._userArgs(u));
  let modified = 0;
  const upd = db.prepare(`UPDATE recipes SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r.data) continue;
      let arr;
      try { arr = JSON.parse(r.data); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      let touched = false;
      const out = [];
      for (const v of arr) {
        const name = typeof v === 'string' ? v.trim() : '';
        if (!name) continue;
        if (name.toLowerCase() === oldLower) {
          // Dedupe: if `next` is already in this recipe's array, drop
          // the old occurrence instead of creating a duplicate chip.
          if (out.some(x => x.toLowerCase() === next.toLowerCase())) {
            touched = true;
            continue;
          }
          out.push(next);
          touched = true;
        } else {
          out.push(name);
        }
      }
      if (touched) {
        upd.run(JSON.stringify(out), r.id);
        modified += 1;
      }
    }
  });
  tx();
  return modified;
}

function _deleteField(u, field, name) {
  const lower = String(name).toLowerCase().trim();
  if (!lower) throw Object.assign(new Error('name required'), { status: 400 });
  const rows = db.prepare(
    `SELECT id, ${field} AS data FROM recipes
      WHERE ${_whereUser(u)} AND deleted_at IS NULL`
  ).all(..._userArgs(u));
  let modified = 0;
  const upd = db.prepare(`UPDATE recipes SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r.data) continue;
      let arr;
      try { arr = JSON.parse(r.data); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      const out = arr
        .map(v => typeof v === 'string' ? v.trim() : '')
        .filter(v => v && v.toLowerCase() !== lower);
      if (out.length !== arr.filter(v => typeof v === 'string' && v.trim()).length) {
        upd.run(JSON.stringify(out), r.id);
        modified += 1;
      }
    }
  });
  tx();
  return modified;
}

router.get('/tags',  wrap((req, res) => res.json(_enumerateField(uid(req), 'tags'))));
router.get('/tools', wrap((req, res) => res.json(_enumerateField(uid(req), 'tools'))));

router.put('/tags/:name', wrap((req, res) => {
  try {
    const modified = _renameField(uid(req), 'tags', req.params.name, req.body?.name || '');
    res.json({ modified });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}));
router.put('/tools/:name', wrap((req, res) => {
  try {
    const modified = _renameField(uid(req), 'tools', req.params.name, req.body?.name || '');
    res.json({ modified });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}));

router.delete('/tags/:name', wrap((req, res) => {
  try {
    const modified = _deleteField(uid(req), 'tags', req.params.name);
    res.json({ modified });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}));
router.delete('/tools/:name', wrap((req, res) => {
  try {
    const modified = _deleteField(uid(req), 'tools', req.params.name);
    res.json({ modified });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}));

// ── GET /peers — users on this instance the current user can share with.
// Static path: declared BEFORE /:id so Express doesn't try to parse
// "peers" as a recipe id. Returns id + display name; excludes the
// requester. Returns [] in single-user mode.
router.get('/peers', wrap((req, res) => {
  const u = uid(req);
  if (u == null) return res.json([]);
  const peers = db.prepare(
    `SELECT id, full_name, username FROM users
      WHERE id != ?
      ORDER BY COALESCE(full_name, username) COLLATE NOCASE ASC`
  ).all(u);
  res.json(peers.map(p => ({ id: p.id, name: p.full_name || p.username, username: p.username })));
}));

// ── GET /shared-with-me — recipes others have explicitly shared ──────
// Same static-before-:id ordering as /peers.
router.get('/shared-with-me', wrap((req, res) => {
  const u = uid(req);
  if (u == null) return res.json([]);
  const catMap = new Map();
  for (const c of db.prepare(
    `SELECT id, name, slug, color FROM recipe_categories`
  ).all()) {
    catMap.set(c.id, c);
  }
  const rows = db.prepare(
    `SELECT r.*, u.username AS shared_by_username
       FROM recipe_shares s
       JOIN recipes r ON r.id = s.recipe_id
       LEFT JOIN users u ON u.id = s.granted_by
      WHERE s.grantee_id = ? AND r.deleted_at IS NULL
      ORDER BY s.granted_at DESC`
  ).all(u);
  res.json(rows.map(r => ({
    ..._hydrate(r, catMap),
    shared_with_me: true,
    shared_by: r.shared_by_username || r.created_by_username || null,
  })));
}));

// ── GET /:id — single recipe ────────────────────────────────────────────
router.get('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const row = db.prepare(
    `SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`
  ).get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && row.user_id == null) || row.user_id === u;
  // Explicit per-user share — recipe_shares grants read access.
  let isShared = false;
  if (!isOwner && u != null) {
    const r = db.prepare(`SELECT 1 FROM recipe_shares WHERE recipe_id = ? AND grantee_id = ?`).get(id, u);
    isShared = !!r;
  }
  if (!isOwner && !isShared && row.visibility !== 'group') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(_withCreatorAvatar(_hydrate(row), row));
}));

// ── POST / — create ─────────────────────────────────────────────────────
router.post('/', wrap((req, res) => {
  const u = uid(req);
  // Resolve / auto-create pantry items BEFORE serializing to JSON,
  // but only when the user opts in via the autoCreatePantryFromRecipes
  // setting. Default off — typing "flour" in a recipe editor doesn't
  // silently grow the pantry catalog. Manual links from the Link
  // picker still flow through pantry_item_id directly regardless.
  const body = { ...(req.body || {}) };
  if (_userSetting(u, 'autoCreatePantryFromRecipes') === 'true') {
    body.ingredients = _linkIngredientsToPantry(u, body.ingredients);
  }
  const data = _toStorage(body);
  if (!data.name) return res.status(400).json({ error: 'Name is required' });

  // Capture creator's username on insert (denormalized for display speed).
  const creatorUsername = req.user?.username || null;

  const result = db.prepare(
    `INSERT INTO recipes
       (user_id, name, description, img_url, servings, yield_text,
        prep_minutes, cook_minutes, total_minutes, rest_minutes, rating, favorite,
        ingredients, steps, tags, tools, nutrition,
        source_url, notes, visibility, created_by_username, category_id, video_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    u, data.name, data.description, data.img_url, data.servings, data.yield_text,
    data.prep_minutes, data.cook_minutes, data.total_minutes, data.rest_minutes, data.rating, data.favorite,
    data.ingredients, data.steps, data.tags, data.tools, data.nutrition,
    data.source_url, data.notes, data.visibility, creatorUsername, data.category_id, data.video_url,
  );
  const row = db.prepare(`SELECT * FROM recipes WHERE id = ?`).get(result.lastInsertRowid);
  res.status(201).json(_withCreatorAvatar(_hydrate(row), row));
}));

// ── PUT /:id — update ───────────────────────────────────────────────────
router.put('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const existing = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && existing.user_id == null) || existing.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

  const body = { ...(req.body || {}) };
  if (_userSetting(u, 'autoCreatePantryFromRecipes') === 'true') {
    body.ingredients = _linkIngredientsToPantry(u, body.ingredients);
  }
  const data = _toStorage(body);
  if (!data.name) return res.status(400).json({ error: 'Name is required' });

  db.prepare(
    `UPDATE recipes SET
       name = ?, description = ?, img_url = ?, servings = ?, yield_text = ?,
       prep_minutes = ?, cook_minutes = ?, total_minutes = ?, rest_minutes = ?, rating = ?, favorite = ?,
       ingredients = ?, steps = ?, tags = ?, tools = ?, nutrition = ?,
       source_url = ?, notes = ?, visibility = ?, category_id = ?, video_url = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    data.name, data.description, data.img_url, data.servings, data.yield_text,
    data.prep_minutes, data.cook_minutes, data.total_minutes, data.rest_minutes, data.rating, data.favorite,
    data.ingredients, data.steps, data.tags, data.tools, data.nutrition,
    data.source_url, data.notes, data.visibility, data.category_id, data.video_url,
    id,
  );
  const row = db.prepare(`SELECT * FROM recipes WHERE id = ?`).get(id);
  res.json(_withCreatorAvatar(_hydrate(row), row));
}));

// ── POST /:id/backdate — set recipe's created_at to an earlier date ───
// Used by the Mealie timeline importer to pull a recipe's creation
// timestamp back to the original Mealie "Recipe Created" event. Only
// applies if the requested date is OLDER than the current created_at —
// we never push the date forward and never touch it if no change.
// Body: { created_at: '2023-04-15T12:34:56Z' } (ISO 8601).
router.post('/:id/backdate', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const raw = req.body?.created_at;
  if (typeof raw !== 'string' || raw.length < 10) return res.status(400).json({ error: 'created_at required' });
  const ts = new Date(raw);
  if (Number.isNaN(ts.getTime())) return res.status(400).json({ error: 'Invalid created_at' });

  const existing = db.prepare(`SELECT id, created_at FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare(`SELECT user_id, visibility FROM recipes WHERE id = ?`).get(id);
  const isOwner = (u == null && row.user_id == null) || row.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

  const newIso = ts.toISOString().replace('T', ' ').slice(0, 19); // SQLite-naive UTC
  const cur = existing.created_at || '';
  // Compare lexically — both are 'YYYY-MM-DD HH:MM:SS' UTC strings.
  if (cur && cur <= newIso) {
    return res.json({ updated: false, reason: 'current date is already earlier or equal' });
  }
  db.prepare(`UPDATE recipes SET created_at = ?, updated_at = datetime('now') WHERE id = ?`).run(newIso, id);
  res.json({ updated: true, created_at: newIso });
}));

// ── POST /:id/cooked — log a cook event ────────────────────────────────
// Creates a cook_diary row (with optional date/notes/photo_url from the
// dialog) and recomputes the recipe's last_cooked_at + cook_count from
// the cook_diary aggregates so deletes update them too.
router.post('/:id/cooked', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const existing = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && existing.user_id == null) || existing.user_id === u;
  if (!isOwner && existing.visibility !== 'group') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Date defaults to today (UTC date). Accept ISO date "YYYY-MM-DD" from
  // the client, or fall back to today if anything else.
  const today = new Date().toISOString().slice(0, 10);
  const date = (typeof req.body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date))
    ? req.body.date
    : today;
  const notes = req.body?.notes ? String(req.body.notes).trim() || null : null;
  // Accept legacy `photo_url` (single string) AND new `photos` (array
  // of strings). Normalise: photos JSON column gets the array;
  // photo_url mirror keeps photos[0] for backwards compatibility.
  let photos = Array.isArray(req.body?.photos)
    ? req.body.photos.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim())
    : [];
  if (photos.length === 0) {
    const single = req.body?.photo_url ?? req.body?.photoUrl ?? null;
    if (single) photos = [String(single)];
  }
  const photoUrl = photos[0] || null;
  const photosJson = photos.length ? JSON.stringify(photos) : null;
  // Diary v2 — optional meal-type slot + per-cook rating. Whitelist
  // meal_type, clamp rating to 0..5. Either stores as NULL when blank.
  const _MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snack']);
  const mealType = (() => {
    if (req.body?.meal_type == null || req.body?.meal_type === '') return null;
    const norm = String(req.body.meal_type).toLowerCase().trim();
    return _MEAL_TYPES.has(norm) ? norm : null;
  })();
  const rating = (() => {
    if (req.body?.rating == null || req.body?.rating === '') return null;
    const n = parseInt(req.body.rating, 10);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(5, n)) || null;
  })();

  db.prepare(
    `INSERT INTO cook_diary (user_id, recipe_id, date, kind, notes, photo_url, photos, meal_type, rating)
     VALUES (?, ?, ?, 'cooked', ?, ?, ?, ?, ?)`
  ).run(u, id, date, notes, photoUrl, photosJson, mealType, rating);

  _recomputeCookAggregates(id);
  const row = db.prepare(`SELECT * FROM recipes WHERE id = ?`).get(id);
  res.json(_withCreatorAvatar(_hydrate(row), row));
}));

// ── GET /:id/cooks — list cook entries for a recipe ────────────────────
router.get('/:id/cooks', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!recipe) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && recipe.user_id == null) || recipe.user_id === u;
  if (!isOwner && recipe.visibility !== 'group') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const rows = db.prepare(
    `SELECT cd.id, cd.date, cd.notes, cd.photo_url, cd.photos, cd.created_at,
            cd.user_id AS cooked_by_user_id,
            u.username AS cooked_by_username, u.full_name AS cooked_by_full_name
     FROM cook_diary cd
     LEFT JOIN users u ON u.id = cd.user_id
     WHERE cd.recipe_id = ? AND cd.deleted_at IS NULL
     ORDER BY cd.date DESC, cd.created_at DESC`
  ).all(id);
  // Hydrate `photos` JSON column to an array. Fall back to [photo_url]
  // for legacy rows that only have the single field.
  for (const r of rows) {
    let arr = [];
    if (r.photos) { try { arr = JSON.parse(r.photos) || []; } catch { arr = []; } }
    if (arr.length === 0 && r.photo_url) arr = [r.photo_url];
    r.photos = arr;
  }
  res.json(rows);
}));

// ── PUT /:id/cooks/:cookId — edit a cook entry ─────────────────────────
router.put('/:id/cooks/:cookId', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  const cookId = parseInt(req.params.cookId, 10);
  if (!Number.isFinite(id) || !Number.isFinite(cookId)) return res.status(400).json({ error: 'Invalid id' });

  const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  const isOwner = (u == null && recipe.user_id == null) || recipe.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

  const existing = db.prepare(`SELECT * FROM cook_diary WHERE id = ? AND recipe_id = ? AND deleted_at IS NULL`).get(cookId, id);
  if (!existing) return res.status(404).json({ error: 'Cook entry not found' });

  const date = (typeof req.body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date))
    ? req.body.date : existing.date;
  const notes = req.body?.notes !== undefined
    ? (req.body.notes ? String(req.body.notes).trim() || null : null)
    : existing.notes;

  // Resolve next photos array: prefer `photos` (array), fall back to
  // legacy `photo_url` (single), else keep existing.
  let nextPhotos;
  if (Array.isArray(req.body?.photos)) {
    nextPhotos = req.body.photos.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim());
  } else if (req.body?.photo_url !== undefined) {
    nextPhotos = req.body.photo_url ? [String(req.body.photo_url)] : [];
  } else {
    let existingPhotos = [];
    if (existing.photos) { try { existingPhotos = JSON.parse(existing.photos) || []; } catch {} }
    if (existingPhotos.length === 0 && existing.photo_url) existingPhotos = [existing.photo_url];
    nextPhotos = existingPhotos;
  }
  const photoUrl = nextPhotos[0] || null;
  const photosJson = nextPhotos.length ? JSON.stringify(nextPhotos) : null;

  db.prepare(
    `UPDATE cook_diary
       SET date = ?, notes = ?, photo_url = ?, photos = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(date, notes, photoUrl, photosJson, cookId);

  _recomputeCookAggregates(id);
  res.json({ ok: true });
}));
// ── GET /:id/shares — list user grants on this recipe ────────────────
router.get('/:id/shares', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!recipe) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && recipe.user_id == null) || recipe.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

  const rows = db.prepare(
    `SELECT s.grantee_id AS user_id, u.username, s.granted_at
       FROM recipe_shares s
       JOIN users u ON u.id = s.grantee_id
      WHERE s.recipe_id = ?
      ORDER BY s.granted_at DESC`
  ).all(id);
  res.json(rows);
}));

// ── POST /:id/shares — grant share access to one or more users ────────
// body: { user_ids: [1,2,3] }
router.post('/:id/shares', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!recipe) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && recipe.user_id == null) || recipe.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

  const ids = Array.isArray(req.body?.user_ids)
    ? req.body.user_ids.map(n => parseInt(n, 10)).filter(Number.isFinite)
    : [];
  if (ids.length === 0) return res.status(400).json({ error: 'user_ids required' });
  // Filter out the owner themselves and any non-existent users.
  const ownerId = recipe.user_id;
  const valid = db.prepare(
    `SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids).map(r => r.id).filter(uid2 => uid2 !== ownerId);

  const ins = db.prepare(
    `INSERT OR IGNORE INTO recipe_shares (recipe_id, grantee_id, granted_by)
     VALUES (?, ?, ?)`
  );
  let added = 0;
  const newGrantees = [];
  const tx = db.transaction(() => {
    for (const gid of valid) {
      const r = ins.run(id, gid, u);
      if (r.changes > 0) { added++; newGrantees.push(gid); }
    }
  });
  tx();

  // Best-effort email each new grantee. Skipped if SMTP isn't
  // configured or any individual send throws.
  if (newGrantees.length > 0 && isEmailConfigured()) {
    const sharerName = req.user?.full_name || req.user?.username || null;
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host  = req.headers['x-forwarded-host']  || req.headers.host || '';
    const baseUrl = `${proto}://${host}`;
    const viewUrl = `${baseUrl}/#/recipes/${id}`;
    const granteeEmails = db.prepare(
      `SELECT id, email FROM users WHERE id IN (${newGrantees.map(() => '?').join(',')})`
    ).all(...newGrantees);
    for (const row of granteeEmails) {
      if (!row.email) continue;
      sendRecipeShared(row.email, viewUrl, recipe.name, sharerName)
        .catch(e => logger.debug?.(`[share] email to ${row.email} failed: ${e.message}`));
    }
  }

  res.json({ ok: true, added });
}));

// ── DELETE /:id/shares/:userId — revoke a single share ────────────────
router.delete('/:id/shares/:userId', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(id) || !Number.isFinite(userId)) return res.status(400).json({ error: 'Invalid id' });
  const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!recipe) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && recipe.user_id == null) || recipe.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

  db.prepare(`DELETE FROM recipe_shares WHERE recipe_id = ? AND grantee_id = ?`).run(id, userId);
  res.json({ ok: true });
}));

// ── POST /:id/share — mint (or rotate) a public share token ───────────
// Owner only. Returns { share_token }. The public read path lives at
// /api/r/:token (server/routes/share.js) and bypasses auth.
router.post('/:id/share', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!recipe) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && recipe.user_id == null) || recipe.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

  // 22 url-safe chars: 16 random bytes -> base64url. Cryptographically
  // unguessable, short enough for a shareable URL.
  const token = _randomToken(16);
  db.prepare(`UPDATE recipes SET share_token = ?, updated_at = datetime('now') WHERE id = ?`).run(token, id);
  res.json({ share_token: token });
}));

// ── DELETE /:id/share — revoke the public share token ──────────────────
router.delete('/:id/share', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!recipe) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && recipe.user_id == null) || recipe.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`UPDATE recipes SET share_token = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
  res.json({ ok: true });
}));

function _randomToken(byteLen) {
  // Base64url encoding via Buffer (Node 18+).
  const buf = Buffer.alloc(byteLen);
  for (let i = 0; i < byteLen; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── DELETE /:id/cooks/:cookId — soft-delete a cook entry ───────────────
router.delete('/:id/cooks/:cookId', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  const cookId = parseInt(req.params.cookId, 10);
  if (!Number.isFinite(id) || !Number.isFinite(cookId)) return res.status(400).json({ error: 'Invalid id' });

  const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
  const isOwner = (u == null && recipe.user_id == null) || recipe.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

  db.prepare(
    `UPDATE cook_diary SET deleted_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND recipe_id = ?`
  ).run(cookId, id);

  _recomputeCookAggregates(id);
  res.json({ ok: true });
}));

// Recomputes recipe.cook_count and recipe.last_cooked_at from the
// cook_diary table — keeps them honest after inserts AND deletes.
function _recomputeCookAggregates(recipeId) {
  // The cook_diary.date column is YYYY-MM-DD. We don't display a time
  // for "Last Cooked" anywhere, so just take MAX(date) and stash it as
  // a date-only string. The earlier composite (date || ' ' ||
  // COALESCE(created_at, '00:00:00')) was malformed because created_at
  // was already a full timestamp, producing strings like
  // "2026-05-04 2026-05-04 18:30:45" that no Date parser could handle.
  const stats = db.prepare(
    `SELECT COUNT(*) AS n, MAX(date) AS last
       FROM cook_diary
      WHERE recipe_id = ? AND deleted_at IS NULL AND kind = 'cooked'`
  ).get(recipeId);

  db.prepare(
    `UPDATE recipes
       SET cook_count = ?, last_cooked_at = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(stats.n || 0, stats.last || null, recipeId);
}

// ── POST /scrape — fetch a URL and turn it into a saved recipe ─────────
// Parses schema.org/Recipe JSON-LD from the page, normalises into our
// shape, then runs through the regular create flow so pantry-linking +
// sodium↔salt derivation apply automatically.
// Scrape one URL through the tiered chain (Standard JSON-LD, Enhanced
// recipe-scrapers, Smart AI fallback) without saving. Returns
// { parsed, usedTier, errors }. Shared by /scrape (single-URL save flow)
// and /batch-scrape (multi-URL preview-and-pick flow).
async function _scrapeUrlOnly(url, opts = {}) {
  const errors = [];
  let html, finalUrl;
  try { ({ html, finalUrl } = await fetchRecipeHtml(url)); }
  catch (e) { return { parsed: null, usedTier: null, errors: [e.message] }; }

  const engine   = opts.engine   || 'standard';
  const fallback = opts.fallback || 'standard';
  const aiCfg    = opts.aiCfg    || null;
  let parsed = null;
  let usedTier = null;

  const tryStandard = () => {
    try {
      const r = extractFromHtml(html, finalUrl);
      if (r) { parsed = r; usedTier = 'standard'; }
    } catch (e) { errors.push(`standard: ${e.message}`); }
  };
  const tryEnhanced = async () => {
    try {
      if (!await isRecipeScrapersAvailable()) {
        errors.push('enhanced: recipe-scrapers not available on this server');
        return;
      }
      const r = await scrapeWithRecipeScrapers(html, finalUrl);
      if (r?.name) { parsed = r; usedTier = 'enhanced'; }
    } catch (e) { errors.push(`enhanced: ${e.message}`); }
  };
  const trySmart = async () => {
    try {
      if (!aiCfg) { errors.push('smart: AI not configured'); return; }
      const r = await aiExtractRecipe(html, finalUrl, aiCfg);
      if (r?.name) { parsed = r; usedTier = 'smart'; }
    } catch (e) { errors.push(`smart: ${e.message}`); }
  };

  if (engine === 'enhanced') {
    await tryEnhanced();
    if (!parsed) {
      if (fallback === 'smart') await trySmart();
      if (!parsed) tryStandard();
    }
  } else if (engine === 'smart') {
    await trySmart();
    if (!parsed) tryStandard();
  } else {
    tryStandard();
    if (!parsed && aiCfg) await trySmart();
  }
  return { parsed, usedTier, errors };
}

router.post('/scrape', wrap(async (req, res) => {
  const u = uid(req);
  const url = (req.body?.url || '').toString().trim();
  if (!url) return res.status(400).json({ error: 'url required' });
  // Defaults preserve the legacy auto-add behaviour for pantry, but tags
  // default off (they tend to be noisy on imported content).
  const addToPantry      = req.body?.addToPantry !== false;
  const applyTags        = req.body?.applyTags === true;
  // Categories from the source page default ON (matches what other
  // recipe apps do); explicit false opts out.
  const importCategories = req.body?.importCategories !== false;
  // Dedup: 'skip' (default) | 'replace' | 'force'. Existing recipes
  // matched by case-insensitive name or source_url are left in place
  // by default to prevent silent duplicates on re-imports.
  const dedup            = typeof req.body?.dedup === 'string' ? req.body.dedup : 'skip';

  // Tiered parser chain. Resolve the user's chosen engine + fallback
  // from user_settings. Engine values: 'standard' (JSON-LD only),
  // 'enhanced' (recipe-scrapers Python tier), 'smart' (AI fallback).
  // Fallback applies only when 'enhanced' is selected and the Python
  // tier is unavailable for this request (e.g. local-Android client).
  const engine   = _userSetting(u, 'urlImportEngine')   || 'standard';
  const fallback = _userSetting(u, 'urlImportFallback') || 'standard';
  const aiCfg    = _aiConfigForUser(u);

  let html, finalUrl;
  try { ({ html, finalUrl } = await fetchRecipeHtml(url)); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  let parsed = null;
  let usedTier = null;
  const errors = [];

  // Try preferred engine, then fall through tiers in cost order until
  // one returns a usable recipe.
  const tryStandard = () => {
    try {
      const r = extractFromHtml(html, finalUrl);
      if (r) { parsed = r; usedTier = 'standard'; }
    } catch (e) { errors.push(`standard: ${e.message}`); }
  };
  const tryEnhanced = async () => {
    try {
      if (!await isRecipeScrapersAvailable()) {
        errors.push('enhanced: recipe-scrapers not available on this server');
        return;
      }
      const r = await scrapeWithRecipeScrapers(html, finalUrl);
      if (r?.name) { parsed = r; usedTier = 'enhanced'; }
    } catch (e) { errors.push(`enhanced: ${e.message}`); }
  };
  const trySmart = async () => {
    try {
      if (!aiCfg) {
        errors.push('smart: AI not configured');
        return;
      }
      const r = await aiExtractRecipe(html, finalUrl, aiCfg);
      if (r?.name) { parsed = r; usedTier = 'smart'; }
    } catch (e) { errors.push(`smart: ${e.message}`); }
  };

  // Run in this order:
  //  - enhanced first if user picked it
  //  - smart first if user picked it
  //  - standard always available, runs as the cheapest fallback
  if (engine === 'enhanced') {
    await tryEnhanced();
    if (!parsed) {
      // Engine failed — apply user's preferred fallback.
      if (fallback === 'smart') await trySmart();
      if (!parsed) tryStandard();
    }
  } else if (engine === 'smart') {
    await trySmart();
    if (!parsed) tryStandard();
  } else {
    // 'standard' (or any unrecognised value) — JSON-LD first, AI as
    // last-ditch if user has it configured (zero-cost when not).
    tryStandard();
    if (!parsed && aiCfg) await trySmart();
  }

  if (!parsed) {
    return res.status(400).json({
      error: 'No recipe could be extracted from that URL',
      details: errors,
    });
  }

  const row = _saveImportedRecipe(u, parsed, { addToPantry, applyTags, importCategories, dedup, creatorUsername: req.user?.username || null });
  if (!row) {
    return res.status(200).json({ skipped: true, reason: 'duplicate', _import_tier: usedTier });
  }
  res.status(201).json({ ...row, _import_tier: usedTier });
}));

// ── POST /batch-scrape ─────────────────────────────────────────────────
// Multi-URL preview-and-pick flow. Accepts `{ urls: [string, ...] }`,
// scrapes each through the tiered chain (concurrency capped at 3 to
// avoid hammering target sites), and writes per-URL parsed previews
// into the same .import-cache/bulk-<uuid>/ pattern Phase 2 uses. The
// existing /bulk-commit endpoint then saves the user-selected rows.
//
// Concurrency cap (3) is per-batch only; over a 50-URL paste this
// completes in under a minute on most sites, while keeping any single
// host happy.
router.post('/batch-scrape', wrap(async (req, res) => {
  const u = uid(req);
  const raw = req.body?.urls;
  let urls = [];
  if (Array.isArray(raw)) {
    urls = raw.map(s => String(s || '').trim()).filter(Boolean);
  } else if (typeof raw === 'string') {
    // Allow a single string of newline / space / comma separated URLs.
    urls = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  }
  // De-duplicate while preserving order.
  const seen = new Set();
  urls = urls.filter(u => (seen.has(u) ? false : (seen.add(u), true)));
  if (urls.length === 0) return res.status(400).json({ error: 'No URLs provided' });
  if (urls.length > 100) return res.status(400).json({ error: 'Up to 100 URLs per batch' });

  _pruneImportCache();
  const uuid = crypto.randomUUID();

  const engine   = _userSetting(u, 'urlImportEngine')   || 'standard';
  const fallback = _userSetting(u, 'urlImportFallback') || 'standard';
  const aiCfg    = _aiConfigForUser(u);
  const scrapeOpts = { engine, fallback, aiCfg };

  // Small concurrent pool. Workers pull from a shared index so we don't
  // need a queue library for a one-shot batch.
  const CONCURRENCY = 3;
  const manifest = new Array(urls.length);
  let nextIdx = 0;

  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= urls.length) return;
      const url = urls[i];
      const fileId = String(i + 1);
      try {
        const result = await _scrapeUrlOnly(url, scrapeOpts);
        if (!result.parsed) {
          const row = {
            id: fileId,
            filename: url,
            source: null,
            url,
            error: result.errors[0] || 'No recipe could be extracted',
            empty: false,
            confidence: 0,
          };
          manifest[i] = row;
          _writeBulkPreview(uuid, fileId, row);
          continue;
        }
        // URL-scraped recipes treat as high confidence (the parse came
        // from a structured source). The Phase 2 picker uses this to
        // pre-check rows by default.
        const summary = {
          id: fileId,
          filename: result.parsed.name || url,
          source: null,
          url,
          type: 'url',
          tier: result.usedTier,
          empty: false,
          confidence: 1,
          name: result.parsed.name,
          servings: result.parsed.servings || null,
          prep_minutes:  result.parsed.prep_minutes  || null,
          cook_minutes:  result.parsed.cook_minutes  || null,
          rest_minutes:  result.parsed.rest_minutes  || null,
          total_minutes: result.parsed.total_minutes || null,
          ingredientCount: (result.parsed.ingredients || []).length,
          stepCount: (result.parsed.steps || []).length,
        };
        manifest[i] = summary;
        _writeBulkPreview(uuid, fileId, { ...summary, recipe: result.parsed });
      } catch (e) {
        const row = {
          id: fileId,
          filename: url,
          source: null,
          url,
          error: e.message || 'Scrape failed',
          empty: false,
          confidence: 0,
        };
        manifest[i] = row;
        _writeBulkPreview(uuid, fileId, row);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker()));

  return res.status(201).json({
    cacheUuid: uuid,
    highConfidenceThreshold: HIGH_CONFIDENCE_THRESHOLD,
    items: manifest,
    summary: {
      total: manifest.length,
      clean:      manifest.filter(m => !m.error).length,
      partial:    0,
      lowOrError: manifest.filter(m =>  m.error).length,
    },
  });
}));

// Read a single user_settings value as a plain string. Returns null
// when not set. Handles both stringified and raw stored values.
function _userSetting(u, key) {
  const row = db.prepare(
    `SELECT value FROM user_settings WHERE ${u == null ? 'user_id IS NULL' : 'user_id = ?'} AND key = ?`
  ).get(...(u == null ? [key] : [u, key]));
  if (!row?.value) return null;
  // Values are JSON-encoded by createSettingStore; unwrap if so.
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === 'string' ? parsed : (parsed == null ? null : String(parsed));
  } catch { return String(row.value); }
}

// Build an AI config object for a user from their stored settings, or
// fall back to the server-side AI env config when they have nothing
// of their own. Returns null when no usable config exists.
function _aiConfigForUser(u) {
  const provider = _userSetting(u, 'aiProvider');
  const apiKey   = _userSetting(u, 'aiApiKey');
  const model    = _userSetting(u, 'aiModel');
  const baseUrl  = _userSetting(u, 'aiBaseUrl');
  if (provider && apiKey) return { provider, apiKey, model: model || '', baseUrl: baseUrl || '' };
  // Fall back to env-configured AI (same key as /api/ai/chat uses).
  if (process.env.AI_API_KEY) {
    return {
      provider: process.env.AI_PROVIDER || 'claude',
      apiKey:   process.env.AI_API_KEY,
      model:    process.env.AI_MODEL || '',
      baseUrl:  process.env.AI_BASE_URL || '',
    };
  }
  return null;
}

// Shared writer used by /scrape, /import, and /import-file. Takes a
// parsed recipe shape and persists it with the same flow as POST /.
function _saveImportedRecipe(u, parsed, opts = {}) {
  const {
    addToPantry = true,
    applyTags = false,
    // Default ON — matches what Mealie / Paprika / NYT Cooking do
    // (categories from the source carry over verbatim). User can opt
    // out via the import dialog if they'd rather keep their catalog
    // tightly curated.
    importCategories = true,
    creatorUsername = null,
    // Dedup behaviour — 'skip' returns null and the row stays in
    // place; 'replace' updates the existing recipe with the imported
    // shape; 'force' creates a duplicate (pre-dedup behaviour). Match
    // is by case-insensitive name first, then by source_url.
    dedup = 'skip',
  } = opts;
  if (dedup !== 'force' && parsed?.name) {
    const lower = String(parsed.name).toLowerCase().trim();
    let existing = db.prepare(
      `SELECT id FROM recipes
        WHERE ${_whereUser(u)} AND deleted_at IS NULL AND lower(name) = ? LIMIT 1`
    ).get(...[..._userArgs(u), lower]);
    if (!existing && parsed.source_url) {
      existing = db.prepare(
        `SELECT id FROM recipes
          WHERE ${_whereUser(u)} AND deleted_at IS NULL AND source_url = ? LIMIT 1`
      ).get(...[..._userArgs(u), parsed.source_url]);
    }
    if (existing) {
      if (dedup === 'skip') return null;
      // dedup === 'replace' falls through and gets re-inserted; the
      // existing row stays for now (could be deleted-and-recreated
      // here but that'd lose cook_diary FK references). Caller can
      // explicitly delete the duplicate after the fact if needed.
    }
  }
  const body = { ...parsed };
  if (!applyTags) body.tags = [];
  if (addToPantry) body.ingredients = _linkIngredientsToPantry(u, body.ingredients);
  // Resolve `category_name` from the importer to a category_id in the
  // user's catalog. Match is case-insensitive; on miss, auto-create a
  // new category when importCategories is on, else drop silently so
  // strict-catalog imports stay strict.
  if (!body.category_id && body.category_name) {
    const name = String(body.category_name).trim();
    const cat = db.prepare(
      `SELECT id FROM recipe_categories WHERE ${_whereUser(u)} AND lower(name) = lower(?) LIMIT 1`
    ).get(...[..._userArgs(u), name]);
    if (cat) {
      body.category_id = cat.id;
    } else if (importCategories && name) {
      // Auto-create — pick a unique slug, append to the end of the
      // catalog. Color is left null; user can theme it in Manage
      // later. Reuses the same insert shape as POST /categories.
      let slug = _slugify(name);
      let i = 2;
      while (db.prepare(
        `SELECT 1 FROM recipe_categories WHERE ${_whereUser(u)} AND slug = ?`
      ).get(...[..._userArgs(u), slug])) {
        slug = `${_slugify(name)}-${i++}`;
      }
      const maxOrder = db.prepare(
        `SELECT COALESCE(MAX(sort_order), -1) AS m FROM recipe_categories WHERE ${_whereUser(u)}`
      ).get(..._userArgs(u)).m;
      const ins = db.prepare(
        `INSERT INTO recipe_categories (user_id, name, slug, color, sort_order) VALUES (?, ?, ?, ?, ?)`
      ).run(u, name, slug, null, maxOrder + 1);
      body.category_id = ins.lastInsertRowid;
    }
  }
  const data = _toStorage(body);
  if (!data.name) throw Object.assign(new Error('No recipe name found'), { status: 400 });

  const result = db.prepare(
    `INSERT INTO recipes
       (user_id, name, description, img_url, servings, yield_text,
        prep_minutes, cook_minutes, total_minutes, rest_minutes, rating, favorite,
        ingredients, steps, tags, tools, nutrition,
        source_url, notes, visibility, created_by_username, category_id, video_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    u, data.name, data.description, data.img_url, data.servings, data.yield_text,
    data.prep_minutes, data.cook_minutes, data.total_minutes, data.rest_minutes, data.rating, data.favorite,
    data.ingredients, data.steps, data.tags, data.tools, data.nutrition,
    data.source_url, data.notes, data.visibility, creatorUsername, data.category_id, data.video_url,
  );

  // Backdate to the source app's original creation timestamp if the
  // importer captured one (Mealie's date_added/created_at, Paprika's
  // `created`). Only pull the date backwards.
  if (parsed.imported_created_at) {
    const ts = new Date(parsed.imported_created_at);
    if (!Number.isNaN(ts.getTime())) {
      const newIso = ts.toISOString().replace('T', ' ').slice(0, 19);
      const cur = db.prepare(`SELECT created_at FROM recipes WHERE id = ?`).get(result.lastInsertRowid)?.created_at || '';
      if (!cur || cur > newIso) {
        db.prepare(`UPDATE recipes SET created_at = ?, updated_at = datetime('now') WHERE id = ?`).run(newIso, result.lastInsertRowid);
      }
    }
  }

  const row = db.prepare(`SELECT * FROM recipes WHERE id = ?`).get(result.lastInsertRowid);
  return _hydrate(row);
}

// ── POST /import — paste-or-upload import ──────────────────────────────
// Accepts either:
//   - JSON body: { text: "<paste>", addToPantry, applyTags }
//   - multipart/form-data with `file` (.json / .html / .paprikarecipes /
//     .paprikarecipe), addToPantry + applyTags as form fields.
// JSON paste auto-detects schema.org/Recipe / Mealie / Tandoor /
// CookTrace shapes; HTML paste runs the JSON-LD extractor; .paprikarecipes
// expands to multiple recipes (one row per file in the archive).
const _importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // 16 MB. Paprika archives can be large.
});
// Multer instance for the file-import flow (Issue #2 Phase 1). Accepts PDF /
// RTF / TXT / MD up to 16 MB. Higher than a typical paste, lower than the
// bulk-zip importer.
const _fileImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
});
// Larger multer for zip-based bulk imports. Mealie / Tandoor backup
// zips with image assets routinely run 100-300 MB. Override via the
// IMPORT_ZIP_MAX_MB env var if you regularly import bigger libraries.
// Default 512 MB matches the full-backup ceiling so the two flows
// behave the same. Memory storage is fine for one-shot imports; the
// buffer is released as soon as the request resolves.
const _zipImportMaxMb = parseInt(process.env.IMPORT_ZIP_MAX_MB || '512', 10);
const _zipImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: _zipImportMaxMb * 1024 * 1024 },
});
// Multer instance for the bulk-file-import flow (Issue #2 Phase 2). Accepts
// multiple files (or a single ZIP) up to IMPORT_ZIP_MAX_MB total. Memory
// storage so nothing the user uploaded touches disk before we extract.
const _bulkFileImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: _zipImportMaxMb * 1024 * 1024,
    files: 200,  // cap the per-request count to keep the scan responsive
  },
});

// Where /uploads lives on disk. Mirrors image-localizer.js.
const _UPLOADS_DIR = process.env.UPLOADS_PATH || './uploads';

// Cache directory for /import-zip uploads. Scan caches the zip here
// with a UUID; commit reads it back instead of forcing the client to
// re-upload the entire archive (which on a 100 MB Mealie backup means
// doubling the upload time + bandwidth for what is otherwise a tiny
// JSON-shaped commit). Files older than 1 hour are pruned on every
// scan so we don't accumulate.
const _IMPORT_CACHE_DIR = path.join(process.env.UPLOADS_PATH || './uploads', '.import-cache');
const _IMPORT_CACHE_TTL_MS = 60 * 60 * 1000;
function _pruneImportCache() {
  try {
    fs.mkdirSync(_IMPORT_CACHE_DIR, { recursive: true });
    const now = Date.now();
    for (const f of fs.readdirSync(_IMPORT_CACHE_DIR)) {
      try {
        const p = path.join(_IMPORT_CACHE_DIR, f);
        const st = fs.statSync(p);
        if (now - st.mtimeMs > _IMPORT_CACHE_TTL_MS) {
          // Both single-file zip caches and bulk preview directories live here.
          // rm with recursive handles both shapes safely.
          fs.rmSync(p, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}
function _importCachePath(id) {
  // Constrain id to a hex UUID so a malicious client can't escape the
  // cache directory via path traversal.
  if (!/^[a-f0-9-]{8,64}$/i.test(id)) return null;
  return path.join(_IMPORT_CACHE_DIR, `${id}.zip`);
}
function _writeImportCache(buffer) {
  fs.mkdirSync(_IMPORT_CACHE_DIR, { recursive: true });
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(_IMPORT_CACHE_DIR, `${id}.zip`), buffer);
  return id;
}
function _readImportCache(id) {
  const p = _importCachePath(id);
  if (!p) return null;
  try { return fs.readFileSync(p); } catch { return null; }
}
function _deleteImportCache(id) {
  const p = _importCachePath(id);
  if (!p) return;
  try { fs.unlinkSync(p); } catch {}
}

// ── Bulk-import cache helpers (Issue #2 Phase 2) ───────────────────────
// Bulk imports cache one JSON preview per source file under
// `.import-cache/<uuid>/`. Each preview is a few KB so the picker can
// render the full manifest without re-uploading anything. The original
// PDF/RTF/TXT/MD/ZIP buffers are dropped after extraction; nothing the
// user uploaded is persisted past the request.
function _bulkCacheDir(uuid) {
  if (!/^[a-f0-9-]{8,64}$/i.test(uuid)) return null;
  return path.join(_IMPORT_CACHE_DIR, `bulk-${uuid}`);
}
function _bulkPreviewPath(uuid, fileId) {
  const dir = _bulkCacheDir(uuid);
  if (!dir) return null;
  if (!/^[a-z0-9_-]{1,32}$/i.test(fileId)) return null;
  return path.join(dir, `${fileId}.json`);
}
function _writeBulkPreview(uuid, fileId, payload) {
  const p = _bulkPreviewPath(uuid, fileId);
  if (!p) throw new Error('Invalid cache id');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(payload));
}
function _readBulkPreview(uuid, fileId) {
  const p = _bulkPreviewPath(uuid, fileId);
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
}
function _readBulkManifest(uuid) {
  const dir = _bulkCacheDir(uuid);
  if (!dir) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
          // Strip the raw extracted text from the manifest payload — the
          // picker doesn't need it, and including 50 × 30 KB blobs makes
          // the response heavy. Re-read full text via _readBulkPreview for
          // the AI-fallback path.
          const { text, ...summary } = data;
          return summary;
        } catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}
function _deleteBulkCache(uuid) {
  const dir = _bulkCacheDir(uuid);
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Save raw image bytes from a zip entry to /uploads and return the
// public path. Returns null on failure so the caller can fall through
// without breaking the import.
function _saveZipImage(bytes, ext) {
  if (!bytes || bytes.length < 64) return null;
  try {
    fs.mkdirSync(_UPLOADS_DIR, { recursive: true });
    const safeExt = /^[a-z0-9]{2,5}$/.test(ext) ? ext : 'jpg';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${safeExt}`;
    const filePath = path.join(_UPLOADS_DIR, filename);
    fs.writeFileSync(filePath, bytes);
    return `/uploads/${filename}`;
  } catch (e) {
    logger.debug(`[import-zip] image save failed: ${e.message}`);
    return null;
  }
}

// ── POST /import-zip/scan — manifest-only inspection of an upload ───────
// Returns the list of recipes found in the zip without writing
// anything. Caller renders this as a picker, then re-uploads the same
// file to /import-zip/commit with the selected indices.
router.post('/import-zip/scan', _zipImportUpload.single('file'), wrap(async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'Upload a zip file' });
  // Drop stale entries before writing a new one so the cache doesn't grow
  // unbounded if commits get abandoned.
  _pruneImportCache();
  let zip, scanned, uploadId;
  try {
    zip = await loadRecipeZip(f.buffer);
    scanned = await scanLoadedZip(zip);
    // Stash the raw zip for /import-zip/commit so the client doesn't
    // need to re-upload it after the user picks recipes. Doesn't block
    // the scan response — even if writing fails, the client can still
    // re-upload via the legacy multipart path.
    try { uploadId = _writeImportCache(f.buffer); }
    catch (e) { logger.debug(`[import-zip] cache write failed: ${e.message}`); }
  } catch (e) { return res.status(400).json({ error: e.message }); }

  // Inline a small base64 thumbnail per recipe so the picker shows
  // real images instead of placeholder icons. Capped at 64 KB per
  // entry — Mealie's `tiny-original.webp` is ~4 KB so 123 thumbs fit
  // comfortably; oversized variants get dropped (the picker falls
  // back to the placeholder badge).
  const THUMB_BYTE_CAP = 64 * 1024;
  const thumbs = await Promise.all(scanned.map(async s => {
    if (!s.thumbEntryName) return null;
    try {
      const img = await readImageFromLoadedZip(zip, s.thumbEntryName);
      if (!img || !img.bytes || img.bytes.length > THUMB_BYTE_CAP) return null;
      const mime = img.ext === 'jpg' || img.ext === 'jpeg' ? 'image/jpeg' :
                   img.ext === 'png'  ? 'image/png'  :
                   img.ext === 'gif'  ? 'image/gif'  :
                   img.ext === 'webp' ? 'image/webp' : 'application/octet-stream';
      return `data:${mime};base64,${img.bytes.toString('base64')}`;
    } catch { return null; }
  }));

  res.json({
    count: scanned.length,
    uploadId: uploadId || null,
    recipes: scanned.map((s, idx) => ({
      idx,
      name: s.recipe.name,
      source: s.source,
      source_url: s.recipe.source_url || null,
      img_url: s.recipe.imgUrl || null,
      has_image_asset: !!s.imageEntryName,
      thumb_data_url: thumbs[idx] || null,
      ingredient_count: (s.recipe.ingredients || []).reduce((n, g) => n + (g.items?.length || 0), 0),
      step_count: (s.recipe.steps || []).length,
      timelineEventCount: Array.isArray(s.timelineEvents) ? s.timelineEvents.length : 0,
    })),
  });
}));

// ── POST /import-zip/commit — write the selected subset ──────────────────
// Accepts EITHER the same zip again as multipart (legacy / fallback for
// expired cache) OR a JSON body with { uploadId, selected, ... } where
// uploadId is the value returned by /import-zip/scan. Cache hit avoids
// re-uploading the entire archive — a 100 MB Mealie backup commit
// becomes a sub-kilobyte JSON request.
router.post('/import-zip/commit', _zipImportUpload.single('file'), wrap(async (req, res) => {
  const u = uid(req);
  const f = req.file;
  // Cached scan flow: client sent { uploadId, selected, addToPantry, ... }
  // as JSON. No file in the request — read the zip from disk.
  const cachedId = (req.body?.uploadId || '').toString();
  let buffer = null;
  if (f) {
    buffer = f.buffer;
  } else if (cachedId) {
    buffer = _readImportCache(cachedId);
    if (!buffer) {
      return res.status(410).json({ error: 'Upload session expired — re-pick the file and try again', code: 'upload_expired' });
    }
  } else {
    return res.status(400).json({ error: 'Upload a zip file or pass uploadId from scan' });
  }

  const addToPantry      = (req.body?.addToPantry ?? true) !== false && req.body?.addToPantry !== 'false';
  const applyTags        = req.body?.applyTags === true || req.body?.applyTags === 'true';
  const importCategories = req.body?.importCategories !== false && req.body?.importCategories !== 'false';
  const importImages = req.body?.import_images === true || req.body?.import_images === 'true' || req.body?.import_images === '1';
  const importTimeline = req.body?.import_timeline === true || req.body?.import_timeline === 'true' || req.body?.import_timeline === '1';
  const dedup = typeof req.body?.dedup === 'string' ? req.body.dedup : 'skip';
  const creatorUsername = req.user?.username || null;

  let selected;
  try {
    selected = req.body?.selected
      ? (typeof req.body.selected === 'string' ? JSON.parse(req.body.selected) : req.body.selected)
      : null;
  } catch { return res.status(400).json({ error: 'Invalid `selected` (expect JSON array of indices)' }); }
  if (!Array.isArray(selected)) selected = null; // null = all

  // Load the zip ONCE and reuse the loaded JSZip across the scan +
  // every per-recipe image extraction. Previous version re-parsed the
  // zip for every image in the loop, which on a 100-recipe Mealie
  // backup meant 100x the work.
  let zip, scanned;
  try {
    zip = await loadRecipeZip(buffer);
    scanned = await scanLoadedZip(zip);
  } catch (e) { return res.status(400).json({ error: e.message }); }

  const wantedIdx = selected != null ? new Set(selected.map(n => parseInt(n, 10)).filter(Number.isFinite)) : null;
  const created = [];
  const failed = [];
  const skippedDup = [];
  let timelineImported = 0;

  for (let i = 0; i < scanned.length; i++) {
    if (wantedIdx && !wantedIdx.has(i)) continue;
    const entry = scanned[i];
    const { recipe, imageEntryName } = entry;
    try {
      // Optional image transfer. Embedded zip image takes priority; if
      // no asset is in the zip and the parsed recipe already has a
      // direct URL (Mealie's image_url, Paprika's photo_url), keep that.
      if (importImages && imageEntryName) {
        const img = await readImageFromLoadedZip(zip, imageEntryName);
        if (img) {
          const local = _saveZipImage(img.bytes, img.ext);
          if (local) recipe.imgUrl = local;
        }
      } else if (!importImages) {
        recipe.imgUrl = null;
      }
      const row = _saveImportedRecipe(u, recipe, { addToPantry, applyTags, importCategories, dedup, creatorUsername });
      // Resolve a target recipe_id even when the row was dedup-skipped
      // so timeline events still land on the existing recipe.
      let targetRecipeId = row?.id || null;
      if (!row) {
        skippedDup.push({ idx: i, name: recipe?.name || `(item ${i})` });
        const lower = String(recipe?.name || '').toLowerCase().trim();
        if (lower) {
          const existing = db.prepare(
            `SELECT id FROM recipes
              WHERE ${_whereUser(u)} AND deleted_at IS NULL AND lower(name) = ? LIMIT 1`
          ).get(...[..._userArgs(u), lower]) || (recipe.source_url ? db.prepare(
            `SELECT id FROM recipes
              WHERE ${_whereUser(u)} AND deleted_at IS NULL AND source_url = ? LIMIT 1`
          ).get(...[..._userArgs(u), recipe.source_url]) : null);
          targetRecipeId = existing?.id || null;
        }
      } else {
        created.push(row);
      }

      // Mealie timeline events ride along with each recipe entry from
      // the importer when present. Land them as cook_diary rows tied
      // to the (new or existing) recipe — dedup by (recipe_id, date,
      // notes) so re-imports don't pile up duplicate cook entries.
      if (importTimeline && targetRecipeId && Array.isArray(entry.timelineEvents) && entry.timelineEvents.length) {
        const insTimeline = db.prepare(
          `INSERT INTO cook_diary (user_id, recipe_id, date, kind, notes, photo_url)
           VALUES (?, ?, ?, 'cooked', ?, ?)`
        );
        const checkDup = db.prepare(
          `SELECT 1 FROM cook_diary
            WHERE ${_whereUser(u)} AND deleted_at IS NULL AND kind = 'cooked'
              AND recipe_id = ? AND date = ?
              AND IFNULL(notes, '') = IFNULL(?, '')
            LIMIT 1`
        );

        // Pre-scan for the "Recipe Created" event so we can backdate
        // the recipe's created_at to the Mealie original. Filter on
        // subject (well-known) rather than event_type to dodge any
        // enum-encoding variance across Mealie versions / endpoints.
        let oldestCreatedTs = null;
        for (const ev of entry.timelineEvents) {
          const subj = String(ev.subject || '').trim();
          if (/^recipe created/i.test(subj)) {
            const ts = ev.timestamp || ev.created_at || ev.createdAt;
            if (ts && (!oldestCreatedTs || ts < oldestCreatedTs)) oldestCreatedTs = ts;
          }
        }
        if (oldestCreatedTs) {
          const ts = new Date(oldestCreatedTs);
          if (!Number.isNaN(ts.getTime())) {
            const newIso = ts.toISOString().replace('T', ' ').slice(0, 19);
            const cur = db.prepare(`SELECT created_at FROM recipes WHERE id = ?`).get(targetRecipeId)?.created_at || '';
            if (!cur || cur > newIso) {
              db.prepare(`UPDATE recipes SET created_at = ?, updated_at = datetime('now') WHERE id = ?`).run(newIso, targetRecipeId);
            }
          }
        }

        const SYSTEM_SUBJECTS = /^(recipe created|recipe updated)\b/i;
        const _AUTO_MADE = /\bmade this( as a side| for \w+)?\.?$/i;

        // Pass 1 (async) — build the row payload list and pre-extract
        // every event photo from the zip. better-sqlite3 transactions
        // are synchronous, so we can't await inside the tx itself.
        const rows = [];
        for (const ev of entry.timelineEvents) {
          if (SYSTEM_SUBJECTS.test(String(ev.subject || '').trim())) continue;
          const ts = ev.timestamp || ev.created_at || ev.createdAt;
          if (!ts) continue;
          const date = String(ts).slice(0, 10);
          const msg = ev.event_message ?? ev.eventMessage ?? null;
          const noteBits = [];
          if (ev.subject && ev.subject !== 'Recipe Made' && !_AUTO_MADE.test(ev.subject)) {
            noteBits.push(ev.subject);
          }
          if (msg) noteBits.push(msg);
          const notes = noteBits.join('\n').trim() || null;

          // Cook-event photo. Mealie's `image` field is "has image" /
          // "does not have image" / null. When present, the photo is
          // in the same zip under
          //   data/recipes/<recipe-uuid>/images/timeline/<event-uuid>/<size>.webp
          let photoUrl = null;
          const hasImage = typeof ev.image === 'string' && /has image/i.test(ev.image);
          if (importImages && hasImage && entry._mealieRecipeUuid && ev.id) {
            for (const p of mealieEventImagePaths(entry._mealieRecipeUuid, ev.id)) {
              const img = await readImageFromLoadedZip(zip, p);
              if (img?.bytes?.length) {
                photoUrl = _saveZipImage(img.bytes, 'webp');
                if (photoUrl) break;
              }
            }
          }
          rows.push({ date, notes, photoUrl });
        }

        // Pass 2 (sync) — dedup-check and INSERT under one transaction.
        const tx = db.transaction(() => {
          for (const row of rows) {
            const dupExists = !!checkDup.get(...[..._userArgs(u), targetRecipeId, row.date, row.notes]);
            if (dupExists) continue;
            insTimeline.run(u, targetRecipeId, row.date, row.notes, row.photoUrl);
            timelineImported++;
          }
        });
        try { tx(); } catch {}
      }
    } catch (e) {
      failed.push({ idx: i, name: recipe?.name || `(item ${i})`, error: e.message || 'Save failed' });
    }
  }

  if (created.length === 0 && failed.length === 0 && skippedDup.length === 0) {
    return res.status(400).json({ error: 'Nothing selected' });
  }
  // Successful commit — drop the cached zip so we don't keep it
  // sitting around taking up space.
  if (cachedId) _deleteImportCache(cachedId);
  res.status(201).json({ count: created.length, recipes: created, failed, skipped: skippedDup, timelineImported });
}));

router.post('/import', _importUpload.single('file'), wrap(async (req, res) => {
  const u = uid(req);
  const addToPantry      = (req.body?.addToPantry ?? true) !== false && req.body?.addToPantry !== 'false';
  const applyTags        = req.body?.applyTags === true || req.body?.applyTags === 'true';
  // Default ON; only explicit "false" disables (form-data sends "false" as a string).
  const importCategories = req.body?.importCategories !== false && req.body?.importCategories !== 'false';
  const creatorUsername = req.user?.username || null;

  // Paprika archive — multiple recipes in one .paprikarecipes zip.
  const f = req.file;
  if (f && /\.paprikarecipes$/i.test(f.originalname)) {
    let recipes;
    try { recipes = await importPaprikaArchive(f.buffer); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const created = [];
    for (const r of recipes) {
      try {
        const row = _saveImportedRecipe(u, r, { addToPantry, applyTags, importCategories, creatorUsername });
        created.push(row);
      } catch (e) {
        // Continue on per-recipe failure — most archives have many.
      }
    }
    if (created.length === 0) return res.status(400).json({ error: 'No recipes could be imported' });
    return res.status(201).json({ recipes: created, count: created.length });
  }

  // Single recipe — text body or single-file upload.
  let text = null;
  if (f) {
    text = f.buffer.toString('utf-8');
  } else if (req.body?.text) {
    text = String(req.body.text);
  }
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Provide a `text` JSON string, an HTML page, or upload a file' });
  }

  let parsed;
  try { parsed = importRecipeFromText(text); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    const row = _saveImportedRecipe(u, parsed, { addToPantry, applyTags, importCategories, creatorUsername });
    return res.status(201).json(row);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Import failed' });
  }
}));

// ── POST /extract-and-parse — Issue #2 Phase 1 ─────────────────────────
// Multi-format text extraction + heuristic recipe parser. Accepts a PDF,
// RTF, TXT, or MD upload, returns the extracted text plus a best-effort
// structured recipe with a confidence score. Does NOT save anything.
//
// Confidence guides the client:
//   high  (>= HIGH_CONFIDENCE_THRESHOLD): save the heuristic result.
//   low   (< threshold) + AI configured:  offer "Try with AI" fallback.
//   low   + no AI:                        offer best-effort save with a badge.
//
// Image-only PDFs (no text layer) come back with empty: true and a hint
// pointing the user at Photo Import per page; auto-rendering those pages
// as images is deferred to a later phase.
router.post('/extract-and-parse', _fileImportUpload.single('file'), wrap(async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'No file uploaded' });
  const type = detectFileType(f.mimetype, f.originalname);
  if (!type) {
    return res.status(400).json({
      error: 'Unsupported file type. Use PDF, RTF, TXT, or MD.',
      filename: f.originalname,
    });
  }
  let extracted;
  try {
    extracted = await extractText(f.buffer, f.mimetype, f.originalname);
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Could not read file', type });
  }
  if (extracted.empty) {
    return res.status(200).json({
      type: extracted.type,
      text: '',
      empty: true,
      pages: extracted.pages || null,
      hint: extracted.type === 'pdf'
        ? 'This PDF has no text layer (looks like a scanned image). Try saving each page as an image and using Photo Import.'
        : 'File is empty.',
      recipe: null,
      confidence: 0,
    });
  }

  // Use the original filename (sans extension) as a fallback recipe name
  // when the text doesn't yield a clear title.
  const fallbackName = String(f.originalname || '').replace(/\.[^.]+$/, '').trim() || null;
  const parsed = parseRecipeText(extracted.text, { fallbackName });

  // `save=true` is the one-shot path: extract, parse, persist, return the row.
  // Used by the dialog when the user confirms a high-confidence preview, or
  // explicitly chooses "save anyway" on a low-confidence one. Without `save`,
  // the call is a read-only preview that the client can route to AI fallback.
  const wantsSave = req.body?.save === true || req.body?.save === 'true' || req.body?.save === '1';
  if (wantsSave) {
    const u = uid(req);
    const addToPantry      = (req.body?.addToPantry ?? false) === true || req.body?.addToPantry === 'true';
    const applyTags        = req.body?.applyTags === true || req.body?.applyTags === 'true';
    const importCategories = req.body?.importCategories !== false && req.body?.importCategories !== 'false';
    try {
      const row = _saveImportedRecipe(u, parsed.recipe, {
        addToPantry, applyTags, importCategories,
        creatorUsername: req.user?.username || null,
      });
      return res.status(201).json({
        type: extracted.type,
        pages: extracted.pages || null,
        confidence: parsed.confidence,
        highConfidenceThreshold: HIGH_CONFIDENCE_THRESHOLD,
        recipe: row,
      });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message || 'Save failed' });
    }
  }

  return res.status(200).json({
    type: extracted.type,
    text: extracted.text,
    empty: false,
    pages: extracted.pages || null,
    recipe: parsed.recipe,
    confidence: parsed.confidence,
    highConfidenceThreshold: HIGH_CONFIDENCE_THRESHOLD,
    debug: parsed.debug,
  });
}));

// ── POST /bulk-scan — Issue #2 Phase 2 ─────────────────────────────────
// Multi-file bulk import. Accepts up to 200 files in one request, or a
// single ZIP that gets expanded server-side. Each supported entry
// (PDF / RTF / TXT / MD) runs through the same extract + heuristic
// pipeline as Phase 1, with the parsed preview cached under
// .import-cache/bulk-<uuid>/<fileId>.json. Returns the cache UUID plus
// a manifest (name, confidence, source filename, ingredient/step counts)
// so the client can render a picker without re-uploading anything.
//
// Original file bytes are never written to disk. Memory storage drops
// them as soon as the request resolves; only the small JSON preview
// (a few KB each) lives in the cache directory.
router.post('/bulk-scan', _bulkFileImportUpload.array('files', 200), wrap(async (req, res) => {
  _pruneImportCache();
  const uploads = Array.isArray(req.files) ? req.files : [];
  if (uploads.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  // Expand any ZIPs into their supported entries.
  const items = [];
  for (const f of uploads) {
    const ext = (f.originalname || '').toLowerCase().split('.').pop();
    const isZip = ext === 'zip' || f.mimetype === 'application/zip' || f.mimetype === 'application/x-zip-compressed';
    if (isZip) {
      let zip;
      try { zip = await JSZip.loadAsync(f.buffer); }
      catch (e) {
        items.push({ kind: 'error', filename: f.originalname, error: 'ZIP read failed: ' + (e.message || 'unknown') });
        continue;
      }
      for (const entryName of Object.keys(zip.files)) {
        const entry = zip.files[entryName];
        if (entry.dir) continue;
        // Skip macOS metadata + hidden / system files.
        if (/^__MACOSX\/|(^|\/)\._|(^|\/)\.DS_Store$/.test(entryName)) continue;
        const entryExt = entryName.toLowerCase().split('.').pop();
        if (!['pdf', 'rtf', 'txt', 'md', 'markdown'].includes(entryExt)) continue;
        let bytes;
        try { bytes = await entry.async('nodebuffer'); }
        catch (e) {
          items.push({ kind: 'error', filename: entryName, source: f.originalname, error: 'Could not read zip entry' });
          continue;
        }
        items.push({ kind: 'file', filename: entryName, source: f.originalname, buffer: bytes, mimetype: _mimeFromExt(entryExt) });
      }
    } else {
      const type = detectFileType(f.mimetype, f.originalname);
      if (!type) {
        items.push({ kind: 'error', filename: f.originalname, error: 'Unsupported file type' });
        continue;
      }
      items.push({ kind: 'file', filename: f.originalname, source: null, buffer: f.buffer, mimetype: f.mimetype });
    }
  }

  if (items.filter(i => i.kind === 'file').length === 0) {
    return res.status(400).json({ error: 'No PDF / RTF / TXT / MD files found in the upload' });
  }

  // Allocate the cache UUID up front, then process each entry. Errors
  // become explicit error rows in the manifest so the picker shows them
  // alongside successful parses.
  const uuid = crypto.randomUUID();
  const manifest = [];
  let nextId = 0;
  for (const it of items) {
    const fileId = String(++nextId);
    if (it.kind === 'error') {
      manifest.push({
        id: fileId,
        filename: it.filename,
        source: it.source || null,
        error: it.error,
        empty: false,
        confidence: 0,
      });
      _writeBulkPreview(uuid, fileId, { ...manifest[manifest.length - 1] });
      continue;
    }
    let extracted;
    try { extracted = await extractText(it.buffer, it.mimetype, it.filename); }
    catch (e) {
      const row = {
        id: fileId,
        filename: it.filename,
        source: it.source,
        error: e.message || 'Extraction failed',
        empty: false,
        confidence: 0,
      };
      manifest.push(row);
      _writeBulkPreview(uuid, fileId, row);
      continue;
    }
    if (extracted.empty) {
      const row = {
        id: fileId,
        filename: it.filename,
        source: it.source,
        type: extracted.type,
        pages: extracted.pages || null,
        empty: true,
        confidence: 0,
        hint: extracted.type === 'pdf'
          ? 'This PDF has no text layer (looks like a scanned image). Try Photo Import per page.'
          : 'File is empty.',
      };
      manifest.push(row);
      _writeBulkPreview(uuid, fileId, row);
      continue;
    }
    const fallbackName = String(it.filename || '').replace(/^.*\//, '').replace(/\.[^.]+$/, '').trim() || null;
    const parsed = parseRecipeText(extracted.text, { fallbackName });
    const summary = {
      id: fileId,
      filename: it.filename,
      source: it.source,
      type: extracted.type,
      pages: extracted.pages || null,
      empty: false,
      confidence: parsed.confidence,
      name: parsed.recipe.name,
      servings: parsed.recipe.servings || null,
      prep_minutes:  parsed.recipe.prep_minutes  || null,
      cook_minutes:  parsed.recipe.cook_minutes  || null,
      rest_minutes:  parsed.recipe.rest_minutes  || null,
      total_minutes: parsed.recipe.total_minutes || null,
      ingredientCount: parsed.recipe.ingredients.length,
      stepCount: parsed.recipe.steps.length,
    };
    manifest.push(summary);
    // Write the full payload (including extracted text + parsed recipe)
    // so commit and the AI-fallback path can re-read it without another
    // upload. Manifest reader strips `text` from the picker response.
    _writeBulkPreview(uuid, fileId, { ...summary, recipe: parsed.recipe, text: extracted.text });
  }

  return res.status(201).json({
    cacheUuid: uuid,
    highConfidenceThreshold: HIGH_CONFIDENCE_THRESHOLD,
    items: manifest,
    summary: {
      total: manifest.length,
      clean: manifest.filter(m => !m.error && !m.empty && m.confidence >= HIGH_CONFIDENCE_THRESHOLD).length,
      partial: manifest.filter(m => !m.error && !m.empty && m.confidence < HIGH_CONFIDENCE_THRESHOLD && m.confidence >= 0.4).length,
      lowOrError: manifest.filter(m => m.error || m.empty || m.confidence < 0.4).length,
    },
  });
}));

// Map a recognized extension to a sensible mime type for downstream extractors.
function _mimeFromExt(ext) {
  if (ext === 'pdf')  return 'application/pdf';
  if (ext === 'rtf')  return 'application/rtf';
  if (ext === 'md' || ext === 'markdown') return 'text/markdown';
  return 'text/plain';
}

// ── POST /bulk-commit ──────────────────────────────────────────────────
// Reads the cached previews for the selected file ids and saves each
// via _saveImportedRecipe. Deletes the cache directory when done so
// nothing the user uploaded is retained beyond the import window.
router.post('/bulk-commit', wrap(async (req, res) => {
  const u = uid(req);
  const cacheUuid = String(req.body?.cacheUuid || '');
  if (!cacheUuid) return res.status(400).json({ error: 'cacheUuid is required' });
  const dir = _bulkCacheDir(cacheUuid);
  if (!dir || !fs.existsSync(dir)) return res.status(404).json({ error: 'Cache expired or not found' });

  const selectedIds = Array.isArray(req.body?.selectedIds) ? req.body.selectedIds.map(String) : null;
  if (!selectedIds || selectedIds.length === 0) {
    return res.status(400).json({ error: 'selectedIds is required (non-empty array)' });
  }
  const addToPantry      = req.body?.addToPantry === true || req.body?.addToPantry === 'true';
  const applyTags        = req.body?.applyTags === true || req.body?.applyTags === 'true';
  const importCategories = req.body?.importCategories !== false && req.body?.importCategories !== 'false';
  const creatorUsername  = req.user?.username || null;

  const created = [];
  const failed = [];
  for (const id of selectedIds) {
    const preview = _readBulkPreview(cacheUuid, id);
    if (!preview || preview.error || preview.empty || !preview.recipe) {
      failed.push({ id, reason: preview?.error || preview?.hint || 'Nothing to save for this entry' });
      continue;
    }
    try {
      const row = _saveImportedRecipe(u, preview.recipe, {
        addToPantry, applyTags, importCategories, creatorUsername,
      });
      created.push({ id, recipe: row });
    } catch (e) {
      failed.push({ id, reason: e.message || 'Save failed' });
    }
  }

  // Cleanup: drop the entire bulk cache directory whether all entries
  // saved cleanly or not. Anything not saved this round needs to be
  // re-uploaded, which matches Mealie's bulk-zip importer behavior.
  _deleteBulkCache(cacheUuid);

  return res.status(201).json({
    count: created.length,
    recipes: created,
    failed,
  });
}));

// ── POST /bulk-cancel ──────────────────────────────────────────────────
// Explicit cancel from the picker. Drops the cache directory immediately
// so abandoned uploads don't wait for the TTL sweep.
router.post('/bulk-cancel', wrap(async (req, res) => {
  const cacheUuid = String(req.body?.cacheUuid || '');
  if (!cacheUuid) return res.status(400).json({ error: 'cacheUuid is required' });
  _deleteBulkCache(cacheUuid);
  return res.status(204).end();
}));

// ── GET /bulk-text/:cacheUuid/:fileId ──────────────────────────────────
// Returns the extracted text for one cached entry. The client uses this
// to feed Trace AI when the user clicks "Try with AI" on a low-confidence
// row in the picker, without re-uploading the original file.
router.get('/bulk-text/:cacheUuid/:fileId', wrap(async (req, res) => {
  const { cacheUuid, fileId } = req.params;
  const preview = _readBulkPreview(cacheUuid, fileId);
  if (!preview) return res.status(404).json({ error: 'Not found' });
  if (preview.error || preview.empty || !preview.text) {
    return res.status(400).json({ error: preview.error || preview.hint || 'No text available' });
  }
  return res.status(200).json({
    text: preview.text,
    filename: preview.filename,
    type: preview.type,
  });
}));

// ── GET /:id/card.png — server-rendered share card (Phase 6) ───────────
// Returns an SVG (browsers + Slack/Discord/iMessage all render SVG fine).
// Pinterest-style portrait card with hero image (if present), recipe name,
// time/serving meta, and CookTrace watermark.
router.get('/:id/card.png', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!recipe) return res.status(404).json({ error: 'Not found' });
  // Allow public access to group-shared recipes; require auth for private.
  if (recipe.visibility !== 'group' && (!req.user || (recipe.user_id != null && recipe.user_id !== req.user.id))) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const total = recipe.total_minutes != null
    ? recipe.total_minutes
    : (recipe.prep_minutes || 0) + (recipe.cook_minutes || 0) + (recipe.rest_minutes || 0);
  const subtitle = [
    total ? `${total} min` : null,
    recipe.servings ? `Serves ${recipe.servings}` : null,
    recipe.yield_text || null,
  ].filter(Boolean).join(' · ');

  // SVG card — 600 × 800 portrait. Hero image embedded via <image> if we
  // can resolve to an absolute URL, else pure typography.
  const safeName = String(recipe.name || 'Recipe').replace(/[<&]/g, '');
  const safeSub = subtitle.replace(/[<&]/g, '');
  const heroSection = recipe.img_url ? `
    <image href="${_absoluteUrl(req, recipe.img_url)}" x="0" y="0" width="600" height="500" preserveAspectRatio="xMidYMid slice" />
    <rect x="0" y="380" width="600" height="120" fill="url(#grad)" />
  ` : `
    <rect x="0" y="0" width="600" height="500" fill="#0A0B0F" />
    <text x="300" y="270" font-size="60" fill="#4FFFB0" text-anchor="middle">🍳</text>
  `;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0)" />
      <stop offset="100%" stop-color="rgba(0,0,0,0.85)" />
    </linearGradient>
  </defs>
  <rect width="600" height="800" fill="#0A0B0F" />
  ${heroSection}
  <text x="40" y="560" font-family="system-ui, sans-serif" font-size="40" font-weight="800" fill="#FFFFFF">${_textWrap(safeName, 22)}</text>
  ${safeSub ? `<text x="40" y="660" font-family="system-ui, sans-serif" font-size="20" fill="#A1A8B8">${safeSub}</text>` : ''}
  <text x="40" y="760" font-family="system-ui, sans-serif" font-size="14" fill="#4FFFB0" font-weight="700" letter-spacing="2">COOKTRACE</text>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(svg);
}));

function _absoluteUrl(req, path) {
  if (!path) return '';
  if (/^https?:\/\//.test(path)) return path;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return `${proto}://${host}${path.startsWith('/') ? '' : '/'}${path}`;
}

function _textWrap(text, perLine) {
  // SVG <text> doesn't auto-wrap. Insert <tspan x="40" dy="48"> for
  // continuation lines. Cap at 3 lines.
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > perLine && cur) { lines.push(cur); cur = w; }
    else cur = cur ? cur + ' ' + w : w;
    if (lines.length >= 2) break;
  }
  if (cur) lines.push(cur);
  if (lines.length > 3) lines.length = 3;
  return lines.map((l, i) => i === 0 ? l : `<tspan x="40" dy="48">${l}</tspan>`).join('');
}

// ── Comments ────────────────────────────────────────────────────────────
// Flat for v1 (parent_id is reserved). Visible to anyone who can see the
// recipe; posting requires auth. Edit/delete restricted to author + admin.
function _commentRow(r) {
  return {
    id: r.id,
    recipe_id: r.recipe_id,
    parent_id: r.parent_id,
    user_id: r.user_id,
    body: r.body,
    created_by_username:  r.created_by_username,
    created_by_full_name: r.created_by_full_name || null,
    created_by_avatar_url: r.created_by_avatar_url || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// Single-comment fetch that joins the author's current avatar so the
// client can render a profile pic instead of a letter avatar. Avatar
// is read live (not denormalized) so users see updates without
// rewriting comment rows.
function _selectCommentJoined(cid) {
  return db.prepare(
    `SELECT c.*, u.avatar_url AS created_by_avatar_url,
              u.full_name AS created_by_full_name
       FROM recipe_comments c
       LEFT JOIN users u ON u.id = c.user_id
      WHERE c.id = ?`
  ).get(cid);
}

router.get('/:id/comments', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!recipe) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && recipe.user_id == null) || recipe.user_id === u;
  if (!isOwner && recipe.visibility !== 'group') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const rows = db.prepare(
    `SELECT c.*, u.avatar_url AS created_by_avatar_url,
              u.full_name AS created_by_full_name
       FROM recipe_comments c
       LEFT JOIN users u ON u.id = c.user_id
      WHERE c.recipe_id = ? AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC`
  ).all(id);
  res.json(rows.map(_commentRow));
}));

router.post('/:id/comments', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  // Posting requires a real user even in single-user mode (we attach the
  // username from req.user). If single-user is anonymous, fall through
  // to user_id=NULL and a generic display name.
  const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!recipe) return res.status(404).json({ error: 'Not found' });

  const body = (req.body?.body || '').toString().trim();
  if (!body) return res.status(400).json({ error: 'body required' });
  if (body.length > 4000) return res.status(400).json({ error: 'comment too long (4000 char max)' });

  const parentRaw = req.body?.parent_id;
  const parentId = parentRaw != null && Number.isFinite(parseInt(parentRaw, 10)) ? parseInt(parentRaw, 10) : null;
  // Parent must belong to the same recipe — guard against cross-recipe attaches.
  if (parentId != null) {
    const parent = db.prepare(`SELECT recipe_id FROM recipe_comments WHERE id = ? AND deleted_at IS NULL`).get(parentId);
    if (!parent || parent.recipe_id !== id) return res.status(400).json({ error: 'Invalid parent_id' });
  }

  const username = req.user?.username || null;
  const result = db.prepare(
    `INSERT INTO recipe_comments (recipe_id, user_id, parent_id, body, created_by_username)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, u, parentId, body, username);
  const row = _selectCommentJoined(result.lastInsertRowid);

  // Notify the recipe owner if it's not their own comment. Fire-and-
  // forget — the notification is a nicety; commenting succeeds either
  // way. Skipped in single-user mode (recipe.user_id == null).
  try {
    if (recipe.user_id != null && recipe.user_id !== u) {
      notifyCommentReply(recipe.user_id, recipe.name, username || 'Someone')
        .catch(() => {});
    }
  } catch {}

  res.status(201).json(_commentRow(row));
}));

router.put('/:id/comments/:commentId', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  const cid = parseInt(req.params.commentId, 10);
  if (!Number.isFinite(id) || !Number.isFinite(cid)) return res.status(400).json({ error: 'Invalid id' });

  const c = db.prepare(`SELECT * FROM recipe_comments WHERE id = ? AND recipe_id = ? AND deleted_at IS NULL`).get(cid, id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const isAuthor = (u == null && c.user_id == null) || c.user_id === u;
  const isAdmin = req.user?.role === 'admin';
  if (!isAuthor && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

  const body = (req.body?.body || '').toString().trim();
  if (!body) return res.status(400).json({ error: 'body required' });
  if (body.length > 4000) return res.status(400).json({ error: 'comment too long (4000 char max)' });

  db.prepare(
    `UPDATE recipe_comments SET body = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(body, cid);
  const row = _selectCommentJoined(cid);
  res.json(_commentRow(row));
}));

router.delete('/:id/comments/:commentId', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  const cid = parseInt(req.params.commentId, 10);
  if (!Number.isFinite(id) || !Number.isFinite(cid)) return res.status(400).json({ error: 'Invalid id' });

  const c = db.prepare(`SELECT * FROM recipe_comments WHERE id = ? AND recipe_id = ? AND deleted_at IS NULL`).get(cid, id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const isAuthor = (u == null && c.user_id == null) || c.user_id === u;
  const isAdmin = req.user?.role === 'admin';
  if (!isAuthor && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

  db.prepare(
    `UPDATE recipe_comments SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(cid);
  res.json({ ok: true });
}));

// ── DELETE /:id — soft delete ───────────────────────────────────────────
router.delete('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const existing = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const isOwner = (u == null && existing.user_id == null) || existing.user_id === u;
  if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

  db.prepare(
    `UPDATE recipes SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(id);
  res.json({ ok: true });
}));

export default router;
