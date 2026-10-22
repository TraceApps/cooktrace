/**
 * TraceApps/nutritrace#290 (@wallinb), the same bug in CookTrace: pantry
 * items added from USDA were saved with every value multiplied by
 * 100 / servingSize.
 *
 * FoodData Central gives nutrients per 100 g (or 100 ml) for every data type,
 * Branded included; servingSize is only the label's serving. The fixtures are
 * real responses recorded from api.nal.usda.gov (see their _note), served by
 * a stubbed fetch, so these tests never touch the network.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as USDA from '../src/lib/usda.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const R = JSON.parse(read('./fixtures/usda-290-responses.json'));
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
const kcal = (r) => r.nutrition.calories;

test('the reporter\'s popcorn (13 g serving) is saved at 385 kcal per 100 g', async () => {
  serve(() => R.search_popcorn);
  const [r] = await USDA.searchByName('himalayan pink salt organic popcorn', 1, 'KEY');
  assert.equal(r.barcode, R.search_popcorn.foods[0].gtinUpc);
  assert.equal(kcal(r), 385);
  assert.equal(r.serving_size, 100);
  assert.equal(r.serving_unit, 'g');
  assert.equal(r.nutrition.sodium, 692);
  // The label says 50 kcal per 13 g serving: the same density.
  assert.ok(Math.abs(kcal(r) * 13 / 100 - R.food_2607245.labelNutrients.calories.value) < 0.5);
});

test('a serving over 100 g is not scaled down; ml stays ml', async () => {
  serve(() => R.search_over_100);
  const rows = await USDA.searchByName('yogurt', 1, 'KEY');
  const g = rows.find(r => r.name === 'NONFAT YOGURT, NONFAT YOGURT');
  const ml = rows.find(r => r.serving_unit === 'ml');
  assert.equal(kcal(g), 47);
  assert.equal(kcal(ml), 94);
  assert.equal(ml.serving_size, 100);
});

test('a 100 g serving maps the same as before', async () => {
  serve(() => R.search_exactly_100);
  const [r] = await USDA.searchByName('instant noodles', 1, 'KEY');
  assert.equal(kcal(r), 400);
});

test('barcode lookup is per 100 g too', async () => {
  serve(() => R.search_popcorn);
  const r = await USDA.lookupBarcode(R.search_popcorn.foods[0].gtinUpc, 'KEY');
  assert.equal(kcal(r), 385);
});

test('the detail response (amount) and SR Legacy: per 100 g, salt derived, net carbs kept', () => {
  assert.equal(kcal(USDA.mapUsdaFood(R.food_2607245)), 385);
  const apple = USDA.mapUsdaFood(R.food_171688);
  assert.equal(apple.dataType, 'SR Legacy');
  assert.equal(apple.serving_size, 100);
  assert.equal(apple.serving_unit, 'g');
  assert.equal(kcal(apple), 52);
  assert.equal(apple.nutrition.carbohydrates, 11.41);
  assert.equal(apple.nutrition.sodium, 1);
  assert.ok(apple.nutrition.salt > 0);
});

test('Refresh from USDA looks an fdcId_ item up by id, and a GTIN item by barcode', async () => {
  let urls = serve((u) => u.includes('/food/171688?') ? R.food_171688 : null);
  const apple = await USDA.lookupForRefresh('fdcId_171688', 'KEY');
  assert.equal(kcal(apple), 52);
  assert.match(urls[0], /^https:\/\/api\.nal\.usda\.gov\/fdc\/v1\/food\/171688\?api_key=KEY$/);
  serve(() => null);
  assert.equal(await USDA.lookupForRefresh('fdcId_1', 'KEY'), null);
  urls = serve(() => R.search_popcorn);
  const pop = await USDA.lookupForRefresh(R.search_popcorn.foods[0].gtinUpc, 'KEY');
  assert.equal(kcal(pop), 385);
  assert.match(urls[0], /\/foods\/search\?query=.*&dataType=Branded/);
  assert.equal(await USDA.lookupForRefresh('fdcId_171688', ''), null);
});

test('the pantry sheet offers Refresh from USDA through the same apply as Refresh from OFF', () => {
  const s = read('../src/components/pantry/PantryItemSheet.svelte');
  const off = s.slice(s.indexOf('async function downloadFromOFF'), s.indexOf('async function downloadFromUSDA'));
  const usda = s.slice(s.indexOf('async function downloadFromUSDA'), s.indexOf('function _applyRefresh'));
  assert.match(off, /_applyRefresh\(result\)/);
  assert.match(usda, /usdaLookupForRefresh\(draft\.barcode, \$usdaApiKey\)/);
  assert.match(usda, /_applyRefresh\(result\)/);
  assert.match(usda, /usda_needs_key/);
  assert.match(usda, /usda_offline/);
  assert.match(s, /on:click=\{downloadFromUSDA\}/);
  // A refresh redraws the nutrient inputs, which read the numbers only when drawn.
  assert.match(s.slice(s.indexOf('function _applyRefresh')), /nutritionRev\+\+/);
  assert.match(s, /\{#key nutritionRev\}\s*\{#each visibleInlineNutriments as n\}/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.equal(en.pantry_editor.actions.refresh_usda, 'Refresh from USDA');
  for (const k of ['not_found_usda', 'usda_needs_key', 'usda_offline']) assert.ok(en.pantry_sheet_extra.toast[k], k);
  assert.ok(en.fail.usda_lookup);
  assert.ok(en.pantry_item_sheet_ui.usda_pull_title);
});

test('usda.js has no serving factor left', () => {
  assert.doesNotMatch(read('../src/lib/usda.js'), /100 \/ servingSize\)/);
});
