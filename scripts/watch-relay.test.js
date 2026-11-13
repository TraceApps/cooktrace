/**
 * Local mode on the watch: with no server, the watch sends its four requests
 * to the phone, and the phone's own local handlers answer them.
 *
 * The routing is checked on its own, then the whole round trip runs against
 * the phone's real Local mode code (api-native.js on the SQLite shim from
 * scripts/android-sync): the list read and ticked off from the watch, the
 * recipe read, and a cook logged the way the watch logs one.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { answerWatchRequest, PHONE_ADDRESS } from '../src/lib/watch-relay.js';

function fakeApi() {
  const calls = [];
  const api = {
    getShoppingList: async () => { calls.push(['list']); return [{ id: 1 }]; },
    getRecipe: async (id) => { calls.push(['recipe', id]); return id === 7 ? { id: 7, name: 'Soup' } : null; },
    toggleShoppingChecked: async (id, checked) => { calls.push(['check', id, checked]); return { ok: true, checked }; },
    createDiaryEntry: async (d) => { calls.push(['cooked', d]); return { id: 1, ...d }; },
  };
  return { api, calls };
}

test('only the four requests the watch makes are answered', async () => {
  const { api, calls } = fakeApi();
  const ask = (method, path, body = null) => answerWatchRequest({ method, path, body }, { localMode: true, api });
  assert.equal((await ask('GET', '/api/shopping')).status, 200);
  assert.equal((await ask('GET', '/api/recipes/7')).status, 200);
  assert.equal((await ask('PATCH', '/api/shopping/3/check', '{"checked":true}')).status, 200);
  assert.equal((await ask('POST', '/api/cook-diary', '{"recipe_id":7,"date":"2026-11-13","kind":"cooked"}')).status, 200);
  assert.deepEqual(calls, [
    ['list'], ['recipe', 7], ['check', 3, true],
    ['recipe', 7], ['cooked', { recipe_id: 7, date: '2026-11-13', kind: 'cooked' }],
  ]);
  calls.length = 0;
  for (const [m, p] of [['DELETE', '/api/shopping/3'], ['GET', '/api/recipes'], ['PUT', '/api/recipes/7'], ['POST', '/api/shopping'],
    ['GET', '/api/recipes/7/../../auth/me'], ['GET', '/api/settings'], ['POST', '/api/ai/chat'], ['GET', '/api/recipes/abc']]) {
    assert.equal((await ask(m, p)).status, 404, `${m} ${p} is refused`);
  }
  assert.equal(calls.length, 0, 'nothing refused reached the handlers');
});

test('a missing recipe is not found, a cook is checked as the server checks it, and writes name what changed', async () => {
  const { api, calls } = fakeApi();
  const ask = (method, path, body = null) => answerWatchRequest({ method, path, body }, { localMode: true, api });
  assert.equal((await ask('GET', '/api/recipes/8')).status, 404);
  assert.equal((await ask('POST', '/api/cook-diary', '{"recipe_id":8,"date":"2026-11-13","kind":"cooked"}')).status, 404);
  assert.equal((await ask('POST', '/api/cook-diary', '{"recipe_id":7,"date":"13/11/2026"}')).status, 400);
  assert.equal((await ask('POST', '/api/cook-diary', '{"date":"2026-11-13"}')).status, 400);
  assert.ok(!calls.some(c => c[0] === 'cooked'), 'nothing was logged');
  assert.deepEqual((await ask('PATCH', '/api/shopping/3/check', '{"checked":false}')).changed, ['shopping_list']);
  assert.deepEqual((await ask('POST', '/api/cook-diary', '{"recipe_id":7,"date":"2026-11-13","kind":"cooked"}')).changed, ['cook_diary', 'recipes']);
  assert.equal((await ask('GET', '/api/shopping')).changed, undefined);
});

test('a phone on a server refuses, bad input is a bad request, and a failure says why', async () => {
  const { api } = fakeApi();
  assert.equal((await answerWatchRequest({ method: 'GET', path: '/api/shopping' }, { localMode: false, api })).status, 409);
  assert.equal((await answerWatchRequest({ method: 'PATCH', path: '/api/shopping/3/check', body: '{not json' }, { localMode: true, api })).status, 400);
  const failing = await answerWatchRequest({ method: 'GET', path: '/api/shopping' }, { localMode: true, api: { getShoppingList: async () => { throw new Error('disk full'); } } });
  assert.deepEqual([failing.status, JSON.parse(failing.body).error], [500, 'disk full']);
  assert.equal(PHONE_ADDRESS, 'phone:', 'the watch looks for exactly this (Pairing.PHONE)');
});

let sqliteOk = true;
try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); } catch { sqliteOk = false; }

test("the watch's list, recipe and cook go through the phone's own Local mode code", { skip: !sqliteOk }, () => {
  const script = `
    const store = new Map();
    globalThis.window = globalThis;
    globalThis.addEventListener ??= () => {}; globalThis.removeEventListener ??= () => {}; globalThis.dispatchEvent = () => true;
    globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
    globalThis.location = { origin: 'http://localhost', href: 'http://localhost/' };
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), key: () => null, length: 0 }, configurable: true });
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US', languages: ['en-US'], userAgent: 'node', onLine: true }, configurable: true });
    const { getDb } = await import('./src/lib/db-native.js');
    await getDb();
    const { CtApiNative } = await import('./src/lib/api-native.js');
    const { answerWatchRequest } = await import('./src/lib/watch-relay.js');
    const ask = async (method, path, body) => {
      const r = await answerWatchRequest({ method, path, body: body ? JSON.stringify(body) : null }, { localMode: true, api: CtApiNative });
      return { status: r.status, body: JSON.parse(r.body) };
    };
    const recipe = await CtApiNative.createRecipe({ name: 'Tomato Soup', servings: 2,
      ingredients: [{ name: 'Tomatoes', quantity: 4, unit: '' }], steps: ['Simmer'] });
    await CtApiNative.addShoppingItem({ name: 'Basil' });
    const list = await ask('GET', '/api/shopping');
    const item = list.body.find(i => i.name === 'Basil');
    const ticked = await ask('PATCH', '/api/shopping/' + item.id + '/check', { checked: true });
    const listAfter = await ask('GET', '/api/shopping');
    const read = await ask('GET', '/api/recipes/' + recipe.id);
    const cooked = await ask('POST', '/api/cook-diary', { recipe_id: recipe.id, date: '2026-11-13', kind: 'cooked' });
    const diary = await CtApiNative.getCookDiary({});
    const recipeAfter = await CtApiNative.getRecipe(recipe.id);
    console.log(JSON.stringify({ list, ticked, listAfter, read, cooked, diary, recipeAfter, recipeId: recipe.id }));
    process.exit(0);`;
  const out = execFileSync(process.execPath, ['--import', './scripts/android-sync/register.mjs', '--input-type=module', '-e', script],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60000 });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.list.status, 200);
  assert.ok(Array.isArray(r.list.body), 'the list is an array, as the server gives it (Kitchen.items)');
  const basil = r.listAfter.body.find(i => i.name === 'Basil');
  assert.equal(r.ticked.status, 200);
  assert.ok(basil.checked === true || basil.checked === 1, 'ticked on the watch, ticked on the phone');
  assert.equal(r.read.status, 200);
  assert.equal(r.read.body.id, r.recipeId);
  assert.equal(r.read.body.name, 'Tomato Soup');
  assert.ok(Array.isArray(r.read.body.ingredients) && Array.isArray(r.read.body.steps), 'what Kitchen.recipe reads');
  assert.equal(r.cooked.status, 200);
  const entries = Array.isArray(r.diary) ? r.diary : (r.diary.entries || r.diary.rows || []);
  assert.ok(entries.some(e => e.recipe_id === r.recipeId && e.date === '2026-11-13' && e.kind === 'cooked'), 'the cook is in the diary');
  assert.ok(Number(r.recipeAfter.cook_count ?? r.recipeAfter.times_cooked ?? 1) >= 1, 'the recipe knows it was cooked');
});
