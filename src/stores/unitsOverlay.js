/**
 * unitsOverlay — server-backed cache of `{ disabled, custom }` for
 * cooking units. Read by every UnitPicker on the page, refreshed by
 * the Manage Units editor when the user toggles or creates entries.
 *
 * Load is lazy: stays empty (no disable, no custom) until first read,
 * then fetches once and shares the result across all subscribers.
 */
import { writable, get } from 'svelte/store';
import { NtApi } from '../lib/api.js';
import { onSyncChanges } from '../lib/sync-refresh.js';

const EMPTY = { disabled: [], custom: [] };
let _loaded = false;
let _inflight = null;
let _watched = false;  // a picker is on screen
let _changes = 0;      // syncs that changed the units (lib/sync-refresh.js)
let _seq = 0;

// Loads when the first component subscribes (a UnitPicker on screen), not
// when the module is imported: importing the app pulled this in on the
// sign-in screen, where the request could only be refused.
export const unitsOverlay = writable(EMPTY, () => {
  _watched = true;
  if (!_loaded && !_inflight) refreshUnitsOverlay();
  return () => { _watched = false; };
});

// Android: a sync that changed the custom or turned-off units makes what is
// held here old. A picker on screen reads them again at once (quietly); with
// none, the next one to appear does.
onSyncChanges(() => {
  _changes++;
  if (_watched) refreshUnitsOverlay({ quiet: true });
  else _loaded = false;
}, ['custom_units', 'disabled_units']);

// Moves when the account changes: a read started before doesn't land.
let _gen = 0;
async function _fetch(quiet = false) {
  const gen = _gen;
  const mine = ++_seq; // only the newest read sets the store
  try {
    const res = await NtApi.getUnits();
    if (gen === _gen && mine === _seq) unitsOverlay.set({ disabled: res?.disabled || [], custom: res?.custom || [] });
    return true;
  } catch {
    // A quiet read that fails keeps what is held (and the next picker asks again).
    if (gen === _gen && mine === _seq && !quiet) unitsOverlay.set(EMPTY);
    return !quiet;
  }
}

/** Trigger a fetch. Returns a Promise so callers (e.g. Manage edits)
 *  can await consistency before the next render. */
export function refreshUnitsOverlay({ quiet = false } = {}) {
  const gen = _gen;
  const seen = _changes;
  const p = _fetch(quiet).then(ok => { if (gen === _gen) { _loaded = ok && seen === _changes; _inflight = null; } });
  _inflight = p;
  return p;
}

/** Another account (or none): forget this one's units; the next picker on
 *  screen reads them again (lib/user-state.js). */
export function resetUnitsOverlay() {
  _gen++;
  _loaded = false;
  _inflight = null;
  unitsOverlay.set(EMPTY);
}
