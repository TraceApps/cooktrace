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

async function _fetch() {
  try {
    const res = await NtApi.getUnits();
    unitsOverlay.set({ disabled: res?.disabled || [], custom: res?.custom || [] });
  } catch {
    unitsOverlay.set(EMPTY);
  }
}

/** Trigger a fetch. Returns a Promise so callers (e.g. Manage edits)
 *  can await consistency before the next render. */
export function refreshUnitsOverlay() {
  _inflight = _fetch().finally(() => { _loaded = true; _inflight = null; });
  return _inflight;
}
