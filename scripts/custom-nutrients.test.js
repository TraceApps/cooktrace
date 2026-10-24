/**
 * Custom nutrients in CookTrace work the way they do in NutriTrace: a name and
 * a unit in Settings > Nutrition, then a field wherever nutrition is entered.
 * The value is stored under the nutrient's id like any built-in, so recipe
 * totals, sync and backups carry it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NUTRIMENTS, CUSTOM_NUTRIENT_UNITS, customNutrientId, asCustomNutriments, allNutriments,
} from '../src/lib/nutriments.js';
import { computeRecipeNutrition } from '../src/lib/recipe-nutrition.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('a custom nutrient gets the same id NutriTrace gives it', () => {
  assert.equal(customNutrientId('Omega-3'), 'custom_omega-3');
  assert.equal(customNutrientId('  Omega 3 Fatty  Acids '), 'custom_omega_3_fatty_acids');
  assert.equal(customNutrientId('Omega-3'), 'custom_' + 'Omega-3'.toLowerCase().replace(/\s+/g, '_'));
});

test('the units offered are the ones NutriTrace offers', () => {
  assert.deepEqual(CUSTOM_NUTRIENT_UNITS, ['g', 'mg', 'mcg', 'IU', 'kcal', 'kJ', '%']);
});

test('custom nutrients become catalog rows after the built-ins', () => {
  const saved = [{ id: 'custom_omega-3', label: 'Omega-3', unit: 'g' }, { id: 'custom_lutein', label: 'Lutein', unit: 'mcg' }];
  const all = allNutriments(saved);
  assert.equal(all.length, NUTRIMENTS.length + 2);
  assert.deepEqual(all.slice(0, NUTRIMENTS.length).map(n => n.id), NUTRIMENTS.map(n => n.id));
  const omega = all.at(-2);
  assert.equal(omega.id, 'custom_omega-3');
  assert.equal(omega.label, 'Omega-3');
  assert.equal(omega.unit, 'g');
  assert.equal(omega.custom, true);
  assert.equal(omega.dv, null, 'no %DV');
  assert.equal(omega.fdaBlock, 'micros', 'below the rule, with the vitamins and minerals');
  assert.ok(!omega.subOf);
});

test('a broken saved list is ignored, not thrown on', () => {
  assert.deepEqual(asCustomNutriments(null), []);
  assert.deepEqual(asCustomNutriments('x'), []);
  assert.deepEqual(asCustomNutriments([null, {}, { id: 'a' }, { id: 'b', label: '  ' }]), []);
  assert.equal(allNutriments(undefined).length, NUTRIMENTS.length);
});

test('recipe totals add a custom nutrient up like any other', () => {
  const pantry = new Map([
    [1, { id: 1, serving_size: 100, serving_unit: 'g', nutrition: { calories: 50, 'custom_omega-3': 2 } }],
    [2, { id: 2, serving_size: 100, serving_unit: 'g', nutrition: { calories: 20, 'custom_omega-3': 0.5 } }],
  ]);
  const groups = [{ items: [
    { name: 'Flax', qty: '200', unit: 'g', pantry_item_id: 1 },
    { name: 'Chia', qty: '100', unit: 'g', pantry_item_id: 2 },
  ] }];
  const { nutrition } = computeRecipeNutrition(groups, pantry);
  assert.equal(nutrition.calories, 120);
  assert.equal(nutrition['custom_omega-3'], 4.5);
});

test('the setting syncs with the account, like the visible-nutrients list', () => {
  const src = read('../src/stores/settings.js');
  assert.match(src, /'customNutriments',/, 'listed among the synced preferences');
  assert.match(src, /createSettingStore\('customNutriments',\s*\[\]\)/);
});

test('every place that enters or shows nutrition lists the custom ones', () => {
  for (const [file, needle] of [
    ['../src/components/recipe/NutritionFactsBox.svelte', 'allNutriments($customNutriments)'],
    ['../src/routes/PantryEditor.svelte', 'asCustomNutriments($customNutriments)'],
    ['../src/routes/RecipeEditor.svelte', 'asCustomNutriments($customNutriments)'],
    ['../src/components/pantry/PantryItemSheet.svelte', 'asCustomNutriments($customNutriments)'],
  ]) {
    assert.ok(read(file).includes(needle), file);
  }
});

test('the settings page has the add and remove flow with every string translatable', () => {
  const svelte = read('../src/components/settings/SettingsNutrition.svelte');
  const en = JSON.parse(read('../src/i18n/en.json')).settings_nutrition_ui;
  const keys = [...svelte.matchAll(/settings_nutrition_ui\.(custom_\w+)/g)].map(m => m[1]);
  assert.ok(keys.length >= 8, 'the section uses its strings');
  for (const k of new Set(keys)) assert.ok(en[k], `settings_nutrition_ui.${k} is in en.json`);
  assert.match(svelte, /customNutriments\.set\(/);
});
