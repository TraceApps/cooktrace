/**
 * Keeping the pantry's variant tree in the shape PUT /api/pantry/:id allows,
 * after edits from two devices were merged (each fine alone, not together):
 *   - a variant's generic item is not itself a variant (one level only);
 *   - an item with variants is not a variant;
 *   - an item's nutrition source is one of its own variants, and a variant
 *     has no nutrition source.
 * Where two links break a rule, the newer edit stays and the older link is
 * taken out, so the tree is never left invalid.
 */
import db from '../db.js';
import { fieldStamps } from './field-merge.js';
import { utcMs } from './sync-clock.js';
import { stampFields } from './field-stamps.js';

const _get = id => (id == null ? null : db.prepare(`SELECT * FROM pantry_items WHERE id = ? AND deleted_at IS NULL`).get(id));
const _at = (row, f) => utcMs(fieldStamps(row)(f)[1]) || 0;
function _drop(id, f) {
  db.prepare(`UPDATE pantry_items SET ${f} = NULL WHERE id = ?`).run(id);
  stampFields('pantry_items', id, [f]);
}

/** Check the rows `ids` touch (and their generics and variants); returns the links taken out. */
export function repairVariantTree(ids) {
  const dropped = [];
  const queue = [...new Set(ids)];
  for (let n = 0; queue.length && n < 500; n++) {
    const r = _get(queue.shift());
    if (!r) continue;
    if (r.generic_parent_id != null) {
      const p = _get(r.generic_parent_id);
      // Its generic is a variant itself (or it is its own): the newer link stays.
      if (p && (p.id === r.id || p.generic_parent_id != null)) {
        if (p.id !== r.id && _at(r, 'generic_parent_id') >= _at(p, 'generic_parent_id')) {
          _drop(p.id, 'generic_parent_id'); dropped.push([p.id, 'generic_parent_id']); queue.push(p.id, r.id);
        } else {
          _drop(r.id, 'generic_parent_id'); dropped.push([r.id, 'generic_parent_id']); queue.push(r.id);
        }
        continue;
      }
      // It is a variant with variants of its own: the newer link stays.
      const kids = db.prepare(`SELECT * FROM pantry_items WHERE generic_parent_id = ? AND deleted_at IS NULL`).all(r.id);
      if (kids.length) {
        if (Math.max(...kids.map(k => _at(k, 'generic_parent_id'))) > _at(r, 'generic_parent_id')) {
          _drop(r.id, 'generic_parent_id'); dropped.push([r.id, 'generic_parent_id']); queue.push(r.id);
          continue;
        }
        for (const kid of kids) { _drop(kid.id, 'generic_parent_id'); dropped.push([kid.id, 'generic_parent_id']); }
      }
    }
    const fresh = _get(r.id);
    if (fresh?.nutrition_source_variant_id != null) {
      const v = _get(fresh.nutrition_source_variant_id);
      if (fresh.generic_parent_id != null || !v || v.generic_parent_id !== fresh.id) {
        _drop(fresh.id, 'nutrition_source_variant_id'); dropped.push([fresh.id, 'nutrition_source_variant_id']);
      }
    }
    // Its own generic may now own a source that is no longer its variant.
    if (r.generic_parent_id != null && !queue.includes(r.generic_parent_id)) {
      const p = _get(r.generic_parent_id);
      if (p?.nutrition_source_variant_id != null) {
        const v = _get(p.nutrition_source_variant_id);
        if (!v || v.generic_parent_id !== p.id) { _drop(p.id, 'nutrition_source_variant_id'); dropped.push([p.id, 'nutrition_source_variant_id']); }
      }
    }
  }
  return dropped;
}
