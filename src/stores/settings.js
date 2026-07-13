import { writable, get, derived } from 'svelte/store';
import { DB } from '../lib/db.js';

const _dlog = import.meta.env.DEV
  ? console.log
  : (...a) => { try { if (localStorage.getItem('ct:verboseLogging') === '1') console.log(...a); } catch {} };

// ── Settings categorization ────────────────────────────────────────────────
//
// USER_PREFS — synced to server, travel with the user across devices.
// DEVICE_PREFS — local-only, never synced.
// SERVER_ADMIN — server-only (filtered in server/lib/server-only-keys.js).
//
export const USER_PREFS = new Set([
  // Locale + display
  'language','accentColor','pageBanners','bannerStyle','bannerAnimation','startPage',
  'dateFormat','timeFormat','timezone',
  // Cooking prefs (used by CookTrace features as they ship)
  'measurementSystem',         // 'metric' | 'imperial' — physical units only
  'energyUnit',                // 'kcal' | 'kJ' — separate from measurementSystem (AU/NZ
                               // are metric+kJ but UK/EU/Canada are metric+kcal)
  'defaultServings',           // number
  'dietaryPrefs',              // string[] (e.g. ['vegetarian','gluten-free'])
  'allergens',                 // string[]
  'visibleNutriments',         // string[] of nutriment ids shown in the FDA box
  'customUnits',               // string[] of user-defined unit abbreviations
  // NutriTrace federation (Phase 2)
  'ntInstanceUrl','ntInstanceToken','ntFederationEnabled','ntConnectionVerified',
  // AI Assistant ("Trace" persona)
  'aiEnabled','aiProvider','aiApiKey','aiModel','aiBaseUrl','aiAssistantName','aiKeyVerified',
  // CookTrace-only mascot flourish: render the same animated TraceFace
  // with a chef hat layered on top everywhere it appears.
  'traceChefHat',
  // Smart Log (hold-to-record on the FAB → AI parses spoken intent → tool execution)
  'smartLogEnabled',
  // URL Import Engine — 'standard' | 'enhanced' (recipe-scrapers) | 'smart' (AI)
  'urlImportEngine','urlImportFallback',
  // Pantry view mode — 'grid' (default photo cards) | 'list' (compact rows)
  'pantryView',
  // Shopping list grouping — 'aisle' (default) | 'recipe' | 'flat'
  'shoppingGroupBy',
  // What happens to items after check — 'bottom' (default, sink to end
  // of group) | 'hide' (soft-remove until Show Checked toggled)
  'shoppingCheckedBehavior',
  // When true, recipes shared with the user (via a Kitchen or a
  // direct grant) also appear in the main Recipes list alongside
  // their own, badged so ownership is still clear. Off by default —
  // the Shared tab stays as the canonical view for "not mine but
  // I can cook from it". Users who prefer Mealie's one-pool feel
  // flip this on.
  'mixSharedIntoRecipes',
  // When true (default false), saving a recipe whose ingredients aren't
  // already linked to a pantry row will auto-create a pantry row by
  // ingredient name. Off by default — typing "flour" shouldn't silently
  // populate the pantry catalog. Users opt in to grow their pantry as
  // they cook.
  'autoCreatePantryFromRecipes',
  // Active kitchen for users with multiple memberships
  'currentKitchenId',
  // Notifications
  'notifLocalEnabled','notifPushService',
  'appriseUrl','appriseTag','gotifyUrl','gotifyToken','ntfyUrl','ntfyTopic','ntfyToken',
  // Pantry expiration digest. Enable ships a once-a-day roll-up of
  // items expiring within the user-picked window; keeps the delivery
  // channel(s) consistent with every other reminder (local + configured
  // push service).
  'notifExpiryEnabled','notifExpiryDaysBefore','notifExpiryTime',
  // Open Food Facts. Search prefs + contribution credentials.
  'offEnabled','offSearchLanguage','offSearchCountry',
  'offUsername','offPassword','offUploadCountry',
  // USDA FoodData Central.
  'usdaEnabled','usdaApiKey',
  // Barcode scanner preferences (matches NT key names).
  'barcodeBeep','barcodeFlashlight',
]);

export const DEVICE_PREFS = new Set([
  'appearance','navStyle','sidebarPersistent','disableAnimations',
  'biometricLoginEnabled', // Android-only, per-device biometric unlock for sign-in
]);

const SERVER_SETTINGS = USER_PREFS;

import { isNative, getServerUrl, getAuthToken, apiUrl } from '../lib/platform.js';

function _settingsUrl() { return apiUrl('/api/settings'); }

function _authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (isNative && getServerUrl()) {
    const token = getAuthToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
  } else if (!isNative) {
    const csrf = localStorage.getItem('ct:csrf');
    if (csrf) h['X-CSRF-Token'] = csrf;
  }
  return h;
}

const _saveQueue = {};
const _recentlyChanged = new Map();
export function isRecentlyChanged(key) {
  const ts = _recentlyChanged.get(key);
  return ts && Date.now() - ts < 10000;
}
let _suppressSync = false;

export function _applySetting(key, value) {
  _suppressSync = true;
  DB.setSetting(key, value);
  _suppressSync = false;
}

function _isLoggedIn() { return !!localStorage.getItem('wl:userId'); }
function _shouldSyncToServer() { return _isLoggedIn() && !(isNative && !getServerUrl()); }

export function scheduleSave(key, value) {
  if (!SERVER_SETTINGS.has(key)) return;
  if (_suppressSync) return;
  clearTimeout(_saveQueue[key]);
  _saveQueue[key] = setTimeout(async () => {
    if (!_shouldSyncToServer()) return;
    try {
      const url = _settingsUrl();
      _dlog(`[settings] pushing ${key}=${JSON.stringify(value)} to ${url}`);
      const res = await fetch(url, {
        method: 'PUT',
        credentials: 'include',
        headers: _authHeaders(),
        body: JSON.stringify({ key, value }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      if (isNative) {
        try {
          const { dbMarkSettingsSynced } = await import('../lib/db-native.js');
          await dbMarkSettingsSynced([key]);
        } catch {}
      }
    } catch (e) {
      console.warn(`[settings] direct push failed for ${key}:`, e.message);
    }
  }, 600);
}

export async function bulkSet(settingsObj) {
  if (!settingsObj || typeof settingsObj !== 'object') return;
  const entries = Object.entries(settingsObj);
  if (entries.length === 0) return;
  const userPrefEntries = entries.filter(([k]) => USER_PREFS.has(k));

  _suppressSync = true;
  try {
    for (const [key, value] of entries) DB.setSetting(key, value);
  } finally { _suppressSync = false; }

  if (isNative && userPrefEntries.length > 0) {
    try {
      const { dbUpsertSetting } = await import('../lib/db-native.js');
      for (const [key, value] of userPrefEntries) await dbUpsertSetting(key, value);
    } catch (e) {
      console.warn('[settings] bulk native upsert failed:', e.message);
    }
  }

  if (!_shouldSyncToServer() || userPrefEntries.length === 0) return;
  try {
    const url = _settingsUrl() + '/bulk';
    const bulkObj = Object.fromEntries(userPrefEntries);
    const res = await fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: _authHeaders(),
      body: JSON.stringify({ settings: bulkObj }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    if (isNative) {
      try {
        const { dbMarkSettingsSynced } = await import('../lib/db-native.js');
        await dbMarkSettingsSynced(userPrefEntries.map(([k]) => k));
      } catch {}
    }
  } catch (e) {
    console.warn('[settings] bulk push failed:', e.message);
  }
}

export async function loadServerSettings() {
  if (!_shouldSyncToServer()) return;
  try {
    const res = await fetch(_settingsUrl(), { credentials: 'include', headers: _authHeaders(), signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const serverSettings = await res.json();
    _suppressSync = true;
    // CRITICAL: skip DEVICE_PREFS keys. These are local-only (form-factor
    // or hardware specific) and should never be overwritten by server
    // values. Stale rows can exist from before the device-pref filter
    // was added on the write path — without this filter every settings
    // poll would overwrite a tablet's `sidebarPersistent: true` with a
    // phone's `false` and the persistent-sidebar toggle would silently
    // turn off mid-session.
    for (const [key, value] of Object.entries(serverSettings)) {
      if (DEVICE_PREFS.has(key)) continue;
      DB.setSetting(key, value, true);
    }
    if (isNative) {
      try {
        const { dbUpsertSetting, dbMarkSettingsSynced } = await import('../lib/db-native.js');
        const keys = [];
        // Same DEVICE_PREFS skip as the localStorage loop above.
        for (const [key, value] of Object.entries(serverSettings)) {
          if (DEVICE_PREFS.has(key)) continue;
          await dbUpsertSetting(key, value);
          keys.push(key);
        }
        if (keys.length) await dbMarkSettingsSynced(keys);
      } catch (e) {
        console.warn('[settings] native SQLite mirror failed:', e.message);
      }
    }
    _suppressSync = false;

    try {
      if (typeof window !== 'undefined') {
        const accent = DB.getSetting('accentColor', 'mint');
        const appearanceVal = DB.getSetting('appearance', 'system');
        applyAccentColor(accent);
        applyAppearance(appearanceVal);
      }
    } catch {}
  } catch { _suppressSync = false; }
}

// Global wl:setting listener — catches direct DB.setSetting() calls and
// pushes USER_PREFS keys to server. Mirrors the NutriTrace pattern.
if (typeof window !== 'undefined') {
  window.addEventListener('wl:setting', (e) => {
    const key = e.detail?.key;
    if (!key) return;
    if (!USER_PREFS.has(key)) return;
    if (_suppressSync) return;
    const value = DB.getSetting(key, undefined);
    _recentlyChanged.set(key, Date.now());
    if (isNative) {
      import('../lib/db-native.js').then(({ dbUpsertSetting }) => dbUpsertSetting(key, value)).catch(() => {});
    }
    scheduleSave(key, value);
  });
}

function createSettingStore(key, defaultValue) {
  const store = writable(DB.getSetting(key, defaultValue));

  window.addEventListener('wl:setting', (e) => {
    if (e.detail && e.detail.key === key) {
      const next = DB.getSetting(key, defaultValue);
      const prev = get(store);
      if (JSON.stringify(prev) !== JSON.stringify(next)) store.set(next);
    }
  });

  return {
    subscribe: store.subscribe,
    set(value) {
      const current = DB.getSetting(key, defaultValue);
      if (JSON.stringify(current) === JSON.stringify(value)) {
        store.set(value);
        return;
      }
      DB.setSetting(key, value);
      store.set(value);
      if (_suppressSync) return;
      _recentlyChanged.set(key, Date.now());
      if (isNative && SERVER_SETTINGS.has(key)) {
        import('../lib/db-native.js').then(({ dbUpsertSetting }) => dbUpsertSetting(key, value)).catch(() => {});
      }
      scheduleSave(key, value);
    },
    update(fn) {
      const current = DB.getSetting(key, defaultValue);
      this.set(fn(current));
    },
    get() { return get(store); }
  };
}

// ── Device prefs (local-only) ──────────────────────────────────────────────
export const appearance        = createSettingStore('appearance',        'system');
export const navStyle          = createSettingStore('navStyle',          'both');
export const sidebarPersistent = createSettingStore('sidebarPersistent', false);
export const disableAnimations = createSettingStore('disableAnimations', false);
export const biometricLoginEnabled = createSettingStore('biometricLoginEnabled', false);

// ── User prefs (server-synced) ─────────────────────────────────────────────
export const language    = createSettingStore('language',    'en');
export const accentColor = createSettingStore('accentColor', 'mint');
// Page banners — three styles:
//   'animated' = tall header with the page's illustrated SVG
//   'gradient' = compact header filled with the active accent gradient (default)
//   'off'      = compact header, no decoration
// `pageBanners` is kept as a derived alias so existing call sites (route
// has-banner class, padding maths) continue to mean "show the tall illustrated
// header layout" — true ONLY for 'animated'.
//
// Migration matrix:
//   - Saved bannerStyle → keep the explicit pick (any return user who's been
//     in Settings → Appearance since the gradient setting shipped).
//   - Legacy pageBanners=false → 'off' (user explicitly hid banners; respect it).
//   - Anything else (including the legacy default pageBanners=true) → 'gradient',
//     since the prior 'true' default was never an explicit "I want the
//     illustrated banner" choice. Resolved value is persisted so subsequent
//     boots short-circuit to the saved-pick path.
function _migrateBannerStyle() {
  const saved = DB.getSetting('bannerStyle', null);
  if (saved != null) return saved;
  // Legacy pageBanners=false → 'off' (respect explicit opt-out).
  // Anything else → 'animated' (preserve the existing-user experience).
  // New users completing the Wizard get 'gradient' written into their
  // settings batch by finish() — that's a 100%-reliable "this is a new
  // install" signal that doesn't require scraping localStorage. Mirrors
  // LiftTrace d24bed5.
  if (DB.getSetting('pageBanners', true) === false) return 'off';
  return 'animated';
}
export const bannerStyle = createSettingStore('bannerStyle', _migrateBannerStyle());
// pageBanners is now a legacy derived alias. Illustrated SVG banners were
// retired (mirrors LiftTrace's banner rebuild). Kept around as
// `bannerStyle !== 'off'` for any downstream code still importing it.
export const pageBanners = derived(bannerStyle, $s => $s !== 'off');
// bannerAnimation picks which CSS animation applies when bannerStyle is
// 'animated'. Four styles: 'shimmer' (default), 'drift', 'pulse', 'aurora'.
export const bannerAnimation = createSettingStore('bannerAnimation', 'shimmer');
export const startPage   = createSettingStore('startPage',   '/');
export const dateFormat  = createSettingStore('dateFormat',  'US');
export const timeFormat  = createSettingStore('timeFormat',  '12h');
export const timezone    = createSettingStore('timezone',    '');

// Cooking prefs
export const measurementSystem = createSettingStore('measurementSystem', 'imperial');
export const defaultServings   = createSettingStore('defaultServings',   2);

// Recipes list sort. Mirrors NutriTrace's per-list sort settings (food /
// meal / recipe), but adapted to CookTrace's signals:
//   'fav-alpha' — favorites first, then alphabetical (default)
//   'alpha'     — straight alphabetical
//   'recent'    — last_cooked_at desc, never-cooked at the bottom alphabetical
//   'most'      — cook_count desc, ties alphabetical
//   'newest'    — created_at desc (most recently added first)
export const recipesSort = createSettingStore('recipesSort', 'fav-alpha');

// Pantry view mode — 'grid' = default photo-card grid, 'list' = compact
// row-per-item layout for users with very large catalogs who want to
// scan more density per screen.
export const pantryView = createSettingStore('pantryView', 'grid');
export const shoppingGroupBy         = createSettingStore('shoppingGroupBy',         'aisle');
export const shoppingCheckedBehavior = createSettingStore('shoppingCheckedBehavior', 'bottom');
export const mixSharedIntoRecipes    = createSettingStore('mixSharedIntoRecipes',    false);

// Auto-create pantry rows when saving a recipe whose ingredients
// aren't already linked. Off by default — typing "flour" in a recipe
// editor shouldn't silently grow the pantry catalog with rows that
// don't carry brand / nutrition / stock. Users can flip this on if
// they want the catalog to grow organically as they cook.
export const autoCreatePantryFromRecipes = createSettingStore('autoCreatePantryFromRecipes', false);

// Energy unit is independent from measurementSystem. Most metric countries
// (UK / EU / Canada) still use kcal — AU + NZ are the kJ outliers. So both
// systems default to kcal and the user flips the kJ toggle if they want it.
// Stored nutrition values always stay in kcal; the unit is presentation-only.
export const energyUnit = createSettingStore('energyUnit', 'kcal');
export const dietaryPrefs      = createSettingStore('dietaryPrefs',      []);
export const allergens         = createSettingStore('allergens',         []);
// Nutrition + units customization. visibleNutriments default = `null` so
// consumers fall back to DEFAULT_VISIBLE_NUTRIMENT_IDS — that lets us add
// new defaults later without users who never customized losing them.
export const visibleNutriments = createSettingStore('visibleNutriments', null);
export const customUnits       = createSettingStore('customUnits',       []);

// NutriTrace federation (used in Phase 2)
export const ntInstanceUrl       = createSettingStore('ntInstanceUrl',       '');
export const ntInstanceToken     = createSettingStore('ntInstanceToken',     '');
export const ntFederationEnabled = createSettingStore('ntFederationEnabled', false);
// Persists across navigation so the green Connected pill in
// SettingsFederation survives leaving Settings and coming back. Set true
// on a successful /api/nt/test, cleared by any URL/token edit or a
// failed re-test. Mirrors aiKeyVerified in shape.
export const ntConnectionVerified = createSettingStore('ntConnectionVerified', false);

// AI Assistant ("Trace" persona)
export const aiEnabled       = createSettingStore('aiEnabled',       false);
// Server-driven env-lock state. Populated from /api/app-config/env-locks
// at app startup. Mirrors NutriTrace #36 fix so AI_ENABLED=true in env
// actually enables the assistant.
export const envLocks = writable({ smtp: false, ai: false, ai_enabled: false, oidc_provider_ids: [] });
export const aiEffectivelyEnabled = derived(
  [aiEnabled, envLocks],
  ([$aiEnabled, $envLocks]) => !!$aiEnabled || (!!$envLocks.ai && !!$envLocks.ai_enabled)
);
export const aiProvider      = createSettingStore('aiProvider',      'claude');
export const aiApiKey        = createSettingStore('aiApiKey',        '');
export const aiModel         = createSettingStore('aiModel',         '');
export const aiBaseUrl       = createSettingStore('aiBaseUrl',       '');
export const aiAssistantName = createSettingStore('aiAssistantName', 'Trace');
// True after a successful "Test" in Settings → Trace. The Trace FAB
// only shows when this flips on (or when the AI is env-locked, since
// the admin has already validated the key). Cleared whenever the user
// changes provider / api key / model / base URL so they can't sail
// past a stale "verified" status.
export const aiKeyVerified  = createSettingStore('aiKeyVerified',  false);
// Optional chef-hat flourish on the TraceFace mascot. Off by default;
// when on, every TraceFace render in CookTrace gets a chef hat layered
// on top while the underlying SVG stays identical to the cross-app
// shared face (NutriTrace + LiftTrace).
export const traceChefHat   = createSettingStore('traceChefHat',   false);
// Smart Log: hold-to-record on the FAB → AI parses spoken intent →
// runs tools (cook a recipe, add to pantry, log to diary, etc.).
// Defaults off; user enables explicitly in Settings → Trace.
export const smartLogEnabled = createSettingStore('smartLogEnabled', false);

// URL Import Engine — which parser tier the scrape route tries first.
// 'standard' = JSON-LD only (always works, ~85% of sites)
// 'enhanced' = recipe-scrapers Python tier (server only, ~99%)
// 'smart'    = AI fallback (cost in tokens, handles weird HTML)
export const urlImportEngine   = createSettingStore('urlImportEngine',   'standard');
export const urlImportFallback = createSettingStore('urlImportFallback', 'standard');

// Active kitchen — null/0 = personal scope, otherwise a kitchens.id.
// Lets users with multiple memberships pick which kitchen they're
// currently cooking out of (governs recipe / pantry / shopping
// visibility client-side; server still honours per-user grants).
export const currentKitchenId = createSettingStore('currentKitchenId', null);

// Notifications
export const notifLocalEnabled = createSettingStore('notifLocalEnabled', true);
export const notifPushService  = createSettingStore('notifPushService',  'none');
// Pantry expiration digest. daysBefore covers the window "expiring
// within N days" that gets rolled into one push per day. Off by
// default so a fresh install never spams. notifExpiryTime is a
// server-local HH:MM string (server has no reliable per-user timezone
// yet) picked by TimePicker in Settings.
export const notifExpiryEnabled     = createSettingStore('notifExpiryEnabled',     false);
export const notifExpiryDaysBefore  = createSettingStore('notifExpiryDaysBefore',  3);
export const notifExpiryTime        = createSettingStore('notifExpiryTime',        '09:00');
export const appriseUrl  = createSettingStore('appriseUrl',  '');
export const appriseTag  = createSettingStore('appriseTag',  '');
export const gotifyUrl   = createSettingStore('gotifyUrl',   '');
export const gotifyToken = createSettingStore('gotifyToken', '');
export const ntfyUrl     = createSettingStore('ntfyUrl',     'https://ntfy.sh');
export const ntfyTopic   = createSettingStore('ntfyTopic',   '');
export const ntfyToken   = createSettingStore('ntfyToken',   '');

// Open Food Facts integration (parity with NutriTrace's foods area).
// `offEnabled` gates the Refresh-from-OFF / Share-to-OFF buttons in
// the pantry editor + barcode-scanner search-bar in the pantry list.
export const offEnabled        = createSettingStore('offEnabled',        true);
export const offSearchLanguage = createSettingStore('offSearchLanguage', 'en');
export const offSearchCountry  = createSettingStore('offSearchCountry',  'World');
export const offUploadCountry  = createSettingStore('offUploadCountry',  'Auto');
export const offUsername       = createSettingStore('offUsername',       '');
export const offPassword       = createSettingStore('offPassword',       '');

// USDA FoodData Central — opt-in (requires a free API key).
export const usdaEnabled = createSettingStore('usdaEnabled', false);
export const usdaApiKey  = createSettingStore('usdaApiKey',  '');

// Barcode scanner — beep on detect (per-user preference), flashlight
// override (form-factor specific but kept on USER_PREFS to mirror NT).
export const barcodeBeep       = createSettingStore('barcodeBeep',       true);
export const barcodeFlashlight = createSettingStore('barcodeFlashlight', false);

// Local-mode scheduled backup. Per-device localStorage (no server in
// local mode). Tick runs JS-side via local-backup-scheduler.js while the
// app is open. Mirrors NutriTrace's same-named keys for TraceApps parity.
export const localBackupSchedule  = createSettingStore('localBackupSchedule',  'off');
export const localBackupTime      = createSettingStore('localBackupTime',      '03:00');
export const localBackupRetention = createSettingStore('localBackupRetention', 7);
export const localBackupLastRun   = createSettingStore('localBackupLastRun',   null);
export const localBackupLastError = createSettingStore('localBackupLastError', null);

// ── Apply helpers ──────────────────────────────────────────────────────────
let _lastAppliedAccent = null;
export function applyAccentColor(value) {
  if (value === _lastAppliedAccent) {
    accentColor.set(value);
    return;
  }
  _lastAppliedAccent = value;
  const isHex = /^#[0-9a-fA-F]{6}$/.test(value);
  ['--accent','--accent-2','--accent-dim','--accent-text'].forEach(v =>
    document.documentElement.style.removeProperty(v));
  if (value === 'mint') {
    document.documentElement.removeAttribute('data-accent');
  } else if (isHex) {
    document.documentElement.removeAttribute('data-accent');
    const r = parseInt(value.slice(1,3), 16);
    const g = parseInt(value.slice(3,5), 16);
    const b = parseInt(value.slice(5,7), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    document.documentElement.style.setProperty('--accent',      value);
    document.documentElement.style.setProperty('--accent-2',    value);
    document.documentElement.style.setProperty('--accent-dim',  `rgba(${r},${g},${b},0.15)`);
    document.documentElement.style.setProperty('--accent-text', lum > 0.55 ? '#0A0B0F' : '#FFFFFF');
  } else {
    document.documentElement.setAttribute('data-accent', value);
  }
  accentColor.set(value);
}

let _lastAppliedAppearance = null;
export function applyAppearance(value) {
  if (value === _lastAppliedAppearance) {
    appearance.set(value);
    return;
  }
  _lastAppliedAppearance = value;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = value === 'dark' || (value === 'system' && prefersDark);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const meta = document.getElementById('theme-color-meta');
  if (meta) meta.content = dark ? '#0A0B0F' : '#F5F7FA';
  appearance.set(value);
}
