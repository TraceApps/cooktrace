/**
 * Recipe history (#54): the versions of what a recipe has you cook, and
 * the cooks made from each. What a version is lives in recipe-content.js;
 * the table and the cook stamp in db.js.
 *
 * Every write that can change a recipe's content calls recordRevision()
 * after it: the routes (create, edit, restore, import), Trace's tools and
 * a phone's sync. Nothing is trimmed: a version goes only by hand, and only
 * when no cook used it.
 */
import db from '../db.js';
import { revisionOf, parseRevision, restoreValues, legacyRevOf } from './recipe-content.js';

/** A version's name: trimmed, at most 60 characters, or null. */
export function cleanLabel(v) {
  const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 60) : null;
}

const _now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/**
 * The recipe's content as a version: added when it's new, brought back when
 * it was deleted, and made the recipe's current one. `at` dates a new one
 * (when it was made, by the server's clock); `by` is whose edit it was.
 * Returns the version's key.
 */
export function recordRevision(recipeId, { by = null, at = null } = {}) {
  const r = db.prepare(`SELECT * FROM recipes WHERE id = ?`).get(recipeId);
  if (!r) return null;
  const { rev, data } = revisionOf(r);
  const when = at || _now();
  db.prepare(
    `INSERT INTO recipe_revisions (recipe_id, user_id, rev, data, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(recipe_id, rev) DO UPDATE SET deleted_at = NULL, updated_at = excluded.updated_at
     WHERE recipe_revisions.deleted_at IS NOT NULL`
  ).run(r.id, r.user_id ?? null, rev, JSON.stringify(data), by ?? r.last_edited_by ?? r.user_id ?? null, when, when);
  if (r.rev !== rev) db.prepare(`UPDATE recipes SET rev = ? WHERE id = ?`).run(rev, r.id);
  return rev;
}

// Who may add to a recipe's history: its owner, or a Sous Chef of a
// kitchen it's shared with (routes/recipes.js _canEditViaKitchen).
function _mayAdd(recipe, u) {
  if ((u == null && recipe.user_id == null) || (u != null && recipe.user_id === u)) return true;
  return u != null && !!db.prepare(
    `SELECT 1 FROM recipe_shares s
       JOIN kitchen_members m ON m.kitchen_id = s.via_kitchen_id AND m.user_id = s.grantee_id
      WHERE s.recipe_id = ? AND s.grantee_id = ? AND s.via_kitchen_id IS NOT NULL AND m.role = 'sous' LIMIT 1`
  ).get(recipe.id, u);
}

/**
 * The version a cook says it was made from, made sure of before the cook
 * is kept, so the cook never loses it (#54). For someone who may change the
 * recipe's history (`u`: its owner or a kitchen's Sous Chef):
 *   - deleted elsewhere before this cook was heard of: it comes back, as a
 *     version a cook used stays;
 *   - not here yet, and the cook brings it (`version`: { data, at }, from a
 *     page whose save is still on its way up): kept, dated when it was cooked.
 * For anyone, a key from an older app or server (amounts rounded, and no
 * content brought, as only newer apps bring it): the version it meant.
 * Returns the key the cook keeps: `rev`, or the version it meant.
 */
export function cookedVersion(recipeId, rev, { version = null, u = null } = {}) {
  if (recipeId == null || typeof rev !== 'string' || !rev) return rev;
  const recipe = db.prepare(`SELECT id, user_id, rev, created_at FROM recipes WHERE id = ?`).get(recipeId);
  if (!recipe) return rev;
  const mayAdd = _mayAdd(recipe, u);
  const revive = v => {
    if (v.deleted_at && mayAdd) db.prepare(`UPDATE recipe_revisions SET deleted_at = NULL, updated_at = ? WHERE id = ?`).run(_now(), v.id);
  };
  const v = db.prepare(`SELECT id, deleted_at FROM recipe_revisions WHERE recipe_id = ? AND rev = ?`).get(recipeId, rev);
  if (v) { revive(v); return rev; }
  const brought = version && typeof version === 'object' && version.data;
  if (brought) {
    if (!mayAdd) return rev;
    const made = revisionOf(parseRevision(version.data));
    if (made.rev !== rev) return rev;
    // When it was cooked, by the page's clock: never before the recipe was
    // made, never after now.
    const raw = typeof version.at === 'string' ? new Date(version.at) : null;
    let when = raw && !Number.isNaN(raw.getTime()) ? raw.toISOString().replace('T', ' ').slice(0, 19) : _now();
    if (when > _now()) when = _now();
    if (recipe.created_at && when < recipe.created_at) when = recipe.created_at;
    db.prepare(
      `INSERT OR IGNORE INTO recipe_revisions (recipe_id, user_id, rev, data, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(recipe.id, recipe.user_id ?? null, rev, JSON.stringify(made.data), u ?? null, when, when);
    return rev;
  }
  // An old key can stand for more than one version (that was the trouble
  // with it): an app works it out from the recipe as it has it, so the
  // current version first, then the newest.
  for (const old of db.prepare(
    `SELECT id, rev, data, deleted_at FROM recipe_revisions WHERE recipe_id = ?
      ORDER BY (rev = ?) DESC, created_at DESC, id DESC`
  ).all(recipeId, recipe.rev ?? null)) {
    let was = null;
    try { was = legacyRevOf(parseRevision(old.data)); } catch { /* unreadable */ }
    if (was === rev && was !== old.rev) { revive(old); return old.rev; }
  }
  return rev;
}

/** Is this version used by a cook (anyone's)? */
export function revisionUsed(recipeId, rev) {
  return !!db.prepare(
    `SELECT 1 FROM cook_diary WHERE recipe_id = ? AND recipe_rev = ? AND deleted_at IS NULL LIMIT 1`
  ).get(recipeId, rev);
}

/**
 * A recipe's versions, oldest first and numbered, each with `viewer`'s own
 * cooks of it (date, rating, notes, photos) and whether anyone's cook uses
 * it. Deleted versions aren't listed, but their numbers stay taken, so
 * Version 3 is always the same version.
 */
export function listRevisions(recipe, viewer) {
  const rows = db.prepare(
    `SELECT v.id, v.rev, v.data, v.label, v.created_at, v.deleted_at, v.created_by,
            COALESCE(u.full_name, u.username) AS created_by_name
       FROM recipe_revisions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.recipe_id = ?
      ORDER BY v.created_at ASC, v.id ASC`
  ).all(recipe.id);
  const userClause = viewer == null ? 'user_id IS NULL' : 'user_id = ?';
  const cooks = db.prepare(
    `SELECT id, date, rating, notes, photo_url, photos, servings, recipe_rev, meal_type
       FROM cook_diary WHERE recipe_id = ? AND kind = 'cooked' AND deleted_at IS NULL AND ${userClause}
      ORDER BY date DESC, id DESC`
  ).all(recipe.id, ...(viewer == null ? [] : [viewer]));
  const used = new Set(db.prepare(
    `SELECT DISTINCT recipe_rev FROM cook_diary WHERE recipe_id = ? AND recipe_rev IS NOT NULL AND deleted_at IS NULL`
  ).all(recipe.id).map(x => x.recipe_rev));
  const out = [];
  rows.forEach((v, i) => {
    if (v.deleted_at) return;
    out.push({
      id: v.id,
      rev: v.rev,
      number: i + 1,
      label: v.label || null,
      created_at: v.created_at,
      created_by: v.created_by ?? null,
      created_by_name: v.created_by_name || null,
      current: v.rev === recipe.rev,
      used: used.has(v.rev),
      data: parseRevision(v.data),
      cooks: cooks.filter(c => c.recipe_rev === v.rev),
    });
  });
  return {
    current: recipe.rev || null,
    revisions: out,
    // Cooks from before the history was kept, or of a version since deleted.
    unversioned: cooks.filter(c => !c.recipe_rev || !out.some(v => v.rev === c.recipe_rev)),
  };
}

/** One version of a recipe, or null. */
export function getRevision(recipeId, rev) {
  const v = db.prepare(`SELECT * FROM recipe_revisions WHERE recipe_id = ? AND rev = ?`).get(recipeId, rev);
  if (!v) return null;
  const number = db.prepare(
    `SELECT COUNT(*) AS n FROM recipe_revisions WHERE recipe_id = ? AND (created_at < ? OR (created_at = ? AND id <= ?))`
  ).get(recipeId, v.created_at, v.created_at, v.id).n;
  return { id: v.id, rev: v.rev, number, label: v.label || null, created_at: v.created_at, deleted: !!v.deleted_at, data: parseRevision(v.data) };
}

/** The columns that put a version back on its recipe (recipe-content.js). */
export const restoreColumns = (recipe, data) => restoreValues(recipe, data);
