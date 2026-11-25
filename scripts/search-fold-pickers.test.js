/**
 * Two lists that compared lowercase text only (from nutritrace#346): the
 * ingredient name suggestions in the recipe editor and the Manage > Units
 * filter. Both fold accents now, so a name typed without them still finds
 * the row, and English matches as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldText } from '../src/lib/search-text.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const field = read('../src/components/recipe/IngredientNameField.svelte');
const units = read('../src/components/manage/ManageUnits.svelte');

// The suggestion rule as the field runs it.
const _norm = (s) => String(s || '').toLowerCase().trim();
const suggest = (suggestions, value) => {
  const q = _norm(value);
  return q ? suggestions.filter(n => foldText(n).includes(foldText(q)) && _norm(n) !== q) : [];
};

test('the ingredient field runs the rule tested here', () => {
  assert.match(field, /suggestions\.filter\(n => foldText\(n\)\.includes\(foldText\(q\)\) && _norm\(n\) !== q\)/);
  assert.match(field, /function _norm\(s\) \{ return String\(s \|\| ''\)\.toLowerCase\(\)\.trim\(\); \}/);
});

test('ingredient suggestions ignore accents', () => {
  const pantry = ['Jalapeño', 'Crème fraîche', 'Limón', 'Lemon', 'Flour'];
  assert.deepEqual(suggest(pantry, 'jalapeno'), ['Jalapeño']);
  assert.deepEqual(suggest(pantry, 'creme'), ['Crème fraîche']);
  assert.deepEqual(suggest(pantry, 'limon'), ['Limón']);
  // A name typed exactly isn't offered back to itself.
  assert.deepEqual(suggest(pantry, 'jalapeño'), []);
  // English as before.
  assert.deepEqual(suggest(pantry, 'lem'), ['Lemon']);
  assert.deepEqual(suggest(pantry, 'flour'), []);
  assert.deepEqual(suggest(pantry, ''), []);
});

test('the Units filter folds both sides', () => {
  assert.match(units, /const abbr = foldText\(u\.abbr\);/);
  assert.match(units, /const full = foldText\(u\.full \|\| u\.full_name\);/);
  assert.match(units, /\$: needle = foldText\(filter\)\.trim\(\);/);
});
