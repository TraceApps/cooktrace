/**
 * #95: a recipe with no servings stays blank. The editor showed 2 for one,
 * and its next save stored that 2, whatever was changed. A new recipe
 * still starts from Settings > Cooking > Default Servings. The Android
 * app's own create and import stay blank too (android-sync.test.js runs
 * them).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editor = readFileSync(new URL('../src/routes/RecipeEditor.svelte', import.meta.url), 'utf8');

test('the editor opens a recipe with no servings with the field blank', () => {
  assert.match(editor, /if \(take\('servings'\)\) servings = r\.servings \?\? '';/);
  assert.doesNotMatch(editor, /servings = r\.servings \|\| \d/);
});

test('a blank field saves as no servings', () => {
  assert.match(editor, /servings: parseInt\(servings, 10\) \|\| null,/);
});

test('a new recipe still starts from Default Servings', () => {
  assert.match(editor, /let servings = \$defaultServings \|\| 2;/);
});
