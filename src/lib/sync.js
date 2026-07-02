/**
 * sync.js — Differential sync orchestrator for the native app in
 * server-connected mode. Pushes pending local writes to the server,
 * pulls server-side changes since the last sync, and exposes hooks
 * (resume / manual button) for the UI.
 *
 * Active ONLY when isNative + getServerUrl() returns a URL. On PWA the
 * `NtApi` HTTP impl talks directly to the server; on native + no URL
 * we're in local-only mode and nothing here runs.
 *
 * Pattern lifted from /home/papa/Documents/claude_code/nutritrace/src/lib/sync.js
 * but generalised over the CookTrace table list so adding a new table
 * doesn't require touching this file.
 */

import { writable } from 'svelte/store';
import { isNative, getServerUrl, getAuthToken, apiUrl } from './platform.js';
import {
  dbGetPendingChanges, dbGetPendingSettingsForPush,
  dbSetServerId, dbApplyPull,
  dbGetMeta, dbSetMeta, dbMarkSettingsSynced, dbMarkTableSynced,
} from './db-native.js';

let _syncInFlight = null;
let _interval = null;
const LAST_PULL_KEY = 'last_pull_at';

/** Public store the UI binds against — Settings + the connect dialog
 *  read `online`, `syncing`, `lastSync`, `error` to render their state. */
export const syncState = writable({
  syncing: false,
  phase: '',
  progress: '',
  lastSync: null,
  error: null,
  online: true,
});

export function startNetworkMonitor() {
  if (typeof window === 'undefined') return;
  const update = () => syncState.update(s => ({ ...s, online: navigator.onLine }));
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

// Try to surface a server-side error body in the thrown message so the
// "Sync error" banner shows something actionable instead of bare HTTP
// status. Falls back silently if the response can't be read or parsed.
async function _errBody(res) {
  try {
    const text = await res.text();
    if (!text) return '';
    try {
      const j = JSON.parse(text);
      return j.error || j.message || text.slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return '';
  }
}

function _headers() {
  const h = { 'Content-Type': 'application/json' };
  const tok = getAuthToken();
  if (tok) h['Authorization'] = `Bearer ${tok}`;
  return h;
}

/**
 * Handle a 401 from any sync endpoint by clearing local auth state so
 * App.svelte's reactive gate sends the user to Login. Without this,
 * an expired JWT or rotated server-side JWT_SECRET puts sync into an
 * unwinnable retry loop — the token in localStorage stays put but is
 * no longer accepted, and the user sees "Sync push failed: 401" every
 * cycle. Mirrors the same fix in NT sync.js (commit d1e8217).
 */
async function _handleSyncAuthError() {
  console.warn('[sync] received 401 — clearing local auth so the user can re-sign-in');
  try {
    const { setAuthToken } = await import('./platform.js');
    setAuthToken(null);
  } catch {}
  try { localStorage.removeItem('wl:userId'); } catch {}
  try { localStorage.removeItem('ct:cachedUser'); } catch {}
  try { localStorage.removeItem('ct:csrf'); } catch {}
  // Also wipe the biometric-saved JWT. Without this, the user retrieves a
  // stale token on next launch via biometric, hits 401 silently, and bounces
  // back to Login with no visible feedback. NT confirmed this pattern via
  // logcat 2026-06-09 (NT commit 9d33afb).
  try {
    const { clearSavedToken } = await import('./biometric.js');
    await clearSavedToken();
  } catch {}
  try {
    const { currentUser } = await import('../stores/auth.js');
    currentUser.set(null);
  } catch {}
}
function _shouldRun() {
  return isNative && !!getServerUrl();
}
function _notify(payload) {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new CustomEvent('ct:sync-complete', { detail: payload })); }
  catch {}
}

async function pushChanges() {
  const pending = await dbGetPendingChanges();
  const settings = await dbGetPendingSettingsForPush();

  const tablesToSend = {};
  let total = 0;
  for (const [table, rows] of Object.entries(pending)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    if (table === 'disabled_units' || table === 'recipe_cookbook_links') continue;
    tablesToSend[table] = rows.map(r => {
      const out = { ...r, client_id: r.id, server_id: r.server_id || null };
      delete out.id;
      delete out.sync_status;
      return out;
    });
    total += rows.length;
  }
  if (Array.isArray(pending.disabled_units) && pending.disabled_units.length) {
    tablesToSend.disabled_units = pending.disabled_units.map(r => ({ abbr: r.abbr }));
  }
  if (Array.isArray(pending.recipe_cookbook_links) && pending.recipe_cookbook_links.length) {
    tablesToSend.recipe_cookbook_links = pending.recipe_cookbook_links.map(r => ({
      cookbook_id: r.cookbook_id, recipe_id: r.recipe_id, sort_order: r.sort_order ?? 0,
    }));
  }

  if (total === 0 && settings.length === 0
      && !tablesToSend.disabled_units && !tablesToSend.recipe_cookbook_links) {
    return { pushed: 0 };
  }

  const res = await fetch(apiUrl('/api/sync/push'), {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({ tables: tablesToSend, settings }),
  });
  if (!res.ok) {
    if (res.status === 401) await _handleSyncAuthError();
    throw new Error(`Sync push failed: ${res.status} ${await _errBody(res)}`);
  }
  const body = await res.json();

  // Build a lookup of {table → {clientId → snapshotUpdatedAt}} so the
  // mark-synced steps below can check the push snapshot against the
  // row's current updated_at. If the user edited the same row between
  // the push snapshot and now, updated_at moved forward and the row
  // stays pending so the next sync re-pushes the fresh value.
  const snapshotByTable = {};
  for (const [table, rows] of Object.entries(pending)) {
    if (!Array.isArray(rows)) continue;
    const m = new Map();
    for (const r of rows) {
      if (r.id != null) m.set(r.id, r.updated_at);
    }
    if (m.size) snapshotByTable[table] = m;
  }

  for (const [table, results] of Object.entries(body.tables || {})) {
    if (!Array.isArray(results)) continue;
    const snap = snapshotByTable[table];
    const updatedRowsForBulkMark = [];
    for (const r of results) {
      if (r.client_id && r.server_id) {
        // Newly-created row: server assigned a server_id. Stamp it +
        // mark synced gated on updated_at.
        await dbSetServerId(table, r.client_id, r.server_id, snap?.get(r.client_id) || null);
      } else if (r.client_id) {
        // Update of an existing server_id row: server didn't need to
        // assign anything. Still mark synced gated on updated_at.
        const updatedAt = snap?.get(r.client_id);
        if (updatedAt) updatedRowsForBulkMark.push({ id: r.client_id, updated_at: updatedAt });
      }
    }
    if (updatedRowsForBulkMark.length) {
      await dbMarkTableSynced(table, updatedRowsForBulkMark);
    }
  }
  if (settings.length) {
    await dbMarkSettingsSynced(settings.map(s => ({ key: s.key, updated_at: s.updated_at })));
  }
  return { pushed: total };
}

async function pullChanges() {
  const since = (await dbGetMeta(LAST_PULL_KEY)) || '1970-01-01T00:00:00';
  const res = await fetch(apiUrl(`/api/sync/pull?since=${encodeURIComponent(since)}`), {
    method: 'GET',
    headers: _headers(),
  });
  if (!res.ok) {
    if (res.status === 401) await _handleSyncAuthError();
    throw new Error(`Sync pull failed: ${res.status} ${await _errBody(res)}`);
  }
  const body = await res.json();
  await dbApplyPull(body);
  await dbSetMeta(LAST_PULL_KEY, body.now || new Date().toISOString());
  let pulled = 0;
  for (const arr of Object.values(body.tables || {})) {
    if (Array.isArray(arr)) pulled += arr.length;
  }
  return { pulled };
}

/**
 * Full sync round: pull recent FIRST, then push pending. Pull-then-push
 * means mobile pushes against the freshest baseline; otherwise a row
 * the user edited locally before the server's last change would push
 * the stale full-row payload and silently clobber the server (issue
 * surfaced as variant relationships not appearing on mobile even
 * though the PWA had set them — local row was still pre-attach, the
 * push sent generic_parent_id=NULL, and the server's value was lost).
 * Concurrent callers share the in-flight promise so a manual "Sync
 * now" tap mid-background round doesn't double-fire.
 */
export async function fullSync(silentOrOpts = false) {
  const silent = typeof silentOrOpts === 'object' ? !!silentOrOpts.silent : !!silentOrOpts;
  if (!_shouldRun()) return { ok: false, reason: 'not-server-mode' };
  if (_syncInFlight) return _syncInFlight;
  syncState.update(s => ({ ...s, syncing: true, phase: 'pull', error: null }));
  _syncInFlight = (async () => {
    try {
      const pull = await pullChanges();
      syncState.update(s => ({ ...s, phase: 'push' }));
      const push = await pushChanges();
      // After the data pull, walk the server's image URLs and download
      // any that aren't already in the local cache so recipe/pantry/
      // diary thumbnails render offline. Best-effort: a failure here
      // doesn't fail the sync — the user just sees broken-image
      // placeholders for fresh entries until the next pass. Same
      // ordering as NutriTrace's sync.js.
      try {
        const { cacheAllImages } = await import('./image-cache.js');
        await cacheAllImages((done, total) => {
          if (total > 0) {
            syncState.update(s => ({ ...s, phase: 'images', progress: `Caching images… ${done}/${total}` }));
          }
        });
      } catch (e) {
        console.warn('[sync] image-cache pass failed:', e?.message);
      }
      const result = { ok: true, ...push, ...pull };
      const ts = new Date().toISOString();
      syncState.update(s => ({ ...s, syncing: false, phase: '', progress: '', lastSync: ts, error: null }));
      _notify(result);
      return result;
    } catch (e) {
      const err = e.message || String(e);
      syncState.update(s => ({ ...s, syncing: false, phase: '', error: err }));
      if (!silent) _notify({ ok: false, error: err });
      return { ok: false, error: err };
    } finally {
      _syncInFlight = null;
    }
  })();
  return _syncInFlight;
}

/** Start the background sync loop. Idempotent. */
export function startSyncLoop(intervalMs = 30000) {
  if (!isNative) return;
  if (_interval) return;
  _interval = setInterval(() => { fullSync(true); }, intervalMs);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') fullSync(true);
    });
  }
  // Best-effort kick on startup so the first paint includes the
  // freshest server data.
  if (_shouldRun()) fullSync(true);
}

export function stopSyncLoop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

/** Bulk push every local row to the server. Used by the merge dialog
 *  on first-connect to upload an existing local-only library. */
export async function pushAllFromDevice() {
  if (!_shouldRun()) return { ok: false, reason: 'not-server-mode' };
  const { getDb } = await import('./db-native.js');
  const db = await getDb();
  const tables = [
    'recipe_categories', 'pantry_categories', 'custom_units', 'cookbooks',
    'recipes', 'pantry_items', 'cook_diary', 'shopping_list',
    'recipe_comments', 'ai_chat_history',
  ];
  for (const t of tables) {
    await db.run(`UPDATE ${t} SET sync_status = 'pending'`, []);
  }
  await db.run(`UPDATE user_settings SET sync_status = 'pending'`, []);
  return fullSync(false);
}
