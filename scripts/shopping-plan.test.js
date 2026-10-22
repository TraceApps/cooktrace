/**
 * A plan or a recipe onto the shopping list (lib/shopping-plan.js): amounts
 * scale to the planned servings, the same ingredient adds up across
 * recipes and units of one kind, each row keeps where its amount came
 * from, and building the same week again replaces its share. Before, every
 * build added a second copy of each row, servings were ignored, and only
 * the first recipe's id was kept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  recipeContributions, mergeIntoList, parseSources, mapSourceIds, cleanSourceIds, scaleFor,
  cooksOnList, onlyListed, withoutRecipe,
} from '../src/lib/shopping-plan.js';

const WEEK = { from: '2030-01-07', to: '2030-01-13' };
const shak = { id: 1, servings: 2, ingredients: [{ items: [
  { id: 'a', name: 'Tomatoes', qty: '3' },
  { id: 'b', name: 'olive oil', qty: '2', unit: 'tbsp', pantry_item_id: 50 },
  { id: 'c', name: 'salt', qty: 'to taste' },
] }] };
const tacos = { id: 2, servings: 4, ingredients: JSON.stringify([{ items: [
  { id: 'x', name: 'tomato', qty: '2' },
  { id: 'y', name: 'Olive Oil', qty: '60', unit: 'ml' },
  { id: 'z', name: 'tortillas', qty: '8-10' },
] }]) };
const plan = (recipe, diaryId, date, servings) => recipeContributions(recipe, { diaryId, date, servings });
const asRows = r => r.inserts.map((x, i) => ({ id: i + 1, ...x, checked: 0 }));
const byName = (rows, n) => rows.find(r => r.name.toLowerCase().startsWith(n));

test('the server and the app use the same shopping-plan.js', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  assert.equal(read('server/lib/shopping-plan.js'), read('src/lib/shopping-plan.js'));
});

test('a recipe scales to the servings planned', () => {
  assert.equal(scaleFor(shak, 4), 2);
  assert.equal(scaleFor(shak, null), 1);
  assert.equal(scaleFor({ servings: null }, 4), 1, 'unknown base servings: as written');
  const c = plan(shak, 10, '2030-01-07', 4);
  assert.deepEqual(c.map(x => [x.name, x.qty, x.unit]), [['Tomatoes', 6, null], ['olive oil', 4, 'tbsp'], ['salt', null, null]]);
  assert.equal(c[0].ref, 'a');
  assert.equal(recipeContributions(tacos, {})[2].qty, 10, 'a range buys its upper end');
  assert.equal(recipeContributions(shak, { skip: it => it.pantry_item_id === 50 }).length, 2, 'in stock is left out');
});

test('the same ingredient adds up across recipes and units, one row each', () => {
  const r = mergeIntoList([], [...plan(shak, 10, '2030-01-07', 4), ...plan(tacos, 11, '2030-01-09', 4)], { window: WEEK });
  assert.equal(r.inserts.length, 4);
  const tom = byName(r.inserts, 'tomato');
  assert.equal(tom.quantity, 8);
  assert.equal(tom.recipe_id, 1);
  assert.deepEqual(parseSources(tom.sources).map(s => [s.recipe_id, s.diary_id, s.qty]), [[1, 10, 6], [2, 11, 2]]);
  const oil = byName(r.inserts, 'olive');
  assert.equal(oil.unit, 'tbsp');
  assert.equal(oil.quantity, 8, '4 tbsp + 60 ml');
  assert.equal(oil.pantry_id, 50);
  assert.equal(byName(r.inserts, 'salt').quantity, null);
});

test('building the same week again replaces its share; a hand-typed amount stays', () => {
  const first = mergeIntoList([], [...plan(shak, 10, '2030-01-07', 4), ...plan(tacos, 11, '2030-01-09', 4)], { window: WEEK });
  const rows = asRows(first);
  byName(rows, 'tomato').quantity = 10; // 2 more typed in
  const again = mergeIntoList(rows, [...plan(shak, 10, '2030-01-07', 4), ...plan(tacos, 11, '2030-01-09', 4)], { window: WEEK });
  assert.equal(again.inserts.length, 0, 'nothing doubled');
  assert.ok(!again.updates.some(u => u.id === byName(rows, 'tomato').id), 'the same plan again leaves the row as it is');
  assert.equal(byName(rows, 'tomato').quantity, 10, 'the 2 typed in stay');
  // The shakshuka for 6: its share grows, and the 2 typed in still stay.
  const more = mergeIntoList(rows, [...plan(shak, 10, '2030-01-07', 6), ...plan(tacos, 11, '2030-01-09', 4)], { window: WEEK });
  const tom = more.updates.find(u => u.id === byName(rows, 'tomato').id);
  assert.equal(tom.quantity, 13, '9 + 2 + 2 typed');
  assert.equal(parseSources(tom.sources).length, 2);
});

test('a cook taken off the plan takes its share out, and a row it alone made goes', () => {
  const rows = asRows(mergeIntoList([], [...plan(shak, 10, '2030-01-07', 4), ...plan(tacos, 11, '2030-01-09', 4)], { window: WEEK }));
  const r = mergeIntoList(rows, plan(shak, 10, '2030-01-07', 4), { window: WEEK });
  assert.equal(r.updates.find(u => u.id === byName(rows, 'tomato').id).quantity, 6);
  assert.deepEqual(r.deletes, [byName(rows, 'tortilla').id], 'only the tacos needed tortillas');
  const empty = mergeIntoList(rows, [], { window: WEEK });
  assert.equal(empty.deletes.length, 4, 'nothing planned: the plan rows go');
});

test("a cook outside the week built isn't touched", () => {
  const rows = asRows(mergeIntoList([], plan(tacos, 11, '2030-01-20', 4), { window: { from: '2030-01-20', to: '2030-01-26' } }));
  const r = mergeIntoList(rows, plan(shak, 10, '2030-01-07', 4), { window: WEEK });
  assert.equal(r.deletes.length, 0);
  assert.equal(r.updates.find(u => u.id === byName(rows, 'tomato').id).quantity, 8, 'next week stays, this week adds');
});

test('a line already checked off is bought: building again does not add it back', () => {
  const rows = asRows(mergeIntoList([], plan(shak, 10, '2030-01-07', 4), { window: WEEK }));
  byName(rows, 'tomato').checked = 1;
  const r = mergeIntoList(rows, plan(shak, 10, '2030-01-07', 4), { window: WEEK });
  assert.equal(r.inserts.length, 0);
  assert.ok(!r.updates.some(u => u.id === byName(rows, 'tomato').id));
});

test('adding a recipe (not a plan) adds each time, onto a hand-made row of the same thing', () => {
  const rows = [{ id: 7, name: 'Milk', quantity: 1, unit: 'l', checked: 0, sources: null }];
  const recipe = { id: 3, servings: 1, ingredients: [{ items: [{ name: 'milk', qty: '2', unit: 'cups' }] }] };
  const r1 = mergeIntoList(rows, recipeContributions(recipe, {}), {});
  assert.equal(r1.inserts.length, 0);
  assert.equal(r1.updates[0].unit, 'l');
  assert.ok(Math.abs(r1.updates[0].quantity - 1.47) < 0.01, `1 l + 2 cups = ${r1.updates[0].quantity} l`);
  const rows2 = [{ ...rows[0], quantity: r1.updates[0].quantity, sources: r1.updates[0].sources }];
  const r2 = mergeIntoList(rows2, recipeContributions(recipe, {}), {});
  assert.ok(Math.abs(r2.updates[0].quantity - 1.95) < 0.02, `twice the recipe, twice the milk: ${r2.updates[0].quantity}`);
});

test('counted things round up to whole ones, and the rounding is never taken for a typed amount', () => {
  const r = { id: 5, servings: 4, ingredients: [{ items: [{ id: 't', name: 'tomatoes', qty: '6' }] }] };
  const first = mergeIntoList([], recipeContributions(r, { diaryId: 1, date: '2030-01-07', servings: 5 }), { window: WEEK });
  assert.equal(first.inserts[0].quantity, 8, '7.5 tomatoes is 8 to buy');
  const rows = asRows(first);
  const fewer = mergeIntoList(rows, recipeContributions(r, { diaryId: 1, date: '2030-01-07', servings: 4 }), { window: WEEK });
  assert.equal(fewer.updates[0].quantity, 6, 'planned for 4 again: 6, not 6 plus the half rounded up before');
});

test('ids in sources map to the other side, and unknown ones wait', () => {
  const json = JSON.stringify([{ recipe_id: 1, diary_id: 10, name: 'x' }, { recipe_id: 2, diary_id: null, name: 'y' }]);
  const m = mapSourceIds(json, id => ({ 1: 101, 2: 102 })[id], id => ({ 10: 110 })[id]);
  assert.equal(m.unknown, false);
  assert.deepEqual(JSON.parse(m.json).map(s => [s.recipe_id, s.diary_id]), [[101, 110], [102, null]]);
  assert.equal(mapSourceIds(json, () => undefined, () => 1).unknown, true, 'not on the server yet');
  assert.deepEqual(JSON.parse(mapSourceIds(json, () => null, () => null).json).map(s => s.name), ['x', 'y'], 'an id gone keeps the line');
  const cleaned = JSON.parse(cleanSourceIds(json, id => id === 1, () => false));
  assert.deepEqual(cleaned.map(s => [s.recipe_id, s.diary_id]), [[1, null], [null, null]], "another account's ids are taken out");
  assert.deepEqual(parseSources('nonsense'), []);
  assert.deepEqual(parseSources(null), []);
});

// ── #81: the list follows the plan, and adds only what's short ──────────

test('a cook moved to next week and that week built is counted once', () => {
  const rows = asRows(mergeIntoList([], plan(tacos, 11, '2030-01-09', 4), { window: WEEK }));
  // Moved to the 16th; next week is built with the cooks the list holds.
  const NEXT = { from: '2030-01-14', to: '2030-01-20' };
  const r = mergeIntoList(rows, plan(tacos, 11, '2030-01-16', 4), { window: NEXT, cooks: new Set([11]) });
  assert.equal(r.inserts.length, 0, 'nothing doubled');
  const tort = r.updates.find(u => u.id === byName(rows, 'tortilla').id);
  assert.equal(tort.quantity, 10, '8-10 buys 10');
  assert.deepEqual(parseSources(tort.sources).map(s => s.date), ['2030-01-16'], 'the share is dated where the cook is now');
});

test("a changed cook's share follows it; a deleted one's comes out", () => {
  const rows = asRows(mergeIntoList([], [...plan(shak, 10, '2030-01-07', 4), ...plan(tacos, 11, '2030-01-09', 4)], { window: WEEK }));
  // The tacos for 8 instead of 4.
  const more = mergeIntoList(rows, [...plan(shak, 10, '2030-01-07', 4), ...plan(tacos, 11, '2030-01-09', 8)], { cooks: new Set([10, 11]) });
  assert.equal(more.updates.find(u => u.id === byName(rows, 'tortilla').id).quantity, 20);
  assert.equal(more.updates.find(u => u.id === byName(rows, 'tomato').id).quantity, 10);
  // The tacos deleted.
  const gone = mergeIntoList(rows, plan(shak, 10, '2030-01-07', 4), { cooks: new Set([10, 11]) });
  assert.deepEqual(gone.deletes, [byName(rows, 'tortilla').id]);
  assert.equal(gone.updates.find(u => u.id === byName(rows, 'tomato').id).quantity, 6);
});

test('the cooks a list holds are the ones on rows not yet bought', () => {
  const rows = asRows(mergeIntoList([], [...plan(shak, 10, '2030-01-07', 4), ...plan(tacos, 11, '2030-01-09', 4)], { window: WEEK }));
  assert.deepEqual([...cooksOnList(rows)].sort(), [10, 11]);
  for (const r of rows) if (parseSources(r.sources).some(s => s.diary_id === 11)) r.checked = 1;
  // Tomatoes and oil are shared with cook 10, so only its rows are left open.
  assert.deepEqual([...cooksOnList(rows)], [10]);
});

test("keeping up with a changed plan doesn't bring back what was bought and cleared", () => {
  const rows = asRows(mergeIntoList([], [...plan(shak, 10, '2030-01-07', 4), ...plan(tacos, 11, '2030-01-09', 4)], { window: WEEK }));
  // Tortillas bought and cleared: the row is gone.
  const left = rows.filter(r => !r.name.startsWith('tortilla'));
  const more = onlyListed([...plan(shak, 10, '2030-01-07', 4), ...plan(tacos, 11, '2030-01-09', 8)], left, [10, 11]);
  const r = mergeIntoList(left, more, { cooks: [10, 11] });
  assert.equal(r.inserts.length, 0, 'the tortillas stay off');
  assert.equal(r.updates.find(u => u.id === byName(left, 'tomato').id).quantity, 10, 'what is still there follows');
});

test('a plan change that leaves the list as it was writes nothing', () => {
  const lines = [...plan(shak, 10, '2030-01-07', 4), ...plan(tacos, 11, '2030-01-09', 4)];
  const rows = asRows(mergeIntoList([], lines, { window: WEEK }));
  const r = mergeIntoList(rows, lines, { cooks: [10, 11] });
  assert.deepEqual([r.inserts.length, r.updates.length, r.deletes.length], [0, 0, 0]);
});

test("a recipe's trash icon in By Recipe takes out only that recipe's share", () => {
  const pancakes = { id: 5, servings: 2, ingredients: [{ items: [{ id: 'f', name: 'Flour', qty: '1', unit: 'cup' }, { id: 'e', name: 'Eggs', qty: '2' }] }] };
  const bread = { id: 6, servings: 1, ingredients: [{ items: [{ id: 'f', name: 'flour', qty: '2', unit: 'cup' }] }] };
  let rows = asRows(mergeIntoList([], recipeContributions(pancakes, {})));
  rows = rows.map(r => ({ ...r, recipe_id: 5 }));
  const more = mergeIntoList(rows, recipeContributions(bread, {}));
  for (const u of more.updates) Object.assign(rows.find(r => r.id === u.id), u);
  const flour = byName(rows, 'flour');
  assert.equal(flour.quantity, 3, 'one Flour 3 cup item');
  // Pancakes off: its eggs go, the flour stays with bread's 2 cups, under bread.
  const r = withoutRecipe(rows, 5);
  assert.deepEqual(r.deletes, [byName(rows, 'egg').id]);
  assert.equal(r.updates.length, 1);
  assert.equal(r.updates[0].quantity, 2);
  assert.equal(r.updates[0].recipe_id, 6);
  // An amount typed in by hand stays even when its only recipe goes.
  flour.quantity = 4;
  const typed = withoutRecipe([flour], 5);
  assert.equal(typed.updates[0].quantity, 3, '2 for bread + 1 typed');
  // An item added before sources were kept goes with its recipe, as before.
  assert.deepEqual(withoutRecipe([{ id: 9, name: 'Salt', recipe_id: 5, sources: null }], 5).deletes, [9]);
});
