// recipe-hydrate.js — shared recipe row → API-shape hydration.
//
// Extracted from recipes.js so every endpoint that returns recipe
// cards (the main list, a single recipe, and — the reason this file
// exists — a cookbook's recipe list) hydrates them identically:
// resolved category, normalised ingredient groups, parsed JSON
// columns, and (where relevant) the pantry-match "N of M ingredients
// in stock" summary.
//
// Before this extraction, cookbooks.js had its own narrower SELECT
// and no hydration step at all, so cookbook cards were silently
// missing category, rating badge data, tags, and pantry-match versus
// the same recipe's card on the Recipes tab. Same class of bug as
// the Kitchen auto-share fan-out miss (server/lib/auto-share.js) —
// logic that should be one shared implementation had drifted into
// two, and the second one was thinner.
import db from '../db.js';

export function safeJson(text, fallback) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

export function normaliseIngredientGroups(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  // Detect old flat shape: items have qty/unit/name at the top level
  // rather than an `items` array. Wrap in a single empty-name group.
  const looksFlat = raw.every(r => r && typeof r === 'object' && !Array.isArray(r.items));
  if (looksFlat) return [{ name: '', items: raw }];
  return raw.map(g => ({
    name:  (g && g.name) || '',
    items: Array.isArray(g && g.items) ? g.items : [],
  }));
}

// Resolve + normalise one recipe row into the shape every recipe-card
// consumer expects. `categoryMap` is an optional pre-built Map (see
// buildCategoryMap below) to avoid an N+1 SELECT across a list.
export function hydrateRecipe(row, categoryMap = null) {
  if (!row) return null;
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
    ingredients: normaliseIngredientGroups(safeJson(row.ingredients, [])),
    steps:       safeJson(row.steps, []),
    tags:        safeJson(row.tags, []),
    tools:       safeJson(row.tools, []),
    nutrition:   safeJson(row.nutrition, {}),
    favorite:    !!row.favorite,
    category,
  };
}

// Count "X of Y ingredients you have in stock" given the recipe's
// grouped ingredient array (already normalised) + a Set of
// "effectively in-stock" pantry_item_ids (see buildStockSet).
export function matchSummary(grouped, stockSet) {
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

// Per-user Set of "effectively in-stock" pantry_item_ids — variant-
// aware (Issue #4): an item counts as in-stock when its own
// in_stock = 1, OR when it is a generic with at least one in-stock
// child variant. Build once per request and reuse across every
// recipe's matchSummary call, same as the main recipes list endpoint
// always has.
export function buildStockSet(u) {
  const whereUser = u == null ? 'user_id IS NULL' : 'user_id = ?';
  const args = u == null ? [] : [u];
  const allStock = db.prepare(
    `SELECT id, generic_parent_id, in_stock FROM pantry_items
       WHERE ${whereUser} AND deleted_at IS NULL`
  ).all(...args);
  const stockSet = new Set();
  const stockedByParent = new Set();
  for (const r of allStock) {
    if (r.in_stock) {
      stockSet.add(r.id);
      if (r.generic_parent_id != null) stockedByParent.add(r.generic_parent_id);
    }
  }
  for (const r of allStock) {
    if (stockedByParent.has(r.id)) stockSet.add(r.id);
  }
  return stockSet;
}

// Per-user category id -> {id,name,slug,color} map, built once and
// reused across a batch of recipes to avoid an N+1 SELECT.
export function buildCategoryMap(u) {
  const whereUser = u == null ? 'user_id IS NULL' : 'user_id = ?';
  const args = u == null ? [] : [u];
  const catMap = new Map();
  for (const c of db.prepare(
    `SELECT id, name, slug, color FROM recipe_categories WHERE ${whereUser}`
  ).all(...args)) {
    catMap.set(c.id, c);
  }
  return catMap;
}
