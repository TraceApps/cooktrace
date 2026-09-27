/**
 * Pantry search compared raw lowercase text, so "oregano" did not find
 * "Orégano" and "cafe" did not find "Café". Pantry names in Spanish,
 * Portuguese, French or German carry accents that are rarely typed on a
 * phone keyboard. The search now folds diacritics on both sides; English
 * names have none, so they match exactly as before.
 *
 * Also pinned: the All-mode pantry results called matchesSearch with the
 * query and the variants map swapped, so the query was read as the string
 * "[object Map]" and no pantry item ever matched in All mode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesSearch, classifySearchHit, buildVariantsByParent } from '../src/lib/pantry-variants.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const items = [
  { id: 1, name: 'Orégano seco' },
  { id: 2, name: 'Café' },
  { id: 3, name: 'Limón' },
  { id: 4, name: 'Jalapeño' },
  { id: 5, name: 'Leite', brand: 'Itambé' },
  { id: 6, name: 'Whole milk' },
  { id: 7, name: 'Queso', generic_parent_id: null },
  { id: 8, name: 'Queso', brand: 'La Serenísima', generic_parent_id: 7 },
];
const byParent = buildVariantsByParent(items);
const find = (q) => items.filter(i => i.generic_parent_id == null && matchesSearch(i, byParent, q)).map(i => i.id);

test('a query without accents finds an accented name', () => {
  assert.deepEqual(find('oregano'), [1]);
  assert.deepEqual(find('orega'), [1]);
  assert.deepEqual(find('cafe'), [2]);
  assert.deepEqual(find('limon'), [3]);
  assert.deepEqual(find('jalapeno'), [4]);
});

test('a query with accents still finds the name, with or without them', () => {
  assert.deepEqual(find('orégano'), [1]);
  assert.deepEqual(find('Oregano Seco'), [1]);
});

test('brands fold too, including a variant brand', () => {
  assert.deepEqual(find('itambe'), [5]);
  assert.equal(classifySearchHit(items[6], byParent, 'serenisima'), 'variants');
});

test('English names match exactly as before', () => {
  assert.deepEqual(find('milk'), [6]);
  assert.deepEqual(find('whole milk'), [6]);
  assert.deepEqual(find('oat'), []);
});

test('All mode passes the variants map before the query', () => {
  const src = read('../src/routes/Pantry.svelte');
  // Real calls only (a comment above them mentions matchesSearch() too).
  const calls = src.match(/matchesSearch\(\w[^\n]*/g) || [];
  assert.ok(calls.length > 0, 'expected a matchesSearch call in Pantry.svelte');
  for (const c of calls) {
    // The map may be a hoisted reactive value or built inline; what matters
    // is that the query is the third argument and never the second.
    assert.match(c, /matchesSearch\(\s*\w+\s*,\s*(?!query\b)[\w.]+(?:\([^)]*\))?\s*,\s*query\s*\)/);
  }
});

test('All mode reuses the hoisted variants map instead of rebuilding it per item', () => {
  const src = read('../src/routes/Pantry.svelte');
  const allMode = src.match(/\$: _allModeItems =[\s\S]*?\n  \];/);
  assert.ok(allMode, 'expected the _allModeItems reactive block');
  assert.doesNotMatch(allMode[0], /buildVariantsByParent\(/);
  // Variants are surfaced by the main list's own classification, so the
  // merged list holds top-level rows only.
  assert.match(allMode[0], /topLevelItems\(items\)/);
});

test('a local row in All mode opens the item it already is, never a prefilled copy', () => {
  const src = read('../src/routes/Pantry.svelte');
  const fn = src.match(/function pickExternalResult\(r\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, 'expected pickExternalResult');
  assert.match(fn[0], /_source === 'local'[\s\S]*openItem\(r\);\s*return;/);
  // The create path must stay below the local short-circuit.
  assert.ok(fn[0].indexOf('openItem(r)') < fn[0].indexOf('sheetPrefill = r'));
});

test('an All-mode row labels its own source, local included', () => {
  const src = read('../src/routes/Pantry.svelte');
  const badge = src.match(/<span class="src-badge src-\{r\._source\}">\{[^}]*\}<\/span>/);
  assert.ok(badge, 'expected the source badge');
  // Before: anything that was not OFF or USDA was labelled NT, so a pantry
  // item of your own claimed to come from NutriTrace.
  assert.match(badge[0], /_source === 'nt'/);
  assert.match(src, /\.src-badge\.src-local\s*\{/);
});
