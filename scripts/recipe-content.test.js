/**
 * Recipe history (#54), the shared part (src/lib/recipe-content.js): what a
 * version is, its key, and what changed between two versions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cookContent, revisionOf, revOf, parseRevision, compareContent, changeSummary, diffWords, numberRevisions,
} from '../src/lib/recipe-content.js';

test('the server and the app use the same recipe-content.js', () => {
  assert.equal(readFileSync(new URL('../server/lib/recipe-content.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/lib/recipe-content.js', import.meta.url), 'utf8'));
});

const scones = {
  name: 'Scones', img_url: '/uploads/a.jpg', notes: 'Grandma', tags: ['baking'],
  servings: 8, prep_minutes: 15, cook_minutes: 12,
  ingredients: [{ name: 'Dough', items: [
    { id: 'i1', qty: '300', unit: 'g', name: 'flour', pantry_item_id: 4 },
    { id: 'i2', qty: '1/2', unit: 'cup', name: 'buttermilk' },
    { id: 'i3', qty: '50', unit: 'g', name: 'butter', note: 'cold' },
  ] }],
  steps: ['Rub the butter into the flour.', { title: 'Bake', text: 'Bake at 220°C.', refIds: ['i1'] }],
};

test('a version is what you cook: a new photo, title, notes or pantry link is not one', () => {
  const v = revisionOf(scones);
  assert.equal(revisionOf({ ...scones, name: 'Best Scones', img_url: '/uploads/b.jpg', notes: 'x', tags: [], category_id: 3 }).rev, v.rev);
  const relinked = structuredClone(scones); relinked.ingredients[0].items[0].pantry_item_id = 99;
  assert.equal(revisionOf(relinked).rev, v.rev);
  assert.equal(v.data.ingredients[0].items[0].pantry_item_id, undefined, 'pantry links are not kept');
  assert.equal(v.data.ingredients[0].items[0].id, 'i1', 'ingredient ids are, for lining up');
  assert.deepEqual(v.data.steps[1].refIds, ['i1']);
});

test('the same content is the same version however it is written', () => {
  const v = revisionOf(scones).rev;
  const same = structuredClone(scones);
  same.steps[0] = { title: '', text: '  Rub the butter into the flour.  ' };   // the editor's shape
  same.ingredients[0].items[1].qty = '0.5'; same.ingredients[0].items[1].unit = 'cups';
  same.ingredients[0].items[0].id = 'other-id';
  same.servings = '8';
  assert.equal(revisionOf(same).rev, v);
  assert.equal(revisionOf({ ...scones, ingredients: JSON.stringify(scones.ingredients), steps: JSON.stringify(scones.steps) }).rev, v, 'a stored row');
  const unnamed = { ...scones, ingredients: [{ name: '', items: scones.ingredients[0].items }] };
  assert.equal(revisionOf({ ...scones, ingredients: scones.ingredients[0].items }).rev, revisionOf(unnamed).rev, 'the older flat list');
  assert.match(v, /^v[0-9a-f]{14}$/);
});

test('a change to what you cook is a new version', () => {
  const v = revisionOf(scones).rev;
  const less = structuredClone(scones); less.ingredients[0].items[0].qty = '250';
  assert.notEqual(revisionOf(less).rev, v);
  assert.notEqual(revisionOf({ ...scones, cook_minutes: 14 }).rev, v);
  assert.notEqual(revisionOf({ ...scones, steps: [...scones.steps, 'Cool.'] }).rev, v);
  assert.equal(revOf(parseRevision(JSON.stringify(revisionOf(less).data))), revisionOf(less).rev, 'stored and read back');
});

test('what changed: amounts, added and removed ingredients, steps and times', () => {
  const a = cookContent(scones);
  const next = structuredClone(scones);
  next.ingredients[0].items[0].qty = '250';
  next.ingredients[0].items.splice(2, 1);                                 // no butter
  next.ingredients[0].items.push({ id: 'i9', qty: '1', unit: 'tbsp', name: 'sugar' });
  next.steps[1] = { title: 'Bake', text: 'Bake at 200°C.' };
  next.cook_minutes = 15;
  const b = cookContent(next);
  assert.deepEqual(changeSummary(a, b), [
    { kind: 'ingredient_changed', name: 'flour', from: '300 g', to: '250 g' },
    { kind: 'ingredient_removed', name: 'butter' },
    { kind: 'ingredient_added', name: 'sugar' },
    { kind: 'detail', field: 'cook_minutes', from: 12, to: 15 },
    { kind: 'step_changed', n: 2 },
  ]);
  const d = compareContent(a, b);
  assert.deepEqual(d.ingredients.map(x => x.kind), ['changed', 'same', 'removed', 'added']);
  assert.deepEqual(changeSummary(a, a), [], 'nothing changed');
});

test('ingredients without ids line up by name, plurals included', () => {
  const a = cookContent({ ingredients: [{ items: [{ qty: '2', name: 'tomatoes' }, { qty: '1', name: 'onion' }] }] });
  const b = cookContent({ ingredients: [{ items: [{ qty: '1', name: 'onion' }, { qty: '3', name: 'Tomato' }] }] });
  assert.deepEqual(changeSummary(a, b), [{ kind: 'ingredient_changed', name: 'Tomato', from: '2', to: '3' }]);
  const c = cookContent({ ingredients: [{ items: [{ qty: '2', name: 'tomatoes', note: 'diced' }] }] });
  assert.deepEqual(changeSummary(a, c), [
    { kind: 'ingredient_changed', name: 'tomatoes', from: '2 tomatoes', to: '2 tomatoes, diced' },
    { kind: 'ingredient_removed', name: 'onion' },
  ], 'a note: the whole line');
});

test('steps: a step put in between is added, not every later one changed', () => {
  const a = cookContent({ steps: ['Mix', 'Rest', 'Bake'] });
  const b = cookContent({ steps: ['Mix', 'Chill', 'Rest', 'Bake'] });
  assert.deepEqual(changeSummary(a, b), [{ kind: 'step_added', n: 2 }]);
  assert.deepEqual(changeSummary(b, a), [{ kind: 'step_removed', n: 2 }]);
});

test('word changes in a step, and versions numbered by when they appeared', () => {
  assert.deepEqual(diffWords('Bake at 220°C for 12 min', 'Bake at 200°C for 15 min').filter(x => x.kind !== 'same'),
    [{ kind: 'removed', text: '220°C' }, { kind: 'added', text: '200°C' }, { kind: 'removed', text: '12' }, { kind: 'added', text: '15' }]);
  const n = numberRevisions([{ id: 3, created_at: '2026-10-03 09:00:00' }, { id: 1, created_at: '2026-10-01 09:00:00' }, { id: 2, created_at: '2026-10-03 09:00:00' }]);
  assert.deepEqual(n.map(r => [r.id, r.number]), [[1, 1], [2, 2], [3, 3]]);
});
