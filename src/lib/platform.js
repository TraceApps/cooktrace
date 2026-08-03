/**
 * platform.js — Runtime detection for Capacitor native vs web browser.
 *
 * All platform-specific branching in the app goes through this module.
 * Uses @capacitor/core for reliable detection (not window.Capacitor directly).
 */

import { Capacitor } from '@capacitor/core';

/**
 * True when running inside the Capacitor native shell (Android / iOS).
 * False in the browser (PWA, desktop).
 */
export const isNative = Capacitor.isNativePlatform();

/**
 * Server-injected base path (when CookTrace is mounted at a subpath via
 * BASE_URL env var, e.g. `/cooktrace`). Empty string when running at root,
 * or in native where API calls go through getServerUrl() which already
 * carries any path component the user configured.
 */
const _basePath = (typeof window !== 'undefined' && window.__CT_CONFIG__ && window.__CT_CONFIG__.basePath) || '';


/**
 * Native setup mode: 'local' | 'server' | null (not yet chosen).
 * Set during the Android onboarding wizard.
 */
export function getNativeMode() {
  if (!isNative) return null;
  return localStorage.getItem('ct:nativeMode') || null;
}

export function setNativeMode(mode) {
  if (mode) {
    localStorage.setItem('ct:nativeMode', mode);
  } else {
    localStorage.removeItem('ct:nativeMode');
  }
}

/**
 * The server URL to use for sync.
 * In web mode: always same-origin (relative URLs).
 * In native mode: read from localStorage, or null (standalone / offline-first).
 */
export function getServerUrl() {
  if (!isNative) return ''; // relative URLs — same origin
  return localStorage.getItem('ct:serverUrl') || null;
}

/**
 * Save the server URL for native sync mode.
 * Pass null to revert to standalone (offline-only) mode.
 */
export function setServerUrl(url) {
  if (url) {
    const clean = url.replace(/\/$/, '');
    localStorage.setItem('ct:serverUrl', clean);
    // Keep a copy for image cache lookups even after disconnecting
    localStorage.setItem('ct:lastServerUrl', clean);
  } else {
    localStorage.removeItem('ct:serverUrl');
    // Don't remove lastServerUrl — needed for cached image resolution
  }
}


/**
 * True when running native but setup hasn't been completed yet.
 */
export function needsNativeSetup() {
  return isNative && !getNativeMode();
}

/** Store the JWT token for native server mode (used in Authorization header) */
export function setAuthToken(token) {
  if (token) localStorage.setItem('ct:authToken', token);
  else localStorage.removeItem('ct:authToken');
}

export function getAuthToken() {
  return localStorage.getItem('ct:authToken') || null;
}

/**
 * Translate a connect-server error into something the user can act on.
 * Release-signed Android APKs ship with a strict network_security_config
 * that blocks cleartext (http://) traffic — the WebView and CapacitorHttp
 * surface this as a generic network error or "ERR_CLEARTEXT_NOT_PERMITTED".
 * If the user typed an http:// URL, point them at the HTTPS setup docs
 * instead of leaving them staring at a generic failure.
 */
export function explainConnectError(rawError, serverUrl) {
  const msg = (rawError?.message || String(rawError) || '').toLowerCase();
  const isHttp = typeof serverUrl === 'string' && serverUrl.toLowerCase().startsWith('http://');
  const looksLikeCleartextBlock =
    msg.includes('cleartext') ||
    msg.includes('err_cleartext') ||
    (isNative && isHttp && (msg.includes('network') || msg.includes('not reachable') || msg.includes('failed to fetch')));
  if (isHttp && looksLikeCleartextBlock) {
    return 'This build only allows HTTPS connections. Set up a reverse proxy (Caddy, Tailscale, Cloudflare Tunnel) or install a debug APK. See DEPLOY.md → Connecting from Android.';
  }
  if (isHttp && isNative) {
    // Plain http on native — even if it succeeded, surface the warning so
    // users on debug builds know release builds will reject this URL.
    return rawError?.message || 'Could not reach server';
  }
  return rawError?.message || 'Could not reach server';
}

/**
 * In-memory image cache map: server URL → local file URI.
 * Populated during sync by loadImageMap(). Used by resolveAssetUrl() synchronously.
 */
let _imageMap = {};

/** Load the image map from local DB into memory (call once on sync init).
 *  Honors image_cache_version (NT #61 port): if the stored version differs
 *  from the current code, the cached map is treated as empty because old
 *  keys pointed at filenames that may have collided across products. The
 *  next cacheAllImages() run rebuilds the map with collision-safe keys. */
export async function loadImageMap() {
  if (!isNative) return;
  try {
    const { getDb } = await import('./db-native.js');
    const db = await getDb();
    // Must stay in sync with CACHE_VERSION in image-cache.js. Inlined as a
    // small magic number to avoid creating a cross-file import just for
    // this one constant; only image-cache.js writes it.
    const IMAGE_CACHE_VERSION = 3;
    const vr = await db.query(`SELECT value FROM sync_meta WHERE key = 'image_cache_version'`, []);
    const storedVersion = parseInt(vr?.values?.[0]?.value || '1', 10);
    if (storedVersion !== IMAGE_CACHE_VERSION) { _imageMap = {}; return; }
    const r = await db.query(`SELECT value FROM sync_meta WHERE key = 'image_map'`, []);
    const row = r?.values?.[0];
    if (row?.value) _imageMap = JSON.parse(row.value);
  } catch {}
}

/** Update the in-memory image map (called after image cache downloads) */
export function setImageMap(map) {
  _imageMap = map || {};
}

/**
 * Resolve a relative URL (e.g. /uploads/photo.jpg) to an absolute URL
 * when in native server mode. Checks local image cache first for offline support.
 * On web, returns the path unchanged.
 */
/**
 * Version-busted URL for one of the app's icon PNGs. Browsers cache
 * these hard by URL and won't refetch when the file changes underneath
 * them; appending ?v=<version> makes each dev bump a new URL so a
 * shipped icon fix is actually visible without cache-clearing.
 */
export function iconUrl(path) {
  const resolved = resolveAssetUrl(path);
  if (!resolved) return resolved;
  if (resolved.startsWith('data:') || resolved.includes('?')) return resolved;
  const v = (typeof window !== 'undefined' && window.__APP_VERSION__) || 'dev';
  return `${resolved}?v=${encodeURIComponent(v)}`;
}

// WebView's own origin — historically https://localhost, now
// https://app.cooktrace.local after the hostname flip for password-
// manager identity. Resolved once at load time; any absolute URL that
// begins with this origin is already a bundled asset served from the
// APK and doesn't need further path resolution.
const _webviewOrigin = typeof window !== 'undefined' ? window.location.origin : '';

export function resolveAssetUrl(path) {
  if (!path) return path;
  if (path.startsWith('data:')) return path;
  if (_webviewOrigin && path.startsWith(_webviewOrigin)) return path;
  // Local-mode images live as file:// URIs in Capacitor's Data dir.
  // The WebView can't load file:// directly for security reasons —
  // Capacitor.convertFileSrc() rewrites them to the WebView-served
  // scheme (https://localhost/_capacitor_file_/... on Android) which
  // does load via <img src>. Fresh uploads (see api-native.uploadImage)
  // already carry the converted URL — this branch backstops entries
  // written before that change so old rows still render after the
  // upgrade.
  if (path.startsWith('file:')) {
    if (isNative && Capacitor?.convertFileSrc) {
      return Capacitor.convertFileSrc(path);
    }
    return path;
  }
  // Raw Android internal-storage path with no scheme (some Capacitor
  // versions strip the file:// prefix on Filesystem.getUri). Prefix it
  // so convertFileSrc treats it as a file URI.
  if (isNative && path.startsWith('/data/')) {
    if (Capacitor?.convertFileSrc) {
      return Capacitor.convertFileSrc('file://' + path);
    }
  }
  if (isNative) {
    // Always check local image cache first (fastest, works offline + disconnected)
    if (_imageMap[path]) return _imageMap[path];
    const url = getServerUrl() || localStorage.getItem('ct:lastServerUrl') || '';
    if (url) {
      const fullUrl = path.startsWith('http') ? path : url + path;
      if (_imageMap[fullUrl]) return _imageMap[fullUrl];
    }
    // External https URLs (recipe-site photos, NT-federation images, etc.):
    // let the WebView fetch direct. CORS doesn't apply to <img> rendering,
    // and image-cache.js downloads them via CapacitorHttp for offline use.
    // Routing every external image through /api/proxy was the previous
    // default, but that path is gated by a small IMG_ALLOWED host list on
    // the server (images.openfoodfacts.org, walmart, kroger, target, etc.)
    // — anything not in that list 403'd, which broke arbitrary recipe-site
    // hero images and NT federation pantry photos. The proxy is still
    // available; it just shouldn't be the default rendering path.
    if (path.startsWith('https://')) return path;
    // Server-hosted images
    if (url && !path.startsWith('http')) return url + path;
    if (path.startsWith('http')) return path;
  }
  // PWA: prefix server-relative paths with base path so they resolve under
  // the configured subpath instead of the document root.
  if (_basePath && (path.startsWith('/uploads/') || path.startsWith('/api/') || path.startsWith('/icons/') || path.startsWith('/fonts/'))) {
    return _basePath + path;
  }
  return path;
}

/**
 * Prefix an API path with the server URL when in native server-connected mode.
 * In native local mode, returns the path unchanged (caller intercepts to local
 * SQLite). In PWA mode, prefixes with the server-injected base path so the
 * request reaches the right place when the server is mounted at a subpath.
 */
export function apiUrl(path) {
  if (isNative) {
    const url = getServerUrl();
    if (url) return url + path; // server URL already carries any subpath the user configured
    return path; // native local — caller redirects to NtApiNative
  }
  return _basePath + path;
}
