/**
 * user-state.js: what the app keeps in memory for the account signed in.
 *
 * Module stores outlive a sign-out, so the next account would see, and
 * could change or save, the last one's:
 *   - every setting store (stores/settings.js): units, AI keys, the
 *     kitchen and the rest are kept per account in storage, but each store
 *     holds the value it read last; a change still waiting to be sent is
 *     dropped;
 *   - the units overlay (stores/unitsOverlay.js): the account's custom and
 *     turned-off units;
 *   - what one page hands an editor (stores/editorState.js).
 * Cleared when the account changes and on sign-out, before anything is
 * shown. Pages keep the rest in their own state, which goes with them when
 * the sign-in screen (or the account check) replaces the app. Server-wide
 * state (user management on, feature flags, update checks) stays. Cooks
 * underway and their timers are this phone's, and go only when another
 * account's sign-in clears the copy (lib/local-account.js).
 */
export async function resetUserState() {
  await Promise.allSettled([
    import('../stores/settings.js').then(m => m.reloadSettingStores?.({ force: true })),
    import('../stores/unitsOverlay.js').then(m => m.resetUnitsOverlay?.()),
    import('../stores/editorState.js').then(m => { m.clearFoodEditorState?.(); m.clearMealEditorState?.(); }),
  ]);
}
