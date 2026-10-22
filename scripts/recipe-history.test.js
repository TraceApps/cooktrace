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
    if (i > 150 || proc.exitCode != null) { proc.kill(); throw new Error('server did not start: ' + errors.slice(-500)); }
  }
  return { base, stop: () => new Promise(r => { if (proc.exitCode != null || proc.signalCode != null) return r(); proc.on('exit', r); proc.kill(); }) };
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
  const callAs = tok => async (method, path, body) => {
    const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : null };
  };
  const call = callAs(token);
  // Another account, made by the first (the admin): its own call().
  const another = async username => {
    const made = await fetch(srv.base + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ username, password: 'Str0ng-Pass-77!z' }),
    });
    assert.ok(made.status < 300, `register ${username}: ${made.status}`);
    const login = await fetch(srv.base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'Str0ng-Pass-77!z' }),
    });
    const tok = login.headers.getSetCookie().map(c => c.split(';')[0].split('=')[1]).find(v => v?.startsWith('eyJ'));
    assert.ok(tok, `${username} signed in`);
    return callAs(tok);
  };
  const ok = async (method, path, body) => {
    const r = await call(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return r.body;
  };
  return {
    call, ok, another, dbPath: join(dir, 'app.db'),
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

// Reported on #54 by @DefectiveConsole, with reproductions.

test('a recipe pushed with steps that are not a list is kept, and the server still starts', { skip, timeout: 60_000 }, async () => {
  const s = await start();
  try {
    const pushed = await s.ok('POST', '/api/sync/push', { fk_ids: 'server', client_now: new Date().toISOString(),
      tables: { recipes: [{ client_id: 1, name: 'Odd', visibility: 'private', favorite: 0, cook_count: 0, rating: null, ingredients: '[]', steps: '{}', tags: '{"a":1}', tools: '[]', nutrition: '{}', updated_at: '2030-01-01 00:00:00' }] } });
    assert.ok(Array.isArray(pushed.tables.recipes), JSON.stringify(pushed.tables.recipes));
    const id = pushed.tables.recipes[0].server_id;
    assert.ok(id, 'kept');
    // A row left this way before the fix: the next start still runs.
    const db = new Database(s.dbPath);
    db.prepare(`UPDATE recipes SET steps = '{}', rev = NULL WHERE id = ?`).run(id);
    db.close();
    await s.restart();
    const h = await s.ok('GET', `/api/recipes/${id}/revisions`);
    assert.equal(h.revisions.length, 1, 'it has its version');
    const r = await s.ok('GET', `/api/recipes/${id}`);
    assert.deepEqual([r.steps, r.tags], [[], []], 'read as no steps and no tags');
    const after = new Database(s.dbPath);
    assert.equal(after.prepare(`SELECT steps FROM recipes WHERE id = ?`).get(id).steps, '[]', 'repaired where it is kept');
    after.close();
  } finally { await s.stop(); }
});

test('an amount changed by less than an eighth is a new version; the same amount written another way is not', { skip, timeout: 60_000 }, async () => {
  const s = await start();
  try {
    const salt = q => ({ ...scones(), ingredients: [{ name: '', items: [{ id: 'i1', qty: q, unit: 'g', name: 'salt' }] }] });
    const r = await s.ok('POST', '/api/recipes', salt('0.10'));
    await s.ok('PUT', `/api/recipes/${r.id}`, salt('0.15'));
    await s.ok('POST', `/api/recipes/${r.id}/cooked`, { date: '2030-02-01' });
    let h = await s.ok('GET', `/api/recipes/${r.id}/revisions`);
    assert.equal(h.revisions.length, 2);
    const cooked = h.revisions.find(v => v.cooks.length);
    assert.equal(cooked.data.ingredients[0].items[0].qty, '0.15', 'the cook shows the amount it was made with');
    await s.ok('PUT', `/api/recipes/${r.id}`, salt('1/2'));
    await s.ok('PUT', `/api/recipes/${r.id}`, salt('0.5'));
    await s.ok('PUT', `/api/recipes/${r.id}`, salt('½'));
    h = await s.ok('GET', `/api/recipes/${r.id}/revisions`);
    assert.equal(h.revisions.length, 3, '1/2, 0.5 and ½ are one version');
  } finally { await s.stop(); }
});

test('a cook queued offline between two saves keeps the version it was made from', { skip, timeout: 60_000 }, async () => {
  const s = await start();
  try {
    const { writeOp, collapseOps, withSaveBase, recipeSaveBase, recipeBaseOf } = await import('../src/lib/offline-edits.js');
    const content = await import('../src/lib/recipe-content.js');
    const r = await s.ok('POST', '/api/recipes', scones('300'));
    await s.ok('POST', `/api/recipes/${r.id}/cooked`, { date: '2030-03-31' });
    const earlier = (await s.ok('GET', '/api/cook-diary?from=2030-03-31&to=2030-03-31'))[0];
    const page0 = await s.ok('GET', `/api/recipes/${r.id}`);
    // Offline: 250 g saved, a cook of it logged and an earlier cook said to
    // be of it, then 200 g saved.
    let seq = 0;
    const queue = (method, path, body) => ({ ...writeOp(method, path, body), seq: ++seq, method, path, body: { ...body, _sync: undefined }, sync: body._sync });
    const save = (page, flour) => {
      const body = { ...page, ingredients: scones(flour).ingredients, _base: recipeBaseOf(page0) };
      return queue('PUT', `/api/recipes/${r.id}`, { ...body, _sync: recipeSaveBase(body, null, new Date().toISOString()) });
    };
    const page250 = { ...page0, ingredients: scones('250').ingredients };
    const cookBody = { date: '2030-04-01', ...(content.cookVersion ? content.cookVersion(page250) : { recipe_rev: content.revisionOf(page250).rev }) };
    const editBody = { rating: 4, ...(content.cookVersion ? content.cookVersion(page250) : { recipe_rev: content.revisionOf(page250).rev }) };
    const ops = [save(page0, '250'), queue('POST', `/api/recipes/${r.id}/cooked`, cookBody),
      queue('PUT', `/api/recipes/${r.id}/cooks/${earlier.id}`, editBody), save(page250, '200')];
    for (const op of collapseOps(ops)) {
      const res = await s.call(op.method, op.path, withSaveBase(op.body, op.sync));
      assert.ok(res.status < 400, `${op.method} ${op.path} ${res.status}`);
    }
    const h = await s.ok('GET', `/api/recipes/${r.id}/revisions`);
    assert.equal(h.unversioned.length, 0, 'the cook has its version');
    const v = h.revisions.find(x => x.cooks.length);
    assert.equal(v.data.ingredients[0].items[0].qty, '250');
    assert.equal(v.cooks.length, 2, 'the new cook and the one edited to say so');
    assert.equal(v.cooks.find(c => c.id === earlier.id).rating, 4, 'the edit went in');
    assert.deepEqual(h.revisions.map(x => x.data.ingredients[0].items[0].qty), ['300', '250', '200'], 'in the order they were made');
    assert.equal((await s.ok('GET', `/api/recipes/${r.id}`)).ingredients[0].items[0].qty, '200');
  } finally { await s.stop(); }
});

test('versions keyed before amounts were exact get their exact keys at start, and their cooks follow', { skip, timeout: 60_000 }, async () => {
  const s = await start();
  try {
    const { legacyRevOf, revOf, parseRevision } = await import('../src/lib/recipe-content.js');
    const salt = q => ({ ...scones(), ingredients: [{ name: '', items: [{ id: 'i1', qty: q, unit: 'g', name: 'salt' }] }] });
    const r = await s.ok('POST', '/api/recipes', salt('0.10'));
    await s.ok('POST', `/api/recipes/${r.id}/cooked`, { date: '2030-05-01', rating: 4 });
    // As a server from before left it: the version under its rounded key,
    // and the recipe since changed to 0.15 g with no version of its own.
    const db = new Database(s.dbPath);
    const v = db.prepare(`SELECT id, rev, data FROM recipe_revisions WHERE recipe_id = ?`).get(r.id);
    const old = legacyRevOf(parseRevision(v.data));
    assert.notEqual(old, v.rev, 'the key changed');
    db.prepare(`UPDATE recipe_revisions SET rev = ? WHERE id = ?`).run(old, v.id);
    db.prepare(`UPDATE cook_diary SET recipe_rev = ? WHERE recipe_id = ?`).run(old, r.id);
    db.prepare(`UPDATE recipes SET rev = ?, ingredients = ? WHERE id = ?`).run(old, JSON.stringify(salt('0.15').ingredients), r.id);
    db.prepare(`DELETE FROM app_config WHERE key = 'history_exact_amounts'`).run();
    db.close();
    await s.restart();
    const h = await s.ok('GET', `/api/recipes/${r.id}/revisions`);
    assert.deepEqual(h.revisions.map(x => [x.data.ingredients[0].items[0].qty, x.cooks.map(c => c.rating), x.current]), [['0.10', [4], false], ['0.15', [], true]]);
    assert.equal(h.unversioned.length, 0);
    assert.equal(h.revisions[0].rev, v.rev, 'the exact key');
    // Cooks from an app that still makes old keys: the version it had.
    await s.ok('POST', '/api/sync/push', { fk_ids: 'server', client_now: new Date().toISOString(),
      tables: { cook_diary: [{ client_id: 9, recipe_id: r.id, date: '2030-05-02', kind: 'cooked', rating: 2, recipe_rev: old, updated_at: '2030-01-01 00:00:00' }] } });
    await s.ok('POST', `/api/recipes/${r.id}/cooked`, { date: '2030-05-03', rating: 5, recipe_rev: old });
    const after = await s.ok('GET', `/api/recipes/${r.id}/revisions`);
    assert.deepEqual(after.revisions.map(x => x.cooks.map(c => c.rating).sort()), [[4], [2, 5]], 'of the version the recipe has now, as that app had it');
    assert.equal(after.unversioned.length, 0);
    assert.equal(revOf(after.revisions[1].data), after.current);
  } finally { await s.stop(); }
});

test("a cook adds a version it brings only to a history its cook may change", { skip, timeout: 60_000 }, async () => {
  const s = await start();
  try {
    const { cookVersion } = await import('../src/lib/recipe-content.js');
    const r = await s.ok('POST', '/api/recipes', { ...scones(), visibility: 'group' });
    const pat = await s.another('pat');
    const made = cookVersion(scones('1'));
    const res = await pat('POST', `/api/recipes/${r.id}/cooked`, { date: '2030-06-01', ...made });
    assert.equal(res.status < 300, true, `cooked: ${res.status}`);
    const h = await s.ok('GET', `/api/recipes/${r.id}/revisions`);
    assert.equal(h.revisions.length, 1, "another account's cook adds nothing to the owner's history");
    // The owner's own does.
    await s.ok('POST', `/api/recipes/${r.id}/cooked`, { date: '2030-06-02', ...made });
    assert.equal((await s.ok('GET', `/api/recipes/${r.id}/revisions`)).revisions.length, 2);
    // A version whose content isn't what it says is not kept.
    await s.ok('POST', `/api/recipes/${r.id}/cooked`, { date: '2030-06-03', recipe_rev: 'v0000000000000a', recipe_version: made.recipe_version });
    assert.equal((await s.ok('GET', `/api/recipes/${r.id}/revisions`)).revisions.length, 2);
  } finally { await s.stop(); }
});

test("only someone who may change a recipe's history brings back a deleted version with a cook", { skip, timeout: 60_000 }, async () => {
  const s = await start();
  try {
    const r = await s.ok('POST', '/api/recipes', { ...scones(), visibility: 'group' });
    const v1 = (await s.ok('GET', `/api/recipes/${r.id}/revisions`)).current;
    await s.ok('PUT', `/api/recipes/${r.id}`, { ...scones('250'), visibility: 'group' });
    await s.ok('DELETE', `/api/recipes/${r.id}/revisions/${v1}`);
    const pat = await s.another('pat');
    assert.ok((await pat('POST', `/api/recipes/${r.id}/cooked`, { date: '2030-07-01', recipe_rev: v1 })).status < 300);
    assert.deepEqual((await s.ok('GET', `/api/recipes/${r.id}/revisions`)).revisions.map(v => v.number), [2], "another account's cook doesn't bring it back");
    await s.ok('POST', `/api/recipes/${r.id}/cooked`, { date: '2030-07-02', recipe_rev: v1 });
    assert.deepEqual((await s.ok('GET', `/api/recipes/${r.id}/revisions`)).revisions.map(v => v.number), [1, 2], "the owner's does");
  } finally { await s.stop(); }
});

test("a recipe's cooks say a plan's week and servings, and I Cooked This on a planned day makes the plan the cook (#61)", { skip, timeout: 60_000 }, async () => {
  const s = await start();
  try {
    const r = await s.ok('POST', '/api/recipes', scones());
    const plan = await s.ok('POST', '/api/cook-diary', { recipe_id: r.id, date: '2030-08-05', kind: 'planned', servings: 6, any_day: true });
    let cooks = await s.ok('GET', `/api/recipes/${r.id}/cooks`);
    assert.deepEqual(cooks.map(c => [c.kind, c.any_day, c.servings]), [['planned', 1, 6]]);
    // The plan made into the cook: one row, cooked, with its servings and a version.
    await s.ok('PUT', `/api/recipes/${r.id}/cooks/${plan.id}`, { kind: 'cooked', date: '2030-08-07', rating: 5, meal_type: 'dinner' });
    cooks = await s.ok('GET', `/api/recipes/${r.id}/cooks`);
    assert.deepEqual(cooks.map(c => [c.id, c.kind, c.date, c.any_day, c.servings, c.rating]), [[plan.id, 'cooked', '2030-08-07', 0, 6, 5]]);
    assert.match(cooks[0].recipe_rev, /^v[0-9a-f]{14}$/, 'made from the current version');
    assert.equal((await s.ok('GET', `/api/recipes/${r.id}`)).cook_count, 1);
    // An edit never turns a cook back into a plan.
    await s.ok('PUT', `/api/recipes/${r.id}/cooks/${plan.id}`, { kind: 'planned', notes: 'good' });
    assert.equal((await s.ok('GET', `/api/recipes/${r.id}/cooks`))[0].kind, 'cooked');
  } finally { await s.stop(); }
});
