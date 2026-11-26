/**
 * An access audit after cooktrace#110: what a recipe's sharing allows
 * holds everywhere. A cookbook shows a recipe only while its owner can
 * still open it; a plan stops copying a recipe once it isn't shared; and
 * owning a recipe doesn't let you change someone else's cook of it.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';

const root = new URL('../', import.meta.url);
let Database = null;
try {
  Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  new Database(':memory:').close();
} catch { Database = null; }
const skip = Database ? false : 'needs the server dependencies, built for this Node';

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

async function boot(dir, env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: new URL('server/', root),
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'app.db'), UPLOADS_PATH: join(dir, 'uploads'),
      JWT_SECRET: 'access-audit-test-secret--0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', MCP_ENABLED: '1', MCP_WRITE_ENABLED: '1', MCP_DESTROY_ENABLED: '1', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  proc.stderr.on('data', d => { errors += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { await fetch(base + '/api/auth/me'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
    if (i > 150) { proc.kill(); throw new Error('server did not start: ' + errors.slice(-500)); }
  }
  return { base, stop: () => new Promise(r => { proc.on('exit', r); proc.kill(); }) };
}



// Two accounts and a way to call the API as each.
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-access-'));
  const srv = await boot(dir);
  const call = async (method, path, body, who) => {
    const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Cookie: `ct_token=${who.jwt}`, 'X-CSRF-Token': who.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    let json = null; try { json = JSON.parse(t); } catch { /* not json */ }
    return { status: r.status, body: json };
  };
  const login = async (username, password, admin) => {
    const reg = await call('POST', '/api/auth/register', { username, password }, admin);
    assert.ok(reg.status < 300, `register ${username}: ${reg.status}`);
    const l = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const jwt = l.headers.getSetCookie().map(c => c.split(';')[0].split('=')[1]).find(v => v?.startsWith('eyJ'));
    const me = await fetch(srv.base + '/api/auth/me', { headers: { Cookie: `ct_token=${jwt}` } }).then(r => r.json());
    return { jwt, csrf: me.csrf, id: me.user.id };
  };
  const a = await login('alex', 'Str0ng-Pass-88!y');
  const b = await login('bea', 'Str0ng-Pass-77!z', a);
  const recipe = async (who, name, ingredient) => (await call('POST', '/api/recipes', { name, servings: 2, ingredients: [{ title: '', items: [{ name: ingredient, qty: '1', unit: 'cup' }] }], steps: [{ title: '', text: 'Cook.' }] }, who)).body;
  const stop = async () => { await srv.stop(); rmSync(dir, { recursive: true, force: true }); };
  return { call, a, b, recipe, stop };
}

test("a cookbook's owner sees a recipe only while they can open it", { skip, timeout: 90000 }, async () => {
  const t = await setup();
  try {
    const own = await t.recipe(t.a, 'Alex Soup', 'leek');
    const beas = await t.recipe(t.b, 'Bea Secret Stew', 'saffron');
    assert.equal((await t.call('POST', `/api/recipes/${beas.id}/shares`, { user_ids: [t.a.id] }, t.b)).status, 200);
    const book = (await t.call('POST', '/api/cookbooks', { name: 'Mine' }, t.a)).body;
    assert.equal((await t.call('POST', `/api/cookbooks/${book.id}/recipes`, { recipe_ids: [own.id, beas.id] }, t.a)).body.added, 2);
    const open = async () => (await t.call('GET', `/api/cookbooks/${book.id}`, null, t.a)).body.recipes;
    let rs = await open();
    assert.equal(rs.find(r => r.id === beas.id).locked, undefined, 'shared: open');
    assert.ok(JSON.stringify(rs.find(r => r.id === beas.id)).includes('saffron'));
    // Bea stops sharing: the cookbook shows it locked, nothing of it but its name.
    assert.equal((await t.call('DELETE', `/api/recipes/${beas.id}/shares/${t.a.id}`, null, t.b)).status, 200);
    assert.equal((await t.call('GET', `/api/recipes/${beas.id}`, null, t.a)).status, 403, 'the direct read refuses it');
    rs = await open();
    const locked = rs.find(r => r.id === beas.id);
    assert.equal(locked.locked, true);
    assert.ok(!JSON.stringify(locked).includes('saffron'), 'no ingredients');
    assert.equal(rs.find(r => r.id === own.id).locked, undefined, 'their own recipe still open');
    assert.ok(JSON.stringify(rs.find(r => r.id === own.id)).includes('leek'));
  } finally { await t.stop(); }
});

test('a plan stops copying a recipe into the shopping list once it is no longer shared', { skip, timeout: 90000 }, async () => {
  const t = await setup();
  try {
    const beas = await t.recipe(t.b, 'Bea Secret Stew', 'saffron');
    const own = await t.recipe(t.a, 'Alex Soup', 'leek');
    await t.call('POST', `/api/recipes/${beas.id}/shares`, { user_ids: [t.a.id] }, t.b);
    const day = '2030-01-15';
    for (const r of [beas, own]) {
      const p = await t.call('POST', '/api/cook-diary', { recipe_id: r.id, date: day, kind: 'planned' }, t.a);
      assert.ok(p.status < 300, `plan ${r.name}: ${p.status} ${JSON.stringify(p.body)}`);
    }
    await t.call('DELETE', `/api/recipes/${beas.id}/shares/${t.a.id}`, null, t.b);
    const built = await t.call('POST', `/api/shopping/from-plan?from=${day}&to=${day}&only_missing=0`, null, t.a);
    assert.ok(built.status < 300, `from-plan: ${built.status}`);
    const names = (await t.call('GET', '/api/shopping', null, t.a)).body.map(i => i.name.toLowerCase());
    assert.ok(names.includes('leek'), "their own recipe's ingredient is there");
    assert.ok(!names.includes('saffron'), 'the recipe no longer shared adds nothing');
  } finally { await t.stop(); }
});

test("a recipe's owner can't change or remove someone else's cook of it", { skip, timeout: 90000 }, async () => {
  const t = await setup();
  try {
    const beas = await t.recipe(t.b, 'Bea Stew', 'carrot');
    await t.call('POST', `/api/recipes/${beas.id}/shares`, { user_ids: [t.a.id] }, t.b);
    const cook = (await t.call('POST', '/api/cook-diary', { recipe_id: beas.id, date: '2026-01-10', kind: 'cooked', notes: 'alex notes' }, t.a)).body;
    assert.ok(cook?.id, 'alex logged a cook');
    // Bea owns the recipe, not Alex's diary.
    assert.equal((await t.call('PUT', `/api/recipes/${beas.id}/cooks/${cook.id}`, { notes: 'rewritten' }, t.b)).status, 404);
    await t.call('DELETE', `/api/recipes/${beas.id}/cooks/${cook.id}`, null, t.b);
    const mine = (await t.call('GET', '/api/cook-diary?from=2026-01-01&to=2026-01-31', null, t.a)).body;
    const entry = (Array.isArray(mine) ? mine : mine.items || mine.entries || []).find(e => e.id === cook.id);
    assert.ok(entry, "alex's cook is still there");
    assert.equal(entry.notes, 'alex notes');
    // Bea's own cook of her recipe: hers to change and remove, as before.
    const hersId = (await t.call('POST', '/api/cook-diary', { recipe_id: beas.id, date: '2026-01-11', kind: 'cooked' }, t.b)).body?.id;
    assert.ok(hersId, 'bea logged a cook');
    assert.equal((await t.call('PUT', `/api/recipes/${beas.id}/cooks/${hersId}`, { notes: 'mine' }, t.b)).status, 200);
    assert.equal((await t.call('DELETE', `/api/recipes/${beas.id}/cooks/${hersId}`, null, t.b)).status, 200);
  } finally { await t.stop(); }
});
