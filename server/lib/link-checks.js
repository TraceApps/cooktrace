/**
 * link-checks.js: an id a request (or an upload) sends for another row
 * points only at a row the account may point at, or at nothing.
 *
 * An id from somewhere else (the Android app's own numbering, sent by an
 * older upload, or another account's row) never links across accounts and
 * never reads another account's row (a pantry item's aisle, a recipe's
 * name). Used by the REST routes; the sync push has the same rule
 * (routes/sync.js _translateParents).
 */
import db from '../db.js';

const _mine = (row, u) => !!row && ((u == null && row.user_id == null) || (u != null && row.user_id === u));

/** The id, when that row of `table` is the account's (and not deleted;
 *  `softDelete: false` for a table without deleted_at); else null. */
export function ownId(table, raw, u, { softDelete = true } = {}) {
  const id = raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isInteger(id)) return null;
  const row = db.prepare(`SELECT user_id${softDelete ? ', deleted_at' : ''} FROM ${table} WHERE id = ?`).get(id);
  if (!_mine(row, u)) return null;
  if (softDelete && row.deleted_at != null) return null;
  return id;
}

/** A recipe the account owns or was shared (a shopping item or a cook can be about a shared one). */
export function linkableRecipeId(raw, u) {
  const own = ownId('recipes', raw, u);
  if (own != null) return own;
  const id = Number(raw);
  if (u == null || !Number.isInteger(id)) return null;
  return db.prepare(`SELECT 1 FROM recipe_shares WHERE recipe_id = ? AND grantee_id = ?`).get(id, u) ? id : null;
}

/**
 * A recipe's ingredients (JSON text or a list of groups) with every pantry
 * link that isn't one of `ownerId`'s own pantry items taken out: a link
 * holds the server's id of the recipe owner's item, never another
 * account's (or an id from a phone's own numbering). Same type back.
 */
export function ownIngredientLinks(ingredients, ownerId) {
  const asText = typeof ingredients === 'string';
  let groups = ingredients;
  if (asText) { try { groups = JSON.parse(ingredients); } catch { return ingredients; } }
  if (!Array.isArray(groups)) return ingredients;
  let changed = false;
  const items = g => (g && Array.isArray(g.items) ? g.items : null);
  const fix = it => {
    if (!it || typeof it !== 'object' || it.pantry_item_id == null) return it;
    if (ownId('pantry_items', it.pantry_item_id, ownerId) != null) return it;
    changed = true;
    const { pantry_item_id, ...rest } = it;
    return rest;
  };
  const out = groups.map(g => (items(g) ? { ...g, items: g.items.map(fix) } : fix(g)));
  if (!changed) return ingredients;
  return asText ? JSON.stringify(out) : out;
}
