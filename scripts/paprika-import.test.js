/**
 * Paprika exports embed each photo inside the .paprikarecipe JSON:
 * `photo_data` (or `photos[0].data` on some versions) holds the base64
 * bytes, `photo` is only the embedded filename, and `photo_url` /
 * `image_url` point at the source site. The importer built its data URL
 * out of the *filename*, so the magic-byte check downstream rejected
 * every picture and Paprika imports arrived imageless.
 *
 * The same archive can also hold user-made copies of a recipe ("[copy]",
 * the same source URL) and different recipes from one page. Rows written
 * earlier in the same batch count as duplicates by name only, never by
 * source URL, so those all import, and a recipe that's in the archive
 * twice under one name still imports once.
 *
 * Fixtures are trimmed from a real Paprika 3 export (2026-10).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import { loadRecipeZip, scanLoadedZip, importPaprikaArchive } from '../server/lib/recipe-importers.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// JPEG header bytes only — enough to be a plausible photo. The importer
// treats photo_data as opaque base64; the magic-byte validation happens
// later, when the data URL is localized at save time.
const PHOTO_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]).toString('base64');

const paprikaRecipe = (over = {}) => ({
  name: 'Lentil Soup',
  ingredients: '1 cup lentils\n2 cups water',
  directions: 'Boil.\n\nSimmer.',
  photo: 'lentil-soup.jpg',   // a filename, not bytes
  photo_data: PHOTO_B64,
  ...over,
});

async function paprikaArchive(entries) {
  const z = new JSZip();
  for (const [name, recipe] of entries) {
    z.file(name, gzipSync(Buffer.from(JSON.stringify(recipe))));
  }
  return z.generateAsync({ type: 'nodebuffer' });
}

test('photo_data becomes the image, not the photo filename', async () => {
  const out = await scanLoadedZip(await loadRecipeZip(await paprikaArchive([['a.paprikarecipe', paprikaRecipe()]])));
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'paprika');
  assert.equal(out[0].recipe.imgUrl, `data:image/jpeg;base64,${PHOTO_B64}`);
});

test('the photos[] array is used when photo_data is absent', async () => {
  const withPhotos = paprikaRecipe({ photo_data: null, photos: [{ filename: 'x.jpg', hash: '', data: PHOTO_B64 }] });
  const out = await scanLoadedZip(await loadRecipeZip(await paprikaArchive([['a.paprikarecipe', withPhotos]])));
  assert.equal(out[0].recipe.imgUrl, `data:image/jpeg;base64,${PHOTO_B64}`);
});

test('a recipe without embedded bytes falls back to the source-site URL', async () => {
  const remote = paprikaRecipe({ photo_data: null, photos: [], image_url: 'https://example.com/soup.jpg' });
  const out = await scanLoadedZip(await loadRecipeZip(await paprikaArchive([['a.paprikarecipe', remote]])));
  assert.equal(out[0].recipe.imgUrl, 'https://example.com/soup.jpg');
});

test('a recipe with no picture imports with a null image', async () => {
  const bare = paprikaRecipe({ photo_data: null, photos: [], image_url: null });
  const out = await scanLoadedZip(await loadRecipeZip(await paprikaArchive([['a.paprikarecipe', bare]])));
  assert.equal(out[0].recipe.imgUrl, null);
});

test('importPaprikaArchive (the /import path) reads the same fields', async () => {
  const recipes = await importPaprikaArchive(await paprikaArchive([
    ['a.paprikarecipe', paprikaRecipe()],
    ['b.paprikarecipe', paprikaRecipe({ name: 'Other Soup' })],
  ]));
  assert.equal(recipes.length, 2);
  assert.ok(recipes.every(r => r.imgUrl === `data:image/jpeg;base64,${PHOTO_B64}`));
});

test('a Paprika rating survives import (0 means unrated)', async () => {
  const out = await scanLoadedZip(await loadRecipeZip(await paprikaArchive([
    ['a.paprikarecipe', paprikaRecipe({ rating: 4 })],
    ['b.paprikarecipe', paprikaRecipe({ name: 'Unrated', rating: 0 })],
  ])));
  const byName = Object.fromEntries(out.map(o => [o.recipe.name, o.recipe]));
  assert.equal(byName['Lentil Soup'].rating, 4);
  assert.equal(byName['Unrated'].rating, null);
});

test("Paprika's nutritional_info rides along in notes instead of being dropped", async () => {
  const out = await scanLoadedZip(await loadRecipeZip(await paprikaArchive([
    ['a.paprikarecipe', paprikaRecipe({ notes: 'Family favourite.', nutritional_info: '340 kcal per serving' })],
    ['b.paprikarecipe', paprikaRecipe({ name: 'Bare', notes: null, nutritional_info: null })],
  ])));
  const byName = Object.fromEntries(out.map(o => [o.recipe.name, o.recipe]));
  assert.equal(byName['Lentil Soup'].notes, 'Family favourite.\n\nNutrition (from Paprika):\n340 kcal per serving');
  assert.equal(byName['Bare'].notes, null);
});

test('the client-side importer copy builds the same data URL', () => {
  const client = read('src/lib/recipe-importers-client.js');
  assert.match(client, /function _paprikaImgUrl\(r\)/);
  assert.doesNotMatch(client, /data:image\/jpeg;base64,\$\{r\.photo\}/, 'the filename is never used as image bytes');
});

test('server: batch imports dedup against the library, not against the batch', () => {
  const routes = read('server/routes/recipes.js');
  assert.match(routes, /function _findImportDuplicate\(u, parsed, excludeIds\)/);
  // Same batch: a duplicate by name only, never by source link (#97).
  assert.match(routes, /\.find\(r => !excludeIds\?\.has\(r\.id\)\)/);
  assert.match(routes, /_saveImportedRecipe\(u, recipe, \{ addToPantry, applyTags, importCategories, dedup, creatorUsername, excludeIds: createdIds \}\)/);
  assert.match(routes, /_saveImportedRecipe\(u, r, \{ addToPantry, applyTags, importCategories, creatorUsername, excludeIds: createdIds \}\)/);
  assert.equal((routes.match(/createdIds\.add\(row\.id\)/g) || []).length, 2, 'both server batch paths record what they wrote');
});

test('local mode: batch imports dedup against the library, not against the batch', () => {
  const native = read('src/lib/api-native.js');
  assert.match(native, /function _findImportDuplicateLocal\(r, excludeIds\)/);
  assert.match(native, /\.find\(x => !excludeIds\?\.has\(x\.id\)\)/);
  assert.match(native, /_saveImportedRecipeLocal\(this, r, \{ addToPantry, applyTags, excludeIds: createdIds \}\)/);
  assert.match(native, /_saveImportedRecipeLocal\(this, entry\.recipe, \{ addToPantry, applyTags, dedup, excludeIds: createdIds \}\)/);
  assert.equal((native.match(/createdIds\.add\(saved\.id\)/g) || []).length, 2, 'both local batch paths record what they wrote');
});

test('local mode: an embedded data: photo becomes a file before it reaches the table', () => {
  const native = read('src/lib/api-native.js');
  assert.match(native, /async function _localizeImportedImage\(api, url\)/);
  assert.match(native, /api\.uploadImage\(new File\(\[bytes\]/);
  assert.match(native, /await _importedPayloadWithImage\(api, r\)/);
});
