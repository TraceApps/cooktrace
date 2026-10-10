/**
 * Earlier versions of a recipe.
 *
 * A device that syncs an edit made against an older copy of a recipe meets
 * a newer copy on the server, and only one of the two can stay. The other
 * one is kept here, so nothing typed on either side is lost: the recipe page
 * offers it back. Restoring a version keeps the copy it replaces the same
 * way, so a restore can be undone.
 */
import db from '../db.js';
import { mergeFields } from './field-merge.js';
import { SYNC_GROUPS } from './sync-fields.js';
import { normaliseIngredientGroups } from './recipe-hydrate.js';

// What a version holds: the recipe as someone wrote it. Rating, favorite,
// cook counts and sharing are about the recipe, not its content.
export const VERSION_FIELDS = [
  'name', 'description', 'ingredients', 'steps', 'tags', 'tools', 'notes',
  'servings', 'prep_minutes', 'cook_minutes', 'total_minutes', 'rest_minutes',
  'nutrition', 'category_id', 'img_url', 'source_url', 'video_url', 'yield_text',
];
// About the recipe rather than its content: each is merged like the rest,
// and never kept as a version.
// A recipe's allergen correction (lib/allergens.js) is one of them.
export const META_FIELDS = ['rating', 'favorite', 'visibility', 'allergen_overrides'];
// The fields an edit of a recipe is merged over.
export const RECIPE_MERGE_FIELDS = [...VERSION_FIELDS, ...META_FIELDS, 'deleted_at'];

const JSON_FIELDS = { ingredients: [], steps: [], tags: [], tools: [], nutrition: {} };
const NUMBER_FIELDS = new Set(['servings', 'prep_minutes', 'cook_minutes', 'total_minutes', 'rest_minutes', 'category_id']);

// Versions kept per recipe.
export const VERSIONS_KEPT = 20;

/** A recipe row (stored or pushed) as plain content, comparable either way. */
export function recipeContent(row) {
  const out = {};
  for (const f of VERSION_FIELDS) {
    let v = row?.[f];
    if (f in JSON_FIELDS) {
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* kept as text */ } }
      if (v == null || v === '') v = JSON_FIELDS[f];
      // Grouped or the older flat list: the same ingredients.
      if (f === 'ingredients' && Array.isArray(v)) v = normaliseIngredientGroups(v);
    } else if (v === undefined || v === '') {
      v = null;
    } else if (NUMBER_FIELDS.has(f) && typeof v === 'string' && Number.isFinite(Number(v))) {
      v = Number(v);
    }
    out[f] = v;
  }
  return out;
}

// Key order doesn't make two copies different.
function _stable(v) {
  if (Array.isArray(v)) return `[${v.map(_stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${_stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export function sameContent(a, b) {
  return _stable(recipeContent(a)) === _stable(recipeContent(b));
}

/**
 * Keep `row`'s content as a version of the recipe. reason: 'conflict' (two
 * edits met), 'restore' (the copy a restore replaced), or 'replaced' (the
 * copy a save that can't say what it was made on replaced: an older app or
 * page; kept only to be safe, so not pointed at). editedBy: whose edit the
 * copy was. The newest VERSIONS_KEPT per recipe stay, whoever made them;
 * over that, the oldest 'replaced' copies go first.
 */
export function saveRecipeVersion(recipeId, userId, row, { reason = 'conflict', seen = reason !== 'conflict', editedBy = userId } = {}) {
  // The same copy kept already (the same edit sent twice, two syncs at
  // once, a restore of a copy kept before): kept once, as the newest, for
  // this reason. The older entry goes, so it's never the first trimmed and
  // a restore's undo point never stays marked 'replaced'.
  const data = JSON.stringify(recipeContent(row));
  const key = _stable(recipeContent(row));
  for (const v of db.prepare(`SELECT id, data FROM recipe_versions WHERE recipe_id = ?`).all(recipeId)) {
    let same = false;
    try { same = _stable(recipeContent(JSON.parse(v.data))) === key; } catch { same = false; }
    if (same) db.prepare(`DELETE FROM recipe_versions WHERE id = ?`).run(v.id);
  }
  db.prepare(
    `INSERT INTO recipe_versions (recipe_id, user_id, data, reason, seen, edited_by) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(recipeId, userId ?? null, data, reason, seen ? 1 : 0, editedBy ?? null);
  db.prepare(
    `DELETE FROM recipe_versions WHERE recipe_id = ? AND id NOT IN (
       SELECT id FROM recipe_versions WHERE recipe_id = ?
        ORDER BY (reason = 'replaced') ASC, id DESC LIMIT ?)`
  ).run(recipeId, recipeId, VERSIONS_KEPT);
}

/**
 * One edit of a recipe meeting the copy here (lib/field-merge.js, over its
 * content, rating, favorite, visibility and deleted_at; cook counts are the
 * server's, counted from the diary), and which copy is kept as a version:
 * only when content was lost. The edit's copy when some of its content
 * didn't go in (it never saw the newer change here). The copy here when
 * the edit replaced content changed here since: pointed at when the edit
 * said which copy it was made on, or its time can't be judged; kept quietly
 * ('replaced') when it couldn't say.
 *
 * Returns mergeFields' result plus keep: [{ row, reason, side }].
 */
export function mergeRecipe(existing, incoming, opts) {
  const m = mergeFields(existing, incoming, { ...opts, fields: RECIPE_MERGE_FIELDS, groups: SYNC_GROUPS.recipes });
  const keep = [];
  const lost = list => list.some(f => VERSION_FIELDS.includes(f));
  if (lost(m.lostIncoming) && incoming.deleted_at == null) {
    const edited = { ...existing };
    for (const f of VERSION_FIELDS) if (m.lostIncoming.includes(f) || m.applied.includes(f)) edited[f] = incoming[f];
    if (!sameContent(edited, existing)) keep.push({ side: 'incoming', row: edited, reason: 'conflict' });
  }
  if (lost(m.lostExisting) && existing.deleted_at == null) {
    keep.push({ side: 'existing', row: existing, reason: m.validBase || !m.plausible ? 'conflict' : 'replaced' });
  }
  return { ...m, keep };
}

/** The columns and values that put a version's content back on the recipe. */
export function versionColumns(data) {
  const c = recipeContent(data);
  const cols = [];
  const vals = [];
  for (const f of VERSION_FIELDS) {
    cols.push(f);
    vals.push(f in JSON_FIELDS && typeof c[f] !== 'string' ? JSON.stringify(c[f]) : c[f]);
  }
  return { cols, vals };
}
