/**
 * cooktrace#98: the Android app's file picker turns each extension in an
 * accept list into a MIME type and drops the ones Android doesn't know
 * (.paprikarecipes, .paprikarecipe), so a Paprika export was greyed out.
 * In the app the two import pickers now show every file and check the
 * pick themselves; the browser keeps its filter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickerAccept, fileMatchesAccept } from '../src/lib/file-accept.js';

const ARCHIVE = '.zip,.paprikarecipes,application/zip,application/x-zip-compressed';
const PASTE = '.json,.html,.htm,.paprikarecipes,.paprikarecipe,application/json,text/html';

test('the app shows every file, the browser keeps the list', () => {
  assert.equal(pickerAccept(ARCHIVE, true), '');
  assert.equal(pickerAccept(ARCHIVE, false), ARCHIVE);
});

test('Paprika, Mealie and Tandoor archives pass, case-insensitively', () => {
  for (const name of ['My Recipes.paprikarecipes', 'BACKUP.PAPRIKARECIPES', 'mealie.zip']) {
    assert.ok(fileMatchesAccept({ name, type: 'application/octet-stream' }, ARCHIVE), name);
  }
  assert.ok(fileMatchesAccept({ name: 'Soup.paprikarecipe', type: '' }, PASTE));
  assert.ok(fileMatchesAccept({ name: 'recipe.json', type: 'application/json' }, PASTE));
});

test('a file with no extension passes on its type', () => {
  assert.ok(fileMatchesAccept({ name: 'export', type: 'application/zip' }, ARCHIVE));
  assert.ok(!fileMatchesAccept({ name: 'export', type: 'application/octet-stream' }, ARCHIVE));
});

test('other files are refused', () => {
  assert.ok(!fileMatchesAccept({ name: 'photo.jpg', type: 'image/jpeg' }, ARCHIVE));
  assert.ok(!fileMatchesAccept({ name: 'notes.paprikarecipes.txt', type: 'text/plain' }, ARCHIVE));
  assert.ok(!fileMatchesAccept({ name: 'archive.zip', type: 'application/zip' }, PASTE));
  assert.ok(!fileMatchesAccept(null, ARCHIVE));
});

test('both import pickers use the helper, with no fixed accept list left', () => {
  const settings = readFileSync(new URL('../src/components/settings/SettingsImport.svelte', import.meta.url), 'utf8');
  const recipes = readFileSync(new URL('../src/routes/Recipes.svelte', import.meta.url), 'utf8');
  for (const [name, src] of [['SettingsImport', settings], ['Recipes', recipes]]) {
    assert.match(src, /accept=\{pickerAccept\(/, name);
    assert.doesNotMatch(src, /accept="[^"]*paprikarecipe/, name);
    assert.match(src, /isNative && !fileMatchesAccept\(/, name);
  }
});
