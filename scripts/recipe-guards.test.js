import assert from 'node:assert/strict';
import test from 'node:test';

import { isEmptyForGuard, guardNestedRecipeFields } from '../server/lib/recipe-guards.js';

// Tests for the CT wipe-guard (Option E, 2026-08-11). See
// project_traceapps_diary_merge_port memory + server/lib/recipe-guards.js
// for the shared design rationale.

test('isEmptyForGuard: null/undefined always empty', () => {
  assert.equal(isEmptyForGuard(null),      true);
  assert.equal(isEmptyForGuard(undefined), true);
});

test('isEmptyForGuard: empty arrays are empty', () => {
  assert.equal(isEmptyForGuard([], 'array'),       true);
  assert.equal(isEmptyForGuard([], 'ingredients'), true);
});

test('isEmptyForGuard: non-empty array is non-empty', () => {
  assert.equal(isEmptyForGuard([{ foo: 1 }], 'array'), false);
});

test('isEmptyForGuard: ingredients with only empty sections counts as empty', () => {
  assert.equal(isEmptyForGuard([{ name: '', items: [] }], 'ingredients'), true);
  assert.equal(isEmptyForGuard([{ name: 'Sauce', items: [] }, { items: [] }], 'ingredients'), true);
});

test('isEmptyForGuard: ingredients with any populated section is non-empty', () => {
  assert.equal(isEmptyForGuard([
    { name: '', items: [] },
    { name: 'Sauce', items: [{ name: 'garlic' }] },
  ], 'ingredients'), false);
});

test('isEmptyForGuard: empty object treated as empty', () => {
  assert.equal(isEmptyForGuard({}, 'object'), true);
});

test('guardNestedRecipeFields: incoming empty + server has content → server wins', () => {
  const existing = {
    ingredients: JSON.stringify([{ name: '', items: [{ name: 'onion', qty: '1' }] }]),
    steps:       JSON.stringify([{ text: 'chop' }]),
    tags:        JSON.stringify(['dinner']),
    tools:       JSON.stringify(['knife']),
    nutrition:   JSON.stringify({ calories: 200 }),
  };
  const incoming = {
    ingredients: JSON.stringify([]),
    steps:       JSON.stringify([]),
    tags:        JSON.stringify([]),
    tools:       JSON.stringify([]),
    nutrition:   JSON.stringify({}),
  };
  const out = guardNestedRecipeFields({ existing, incoming });
  assert.equal(out.ingredients, existing.ingredients, 'ingredients preserved');
  assert.equal(out.steps,       existing.steps,       'steps preserved');
  // Tags are deliberately NOT guarded — user's "clear all tags" edit
  // should apply. Different from other nested fields: tags are a small
  // flat string array, blast radius of a stale-client wipe is small,
  // and the guard would silently revert a common UI action.
  assert.equal(out.tags,        incoming.tags,        'tags cleared (not guarded)');
  assert.equal(out.tools,       existing.tools,       'tools preserved');
  assert.equal(out.nutrition,   existing.nutrition,   'nutrition preserved');
});

test('guardNestedRecipeFields: incoming non-empty always wins over server', () => {
  const existing = {
    ingredients: JSON.stringify([{ name: '', items: [{ name: 'onion' }] }]),
    steps:       JSON.stringify([{ text: 'old step' }]),
    tags:        JSON.stringify(['old']),
    tools:       JSON.stringify(['old-tool']),
    nutrition:   JSON.stringify({ calories: 100 }),
  };
  const incoming = {
    ingredients: JSON.stringify([{ name: '', items: [{ name: 'garlic' }, { name: 'tomato' }] }]),
    steps:       JSON.stringify([{ text: 'new step 1' }, { text: 'new step 2' }]),
    tags:        JSON.stringify(['dinner', 'italian']),
    tools:       JSON.stringify(['pan', 'knife']),
    nutrition:   JSON.stringify({ calories: 350 }),
  };
  const out = guardNestedRecipeFields({ existing, incoming });
  assert.equal(out.ingredients, incoming.ingredients);
  assert.equal(out.steps,       incoming.steps);
  assert.equal(out.tags,        incoming.tags);
  assert.equal(out.tools,       incoming.tools);
  assert.equal(out.nutrition,   incoming.nutrition);
});

test('guardNestedRecipeFields: mixed — some incoming empty, others non-empty', () => {
  const existing = {
    ingredients: JSON.stringify([{ name: '', items: [{ name: 'onion' }] }]),
    steps:       JSON.stringify([{ text: 'chop' }]),
    tags:        JSON.stringify(['dinner']),
    tools:       JSON.stringify(['knife']),
    nutrition:   JSON.stringify({}),
  };
  const incoming = {
    ingredients: JSON.stringify([]),                              // empty → preserve
    steps:       JSON.stringify([{ text: 'chop finely' }]),       // non-empty → wins
    tags:        JSON.stringify([]),                              // empty → preserve
    tools:       JSON.stringify(['knife', 'board']),              // non-empty → wins
    nutrition:   JSON.stringify({ calories: 200 }),               // non-empty → wins (server was empty anyway)
  };
  const out = guardNestedRecipeFields({ existing, incoming });
  assert.equal(out.ingredients, existing.ingredients);
  assert.equal(out.steps,       incoming.steps);
  assert.equal(out.tags,        incoming.tags, 'tags cleared (not guarded)');
  assert.equal(out.tools,       incoming.tools);
  assert.equal(out.nutrition,   incoming.nutrition);
});

test('guardNestedRecipeFields: both empty leaves incoming empty', () => {
  const existing = { ingredients: JSON.stringify([]), steps: JSON.stringify([]), tags: JSON.stringify([]), tools: JSON.stringify([]), nutrition: JSON.stringify({}) };
  const incoming = { ingredients: JSON.stringify([]), steps: JSON.stringify([]), tags: JSON.stringify([]), tools: JSON.stringify([]), nutrition: JSON.stringify({}) };
  const out = guardNestedRecipeFields({ existing, incoming });
  assert.deepEqual(out, incoming);
});

test('regression: stale mobile client whose recipe cache lost ingredients cannot wipe them', () => {
  const existing = {
    ingredients: JSON.stringify([
      { name: '', items: [
        { name: 'flour',  qty: '500', unit: 'g' },
        { name: 'yeast',  qty: '7',   unit: 'g' },
        { name: 'water',  qty: '350', unit: 'ml' },
        { name: 'salt',   qty: '10',  unit: 'g' },
      ]},
    ]),
    steps: JSON.stringify([{ text: 'mix' }, { text: 'knead' }, { text: 'rise' }, { text: 'bake' }]),
    tags: JSON.stringify(['bread']),
    tools: JSON.stringify(['oven', 'bowl']),
    nutrition: JSON.stringify({ calories: 320 }),
  };
  // Mobile app opened stale, user changed just the notes, PUT sends
  // whole row with empty nested arrays (stale cache).
  const incoming = {
    ingredients: JSON.stringify([]),
    steps: JSON.stringify([]),
    tags: JSON.stringify([]),
    tools: JSON.stringify([]),
    nutrition: JSON.stringify({}),
  };
  const out = guardNestedRecipeFields({ existing, incoming });
  assert.equal(out.ingredients, existing.ingredients, 'ingredients survived stale wipe attempt');
  assert.equal(out.steps,       existing.steps,       'steps survived');
  // Tags: intentional carve-out. Small blast radius, common clear
  // action in the UI, so we accept the stale-client wipe risk for
  // this specific field. If a user reports lost tags from a stale
  // sync, promote tags back into CHECKS.
  assert.equal(out.tags,        incoming.tags,        'tags cleared (not in guard list)');
  assert.equal(out.tools,       existing.tools,       'tools survived');
  assert.equal(out.nutrition,   existing.nutrition,   'nutrition survived');
});

test('guardNestedRecipeFields: flat-shape ingredients are NOT treated as empty (finding #1)', () => {
  // Regression from code review: any element with a non-empty `.name`
  // (flat shape OR grouped heading) is content and must NOT trigger
  // the empty-guard. Prior implementation required `.items` on every
  // element and silently classified flat-shape ingredients as empty,
  // dropping non-empty updates from any client sending the legacy
  // flat shape (older builds, AI generators).
  const existing = {
    ingredients: JSON.stringify([{ name: '', items: [{ name: 'onion' }] }]),
    steps:       JSON.stringify([{ text: 'chop' }]),
    tools:       JSON.stringify(['knife']),
    nutrition:   JSON.stringify({}),
  };
  const incoming = {
    ingredients: JSON.stringify([
      { name: 'garlic', quantity: '2',   unit: 'clove' },
      { name: 'tomato', quantity: '400', unit: 'g'     },
    ]),
    steps:       JSON.stringify([{ text: 'sauté' }]),
    tools:       JSON.stringify(['pan']),
    nutrition:   JSON.stringify({ calories: 180 }),
  };
  const out = guardNestedRecipeFields({ existing, incoming });
  assert.equal(out.ingredients, incoming.ingredients, 'flat-shape ingredients wrote through');
});
