/**
 * The shopping list's add row (item picker, quantity, Add) is a grid. Its
 * first track was a bare `1fr`, which cannot shrink below the picker's own
 * width, so on a phone Add ran 49 to 79px past the right edge. `minmax(0,
 * 1fr)` lets the picker give up the room instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/routes/Shopping.svelte', import.meta.url), 'utf8');

test('every quick-add grid lets the item picker shrink', () => {
  const rules = [...src.matchAll(/\.quick-add\s*\{[^}]*grid-template-columns:\s*([^;]+);/g)].map(m => m[1].trim());
  assert.ok(rules.length >= 2, 'expected the base rule and the narrow-screen rule');
  for (const cols of rules) {
    assert.match(cols, /^minmax\(0,\s*1fr\)/, `quick-add columns "${cols}" start with a track that cannot shrink`);
  }
});
