/**
 * quantity.js reads and adds recipe amounts the same way on the server and
 * in the app. The shopping list used Number(qty), so "1/2" (and "1 1/2",
 * "½") became no amount at all, and "from this recipe" stored the raw text
 * in a number column.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseQty, parseQtyRange, qtyToBuy, formatQty, scaleQty, displayQty, displayQtyParts,
  normalizeUnit, unitFamily, convertWithinFamily, convertQty, amountKey, sumAmounts,
  roundForList, ingredientKey,
} from '../src/lib/quantity.js';

const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('the server and the app use the same quantity.js', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  assert.equal(read('server/lib/quantity.js'), read('src/lib/quantity.js'));
});

test('fractions, mixed numbers, vulgar fractions and decimal commas read as numbers', () => {
  assert.equal(parseQty('1/2'), 0.5);
  assert.equal(parseQty('1 1/2'), 1.5);
  assert.equal(parseQty('1 and 1/2'), 1.5);
  assert.equal(parseQty('½'), 0.5);
  assert.equal(parseQty('1½'), 1.5);
  assert.equal(parseQty('1 ½'), 1.5);
  assert.equal(parseQty('0,5'), 0.5);
  assert.equal(parseQty('2'), 2);
  assert.equal(parseQty('.5'), 0.5);
  assert.equal(parseQty(3), 3);
});

test('text, ranges and nonsense are not a single number', () => {
  for (const s of ['to taste', '', null, undefined, '4-5', '1/0', 'a pinch', '1,000', '2 cups']) {
    assert.equal(parseQty(s), null, String(s));
  }
});

test('ranges read both ends, and buying takes the upper one', () => {
  assert.deepEqual(parseQtyRange('4-5'), { lo: 4, hi: 5 });
  assert.deepEqual(parseQtyRange('4 - 5'), { lo: 4, hi: 5 });
  assert.deepEqual(parseQtyRange('4–5'), { lo: 4, hi: 5 });
  assert.deepEqual(parseQtyRange('1/2 to 1'), { lo: 0.5, hi: 1 });
  assert.deepEqual(parseQtyRange('2 or 3'), { lo: 2, hi: 3 });
  assert.deepEqual(parseQtyRange('3'), { lo: 3, hi: 3 });
  assert.equal(parseQtyRange('5-4'), null);
  assert.equal(qtyToBuy('4-5'), 5);
  assert.equal(qtyToBuy('1/2'), 0.5);
  assert.equal(qtyToBuy('to taste'), null);
});

test('writing and scaling keep what readers expect', () => {
  assert.equal(formatQty(0.5), '1/2');
  assert.equal(formatQty(1.333), '1 1/3');
  assert.equal(formatQty(2), '2');
  assert.equal(scaleQty('1/2', 2), '1');
  assert.equal(scaleQty('4-5', 2), '8-10');
  assert.equal(scaleQty('to taste', 2), 'to taste');
  assert.equal(displayQty('0.25', 'cup'), '1/4');
  assert.equal(displayQty('0.25', 'cups'), '1/4', 'a plural unit still reads as a fraction unit');
  assert.equal(displayQty('1.5', 'g'), '1.5');
  assert.equal(displayQty('½', 'tsp', 3), '1 1/2');
  assert.deepEqual(displayQtyParts('1.5', 'cup'), { whole: '1', fraction: '1/2' });
});

test('units normalize and convert within a family', () => {
  assert.equal(normalizeUnit('Tablespoons'), 'tbsp');
  assert.equal(normalizeUnit('cups'), 'cup');
  assert.equal(normalizeUnit('Grams'), 'g');
  assert.equal(normalizeUnit('handful'), 'handful');
  assert.equal(unitFamily('ml'), 'volume');
  assert.equal(unitFamily('lbs'), 'weight');
  assert.equal(unitFamily('cloves'), 'count');
  assert.equal(unitFamily(''), null);
  close(convertWithinFamily(1, 'cup', 'ml'), 236.59);
  close(convertWithinFamily(1, 'lb', 'g'), 453.59);
  assert.equal(convertWithinFamily(1, 'clove', 'clove'), 1);
  assert.equal(convertWithinFamily(1, 'clove', 'pc'), null);
  assert.equal(convertWithinFamily(1, 'cup', 'g'), null);
  close(convertQty(1, 'cup', 'g', 120), 120);
  close(convertQty(60, 'g', 'cup', 120), 0.5);
});

test('amounts of one ingredient add up across units of a family', () => {
  assert.equal(amountKey('cup'), amountKey('ml'));
  assert.notEqual(amountKey('cup'), amountKey('g'));
  assert.equal(amountKey('cloves'), 'count:clove');
  assert.equal(amountKey(''), 'each');

  const v = sumAmounts([{ qty: 1, unit: 'cup' }, { qty: 120, unit: 'ml' }]);
  assert.equal(v.unit, 'cup');
  close(v.qty, 1.507);
  // Under 1 kg reads better in grams.
  const w = sumAmounts([{ qty: 200, unit: 'g' }, { qty: 0.5, unit: 'kg' }]);
  assert.equal(w.unit, 'g');
  close(w.qty, 700);
  const big = sumAmounts([{ qty: 800, unit: 'g' }, { qty: 0.5, unit: 'kg' }]);
  assert.equal(big.unit, 'kg');
  close(big.qty, 1.3);
  const small = sumAmounts([{ qty: 1, unit: 'tsp' }, { qty: 1, unit: 'tbsp' }]);
  assert.equal(small.unit, 'tbsp');
  close(small.qty, 1.333);
  assert.deepEqual(sumAmounts([{ qty: 2, unit: null }, { qty: 3, unit: null }]), { qty: 5, unit: null });
  assert.deepEqual(sumAmounts([{ qty: null, unit: 'pinch' }]), { qty: null, unit: 'pinch' });
  // An amount without a number doesn't wipe out the ones that have one.
  assert.deepEqual(sumAmounts([{ qty: 2, unit: 'clove' }, { qty: null, unit: 'clove' }]), { qty: 2, unit: 'clove' });
  assert.equal(roundForList(1.507, 'cup'), 1.5);
  assert.equal(roundForList(0.7004, 'kg'), 0.7);
});

test('ingredient names match across plural and case', () => {
  assert.equal(ingredientKey('Tomatoes'), ingredientKey('tomato'));
  assert.equal(ingredientKey('cherry tomatoes'), 'cherry tomato');
  assert.equal(ingredientKey('Berries'), 'berry');
  assert.equal(ingredientKey('peaches'), 'peach');
  assert.equal(ingredientKey('Eggs'), 'egg');
  assert.equal(ingredientKey('jalapeño'), 'jalapeno');
  assert.equal(ingredientKey('couscous'), 'couscous');
  assert.equal(ingredientKey('glass noodles'), 'glass noodle');
  assert.notEqual(ingredientKey('onion'), ingredientKey('green onion'));
});
