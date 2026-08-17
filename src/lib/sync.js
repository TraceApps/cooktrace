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
 *  read `online`, `syncing`, `lastSync`, `error` to render their state.
 *  `connectionIssue` carries the structured classification (kind, host,
 *  connectionType, status) that App.svelte's smart connection banner
 *  renders via lib/connection-message.js. `showErrorBanner` gates the
 *  full-height banner vs the compact hamburger cloud badge —
 *  automatic probes only update the badge; manual retries + explicit
 *  sync failures opt into the full banner. */
export const syncState = writable({
  syncing: false,
  phase: '',
  progress: '',
  lastSync: null,
  error: null,
  online: true,
  connectionIssue: null,
  showErrorBanner: false,
});

export function startNetworkMonitor() {
  if (typeof window === 'undefined') return;
  const update = () => syncState.update(s => ({ ...s, online: navigator.onLine }));
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

// ── Server-reachability probe ────────────────────────────────────────────
// Mirrors NT sync.js. Distinguishes "no network" (airplane / OS reports
// offline) from "server unreachable" (network fine, host doesn't answer)
// from "server error" (HTTP 4xx/5xx). Classifier output feeds the smart
// connection banner in App.svelte via describeConnectionIssue().
let _lastOfflineAt = 0;
let _lastOnlineAt = 0;
let _onlineCheckPromise = null;
const OFFLINE_RETRY_DELAY_MS = 15000;
const ONLINE_CHECK_CACHE_MS = 15000;

/** True while the health-check circuit breaker is suppressing redundant requests. */
export function isServerKnownUnavailable() {
  return !!_lastOfflineAt && Date.now() - _lastOfflineAt < OFFLINE_RETRY_DELAY_MS;
}

async function _networkSnapshot() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { connected: false, connectionType: 'none' };
  }
  try {
    const { Network } = await import('@capacitor/network');
    return await Network.getStatus();
  } catch {
    return {
      connected: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
      connectionType: 'unknown',
    };
  }
}

function _serverHost() {
  try { return new URL(getServerUrl()).hostname; }
  catch { return getServerUrl() || 'server'; }
}

function _connectionIssue({ network, error = null, status = null }) {
  const noNetwork = !network?.connected || network?.connectionType === 'none';
  return {
    kind: noNetwork ? 'no_network' : status ? 'server_error' : 'server_unreachable',
    host: _serverHost(),
    connectionType: network?.connectionType || 'unknown',
    status,
    detail: error?.message || null,
    at: new Date().toISOString(),
  };
}

function _publishConnectionIssue(issue, showErrorBanner = false) {
  syncState.update(s => ({
    ...s,
    online: false,
    connectionIssue: issue,
    // Automatic checks update compact status only. Once explicitly
    // requested (manual retry, user-initiated sync), detailed feedback
    // remains until dismissal or a successful connection.
    ...(showErrorBanner ? { showErrorBanner: true } : {}),
  }));
}

async function _probeServer(showErrorBanner = false) {
  try {
    const res = await fetch(apiUrl('/api/health'), {
      headers: _headers(),
      signal: AbortSignal.timeout(3000),
    });
    const online = res.ok;
    if (!online) {
      _lastOnlineAt = 0;
      _lastOfflineAt = Date.now();
      const network = await _networkSnapshot();
      const issue = _connectionIssue({ network, status: res.status });
      console.warn(`[sync] server health check failed: host=${issue.host} network=${issue.connectionType} status=${res.status}`);
      _publishConnectionIssue(issue, showErrorBanner);
    } else {
      _lastOfflineAt = 0;
      _lastOnlineAt = Date.now();
      syncState.update(s => ({ ...s, online: true, connectionIssue: null, showErrorBanner: false }));
    }
    return online;
  } catch (error) {
    _lastOnlineAt = 0;
    _lastOfflineAt = Date.now();
    const network = await _networkSnapshot();
    const issue = _connectionIssue({ network, error });
    console.warn(`[sync] server unreachable: host=${issue.host} network=${issue.connectionType} error=${error?.message || String(error)}`);
    _publishConnectionIssue(issue, showErrorBanner);
    return false;
  }
}

export async function checkOnline(force = false, showErrorBanner = false) {
  if (!force && isServerKnownUnavailable()) return false;
  if (!force && _lastOnlineAt && Date.now() - _lastOnlineAt < ONLINE_CHECK_CACHE_MS) {
    return true;
  }
  if (!force && _onlineCheckPromise) return _onlineCheckPromise;
  if (force) return _probeServer(showErrorBanner);

  _onlineCheckPromise = _probeServer(showErrorBanner);
  try {
    return await _onlineCheckPromise;
  } finally {
    _onlineCheckPromise = null;
  }
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

// ── Local-photo URL reconciliation ─────────────────────────────────────
// Phone-uploaded photos stored under Capacitor's private Filesystem end
// up in server-tracked entities as URLs like
// https://<webview-host>/_capacitor_file_/data/.../uploads/img_xxx.jpg.
// These are non-portable — they point at THIS install's private storage
// only. Other devices see them as broken images, and a reinstall of the
// same device loses them too. This pass walks recipes / pantry / cook
// diary entries, and for every _capacitor_file_ URL it finds:
//   - if the local file exists → POST to /api/upload, rewrite the URL
//     to the returned /uploads/<file> path, mark the entity dirty so
//     the following push syncs the fix out.
//   - if the local file is gone → clear the URL (portable placeholder).
//
// Idempotent; runs between pull and push on every sync, so entries
// take at most one sync cycle to converge.
function _isLocalCapacitorUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.includes('_capacitor_file_');
}
function _capacitorUrlToFileUri(url) {
  // Reverse of Capacitor.convertFileSrc: strips the WebView origin +
  // "_capacitor_file_" segment to recover the original file:// URI.
  // Handles both https://localhost/_capacitor_file_/... and the newer
  // https://app.cooktrace.local/_capacitor_file_/... shape.
  const marker = '/_capacitor_file_';
  const idx = url.indexOf(marker);
  if (idx < 0) return null;
  return 'file://' + url.slice(idx + marker.length);
}
async function _fileExistsAtUri(fileUri) {
  try {
    const { Filesystem } = await import('@capacitor/filesystem');
    await Filesystem.stat({ path: fileUri });
    return true;
  } catch {
    return false;
  }
}
async function _readFileAsBlob(fileUri) {
  try {
    const { Filesystem } = await import('@capacitor/filesystem');
    const res = await Filesystem.readFile({ path: fileUri });
    const base64 = res.data;
    if (!base64) return null;
    // base64 → binary blob. Guess a MIME from the extension; server
    // magic-byte detection re-verifies for images.
    const extMatch = fileUri.match(/\.([a-z0-9]+)$/i);
    const ext = (extMatch?.[1] || 'jpg').toLowerCase();
    const mime = ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
      : 'image/jpeg';
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}
async function _uploadFromFileUri(fileUri) {
  const blob = await _readFileAsBlob(fileUri);
  if (!blob) return null;
  const nameMatch = fileUri.match(/[^/]+$/);
  const name = nameMatch ? nameMatch[0] : 'photo.jpg';
  const file = new File([blob], name, { type: blob.type });
  // Hit /api/upload directly (bypassing NtApi.uploadImage's local
  // fallback — we don't want the fallback here because the whole
  // point is to promote a local URL to a portable server one; a
  // fallback would just re-write the same local URL).
  try {
    const form = new FormData();
    form.append('file', file);
    const headers = {};
    const token = getAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(apiUrl('/api/upload'), {
      method: 'POST', headers, credentials: 'include', body: form,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data?.url || null;
  } catch {
    return null;
  }
}
async function _reconcileLocalPhotoUrls(onProgress) {
  const { getDb } = await import('./db-native.js');
  const db = await getDb();
  // Collect candidates from the tables that carry user photos. Field
  // names differ per table (photo_url + photos JSON on cook_diary,
  // img_url on recipes, photo_url on pantry_items).
  const jobs = [];
  async function scan(sql, params, mapper) {
    try {
      const r = await db.query(sql, params);
      for (const row of r?.values || []) jobs.push(...mapper(row));
    } catch (e) {
      console.warn('[reconcile] scan failed:', sql, e?.message);
    }
  }
  await scan(
    `SELECT id, photo_url, photos FROM cook_diary WHERE (photo_url IS NOT NULL AND photo_url != '') OR (photos IS NOT NULL AND photos != '')`,
    [],
    row => {
      const out = [];
      if (_isLocalCapacitorUrl(row.photo_url)) {
        out.push({ table: 'cook_diary', id: row.id, field: 'photo_url', url: row.photo_url });
      }
      if (row.photos) {
        let arr = [];
        try { arr = JSON.parse(row.photos); } catch {}
        if (Array.isArray(arr)) {
          arr.forEach((u, idx) => {
            if (_isLocalCapacitorUrl(u)) out.push({ table: 'cook_diary', id: row.id, field: 'photos', arrayIndex: idx, url: u });
          });
        }
      }
      return out;
    }
  );
  await scan(
    `SELECT id, img_url FROM recipes WHERE img_url IS NOT NULL AND img_url != ''`,
    [],
    row => (_isLocalCapacitorUrl(row.img_url) ? [{ table: 'recipes', id: row.id, field: 'img_url', url: row.img_url }] : [])
  );
  await scan(
    `SELECT id, img_url FROM pantry_items WHERE img_url IS NOT NULL AND img_url != ''`,
    [],
    row => (_isLocalCapacitorUrl(row.img_url) ? [{ table: 'pantry_items', id: row.id, field: 'img_url', url: row.img_url }] : [])
  );
  if (jobs.length === 0) return { total: 0, uploaded: 0, cleared: 0 };
  let uploaded = 0;
  let cleared = 0;
  let progressDone = 0;
  // Batch photos-array jobs by row so multiple broken elements in the
  // same cook_diary.photos array are processed in a single read+write
  // instead of one job at a time. The prior per-job splice mutated
  // .photos while later jobs still held stale arrayIndex values that
  // pointed at the shifted (or vanished) element, so a row with N
  // broken photos took N sync cycles to converge.
  const scalarJobs = [];
  const photoJobsByRowId = new Map(); // id → [job, job, ...]
  for (const j of jobs) {
    if (j.field === 'photos') {
      const list = photoJobsByRowId.get(j.id) || [];
      list.push(j);
      photoJobsByRowId.set(j.id, list);
    } else {
      scalarJobs.push(j);
    }
  }
  async function _resolveUrl(url) {
    const fileUri = _capacitorUrlToFileUri(url);
    if (fileUri && await _fileExistsAtUri(fileUri)) {
      const uploaded_ = await _uploadFromFileUri(fileUri);
      if (uploaded_) return { status: 'uploaded', url: uploaded_ };
      return { status: 'retry' }; // upload attempt failed; try again next sync
    }
    return { status: 'cleared' };
  }
  // Scalar fields (recipes.img_url, pantry_items.img_url, cook_diary.photo_url).
  for (const j of scalarJobs) {
    const r = await _resolveUrl(j.url);
    if (r.status === 'retry') { progressDone++; if (onProgress) onProgress(progressDone, jobs.length); continue; }
    const newUrl = r.status === 'uploaded' ? r.url : '';
    if (r.status === 'uploaded') uploaded++; else cleared++;
    try {
      await db.run(
        `UPDATE ${j.table} SET ${j.field} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), sync_status = 'pending' WHERE id = ?`,
        [newUrl, j.id]
      );
    } catch (e) {
      console.warn('[reconcile] db update failed:', j.table, j.id, e?.message);
    }
    progressDone++;
    if (onProgress) onProgress(progressDone, jobs.length);
  }
  // cook_diary.photos: one pass per row. Read the current array once,
  // rewrite/remove every stale element in memory, write back once.
  for (const [rowId, rowJobs] of photoJobsByRowId) {
    let arr = [];
    try {
      const r = await db.query('SELECT photos FROM cook_diary WHERE id = ?', [rowId]);
      arr = JSON.parse(r?.values?.[0]?.photos || '[]');
      if (!Array.isArray(arr)) arr = [];
    } catch { arr = []; }
    let dirty = false;
    for (const j of rowJobs) {
      const currentIdx = arr.indexOf(j.url); // re-find by value, not by stale cached index
      if (currentIdx === -1) { progressDone++; if (onProgress) onProgress(progressDone, jobs.length); continue; }
      const r = await _resolveUrl(j.url);
      if (r.status === 'retry') { progressDone++; if (onProgress) onProgress(progressDone, jobs.length); continue; }
      if (r.status === 'uploaded') { arr[currentIdx] = r.url; uploaded++; dirty = true; }
      else { arr[currentIdx] = null; cleared++; dirty = true; } // mark for compaction below
      progressDone++;
      if (onProgress) onProgress(progressDone, jobs.length);
    }
    if (dirty) {
      const finalArr = arr.filter(u => u != null);
      try {
        await db.run(
          `UPDATE cook_diary SET photos = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), sync_status = 'pending' WHERE id = ?`,
          [JSON.stringify(finalArr), rowId]
        );
      } catch (e) {
        console.warn('[reconcile] db update failed: cook_diary', rowId, e?.message);
      }
    }
  }
  console.info(`[reconcile] ${uploaded} uploaded, ${cleared} cleared, ${jobs.length} total`);
  return { total: jobs.length, uploaded, cleared };
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
export async function fullSync(silentOrOpts = false, forceCheck = false, showFailureBanner = false) {
  // Backwards-compatible: old callers pass a bool for `silent`; the
  // pull-to-refresh + Retry banner paths pass all three positional args.
  const silent = typeof silentOrOpts === 'object' ? !!silentOrOpts.silent : !!silentOrOpts;
  if (!_shouldRun()) return { ok: false, reason: 'not-server-mode' };
  if (_syncInFlight) return _syncInFlight;
  // Server-reachability probe before the heavy pull/push. Skipping this
  // when the circuit breaker says "known offline" avoids re-triggering
  // the 3s health-check on every ticked poll. `showFailureBanner` opts
  // this call into surfacing the full connection banner instead of just
  // the compact cloud badge.
  const online = await checkOnline(forceCheck, showFailureBanner);
  if (!online) return { ok: false, reason: 'offline' };
  syncState.update(s => ({ ...s, syncing: true, phase: 'pull', error: null }));
  _syncInFlight = (async () => {
    try {
      const pull = await pullChanges();
      // Between pull and push: reconcile any phone-local photo URLs
      // (Capacitor's https://<host>/_capacitor_file_/... scheme) that
      // ended up in server-tracked entities. These are always non-
      // portable — they point at a file inside THIS install's private
      // Filesystem. If the file still exists on disk, re-upload to
      // /api/upload and rewrite the URL to a portable /uploads/... one.
      // If it doesn't (fresh install syncing entries from another
      // device, uninstall-reinstall), clear the URL so downstream
      // renderers show the placeholder instead of a broken image.
      // Runs before push so the rewritten URLs sync out in the same
      // pass.
      try {
        await _reconcileLocalPhotoUrls((done, total) => {
          if (total > 0) {
            syncState.update(s => ({ ...s, phase: 'photos', progress: `Uploading local photos… ${done}/${total}` }));
          }
        });
      } catch (e) {
        console.warn('[sync] local-photo reconcile failed:', e?.message);
      }
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
      // Clear connectionIssue + showErrorBanner + error on success so a
      // stale banner from a prior 401 / timeout doesn't linger forever
      // once the underlying issue is resolved.
      syncState.update(s => ({
        ...s, syncing: false, phase: '', progress: '',
        lastSync: ts, error: null, online: true,
        connectionIssue: null, showErrorBanner: false,
      }));
      _notify(result);
      return result;
    } catch (e) {
      const err = e.message || String(e);
      syncState.update(s => ({
        ...s, syncing: false, phase: '', error: err,
        ...(showFailureBanner ? { showErrorBanner: true } : {}),
      }));
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
