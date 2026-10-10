/**
 * Amounts written in a step follow the servings: "2 cups of milk" doubled
 * reads "4 cups". Before, the ingredient list scaled and the steps kept
 * the recipe's own amounts. Only measures scale; times, temperatures,
 * pan sizes and plain counts stay as written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaledStepParts, scaleStepText, scaledAmountHtml, formatStepText } from '../src/lib/step-format.js';

const shown = (text, f) => scaledStepParts(text, f).map(p => (p.type === 'amount' ? `[${p.value}]` : p.value)).join('');

test('measures scale, written the way the unit reads', () => {
  assert.equal(shown('Whisk in 2 cups of milk and 1/2 tsp salt.', 2), 'Whisk in [4 cups] of milk and [1 tsp] salt.');
  assert.equal(shown('Add 250g flour.', 2), 'Add [500g] flour.');
  assert.equal(shown('Pour 1 ½ cups stock.', 2), 'Pour [3 cups] stock.');
  assert.equal(shown('Use 1-2 tbsp oil.', 2), 'Use [2-4 tbsp] oil.');
  assert.equal(shown('Add 2 to 3 lbs potatoes.', 2), 'Add [4-6 lbs] potatoes.');
  assert.equal(shown('Stir in 2 fl oz cream.', 2), 'Stir in [4 fl oz] cream.');
  assert.equal(shown('Add 3/4 cup sugar.', 0.5), 'Add [3/8 cup] sugar.');
  assert.equal(shown('Add 1 cup milk.', 2), 'Add [2 cups] milk.', 'a full unit word follows the number');
  assert.equal(shown('Add 2 cups milk.', 0.5), 'Add [1 cup] milk.');
  assert.equal(shown('Add 1 tbsp oil.', 3), 'Add [3 tbsp] oil.', 'abbreviations stay');
});

test('times, temperatures, sizes and counts stay as written', () => {
  const t = 'Bake at 350°F for 20-25 minutes in a 9x13 inch pan. Cut into 4 pieces, then rest 2 hours.';
  assert.equal(shown(t, 2), t);
  assert.equal(shown('Crack 2 eggs.', 2), 'Crack 2 eggs.', 'a count without a measure is left alone');
  assert.equal(shown('Add 2 c of water.', 2), 'Add 2 c of water.', 'one-letter spellings that are words too');
  assert.equal(shown('Fry 2 tbsp of batter per pancake, then add 1 cup milk.', 2), 'Fry 2 tbsp of batter per pancake, then add [2 cups] milk.',
    'an amount for each one stays');
  assert.equal(shown('Add the stock 1/2 cup at a time.', 2), 'Add the stock 1/2 cup at a time.');
  assert.equal(shown('Put 1 tbsp of filling on each tortilla.', 2), 'Put 1 tbsp of filling on each tortilla.');
});

test('at the recipe as written, nothing changes', () => {
  assert.deepEqual(scaledStepParts('Add 2 cups milk.', 1), [{ type: 'text', value: 'Add 2 cups milk.' }]);
  assert.equal(scaleStepText('Add 2 cups milk.', 1), 'Add 2 cups milk.');
});

test('scaled amounts are marked, and bold or italic around them still works', () => {
  const html = scaledAmountHtml(formatStepText(scaleStepText('Add **2 cups** flour and <b>salt</b>', 1.5)));
  assert.equal(html, 'Add <strong><span class="step-amount">3 cups</span></strong> flour and &lt;b&gt;salt&lt;/b&gt;');
  assert.equal(scaledAmountHtml('plain'), 'plain');
});
