/**
 * The Nutrition Facts label's right column can read "Per 100 g" (100 ml for
 * drinks) instead of % Daily Value, matching NutriTrace
 * (TraceApps/nutritrace#297).
 *
 * Per 100 = value / serving in grams (or ml) * 100. A weight reads per
 * 100 g, a volume per 100 ml, and a serving with no weight leaves the
 * column blank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { per100, factsColumn, servingInBase, FACTS_COLUMN_DEFAULT } from '../src/lib/facts-column.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const EM_DASH = String.fromCharCode(8212);

test('a gram serving: 30 g with 12 g protein is 40 g per 100 g', () => {
  const base = servingInBase(30, 'g');
  assert.deepEqual(base, { amount: 30, basis: 'g' });
  close(per100(12, base), 40);
});

test('other weights convert to grams, spelled any way the app stores them', () => {
  close(servingInBase(1, 'oz').amount, 28.3495);
  assert.equal(servingInBase(1, 'oz').basis, 'g');
  close(servingInBase(0.5, 'kg').amount, 500);
  close(servingInBase(2, 'Grams').amount, 2);
});

test('a volume reads per 100 ml', () => {
  const base = servingInBase(250, 'ml');
  assert.deepEqual(base, { amount: 250, basis: 'ml' });
  close(per100(105, base), 42);
  const cup = servingInBase(1, 'cup');
  assert.equal(cup.basis, 'ml');
  close(cup.amount, 236.588);
  close(servingInBase(2, 'Tablespoons').amount, 2 * 14.787);
});

test('a serving with no weight leaves the column blank', () => {
  assert.equal(servingInBase(1, 'piece'), null);
  assert.equal(servingInBase(2, 'cloves'), null);
  assert.equal(servingInBase(1, ''), null);
  assert.equal(servingInBase(1, null), null);
  assert.equal(per100(12, null), null);
});

test('a zero, missing or bad serving leaves the column blank', () => {
  assert.equal(servingInBase(0, 'g'), null);
  assert.equal(servingInBase(-5, 'g'), null);
  assert.equal(servingInBase(null, 'g'), null);
  assert.equal(servingInBase('abc', 'g'), null);
  assert.equal(per100(12, { amount: 0, basis: 'g' }), null);
});

test('a missing value stays blank, a zero value stays zero', () => {
  const base = { amount: 50, basis: 'g' };
  assert.equal(per100(null, base), null);
  assert.equal(per100('', base), null);
  assert.equal(per100(0, base), 0);
  close(per100('2.5', base), 5);
});

test('the setting defaults to % Daily Value and keeps today\'s label', () => {
  assert.equal(FACTS_COLUMN_DEFAULT, 'dv');
  assert.equal(factsColumn(undefined), 'dv');
  assert.equal(factsColumn('bogus'), 'dv');
  assert.equal(factsColumn('per100'), 'per100');
  assert.match(read('src/stores/settings.js'), /createSettingStore\('nutritionFactsColumn', FACTS_COLUMN_DEFAULT\)/);
  assert.match(read('src/components/recipe/NutritionFactsBox.svelte'), /nutrition_facts_box_ui\.daily_value_header/);
});

test('the setting syncs under NutriTrace\'s key, with its row, strings and search words', () => {
  const settings = read('src/stores/settings.js');
  const at = settings.indexOf('export const USER_PREFS');
  const prefs = settings.slice(at, settings.indexOf(']);', at));
  assert.match(prefs, /'nutritionFactsColumn'/);
  const page = read('src/components/settings/SettingsNutrition.svelte');
  assert.match(page, /<option value="dv">/);
  assert.match(page, /<option value="per100">/);
  const en = JSON.parse(read('src/i18n/en.json'));
  assert.equal(en.settings_nutrition_ct.facts_column, 'Right Column');
  assert.equal(en.settings_nutrition_ct.facts_column_dv, '% Daily Value');
  assert.equal(en.settings_nutrition_ct.facts_column_per100, 'Per 100 g');
  assert.equal(en.nutrition_facts.per_100, 'Per 100 {unit}');
  for (const v of Object.values({ ...en.settings_nutrition_ct, ...en.nutrition_facts })) {
    assert.ok(!v.includes(EM_DASH), 'no em dashes');
  }
  assert.match(read('src/routes/Settings.svelte'), /nutrition: +\[[^\]]*'daily value'[^\]]*'per 100 g'/);
});

test('the recipe and pantry labels are given their serving', () => {
  assert.match(read('src/routes/RecipeView.svelte'), /<NutritionFactsBox[^>]*portion=\{recipeMassExactG\}\s+unit="g"/);
  // The public page has no ingredient weights and its viewer can't add any.
  assert.match(read('src/routes/PublicRecipe.svelte'), /<NutritionFactsBox[^>]*per100Allowed=\{false\}/);
  assert.match(read('src/components/pantry/PantryItemSheet.svelte'), /<NutritionFactsBox[^>]*portion=\{item\.serving_size\} unit=\{item\.serving_unit\}/);
});

test('a recipe\'s weight per serving is not rounded for the column', async () => {
  const { computeRecipeMass } = await import('../src/lib/recipe-nutrition.js');
  const r = computeRecipeMass({ servings: 5, ingredients: [{ items: [{ name: 'Paprika', qty: '13', unit: 'g' }] }] }, {});
  assert.equal(r.perServingG, 3, 'the "~3g" serving text stays rounded');
  close(r.exactG, 2.6);
  close(per100(1, { amount: r.exactG, basis: 'g' }), 100 / 2.6);
});

test('the blank column says what a recipe needs, apart from a pantry item', () => {
  const en = JSON.parse(read('src/i18n/en.json'));
  assert.ok(en.nutrition_facts.per_100_unknown_recipe);
  assert.match(read('src/components/recipe/NutritionFactsBox.svelte'), /'nutrition_facts\.per_100_unknown_recipe'/);
});
