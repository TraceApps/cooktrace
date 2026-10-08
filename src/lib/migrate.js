/**
 * migrate.js — Local → server data migration on first connect.
 *
 * Called from SettingsServerConnection.svelte when the user is leaving
 * local-only mode for a server. If local SQLite has data from prior
 * offline use, surface counts so the user picks:
 *   • upload   — push local rows to the server, server keeps its data
 *   • download — wipe local first, then let the post-reload sync pull
 *                everything down from the server
 *   • merge    — push local rows, then pull on reload (most permissive,
 *                may produce duplicates because most CookTrace tables
 *                don't have a natural unique key)
 *
 * Mirrors NutriTrace's migrate.js: counts first, real upload helper
 * that returns a per-table success/error summary, no silent .catch().
 *
 * Server endpoints used (already exist):
 *   POST /api/recipes/categories     create a recipe category
 *   POST /api/recipes                create a recipe
 *   POST /api/pantry/categories      create a pantry category
 *   POST /api/pantry                 create a pantry item
 *   POST /api/cook-diary             create a diary entry
 *   POST /api/shopping               create a shopping list item
 *   PUT  /api/settings/bulk          upsert many settings at once
 *
 * Recipes/diary/pantry don't have a natural unique key on the server,
 * so re-running upload would produce duplicates — the dialog warns.
 */

import { CapacitorHttp } from '@capacitor/core';
import { NtApi } from './api.js';
import { isNative } from './platform.js';

/**
 * Count local rows that would be uploaded. Fast — pulls from the local
 * API surface, no network. Returns `{ recipes, pantry, diary, shopping,
 * categories, settings, total }`.
 */
export async function countLocalData() {
  if (!isNative) return _empty();
  try {
    const [recipes, pantry, diary, shopping, recipeCats, pantryCats] = await Promise.all([
      NtApi.getRecipes().catch(() => []),
      NtApi.getPantry().catch(() => []),
      NtApi.getCookDiary().catch(() => []),
      NtApi.getShoppingList().catch(() => []),
      NtApi.getRecipeCategories ? NtApi.getRecipeCategories().catch(() => []) : [],
      NtApi.getPantryCategories ? NtApi.getPantryCategories().catch(() => []) : [],
    ]);

    // Settings live in localStorage under wl_u<id>_<key>. Counting those
    // keys gives a faithful "user settings" tally without leaking
    // transient keys like ct:csrf.
    let settings = 0;
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && /^wl_u\d+_/.test(k)) settings++;
      }
    }

    const categories = (recipeCats?.length || 0) + (pantryCats?.length || 0);
    const total = recipes.length + pantry.length + diary.length + shopping.length + categories + settings;

    return {
      recipes: recipes.length,
      pantry: pantry.length,
      diary: diary.length,
      shopping: shopping.length,
      categories,
      settings,
      total,
    };
  } catch (err) {
    console.warn('[migrate] countLocalData failed:', err?.message || err);
    return _empty();
  }
}

/**
 * Push every local row to the server. Caller must already have a valid
 * auth token (login completed) and the server URL. Returns
 *   `{ success: { recipes, pantry, diary, shopping, categories, settings },
 *      errors: [...], total, totalSuccess }`.
 *
 * `onProgress(stage, current, total)` fires once per row so the UI can
 * render progress. `stage` is one of: 'categories', 'recipes', 'pantry',
 * 'diary', 'shopping', 'settings'.
 */
export async function uploadLocalToServer({ serverUrl, authToken, onProgress } = {}) {
  if (!isNative)  throw new Error('uploadLocalToServer only runs on Capacitor');
  if (!serverUrl) throw new Error('Server URL required');
  if (!authToken) throw new Error('Auth token required');

  const summary = {
    success: { recipes: 0, pantry: 0, diary: 0, shopping: 0, categories: 0, settings: 0 },
    errors: [],
    total: 0,
    totalSuccess: 0,
    // The rows that went up, by table: [local id, server id]. They take
    // the server's ids when the phone connects (lib/local-account.js
    // claimForServer), so the next sync doesn't send them again.
    uploaded: {},
  };
  const went = (table, localId, created) => {
    if (localId != null && created?.id != null) (summary.uploaded[table] ||= []).push([localId, created.id]);
  };
  // A key per row (this install and the row's own id): an upload sent
  // twice, or one whose answer was lost, makes each row once on the server.
  let install = null, createKeyOf = () => undefined;
  try { ({ createKeyOf } = await import('./db-native.js')); install = await (await import('./db-native.js')).dbInstallId(); } catch { install = null; }
  const key = (table, row) => createKeyOf(install, table, row);
  const headers = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${authToken}`,
  };

  // ── Categories first so recipes/pantry items can reference them ─────────
  // Map local category_id → newly-created server category_id so the
  // recipes + pantry uploads that follow can rewrite their FK fields.
  // The account's categories on the server, by slug or name: a category
  // the phone has that the account has too is matched, never made twice.
  const _byKey = async path => {
    const list = await _request('GET', `${serverUrl}${path}`, headers).catch(() => []);
    const m = new Map();
    for (const x of Array.isArray(list) ? list : []) {
      if (x?.slug) m.set(`s:${x.slug}`, x);
      if (x?.name) m.set(`n:${String(x.name).trim().toLowerCase()}`, x);
    }
    return c => m.get(`s:${c.slug}`) || m.get(`n:${String(c.name || '').trim().toLowerCase()}`) || null;
  };
  const theirs = { recipe: await _byKey('/api/recipes/categories'), pantry: await _byKey('/api/pantry/categories') };
  const recipeCatIdMap = new Map();
  try {
    const localCats = NtApi.getRecipeCategories ? await NtApi.getRecipeCategories().catch(() => []) : [];
    for (let i = 0; i < localCats.length; i++) {
      onProgress?.('categories', i, localCats.length);
      const c = localCats[i];
      try {
        // One the account has already (the default ones every account
        // starts with, or an upload sent before): that one, not a second.
        const created = theirs.recipe(c) || await _post(`${serverUrl}/api/recipes/categories`, headers, {
          name: c.name, slug: c.slug || null, color: c.color || null,
        });
        if (created?.id) recipeCatIdMap.set(c.id, created.id);
        went('recipe_categories', c.id, created);
        summary.success.categories++;
      } catch (e) {
        summary.errors.push({ stage: 'categories', name: c.name || `cat #${c.id}`, message: e.message });
      }
    }
  } catch (e) {
    summary.errors.push({ stage: 'categories', name: '(load)', message: e.message });
  }

  const pantryCatIdMap = new Map();
  try {
    if (NtApi.getPantryCategories) {
      const localPCats = await NtApi.getPantryCategories().catch(() => []);
      for (let i = 0; i < localPCats.length; i++) {
        onProgress?.('categories', i, localPCats.length);
        const c = localPCats[i];
        try {
          const created = theirs.pantry(c) || await _post(`${serverUrl}/api/pantry/categories`, headers, {
            name: c.name, slug: c.slug || null, color: c.color || null,
          });
          if (created?.id) pantryCatIdMap.set(c.id, created.id);
          went('pantry_categories', c.id, created);
          summary.success.categories++;
        } catch (e) {
          summary.errors.push({ stage: 'categories', name: c.name || `pcat #${c.id}`, message: e.message });
        }
      }
    }
  } catch { /* non-fatal */ }

  // ── Pantry items ────────────────────────────────────────────────────────
  // Items first (recipes, the shopping list and other items point at them),
  // and every link sent as the server's id: an id from this phone's own
  // numbering would point at whatever has that id on the server. Items
  // that aren't variants go first, then their variants, then each item's
  // nutrition source, once the variant it points at is there.
  const localPantry = await NtApi.getPantry().catch(() => []);
  const pantryIdMap = new Map(); // local id -> server id
  // An ingredient's link holds this phone's id for the item (db-native.js
  // keeps them so); the server gets the id it gave that item.
  const pantryLink = raw => (raw == null || raw === '' ? null : (pantryIdMap.get(Number(raw)) ?? null));
  const pantryOrder = [
    ...localPantry.filter(p => p.generic_parent_id == null),
    ...localPantry.filter(p => p.generic_parent_id != null),
  ];
  for (let i = 0; i < pantryOrder.length; i++) {
    onProgress?.('pantry', i, pantryOrder.length);
    const p = pantryOrder[i];
    try {
      const { id, user_id, sync_status, server_id, created_at, updated_at, deleted_at,
              category_id, generic_parent_id, nutrition_source_variant_id,
              server_synced_at, server_base, edit_clock, ...rest } = p;
      const created = await _post(`${serverUrl}/api/pantry`, headers, {
        ...rest,
        client_key: key('pantry_items', p),
        category_id: category_id != null ? (pantryCatIdMap.get(category_id) ?? null) : null,
        generic_parent_id: generic_parent_id != null ? (pantryIdMap.get(generic_parent_id) ?? null) : null,
      });
      if (created?.id) pantryIdMap.set(id, created.id);
      went('pantry_items', id, created);
      summary.success.pantry++;
    } catch (e) {
      summary.errors.push({ stage: 'pantry', name: p.name || `pantry #${p.id}`, message: e.message });
    }
  }
  for (const p of localPantry) {
    const own = pantryIdMap.get(p.id);
    const source = p.nutrition_source_variant_id != null ? pantryIdMap.get(p.nutrition_source_variant_id) : null;
    if (!own || !source) continue;
    try { await _request('PUT', `${serverUrl}/api/pantry/${own}`, headers, { nutrition_source_variant_id: source }); }
    catch (e) { summary.errors.push({ stage: 'pantry', name: p.name || `pantry #${p.id}`, message: e.message }); }
  }

  // ── Recipes ───────────────────────────────────────────────────────────────
  const localRecipes = await NtApi.getRecipes().catch(() => []);
  const recipeIdMap = new Map(); // local id → server id, for diary + shopping rewire
  for (let i = 0; i < localRecipes.length; i++) {
    onProgress?.('recipes', i, localRecipes.length);
    const r = localRecipes[i];
    try {
      const { id, user_id, sync_status, server_id, created_at, updated_at, deleted_at,
              cook_count, last_cooked_at, share_token,
              category_id, ...rest } = r;
      // Ingredients linked to pantry items: the server's ids for them.
      const ingredients = Array.isArray(rest.ingredients)
        ? rest.ingredients.map(g => (g && Array.isArray(g.items)
          ? { ...g, items: g.items.map(it => (it && it.pantry_item_id != null ? { ...it, pantry_item_id: pantryLink(it.pantry_item_id) } : it)) }
          : g))
        : rest.ingredients;
      const created = await _post(`${serverUrl}/api/recipes`, headers, {
        ...rest,
        ingredients,
        client_key: key('recipes', r),
        category_id: category_id != null ? (recipeCatIdMap.get(category_id) ?? null) : null,
      });
      if (created?.id) recipeIdMap.set(id, created.id);
      went('recipes', id, created);
      summary.success.recipes++;
    } catch (e) {
      summary.errors.push({ stage: 'recipes', name: r.name || `recipe #${r.id}`, message: e.message });
    }
  }

  // ── Cook diary (rewire recipe_id to its new server id) ──────────────────
  const localDiary = await NtApi.getCookDiary().catch(() => []);
  for (let i = 0; i < localDiary.length; i++) {
    onProgress?.('diary', i, localDiary.length);
    const d = localDiary[i];
    try {
      const { id, user_id, sync_status, server_id, created_at, updated_at, deleted_at, ...rest } = d;
      const remappedRecipeId = d.recipe_id != null ? (recipeIdMap.get(d.recipe_id) ?? null) : null;
      if (d.recipe_id != null && remappedRecipeId == null) {
        summary.errors.push({ stage: 'diary', name: d.date || `diary #${d.id}`, message: 'recipe not uploaded — skipping' });
        continue;
      }
      const created = await _post(`${serverUrl}/api/cook-diary`, headers, {
        ...rest,
        client_key: key('cook_diary', d),
        recipe_id: remappedRecipeId,
      });
      went('cook_diary', id, created);
      summary.success.diary++;
    } catch (e) {
      summary.errors.push({ stage: 'diary', name: d.date || `diary #${d.id}`, message: e.message });
    }
  }

  // ── Shopping list (rewire recipe_id if present) ─────────────────────────
  const localShopping = await NtApi.getShoppingList().catch(() => []);
  for (let i = 0; i < localShopping.length; i++) {
    onProgress?.('shopping', i, localShopping.length);
    const s = localShopping[i];
    try {
      const { id, user_id, sync_status, server_id, created_at, updated_at, deleted_at, ...rest } = s;
      const remappedRecipeId = s.recipe_id != null ? (recipeIdMap.get(s.recipe_id) ?? null) : null;
      const created = await _post(`${serverUrl}/api/shopping`, headers, {
        ...rest,
        client_key: key('shopping_list', s),
        recipe_id: remappedRecipeId,
        pantry_id: s.pantry_id != null ? (pantryIdMap.get(s.pantry_id) ?? null) : null,
      });
      went('shopping_list', id, created);
      summary.success.shopping++;
    } catch (e) {
      summary.errors.push({ stage: 'shopping', name: s.name || `shop #${s.id}`, message: e.message });
    }
  }

  // ── Settings (bulk endpoint — one round-trip) ───────────────────────────
  try {
    const settings = {};
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !/^wl_u\d+_/.test(k)) continue;
        const userKey = k.replace(/^wl_u\d+_/, '');
        const raw = localStorage.getItem(k);
        let value;
        try { value = JSON.parse(raw); } catch { value = raw; }
        settings[userKey] = value;
      }
    }
    const keys = Object.keys(settings);
    if (keys.length > 0) {
      onProgress?.('settings', 0, keys.length);
      await _put(`${serverUrl}/api/settings/bulk`, headers, { settings });
      summary.success.settings += keys.length;
      onProgress?.('settings', keys.length, keys.length);
    }
  } catch (e) {
    summary.errors.push({ stage: 'settings', name: '(bulk upsert)', message: e.message });
  }

  for (const k of Object.keys(summary.success)) {
    summary.totalSuccess += summary.success[k];
    summary.total        += summary.success[k];
  }
  summary.total += summary.errors.length;
  return summary;
}

/**
 * Wipe every local row across the user-facing tables. Used by the
 * "download server to phone" path so the post-reload sync starts from
 * a clean local slate and pulls in the server's state authoritatively.
 * Returns the number of rows touched (best-effort).
 */
export async function wipeLocalData() {
  if (!isNative) return 0;
  const { getDb } = await import('./db-native.js');
  const db = await getDb();
  const tables = [
    'recipes', 'pantry_items', 'cook_diary', 'shopping_list',
    'recipe_categories', 'pantry_categories', 'cookbooks', 'recipe_cookbook_links',
    'recipe_comments', 'custom_units', 'disabled_units',
    // Deletes noted for the old server must not reach the one pulled next.
    'sync_deletes',
  ];
  let touched = 0;
  for (const t of tables) {
    try {
      const r = await db.run(`DELETE FROM ${t}`);
      touched += r?.changes?.changes || 0;
    } catch { /* table may not exist on older installs */ }
  }
  // Blow away local user-scoped settings so the server's win on reload.
  if (typeof localStorage !== 'undefined') {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /^wl_u\d+_/.test(k)) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  }
  return touched;
}

// Back-compat: the old stub exported these names; keep them so any
// existing imports compile while callers migrate to the new helpers.
export async function getLocalRowCounts() {
  const c = await countLocalData();
  return {
    recipes: c.recipes,
    pantry: c.pantry,
    cookDiary: c.diary,
    shoppingList: c.shopping,
  };
}
export async function migrateLocalToServer() {
  return { migrated: 0, skipped: 0 };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function _empty() {
  return { recipes: 0, pantry: 0, diary: 0, shopping: 0, categories: 0, settings: 0, total: 0 };
}

// CapacitorHttp bypasses WebView CORS for the external server origin.
async function _post(url, headers, body) { return _request('POST', url, headers, body); }
async function _put(url, headers, body)  { return _request('PUT',  url, headers, body); }
async function _request(method, url, headers, body) {
  const res = await CapacitorHttp.request({
    method, url, headers,
    data: body || {},
  });
  if (res.status < 200 || res.status >= 300) {
    let msg = `${method} ${url} → ${res.status}`;
    const data = typeof res.data === 'string'
      ? (() => { try { return JSON.parse(res.data); } catch { return null; } })()
      : res.data;
    if (data?.error) msg = data.error;
    throw new Error(msg);
  }
  return typeof res.data === 'string'
    ? (() => { try { return JSON.parse(res.data); } catch { return null; } })()
    : res.data;
}
