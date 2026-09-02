/**
 * api.js — CookTrace server API.
 *
 * Three impls behind a single proxy:
 *   - HTTP (web PWA, or native + server URL)         → _CtApiHttp
 *   - Local SQLite (native standalone, no server)    → CtApiNative
 *   - Cached HTTP with local fallback (native+server) → CtApiCached
 */

import { isNative, getServerUrl, getAuthToken, resolveAssetUrl, apiUrl } from './platform.js';

// Build the auth-related headers a mutating request needs. Callers
// that bypass NtApi._fetch (multipart FormData uploads via a raw
// fetch(), like the file-import dialogs) still need Bearer on native
// AND X-CSRF-Token on PWA — dropping either produces "Invalid CSRF
// token" 403s on the PWA (issue #43) or 401s on native standalone.
// Prefer this helper over hand-rolling the pattern per call site.
function _mutatingAuthHeaders() {
  const h = {};
  if (isNative && getServerUrl()) {
    const token = getAuthToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
  } else if (!isNative) {
    const csrf = typeof localStorage !== 'undefined' ? localStorage.getItem('ct:csrf') : null;
    if (csrf) h['X-CSRF-Token'] = csrf;
  }
  return h;
}

const _CtApiHttp = {
  async _fetch(method, path, body, isUpload = false) {
    const headers = {};
    if (!isUpload) headers['Content-Type'] = 'application/json';

    if (isNative && getServerUrl()) {
      const token = getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    if (!isNative && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const csrf = localStorage.getItem('ct:csrf');
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }

    const res = await fetch(apiUrl(path), {
      method,
      headers,
      credentials: 'include',
      cache: 'no-store',
      body: isUpload ? body : body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `API error ${res.status}`);
    }
    return res.json();
  },

  get(path)         { return this._fetch('GET',    path); },
  post(path, body)  { return this._fetch('POST',   path, body); },
  put(path, body)   { return this._fetch('PUT',    path, body); },
  patch(path, body) { return this._fetch('PATCH',  path, body); },
  del(path)         { return this._fetch('DELETE', path); },

  // XHR-based POST that surfaces upload progress. fetch() can't tell
  // us how many bytes have left the device on a multipart upload, but
  // XHR's upload.onprogress can. We use this for bulk zip imports so
  // the UI can show "Uploading 42%" → "Scanning…" instead of a long
  // mystery wait.
  //
  // Also includes stall detection: if no progress event fires for
  // STALL_TIMEOUT_MS while we're still uploading, abort with a clear
  // error so the user isn't stuck staring at "Uploading 1%" forever
  // when a reverse proxy silently cut the connection.
  _postFormWithProgress(path, formData, { onProgress } = {}) {
    const STALL_TIMEOUT_MS = 45_000;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrl(path), true);
      xhr.withCredentials = true;
      // Same auth scheme as _fetch: Bearer for native+server, CSRF
      // header for cookie-authed PWA.
      if (isNative && getServerUrl()) {
        const token = getAuthToken();
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      } else if (!isNative) {
        const csrf = typeof localStorage !== 'undefined' ? localStorage.getItem('ct:csrf') : null;
        if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
      }

      let stallTimer = null;
      let uploadDone = false;
      const resetStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        if (uploadDone) return;
        stallTimer = setTimeout(() => {
          try { xhr.abort(); } catch {}
          reject(new Error(`Upload stalled — no progress in ${Math.round(STALL_TIMEOUT_MS / 1000)}s. A reverse proxy may have cut the connection (check Nginx client_max_body_size or your CDN body limits).`));
        }, STALL_TIMEOUT_MS);
      };
      resetStall();

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          try { onProgress?.({ loaded: ev.loaded, total: ev.total, percent: Math.round((ev.loaded / ev.total) * 100) }); } catch {}
        }
        resetStall();
      };
      // Once the upload finishes the server is processing — emit a
      // sentinel so the UI can switch from "Uploading" to "Scanning".
      xhr.upload.onload = () => {
        uploadDone = true;
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        try { onProgress?.({ loaded: 1, total: 1, percent: 100, uploaded: true }); } catch {}
      };
      xhr.onload = () => {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        const ct = xhr.getResponseHeader('content-type') || '';
        let body = null;
        if (/json/i.test(ct)) {
          try { body = JSON.parse(xhr.responseText); } catch {}
        }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(body ?? {});
        // Translate common proxy + server statuses into actionable messages.
        let msg = body?.error;
        if (!msg) {
          if (xhr.status === 413) msg = 'File too large for the server. The default cap is 512 MB; bump IMPORT_ZIP_MAX_MB or check your reverse-proxy body limits (Nginx client_max_body_size, Cloudflare upload cap, etc.).';
          else if (xhr.status === 502) msg = 'Server returned 502 Bad Gateway. Likely the upstream timed out reading the upload; try a smaller archive or raise proxy timeouts.';
          else if (xhr.status === 504) msg = 'Server returned 504 Gateway Timeout. The proxy gave up waiting for the upload to finish; try a smaller archive or raise proxy timeouts.';
          else if (xhr.status === 0)  msg = 'Connection closed by the network. Likely a proxy / CDN / firewall issue.';
          else msg = `API error ${xhr.status}`;
        }
        reject(new Error(msg));
      };
      xhr.onerror = () => {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        reject(new Error('Network error during upload (connection dropped or blocked).'));
      };
      xhr.onabort = () => {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        // If we already rejected via stall, this is a no-op.
        reject(new Error('Upload aborted'));
      };
      xhr.send(formData);
    });
  },

  // Image field mapping for any entity with an img_url column
  _imgFromApi(row) {
    if (!row) return null;
    const { img_url, ...rest } = row;
    return { ...rest, imgUrl: resolveAssetUrl(img_url) || '' };
  },
  _imgToApi(obj) {
    const { imgUrl, img_url, ...rest } = obj;
    return { ...rest, img_url: imgUrl || img_url || null };
  },

  // Recipes (Phase 1)
  async getRecipes()             { const r = await this.get('/api/recipes');           return r.map(x => this._imgFromApi(x)); },
  async getRecipe(id)            { return this._imgFromApi(await this.get(`/api/recipes/${id}`)); },
  async createRecipe(data)       { return this._imgFromApi(await this.post('/api/recipes', this._imgToApi(data))); },
  async updateRecipe(id, data)   { return this._imgFromApi(await this.put(`/api/recipes/${id}`, this._imgToApi(data))); },
  async markCooked(id, payload = {}) { return this._imgFromApi(await this.post(`/api/recipes/${id}/cooked`, payload)); },
  async backdateRecipe(id, createdAt) {
    const r = await this.post(`/api/recipes/${id}/backdate`, { created_at: createdAt });
    return r && r.updated === true;
  },
  async scrapeRecipe(url, opts = {}) {
    const body = {
      url,
      addToPantry: opts.addToPantry !== false,
      applyTags: !!opts.applyTags,
      importCategories: opts.importCategories !== false,
    };
    return this._imgFromApi(await this.post('/api/recipes/scrape', body));
  },
  async importRecipe({ text, file, addToPantry = true, applyTags = false, importCategories = true } = {}) {
    if (file) {
      const form = new FormData();
      form.append('file', file);
      form.append('addToPantry', addToPantry ? 'true' : 'false');
      form.append('applyTags', applyTags ? 'true' : 'false');
      form.append('importCategories', importCategories ? 'true' : 'false');
      const res = await this._fetch('POST', '/api/recipes/import', form, true);
      // Paprika archive returns { recipes, count }; single returns a row.
      if (res?.recipes) return { recipes: res.recipes.map(r => this._imgFromApi(r)), count: res.count };
      return this._imgFromApi(res);
    }
    const body = { text, addToPantry, applyTags, importCategories };
    const res = await this.post('/api/recipes/import', body);
    if (res?.recipes) return { recipes: res.recipes.map(r => this._imgFromApi(r)), count: res.count };
    return this._imgFromApi(res);
  },
  // Bulk zip import (Mealie / Tandoor / Paprika backups). Two-step:
  // scan returns a manifest the UI renders as a picker; commit writes
  // the selected subset. Same file is re-uploaded for the commit so
  // the server doesn't have to cache the buffer between calls.
  // onProgress: optional callback receiving { percent, uploaded, ... }
  // so the caller can render an upload bar + switch to a "scanning"
  // indicator once bytes have all left the device.
  async scanRecipeZip(file, { onProgress } = {}) {
    const form = new FormData();
    form.append('file', file);
    return this._postFormWithProgress('/api/recipes/import-zip/scan', form, { onProgress });
  },
  async commitRecipeZip(file, { selected = null, importImages = true, addToPantry = true, applyTags = false, importCategories = true, uploadId = null, onProgress } = {}) {
    // Cached-upload path: scan stashed the zip server-side and gave us
    // an id back. Commit becomes a tiny JSON POST instead of re-uploading
    // the whole archive (which on a 100 MB Mealie backup is a real win).
    // Falls back to the legacy multipart path if uploadId is missing or
    // the server returns 410 (cache expired / pruned).
    if (uploadId) {
      try {
        const res = await this.post('/api/recipes/import-zip/commit', {
          uploadId,
          selected,
          import_images: importImages,
          addToPantry,
          applyTags,
          importCategories,
        });
        return {
          ...res,
          recipes: Array.isArray(res?.recipes) ? res.recipes.map(r => this._imgFromApi(r)) : [],
        };
      } catch (e) {
        // Cache pruned (server restart, > 1h old) — fall through to
        // re-upload so the user doesn't have to re-pick the file.
        if (!/expired|410/i.test(e?.message || '')) throw e;
      }
    }
    const form = new FormData();
    form.append('file', file);
    if (selected) form.append('selected', JSON.stringify(selected));
    form.append('import_images', importImages ? 'true' : 'false');
    form.append('addToPantry', addToPantry ? 'true' : 'false');
    form.append('applyTags',   applyTags   ? 'true' : 'false');
    form.append('importCategories', importCategories ? 'true' : 'false');
    const res = await this._postFormWithProgress('/api/recipes/import-zip/commit', form, { onProgress });
    return {
      ...res,
      recipes: Array.isArray(res?.recipes) ? res.recipes.map(r => this._imgFromApi(r)) : [],
    };
  },

  async getCooks(id)             { return this.get(`/api/recipes/${id}/cooks`); },
  async updateCook(id, cookId, data) { return this.put(`/api/recipes/${id}/cooks/${cookId}`, data); },
  async deleteCook(recipeId, cookId) { return this.del(`/api/recipes/${recipeId}/cooks/${cookId}`); },
  deleteRecipe(id)               { return this.del(`/api/recipes/${id}`); },

  // Recipe sharing — public link tokens
  mintRecipeShareToken(id)              { return this.post(`/api/recipes/${id}/share`); },
  revokeRecipeShareToken(id)            { return this.del(`/api/recipes/${id}/share`); },

  // Recipe sharing — per-user grants
  getSharePeers()                            { return this.get('/api/recipes/peers'); },
  async getRecipesSharedWithMe() {
    const rows = await this.get('/api/recipes/shared-with-me');
    return Array.isArray(rows) ? rows.map(r => this._imgFromApi(r)) : [];
  },
  getRecipeShares(recipeId)                  { return this.get(`/api/recipes/${recipeId}/shares`); },
  shareRecipeWithUsers(recipeId, userIds)    { return this.post(`/api/recipes/${recipeId}/shares`, { user_ids: userIds }); },
  unshareRecipeWithUser(recipeId, userId)    { return this.del(`/api/recipes/${recipeId}/shares/${userId}`); },

  // Recipe categories
  getRecipeCategories()                 { return this.get('/api/recipes/categories'); },
  createRecipeCategory(data)            { return this.post('/api/recipes/categories', data); },
  updateRecipeCategory(id, data)        { return this.put(`/api/recipes/categories/${id}`, data); },
  deleteRecipeCategory(id)              { return this.del(`/api/recipes/categories/${id}`); },
  reorderRecipeCategories(ids)          { return this.put('/api/recipes/categories/order', { ids }); },

  // Recipe tag taxonomy
  getRecipeTags()                       { return this.get('/api/recipes/tags'); },
  renameRecipeTag(oldName, newName)     { return this.put(`/api/recipes/tags/${encodeURIComponent(oldName)}`, { name: newName }); },
  deleteRecipeTag(name)                 { return this.del(`/api/recipes/tags/${encodeURIComponent(name)}`); },

  // Recipe Kitchen Gear (a.k.a. tools) taxonomy
  getRecipeTools()                      { return this.get('/api/recipes/tools'); },
  renameRecipeTool(oldName, newName)    { return this.put(`/api/recipes/tools/${encodeURIComponent(oldName)}`, { name: newName }); },
  deleteRecipeTool(name)                { return this.del(`/api/recipes/tools/${encodeURIComponent(name)}`); },

  // Recipe comments
  getRecipeComments(recipeId)                  { return this.get(`/api/recipes/${recipeId}/comments`); },
  postRecipeComment(recipeId, body, parentId)  { return this.post(`/api/recipes/${recipeId}/comments`, { body, parent_id: parentId ?? null }); },
  updateRecipeComment(recipeId, id, body)      { return this.put(`/api/recipes/${recipeId}/comments/${id}`, { body }); },
  deleteRecipeComment(recipeId, id)            { return this.del(`/api/recipes/${recipeId}/comments/${id}`); },

  // Pantry categories
  getPantryCategories()                  { return this.get('/api/pantry/categories'); },
  createPantryCategory(data)             { return this.post('/api/pantry/categories', data); },
  updatePantryCategory(id, data)         { return this.put(`/api/pantry/categories/${id}`, data); },
  deletePantryCategory(id)               { return this.del(`/api/pantry/categories/${id}`); },
  reorderPantryCategories(ids)           { return this.put('/api/pantry/categories/order', { ids }); },

  // Units overlay (built-in disable + custom CRUD)
  getUnits()                             { return this.get('/api/units'); },
  toggleBuiltinUnit(abbr, disabled)      { return this.patch(`/api/units/builtin/${encodeURIComponent(abbr)}`, { disabled: !!disabled }); },
  createCustomUnit(data)                 { return this.post('/api/units', data); },
  updateCustomUnit(id, data)             { return this.put(`/api/units/${id}`, data); },
  deleteCustomUnit(id)                   { return this.del(`/api/units/${id}`); },

  // Cookbooks
  // Kitchens — multi-user soft groups for sharing
  getKitchens()                               { return this.get('/api/kitchens'); },
  createKitchen(name)                         { return this.post('/api/kitchens', { name }); },
  deleteKitchen(id)                           { return this.del(`/api/kitchens/${id}`); },
  getKitchenMembers(id)                       { return this.get(`/api/kitchens/${id}/members`); },
  addKitchenMember(id, username)              { return this.post(`/api/kitchens/${id}/members`, { username }); },
  removeKitchenMember(id, userId)             { return this.del(`/api/kitchens/${id}/members/${userId}`); },
  shareRecipeWithKitchen(kitchenId, recipeId) { return this.post(`/api/kitchens/${kitchenId}/share-recipe`, { recipe_id: recipeId }); },
  // Per-user auto-share toggle. Enabling backfills every existing
  // recipe you own to every current kitchen member. Server response
  // carries { enabled, recipes, added } so the UI can toast a
  // meaningful summary of the fanout.
  setKitchenAutoShare(kitchenId, enabled)     { return this.put(`/api/kitchens/${kitchenId}/auto-share`, { enabled }); },

  getCookbooks()                              { return this.get('/api/cookbooks'); },
  async getCookbook(id) {
    const cb = await this.get(`/api/cookbooks/${id}`);
    return { ...cb, recipes: (cb.recipes || []).map(r => this._imgFromApi(r)) };
  },
  createCookbook(data)                        { return this.post('/api/cookbooks', data); },
  updateCookbook(id, data)                    { return this.put(`/api/cookbooks/${id}`, data); },
  deleteCookbook(id)                          { return this.del(`/api/cookbooks/${id}`); },
  addRecipesToCookbook(id, recipeIds)         { return this.post(`/api/cookbooks/${id}/recipes`, { recipe_ids: recipeIds }); },
  removeRecipeFromCookbook(id, recipeId)      { return this.del(`/api/cookbooks/${id}/recipes/${recipeId}`); },
  reorderCookbookRecipes(id, recipeIds)       { return this.put(`/api/cookbooks/${id}/recipes/order`, { recipe_ids: recipeIds }); },
  reorderCookbooks(cookbookIds)               { return this.put('/api/cookbooks/order', { cookbook_ids: cookbookIds }); },
  getCookbooksForRecipe(recipeId)             { return this.get(`/api/cookbooks/by-recipe/${recipeId}`); },
  // Cookbook sharing — mirrors the recipe share API. Per-user grants
  // via /shares; kitchen fanout via /share-cookbook on the kitchens
  // resource; /shared-with-me returns cookbooks others have shared.
  getCookbooksSharedWithMe()                  { return this.get('/api/cookbooks/shared-with-me'); },
  getCookbookShares(id)                       { return this.get(`/api/cookbooks/${id}/shares`); },
  shareCookbookWithUsers(id, userIds)         { return this.post(`/api/cookbooks/${id}/shares`, { user_ids: userIds }); },
  unshareCookbookWithUser(id, userId)         { return this.del(`/api/cookbooks/${id}/shares/${userId}`); },
  shareCookbookWithKitchen(kitchenId, cookbookId) { return this.post(`/api/kitchens/${kitchenId}/share-cookbook`, { cookbook_id: cookbookId }); },

  // Pantry
  async getPantry(opts = {}) {
    const params = new URLSearchParams();
    if (opts.in_stock) params.set('in_stock', '1');
    if (opts.q) params.set('q', opts.q);
    const qs = params.toString();
    return this.get(`/api/pantry${qs ? '?' + qs : ''}`);
  },
  getPantryItem(id)              { return this.get(`/api/pantry/${id}`); },
  async getPantryItemRecipes(id) {
    const rows = await this.get(`/api/pantry/${id}/recipes`);
    return Array.isArray(rows) ? rows.map(r => this._imgFromApi(r)) : [];
  },
  async getPantryItemByBarcode(code) {
    if (!code) return null;
    try { return await this.get(`/api/pantry/by-barcode/${encodeURIComponent(code)}`); }
    catch (e) {
      if (/404|Not found/i.test(e.message || '')) return null;
      throw e;
    }
  },
  createPantryItem(data)         { return this.post('/api/pantry', data); },
  updatePantryItem(id, data)     { return this.put(`/api/pantry/${id}`, data); },
  toggleStock(id, in_stock)      { return this.patch(`/api/pantry/${id}/stock`, { in_stock }); },
  deletePantryItem(id, opts = {}) {
    const q = opts.cascade ? '?cascade=1' : '';
    return this.del(`/api/pantry/${id}${q}`);
  },

  // Cook Diary (Phase 3) — past cooks + planned cooks
  async getCookDiary(opts = {}) {
    const params = new URLSearchParams();
    if (opts.from) params.set('from', opts.from);
    if (opts.to)   params.set('to',   opts.to);
    if (opts.kind) params.set('kind', opts.kind);
    const qs = params.toString();
    return this.get(`/api/cook-diary${qs ? '?' + qs : ''}`);
  },
  getCookDiaryStats()              { return this.get('/api/cook-diary/stats'); },
  getCookDiaryHeatmap(days = 365)  { return this.get(`/api/cook-diary/heatmap?days=${days}`); },
  createDiaryEntry(data)         { return this.post('/api/cook-diary', data); },
  updateDiaryEntry(id, data)     { return this.put(`/api/cook-diary/${id}`, data); },
  deleteDiaryEntry(id)           { return this.del(`/api/cook-diary/${id}`); },

  // Shopping List (Phase 4)
  getShoppingList()              { return this.get('/api/shopping'); },
  addShoppingItem(data)          { return this.post('/api/shopping', data); },
  updateShoppingItem(id, data)   { return this.put(`/api/shopping/${id}`, data); },
  toggleShoppingChecked(id, c)   { return this.patch(`/api/shopping/${id}/check`, { checked: c }); },
  deleteShoppingItem(id)         { return this.del(`/api/shopping/${id}`); },
  clearCheckedShopping()         { return this.del('/api/shopping/checked'); },
  reorderShopping(items)         { return this.post('/api/shopping/reorder', { items }); },
  clearShoppingByRecipe(recipeId){ return this.del(`/api/shopping/by-recipe/${recipeId}`); },
  shopFromRecipe(id, opts = {})  {
    const qs = opts.only_missing === false ? '?only_missing=0' : '';
    return this.post(`/api/shopping/from-recipe/${id}${qs}`, {});
  },
  // Bulk-add the ingredients across every planned cook in a date
  // range. opts: { from, to (YYYY-MM-DD), only_missing }.
  shopFromPlan(opts = {})  {
    const p = new URLSearchParams();
    if (opts.from) p.set('from', opts.from);
    if (opts.to)   p.set('to', opts.to);
    if (opts.only_missing === false) p.set('only_missing', '0');
    const qs = p.toString();
    return this.post(`/api/shopping/from-plan${qs ? '?' + qs : ''}`, {});
  },

  // Users (sharing picker)
  getUsersList()                 { return this.get('/api/auth/users/list'); },

  // App config
  getAppConfig()                 { return this.get('/api/app-config'); },

  // Upload
  async uploadImage(file) {
    const form = new FormData();
    form.append('file', file);
    const res = await this._fetch('POST', '/api/upload', form, true);
    return res.url;
  },
};

import { CtApiNative } from './api-native.js';
import { CtApiCached } from './api-cached.js';

// Endpoints without a local mirror in CtApiNative — these are
// inherently server-scoped (Kitchens, per-user sharing peers, user
// management, app config, server-parser recipe imports). In pure
// local mode CtApiNative returns empty / no-op stubs so the UI
// guards collapse cleanly. In server-connected mode we bypass the
// stub and go straight to _CtApiHttp so a Kitchen made on the PWA
// actually appears on the phone, share peer lists reflect reality,
// and User Management admin views populate correctly.
const SERVER_ONLY_METHODS = new Set([
  'getKitchens', 'getKitchenMembers', 'createKitchen', 'deleteKitchen',
  'addKitchenMember', 'removeKitchenMember', 'shareRecipeWithKitchen',
  'setKitchenAutoShare', 'shareCookbookWithKitchen',
  'getCookbooksSharedWithMe', 'getCookbookShares',
  'shareCookbookWithUsers', 'unshareCookbookWithUser',
  'getSharePeers', 'getRecipeShares', 'shareRecipeWithUsers',
  'unshareRecipeWithUser', 'mintRecipeShareToken',
  'revokeRecipeShareToken', 'getRecipesSharedWithMe',
  'getUsersList', 'getAppConfig',
  'scanRecipeZip', 'commitRecipeZip',
  // Low-level HTTP primitives — used by components that don't have a
  // dedicated NtApi wrapper (invite list, session config, admin OIDC
  // CRUD, etc.). CtApiNative stubs these to throw in pure local mode;
  // in server-connected mode we want them to actually reach the
  // server, not blow up in try/catch and silently return empty state.
  'get', 'post', 'put', 'patch', 'del',
]);

// Smart uploadImage for native connected mode. Tries the server first so
// the returned URL is a portable /uploads/<file> path that every device
// can render. Falls back to the native local-file path when the server
// upload fails (offline, transient network error, server down) — the
// diary/recipe/pantry entry can still save with a local URL, and the
// sync engine's stale-photo pass (sync.js → _reconcileLocalPhotoUrls)
// picks it up on the next successful sync, uploads it, and rewrites
// the URL in-place.
async function _uploadImageConnected(file) {
  try {
    return await _CtApiHttp.uploadImage(file);
  } catch (e) {
    console.warn('[upload] server POST failed, saving locally for sync retry:', e?.message);
    return await CtApiNative.uploadImage(file);
  }
}

// Dynamic proxy — picks the right impl per call based on platform mode.
export const NtApi = new Proxy({}, {
  get(_, prop) {
    // Special-case uploadImage in native connected mode: server-first
    // with local fallback so photos land at portable /uploads/<file>
    // URLs that other devices can render, without breaking offline
    // photo-taking.
    if (prop === 'uploadImage' && isNative && getServerUrl()) {
      return _uploadImageConnected;
    }
    let impl;
    if (!isNative)                                             impl = _CtApiHttp;
    else if (!getServerUrl())                                  impl = CtApiNative;
    else if (SERVER_ONLY_METHODS.has(prop))                    impl = _CtApiHttp;
    else                                                       impl = CtApiCached;
    return typeof impl[prop] === 'function' ? impl[prop].bind(impl) : impl[prop];
  },
});

// Alias for the new name. Existing call sites use NtApi; new code can use CtApi.
export const CtApi = NtApi;

// Public re-export for callers that need to hand-roll a fetch() (e.g.
// multipart uploads that can't ride through NtApi._fetch). Use this
// instead of duplicating the CSRF / Bearer pattern per call site.
export const mutatingAuthHeaders = _mutatingAuthHeaders;
