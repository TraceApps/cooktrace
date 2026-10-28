/**
 * Saving with a connection must not depend on this browser's own storage
 * (TraceApps/nutritrace#269). Loads the real offline layer against a small
 * stand-in for IndexedDB, so the cases a browser rarely shows on demand can
 * be staged: storage that refuses to open, a change waiting that the server
 * keeps failing on, and a store that breaks after the page loaded.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Scheduled flushes only run when a test asks for them.
mock.timers.enable({ apis: ['setTimeout'] });
// No other tab to talk to, and nothing left listening when the tests end.
globalThis.BroadcastChannel = undefined;
Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });

const setOnline = (on) => Object.defineProperty(globalThis, 'navigator', { value: { onLine: on }, configurable: true, writable: true });
setOnline(true);

class FakeRequest {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
}
globalThis.IDBRequest = FakeRequest;

const later = (fn) => queueMicrotask(fn);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/** Just enough IndexedDB for lib/offline-api.js, with switches to break it. */
function fakeIndexedDB() {
  const env = { dbs: new Map(), openThrows: false, broken: false, full: false };
  class Tx {
    constructor(db) {
      this.db = db; this.pending = 0; this.failed = null; this.finished = false;
      this.oncomplete = this.onerror = this.onabort = null;
      later(() => this.check());
    }
    objectStore(name) {
      const def = this.db.stores.get(name);
      if (!def) throw new DOMException(`No store ${name}`, 'NotFoundError');
      return new Store(def, this);
    }
    done() { this.pending--; this.check(); }
    check() {
      if (this.pending > 0 || this.finished) return;
      this.finished = true;
      later(() => {
        if (this.failed) { this.error = this.failed; this.onerror?.(); this.onabort?.(); } else this.oncomplete?.();
      });
    }
  }
  class Store {
    constructor(def, tx) { this.def = def; this.tx = tx; }
    req(fn, write) {
      const req = new FakeRequest();
      this.tx.pending++;
      later(() => {
        try {
          if (write && env.full) throw new DOMException('Quota exceeded', 'QuotaExceededError');
          req.result = fn();
          req.onsuccess?.({ target: req });
        } catch (e) {
          req.error = e; this.tx.failed = e; req.onerror?.({ target: req });
        }
        this.tx.done();
      });
      return req;
    }
    getAll() { return this.req(() => [...this.def.rows.values()].map(clone)); }
    get(key) { return this.req(() => clone(this.def.rows.get(key))); }
    add(value) {
      return this.req(() => {
        let key = this.def.keyPath ? value[this.def.keyPath] : undefined;
        if (key == null && this.def.autoIncrement) { key = ++this.def.seq; value = { ...value, [this.def.keyPath]: key }; }
        if (this.def.rows.has(key)) throw new DOMException('Key exists', 'ConstraintError');
        this.def.rows.set(key, clone(value));
        return key;
      }, true);
    }
    put(value, outOfLine) {
      return this.req(() => {
        const key = outOfLine ?? value[this.def.keyPath];
        this.def.rows.set(key, clone(value));
        return key;
      }, true);
    }
    delete(key) { return this.req(() => { this.def.rows.delete(key); }, true); }
    clear() { return this.req(() => { this.def.rows.clear(); }, true); }
  }
  class DB {
    constructor(name) { this.name = name; this.version = 0; this.stores = new Map(); }
    get objectStoreNames() { return { contains: (n) => this.stores.has(n) }; }
    createObjectStore(name, opts = {}) {
      this.stores.set(name, { keyPath: opts.keyPath, autoIncrement: !!opts.autoIncrement, rows: new Map(), seq: 0 });
    }
    transaction() {
      // What a dropped connection does: every new transaction throws.
      if (env.broken) throw new DOMException('The database connection is closing.', 'InvalidStateError');
      return new Tx(this);
    }
    close() {}
  }
  const idb = {
    open(name, version) {
      // What a browser refusing this site storage does.
      if (env.openThrows) throw new DOMException('The operation is insecure.', 'SecurityError');
      const req = new FakeRequest();
      later(() => {
        let db = env.dbs.get(name);
        if (!db) { db = new DB(name); env.dbs.set(name, db); }
        req.result = db;
        if (version && version > db.version) { db.version = version; req.onupgradeneeded?.(); }
        req.onsuccess?.();
      });
      return req;
    },
    deleteDatabase(name) { env.dbs.delete(name); },
  };
  /** A change already waiting when the page opens. */
  env.seed = (op) => {
    const name = 'cooktrace-offline-single';
    let db = env.dbs.get(name);
    if (!db) { db = new DB(name); env.dbs.set(name, db); db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }); }
    const out = db.stores.get('outbox');
    const seq = ++out.seq;
    out.rows.set(seq, { ...op, seq });
  };
  env.outbox = () => [...(env.dbs.get('cooktrace-offline-single')?.stores.get('outbox')?.rows.values() || [])];
  return { idb, env };
}

/** The HTTP API's one door, recording what reached the server. */
function fakeHttp() {
  const sent = [];
  const http = {
    sent,
    async _fetch(method, path, body) {
      sent.push([method, String(path), body ?? null]);
      if (http.fail) throw http.fail;
      return String(path) === '/api/auth/profile' ? { user: { id: 1, username: 'alex', role: 'admin', ...body } } : { ok: true, ...(body || {}) };
    },
  };
  return http;
}

let loads = 0;
/** A fresh copy of the offline layer, as a newly opened page has. */
async function page({ seed = [], openThrows = false } = {}) {
  const { idb, env } = fakeIndexedDB();
  env.openThrows = openThrows;
  for (const op of seed) env.seed(op);
  globalThis.indexedDB = idb;
  const mod = await import(`../src/lib/offline-api.js?page=${++loads}`);
  const server = fakeHttp();
  const call = (method, path, body, http = server) => mod.offlineFetch(http, method, path, body);
  return { mod, call, server, env };
}

// A change the server keeps failing on (a 503 is retried), still waiting.
const WAITING = { method: 'PUT', path: '/api/settings', body: { key: 'units', value: 'metric' }, kind: 'setting', key: 'setting:units', at: 1 };
const PROFILE = { full_name: 'Alex Doe', nickname: 'Lex', birthday: '1990-04-02', gender: 'female', avatar_url: '', email: '' };
// Writes only: a profile change also reads the account back afterwards.
const writes = (server) => server.sent.filter(s => s[0] !== 'GET');
const sentPaths = (server) => writes(server).map(s => `${s[0]} ${s[1]}`);

test('storage that refuses to open: a profile save still reaches the server', async () => {
  setOnline(true);
  const { call, server } = await page({ openThrows: true });
  await call('PUT', '/api/auth/profile', PROFILE);
  assert.deepEqual(sentPaths(server), ['PUT /api/auth/profile']);
});

test('a change still waiting does not hold up a profile save', async () => {
  setOnline(true);
  const { mod, call, server, env } = await page({ seed: [WAITING] });
  assert.equal(await mod.pendingCount(), 1);
  const answer = await call('PUT', '/api/auth/profile', PROFILE);
  assert.equal(answer.user.role, 'admin');
  assert.deepEqual(sentPaths(server), ['PUT /api/auth/profile']);
  assert.deepEqual(env.outbox().map(o => o.key), ['setting:units'], 'what was waiting is still kept');
});

test('a change waiting and the store breaking: saves still reach the server', async () => {
  for (const [method, path, body] of [['PUT', '/api/auth/profile', PROFILE], ['PUT', '/api/settings', { key: 'theme', value: 'dark' }]]) {
    setOnline(true);
    const { mod, call, server, env } = await page({ seed: [WAITING] });
    assert.equal(await mod.pendingCount(), 1);
    env.broken = true;
    await call(method, path, body);
    assert.deepEqual(sentPaths(server), [`${method} ${path}`]);
    assert.equal(await mod.pendingCount(), 1, 'what was waiting is still counted');
  }
});

test('the queue keeps its order when it can still be read', async () => {
  setOnline(true);
  const { mod, call, server } = await page({ seed: [WAITING] });
  assert.equal(await mod.pendingCount(), 1);
  await call('PUT', '/api/settings', { key: 'theme', value: 'dark' });
  assert.equal(writes(server).length, 0, 'nothing sent ahead of what was waiting');
  assert.equal(await mod.pendingCount(), 2);
});

test('an earlier profile save still waiting goes, and the new one takes its place', async () => {
  setOnline(true);
  const older = { method: 'PUT', path: '/api/auth/profile', body: { ...PROFILE, nickname: 'Old' }, kind: 'profile', key: 'profile', at: 1 };
  const { mod, call, server, env } = await page({ seed: [older, WAITING] });
  assert.equal(await mod.pendingCount(), 2);
  await call('PUT', '/api/auth/profile', PROFILE);
  assert.deepEqual(writes(server).map(s => s[2]?.nickname), ['Lex']);
  assert.deepEqual(env.outbox().map(o => o.key), ['setting:units']);
});

test('with no Web Locks (plain http), a flush asked for during the save waits for it', async () => {
  setOnline(true);
  const older = { method: 'PUT', path: '/api/auth/profile', body: { ...PROFILE, nickname: 'Old' }, kind: 'profile', key: 'profile', at: 1 };
  const { mod, server, env } = await page({ seed: [older] });
  assert.equal(await mod.pendingCount(), 1);
  let land;
  const real = server._fetch.bind(server);
  const slow = { ...server, _fetch: (m, path, body) => (body?.nickname === 'Lex' ? new Promise(r => { land = () => r(real(m, path, body)); }) : real(m, path, body)) };
  const saving = mod.offlineFetch(slow, 'PUT', '/api/auth/profile', PROFILE);
  for (let i = 0; i < 200 && !land; i++) await new Promise(r => setImmediate(r));
  assert.ok(land, 'the new save went to the server');
  const flushing = mod.flushOutbox();
  land();
  await saving;
  await flushing;
  assert.deepEqual(writes(server).map(s => s[2]?.nickname), ['Lex'], 'the older save is never sent');
  assert.deepEqual(env.outbox(), []);
});

test('no connection and nowhere to keep it: the error says storage, not offline', async () => {
  for (const breakIt of [(env) => { env.full = true; }, (env) => { env.broken = true; }]) {
    setOnline(false);
    const { mod, call, server, env } = await page();
    await mod.pendingCount();
    breakIt(env);
    await assert.rejects(call('PUT', '/api/auth/profile', PROFILE), (err) => err.storage === true && !err.offline);
    assert.equal(writes(server).length, 0);
  }
  setOnline(true);
});

test('a save tried directly is never sent a second time when it can\'t be kept either', async () => {
  setOnline(true);
  const { mod, call, server, env } = await page();
  await mod.pendingCount();
  env.broken = true;
  server.fail = new Error('The operation was aborted due to timeout');
  await assert.rejects(call('PUT', '/api/settings', { key: 'theme', value: 'dark' }), (err) => err.storage === true);
  assert.equal(writes(server).length, 1);
});

test('the screens say this browser could not keep it, and Profile keeps who is signed in', async () => {
  const { readFileSync } = await import('node:fs');
  const messages = readFileSync(new URL('../src/lib/messages.js', import.meta.url), 'utf8');
  assert.match(messages, /if \(err\?\.storage\) return t\('fail\.not_kept'\);/);
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
  assert.ok(en.fail.not_kept);
  const profile = readFileSync(new URL('../src/routes/Profile.svelte', import.meta.url), 'utf8');
  assert.match(profile, /if \(data\?\.user\) currentUser\.set\(\{ \.\.\.get\(currentUser\), \.\.\.data\.user \}\);/);
});

// ── A server that takes the connection and never answers ─────────────
// Past a deadline it counts as no connection, as one that's gone does: a
// read answers from the copy (or says it needs a connection), a change goes
// into the queue, and while the server is quiet a change doesn't wait for it
// at all (lib/request-deadline.js).
const deadline = await import('../src/lib/request-deadline.js');
/** A server whose every answer runs out of time, saying how long each was given. */
function silentHttp() {
  const given = [];
  return {
    given,
    async _fetch(method, path, body, isUpload, deadlineMs) {
      given.push([method, String(path), deadlineMs ?? null]);
      throw deadline.noAnswerError(new DOMException('The operation timed out.', 'TimeoutError'));
    },
  };
}

test('a silent server: reads wait only so long, and changes go into the queue', async () => {
  setOnline(true);
  deadline.noteAnswered();
  const { mod, call } = await page();
  const silent = silentHttp();
  // A list read here before answers from that copy.
  await call('GET', '/api/shopping', undefined, { _fetch: async () => [{ id: 3, name: 'Eggs' }] });
  deadline.noteAnswered();
  assert.deepEqual((await call('GET', '/api/shopping', undefined, silent)).map(r => r.name), ['Eggs']);
  assert.deepEqual(silent.given.at(-1), ['GET', '/api/shopping', deadline.READ_MS]);
  // A read with no copy says it needs a connection, as with none, and soon.
  await assert.rejects(call('GET', '/api/recipes/shared-with-me', undefined, silent), (e) => e.offline === true);
  assert.deepEqual(silent.given.at(-1), ['GET', '/api/recipes/shared-with-me', deadline.QUIET_READ_MS], 'quiet now: shorter');
  // A change, while the server isn't known quiet: sent with no deadline
  // (one cut off might have landed), and queued once it fails.
  deadline.noteAnswered();
  const made = await call('POST', '/api/shopping', { name: 'Milk' }, silent);
  assert.equal(made.queued, true);
  assert.deepEqual(silent.given.at(-1), ['POST', '/api/shopping', null]);
  assert.equal(await mod.pendingCount(), 1);
  // Quiet now: the next change goes straight into the queue.
  const before = silent.given.length;
  await call('POST', '/api/shopping', { name: 'Bread' }, silent);
  assert.equal(silent.given.length, before, 'not sent while the server is quiet');
  assert.equal(await mod.pendingCount(), 2);
  deadline.noteAnswered();
});

test('server work with no offline answer waits as long as it takes', async () => {
  setOnline(true);
  deadline.noteAnswered();
  const { call } = await page();
  const given = [];
  const http = { async _fetch(method, path, body, isUpload, deadlineMs) { given.push(deadlineMs ?? null); return { ok: true }; } };
  await call('POST', '/api/kitchens', { name: 'Home' }, http);
  await call('POST', '/api/recipes/import-url', { url: 'https://example.com/r' }, http);
  assert.deepEqual(given, [null, null]);
});

test('the API layer stops waiting at the deadline it is given, and calls that no connection', async () => {
  const { readFileSync } = await import('node:fs');
  const api = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8');
  assert.match(api, /async _fetch\(method, path, body, isUpload = false, deadlineMs = null\)/);
  assert.match(api, /const res = await fetchWithDeadline\(/);
  assert.match(api, /\}, deadlineMs\);/);
});

