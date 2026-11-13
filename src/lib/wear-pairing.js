/**
 * wear-pairing.js: hand the watch app what it needs, and the cook you are in.
 *
 * The Wear app talks to CookTrace itself, so it ticks a shopping list off in
 * an aisle with no phone signal. It needs the server address and a token for
 * the signed-in account, and there is no keyboard on a watch worth typing
 * either into. The phone writes both into the Wearable Data Layer when you
 * sign in, and takes them away when you sign out. In Local mode there is no
 * server: the watch asks this phone instead (watch-relay.js).
 *
 * Pressing Cook sends the recipe over the same channel, along with what has
 * been ticked off it. Either device can tick, so each write carries a stamp
 * and the later one wins.
 *
 * Android only, and only when a watch is actually paired with this phone.
 */
import { registerPlugin } from '@capacitor/core';
import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { isNative, getServerUrl, getAuthToken, getNativeMode } from './platform.js';
import { APP_VERSION } from './version.js';
import { mirroredConfirmation } from './plain-http.js';
import { PHONE_ADDRESS, answerWatchRequest } from './watch-relay.js';

// Registered at module level: a plugin proxy returned from an async function
// confuses Capacitor's promise handling.
const WearPairing = registerPlugin('WearPairing');

/** Is there a watch paired with this phone? */
export async function hasWatch() {
  if (!isNative) return false;
  try {
    const { paired } = await WearPairing.hasWatch();
    return !!paired;
  } catch {
    return false;
  }
}

/** Local mode: no server, so the watch asks this phone (watch-relay.js). */
export function isLocalMode() {
  return isNative && getNativeMode() === 'local' && !getServerUrl();
}

/**
 * The id the watch knows a cook's recipe by. With a server, the server's,
 * since the watch fetches it from there; in Local mode this phone's own,
 * since the watch asks this phone. Zero: nothing the watch could fetch.
 */
export function watchRecipeId(cook) {
  return Number(isLocalMode() ? cook?.localId : cook?.serverId) || 0;
}

/**
 * Send the current server and token to the watch. Safe to call often: the
 * write carries a timestamp, so a refreshed token still reaches the watch.
 */
export async function pairWatch() {
  if (!isNative) return false;
  const serverUrl = getServerUrl();
  const token = getAuthToken();
  const local = isLocalMode();
  // Signed out of a server: nothing to hand over. Say which of these it is: a
  // watch stuck on "pair from your phone" is otherwise a mystery from both
  // ends, and this line is the only thing that can tell you why.
  if (!local && (!serverUrl || !token)) {
    console.warn('[wear] not pairing:', serverUrl ? 'signed in on this device but no token' : 'no server connected');
    return false;
  }
  if (!(await hasWatch())) {
    console.warn('[wear] not pairing: no watch is connected to this phone');
    return false;
  }
  try {
    // With this phone's release: a watch on an older one catches up to it.
    // httpOk: the server again when it is plain http:// on your own network
    // and you said Connect Anyway to it; the watch uses plain HTTP only then
    // (LocalAddress.kt, from TraceApps/nutritrace#194).
    // In Local mode the watch is told to ask this phone instead (watch-relay.js).
    if (local) await WearPairing.pair({ serverUrl: PHONE_ADDRESS, token: 'local', appVersion: APP_VERSION, httpOk: '' });
    else await WearPairing.pair({ serverUrl, token, appVersion: APP_VERSION, httpOk: mirroredConfirmation(serverUrl) });
    console.info('[wear] paired with the watch');
    return true;
  } catch (e) {
    console.warn('[wear] pairing failed:', e?.message || e);
    return false;
  }
}

/**
 * Every cook underway, for the watch to show: each one by the id YOUR SERVER
 * uses (never this phone's own) and what has been ticked off it. A list, not
 * a single cook, because a meal is usually two dishes and two devices sharing
 * one slot would only overwrite each other.
 */
export async function publishCooks(cooks, at = 0) {
  if (!isNative) return false;
  try {
    await WearPairing.cooks({
      cooks: (cooks || []).map(c => ({
        serverRecipeId: Number(c.serverRecipeId) || 0,
        name: String(c.name || ''),
        steps: Array.from(c.steps || []).map(Number).filter(Number.isFinite),
        ingredients: Array.from(c.ingredients || []).map(String),
      })).filter(c => c.serverRecipeId > 0),
      // Which ids these are: the phone's own (Local mode) or the server's. A
      // record from before a switch then never points at the wrong recipe.
      local: isLocalMode(),
      at: at || Date.now(),
    });
    return true;
  } catch (e) {
    console.warn('[wear] could not send the cooks:', e?.message || e);
    return false;
  }
}

/**
 * What the watch says about the cooks, when it has the later word. Returns
 * the list to adopt, or undefined when this phone's own state is newer and
 * nothing here should change.
 */
export async function readCooks(mine = 0) {
  if (!isNative) return undefined;
  try {
    const remote = await WearPairing.readCooks();
    if (!remote?.found) return undefined;
    if (Number(remote.at || 0) <= mine) return undefined;
    // Said in the other mode (before a switch): its ids aren't this mode's.
    if (!!remote.local !== isLocalMode()) return undefined;
    return (remote.cooks || []).map(c => ({
      serverRecipeId: Number(c.serverRecipeId) || 0,
      name: String(c.name || ''),
      steps: (c.steps || []).map(Number).filter(Number.isFinite),
      ingredients: (c.ingredients || []).map(String),
    })).filter(c => c.serverRecipeId > 0);
  } catch {
    return undefined;
  }
}

/**
 * What is counting down in the kitchen, for the watch to hold too.
 *
 * Only ever called while a cook has been handed over: off a cook the watch
 * has no business being woken to hear about a timer, let alone ringing in a
 * drawer about one. Each timer carries a key both devices know it by and an
 * absolute deadline, so a slow delivery is late rather than wrong.
 */
export async function publishTimers(timers, at = 0) {
  if (!isNative) return false;
  try {
    await WearPairing.timers({
      timers: (timers || []).map(t => ({
        key: String(t.key || ''),
        label: String(t.label || ''),
        total: Number(t.total) || 0,
        endsAt: Number(t.endsAt) || 0,
      })).filter(t => t.key && t.endsAt > 0),
      at: at || Date.now(),
    });
    return true;
  } catch (e) {
    console.warn('[wear] could not send the timers:', e?.message || e);
    return false;
  }
}

/**
 * What the watch says is counting, when it has the later word. Returns the
 * list to adopt, or undefined when this phone's own state is newer and
 * nothing here should change.
 */
export async function readTimers(mine = 0) {
  if (!isNative) return undefined;
  try {
    const remote = await WearPairing.readTimers();
    if (!remote?.found) return undefined;
    if (Number(remote.at || 0) <= mine) return undefined;
    return (remote.timers || []).map(t => ({
      key: String(t.key || ''),
      label: String(t.label || ''),
      total: Number(t.total) || 0,
      endsAt: Number(t.endsAt) || 0,
    })).filter(t => t.key && t.endsAt > 0);
  } catch {
    return undefined;
  }
}

let _serving = false;

/**
 * Answer the watch's requests in Local mode (watch-relay.js). Listening in
 * any native mode costs nothing: a phone connected to a server answers that
 * the watch should pair again, which it does with the server's address.
 */
export function serveWatch() {
  if (!isNative || _serving) return;
  _serving = true;
  try {
    WearPairing.addListener('watchRequest', async (req) => {
      let out;
      try {
        const { CtApiNative } = await import('./api-native.js');
        out = await answerWatchRequest(req, { localMode: isLocalMode(), api: CtApiNative });
      } catch (e) {
        out = { status: 500, body: JSON.stringify({ error: e?.message || 'The phone could not answer' }) };
      }
      try { await WearPairing.answer({ id: String(req?.id || ''), status: out.status, body: out.body }); } catch { /* the watch gave up */ }
      // The pages on show read again, as after a sync (sync-refresh.js).
      if (out.changed) {
        try { window.dispatchEvent(new CustomEvent('ct:sync-complete', { detail: { ok: true, changed: 1, kinds: out.changed } })); } catch { /* no window */ }
      }
    });
  } catch { /* no watch here */ }
}

/**
 * Keep the app awake for the watch while it's off screen (on), or not (off).
 * Local mode only, and only with a watch connected or used lately.
 */
export async function keepAwakeForWatch(on) {
  if (!isNative) return;
  try {
    if (on && isLocalMode()) await WearPairing.keepAwake({ on: true, title: 'CookTrace', text: get(_)('watch.keep_awake_text') });
    else await WearPairing.keepAwake({ on: false });
  } catch { /* no watch here */ }
}

/** Signed out: the watch shouldn't keep a working token. */
export async function unpairWatch() {
  if (!isNative) return false;
  try {
    await WearPairing.unpair();
    return true;
  } catch {
    return false;
  }
}
