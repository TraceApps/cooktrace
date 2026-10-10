/**
 * The Diary's Week view (src/lib/week.js): weeks start where the person's
 * locale starts them, and the plan summary counts what the week needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstDayOfWeek, weekStartOf, weekDays, weekdayNames, weekNeeds, isoDay, fromIso } from '../src/lib/week.js';

test('the week starts on the locale\'s first day', () => {
  assert.equal(firstDayOfWeek('en-US'), 0, 'Sunday');
  assert.equal(firstDayOfWeek('en-CA'), 0);
  assert.equal(firstDayOfWeek('en-GB'), 1, 'Monday');
  assert.equal(firstDayOfWeek('de-DE'), 1);
  assert.equal(firstDayOfWeek('es-ES'), 1);
});

test('a date belongs to the week of its first day', () => {
  const sat = fromIso('2026-10-10'); // a Saturday
  assert.equal(isoDay(weekStartOf(sat, 0)), '2026-10-04', 'Sunday-first');
  assert.equal(isoDay(weekStartOf(sat, 1)), '2026-10-05', 'Monday-first');
  assert.equal(isoDay(weekStartOf(fromIso('2026-10-04'), 1)), '2026-09-28', 'a Sunday is the end of a Monday week');
  assert.deepEqual(weekDays(fromIso('2026-10-05')).map(d => d.iso), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  assert.deepEqual(weekdayNames('en-US', 1).slice(0, 2), ['Mon', 'Tue']);
  assert.deepEqual(weekdayNames('en-US', 0).slice(0, 2), ['Sun', 'Mon']);
});

test('the plan summary counts what is needed, what is in stock and what it uses up', () => {
  const pantry = [
    { id: 1, name: 'Tomatoes', in_stock: 1, expires_on: '2030-01-09' },
    { id: 2, name: 'Eggs', in_stock: 0 },
    { id: 3, name: 'Milk', in_stock: 0 },
    { id: 4, name: 'Oat Milk', in_stock: 1, generic_parent_id: 3, expires_on: '2030-03-01' },
  ];
  const recipes = new Map([
    [10, { id: 10, ingredients: [{ items: [{ name: 'tomatoes', pantry_item_id: 1 }, { name: 'eggs', pantry_item_id: 2 }, { name: 'salt' }] }] }],
    [11, { id: 11, ingredients: JSON.stringify([{ items: [{ name: 'Tomato', pantry_item_id: 1 }, { name: 'milk', pantry_item_id: 3 }, { name: 'Salt' }] }]) }],
  ]);
  const planned = [{ id: 100, recipe_id: 10 }, { id: 101, recipe_id: 11 }];
  const base = { planned, recipes, pantry, weekEnd: '2030-01-13', today: '2030-01-07' };
  const n = weekNeeds({ ...base, list: [] });
  assert.equal(n.meals, 2);
  assert.equal(n.toBuy, 2, 'eggs and salt (once, though both recipes name it)');
  assert.equal(n.inPantry, 2, 'tomatoes, and milk through its variant in stock');
  assert.equal(n.expiring, 1, 'the tomatoes expire this week');
  assert.equal(n.built, false);
  const built = weekNeeds({ ...base, list: [{ name: 'Eggs', sources: JSON.stringify([{ diary_id: 100 }]) }] });
  assert.equal(built.built, true, 'the list holds this week\'s plan');
  assert.equal(weekNeeds({ ...base, planned: [], list: [] }).meals, 0);
});
