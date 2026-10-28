/**
 * A server that takes the connection and never answers (a captive portal, a
 * dead link, a host gone quiet behind a VPN) counts as no connection within
 * seconds where the web app has an offline answer: an account kept on this
 * device opens in about three seconds rather than eight, and the server then
 * counts as quiet, so the reads that follow wait less (lib/request-deadline.js).
 * The offline layer's part is in offline-storage-save.test.js.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window ??= { location: { hash: '' }, addEventListener() {}, dispatchEvent() {} };

const A = await import('../src/stores/auth.js');
const deadline = await import('../src/lib/request-deadline.js');
const ANN = { id: 7, username: 'ann', role: 'user' };

/** Every request waits until it gives up, as a browser does for a silent server. */
const silent = () => {
  globalThis.fetch = async (url, init = {}) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)));
};

/** loadAuthState's time, kept alive meanwhile (Node would end with only a deadline left). */
async function timedStart() {
  const keep = setInterval(() => {}, 1000);
  const t0 = Date.now();
  try { await A.loadAuthState(); } finally { clearInterval(keep); }
  return Date.now() - t0;
}

test('a silent server, an account kept here: the app opens with it in seconds', async () => {
  store.clear();
  store.set('ct:cachedUser', JSON.stringify(ANN));
  store.set('ct:cachedUserMgmt', '1');
  deadline.noteAnswered();
  silent();
  const ms = await timedStart();
  assert.equal(get(A.currentUser)?.username, 'ann');
  assert.ok(ms >= deadline.SIGN_IN_CHECK_MS - 100 && ms < deadline.SIGN_IN_CHECK_MS + 1500, `opened after ${ms} ms`);
  assert.equal(deadline.isQuiet(), true, 'the reads that follow wait less');
});

test('a silent server, nothing kept: the sign-in page saying why, after the usual wait', async () => {
  store.clear();
  store.set('ct:cachedUserMgmt', '1');
  deadline.noteAnswered();
  silent();
  const ms = await timedStart();
  assert.equal(get(A.currentUser), null);
  assert.equal(get(A.userMgmtActive), true);
  assert.ok(ms >= 7900, `gave up after ${ms} ms`);
});

test('reads by kind: the services the server asks wait as long as they take, whole lists longer', async () => {
  try { await import('svelte/store'); } catch { return; }
  const deadline = await import('../src/lib/request-deadline.js');
  // No other tab to talk to: an open channel would keep the run going.
  globalThis.BroadcastChannel = undefined;
  const { readDeadlineMsFor } = await import('../src/lib/offline-api.js');
  deadline.noteAnswered();
  for (const p of ['/api/recipes/12', '/api/shopping', '/api/units', '/api/app-config', '/api/ai/history', '/api/recipes/12/comments']) assert.equal(readDeadlineMsFor(p), deadline.READ_MS, p);
  for (const p of ['/api/recipes', '/api/recipes?sort=name', '/api/pantry', '/api/pantry?category=2', '/api/cook-diary', '/api/cook-diary?recipe_id=4', '/api/cook-diary/heatmap?days=90', '/api/cook-diary/stats']) {
    assert.equal(readDeadlineMsFor(p), deadline.HEAVY_READ_MS, p);
  }
  for (const p of ['/api/nt/foods?q=oats', '/api/proxy?url=x', '/api/off/product/1', '/api/updates/server-status', '/api/data/export', '/api/full-backup', '/api/ai/models']) assert.equal(readDeadlineMsFor(p), null, p);
});
