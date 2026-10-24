/**
 * TraceApps/nutritrace#281: the built-in nutrients are the ones on a
 * Nutrition Facts label, in box order (US label first, EU label for what the
 * US one lacks), the same in CookTrace and NutriTrace. Open Food Facts and
 * USDA fill the ones they carry.
 *
 * The USDA ids were checked against the live FoodData Central API
 * (2026-10-23); the OFF keys against real product records and the OFF
 * nutrients taxonomy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NUTRIMENTS, deriveSodiumSalt } from '../src/lib/nutriments.js';
import { cleanCodes } from '../src/lib/allergens.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ids = NUTRIMENTS.map(n => n.id);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const NEW = ['starch', 'b5', 'iodine', 'selenium', 'copper', 'manganese', 'choline'];

test('vitamins and minerals follow the order of 21 CFR 101.9', () => {
  assert.deepEqual(ids.slice(ids.indexOf('vitamin-d'), ids.indexOf('choline') + 1), [
    'vitamin-d', 'calcium', 'iron', 'potassium',
    'vitamin-a', 'vitamin-c', 'vitamin-e', 'vitamin-k',
    'b1', 'b2', 'b3', 'b6', 'b9', 'b12', 'b5',
    'phosphorus', 'iodine', 'magnesium', 'zinc', 'selenium', 'copper', 'manganese',
    'choline',
  ]);
});

test('starch is a Carbs sub-row right after the sugars, above the rule', () => {
  assert.equal(ids.indexOf('starch'), ids.indexOf('added-sugars') + 1);
  const starch = NUTRIMENTS.find(n => n.id === 'starch');
  assert.equal(starch.subOf, 'carbohydrates');
  assert.equal(starch.fdaBlock, 'macros');
});

test('the new nutrients carry the label unit and the FDA Daily Value', () => {
  const want = {
    starch: ['g', null], b5: ['mg', 5], iodine: ['mcg', 150], selenium: ['mcg', 55],
    copper: ['mg', 0.9], manganese: ['mg', 2.3], choline: ['mg', 550],
  };
  for (const [id, [unit, dv]] of Object.entries(want)) {
    const n = NUTRIMENTS.find(x => x.id === id);
    assert.ok(n, id);
    assert.equal(n.unit, unit, id);
    assert.equal(n.dv, dv, id);
    assert.equal(n.default, false, `${id} stays hidden until the user turns it on`);
    if (id !== 'starch') assert.equal(n.fdaBlock, 'micros', id);
  }
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

test('the English names are in en.json', () => {
  const en = JSON.parse(read('../src/i18n/en.json')).nutriments;
  for (const n of NUTRIMENTS) assert.ok(en[n.id], `nutriments.${n.id}`);
});

test('USDA ids map to the new nutrients and the B vitamins', () => {
  const src = read('../src/lib/usda.js');
  const a = src.indexOf('const _USDA_NUTRIENT_MAP = ');
  const map = new Function(`return ${src.slice(a, src.indexOf('\n};', a) + 3).replace(/^const \w+ = /, '').replace(/;$/, '')}`)();
  const pick = (...k) => Object.fromEntries(k.map(x => [x, map[x]]));
  assert.deepEqual(pick(1009, 1170, 1100, 1103, 1098, 1101, 1180),
    { 1009: 'starch', 1170: 'b5', 1100: 'iodine', 1103: 'selenium', 1098: 'copper', 1101: 'manganese', 1180: 'choline' });
  assert.deepEqual(pick(1165, 1166, 1167, 1175, 1177, 1178),
    { 1165: 'b1', 1166: 'b2', 1167: 'b3', 1175: 'b6', 1177: 'b9', 1178: 'b12' });
  for (const key of Object.values(map)) {
    assert.ok(ids.includes(key) || key === 'calories', `${key} is a built-in nutrient`);
  }
});

// off.js maps privately; lift the mapper out of it.
function mapOff(nutriments) {
  const src = read('../src/lib/off.js');
  const a = src.indexOf('function _num(');
  const b = src.indexOf('\n}\n', src.indexOf('function _mapOFFProduct(')) + 3;
  const make = new Function('deriveSodiumSalt', 'cleanCodes', `${src.slice(a, b)}\nreturn _mapOFFProduct;`);
  return make(deriveSodiumSalt, cleanCodes)({ code: '1', product_name: 'Test', nutriments });
}

test('Open Food Facts values arrive in our units', () => {
  // OFF stores every amount in grams per 100 g.
  const n = mapOff({
    'energy-kcal_100g': 100,
    starch_100g: 12.5,
    'pantothenic-acid_100g': 0.005,
    iodine_100g: 0.00015,
    selenium_100g: 0.000055,
    copper_100g: 0.0009,
    manganese_100g: 0.0023,
    choline_100g: 0.55,
    calcium_100g: 0.12,
    'vitamin-d_100g': 0.00002,
    'vitamin-b12_100g': 0.0000024,
  }).nutrition;
  near(n.starch, 12.5);
  near(n.b5, 5);
  near(n.iodine, 150);
  near(n.selenium, 55);
  near(n.copper, 0.9);
  near(n.manganese, 2.3);
  near(n.choline, 550);
  near(n.calcium, 120);
  near(n['vitamin-d'], 20);
  near(n.b12, 2.4);
});

test('an OFF product without them keeps them absent, not a saved 0', () => {
  const n = mapOff({ 'energy-kcal_100g': 100, proteins_100g: 3 }).nutrition;
  for (const id of [...NEW, 'calcium', 'iron', 'vitamin-c']) assert.ok(!(id in n), id);
  assert.equal(n.proteins, 3);
});

test('an OFF value marked approximate (~) is not imported', () => {
  const n = mapOff({ 'energy-kcal_100g': 100, copper_100g: 0.0009, copper_modifier: '~' }).nutrition;
  assert.ok(!('copper' in n));
});

test('the scan-label prompt asks for the new nutrients', () => {
  const src = read('../src/lib/scan-nutrition.js');
  for (const id of ['starch', 'b5', 'iodine', 'selenium', 'copper', 'manganese', 'choline']) {
    assert.match(src, new RegExp(`\\b${id} \\(`), id);
  }
});
