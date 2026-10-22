/**
 * Which recipes a smart cookbook holds, from its saved filter.
 *
 * Identical copies live at server/lib/smart-cookbook.js (the server) and
 * src/lib/smart-cookbook.js (the Android app's own database), so a smart
 * cookbook holds the same recipes on both. scripts/smart-cookbook.test.js
 * keeps the two the same.
 *
 * Supported criteria, every one that is set must match:
 *   { category_id, tags: [], favorites_only, min_rating, max_total_minutes }
 * Tags match without regard to case, and a recipe needs every listed tag.
 */

/** A filter as saved: known criteria only, numbers as numbers. */
export function cleanSmartFilter(f) {
  const clean = {};
  if (!f || typeof f !== 'object') return clean;
  if (Number.isFinite(parseInt(f.category_id, 10))) clean.category_id = parseInt(f.category_id, 10);
  if (Array.isArray(f.tags)) clean.tags = f.tags.map(s => String(s).trim()).filter(Boolean);
  if (f.favorites_only === true) clean.favorites_only = true;
  if (Number.isFinite(parseInt(f.min_rating, 10))) clean.min_rating = parseInt(f.min_rating, 10);
  if (Number.isFinite(parseInt(f.max_total_minutes, 10))) clean.max_total_minutes = parseInt(f.max_total_minutes, 10);
  return clean;
}

/** The saved filter from a cookbook row, or null when it has none. */
export function parseSmartFilter(json) {
  if (json == null || json === '') return null;
  if (typeof json === 'object') return json;
  try { return JSON.parse(json); } catch { return null; }
}

function _tagsOf(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw || '[]'); } catch { arr = []; }
  }
  return new Set((Array.isArray(arr) ? arr : []).map(t => String(t).toLowerCase()));
}

/** True when a recipe row (not deleted) matches the filter. */
export function matchesSmartFilter(recipe, filter) {
  if (!recipe || !filter || typeof filter !== 'object') return false;
  if (recipe.deleted_at != null) return false;
  if (Number.isFinite(filter.category_id)) {
    if (recipe.category_id == null || Number(recipe.category_id) !== filter.category_id) return false;
  }
  if (filter.favorites_only && Number(recipe.favorite) !== 1) return false;
  if (Number.isFinite(filter.min_rating)) {
    if (recipe.rating == null || !(Number(recipe.rating) >= filter.min_rating)) return false;
  }
  if (Number.isFinite(filter.max_total_minutes)) {
    const total = (Number(recipe.prep_minutes) || 0) + (Number(recipe.cook_minutes) || 0);
    if (!(total <= filter.max_total_minutes)) return false;
  }
  const want = Array.isArray(filter.tags) ? filter.tags.map(s => String(s).toLowerCase()) : [];
  if (want.length > 0) {
    const have = _tagsOf(recipe.tags);
    if (!want.every(t => have.has(t))) return false;
  }
  return true;
}

/** A saved filter (JSON) with its category id put through `map` (an id
 *  in, an id or undefined out). Undefined leaves it as is. Category ids
 *  differ between a phone and the server, so sync translates them. */
export function mapSmartFilterCategory(json, map) {
  if (!json) return json;
  let f;
  try { f = typeof json === 'string' ? JSON.parse(json) : json; } catch { return json; }
  if (!f || typeof f !== 'object' || f.category_id == null) return json;
  const to = map(f.category_id);
  if (to == null) return json;
  return JSON.stringify({ ...f, category_id: to });
}
