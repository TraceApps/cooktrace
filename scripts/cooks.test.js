/**
 * Cooks in progress: several at once, visible from anywhere, and handed to a
 * watch in the only id a watch can use.
 *
 * Cooking two things at once is the normal way to cook a meal, and the timers
 * were always tagged with the recipe they belong to. What was missing was
 * anywhere to see a cook when you are not on its page, which is how a dish
 * nobody was making stayed on a watch for a day.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  get length() { return store.size; },
  key: i => [...store.keys()][i],
};

const { get } = await import('svelte/store');
const cooks = await import('../src/stores/cooks.js');
const source = readFileSync(new URL('../src/routes/RecipeView.svelte', import.meta.url), 'utf8');

/** The store is module state, so a fresh test needs both halves cleared. */
function reset() {
  store.clear();
  cooks.activeCooks.set({});
}

test('two dishes can be underway at once', () => {
  reset();
  cooks.startCook(12, { name: 'Ragu', serverId: 112 });
  cooks.startCook(34, { name: 'Tiramisu', serverId: 134 });
  const list = cooks.cookList(get(cooks.activeCooks));
  assert.deepEqual(list.map(c => c.name), ['Ragu', 'Tiramisu']);
  assert.ok(cooks.isCooking(12) && cooks.isCooking(34));
});

test('the list keeps the order they were started in', () => {
  reset();
  cooks.startCook(9, { name: 'First' });
  cooks.startCook(4, { name: 'Second' });
  cooks.startCook(7, { name: 'Third' });
  assert.deepEqual(cooks.cookList(get(cooks.activeCooks)).map(c => c.name), ['First', 'Second', 'Third']);
});

test('finishing one leaves the other alone', () => {
  reset();
  cooks.startCook(12, { name: 'Ragu', serverId: 112 });
  cooks.startCook(34, { name: 'Tiramisu', serverId: 134 });
  cooks.endCook(12);
  assert.equal(cooks.isCooking(12), false);
  assert.equal(cooks.isCooking(34), true);
});

test('a cook survives a restart, and remembers which server recipe it is', () => {
  reset();
  cooks.startCook(12, { name: 'Ragu', serverId: 112 });
  const saved = JSON.parse(store.get('ct:cooks'));
  assert.equal(saved['12'].serverId, 112);
  assert.equal(saved['12'].name, 'Ragu');
});

test('a name or server id learned later is filled in without restarting the cook', () => {
  reset();
  cooks.startCook(12, {});
  const started = get(cooks.activeCooks)[12].at;
  cooks.describeCook(12, { name: 'Ragu', serverId: 112 });
  const after = get(cooks.activeCooks)[12];
  assert.equal(after.name, 'Ragu');
  assert.equal(after.serverId, 112);
  assert.equal(after.at, started, 'it is the same cook, not a new one');
});

test('the old per-recipe flags are carried over once and cleared', async () => {
  reset();
  store.set('ct:cookmode:163', '1');
  store.set('ct:cookmode:168', '1');
  const fresh = await import(`../src/stores/cooks.js?migrate=${Date.now()}`);
  const list = fresh.cookList(get(fresh.activeCooks));
  assert.deepEqual(list.map(c => c.localId).sort(), [163, 168]);
  assert.equal(store.get('ct:cookmode:163'), undefined);
});

test('starting a cook no longer ends the others', () => {
  // It briefly did, while a different bug was being chased.
  assert.doesNotMatch(source, /_endOtherCooks/);
});

test('cook mode follows the recipe on screen', () => {
  // Derived from the shared store, so the router reusing this page for a
  // different id cannot leave it believing the wrong thing.
  assert.match(source, /\$: cookMode = Number\.isFinite\(id\) && !!\$activeCooks\[id\]/);
});

test('the watch is given server ids only, and only for cooks that have one', () => {
  const pick = source.slice(source.indexOf('function _watchRecipeId'), source.indexOf('function _cooksForWatch'));
  assert.match(pick, /if \(!isNative\) return id;/);
  assert.match(pick, /Number\(recipe\.server_id\) \|\| 0/);
  const build = source.slice(source.indexOf('function _cooksForWatch'), source.indexOf('function _tellWatch'));
  assert.match(build, /filter\(c => c\.serverId > 0\)/);
  assert.match(build, /serverRecipeId: c\.serverId/);
});

test('what comes back from the watch is matched by server id', () => {
  const hear = source.slice(source.indexOf('async function _hearWatch'));
  assert.match(hear.slice(0, 1200), /byServer\.get\(Number\(cook\.serverRecipeId\)\)/);
  // A dish the watch finished is finished here too.
  assert.match(hear.slice(0, 1200), /endCook\(localId\)/);
});

test('the visibility listener is removed when the page goes', () => {
  assert.match(source, /onDestroy\(\(\) => document\.removeEventListener\('visibilitychange', _onVisible\)\)/);
  assert.doesNotMatch(source, /addEventListener\('visibilitychange', async \(\) =>/);
});

test('the strip navigates to the route the app actually has', () => {
  // The recipe route is /recipes/:id. Pushing /recipe/:id matched nothing,
  // so tapping a cook flashed and stayed where it was.
  const strip = readFileSync(new URL('../src/components/recipe/CookingNow.svelte', import.meta.url), 'utf8');
  assert.match(strip, /push\(`\/recipes\/\$\{first\.localId\}`\)/);
  // The bug: /recipe/:id matched no route, so a tap flashed and stayed put.
  assert.doesNotMatch(strip, /push\(`\/recipe\/\$\{/);
  // And it hides the one you are already looking at, by that same route.
  assert.match(strip, /\$location !== `\/recipes\/\$\{c\.localId\}`/);
});

test('every tap on the strip goes somewhere', () => {
  const strip = readFileSync(new URL('../src/components/recipe/CookingNow.svelte', import.meta.url), 'utf8');
  // One dish: straight to it. Several: a picker, never a dead "more" row
  // that lands you on the page you are already on.
  assert.match(strip, /if \(showing\.length === 1\) push\(`\/recipes\/\$\{first\.localId\}`\);/);
  assert.match(strip, /else pickerOpen = true;/);
  assert.match(strip, /on:select=\{e => push\(`\/recipes\/\$\{e\.detail\.value\}`\)\}/);
  assert.doesNotMatch(strip, /push\('\/recipes'\)/);
});

test('it is one bar, not a stack that buries the page', () => {
  const strip = readFileSync(new URL('../src/components/recipe/CookingNow.svelte', import.meta.url), 'utf8');
  // No each-block over the cooks in the bar itself; the list lives in the
  // picker, which only opens when you ask for it.
  const markup = strip.slice(strip.indexOf('{#if first}'), strip.indexOf('<style>'));
  assert.doesNotMatch(markup, /\{#each/);
});

test('the strip stops ticking when the page is hidden', () => {
  const strip = readFileSync(new URL('../src/components/recipe/CookingNow.svelte', import.meta.url), 'utf8');
  assert.match(strip, /document\.hidden\) stop\(\)/);
  assert.match(strip, /onDestroy\(\(\) => \{[\s\S]{0,160}removeEventListener\('visibilitychange', onVisibility\)/);
});

test('ticking things off does not wake the watch once per tap', () => {
  const view = readFileSync(new URL('../src/routes/RecipeView.svelte', import.meta.url), 'utf8');
  // Every write to the Data Layer starts the watch's listener service, so a
  // burst of checks has to settle into one write.
  assert.match(view, /_tellTimer\s*=\s*setTimeout\(send,\s*\d+\)/);
  // The handover is the exception: a recipe should reach the wrist at once.
  assert.match(view, /_tellWatch\(\{\s*now:\s*true\s*\}\)/);
  // And nothing may be lost by leaving the page mid-burst.
  assert.match(view, /onDestroy\(\(\)\s*=>\s*\{\s*if\s*\(_tellTimer/);
});
