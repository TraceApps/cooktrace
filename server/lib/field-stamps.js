/**
 * Setting when fields of a row were edited, where a write's own updated_at
 * isn't that time: a merged edit's fields went in at the edit's time, and
 * a reorder moves sort_order now without being an edit of the row (its
 * updated_at stays). See the field_stamps triggers in db.js.
 */
import db from '../db.js';

export function stampFields(table, id, fields, at = new Date().toISOString().replace('T', ' ').slice(0, 19)) {
  if (!fields.length) return;
  db.prepare(
    `UPDATE ${table} SET field_stamps = json_set(COALESCE(field_stamps, '{}'), ${fields.map(() => `?, json_array(json_extract(COALESCE(field_stamps, '{}'), ?), ?)`).join(', ')}) WHERE id = ?`
  ).run(...fields.flatMap(f => [`$.${f}`, `$.${f}[0]`, at]), id);
}
