/**
 * USDA Foundation foods added at 0 kcal (found with TraceApps/nutritrace#314).
 *
 * Since October 2020 FoodData Central's Foundation foods no longer show
 * nutrient 1008 ("Energy", kcal); most give only 2047 (Energy, Atwater
 * General Factors) and 2048 (Energy, Atwater Specific Factors), both kcal.
 * usda.js read 1008 and 1062 (kJ) only, so "Yogurt, Greek, plain, whole
 * milk" (fdcId 2259794), first among USDA results, came in at 0 kcal.
 *
 * Calories come from 1008, else 2048, else 2047, else 1062 kJ / 4.184,
 * as in NutriTrace's usda-map.js. The fixtures are real USDA data
 * (api.nal.usda.gov and its Foundation Foods download, see their _note),
 * served by a stubbed fetch, so these tests never touch the network.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as USDA from '../src/lib/usda.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const E = read('./fixtures/usda-energy-responses.json');
const R290 = read('./fixtures/usda-290-responses.json');
// nutritrace#314's recorded "greek yogurt plain" search (copied unchanged).
const GREEK = E.search_greek_yogurt;
const r4 = (x) => Math.round(x * 10000) / 10000;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Answers the app's /api/proxy?url=… with a recorded USDA response.
function serve(answer) {
  const urls = [];
  globalThis.fetch = async (u) => {
    const target = decodeURIComponent(String(u).split('url=')[1] || '');
    urls.push(target);
    const body = answer(target);
    return body == null
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => body };
  };
  return urls;
}
function energyOf(item) {
  const out = {};
  for (const fn of item.foodNutrients) {
    const id = fn.nutrientId ?? fn.nutrient?.id;
    if ([1008, 1062, 2047, 2048].includes(id)) out[id] = fn.value ?? fn.amount;
  }
  return out;
}
const without = (item, ...ids) => ({
  ...item,
  foodNutrients: item.foodNutrients.filter(fn => !ids.includes(fn.nutrientId ?? fn.nutrient?.id)),
});
const YOGURT = 'Yogurt, Greek, plain, whole milk';

test('the order is 1008, then 2048, then 2047, as in NutriTrace', () => {
  assert.deepEqual(USDA.USDA_ENERGY_IDS, [1008, 2048, 2047]);
});

test('search: the Foundation Greek yogurt (2047 and 2048 only) has its calories', async () => {
  serve(() => GREEK);
  const rows = await USDA.searchByName('greek yogurt', 1, 'KEY');
  const f = rows.find(r => r.barcode === 'fdcId_2259794');
  assert.ok(f, 'in the results');
  assert.equal(f.name, YOGURT);
  assert.equal(f.dataType, 'Foundation');
  const e = energyOf(GREEK.foods.find(x => x.fdcId === 2259794));
  assert.equal(e[1008], undefined);
  assert.equal(f.nutrition.calories, e[2048]);
  assert.equal(f.nutrition.kilojoules, Math.round(e[2048] * 4.184 * 10) / 10);
  // SR Legacy in the same reply keeps its 1008 and USDA's own kJ.
  const sr = rows.find(r => r.barcode === 'fdcId_171304');
  const se = energyOf(GREEK.foods.find(x => x.fdcId === 171304));
  assert.equal(sr.nutrition.calories, se[1008]);
  assert.equal(sr.nutrition.kilojoules, se[1062]);
});

test('detail and Refresh from USDA: the food by id has its calories', async () => {
  const e = energyOf(E.food_2259794);
  assert.equal(USDA.mapUsdaFood(E.food_2259794).nutrition.calories, r4(e[2048]));
  serve((u) => u.includes('/food/2259794?') ? E.food_2259794 : null);
  const r = await USDA.lookupForRefresh('fdcId_2259794', 'KEY');
  assert.equal(r.nutrition.calories, r4(e[2048]));
});

test('2047 only, 2048 only, kJ only, none', () => {
  for (const item of [without(GREEK.foods.find(x => x.fdcId === 2259794), 2048), E.download_2257044]) {
    const e = energyOf(item);
    assert.deepEqual(Object.keys(e).map(Number), [2047]);
    assert.equal(USDA.mapUsdaFood(item).nutrition.calories, r4(e[2047]));
  }
  assert.equal(USDA.mapUsdaFood(without(E.food_2259794, 2047)).nutrition.calories, r4(energyOf(E.food_2259794)[2048]));
  const kj = energyOf(R290.food_171688)[1062];
  assert.equal(USDA.mapUsdaFood(without(R290.food_171688, 1008)).nutrition.calories, Math.round(kj / 4.184 * 10) / 10);
  assert.equal(USDA.mapUsdaFood(without(E.food_2259794, 1008, 1062, 2047, 2048)).nutrition.calories, undefined);
});

test('#290\'s recorded foods are unchanged', () => {
  assert.equal(USDA.mapUsdaFood(R290.food_2607245).nutrition.calories, 385);
  assert.equal(USDA.mapUsdaFood(R290.food_171688).nutrition.calories, 52);
  assert.equal(USDA.mapUsdaFood(R290.food_171688).nutrition.kilojoules, 218);
});
