/**
 * One edit of a synced row meeting the copy here, field by field.
 *
 * An edit says which copy it was made on (base: the server's synced_at of
 * that copy) and which fields it changed. db.js keeps, per row, when each
 * field last changed here (field_stamps: { field: [synced_at, edited_at] }).
 * So for each field the edit changed:
 *   - unchanged here since the edit's copy: the edit's value goes in;
 *   - changed here too: the newer of the two stays, by edit time on the
 *     server's clock, and the other is lost for that field.
 * Fields the edit didn't change stay as they are here. A delete and an
 * edit meet as a whole: the newer stays. With no usable base (an edit made
 * before the app kept one, or a stamp from the future), every field counts
 * as changed here, and the times decide. An edit time that can't be right
 * (before the row existed, after now) can't be judged: the edit goes in,
 * and what it replaces is reported as lost so it can be kept.
 */
import { serverIsNewer, utcMs } from './sync-clock.js';
import { normaliseIngredientGroups } from './recipe-hydrate.js';

const BOOLEAN_FIELDS = new Set(['favorite', 'in_stock', 'checked', 'is_smart']);

function _stable(v) {
  if (Array.isArray(v)) return `[${v.map(_stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${_stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** A field's value as compared: the same value written another way is equal. */
export function normValue(f, v) {
  if (v === undefined || v === '') v = null;
  if (f === 'deleted_at') return v == null ? 0 : 1;
  if (BOOLEAN_FIELDS.has(f)) return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
  if (f === 'visibility') return v || 'private';
  if (typeof v === 'string' && /^\s*[[{]/.test(v)) { try { v = JSON.parse(v); } catch { /* text */ } }
  if (f === 'ingredients' && Array.isArray(v)) v = normaliseIngredientGroups(v);
  if (Array.isArray(v) && v.length === 0) return null;
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return null;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return v;
}

export function sameValue(f, a, b) {
  return _stable(normValue(f, a)) === _stable(normValue(f, b));
}

/**
 * When each field last changed here: [server stamp, edit time]. A field
 * with no stamp of its own (a row from before the stamps, see db.js) takes
 * the row's baseline, the last write known when the stamps began, never
 * the row's latest write: a later edit of one field doesn't make the
 * others look changed.
 */
export function fieldStamps(existing) {
  let s = {};
  try { s = existing?.field_stamps ? JSON.parse(existing.field_stamps) : {}; } catch { s = {}; }
  const baseline = Array.isArray(s._base) ? s._base : ['', ''];
  return f => (Array.isArray(s[f]) ? s[f] : baseline);
}

// Not an edit of an item's content: a new place in a list. It never stands
// against a delete, either way.
const ORDER_FIELDS = new Set(['sort_order']);

/**
 * existing: the row here. incoming: the edit's values (as stored; a field
 * it doesn't send is undefined). fields: the fields that merge. groups:
 * lists of fields that merge as one (lib/sync-fields.js SYNC_GROUPS).
 * Options: base, changed (a Set, or null when the edit can't say: every
 * field it sends counts), editedAt (server clock).
 *
 * Returns { row: every field's value afterwards, applied, lostIncoming,
 * lostExisting: field lists, updatedAt (never earlier than here), fieldAt
 * (the edit time of the fields that went in), write, devicePulls (the
 * device's copy isn't what stays), validBase, plausible }.
 */
export function mergeFields(existing, incoming, { fields, groups = [], base, changed = null, editedAt, now = Date.now() }) {
  const validBase = typeof base === 'string' && base !== '' && existing.synced_at != null && base <= existing.synced_at;
  const stampOf = fieldStamps(existing);
  const changedHere = f => !validBase || String(stampOf(f)[0] ?? '') > base;
  const sent = f => incoming[f] !== undefined;
  const has = f => sent(f) && (changed ? changed.has(f) : true);
  const differs = f => has(f) && !sameValue(f, incoming[f], existing[f]);
  const editMs = utcMs(editedAt);
  const createdMs = utcMs(existing.created_at);
  const plausible = Number.isFinite(editMs) && editMs <= now + 5000
    && (!Number.isFinite(createdMs) || editMs >= createdMs - 60_000);
  // Whether the copy here, as of `at`, is newer than the edit.
  const hereNewer = at => plausible && serverIsNewer(at, editedAt);
  const latest = list => list.map(f => stampOf(f)[1]).filter(Boolean).sort((a, b) => utcMs(b) - utcMs(a))[0];

  const row = {};
  const applied = [], lostIncoming = [], lostExisting = [];
  const softDelete = fields.includes('deleted_at');
  const content = fields.filter(f => f !== 'deleted_at' && !ORDER_FIELDS.has(f));
  const editFields = content.filter(differs);

  let editLost = false;
  row.deleted_at = softDelete ? (existing.deleted_at ?? null) : undefined;
  if (softDelete && has('deleted_at') && !sameValue('deleted_at', incoming.deleted_at, existing.deleted_at)) {
    if (incoming.deleted_at != null) {
      // A delete: it loses to an edit of the item's content here since the
      // device's copy that's newer than it (a new place in a list isn't one).
      const latestHere = latest(content.filter(changedHere));
      if (latestHere && hereNewer(latestHere)) lostIncoming.push('deleted_at');
      else { row.deleted_at = incoming.deleted_at; applied.push('deleted_at'); }
    } else {
      row.deleted_at = null; applied.push('deleted_at');
    }
  } else if (softDelete && existing.deleted_at != null && editFields.length && changedHere('deleted_at')) {
    // An edit of the content meets a delete made here since the device's copy.
    if (hereNewer(stampOf('deleted_at')[1])) editLost = true;
    else { row.deleted_at = null; applied.push('deleted_at'); }
  }

  // The fields that merge as one, then each of the rest on its own.
  const inGroup = new Set();
  const units = [];
  for (const g of groups) {
    const u = g.filter(f => fields.includes(f) && f !== 'deleted_at');
    if (u.length) { units.push(u); u.forEach(f => inGroup.add(f)); }
  }
  for (const f of fields) if (f !== 'deleted_at' && !inGroup.has(f)) units.push([f]);

  for (const unit of units) {
    for (const f of unit) row[f] = existing[f];
    const touched = unit.filter(differs);
    if (!touched.length) continue;
    if (editLost) { lostIncoming.push(...touched); continue; }
    const take = () => {
      // The edit's whole group (what it sends of it), so it stays whole.
      for (const f of unit) {
        if (sent(f) && (has(f) || unit.length > 1) && !sameValue(f, incoming[f], existing[f])) { row[f] = incoming[f]; applied.push(f); }
      }
    };
    const here = unit.filter(changedHere);
    if (!here.length) { take(); continue; }
    if (hereNewer(latest(here))) { lostIncoming.push(...touched); continue; }
    lostExisting.push(...unit.filter(f => sent(f) && !sameValue(f, incoming[f], existing[f])));
    take();
  }

  const write = applied.length > 0;
  // The time of what went in: the edit's, or now when it can't be right.
  const fieldAt = plausible ? editedAt : new Date(now).toISOString().replace('T', ' ').slice(0, 19);
  // A row's edit time never goes back.
  const updatedAt = write && !(utcMs(existing.updated_at) >= utcMs(fieldAt)) ? fieldAt : existing.updated_at;
  const devicePulls = fields.some(f => f !== 'deleted_at' && sent(f) && !sameValue(f, row[f], incoming[f]))
    || (softDelete && sent('deleted_at') && !sameValue('deleted_at', row.deleted_at, incoming.deleted_at));
  return { row, applied, lostIncoming, lostExisting, updatedAt, fieldAt, write, devicePulls, validBase, plausible };
}
