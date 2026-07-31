/**
 * image-cache.js — Download server images to local device storage so the
 * Android app can render them offline.
 *
 * Scans server data (recipes, pantry items, cook diary entries, user
 * avatar) for image URLs, fetches each via CapacitorHttp, writes to
 * Capacitor Filesystem under `image_cache/`, and saves the server-URL →
 * local-URI mapping in sync_meta.image_map. resolveAssetUrl() in
 * platform.js reads that map synchronously so <img src> swaps to the
 * cached file:// URI when present.
 *
 * Ported from NutriTrace src/lib/image-cache.js; CT-specific bits are
 * the entity list (recipes / pantry_items / cook_diary instead of
 * foods / meals / diary) and the localStorage cached-user key
 * (`ct:cachedUser` instead of `nt:cachedUser`).
 */

import { Filesystem, Directory } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import { getServerUrl, getAuthToken } from './platform.js';

const CACHE_DIR = 'image_cache';
// Bump when the cache key derivation changes so existing users invalidate
// their (collision-prone) imageMap once and re-download cleanly. v1 used
// the trailing filename only — colliding for OFF image URLs that all end
// with names like "front_en.4.400.jpg" across different products. Ported
// from NutriTrace #61 fix (commit 409e9a1). v2 hashes the full URL.
// Bumped to 3 on the WebView hostname flip (localhost → app.cooktrace.local).
// Cached image URLs are pre-generated via Capacitor.convertFileSrc() at
// download time, which bakes in the WebView's current authority. Old caches
// stored https://localhost/_capacitor_file_/... URLs; on the new hostname
// those paths are cross-origin and the WebView refuses to load them.
// Bumping the version invalidates every cached URL so the next sync
// re-caches them against the current hostname.
const CACHE_VERSION = 3;

/**
 * Derive a collision-safe cache filename from a full image URL. The trailing
 * URL segment alone is not unique (OFF image URLs across different products
 * share filenames like "front_en.4.400.jpg"). Hash the full URL and preserve
 * the original extension so the OS still picks up the right MIME type.
 */
function _cacheFilename(serverUrl) {
  // 32-bit FNV-1a-style fold — deterministic, cheap, no crypto dep needed.
  let h = 0;
  for (let i = 0; i < serverUrl.length; i++) {
    h = ((h << 5) - h + serverUrl.charCodeAt(i)) | 0;
  }
  const extMatch = serverUrl.match(/\.(jpe?g|png|webp|gif|bmp|avif)(?:\?|$)/i);
  const ext = (extMatch?.[1] || 'jpg').toLowerCase();
  return `${(h >>> 0).toString(36)}.${ext}`;
}

/**
 * Download a single image from the server and cache it locally.
 * Returns the local file URI (Capacitor-rewritten so the WebView can
 * load it), or null on failure.
 */
async function _downloadImage(serverUrl) {
  if (!serverUrl || !serverUrl.startsWith('http')) return null;

  const filename = _cacheFilename(serverUrl);
  if (!filename) return null;

  // Already cached → reuse.
  try {
    const existing = await Filesystem.stat({
      path: `${CACHE_DIR}/${filename}`,
      directory: Directory.Data,
    });
    if (existing.uri) return Capacitor.convertFileSrc(existing.uri);
  } catch {
    // Not cached yet — fall through to download.
  }

  try {
    // CapacitorHttp bypasses the WebView's CORS layer (regular fetch
    // would be blocked for cross-origin assets on Android).
    const { CapacitorHttp } = await import('@capacitor/core');
    const response = await CapacitorHttp.get({
      url: serverUrl,
      responseType: 'blob',
    });
    if (response.status < 200 || response.status >= 300) return null;
    const base64 = response.data;
    if (!base64) return null;

    await Filesystem.writeFile({
      path: `${CACHE_DIR}/${filename}`,
      data: base64,
      directory: Directory.Data,
      recursive: true,
    });
    const { uri } = await Filesystem.getUri({
      path: `${CACHE_DIR}/${filename}`,
      directory: Directory.Data,
    });
    return Capacitor.convertFileSrc(uri);
  } catch (e) {
    console.warn('[image-cache] download failed:', serverUrl, e?.message);
    return null;
  }
}

async function _loadImageMap() {
  try {
    const { getDb } = await import('./db-native.js');
    const db = await getDb();
    // Version gate: when CACHE_VERSION changes (NT #61 fix bumped v1→v2),
    // the old map is treated as empty so the next cacheAllImages run
    // rebuilds the map with collision-safe keys. Wipe the row from
    // sync_meta so platform.js's independent loadImageMap also sees an
    // empty map on next read; otherwise it would keep serving stale
    // (wrong-image) entries to resolveAssetUrl until the next app
    // restart. The version key is rewritten by _saveImageMap once
    // cacheAllImages repopulates the map.
    const vr = await db.query(`SELECT value FROM sync_meta WHERE key = 'image_cache_version'`, []);
    const storedVersion = parseInt(vr?.values?.[0]?.value || '1', 10);
    if (storedVersion !== CACHE_VERSION) {
      try { await db.run(`DELETE FROM sync_meta WHERE key = 'image_map'`, []); } catch {}
      return {};
    }
    const r = await db.query(`SELECT value FROM sync_meta WHERE key = 'image_map'`, []);
    const row = r?.values?.[0];
    if (row?.value) return JSON.parse(row.value);
  } catch {}
  return {};
}

async function _saveImageMap(map) {
  try {
    const { getDb } = await import('./db-native.js');
    const db = await getDb();
    await db.run(
      `INSERT INTO sync_meta (key, value) VALUES ('image_map', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(map)]
    );
    await db.run(
      `INSERT INTO sync_meta (key, value) VALUES ('image_cache_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [String(CACHE_VERSION)]
    );
  } catch {}
}

/**
 * Scan server data for image URLs and download them. Hits the SERVER
 * (not the local cache) so we have the complete set before going
 * offline. onProgress(downloaded, total) fires for UI updates.
 */
export async function cacheAllImages(onProgress) {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { total: 0, downloaded: 0, failed: 0 };

  const imageMap = await _loadImageMap();
  const token = getAuthToken();
  const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

  const urlPairs = []; // [{ relative, full }]
  function addUrl(imgUrl) {
    if (!imgUrl) return;
    // Skip already-local + data URIs.
    if (imgUrl.includes('_capacitor_file_') || imgUrl.startsWith('data:') || imgUrl.startsWith('file:')) return;
    try {
      const rel = imgUrl.startsWith('http') ? new URL(imgUrl).pathname : imgUrl;
      const full = imgUrl.startsWith('http') ? imgUrl : serverUrl + imgUrl;
      urlPairs.push({ relative: rel, full });
    } catch {
      // Invalid URL — skip
    }
  }

  // User avatar from the cached login payload.
  try {
    const cachedUser = localStorage.getItem('ct:cachedUser');
    if (cachedUser) {
      const user = JSON.parse(cachedUser);
      if (user.avatar_url) addUrl(user.avatar_url);
    }
  } catch {}

  // Recipes — hero img_url, plus any photos referenced by per-cook
  // diary rows (those come back in the cooks payload, but cook_diary
  // photos also show up in the diary list below). Server returns
  // hydrated recipes from /api/recipes.
  try {
    const recipes = await fetch(`${serverUrl}/api/recipes`, { headers }).then(r => r.json());
    if (Array.isArray(recipes)) {
      for (const r of recipes) {
        addUrl(r.img_url);
        if (r.creator_avatar_url) addUrl(r.creator_avatar_url);
      }
    }
  } catch {}

  // Pantry items — img_url on each row.
  try {
    const items = await fetch(`${serverUrl}/api/pantry`, { headers }).then(r => r.json());
    if (Array.isArray(items)) for (const p of items) addUrl(p.img_url);
  } catch {}

  // Cook diary entries — photo_url + photos[] JSON array on each row.
  try {
    const diary = await fetch(`${serverUrl}/api/cook-diary`, { headers }).then(r => r.json());
    if (Array.isArray(diary)) {
      for (const d of diary) {
        addUrl(d.photo_url);
        const photos = typeof d.photos === 'string' ? (() => { try { return JSON.parse(d.photos); } catch { return []; } })() : (d.photos || []);
        if (Array.isArray(photos)) for (const p of photos) addUrl(p);
        if (d.recipe_img_url) addUrl(d.recipe_img_url);
      }
    }
  } catch {}

  // Cookbooks — cover images.
  try {
    const cookbooks = await fetch(`${serverUrl}/api/recipes/cookbooks`, { headers }).then(r => r.json());
    if (Array.isArray(cookbooks)) for (const c of cookbooks) addUrl(c.cover_image_url);
  } catch {}

  // Dedupe + skip anything already in the map.
  const seen = new Set();
  const toDownload = urlPairs.filter(p => {
    if (seen.has(p.full)) return false;
    seen.add(p.full);
    return !imageMap[p.relative] && !imageMap[p.full];
  });
  const total = toDownload.length;
  let downloaded = 0;
  let failed = 0;

  if (onProgress) onProgress(0, total);

  for (const pair of toDownload) {
    const localUri = await _downloadImage(pair.full);
    if (localUri) {
      // Store both relative and full URL as keys so lookup works no
      // matter which form a caller passes to resolveAssetUrl().
      imageMap[pair.relative] = localUri;
      imageMap[pair.full] = localUri;
      downloaded++;
    } else {
      failed++;
    }
    if (onProgress) onProgress(downloaded + failed, total);
  }

  await _saveImageMap(imageMap);

  // Refresh the in-memory map so resolveAssetUrl picks up the new
  // entries immediately, without waiting for a page reload.
  try {
    const { setImageMap } = await import('./platform.js');
    setImageMap(imageMap);
  } catch {}

  console.log(`[image-cache] Done: ${downloaded} downloaded, ${failed} failed, ${Object.keys(imageMap).length} total cached`);
  return { total, downloaded, failed };
}
