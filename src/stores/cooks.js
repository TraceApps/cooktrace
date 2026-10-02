/**
 * cooks.js: which recipes are being cooked right now, on this device.
 *
 * Cooking two things at once is the normal case for a meal, dinner in the
 * oven while dessert is started, and the timers were always tagged with the
 * recipe they belong to. What was missing was anywhere to see that a cook is
 * underway when you are not standing on its page, so a forgotten cook could
 * sit there for days and a paired watch would go on showing it.
 *
 * Held on the device, never on the server: a cook is a thing this phone is
 * doing, not a fact about the recipe. It survives closing the app, which is
 * why it needs somewhere visible to live.
 */
import { writable, get } from 'svelte/store';

const KEY = 'ct:cooks';
const LEGACY = 'ct:cookmode:';

function _load() {
  if (typeof localStorage === 'undefined') return {};
  let out = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) out = JSON.parse(raw) || {};
  } catch { out = {}; }
  // One-time move from the per-recipe flags this used to use. Those carried
  // no name, so the cook shows as the recipe's id until its page is opened.
  try {
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(LEGACY)) continue;
      stale.push(k);
      const id = Number(k.slice(LEGACY.length));
      if (Number.isFinite(id) && localStorage.getItem(k) === '1' && !out[id]) {
        out[id] = { name: '', serverId: 0, at: Date.now() };
      }
    }
    stale.forEach(k => localStorage.removeItem(k));
    if (stale.length) localStorage.setItem(KEY, JSON.stringify(out));
  } catch { /* nothing to move */ }
  return out;
}

function _save(value) {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(KEY, JSON.stringify(value)); } catch {}
}

/** { [localRecipeId]: { name, img, serverId, at } } */
export const activeCooks = writable(_load());

activeCooks.subscribe(_save);

/** Start cooking this recipe, alongside anything else already underway. */
export function startCook(localId, { name = '', img = '', serverId = 0 } = {}) {
  if (!Number.isFinite(localId)) return;
  activeCooks.update(all => {
    // Strictly after everything already underway. Two cooks started in the
    // same millisecond would otherwise tie, and a tie falls back to the
    // order of the keys, which for numbers is numeric rather than the order
    // you actually started them in.
    const latest = Object.values(all).reduce((max, c) => Math.max(max, c.at || 0), 0);
    const at = Math.max(Date.now(), latest + 1);
    return { ...all, [localId]: { name, img, serverId: Number(serverId) || 0, at } };
  });
}

/** Keep what a cook knows about itself up to date, without restarting it. */
export function describeCook(localId, { name, img, serverId } = {}) {
  if (!Number.isFinite(localId)) return;
  activeCooks.update(all => {
    const mine = all[localId];
    if (!mine) return all;
    const next = { ...mine };
    if (name != null && name !== '') next.name = name;
    if (img != null && img !== '') next.img = img;
    if (serverId) next.serverId = Number(serverId);
    if (next.name === mine.name && next.img === mine.img && next.serverId === mine.serverId) return all;
    return { ...all, [localId]: next };
  });
}

export function endCook(localId) {
  activeCooks.update(all => {
    if (!(localId in all)) return all;
    const next = { ...all };
    delete next[localId];
    return next;
  });
}

export function isCooking(localId) {
  return !!get(activeCooks)[localId];
}

/** Oldest first, so the list does not reshuffle as you start another. */
export function cookList(all) {
  return Object.entries(all || {})
    .map(([id, v]) => ({ localId: Number(id), ...v }))
    .sort((a, b) => (a.at || 0) - (b.at || 0));
}
