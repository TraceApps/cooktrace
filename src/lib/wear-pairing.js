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
 * The cook you are in, for the watch to show: which recipe, and what has
 * been ticked off it. Pass null when the cook is over.
 */
export async function publishCook(cook, at = 0) {
  if (!isNative) return false;
  try {
    if (!cook) {
      await WearPairing.clearCook({ at: at || Date.now() });
      return true;
    }
    await WearPairing.cook({
      recipeId: Number(cook.recipeId) || 0,
      name: String(cook.name || ''),
      steps: Array.from(cook.steps || []).map(Number).filter(Number.isFinite),
      ingredients: Array.from(cook.ingredients || []).map(String),
      at: at || Date.now(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * What the watch says about the cook, when it has the later word. Returns
 * the cook to adopt, null to end one, or undefined when the phone's own
 * state is newer and nothing should change here.
 */
export async function readCook(mine = 0) {
  if (!isNative) return undefined;
  try {
    const remote = await WearPairing.readCook();
    if (!remote?.found) return undefined;
    const at = Number(remote.at || 0);
    if (at <= mine) return undefined;
    if (remote.cleared || !Number(remote.recipeId)) return null;
    return {
      recipeId: Number(remote.recipeId),
      name: String(remote.name || ''),
      steps: (remote.steps || []).map(Number).filter(Number.isFinite),
      ingredients: (remote.ingredients || []).map(String),
      at,
    };
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
