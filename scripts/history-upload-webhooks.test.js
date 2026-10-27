/**
 * Webhooks and the Android app's Upload, against the real server
 * (server/index.js on a scratch database) and a local receiver that checks
 * each delivery's signature.
 *
 * A phone used without a server keeps its recipes, pantry, cook diary and
 * shopping list on the phone. When it connects to a server, Upload
 * (src/lib/migrate.js) sends them through the app's own routes, one POST
 * per row. Every cooked entry in the diary went through POST
 * /api/cook-diary, which sent meal.cooked as if it had just been cooked:
 * a year of cooking was a meal.cooked per meal.
 *
 * Now an Upload's cooks send none. The app marks them `history_upload`;
 * the 1.4.1 app, which doesn't, is known by the key its Upload gives every
 * row (`<install>:cook_diary:<id>`), which only Upload sends to that route
 * (the sync sends its keys to /api/sync/push). A cook logged now, from the
 * web, the phone or the watch, still sends once.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
// Opened, not just required: a binding built for another Node version
// loads only when a database opens.
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

const PW = 'Str0ng-Pass-77!x';
const EVENTS = ['meal.cooked', 'shopping_list.completed', 'pantry.out_of_stock'];
let proc = null, base = null, dir = null, receiver = null, hookUrl = null;
const secrets = new Set();
const deliveries = [];

async function call(auth, method, path, body) {
  const h = { 'Content-Type': 'application/json' };
  if (auth) h.Authorization = `Bearer ${auth}`;
  const r = await fetch(base + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

// Every delivery `fn` caused, by event. Delivery is fire-and-forget, so
// this waits for the receiver to go quiet.
async function sent(fn) {
  const from = deliveries.length;
  const out = await fn();
  let last = -1;
  for (let i = 0; i < 40 && deliveries.length !== last; i++) { last = deliveries.length; await sleep(150); }
  const got = deliveries.slice(from);
  for (const d of got) assert.ok(d.signed, `${d.event} delivery carries a valid signature`);
  const count = Object.fromEntries(EVENTS.map(e => [e, got.filter(d => d.event === e).length]));
  return { out, got, count, total: got.length };
}

// A new account with a webhook for every event. The first account
// registers itself (and is an admin, as webhooks need); it makes the rest
// as admins.
let n = 0, admin = null;
async function account() {
  const username = `cook${++n}`;
  const reg = await call(admin, 'POST', '/api/auth/register', { username, password: PW, role: 'admin' });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const login = await call(null, 'POST', '/api/auth/login', { username, password: PW });
  const token = login.data.token;
  assert.ok(token, JSON.stringify(login.data));
  if (!admin) admin = token;
  const hook = await call(token, 'POST', '/api/admin/webhooks', { url: `${hookUrl}/hook`, events: EVENTS });
  assert.ok(hook.data.secret, JSON.stringify(hook.data));
  secrets.add(hook.data.secret);
  return token;
}

const INSTALL = '3f1c9a52-7d4e-4b8a-9c11-0e2f6a7b8c9d';
// db-native.js createKeyOf: this install, the table and the row's id here.
const key = (table, row) => `${INSTALL}:${table}:${row.id}${row.created_at ? `@${row.created_at}` : ''}`;

// The phone's data as migrate.js reads it: a recipe and a pantry item it
// uses (out of stock), eight cooks of it and two planned ones, and a
// shopping list with everything ticked.
function history() {
  const recipe = { id: 1, name: 'Tacos', servings: 4, ingredients: [], instructions: [], created_at: '2026-01-01 10:00:00' };
  const pantry = [{ id: 1, name: 'Tortillas', in_stock: 0, quantity: 0, created_at: '2026-01-01 10:00:00' }];
  const diary = [];
  for (let i = 1; i <= 10; i++) {
    const date = `2026-02-${String(i).padStart(2, '0')}`;
    diary.push({ id: i, recipe_id: 1, date, kind: i <= 8 ? 'cooked' : 'planned', servings: 2, rating: 4, meal_type: 'dinner', notes: null, created_at: `${date} 19:00:00` });
  }
  const shopping = [1, 2, 3].map(i => ({ id: i, name: `Item ${i}`, checked: 1, created_at: '2026-02-11 09:00:00' }));
  return { recipe, pantry, diary, shopping };
}

// Upload as migrate.js sends it: pantry, recipe, cook diary, shopping
// list, each row with its key. `marked`: this app marks the cooks
// (history_upload); 1.4.1's Upload doesn't. `keyed`: false for an app
// whose Upload sends no keys (before 1.4.1).
async function upload(token, h, { marked = true, keyed = true } = {}) {
  const k = (table, row) => (keyed ? { client_key: key(table, row) } : {});
  for (const p of h.pantry) {
    const { id, created_at, ...rest } = p;
    const r = await call(token, 'POST', '/api/pantry', { ...rest, ...k('pantry_items', p) });
    assert.ok(r.status < 300, JSON.stringify(r.data));
  }
  const { id: _rid, created_at: _rc, ...recipe } = h.recipe;
  const made = await call(token, 'POST', '/api/recipes', { ...recipe, ...k('recipes', h.recipe) });
  assert.ok(made.status < 300 && made.data.id, JSON.stringify(made.data));
  for (const d of h.diary) {
    const { id, created_at, ...rest } = d;
    const r = await call(token, 'POST', '/api/cook-diary', {
      ...rest, ...k('cook_diary', d), recipe_id: made.data.id, ...(marked ? { history_upload: true } : {}),
    });
    assert.ok(r.status < 300, JSON.stringify(r.data));
  }
  for (const s of h.shopping) {
    const { id, created_at, ...rest } = s;
    const r = await call(token, 'POST', '/api/shopping', { ...rest, ...k('shopping_list', s), recipe_id: made.data.id });
    assert.ok(r.status < 300, JSON.stringify(r.data));
  }
  return made.data.id;
}

test.before(async () => {
  if (!ready) return;
  dir = mkdtempSync(join(tmpdir(), 'ct-history-upload-'));
  const hookPort = await freePort();
  hookUrl = `http://127.0.0.1:${hookPort}`;
  receiver = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let env = {};
      try { env = JSON.parse(raw); } catch { /* counted as unsigned below */ }
      const sig = req.headers['x-cooktrace-signature'];
      const signed = [...secrets].some(s => sig === `sha256=${createHmac('sha256', s).update(raw).digest('hex')}`);
      deliveries.push({ event: env.event, data: env.data, signed });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => receiver.listen(hookPort, '127.0.0.1', r));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: {
      ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'ct.db'), UPLOADS_PATH: join(dir, 'uploads'),
      BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'history-upload-test-0123456789abcdef0123',
      INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off',
      WEBHOOKS_ENABLED: '1', ALLOW_PRIVATE_WEBHOOK_URLS: '1', API_RATE_LIMIT_PER_MIN: '1000',
    },
    stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    if (proc.exitCode != null) throw new Error('server exited at startup');
    if (i >= 300) throw new Error('server did not start');
    try { if ((await fetch(base + '/api/auth/status')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
});

test.after(async () => {
  if (proc) {
    const p = proc; proc = null;
    await new Promise((r) => { if (p.exitCode != null || p.signalCode != null) return r(); p.once('exit', r); p.kill(); });
  }
  if (receiver) await new Promise((r) => receiver.close(r));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const opts = { skip: !ready && 'server packages not installed' };
const none = Object.fromEntries(EVENTS.map(e => [e, 0]));

test('Upload of a phone\'s cook diary sends no webhooks, and uploading again sends none', opts, async () => {
  const token = await account();
  const h = history();
  const first = await sent(() => upload(token, h));
  assert.deepEqual(first.count, none, 'the first Upload');
  const recipeId = first.out;
  const again = await sent(() => upload(token, h));
  assert.deepEqual(again.count, none, 'the same Upload again');
  // It all went up.
  const diary = (await call(token, 'GET', '/api/cook-diary')).data;
  assert.equal(diary.filter(d => d.kind === 'cooked').length, 8);
  // A cook logged now, after the Upload, still sends once.
  const next = await sent(() => call(token, 'POST', '/api/cook-diary', { recipe_id: recipeId, date: '2026-03-01', kind: 'cooked' }));
  assert.equal(next.out.status, 201, JSON.stringify(next.out.data));
  assert.deepEqual(next.count, { ...none, 'meal.cooked': 1 });
});

test('Upload from the 1.4.1 app (not marked, keyed) sends no meal.cooked', opts, async () => {
  const token = await account();
  const first = await sent(() => upload(token, history(), { marked: false }));
  assert.deepEqual(first.count, none);
});

test('a cook logged now sends once: the web, the watch, marking a plan cooked', opts, async () => {
  const token = await account();
  const recipe = (await call(token, 'POST', '/api/recipes', { name: 'Soup', ingredients: [], instructions: [] })).data;
  const web = await sent(() => call(token, 'POST', '/api/cook-diary', { recipe_id: recipe.id, date: '2026-05-01', kind: 'cooked', servings: 2 }));
  assert.equal(web.count['meal.cooked'], 1);
  // The watch sends only the recipe, the date and the kind.
  const watch = await sent(() => call(token, 'POST', '/api/cook-diary', { recipe_id: recipe.id, date: '2026-05-02', kind: 'cooked' }));
  assert.equal(watch.count['meal.cooked'], 1);
  const plan = await call(token, 'POST', '/api/cook-diary', { recipe_id: recipe.id, date: '2026-05-03', kind: 'planned' });
  assert.equal(plan.status, 201);
  const cooked = await sent(() => call(token, 'PUT', `/api/cook-diary/${plan.data.id}`, { kind: 'cooked' }));
  assert.equal(cooked.count['meal.cooked'], 1);
  // A key of any other shape, or a value other than true, is no Upload.
  const other = await sent(() => call(token, 'POST', '/api/cook-diary', { recipe_id: recipe.id, date: '2026-05-04', kind: 'cooked', client_key: 'f00d-cook', history_upload: 'yes' }));
  assert.equal(other.count['meal.cooked'], 1);
});

test('the app\'s Upload marks its cooks as history', () => {
  const src = readFileSync(new URL('../src/lib/migrate.js', import.meta.url), 'utf8');
  const at = src.indexOf('`${serverUrl}/api/cook-diary`');
  assert.ok(at > 0, 'the cook diary POST');
  const post = src.slice(at, src.indexOf('});', at));
  assert.match(post, /history_upload: true/, 'the cooks go up marked');
});

// A cook as the app's sync push sends it (src/lib/sync.js pushChanges): its
// id here as client_id, its key, the recipe's server id.
function pushCook(d, recipeId, { marked = false } = {}) {
  const { id, ...row } = d;
  return { ...row, recipe_id: recipeId, client_id: id, server_id: null, client_key: key('cook_diary', d), ...(marked ? { history_upload: true } : {}) };
}
async function push(token, rows) {
  const r = await call(token, 'POST', '/api/sync/push', { tables: { cook_diary: rows }, settings: [], fk_ids: 'server', client_now: new Date().toISOString() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(Array.isArray(r.data.tables?.cook_diary), JSON.stringify(r.data));
  return r.data;
}

test('cooks an Upload left to the sync, marked, send no meal.cooked; a new cook through the sync sends once', opts, async () => {
  const token = await account();
  const recipe = (await call(token, 'POST', '/api/recipes', { name: 'Stew', ingredients: [], instructions: [] })).data;
  const h = history();
  const left = await sent(() => push(token, h.diary.slice(0, 8).map(d => pushCook(d, recipe.id, { marked: true }))));
  assert.deepEqual(left.count, none, 'the cooks the Upload left');
  assert.equal(left.out.tables.cook_diary.length, 8, 'all went in');
  // A cook logged on the connected phone, keyed as every new row is.
  const now = await sent(() => push(token, [pushCook({ id: 50, date: '2026-04-01', kind: 'cooked', created_at: '2026-04-01 19:00:00' }, recipe.id)]));
  assert.deepEqual(now.count, { ...none, 'meal.cooked': 1 });
  // A plan left by the Upload, sent as a plan, then marked cooked on the phone.
  const plan = await push(token, [pushCook({ id: 51, date: '2026-04-02', kind: 'planned', created_at: '2026-04-02 09:00:00' }, recipe.id)]);
  const serverId = plan.tables.cook_diary[0].server_id;
  const cooked = await sent(() => push(token, [{ client_id: 51, server_id: serverId, recipe_id: recipe.id, date: '2026-04-02', kind: 'cooked', updated_at: new Date().toISOString() }]));
  assert.deepEqual(cooked.count, { ...none, 'meal.cooked': 1 });
});

test('the app marks only the cooks an Upload left, noted when the phone connects', () => {
  const dbn = readFileSync(new URL('../src/lib/db-native.js', import.meta.url), 'utf8');
  const keep = dbn.slice(dbn.indexOf('export async function dbKeepForNewServer'), dbn.indexOf('export function dbInstallId'));
  assert.match(keep, /kind = 'cooked'/, 'the cooks cooked by then');
  assert.match(keep, /HISTORY_COOKS/, 'noted');
  const sync = readFileSync(new URL('../src/lib/sync.js', import.meta.url), 'utf8');
  const fn = sync.slice(sync.indexOf('async function pushChanges'), sync.indexOf('async function pullChanges'));
  assert.match(fn, /table === 'cook_diary' && !row\.server_id && historyCooks\.has\(/, 'only a cook going up as new, and one of those');
});
