/**
 * A save through the REST API (the web app, also replaying saves made with
 * no connection) that says which copy it was made on and what it changed
 * (_sync: { base_synced_at, changed, edited_at, client_now }) merges with
 * the row as a phone's sync does (lib/field-merge.js): what it didn't
 * change stays, and of what it did, the newer of it and a change here
 * since stays. A save that can't say (an older page) writes as before.
 */
import db from '../db.js';
import { mergeFields } from './field-merge.js';
import { SYNC_FIELDS, SYNC_GROUPS } from './sync-fields.js';
import { clockOffset, editTime } from './sync-clock.js';
import { stampFields } from './field-stamps.js';

const _now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/**
 * Write a save to one row. `next`: the columns the route would write, with
 * the values it worked out (from the body, or the row's own where the body
 * leaves them out). Returns { wrote, kept }: kept when what stays isn't all
 * the save sent, so the caller answers with the row as it now is.
 */
export function saveRow(table, id, existing, next, sync) {
  const cols = Object.keys(next);
  if (!sync || typeof sync !== 'object') {
    db.prepare(`UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...cols.map(c => next[c]), _now(), id);
    return { wrote: true, kept: false };
  }
  const fields = (SYNC_FIELDS[table] || []).filter(f => f !== 'deleted_at');
  const incoming = {};
  for (const f of fields) if (f in next) incoming[f] = next[f];
  const said = Array.isArray(sync.changed) ? new Set(sync.changed) : null;
  const changed = new Set(Object.keys(incoming).filter(f => !said || said.has(f)));
  const m = mergeFields(existing, incoming, {
    fields, groups: SYNC_GROUPS[table], changed,
    base: typeof sync.base_synced_at === 'string' ? sync.base_synced_at : null,
    editedAt: editTime(typeof sync.edited_at === 'string' ? sync.edited_at : null, clockOffset(sync.client_now)),
  });
  if (!m.write) return { wrote: false, kept: m.devicePulls };
  db.prepare(`UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...cols.map(c => (c in m.row ? m.row[c] : next[c])), m.updatedAt, id);
  stampFields(table, id, m.applied, m.fieldAt);
  return { wrote: true, kept: m.devicePulls };
}
