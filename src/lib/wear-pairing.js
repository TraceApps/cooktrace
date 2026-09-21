/**
 * wear-pairing.js: hand the watch app what it needs, and the cook you are in.
 *
 * The Wear app talks to CookTrace itself, so it ticks a shopping list off in
 * an aisle with no phone signal. It needs the server address and a token for
 * the signed-in account, and there is no keyboard on a watch worth typing
 * either into. The phone writes both into the Wearable Data Layer when you
 * sign in, and takes them away when you sign out.
 *
 * Pressing Cook sends the recipe over the same channel, along with what has
 * been ticked off it. Either device can tick, so each write carries a stamp
 * and the later one wins.
 *
 * Android only, and only when a watch is actually paired with this phone.
 */
import { registerPlugin } from '@capacitor/core';
import { isNative, getServerUrl, getAuthToken } from './platform.js';

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

/**
 * Send the current server and token to the watch. Safe to call often: the
 * write carries a timestamp, so a refreshed token still reaches the watch.
 */
export async function pairWatch() {
  if (!isNative) return false;
  const serverUrl = getServerUrl();
  const token = getAuthToken();
  // Local-only mode keeps everything on the phone, so there is no address for
  // the watch to call and nothing to pair. Say which of these it is: a watch
  // stuck on "pair from your phone" is otherwise a mystery from both ends,
  // and this line is the only thing that can tell you why.
  if (!serverUrl || !token) {
    console.warn('[wear] not pairing:', serverUrl ? 'signed in on this device but no token' : 'no server connected');
    return false;
  }
  if (!(await hasWatch())) {
    console.warn('[wear] not pairing: no watch is connected to this phone');
    return false;
  }
  try {
    await WearPairing.pair({ serverUrl, token });
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
