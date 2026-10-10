/**
 * Ingredient lines from recipe sites and exports ([#57]): a range became
 * an amount of 4 and a name of "- 5 roma tomatoes", size words stayed in
 * the name ("large eggs", "15-ounce can black beans"), and prep after a
 * comma did too ("garlic, minced"). The name is what the pantry links to,
 * so those made junk pantry items. One parser now serves the server and
 * the Android app.
 *
 * [#57]: https://github.com/TraceApps/cooktrace/discussions/57
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIngredientLine } from '../src/lib/ingredient-line.js';
import { parseIngredientLine as serverParse } from '../server/lib/recipe-scraper.js';
import { parseIngredientLine as phoneParse } from '../src/lib/recipe-scraper-client.js';

const split = l => { const r = parseIngredientLine(l); return [r.qty, r.unit, r.name, r.note]; };

test('the server and the app use the same ingredient-line.js', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  assert.equal(read('server/lib/ingredient-line.js'), read('src/lib/ingredient-line.js'));
  const l = '4 - 5 roma tomatoes, diced';
  assert.deepEqual(serverParse(l), parseIngredientLine(l));
  assert.deepEqual(phoneParse(l), parseIngredientLine(l));
});

test('ranges are one amount', () => {
  assert.deepEqual(split('4 - 5 roma tomatoes'), ['4-5', '', 'roma tomatoes', '']);
  assert.deepEqual(split('4-5 tomatoes'), ['4-5', '', 'tomatoes', '']);
  assert.deepEqual(split('1 to 2 tsp chili flakes'), ['1-2', 'tsp', 'chili flakes', '']);
});

test('sizes and package sizes go to the note', () => {
  assert.deepEqual(split('2 large eggs'), ['2', '', 'eggs', 'large']);
  assert.deepEqual(split('1 (15-ounce) can black beans'), ['1', 'can', 'black beans', '15-ounce']);
  assert.deepEqual(split('1 15-ounce can black beans, drained'), ['1', 'can', 'black beans', '15-ounce; drained']);
  assert.deepEqual(split('1 14.5 oz can diced tomatoes'), ['1', 'can', 'diced tomatoes', '14.5 oz']);
  assert.deepEqual(split('Large can of tomatoes'), ['', 'can', 'tomatoes', 'Large']);
  assert.deepEqual(split('3 medium potatoes, peeled and cubed'), ['3', '', 'potatoes', 'medium; peeled and cubed']);
  assert.deepEqual(split('1 cup packed brown sugar'), ['1', 'cup', 'brown sugar', 'packed']);
});

test('prep after a comma goes to the note; a comma inside the name stays', () => {
  assert.deepEqual(split('2 cloves garlic, minced'), ['2', 'clove', 'garlic', 'minced']);
  assert.deepEqual(split('1 onion, finely chopped'), ['1', '', 'onion', 'finely chopped']);
  assert.deepEqual(split('1 lb boneless, skinless chicken thighs'), ['1', 'lb', 'boneless, skinless chicken thighs', '']);
  assert.deepEqual(split('Salt and pepper, to taste'), ['', '', 'Salt and pepper', 'to taste']);
  assert.deepEqual(split('salt to taste'), ['', '', 'salt', 'to taste']);
});

test('what worked before still does', () => {
  assert.deepEqual(split('1 1/2 cups flour, sifted'), ['1 1/2', 'cup', 'flour', 'sifted']);
  assert.deepEqual(split('½ cup butter (melted)'), ['1/2', 'cup', 'butter', 'melted']);
  assert.deepEqual(split('320g flour'), ['320', 'g', 'flour', '']);
  assert.deepEqual(split('1 and 1/2 cups sugar'), ['1 1/2', 'cup', 'sugar', '']);
  assert.deepEqual(split('1 tbsp. olive oil'), ['1', 'tbsp', 'olive oil', '']);
  assert.deepEqual(split('2 tablespoons of honey'), ['2', 'tbsp', 'honey', '']);
  assert.deepEqual(split('2 fl oz cream'), ['2', 'fl oz', 'cream', '']);
  assert.deepEqual(split('10 oz. spinach'), ['10', 'oz', 'spinach', '']);
  assert.deepEqual(split('Juice of 1 lime'), ['', '', 'Juice of 1 lime', '']);
  assert.deepEqual(parseIngredientLine(''), { qty: '', unit: '', name: '', note: '' });
  assert.deepEqual(parseIngredientLine(null), { qty: '', unit: '', name: '', note: '' });
});
