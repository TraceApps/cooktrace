/**
 * One edit of a synced row meeting the copy here, field by field.
 *
 * The rule is the one every Trace app shares (lib/field-sync.js, the same
 * file in each, pinned by scripts/field-sync.test.js): the newer edit of
 * each field stays, fields that belong together stay together, a delete
 * made before a later edit loses, and an edit made before a delete doesn't
 * bring the row back. Times count in whole seconds; a tie between two edits
 * goes to the one arriving, a tie between an edit and a delete to the
 * delete.
 *
 * CookTrace adds one thing in front of it: an edit says which copy it was
 * made on (base: the server's synced_at of that copy), and db.js keeps, per
 * row, when each field last changed here (field_stamps: { field:
 * [synced_at, edited_at] }). A field not changed here since the edit's copy
 * is simply the edit's to change, whatever the clocks say; only a field
 * changed here too is decided by time. With no usable base (an edit made
 * before the app kept one, or a stamp from the future), every field counts
 * as changed here, and the times decide. An edit time that can't be right
 * (before the row existed, after now) can't be judged: the edit goes in,
 * and what it replaces is reported as lost so it can be kept.
 */
import { utcMs } from './sync-clock.js';
import { normaliseIngredientGroups } from './recipe-hydrate.js';
import { mergeEdit, deleteLoses, editRevives, fieldUnits } from './field-sync.js';

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
 * field it sends counts), editedAt (server clock), fieldEdits (when each
 * field was edited, where the sender knows: { field: time } on the server's
 * clock; a field edited before a later edit of another keeps its own time).
 *
 * Returns { row: every field's value afterwards, applied, lostIncoming,
 * lostExisting: field lists, updatedAt (never earlier than here), fieldAt
 * (the edit's time), fieldTimes ({ field: time } of each field that went
 * in, to stamp), write, devicePulls (the device's copy isn't what stays),
 * validBase, plausible }.
 */
const EPOCH = '1970-01-01T00:00:00.000Z';
const _fmt = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

export function mergeFields(existing, incoming, { fields, groups = [], base, changed = null, editedAt, fieldEdits = null, now = Date.now() }) {
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
  // The edit's time: when it was made, or now when that can't be right.
  const atMs = plausible ? Math.min(editMs, now) : now;
  // When each field changed here, as the shared rule reads it: a field not
  // changed here since the edit's copy (or any field, when the edit's time
  // can't be judged) counts as never, so the edit takes it.
  const times = {};
  for (const f of fields) {
    if (plausible && changedHere(f)) { if (stampOf(f)[1]) times[f] = stampOf(f)[1]; } else times[f] = EPOCH;
  }
  // Each field's own edit time, where the sender says and it can be right.
  let fieldAt = null;
  if (plausible && fieldEdits && typeof fieldEdits === 'object') {
    fieldAt = {};
    for (const [f, v] of Object.entries(fieldEdits)) {
      const ms = utcMs(v);
      if (Number.isFinite(ms) && (!Number.isFinite(createdMs) || ms >= createdMs - 60_000)) fieldAt[f] = ms;
    }
  }

  const row = {};
  const applied = [], lostIncoming = [], lostExisting = [];
  const softDelete = fields.includes('deleted_at');
  const content = fields.filter(f => f !== 'deleted_at' && !ORDER_FIELDS.has(f));
  const editFields = content.filter(differs);
  // A delete made here: when it was, for an edit meeting it.
  const revives = () => editRevives({ existing, at: atMs, times });

  let editLost = false;
  row.deleted_at = softDelete ? (existing.deleted_at ?? null) : undefined;
  if (softDelete && has('deleted_at') && !sameValue('deleted_at', incoming.deleted_at, existing.deleted_at)) {
    if (incoming.deleted_at != null) {
      // A delete: it loses to an edit of the item's content here since the
      // device's copy, or to the item brought back here, made after it (a
      // new place in a list isn't one).
      if (deleteLoses({ existing, fields: content, at: atMs, times }) != null) lostIncoming.push('deleted_at');
      else { row.deleted_at = incoming.deleted_at; applied.push('deleted_at'); }
    } else if (!changedHere('deleted_at') || !plausible || revives()) {
      // Brought back: by an edit made after the delete here, or of a copy
      // that already had the delete.
      row.deleted_at = null; applied.push('deleted_at');
    } else {
      lostIncoming.push('deleted_at');
      editLost = true;
    }
  } else if (softDelete && existing.deleted_at != null && editFields.length && changedHere('deleted_at')) {
    // An edit of the content meets a delete made here since the device's
    // copy: made after it, it brings the item back; made before, it's lost.
    if (plausible && !revives()) editLost = true;
    else { row.deleted_at = null; applied.push('deleted_at'); }
  }

  const merging = fields.filter(f => f !== 'deleted_at');
  const unitGroups = (groups || []).map(g => g.filter(f => f !== 'deleted_at'));
  let mergedTimes = null;
  if (editLost) {
    for (const f of merging) row[f] = existing[f];
    lostIncoming.push(...merging.filter(differs));
  } else {
    const values = {};
    for (const f of merging) if (sent(f)) values[f] = incoming[f];
    const m = mergeEdit({
      existing, values, fields: merging, groups: unitGroups,
      changed: changed ? [...changed] : null, at: atMs, fieldAt, times,
      same: (f, a, b) => sameValue(f, a, b),
    });
    Object.assign(row, m.row);
    applied.push(...m.applied);
    lostIncoming.push(...m.lost);
    // A unit that went in over a change made here since the device's copy:
    // what it replaced is lost.
    for (const unit of fieldUnits(merging, unitGroups)) {
      if (!unit.some(f => m.applied.includes(f)) || !unit.some(changedHere)) continue;
      lostExisting.push(...unit.filter(f => sent(f) && !sameValue(f, incoming[f], existing[f])));
    }
    mergedTimes = m.times;
  }

  const write = applied.length > 0;
  // The time of what went in: the edit's, or now when it can't be right;
  // each field its own, where the sender said.
  const fieldAtStr = _fmt(atMs);
  const fieldTimes = {};
  for (const f of applied) {
    const ms = f === 'deleted_at' ? NaN : utcMs(mergedTimes?.[f]);
    fieldTimes[f] = Number.isFinite(ms) ? _fmt(ms) : fieldAtStr;
  }
  // A row's edit time never goes back.
  const updatedAt = write && !(utcMs(existing.updated_at) >= utcMs(fieldAtStr)) ? fieldAtStr : existing.updated_at;
  const devicePulls = fields.some(f => f !== 'deleted_at' && sent(f) && !sameValue(f, row[f], incoming[f]))
    || (softDelete && sent('deleted_at') && !sameValue('deleted_at', row.deleted_at, incoming.deleted_at));
  return { row, applied, lostIncoming, lostExisting, updatedAt, fieldAt: fieldAtStr, fieldTimes, write, devicePulls, validBase, plausible };
}
