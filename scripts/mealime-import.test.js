/**
 * Mealime closes on 2026-10-21; its users export with a community tool
 * that writes one schema.org Recipe per file under recipes/ and the
 * pictures under images/, each recipe naming its picture as
 * "../images/<file>". The import lost three things: the picture (it looked
 * only beside the JSON file), the cook's notes (`comment`) and the original
 * link (`isBasedOn`), because the looser Mealie reader claimed the file
 * first. Both the server and the Android app's importer are checked.
 *
 * The recipe below has the exporter's shape (toSchemaOrg in its source,
 * github.com/ianknauer/mealime-recipe-exporter, checked 2026-10-10).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import * as server from '../server/lib/recipe-importers.js';
import * as phone from '../src/lib/recipe-importers-client.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const mealime = (name, slug, extra = {}) => ({
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name,
  image: [`../images/${slug}.png`],
  recipeYield: '2 servings',
  totalTime: 'PT30M',
  recipeIngredient: ['1 1/2 cups rice', '2 tbsp soy sauce', '1 lime'],
  recipeInstructions: [{ '@type': 'HowToStep', text: 'Cook the rice.' }, { '@type': 'HowToStep', text: 'Serve.' }],
  tool: [{ '@type': 'HowToTool', name: 'Wok' }],
  ...extra,
});

// The layout the exporter writes (export.js): one folder holding an
// offline cookbook, recipes.json, raw/ (Mealime's own data), markdown/,
// schema-org/ (what imports) and images/.
async function exportZip() {
  const z = new JSZip();
  const root = z.folder('mealime-recipes');
  root.file('index.html', '<!doctype html><title>Cookbook</title>');
  root.file('recipes.json', JSON.stringify({ schema_version: 1, count: 2, recipes: [{ id: 1, name: 'Fried Rice', slug: 'fried-rice' }] }));
  root.file('raw/mealime-favourites-api.json', JSON.stringify({ favourites: [{ recipe: { id: 1, name: 'Fried Rice', ingredients: [] } }] }));
  root.file('markdown/fried-rice.md', '# Fried Rice');
  root.file('schema-org/fried-rice.json', JSON.stringify(mealime('Fried Rice', 'fried-rice', {
    isBasedOn: 'https://example.com/fried-rice',
    comment: { '@type': 'Comment', text: 'Use day-old rice.\nExtra lime.' },
  })));
  root.file('schema-org/plain-bowl.json', JSON.stringify(mealime('Plain Bowl', 'plain-bowl')));
  root.file('images/fried-rice.png', PNG);
  root.file('images/plain-bowl.png', PNG);
  return z.generateAsync({ type: 'nodebuffer' });
}

for (const [side, lib] of [['server', server], ['Android app', phone]]) {
  test(`a Mealime export keeps pictures, notes and links (${side})`, async () => {
    const zip = await lib.loadRecipeZip(await exportZip());
    const out = await lib.scanLoadedZip(zip);
    assert.deepEqual(out.map(o => o.recipe.name).sort(), ['Fried Rice', 'Plain Bowl'], 'recipes.json and raw/ add nothing twice');
    const byName = Object.fromEntries(out.map(o => [o.recipe.name, o]));
    const fr = byName['Fried Rice'];
    assert.equal(fr.imageEntryName, 'mealime-recipes/images/fried-rice.png', 'the picture the recipe names, not a neighbor');
    assert.equal(byName['Plain Bowl'].imageEntryName, 'mealime-recipes/images/plain-bowl.png');
    assert.ok(!fr.recipe.imgUrl && !fr.recipe.img_url, 'a path in the export is never kept as an address');
    assert.equal(fr.recipe.notes, 'Use day-old rice.\nExtra lime.');
    assert.equal(fr.recipe.source_url, 'https://example.com/fried-rice');
    assert.equal(byName['Plain Bowl'].recipe.notes, null);
    assert.equal(fr.recipe.cook_minutes, 30, 'a lone total time comes through as the cook time');
    assert.equal(fr.recipe.servings, 2);
    assert.deepEqual(fr.recipe.tools, ['Wok']);
    assert.equal(fr.recipe.ingredients[0].items.length, 3);
    assert.equal(fr.recipe.ingredients[0].items[0].qty, '1 1/2');
    const img = await lib.readImageFromLoadedZip(zip, fr.imageEntryName);
    assert.equal(img.ext, 'png');
  });
}

test('a schema.org recipe pasted on its own keeps its notes and link, and drops a path that goes nowhere', () => {
  const r = server.importRecipeFromText(JSON.stringify(mealime('Fried Rice', 'fried-rice', {
    isBasedOn: { '@id': 'https://example.com/x', url: 'https://example.com/fried-rice' },
    comment: [{ text: 'One' }, { text: 'Two' }],
  })));
  assert.equal(r.notes, 'One\n\nTwo');
  assert.equal(r.source_url, 'https://example.com/fried-rice');
  assert.equal(r.imgUrl, null);
  const remote = server.importRecipeFromText(JSON.stringify(mealime('Soup', 'soup', { image: 'https://example.com/soup.jpg' })));
  assert.equal(remote.imgUrl, 'https://example.com/soup.jpg', 'an address stays');
});

test("a Mealie export (no schema.org type) still goes through Mealie's reader", () => {
  const r = server.importRecipeFromText(JSON.stringify({
    name: 'Mealie Soup', recipe_ingredient: [{ quantity: 2, unit: { name: 'cup' }, food: { name: 'stock' } }],
    recipe_instructions: [{ text: 'Heat.' }], org_url: 'https://example.com/m', notes: [{ text: 'Mealie note' }],
  }));
  assert.equal(r.source_url, 'https://example.com/m');
  assert.equal(r.notes, 'Mealie note');
  assert.equal(r.ingredients[0].items[0].name, 'stock');
});
