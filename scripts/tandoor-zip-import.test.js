/**
 * Tandoor's export is a zip of zips (cookbook/integration/default.py):
 * export.zip holds one <id>.zip per recipe, each with recipe.json and, when
 * the recipe has one, image.<ext>. The bulk importer only looked at the
 * outer zip's .json files, so every Tandoor export failed with "No JSON
 * files found" (#72). Inner zips are now unpacked under <id>/, so each
 * recipe keeps its own picture. Archives without inner zips are untouched.
 *
 * The recipe.json below is trimmed from a real export made with Tandoor's
 * own exporter (2026-10, vabene1111/recipes:latest).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { loadRecipeZip, scanLoadedZip, readImageFromLoadedZip } from '../server/lib/recipe-importers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const tandoorRecipe = (name, foods) => ({
  name,
  description: '',
  keywords: [{ name: 'Dinner' }],
  steps: [{
    name: '', instruction: 'Cook it.',
    ingredients: foods.map((f, i) => ({ food: { name: f }, unit: { name: 'g' }, amount: 100, note: '', order: i, is_header: false, no_amount: false })),
  }],
  working_time: 10, waiting_time: 0, internal: true, servings: 2,
});

async function tandoorExport(recipes) {
  const outer = new JSZip();
  for (const [id, recipe, withImage] of recipes) {
    const inner = new JSZip();
    inner.file('recipe.json', JSON.stringify(recipe));
    if (withImage) inner.file('image.png', PNG);
    outer.file(`${id}.zip`, await inner.generateAsync({ type: 'nodebuffer' }));
  }
  return outer.generateAsync({ type: 'nodebuffer' });
}

test('a Tandoor export (zip of zips) imports every recipe with its own picture', async () => {
  const buf = await tandoorExport([
    [7, tandoorRecipe('Crème brûlée', ['crème', 'sucre']), true],
    [8, tandoorRecipe('Toast', ['bread']), false],
    [9, tandoorRecipe('Pancakes', ['flour', 'egg', 'milk']), true],
  ]);
  const zip = await loadRecipeZip(buf);
  const out = await scanLoadedZip(zip);
  assert.deepEqual(out.map(o => o.recipe.name).sort(), ['Crème brûlée', 'Pancakes', 'Toast']);
  assert.ok(out.every(o => o.source === 'tandoor'));
  const byName = Object.fromEntries(out.map(o => [o.recipe.name, o]));
  assert.equal(byName['Crème brûlée'].imageEntryName, '7/image.png');
  assert.equal(byName['Pancakes'].imageEntryName, '9/image.png');
  assert.equal(byName['Toast'].imageEntryName, null, 'a recipe without a picture must not borrow another one');
  const img = await readImageFromLoadedZip(zip, byName['Pancakes'].imageEntryName);
  assert.equal(img.ext, 'png');
  assert.equal(byName['Pancakes'].recipe.ingredients.flatMap(g => g.items).length, 3);
});

test('a zip without inner zips scans exactly as before', async () => {
  const z = new JSZip();
  z.file('data/recipes/pasta/recipe.json', JSON.stringify({ name: 'Pasta', recipe_ingredient: [{ note: '200 g pasta' }], recipe_instructions: [{ text: 'Boil.' }] }));
  z.file('data/recipes/pasta/images/original.webp', PNG);
  const zip = await loadRecipeZip(await z.generateAsync({ type: 'nodebuffer' }));
  const names = Object.keys(zip.files).sort();
  const out = await scanLoadedZip(zip);
  assert.deepEqual(Object.keys(zip.files).sort(), names);
  assert.equal(out.length, 1);
  assert.equal(out[0].imageEntryName, 'data/recipes/pasta/images/original.webp');
});

test('a file named .zip that is not a zip is skipped, not fatal', async () => {
  const z = new JSZip();
  z.file('notes.zip', 'not really a zip');
  z.file('r/recipe.json', JSON.stringify({ name: 'Salad', ingredients: [{ name: '', items: [{ qty: '1', unit: '', name: 'lettuce' }] }], steps: [{ text: 'Chop.' }] }));
  const out = await scanLoadedZip(await loadRecipeZip(await z.generateAsync({ type: 'nodebuffer' })));
  assert.deepEqual(out.map(o => o.recipe.name), ['Salad']);
});
