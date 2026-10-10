/**
 * Phase 4 of Plan your week (src/lib/allergens.js): what a recipe
 * contains, from its pantry items' labels and its ingredients' names, and
 * who in the household it's a problem for, on the days they're home.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  nameCodes, cleanCodes, knownCodes, itemAllergens, recipeAllergens, allergenSummary,
  cleanHousehold, homeOn, conflicts, dislikesIn, allergenKey,
} from '../src/lib/allergens.js';

test('the server and the app use the same allergens.js', () => {
  assert.equal(readFileSync(new URL('../server/lib/allergens.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/lib/allergens.js', import.meta.url), 'utf8'));
});

test('names: what they mean, and what only looks like it', () => {
  const cases = {
    'all-purpose flour': ['en:gluten'],
    'Gluten-free all purpose flour': [],
    'almond flour': ['en:nuts'],
    'soy sauce': ['en:gluten', 'en:soybeans'],
    'tamari': ['en:soybeans'],
    'Parmigiano-Reggiano': ['en:milk'],
    'unsalted butter': ['en:milk'],
    'vegan butter': [],
    'peanut butter': ['en:peanuts'],
    'coconut milk': [],
    'butternut squash': [],
    'eggplant': [],
    'large eggs': ['en:eggs'],
    'nutmeg': [],
    'pine nuts': [],
    'walnuts': ['en:nuts'],
    'Worcestershire sauce': ['en:fish'],
    'oyster sauce': ['en:molluscs'],
    'oyster mushrooms': [],
    'tahini': ['en:sesame-seeds'],
    'dry white wine': ['en:sulphur-dioxide-and-sulphites'],
    'Dijon mustard': ['en:mustard'],
    'chicken thighs': ['meat'],
    'vegetable broth': [],
    'goat cheese': ['en:milk'],
    'honey': ['honey'],
    'honeydew melon': [],
    'shrimp': ['en:crustaceans'],
    'queso fresco': ['en:milk'],
    'atún': ['en:fish'],
    'corn tortillas': [],
    'flour tortillas': ['en:gluten'],
    'salt': [],
  };
  for (const [name, want] of Object.entries(cases)) assert.deepEqual(nameCodes(name), want, name);
});

test('codes are cleaned to the known ones, once each, in order', () => {
  assert.deepEqual(cleanCodes(['en:milk', 'en:soy', 'gluten', 'en:milk', 'en:unknown']), ['en:gluten', 'en:soybeans', 'en:milk']);
  assert.deepEqual(cleanCodes('["en:sesame"]'), ['en:sesame-seeds']);
  assert.equal(knownCodes(null), null, 'not known');
  assert.deepEqual(knownCodes('[]'), [], 'known to have none');
  assert.equal(allergenKey('en:sulphur-dioxide-and-sulphites'), 'sulphur_dioxide_and_sulphites');
});

const pantry = new Map([
  [1, { id: 1, name: 'Gluten-Free Flour Blend', allergens: '[]', traces: '["en:nuts"]', allergens_source: 'label' }],
  [2, { id: 2, name: 'Bread', allergens: null, traces: null }],
  [3, { id: 3, name: 'Stock', allergens: '["en:celery"]', traces: null, allergens_source: 'user' }],
]);

test('a pantry item\'s label wins over the name; without one, the name decides', () => {
  assert.deepEqual(itemAllergens({ name: 'flour', pantry_item_id: 1 }, pantry), { contains: [], traces: ['en:nuts'], source: 'label' });
  assert.deepEqual(itemAllergens({ name: 'bread', pantry_item_id: 2 }, pantry), { contains: ['en:gluten'], traces: [], source: 'name' });
  assert.deepEqual(itemAllergens({ name: 'chicken stock', pantry_item_id: 3 }, pantry), { contains: ['en:celery', 'meat'], traces: [], source: 'you' }, 'the diet still comes from the name');
});

test('a recipe adds up its ingredients, keeps which ones, and takes its own correction', () => {
  const recipe = { ingredients: [{ name: 'Dough', items: [{ name: 'flour', pantry_item_id: 1 }, { name: 'butter' }, { name: 'eggs' }] }, { items: [{ name: 'walnuts' }] }] };
  const a = recipeAllergens(recipe, pantry);
  assert.deepEqual(a.contains.map(x => [x.code, x.items, x.source]), [['en:eggs', ['eggs'], 'name'], ['en:milk', ['butter'], 'name'], ['en:nuts', ['walnuts'], 'name']]);
  assert.deepEqual(a.traces, [], 'contains wins over may contain');
  const fixed = recipeAllergens({ ...recipe, allergen_overrides: '{"add":["en:sesame-seeds"],"remove":["en:eggs"]}' }, pantry);
  assert.deepEqual(fixed.contains.map(x => x.code), ['en:milk', 'en:nuts', 'en:sesame-seeds']);
  assert.equal(fixed.contains.at(-1).source, 'you');
  assert.deepEqual(allergenSummary({ ingredients: [{ items: [{ name: 'flour', pantry_item_id: 1 }] }] }, pantry), { contains: [], traces: ['en:nuts'] });
  assert.deepEqual(allergenSummary({ ingredients: '[{"qty":"1","name":"milk"}]' }, null), { contains: ['en:milk'], traces: [] }, 'old flat ingredients');
});

test('the household: who is home, what they avoid, what they dislike', () => {
  const members = cleanHousehold([
    { id: 'a', name: 'Alex', allergies: ['en:peanuts'], diet: [], days: [] },
    { id: 's', name: 'Sam', allergies: ['gluten'], diet: ['vegetarian'], dislikes: ['mushroom'], days: [1, 2, 3, 4] },
    { name: '  ' },
  ]);
  assert.equal(members.length, 2);
  assert.deepEqual(members[1].allergies, ['en:gluten']);
  // 2030-01-05 is a Saturday, 2030-01-07 a Monday.
  assert.deepEqual(homeOn(members, '2030-01-05').map(m => m.name), ['Alex']);
  assert.deepEqual(homeOn(members, '2030-01-07').map(m => m.name), ['Alex', 'Sam']);
  const summary = { contains: ['en:gluten', 'meat'], traces: ['en:peanuts'] };
  assert.deepEqual(conflicts(summary, members), { contains: [{ code: 'en:gluten', who: ['Sam'] }, { code: 'meat', who: ['Sam'] }], traces: [{ code: 'en:peanuts', who: ['Alex'] }] });
  assert.deepEqual(conflicts(summary, members, { date: '2030-01-05' }).contains, [], 'Sam is away on Saturday');
  const recipe = { ingredients: [{ items: [{ name: 'Mushrooms' }, { name: 'rice' }] }] };
  assert.deepEqual(dislikesIn(recipe, members, { date: '2030-01-07' }), [{ item: 'Mushrooms', who: ['Sam'] }]);
  assert.deepEqual(dislikesIn(recipe, members, { date: '2030-01-05' }), []);
});
