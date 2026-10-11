/**
 * The pantry card's + / check button and the item sheet both answer "is this
 * in stock?" through isItemInStock. Before, the button derived it from
 * quantity with Number(quantity) === 0, and Number(null) === 0: an in-stock
 * item with a blank On Hand looked out of stock, so tapping the check to mark
 * it used up marked it in stock again, forever. The sheet had the same read
 * and showed that item as Out of Stock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isItemInStock, stockAfterToggle, stockAfterStep } from '../src/lib/pantry-variants.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// The card's check button and the sheet's switch both write stockAfterToggle.
const toggle = (it) => ({ ...it, ...stockAfterToggle(it) });

test('a blank On Hand is not zero', () => {
  assert.equal(isItemInStock({ in_stock: 1, quantity: null }), true);
  assert.equal(isItemInStock({ quantity: null }), true);
  assert.equal(isItemInStock({ quantity: '' }), true);
});

test('in_stock decides when present, quantity only as a fallback', () => {
  assert.equal(isItemInStock({ in_stock: 0, quantity: null }), false);
  assert.equal(isItemInStock({ in_stock: 0, quantity: 0 }), false);
  assert.equal(isItemInStock({ in_stock: 1, quantity: 3 }), true);
  assert.equal(isItemInStock({ quantity: 0 }), false);
  assert.equal(isItemInStock({ quantity: 2 }), true);
  assert.equal(isItemInStock(null), false);
});

test('out -> tap -> in with On Hand 1 -> tap -> out with On Hand 0', () => {
  let it = { id: 1, in_stock: 0, quantity: 0 };
  it = toggle(it);
  assert.deepEqual([it.in_stock, it.quantity], [1, 1]);
  it = toggle(it);
  assert.deepEqual([it.in_stock, it.quantity], [0, 0]);
});

test('an item left in stock with a blank On Hand can be marked out', () => {
  // The state the old button produced (in, quantity null) and could not leave.
  let it = toggle({ id: 2, in_stock: 1, quantity: null });
  assert.deepEqual([it.in_stock, it.quantity], [0, 0]);
});

test('marking in keeps a quantity that is already there', () => {
  const it = toggle({ id: 3, in_stock: 0, quantity: 4 });
  assert.deepEqual([it.in_stock, it.quantity], [1, 4]);
});

test('On Hand - and + (#60): blank is untracked, 0 is out of stock', () => {
  assert.deepEqual(stockAfterStep({ in_stock: 1, quantity: null }, 1), { quantity: 1, in_stock: 1 });
  assert.equal(stockAfterStep({ in_stock: 1, quantity: null }, -1), null, 'nothing to take from a blank');
  assert.equal(stockAfterStep({ in_stock: 1, quantity: '' }, -1), null);
  assert.equal(stockAfterStep({ in_stock: 0, quantity: 0 }, -1), null, 'not below zero');
  assert.deepEqual(stockAfterStep({ in_stock: 1, quantity: 1 }, -1), { quantity: 0, in_stock: 0 });
  assert.deepEqual(stockAfterStep({ in_stock: 0, quantity: 0 }, 1), { quantity: 1, in_stock: 1 });
  assert.deepEqual(stockAfterStep({ in_stock: 1, quantity: 2.5 }, -1), { quantity: 1.5, in_stock: 1 });
  assert.deepEqual(stockAfterStep({ in_stock: 1, quantity: 0.4 }, -1), { quantity: 0, in_stock: 0 });
  assert.deepEqual(stockAfterStep({ in_stock: 1, quantity: '3' }, 1), { quantity: 4, in_stock: 1 });
});

test('the button, the card check and the sheet all use the same rules', () => {
  const pantry = read('../src/routes/Pantry.svelte');
  const sheet = read('../src/components/pantry/PantryItemSheet.svelte');
  const fn = pantry.slice(pantry.indexOf('async function quickToggle'));
  assert.match(fn.slice(0, 1200), /const next = stockAfterToggle\(it\)/);
  assert.doesNotMatch(fn.slice(0, 1200), /Number\(it\.quantity\) === 0/);
  assert.match(sheet, /function toggleStock\(\) \{ _applyStock\(stockAfterToggle\(item\)\); \}/);
  assert.match(sheet, /_applyStock\(stockAfterStep\(item, delta\)/);
  assert.match(pantry, /inStockDisplay = isGen \? stockAgg\.stocked > 0 : isItemInStock\(it\)/);
  assert.match(sheet, /\$: isInStock = item \? isItemInStock\(item\) : true/);
});
