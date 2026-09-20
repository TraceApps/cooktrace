/**
 * offline-api.js: the browser's side of working without a connection.
 *
 * Online, every call goes to the server as before and what comes back is kept
 * in IndexedDB (the mirror). When the server can't be reached, the screens
 * that matter are answered from the mirror, and what you change goes into an
 * outbox and shows at once. Back online, the outbox is replayed against the
 * same routes, so the server does what it would have done anyway: no second
 * merge path to keep in step.
 *
 * Every call in the app already funnels through one method on the HTTP API
 * (`_fetch`), so wrapping that one method covers every screen without any of
 * them changing.
 *
 * Deliberately not the Background Sync API: Safari doesn't have it, and the
 * iPhone is half the point. The page flushes instead, on a backoff, on the
 * browser's own `online` event, and when the tab comes back to the front.
 *
 * Tabs share the outbox: a Web Lock keeps two of them from replaying it at
 * once, and a BroadcastChannel tells the others when it changed.
 */
import { writable } from 'svelte/store';
import {
  isOfflineError, isMirroredGet, mirrorKey, pathOf, writeOp, collapseOps, sentSeqs,
  answerWithOps, newTempId, createdId, remapIds, remapPath, describeOp, shouldRetryStatus,
  MAKES_A_ROW,
} from './offline-edits.js';

const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 30_000;
let _retryMs = RETRY_MIN_MS;
const _backoff = () => { const ms = _retryMs; _retryMs = Math.min(RETRY_MAX_MS, _retryMs * 2); return ms; };
const _resetBackoff = () => { _retryMs = RETRY_MIN_MS; };

/** { online, pending, syncing, error, refused } for the badge and Settings. */
export const offlineState = writable({
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  pending: 0,
  syncing: false,
  error: null,
  // Changes the server answered and refused. Kept, and said out loud once, so
  // nothing disappears without the person who made it being told.
  refused: [],
});

const _online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

// ── IndexedDB ────────────────────────────────────────────────────────
// Whose queue this is. If the app ever cannot confirm who is signed in (what
// a reload with no connection looks like) and clears the id, the last one
// this browser saw still names the database, so the queue is never orphaned
// where nothing will read it.
const _USER_KEY = 'ct:offline-user';
let _dbPromise = null;
function _dbName() {
  let user = null;
  try {
    user = localStorage.getItem('ct:userId') || localStorage.getItem('wl:userId');
    if (user) localStorage.setItem(_USER_KEY, user);
    else user = localStorage.getItem(_USER_KEY);
  } catch { /* private mode */ }
  return `cooktrace-offline-${user || 'single'}`;
}
const _STORES = ['answers', 'outbox', 'refused'];

function _db() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  const name = _dbName();
  if (_dbPromise && _dbPromise.name === name) return _dbPromise;
  // The first reads of a page happen before the app knows who is signed in,
  // so they are filed under the anonymous name. Once the id turns up, bring
  // what was kept with it rather than leaving it where nothing reads it.
  const leaving = _dbPromise?.name && _dbPromise.name !== name ? _dbPromise.name : null;
  const p = new Promise((resolve) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('answers')) db.createObjectStore('answers', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains('refused')) db.createObjectStore('refused', { keyPath: 'at' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  p.name = name;
  _dbPromise = p;
  if (leaving) p.then(db => _absorb(leaving, db));
  return p;
}

/** Move everything from an old database into this one, then drop it. */
async function _absorb(oldName, db) {
  if (!db) return;
  const old = await new Promise((resolve) => {
    const req = indexedDB.open(oldName);
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => resolve(null);
  });
  if (!old) return;
  for (const store of _STORES) {
    if (!old.objectStoreNames.contains(store) || !db.objectStoreNames.contains(store)) continue;
    const rows = await new Promise((resolve) => {
      try {
        const q = old.transaction(store, 'readonly').objectStore(store).getAll();
        q.onsuccess = () => resolve(q.result || []);
        q.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
    if (!rows.length) continue;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(store, 'readwrite');
        const s = tx.objectStore(store);
        // The outbox is keyed by a running number, so queued work is re-added
        // and given a new one rather than landing on top of something.
        for (const row of rows) { if (store === 'outbox') { const { seq, ...rest } = row; s.add(rest); } else s.put(row); }
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      } catch { resolve(); }
    });
  }
  old.close();
  try { indexedDB.deleteDatabase(oldName); } catch { /* another tab has it open */ }
  _ops = null;
  await _loadOps();
  _publish();
  if (_ops.length) _scheduleFlush(0);
}

// Every read and write is wrapped: a blocked, full or private-mode database
// resolves to null instead of throwing, and the app falls back to the server.
function _tx(store, mode, fn) {
  return _db().then(db => new Promise((resolve) => {
    if (!db) return resolve(null);
    let out;
    try {
      const tx = db.transaction(store, mode);
      out = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
      tx.onerror = tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  }));
}
const _all = (store) => _tx(store, 'readonly', s => s.getAll()).then(r => r || []);
const _remember = (key, body) => _tx('answers', 'readwrite', s => s.put({ key, body, at: Date.now() }));

/** What was last seen for this call: the exact call first, then its path. */
async function _recall(url) {
  const exact = await _tx('answers', 'readonly', s => s.get(mirrorKey(url)));
  if (exact) return exact.body;
  const path = pathOf(url);
  const byPath = await _tx('answers', 'readonly', s => s.get(path));
  if (byPath) return byPath.body;
  const rows = await _all('answers');
  return rows.find(r => pathOf(r.key) === path)?.body;
}

// ── Outbox ───────────────────────────────────────────────────────────
let _ops = null;
async function _loadOps() {
  if (!_ops) _ops = await _all('outbox');
  return _ops;
}
function _publish(extra = {}) {
  offlineState.update(s => ({ ...s, pending: _ops?.length || 0, ...extra }));
}

/** Changes the server refused, so a screen can say so and let them go. */
export async function refusedChanges() {
  return (await _all('refused')).sort((a, b) => a.at - b.at);
}
export async function forgetRefused() {
  await _tx('refused', 'readwrite', s => s.clear());
  _publish({ refused: [] });
}

const _channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('cooktrace-offline') : null;
_channel?.addEventListener('message', async (e) => {
  if (e.data?.type !== 'outbox') return;
  if (e.data.ids) _swapped = { ..._swapped, ...e.data.ids };
  _ops = null;
  await _loadOps();
  _publish();
  if (e.data.synced && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('ct:offline-synced'));
  }
});

/**
 * What each temporary id became. A screen already open goes on showing the
 * id a row was created with offline, so a change made right after the queue
 * goes up would otherwise be sent against an id the server never had.
 */
let _swapped = {};

function _offlineError(message) {
  const err = new Error(message || 'This needs a connection.');
  err.offline = true;
  return err;
}

async function _queue(op) {
  const ops = await _loadOps();
  const seq = await _tx('outbox', 'readwrite', s => s.add(op));
  // No database to queue into (private mode, no space): say so rather than
  // pretending it was saved.
  if (seq == null) return null;
  op.seq = seq;
  ops.push(op);
  _publish({ online: _online() });
  _channel?.postMessage({ type: 'outbox' });
  _scheduleFlush(_online() ? 0 : _retryMs);
  return op;
}

// ── Sending ──────────────────────────────────────────────────────────
let _http = null;           // the plain HTTP API, for the real requests
let _retry = null;
let _flushing = null;

function _scheduleFlush(ms = 0) {
  clearTimeout(_retry);
  _retry = setTimeout(() => { flushOutbox(); }, ms);
}

/** Replay what's waiting. Resolves true when the outbox is empty afterwards. */
export function flushOutbox() {
  if (_flushing) return _flushing;
  _flushing = (async () => {
    try {
      const run = () => _flushOnce();
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await navigator.locks.request('cooktrace-offline-flush', run);
      }
      return await run();
    } finally {
      _flushing = null;
    }
  })();
  return _flushing;
}

async function _flushOnce() {
  _ops = null;
  const ops = await _loadOps();
  if (!ops.length) { _publish({ syncing: false, error: null, online: _online() }); return true; }
  if (!_online() || !_http) { _scheduleFlush(_backoff()); return false; }
  _publish({ syncing: true });

  const done = new Set();
  const refused = [];
  const map = {};
  let stopped = null;

  for (const op of collapseOps(ops)) {
    const path = remapPath(op.path, map);
    const body = op.body == null ? undefined : remapIds(op.body, map);
    let answer;
    try {
      answer = await _http._fetch(op.method, path, body);
    } catch (err) {
      if (isOfflineError(err)) { stopped = { offline: true }; break; }
      // A server that is struggling, or a session that needs signing in
      // again, keeps its place in the queue: everything behind it waits so
      // nothing arrives out of order.
      if (shouldRetryStatus(err.status)) { stopped = { error: err.message || 'failed' }; break; }
      // A refusal is the server's answer: trying again will not change it.
      // Set this one aside, tell the person later, and carry on with the
      // rest, so one rejected change cannot hold up everything behind it.
      refused.push({ at: Date.now() + refused.length, what: describeOp(op), reason: err.message || 'refused' });
      console.error(`[offline] your server refused ${describeOp(op)}: ${err.message} (${op.method} ${op.path})`);
      if (op.key) done.add(op.key);
      continue;
    }
    if (op.tempId != null) {
      const real = createdId(answer);
      if (real != null) map[Number(op.tempId)] = real;
    }
    if (op.key) done.add(op.key);
  }

  if (refused.length) await _tx('refused', 'readwrite', s => { for (const r of refused) s.put(r); });
  if (Object.keys(map).length) {
    _swapped = { ..._swapped, ...map };
    _channel?.postMessage({ type: 'outbox', ids: map });
  }

  const cleared = new Set(sentSeqs(ops, [...done]));
  if (cleared.size) {
    await _tx('outbox', 'readwrite', s => { for (const seq of cleared) s.delete(seq); });
    _ops = ops.filter(op => !cleared.has(op.seq));
  }

  const standing = await refusedChanges();
  if (stopped) {
    _publish({ syncing: false, online: stopped.offline ? false : _online(), error: stopped.error || null, refused: standing });
    _scheduleFlush(_backoff());
    return false;
  }
  // Anything the replay changed should be read again rather than served from
  // a copy taken before it.
  await _tx('answers', 'readwrite', s => s.clear());
  _resetBackoff();
  _publish({ syncing: false, error: null, online: true, refused: standing });
  _channel?.postMessage({ type: 'outbox', synced: true, ids: map });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('ct:offline-synced'));
  if (_ops?.length) _scheduleFlush(0);
  return !(_ops?.length);
}

/** How much is waiting to go up. */
export async function pendingCount() {
  return (await _loadOps()).length;
}

/** Clear the mirror and the queue, e.g. on sign-out. */
export async function clearOffline() {
  for (const store of _STORES) await _tx(store, 'readwrite', s => s.clear());
  _ops = [];
  _swapped = {};
  _dbPromise = null;
  try { localStorage.removeItem(_USER_KEY); } catch { /* private mode */ }
  _publish({ syncing: false, error: null, refused: [] });
}

// ── The wrapper ──────────────────────────────────────────────────────

function _wire() {
  if (typeof window === 'undefined' || window.__ctOfflineWired) return;
  window.__ctOfflineWired = true;
  window.addEventListener('online', () => { _resetBackoff(); _publish({ online: true }); _scheduleFlush(0); });
  window.addEventListener('offline', () => _publish({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _online()) _scheduleFlush(0);
  });
  // A queue left from last time goes up even if the first screen opened
  // never calls the API.
  _loadOps().then(() => { _publish(); if (_ops.length) _scheduleFlush(0); });
}

/**
 * The HTTP API with the mirror and the outbox behind it. Every named method
 * (getRecipes, addShoppingItem, …) calls `_fetch`, so overriding that one
 * method covers all of them, and the object keeps its own `this`.
 */
export function createOfflineApi(http) {
  _http = http;
  _wire();
  const impl = Object.create(http);
  impl._fetch = (method, path, body, isUpload) => (
    // An upload carries a file, which is not ours to hold: it goes straight
    // to the server and says it needs a connection if there isn't one.
    isUpload ? _straight(http, method, path, body, isUpload) : offlineFetch(http, method, path, body)
  );
  return impl;
}

async function _straight(http, method, path, body, isUpload) {
  try {
    return await http._fetch(method, path, body, isUpload);
  } catch (err) {
    if (!isOfflineError(err)) throw err;
    _publish({ online: false });
    throw _offlineError();
  }
}

/** One call, with the copy and the queue behind it. */
export async function offlineFetch(http, method, path, body) {
  _http = http;
  const m = (method || 'GET').toUpperCase();

  if (m === 'GET' || m === 'HEAD') {
    try {
      const answer = await http._fetch(m, path, body);
      if (isMirroredGet(path)) await _remember(mirrorKey(path), answer);
      _publish({ online: true });
      const ops = await _loadOps();
      return ops.length ? answerWithOps(path, answer, ops) : answer;
    } catch (err) {
      if (!isOfflineError(err)) throw err;
      _publish({ online: false });
      if (!isMirroredGet(path)) throw _offlineError();
      const mirrored = await _recall(path);
      // Even with no copy of this call, what is queued for it may be the
      // whole answer: a shopping list written from scratch in a shop.
      const answer = answerWithOps(path, mirrored, await _loadOps());
      if (answer === undefined) {
        console.debug('[offline] no copy held for', path);
        throw _offlineError();
      }
      return answer;
    }
  }

  const target = remapPath(String(path), _swapped);
  const op = writeOp(m, target, body);
  if (!op) {
    // Sharing, kitchens, imports, AI, admin: still the server's job.
    return _straight(http, m, target, body);
  }

  const queued = await _loadOps();
  if (_online() && !queued.length) {
    try {
      const answer = await http._fetch(m, target, body);
      _publish({ online: true, error: null });
      return answer;
    } catch (err) {
      if (!isOfflineError(err)) throw err;
      _publish({ online: false });
    }
  }

  const tempId = MAKES_A_ROW.includes(op.kind) ? newTempId() : null;
  const stored = await _queue({
    method: m,
    path: target,
    body,
    at: Date.now(),
    ...op,
    ...(tempId != null ? { tempId, id: tempId, key: `${op.kind.replace('-create', '')}:${tempId}` } : {}),
  });
  if (!stored) throw _offlineError();

  // Answer in the shape the route would have, so the screen carries on.
  if (tempId != null) return { ...(body || {}), id: tempId, queued: true, offline: true };
  return { ok: true, ...(body || {}), queued: true, offline: true };
}
