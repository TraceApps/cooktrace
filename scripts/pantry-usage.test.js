/**
 * #60: a pantry item's "Used in N" pill and the Used In list in its sheet.
 * Both come from lib/pantry-usage.js, on the server and on the phone, so
 * the number and the list agree, a link saved as "12" still counts, and a
 * recipe reaches a variant through its generic (and a generic through its
 * variants). An app from before 1.5 asks without ?family=1 and gets the
 * same plain list as before.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';
import { linkedPantryIds, usageCounts, recipesUsing } from '../src/lib/pantry-usage.js';

test('the server and app copies are identical', () => {
  const a = readFileSync(new URL('../src/lib/pantry-usage.js', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../server/lib/pantry-usage.js', import.meta.url), 'utf8');
  assert.equal(a, b);
});

const rec = (id, name, ...links) => ({ id, name, img_url: null, ingredients: JSON.stringify([{ title: '', items: links.map(l => ({ name: 'x', pantry_item_id: l })) }]) });

test('links are read as numbers, from groups or a flat list, ignoring junk', () => {
  assert.deepEqual([...linkedPantryIds(JSON.stringify([{ items: [{ pantry_item_id: 12 }, { pantry_item_id: '7' }, { pantry_item_id: null }, { pantry_item_id: '' }, { pantry_item_id: 'abc' }, {}] }]))].sort(), [12, 7].sort());
  assert.deepEqual([...linkedPantryIds([{ name: 'flat', pantry_item_id: 3 }])], [3]);
  assert.equal(linkedPantryIds('not json').size, 0);
  assert.equal(linkedPantryIds(null).size, 0);
});

test('a recipe counts once per item, and the count matches the list', () => {
  const recipes = [rec(1, 'A', 5, 5, '5'), rec(2, 'B', 5, 9), rec(3, 'C', 9)];
  const counts = usageCounts(recipes);
  assert.equal(counts.get(5), 2);
  assert.equal(counts.get(9), 2);
  assert.equal(recipesUsing(recipes, 5).direct.length, counts.get(5));
  assert.deepEqual(recipesUsing(recipes, '9').direct.map(r => r.name), ['B', 'C']);
});

test('a variant is reached through its generic, a generic through its variants', () => {
  // 10 = Whole Milk (generic), 11 = GreenWise (variant), 12 = Horizon (variant)
  const recipes = [rec(1, 'Pancakes', 10), rec(2, 'Latte', 11), rec(3, 'Custard', 12), rec(4, 'Both', 10, 11), rec(5, 'Toast', 99)];
  const greenwise = recipesUsing(recipes, 11, { generic: { id: 10, name: 'Whole Milk' } });
  assert.deepEqual(greenwise.direct.map(r => r.name), ['Latte', 'Both']);
  assert.deepEqual(greenwise.through.map(r => [r.name, r.via.name]), [['Pancakes', 'Whole Milk']]);
  const milk = recipesUsing(recipes, 10, { variants: [{ id: 11, name: 'GreenWise' }, { id: 12, name: 'Horizon' }] });
  assert.deepEqual(milk.direct.map(r => r.name), ['Pancakes', 'Both']);
  assert.deepEqual(milk.through.map(r => [r.name, r.via.name]), [['Latte', 'GreenWise'], ['Custard', 'Horizon']]);
});

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
      JWT_SECRET: 'usage-test-secret-0123456789abcdef01234', INSECURE_COOKIES: '1', NODE_ENV: 'test' },
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
  const dir = mkdtempSync(join(tmpdir(), 'ct-usage-'));
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


test('the endpoint, the card count and older apps agree', { skip }, async () => {
  const s = await start();
  try {
    const milk = await s.ok('POST', '/api/pantry', { name: 'Whole Milk' });
    const gw = await s.ok('POST', '/api/pantry', { name: 'GreenWise Whole Milk', brand: 'GreenWise', generic_parent_id: milk.id });
    const eggs = await s.ok('POST', '/api/pantry', { name: 'Eggs' });
    const mk = (name, ...ids) => s.ok('POST', '/api/recipes', { name, servings: 2, steps: ['Mix.'], ingredients: [{ title: '', items: ids.map(id => ({ name: 'x', qty: '1', unit: '', pantry_item_id: id })) }] });
    await mk('Pancakes', milk.id, eggs.id);
    await mk('Latte', gw.id);
    await mk('Omelette', String(eggs.id));
    const list = await s.ok('GET', '/api/pantry');
    const count = id => list.find(r => r.id === id)?.recipe_count;

    // Older apps: the plain list, now also counting a link saved as text.
    const plain = await s.ok('GET', `/api/pantry/${eggs.id}/recipes`);
    assert.ok(Array.isArray(plain));
    assert.deepEqual(plain.map(r => r.name), ['Omelette', 'Pancakes']);
    assert.equal(plain.length, count(eggs.id));

    // The sheet: direct ones match the card, the family comes after.
    const milkFam = await s.ok('GET', `/api/pantry/${milk.id}/recipes?family=1`);
    assert.deepEqual(milkFam.direct.map(r => r.name), ['Pancakes']);
    assert.equal(milkFam.direct.length, count(milk.id));
    assert.deepEqual(milkFam.through.map(r => [r.name, r.via.id]), [['Latte', gw.id]]);
    const gwFam = await s.ok('GET', `/api/pantry/${gw.id}/recipes?family=1`);
    assert.deepEqual(gwFam.direct.map(r => r.name), ['Latte']);
    assert.deepEqual(gwFam.through.map(r => [r.name, r.via.id]), [['Pancakes', milk.id]]);

    assert.equal((await s.call('GET', '/api/pantry/999999/recipes')).status, 404);
  } finally { await s.stop(); }
});
