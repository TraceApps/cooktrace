/**
 * Phase 3 of Plan your week (src/lib/plan-ideas.js): "Uses Up" finds
 * what's about to expire and the recipes that use the most of it, and
 * "Build My Week" picks dinners from the recipes and the pantry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usesUp, buildWeek, freeDays, picksNeeds, pantryIndex, recipeNeeds } from '../src/lib/plan-ideas.js';

const today = '2030-01-07';
const horizon = '2030-01-14';
const pantry = [
  { id: 1, name: 'Avocados', in_stock: 1, expires_on: '2030-01-09' },
  { id: 2, name: 'Cilantro', in_stock: 1, expires_on: '2030-01-08' },
  { id: 3, name: 'Limes', in_stock: 1, expires_on: '2030-01-20' },
  { id: 4, name: 'Rice', in_stock: 1 },
  { id: 5, name: 'Milk', in_stock: 0 },
  { id: 6, name: 'Oat Milk', in_stock: 1, generic_parent_id: 5, expires_on: '2030-01-10' },
  { id: 7, name: 'Eggs', in_stock: 0 },
];
const R = (id, name, items, extra = {}) => ({ id, name, ingredients: [{ items }], ...extra });
const guac = R(1, 'Guacamole', [{ name: 'avocado', pantry_item_id: 1 }, { name: 'cilantro' }, { name: 'limes', pantry_item_id: 3 }]);
const tacos = R(2, 'Tacos', [{ name: 'tortillas' }, { name: 'Cilantro', pantry_item_id: 2 }]);
const porridge = R(3, 'Porridge', [{ name: 'oats' }, { name: 'oat milk', pantry_item_id: 6 }], { last_cooked_at: '2030-01-05' });
const fried = R(4, 'Fried Rice', [{ name: 'rice', pantry_item_id: 4 }, { name: 'eggs', pantry_item_id: 7 }], { last_cooked_at: '2029-11-01' });
const soup = R(5, 'Soup', [{ name: 'water' }], { total_minutes: 90 });
const recipes = [guac, tacos, porridge, fried, soup];

test('a variant belongs to its generic item; names match without a link', () => {
  const idx = pantryIndex(pantry, { today, horizon });
  assert.ok(idx.stocked.has(5), 'Milk is in stock through Oat Milk');
  assert.deepEqual([...recipeNeeds(porridge, idx).families], [5]);
  assert.deepEqual([...recipeNeeds(guac, idx).families].sort(), [1, 2, 3], '"cilantro" with no link is the Cilantro in the pantry');
});

test('Uses Up lists what expires soon, who plans to use it, and what would use the most of it', () => {
  const r = usesUp({ recipes, pantry, planned: [{ recipe_id: 2 }], today, horizon });
  assert.deepEqual(r.items.map(x => x.name), ['Cilantro', 'Avocados', 'Milk'], 'soonest first; limes expire after the horizon');
  assert.deepEqual(r.items[0].plannedBy, ['Tacos']);
  assert.equal(r.items[0].daysLeft, 1);
  assert.equal(r.ideas[0].recipe.name, 'Guacamole', 'uses two of them');
  assert.deepEqual(r.ideas[0].uses, ['Cilantro', 'Avocados']);
  assert.ok(!r.ideas.some(i => i.recipe.name === 'Tacos'), 'what is planned is not suggested again');
  assert.deepEqual(usesUp({ recipes, pantry: pantry.map(p => ({ ...p, expires_on: null })), planned: [], today, horizon }), { items: [], ideas: [] });
});

test('Build My Week picks what uses things up, skips what was just cooked, and says why', () => {
  const picks = buildWeek({ recipes, pantry, today, horizon, count: 3, options: {} });
  assert.equal(picks[0].recipe.name, 'Guacamole');
  assert.deepEqual(picks[0].reason, { kind: 'uses', items: ['Avocados', 'Cilantro'] });
  assert.ok(picks.findIndex(p => p.recipe.name === 'Porridge') !== 0, 'cooked two days ago: not first');
  assert.equal(new Set(picks.map(p => p.recipe.id)).size, 3, 'no repeats');
  const quick = buildWeek({ recipes, pantry, today, horizon, count: 5, options: { quick: true } });
  assert.ok(!quick.some(p => p.recipe.name === 'Soup'), '90 minutes is not quick');
  const without = buildWeek({ recipes, pantry, today, horizon, count: 5, options: {}, exclude: new Set([1]) });
  assert.ok(!without.some(p => p.recipe.id === 1), 'already planned that week');
});

test('Swap gives the next best for that slot', () => {
  const first = buildWeek({ recipes, pantry, today, horizon, count: 2, options: {} });
  const swapped = buildWeek({ recipes, pantry, today, horizon, count: 2, options: {}, skip: { 0: new Set([first[0].recipe.id]) } });
  assert.notEqual(swapped[0].recipe.id, first[0].recipe.id);
});

test('new dinners go on free days from today, and the totals count each need once', () => {
  assert.deepEqual(freeDays('2030-01-06', ['2030-01-08'], '2030-01-07'), ['2030-01-07', '2030-01-09', '2030-01-10', '2030-01-11', '2030-01-12']);
  assert.deepEqual(freeDays('2030-01-13', [], '2030-01-07').length, 7, 'a week ahead is all free');
  assert.deepEqual(picksNeeds([{ recipe: tacos }, { recipe: guac }], pantry, { today, horizon }), { toBuy: 1, expiring: 2 }, 'tortillas to buy; cilantro and avocados used up');
});
