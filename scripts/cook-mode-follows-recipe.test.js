/**
 * Cook mode belongs to the recipe on screen.
 *
 * The router reuses the recipe page when only the id in the address changes,
 * so anything computed once at setup silently belongs to whichever recipe was
 * open first. Cook mode was one of those: walking from a recipe you were
 * cooking to one you were not left the second looking like it was being
 * cooked, and a paired watch was duly told so, which is how the watch ended up
 * showing a dish nobody was making.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/routes/RecipeView.svelte', import.meta.url), 'utf8');

test('cook mode is re-read when the id in the address changes', () => {
  assert.match(source, /\$: if \(Number\.isFinite\(id\) && id !== _cookModeFor\) \{[\s\S]{0,400}ct:cookmode:\$\{id\}/);
});

test('leftover ticks are cleared for the recipe you arrived at, not the one you started from', () => {
  const block = source.slice(source.indexOf('id !== _cookModeFor'), source.indexOf('let wakeLockSentinel'));
  assert.match(block, /ct:checks:\$\{id\}:ing/);
  assert.match(block, /ct:checks:\$\{id\}:step/);
});

test('the visibility listener is removed when the page goes', () => {
  assert.match(source, /addEventListener\('visibilitychange', _onVisible\)/);
  assert.match(source, /onDestroy\(\(\) => document\.removeEventListener\('visibilitychange', _onVisible\)\)/);
  // The shape of the bug: an anonymous handler nobody can ever take off.
  assert.doesNotMatch(source, /addEventListener\('visibilitychange', async \(\) =>/);
});

test('starting a cook ends any other', () => {
  const start = source.slice(source.indexOf('async function startCookMode'), source.indexOf('async function endCookMode'));
  assert.match(start, /_endOtherCooks\(\)/);
});

test('the watch is given the server id, never this phone local one', () => {
  // The native app keeps its own autoincrement ids and a separate server_id.
  // The watch fetches the recipe from the server, so sending the local id
  // makes it fetch whatever recipe holds that number there instead.
  const pick = source.slice(source.indexOf('function _watchRecipeId'), source.indexOf('function _tellWatch'));
  assert.match(pick, /if \(!isNative\) return id;/);
  assert.match(pick, /Number\(recipe\.server_id\) \|\| 0/);
  assert.match(pick, /Number\(recipe\.id\) !== id/);

  const tell = source.slice(source.indexOf('function _tellWatch'), source.indexOf('async function _hearWatch'));
  assert.match(tell, /recipeId: rid/);
  // And it refuses rather than sending something the watch cannot resolve.
  assert.match(tell, /if \(on && !rid\)/);
  assert.doesNotMatch(tell, /recipeId: id\b/);
});

test('what comes back from the watch is compared in the same units', () => {
  const hear = source.slice(source.indexOf('async function _hearWatch'));
  assert.match(hear.slice(0, 800), /theirs\.recipeId !== _watchRecipeId\(\)/);
});
