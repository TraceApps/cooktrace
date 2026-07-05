/**
 * api-cached.js — CookTrace API impl for native + server-connected mode.
 *
 * Architecture: every read hits the LOCAL SQLite database (same impl as
 * NtApiNative). Every write goes to local SQLite first (marking rows
 * sync_status='pending') and schedules a background push to the
 * server via sync.js. The result is offline-first behavior — the UI
 * never blocks on the network, and the server eventually converges.
 *
 * Bootstraps in main.js after dbInit() when isNative + getServerUrl() is
 * set. Migrates over from local-only by simply choosing this impl in
 * the api.js Proxy dispatch.
 */

import { CtApiNative } from './api-native.js';
import { fullSync, startSyncLoop } from './sync.js';

// Cheap debounce so we don't fire 50 push attempts during a bulk
// import. Last write wins; 600ms after the last write triggers a sync.
let _pushTimer = null;
function _schedulePush() {
  if (_pushTimer) clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => {
    _pushTimer = null;
    fullSync(true);
  }, 600);
}

// Wrap every NtApiNative method. Writes (anything that isn't a `get*`
// or returns a fixed-shape no-op) trigger _schedulePush() after the
// local write returns. Reads pass through untouched.
const WRITE_METHODS = new Set([
  'createRecipe', 'updateRecipe', 'deleteRecipe', 'markCooked',
  'updateCook', 'deleteCook',
  'createPantryItem', 'updatePantryItem', 'toggleStock', 'deletePantryItem',
  'createDiaryEntry', 'updateDiaryEntry', 'deleteDiaryEntry',
  'addShoppingItem', 'updateShoppingItem', 'toggleShoppingChecked',
  'deleteShoppingItem', 'clearCheckedShopping', 'reorderShopping',
  'shopFromRecipe', 'shopFromPlan',
  'createRecipeCategory', 'updateRecipeCategory', 'deleteRecipeCategory',
  'reorderRecipeCategories',
  'createPantryCategory', 'updatePantryCategory', 'deletePantryCategory',
  'reorderPantryCategories',
  'toggleBuiltinUnit', 'createCustomUnit', 'updateCustomUnit', 'deleteCustomUnit',
  'createCookbook', 'updateCookbook', 'deleteCookbook',
  'addRecipesToCookbook', 'removeRecipeFromCookbook',
  'reorderCookbooks', 'reorderCookbookRecipes',
  'postRecipeComment', 'updateRecipeComment', 'deleteRecipeComment',
  'renameRecipeTag', 'deleteRecipeTag', 'renameRecipeTool', 'deleteRecipeTool',
  'appendAiChat', 'clearAiChat',
  'uploadImage',
]);

const wrapped = {};
for (const [key, value] of Object.entries(CtApiNative)) {
  if (typeof value !== 'function') { wrapped[key] = value; continue; }
  if (WRITE_METHODS.has(key)) {
    wrapped[key] = async function (...args) {
      const r = await CtApiNative[key](...args);
      _schedulePush();
      return r;
    };
  } else {
    wrapped[key] = CtApiNative[key].bind(CtApiNative);
  }
}

// Kick off the periodic background sync the first time anything calls
// into the cached impl. Safe to call repeatedly (startSyncLoop is
// idempotent).
let _bootstrapped = false;
function _bootstrap() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  startSyncLoop();
}

export const CtApiCached = new Proxy(wrapped, {
  get(target, prop) {
    _bootstrap();
    return target[prop];
  },
});

// Alias for compatibility with the NT-style naming the proxy in api.js
// expects.
export const NtApiCached = CtApiCached;
