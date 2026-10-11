import { get } from 'svelte/store';

/**
 * Asks the server again whether this tab still has to set it up, then sends
 * the tab where it belongs. Used before sending a tab back to setup and when
 * the tab comes back into view: the first account may have been made in
 * another tab or on another device meanwhile, and then this tab belongs on
 * the sign-in screen, not on a setup that can only be refused.
 *
 * reload: refreshes the auth state (stores/auth.js loadAuthState).
 * setupRequired: the store reload() updates.
 * goWizard / goHome: where to go when setup is, or is no longer, needed.
 * Calls made while one is running share it.
 */
export function createSetupCheck({ reload, setupRequired, goWizard, goHome }) {
  let running = null;
  return function recheck() {
    if (running) return running;
    running = (async () => {
      try { await reload(); } catch { /* keep what this tab knew */ }
      if (get(setupRequired)) goWizard();
      else goHome();
    })().finally(() => { running = null; });
    return running;
  };
}
