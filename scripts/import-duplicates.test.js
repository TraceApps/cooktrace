/**
 * Imports skip a recipe that already exists (same name or source link) by
 * default. The skip used to vanish: the bulk summary counted only imports
 * and errors (#72, 121 found, 119 imported, no word on the other 2), a
 * single paste or URL import of a duplicate opened /recipes/undefined, and
 * a Paprika archive counted its duplicates as imported. Every path now
 * reports what it skipped and which recipe it matched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const routes = read('server/routes/recipes.js');
const nativeApi = read('src/lib/api-native.js');
const api = read('src/lib/api.js');

test('server: every duplicate answer names the recipe it matched', () => {
  const answers = routes.match(/skipped: true, reason: 'duplicate'[^}]*\}/g) || [];
  assert.equal(answers.length, 2, '/scrape and /import single both answer a duplicate');
  for (const a of answers) assert.match(a, /existing_id/);
  assert.match(routes, /skippedDup\.push\(\{ idx: i, .*existing_id: targetRecipeId \}\)/, 'zip commit lists the match too');
});

test('server: a Paprika archive never counts a skipped duplicate as imported', () => {
  assert.doesNotMatch(routes, /const row = _saveImportedRecipe\(u, r,[^\n]*\n\s*created\.push\(row\);/);
  assert.match(routes, /if \(row\) created\.push\(row\);\s*else skipped\.push/);
});

test('local mode answers duplicates the same way as the server', () => {
  assert.match(nativeApi, /return \{ skipped: true, reason: 'duplicate', existing_id:/);
  assert.match(nativeApi, /skipped\.push\(\{ name: entry\.recipe\?\.name \|\| '\?', existing_id:/);
});

test('api.js passes a duplicate answer through instead of treating it as a recipe', () => {
  assert.equal((api.match(/res\?\.skipped \? res : this\._imgFromApi\(res\)/g) || []).length, 3);
});

test('both single-import screens open the existing recipe on a duplicate', () => {
  for (const f of ['src/routes/Recipes.svelte', 'src/components/recipe/ImportUrlDialog.svelte']) {
    const src = read(f);
    assert.match(src, /\.skipped\)/, `${f} checks for a skipped answer`);
    assert.match(src, /push\(`\/recipes\/\$\{(result|created)\.existing_id\}`\)/, `${f} opens the match`);
  }
});

test('the bulk summary lists skipped duplicates by name', () => {
  const src = read('src/components/settings/SettingsImport.svelte');
  assert.match(src, /skipped: \[\{name, existing_id\}\]/);
  assert.match(src, /\{#each summary\.skipped as d\}/);
  assert.match(src, /settings_import_ct\.summary_partial/);
});
