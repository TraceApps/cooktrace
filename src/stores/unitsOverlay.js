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

const EMPTY = { disabled: [], custom: [] };
let _loaded = false;
let _inflight = null;

// Loads when the first component subscribes (a UnitPicker on screen), not
// when the module is imported: importing the app pulled this in on the
// sign-in screen, where the request could only be refused.
export const unitsOverlay = writable(EMPTY, () => {
  if (!_loaded && !_inflight) refreshUnitsOverlay();
});

// Moves when the account changes: a read started before doesn't land.
let _gen = 0;
async function _fetch() {
  const gen = _gen;
  try {
    const res = await NtApi.getUnits();
    if (gen === _gen) unitsOverlay.set({ disabled: res?.disabled || [], custom: res?.custom || [] });
  } catch {
    if (gen === _gen) unitsOverlay.set(EMPTY);
  }
}

/** Trigger a fetch. Returns a Promise so callers (e.g. Manage edits)
 *  can await consistency before the next render. */
export function refreshUnitsOverlay() {
  const gen = _gen;
  const p = _fetch().finally(() => { if (gen === _gen) { _loaded = true; _inflight = null; } });
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
