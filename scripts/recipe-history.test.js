/**
 * Recipe history (#54), on a real server: a version for each change to
 * what a recipe has you cook, each cook keeping the one it was made from,
 * restoring and deleting, recipes from before getting their first version,
 * and apps from before 1.5 getting nothing they can't store.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

async function boot(dir) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: new URL('server/', root),
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'app.db'), UPLOADS_PATH: join(dir, 'uploads'),
      JWT_SECRET: 'history-test-secret-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test' },
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

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-history-'));
  let srv = await boot(dir);
  const reg = await fetch(srv.base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'cook', password: 'Str0ng-Pass-88!y' }),
  });
  const token = reg.headers.getSetCookie().map(c => c.split(';')[0].split('=')[1]).find(v => v?.startsWith('eyJ'));
  assert.ok(token, 'signed in');
  const call = async (method, path, body) => {
    const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : null };
  };
  const ok = async (method, path, body) => {
    const r = await call(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return r.body;
  };
  return {
    call, ok, dbPath: join(dir, 'app.db'),
    restart: async () => { await srv.stop(); srv = await boot(dir); },
    stop: async () => { await srv.stop(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* closing */ } },
  };
}

const scones = (flour = '300') => ({
  name: 'Scones', servings: 8, steps: [{ title: '', text: 'Rub in the butter.' }, { title: 'Bake', text: 'Bake at 220C for 12 minutes.' }],
  ingredients: [{ name: '', items: [{ id: 'i1', qty: flour, unit: 'g', name: 'flour' }, { id: 'i2', qty: '50', unit: 'g', name: 'butter' }] }],
});

test('a version for each change to what you cook; each cook keeps its own', { skip, timeout: 60_000 }, async () => {
  const s = await start();
  try {
    const r = await s.ok('POST', '/api/recipes', scones());
    let h = await s.ok('GET', `/api/recipes/${r.id}/revisions`);
    assert.equal(h.revisions.length, 1);
    const v1 = h.current;
    assert.equal(h.revisions[0].current, true);

    // A new name or note isn't a new version.
    await s.ok('PUT', `/api/recipes/${r.id}`, { ...scones(), name: 'Best Scones', notes: 'from Grandma' });
    h = await s.ok('GET', `/api/recipes/${r.id}/revisions`);
    assert.equal(h.revisions.length, 1, 'renamed: the same version');

    const cook1 = await s.ok('POST', `/api/recipes/${r.id}/cooked`, { date: '2030-01-02', rating: 3 });
    assert.equal(cook1.cook_count, 1);
    // Less flour: version 2, and the next cook is of it.
    await s.ok('PUT', `/api/recipes/${r.id}`, { ...scones('250'), name: 'Best Scones', notes: 'from Grandma' });
    h = await s.ok('GET', `/api/recipes/${r.id}/revisions`);
    assert.equal(h.revisions.length, 2);
    const v2 = h.current;
    assert.notEqual(v2, v1);
    assert.equal(h.revisions[1].data.ingredients[0].items[0].qty, '250');
    await s.ok('POST', '/api/cook-diary', { recipe_id: r.id, date: '2030-01-05', kind: 'cooked', rating: 5 });
    const planned = await s.ok('POST', '/api/cook-diary', { recipe_id: r.id, date: '2030-01-09', kind: 'planned' });
    assert.equal(planned.recipe_rev, null, 'a planned cook has no version yet');

    h = await s.ok('GET', `/api/recipes/${r.id}/revisions`);
    assert.deepEqual(h.revisions.map(v => [v.number, v.cooks.map(c => c.rating)]), [[1, [3]], [2, [5]]], 'each cook with its version');
    assert.deepEqual(h.revisions.map(v => v.used), [true, true]);

    // One version, for a cook's "as you made it".
    const one = await s.ok('GET', `/api/recipes/${r.id}/revisions/${v1}`);
    assert.equal(one.number, 1);
    assert.equal(one.data.ingredients[0].items[0].qty, '300');
    assert.equal((await s.call('GET', `/api/recipes/${r.id}/revisions/vffffffffffffff`)).status, 404);

    // Back to version 1: current again, nothing added, nothing lost; a
    // planned cook marked cooked now is of it.
    const restored = await s.ok('POST', `/api/recipes/${r.id}/revisions/${v1}/restore`);
    assert.equal(restored.name, 'Best Scones', 'the name stays');
    assert.equal(restored.notes, 'from Grandma', 'and the notes');
    assert.equal(restored.ingredients[0].items[0].qty, '300');
    h = await s.ok('GET', `/api/recipes/${r.id}/revisions`);
    assert.deepEqual([h.revisions.length, h.current], [2, v1]);
    const marked = await s.ok('PUT', `/api/cook-diary/${planned.id}`, { kind: 'cooked' });
    assert.equal(marked.recipe_rev ?? (await s.ok('GET', '/api/cook-diary?from=2030-01-09&to=2030-01-09')).find(e => e.id === planned.id).recipe_rev, v1);

    // A cook can say which version it was: one of this recipe's.
    assert.equal((await s.call('PUT', `/api/cook-diary/${planned.id}`, { recipe_rev: 'v00000000000000' })).status, 400);
    await s.ok('PUT', `/api/cook-diary/${planned.id}`, { recipe_rev: v2 });
    const diary = await s.ok('GET', '/api/cook-diary?from=2030-01-09&to=2030-01-09');
    assert.equal(diary.find(e => e.id === planned.id).recipe_rev, v2);
  } finally { await s.stop(); }
});

test('only a version nobody cooked, and not the current one, can be deleted', { skip, timeout: 60_000 }, async () => {
  const s = await start();
  try {
    const r = await s.ok('POST', '/api/recipes', scones());
    const v1 = (await s.ok('GET', `/api/recipes/${r.id}/revisions`)).current;
    await s.ok('PUT', `/api/recipes/${r.id}`, scones('280'));
    const v2 = (await s.ok('GET', `/api/recipes/${r.id}/revisions`)).current;
    await s.ok('POST', `/api/recipes/${r.id}/cooked`, {});
    await s.ok('PUT', `/api/recipes/${r.id}`, scones('260'));
    const del = r2 => s.call('DELETE', `/api/recipes/${r.id}/revisions/${r2}`);
    assert.deepEqual([(await del(v2)).status, (await del(v2)).body.code], [409, 'used']);
    const v3 = (await s.ok('GET', `/api/recipes/${r.id}/revisions`)).current;
    assert.deepEqual([(await del(v3)).status, (await del(v3)).body.code], [409, 'current']);
    assert.equal((await del(v1)).status, 200);
    const h = await s.ok('GET', `/api/recipes/${r.id}/revisions`);
    assert.deepEqual(h.revisions.map(v => v.number), [2, 3], 'numbers stay with their versions');
    // The same content saved again brings it back.
    await s.ok('PUT', `/api/recipes/${r.id}`, scones('300'));
    assert.deepEqual((await s.ok('GET', `/api/recipes/${r.id}/revisions`)).revisions.map(v => v.number), [1, 2, 3]);
  } finally { await s.stop(); }
});

test('recipes from before the history get it at start, and their cooks say so', { skip, timeout: 60_000 }, async () => {
  const s = await start();
  try {
    const r = await s.ok('POST', '/api/recipes', scones());
    await s.ok('POST', `/api/recipes/${r.id}/cooked`, { date: '2029-12-01' });
    // As a server from before 1.5 left it: no versions, no stamps.
    const db = new Database(s.dbPath);
    db.exec(`DELETE FROM recipe_revisions; UPDATE recipes SET rev = NULL; UPDATE cook_diary SET recipe_rev = NULL`);
    db.close();
    await s.restart();
    const h = await s.ok('GET', `/api/recipes/${r.id}/revisions`);
    assert.equal(h.revisions.length, 1);
    assert.equal(h.revisions[0].current, true);
    assert.equal(h.unversioned.length, 1, 'the cook from before has no version');
  } finally { await s.stop(); }
});

test('an app from before 1.5 is sent nothing it has no place for', { skip, timeout: 60_000 }, async () => {
  const s = await start();
  try {
    const r = await s.ok('POST', '/api/recipes', scones());
    await s.ok('POST', `/api/recipes/${r.id}/cooked`, {});
    await s.ok('POST', '/api/shopping', { name: 'Milk', notes: 'oat' });
    const old = await s.ok('GET', '/api/sync/pull?since=1970-01-01T00:00:00&synced_at=1');
    assert.equal(old.tables.recipe_revisions, undefined, 'no versions table');
    assert.equal('recipe_rev' in old.tables.cook_diary[0], false);
    assert.equal('any_day' in old.tables.cook_diary[0], false);
    assert.equal('notes' in old.tables.shopping_list[0], false);
    assert.equal('sources' in old.tables.shopping_list[0], false);
    assert.equal('allergen_overrides' in old.tables.recipes[0], false);
    assert.equal('allergens' in (old.tables.pantry_items[0] || { }), false);
    const now = await s.ok('GET', '/api/sync/pull?since=1970-01-01T00:00:00&synced_at=1&schema=2');
    assert.equal(now.tables.recipe_revisions.length, 1);
    assert.match(now.tables.cook_diary[0].recipe_rev, /^v[0-9a-f]{14}$/);
    assert.equal(now.tables.shopping_list[0].notes, 'oat');
  } finally { await s.stop(); }
});

test("editing a cook from the recipe saves its rating, meal and version (the rating used to be dropped)", { skip, timeout: 60_000 }, async () => {
  const s = await start();
  try {
    const r = await s.ok('POST', '/api/recipes', scones());
    const v1 = (await s.ok('GET', `/api/recipes/${r.id}/revisions`)).current;
    await s.ok('PUT', `/api/recipes/${r.id}`, scones('250'));
    await s.ok('POST', `/api/recipes/${r.id}/cooked`, { date: '2030-03-01', rating: 4 });
    const cook = (await s.ok('GET', '/api/cook-diary?from=2030-03-01&to=2030-03-01'))[0];
    await s.ok('PUT', `/api/recipes/${r.id}/cooks/${cook.id}`, { rating: 2, meal_type: 'lunch', notes: 'edited', recipe_rev: v1 });
    const after = (await s.ok('GET', '/api/cook-diary?from=2030-03-01&to=2030-03-01'))[0];
    assert.deepEqual([after.rating, after.meal_type, after.notes, after.recipe_rev], [2, 'lunch', 'edited', v1]);
    assert.equal((await s.call('PUT', `/api/recipes/${r.id}/cooks/${cook.id}`, { recipe_rev: 'v00000000000000' })).status, 400);
  } finally { await s.stop(); }
});

test('a version can be named, renamed and unnamed; the name is trimmed and kept short', { skip, timeout: 60_000 }, async () => {
  const s = await start();
  try {
    const r = await s.ok('POST', '/api/recipes', scones());
    const v1 = (await s.ok('GET', `/api/recipes/${r.id}/revisions`)).current;
    const named = await s.ok('PUT', `/api/recipes/${r.id}/revisions/${v1}`, { label: '  The   base  ' });
    assert.equal(named.label, 'The base');
    assert.equal((await s.ok('GET', `/api/recipes/${r.id}/revisions`)).revisions[0].label, 'The base');
    await s.ok('PUT', `/api/recipes/${r.id}/revisions/${v1}`, { label: 'x'.repeat(80) });
    assert.equal((await s.ok('GET', `/api/recipes/${r.id}/revisions/${v1}`)).label.length, 60);
    await s.ok('PUT', `/api/recipes/${r.id}/revisions/${v1}`, { label: '' });
    assert.equal((await s.ok('GET', `/api/recipes/${r.id}/revisions/${v1}`)).label, null);
    assert.equal((await s.call('PUT', `/api/recipes/${r.id}/revisions/vffffffffffffff`, { label: 'x' })).status, 404);
  } finally { await s.stop(); }
});
