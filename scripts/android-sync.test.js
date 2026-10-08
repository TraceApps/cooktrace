/**
 * The Android app and the web editing the same recipes.
 *
 * Runs the app's own sync code (src/lib/sync.js, db-native.js,
 * api-native.js; Capacitor swapped for scripts/android-sync/) against a real
 * server started from server/index.js, one fresh server per scenario, with
 * the web saving through the REST API as the web app does. What it holds to:
 *
 *   - the newer of two edits stays, whatever the phone's clock says, and the
 *     other is kept as an earlier version; the phone ends up with what stayed;
 *   - an edit made on the copy still on the server always goes in, and
 *     nothing is kept when nothing conflicted;
 *   - a rating, a favorite or a cook logged on the phone doesn't put back
 *     content, a rating or a visibility changed on the web since, and cook
 *     counts follow the diary;
 *   - a delete is an edit at its time: an older edit doesn't bring a deleted
 *     recipe back, and is kept;
 *   - the phone's own push coming back doesn't undo a newer edit, with a
 *     slow clock and a slow network;
 *   - a phone takes the server's copy as its own only once it has it.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import * as nodeModule from 'node:module';
import test from 'node:test';

const root = new URL('../', import.meta.url);
let Database = null;
try {
  Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  new Database(':memory:').close(); // a build for another Node fails here
  createRequire(new URL('../package.json', import.meta.url)).resolve('svelte/store');
} catch { Database = null; }
const skip = Database && typeof nodeModule.register === 'function' ? false : 'needs the server and app dependencies, built for this Node';

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-android-sync-'));
  const port = await freePort();
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: new URL('server/', root),
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'app.db'), UPLOADS_PATH: join(dir, 'uploads'),
      JWT_SECRET: 'android-sync-test-secret-0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  proc.stderr.on('data', d => { errors += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { await fetch(base + '/api/auth/me'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
    if (i > 150) { proc.kill(); throw new Error('server did not start: ' + errors.slice(-500)); }
  }
  const reg = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'cook', password: 'Str0ng-Pass-88!y' }),
  });
  const token = reg.headers.getSetCookie().map(c => c.split(';')[0].split('=')[1]).find(v => v?.startsWith('eyJ'));
  assert.ok(token, 'signed in');
  // A second account, Bob, made by the admin. Sign-in is rate limited, so
  // his session is made the way the server makes one (signToken).
  const made = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username: 'bob', password: 'Str0ng-Pass-99!z' }),
  }).then(r => r.json());
  const jwt = createRequire(new URL('../server/package.json', import.meta.url))('jsonwebtoken');
  const tokenB = jwt.sign({ id: made.user?.id ?? made.id, username: 'bob', role: 'user', csrf: 'test' }, 'android-sync-test-secret-0123456789abcdef', { expiresIn: '1h' });
  return { base, token, tokenB, dbPath: join(dir, 'app.db'), stop: () => { proc.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* closing */ } } };
}

// A stuck scenario fails rather than holding up the run.
const PHONE_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;

function phone(srv, scenario, env = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${scenario} took longer than ${PHONE_TIMEOUT_MS / 1000}s`)); }, PHONE_TIMEOUT_MS);
    const p = spawn(process.execPath, ['--import', './scripts/android-sync/register.mjs', 'scripts/android-sync/phone.mjs', scenario], {
      cwd: root, env: { ...process.env, CT_SERVER: srv.base, CT_TOKEN: srv.token, CT_TOKEN_B: srv.tokenB, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      clearTimeout(timer);
      const at = out.lastIndexOf('\n@@');
      if (code !== 0 || at < 0) return reject(new Error(`${scenario} exited ${code}: ${err.slice(-800)}`));
      resolve(JSON.parse(out.slice(at + 3)));
    });
  });
}

async function run(scenario, env) {
  const srv = await startServer();
  try { return await phone(srv, scenario, env); } finally { srv.stop(); }
}

const MIN = 60_000;

for (const [clock, skew] of [['right', 0], ['10 minutes slow', -10 * MIN], ['10 minutes fast', 10 * MIN]]) {
  test(`an older phone edit doesn't replace a newer web edit (clock ${clock})`, { skip, timeout: TEST_TIMEOUT_MS }, async () => {
    const r = await run('olderPhone', { PHONE_SKEW_MS: String(skew) });
    assert.equal(r.server.name, 'Soup (web)');
    assert.equal(r.phone.name, 'Soup (web)', 'the phone has what stayed, in the same sync');
    assert.equal(r.phone.pending, false);
    assert.deepEqual(r.versions, ['Soup (phone)'], "the phone's edit is kept");
  });
  test(`a newer phone edit replaces an older web edit (clock ${clock})`, { skip, timeout: TEST_TIMEOUT_MS }, async () => {
    const r = await run('newerPhone', { PHONE_SKEW_MS: String(skew) });
    assert.equal(r.server.name, 'Soup (phone)');
    assert.equal(r.phone.name, 'Soup (phone)');
    assert.deepEqual(r.versions, ['Soup (web)'], "the web's edit is kept");
  });
}

test('edits only on the phone, or on a copy that has the web edit, keep nothing', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('noConflict', { PHONE_SKEW_MS: String(-10 * MIN) });
  assert.equal(r.server.name, 'Soup (phone4)', 'goes in whatever the clock says');
  assert.deepEqual(r.versions, []);
});

test('a rating, a favorite and a cook on the phone keep the web content', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('metaOnly');
  assert.deepEqual(r.server, { name: 'Soup (web)', rating: 4, favorite: true, visibility: 'private', cook_count: 1, servings: null });
  assert.equal(r.phone.name, 'Soup (web)');
  assert.equal(r.phone.rating, 4);
  assert.equal(r.phone.cook_count, 1);
  assert.deepEqual(r.versions, [], 'nothing conflicted');
});

test("a cook on the phone keeps the web's rating, favorite, visibility and cooks", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('cookAfterWeb');
  assert.equal(r.server.rating, 5);
  assert.equal(r.server.favorite, true);
  assert.equal(r.server.visibility, 'group');
  assert.equal(r.server.cook_count, 3, 'two cooks on the web and one on the phone');
  assert.equal(r.phone.cook_count, 3);
  assert.equal(r.phone.rating, 5);
  assert.deepEqual(r.versions, []);
});

test("an older phone edit doesn't bring back a recipe the web deleted later, and is kept", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const srv = await startServer();
  try {
    const r = await phone(srv, 'webDeletesLater');
    assert.equal(r.server, 'gone 404');
    assert.equal(r.phone.deleted, true, 'the phone drops it too');
    const db = new Database(srv.dbPath, { readonly: true });
    const kept = db.prepare('SELECT data FROM recipe_versions WHERE recipe_id = ?').all(r.id).map(v => JSON.parse(v.data).name);
    db.close();
    assert.deepEqual(kept, ['Soup (phone)']);
  } finally { srv.stop(); }
});

test('a phone edit made after the web deleted the recipe brings it back', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('phoneEditsAfterDelete');
  assert.equal(r.server.name, 'Soup (phone)');
  assert.equal(r.phone.deleted, false);
});

for (const [label, env] of [
  ['slow clock', { PHONE_SKEW_MS: String(-10 * MIN) }],
  ['slow clock and a slow network', { PHONE_SKEW_MS: String(-10 * MIN), PHONE_DELAY_MS: '1500' }],
  ['fast clock and a slow network', { PHONE_SKEW_MS: String(10 * MIN), PHONE_DELAY_MS: '1500' }],
]) {
  test(`the phone's own push coming back doesn't undo a newer edit (${label})`, { skip, timeout: TEST_TIMEOUT_MS }, async () => {
    const r = await run('echoCategory', env);
    assert.deepEqual({ server: r.server, phone: r.phone }, { server: 'Beta', phone: 'Beta' });
  });
}

test('other rows merge field by field: checked off on the phone, renamed on the web', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('shoppingFields');
  assert.deepEqual(r.server, { name: 'Oat Milk', checked: true });
  assert.deepEqual(r.phone, { name: 'Oat Milk', checked: true });
});

test('an edit keeps the time it was made, even if the clock is set right before the sync', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('clockFixedBeforePush', { PHONE_SKEW_MS: String(-10 * MIN) });
  assert.equal(r.server.name, 'Soup (phone)', "the phone's edit, made after the web's, stays");
  assert.deepEqual(r.versions, ['Soup (web)']);
});

test("the phone takes the server's copy as its own only once it has it", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('repullFails');
  assert.equal(r.firstSync, 'failed');
  assert.equal(r.stampKept, true, 'the failed pull leaves the stamp of the copy it has');
  assert.equal(r.phoneAfterFail, 'Soup (phone)');
  assert.equal(r.phoneAfter, 'Soup (web)', 'the next sync brings it down');
  assert.equal(r.stampMoved, true);
  assert.equal(r.server, 'Soup (web)');
});

// ── Accounts on one phone, and syncs that run at once ────────────────────
const ownersOf = (srv, name) => {
  const db = new Database(srv.dbPath, { readonly: true });
  try { return db.prepare(`SELECT u.username FROM recipes r JOIN users u ON u.id = r.user_id WHERE r.name = ? AND r.deleted_at IS NULL`).all(name).map(x => x.username); }
  finally { db.close(); }
};

test("another account signing in neither sees nor sends the last one's data; saying no keeps it for them", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const srv = await startServer();
  try {
    const r = await phone(srv, 'accountSwitch');
    assert.equal(r.early, 'other_account', 'no sync before the app has checked');
    assert.equal(r.no, false, 'saying no undoes the sign-in');
    assert.equal(r.asked, 1, 'asked, with the count of changes waiting');
    assert.deepEqual(ownersOf(srv, 'Alice Waiting'), ['cook'], "Alice's change went up as hers, once");
    assert.equal(r.yes, true);
    assert.equal(r.leftAfterClear, 0, "nothing of Alice's left on the phone");
    assert.deepEqual(r.bobPhone, ['Bob Web Soup'], 'Bob sees his own, and only his');
    assert.deepEqual(ownersOf(srv, 'Alice Discarded'), [], 'discarded only after saying so, never sent as Bob');
    assert.deepEqual(r.same, true);
    assert.equal(r.askedBob, false, 'the same account back: nothing asked');
    assert.deepEqual(ownersOf(srv, 'Bob Waiting'), ['bob']);
  } finally { srv.stop(); }
});

test('a sync running when another account signs in stops, and writes nothing after the clear', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('switchDuringSync');
  assert.equal(r.yes, true);
  assert.equal(r.run, 'stopped');
  assert.equal(r.leftAfterClear, 0);
  assert.deepEqual(r.bobPhone, []);
});

test("signing out sends what's waiting with its own session, and never under the next account's", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('signOutMidPush');
  assert.ok(r.took < 5500, `sign-out waited ${r.took} ms`);
  assert.deepEqual(r.pushes, ['alice (cut off)'], 'one push, as Alice, cut off when sign-out stopped waiting');
  assert.equal(r.bobSync, 'other_account', "Bob's session sends nothing before the check");
  assert.equal(r.aliceSoupOnServer, 0, 'what was cut off stays on the phone for Alice');
});

test('every sync trigger at once runs one sync: a new recipe is made once, and an edit made meanwhile goes up after', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('syncTriggersAtOnce');
  assert.equal(r.overlapping, false, 'no two pushes or pulls at once');
  assert.deepEqual(r.server, ['edited while syncing'], 'one recipe on the server, with the edit');
  assert.equal(r.phone, 1, 'one on the phone');
  assert.ok(r.pushes <= 2, `${r.pushes} pushes`);
});

test('a push whose answer was lost sends the new recipe again, and it is still one recipe', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('lostAnswer');
  assert.equal(r.first, false);
  assert.equal(r.server, 1);
  assert.deepEqual(r.phone, [true]);
});

test("if the phone can't tell whose data it holds, it shows none of it, and Retry works", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('gateError');
  assert.deepEqual({ first: r.first, state: r.state, shown: r.shown }, { first: false, state: 'error', shown: false });
  assert.deepEqual({ second: r.second, shownAfter: r.shownAfter }, { second: true, shownAfter: true });
  assert.deepEqual(r.together, [true, true]);
});

test('Disconnect, use the phone alone, connect as another account with Upload: no question, every row once', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('disconnectUpload');
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.asked, null, 'Upload made the copy this account\'s');
  assert.equal(r.madeAtKept, true, "a pull keeps when the phone made its row: it's part of the row's key");
  assert.deepEqual(r.bobServer, ['Alice Synced', 'Made Alone'], 'each once, even after the upload ran twice');
  assert.deepEqual(r.bobPhone, ['Alice Synced', 'Made Alone']);
  assert.deepEqual(r.serverCatDupes, [], "the account's categories are matched, not made twice");
  assert.deepEqual(r.phoneCats, r.serverCats, 'the phone has the same categories, and its pulls go through');
});

test('the same server at another address is the same account; one that cannot tell is asked', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('otherAddress');
  assert.equal(r.sameServer, true);
  assert.equal(r.askedSame, false, 'the server named itself: nothing to ask');
  assert.deepEqual(r.keptSame, ['Kept Soup']);
  assert.equal(r.saidYes, true);
  assert.equal(r.keptYes, 1, '"Same Server" keeps the data');
  assert.equal(r.saidNo, true);
  assert.equal(r.keptNo, 0, '"Different Server" treats it as another account\'s');
  assert.equal(r.questions, 2);
});

test('the first sync tells the pages it brought data down, so the list shows it at once', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('firstSyncTellsPages');
  assert.equal(r.told.length, 2);
  assert.ok(r.told[0].ok && r.told[0].changed > 0, JSON.stringify(r.told));
  assert.equal(r.told[1].changed, 0, 'nothing new, nothing to read again');
});

test("settings are kept per account and server: another account never reads the last one's", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('settingsPerAccount');
  assert.equal(r.bobReads, null);
  assert.equal(r.aliceReads, 'alice-key');
  assert.equal(r.keys.length, 1);
  assert.match(r.keys[0], /^wl_u\d+@127\.0\.0\.1-\d+_aiApiKey$/);
});

test("the phone's cookie jar never speaks for the previous account", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('cookieJar');
  assert.equal(typeof r.jarAfterLogin[r.host].ct_token, 'string', 'the sign-in cookie is in the jar, as on Android');
  assert.equal(typeof r.jarAfterLogin['app.cooktrace.local'].ct_token, 'string', "and its copy at the app's own address");
  assert.equal(r.serverSays, 'bob', "Bob's session, with Alice's cookie still sent alongside, is Bob");
  assert.equal(r.yes, true);
  assert.deepEqual(r.jarAfterSwitch, { [r.host]: { authelia_session: 'gate' }, 'app.cooktrace.local': {}, 'gate.example.com': { CF_Authorization: 'gate' } },
    "only CookTrace's cookies go, at the server and at the app's own address; a gate's stay");
  assert.deepEqual(r.bobPhone, ['Bob Only']);
});

test("our bearer token decides the session, never another account's cookie; anyone else's bearer leaves the web on its cookie", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const srv = await startServer();
  try {
    const jwt = createRequire(new URL('../server/package.json', import.meta.url))('jsonwebtoken');
    const secret = 'android-sync-test-secret-0123456789abcdef';
    const expired = jwt.sign({ id: 2, username: 'bob', role: 'user', csrf: 'x', exp: Math.floor(Date.now() / 1000) - 60 }, secret);
    const idp = jwt.sign({ sub: 'someone', email: 'a@example.com' }, 'the-identity-providers-own-key');
    const cookie = `ct_token=${srv.token}`;
    const me = async headers => (await (await fetch(srv.base + '/api/auth/me', { headers })).json()).user?.username ?? null;
    assert.equal(await me({ Authorization: `Bearer ${srv.tokenB}`, Cookie: cookie }), 'bob', "our bearer's account, not the cookie's");
    assert.equal(await me({ Authorization: `Bearer ${expired}`, Cookie: cookie }), null, 'our expired bearer is no session, never the cookie');
    assert.equal(await me({ Authorization: `Bearer ${idp}`, Cookie: cookie }), 'cook', "a proxy's or identity provider's bearer: the web's cookie");
    assert.equal(await me({ Authorization: 'Bearer opaque-proxy-token', Cookie: cookie }), 'cook');
    assert.equal(await me({ Cookie: cookie }), 'cook', 'the web signs in with its cookie alone');
    assert.equal(await me({ Authorization: `Bearer ${idp}` }), null);
    // Changes: the cookie session needs its CSRF token, whatever bearer comes along.
    const csrf = (await (await fetch(srv.base + '/api/auth/me', { headers: { Cookie: cookie } })).json()).csrf;
    const post = headers => fetch(srv.base + '/api/shopping', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ name: 'Milk' }) }).then(r => r.status);
    assert.equal(await post({ Authorization: `Bearer ${idp}`, Cookie: cookie }), 403, "someone else's bearer doesn't skip the cookie's CSRF check");
    assert.equal(await post({ Authorization: 'Bearer opaque-proxy-token', Cookie: cookie }), 403);
    assert.equal(await post({ Authorization: `Bearer ${idp}`, Cookie: cookie, 'X-CSRF-Token': csrf }), 201);
    assert.equal(await post({ Cookie: cookie }), 403, 'the web without its CSRF token, as before');
    assert.equal(await post({ Cookie: cookie, 'X-CSRF-Token': csrf }), 201, 'the web with it');
    assert.equal(await post({ Authorization: `Bearer ${srv.tokenB}`, Cookie: cookie }), 201, 'our bearer needs none');
    // The API signs in by its own API token: never stopped for CSRF, as before.
    const api = await fetch(srv.base + '/api/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ct_not_a_real_token', Cookie: cookie }, body: '{}' });
    assert.notEqual(api.status, 403, 'the API answers by its own token, not the CSRF check');
  } finally { srv.stop(); }
});

test('an account cached before a Disconnect is never taken for the one now signed in', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('cachedAccount');
  assert.notEqual(r.atOnce, 'cook', "Alice's cached account isn't checked against the phone's copy");
  assert.equal(r.afterServer, 'bob');
});

// ── Review round: restored copies, links, waiting settings, names ───────
test('a phone restored from another phone\'s backup gets its own install id: rows with the same local id stay two rows', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const srv = await startServer();
  const dir = mkdtempSync(join(tmpdir(), 'ct-clone-'));
  try {
    const A = { PHONE_DB: join(dir, 'a'), PHONE_MARKER: join(dir, 'a.marker') };
    const B = { PHONE_DB: join(dir, 'b'), PHONE_MARKER: join(dir, 'b.marker') };
    const a1 = await phone(srv, 'cloneMake', { ...A, RECIPE_NAME: 'Before Backup' });
    // Phone B: phone A's database, put back from a backup (the marker isn't in it).
    copyFileSync(join(dir, 'a-cooktrace_local.db'), join(dir, 'b-cooktrace_local.db'));
    const a2 = await phone(srv, 'cloneMake', { ...A, RECIPE_NAME: 'Phone A Soup' });
    const b1 = await phone(srv, 'cloneMake', { ...B, RECIPE_NAME: 'Phone B Stew' });
    assert.equal(b1.localId, a2.localId, 'both made a row with the same local id');
    const db = new Database(srv.dbPath, { readonly: true });
    const names = db.prepare(`SELECT name FROM recipes WHERE name IN ('Phone A Soup', 'Phone B Stew') ORDER BY name`).all().map(r => r.name);
    db.close();
    assert.deepEqual(names, ['Phone A Soup', 'Phone B Stew'], 'both rows on the server, neither merged into the other');
    assert.ok(a2.serverId && b1.serverId && a2.serverId !== b1.serverId, 'each phone has its own');
    assert.equal(a2.install, a1.install, 'the same phone keeps its id across runs');
    assert.notEqual(b1.install, a1.install, 'the restored copy takes a new one');
  } finally { srv.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('Upload sends every link as the server\'s id, and the phone keeps its links after the first pull', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('uploadLinks');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.server, { variantParentIsMilk: true, sourceIsOat: true, shoppingIsOat: true, ingredientIsOat: true });
  assert.deepEqual(r.phone, { variantParentIsMilk: true, sourceIsOat: true, shoppingIsOat: true, counts: { milk: 1, oat: 1 } });
});

test("another account's pantry item, recipe or category is never linked, nor read through a link", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const srv = await startServer();
  try {
    const call = async (tok, method, path, body) => {
      const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text();
      return { status: r.status, body: t ? JSON.parse(t) : null };
    };
    const A = srv.token, B = srv.tokenB;
    const cat = (await call(A, 'POST', '/api/pantry/categories', { name: 'Alice Aisle Cat', default_aisle: 'Alice Secret Aisle' })).body;
    const item = (await call(A, 'POST', '/api/pantry', { name: 'Alice Truffle', category_id: cat.id })).body;
    const rcat = (await call(A, 'POST', '/api/recipes/categories', { name: 'Alice Only' })).body;
    const recipe = (await call(A, 'POST', '/api/recipes', { name: 'Alice Private', ingredients: [], steps: [] })).body;
    const shop = (await call(B, 'POST', '/api/shopping', { name: 'Truffle', pantry_id: item.id, recipe_id: recipe.id })).body;
    assert.equal(shop.pantry_id, null, "another account's pantry item is no link");
    assert.equal(shop.recipe_id, null, "nor another account's recipe");
    assert.notEqual(shop.aisle, 'Alice Secret Aisle', "and its aisle isn't read");
    const own = (await call(B, 'POST', '/api/pantry', { name: 'Bob Item' })).body;
    const put = await call(B, 'PUT', `/api/shopping/${shop.id}`, { pantry_id: item.id });
    assert.equal(put.body.pantry_id, null);
    const variant = (await call(B, 'POST', '/api/pantry', { name: 'Bob Variant', generic_parent_id: item.id, nutrition_source_variant_id: item.id, category_id: cat.id })).body;
    assert.deepEqual([variant.generic_parent_id, variant.nutrition_source_variant_id, variant.category_id], [null, null, null]);
    assert.equal((await call(B, 'PUT', `/api/pantry/${own.id}`, { generic_parent_id: item.id })).status, 400, "another account's item can't be a parent");
    assert.equal((await call(B, 'POST', '/api/cook-diary', { recipe_id: recipe.id, date: '2026-10-07', kind: 'cooked' })).status, 404, "nor a recipe to log a cook of");
    const bobRecipe = (await call(B, 'POST', '/api/recipes', { name: 'Bob Soup', category_id: rcat.id, ingredients: [], steps: [] })).body;
    assert.equal(bobRecipe.category_id ?? null, null, "nor a recipe category");
    // A link stored before this check (an older upload) reads nothing of Alice's.
    const db = new Database(srv.dbPath);
    db.prepare(`UPDATE shopping_list SET pantry_id = ?, recipe_id = ? WHERE id = ?`).run(item.id, recipe.id, shop.id);
    db.close();
    const list = (await call(B, 'GET', '/api/shopping')).body;
    const row = (Array.isArray(list) ? list : list.items).find(x => x.id === shop.id);
    assert.equal(row.pantry_name ?? null, null, "the list doesn't show another account's pantry item");
    assert.equal(row.recipe_name ?? null, null, "or recipe");
    // Its own links still work.
    const ok = (await call(B, 'POST', '/api/shopping', { name: 'Bob Item', pantry_id: own.id })).body;
    assert.equal(ok.pantry_id, own.id);
  } finally { srv.stop(); }
});

test('a setting changed here and not yet sent counts as a change waiting when another account signs in', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('settingWaits');
  assert.deepEqual(r, { ok: false, asked: 1, ownOk: true, askedAgain: null }, "the last account's setting counts; the new account's own start-up settings don't");
});

test('a category edited here whose name another device moved to another category: pulls go through, the edit goes up', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('categoryNameMoved');
  assert.deepEqual(r.syncs, ['ok', 'ok']);
  assert.deepEqual(r.server, [{ slug: 'soups', color: null }, { slug: 'stews', color: '#ff0000' }], 'the edit went up to the renamed category');
  assert.deepEqual(r.phone, [{ slug: 'soups', color: null, sync_status: 'synced' }, { slug: 'stews', color: '#ff0000', sync_status: 'synced' }]);
});

test('switching accounts while pictures download does not wait for them', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('switchDuringImages');
  assert.equal(r.yes, true);
  assert.ok(r.switchMs < 3000, `the switch took ${r.switchMs} ms`);
  assert.equal(r.run, 'stopped', JSON.stringify(r.sent));
});

test('started offline with a cached account the session is not for: the sign-in screen', { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('cachedAccountOffline');
  assert.deepEqual(r, { user: null, userMgmt: true });
});

test("the pictures of the account's recipes are found for keeping offline", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('imagesFound');
  assert.ok(r.total >= 1, `found ${r.total}`);
});

test("an ingredient's pantry link is the server's id on the server and the phone's own on the phone", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const r = await run('ingredientLinks');
  assert.equal(r.idsDiffer, true, "the item's id differs on each side");
  assert.deepEqual(r.made.server, r.made.want, 'a recipe made on the phone links the right items on the server, a new item included');
  assert.equal(r.edited.server, r.edited.want, 'an offline edit of the link too');
  assert.deepEqual(r.phoneAfter.got, r.phoneAfter.want, 'the phone keeps its own ids after the sync');
  assert.deepEqual(r.fromWeb.got, r.fromWeb.want, "a recipe from the web links the phone's own item");
});

test("a recipe's ingredient can't link another account's pantry item", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const srv = await startServer();
  try {
    const call = async (tok, method, path, body) => {
      const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined });
      return r.json();
    };
    const theirs = await call(srv.token, 'POST', '/api/pantry', { name: 'Alice Saffron' });
    const mine = await call(srv.tokenB, 'POST', '/api/pantry', { name: 'Bob Rice' });
    const link = r => r.ingredients[0].items.map(i => i.pantry_item_id ?? null);
    const made = await call(srv.tokenB, 'POST', '/api/recipes', { name: 'Paella', ingredients: [{ items: [{ name: 'saffron', pantry_item_id: theirs.id }, { name: 'rice', pantry_item_id: mine.id }] }], steps: ['Cook'] });
    assert.deepEqual(link(made), [null, mine.id], "another account's item is no link; your own stays");
    const edited = await call(srv.tokenB, 'PUT', `/api/recipes/${made.id}`, { ...made, ingredients: [{ items: [{ name: 'saffron', pantry_item_id: theirs.id }] }] });
    assert.deepEqual(link(edited), [null]);
    const pushed = await call(srv.tokenB, 'POST', '/api/sync/push', { fk_ids: 'server', client_now: new Date().toISOString(), tables: { recipes: [{ client_id: 1, server_id: null, name: 'Pushed', ingredients: JSON.stringify([{ items: [{ name: 'saffron', pantry_item_id: theirs.id }] }]), steps: '[]', tags: '[]', tools: '[]', nutrition: '{}', visibility: 'private', cook_count: 0, favorite: 0, servings: 2, updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19), edit_clock: 'server' }] } });
    const got = await call(srv.tokenB, 'GET', `/api/recipes/${pushed.tables.recipes[0].server_id}`);
    assert.deepEqual(link(got), [null], 'nor through a sync');
  } finally { srv.stop(); }
});
