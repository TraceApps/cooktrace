/**
 * Search folding, client and server.
 *
 * Every search box compares folded text, so an item named Orégano, Café or
 * Jalapeño is found by someone who did not type the accent. The helpers live
 * in two places because the runtime image ships server/ and dist/ only, so
 * the first test here pins the two copies to the same output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { foldText, includesFolded, coversFolded } from '../src/lib/search-text.js';
import { foldText as serverFoldText } from '../server/lib/search-text.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// The engine the server runs, better-sqlite3, built for the Node in CI and
// the image; Node's own SQLite where that binary doesn't match the local Node
// (node:sqlite is missing from Node 20).
async function openDb() {
  try {
    const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
    return new Database(':memory:');
  } catch {}
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(':memory:');
  } catch {}
  return null;
}

const SAMPLES = [
  'Orégano', 'Café', 'Limón', 'Jalapeño', 'Plátano', 'Jamón', 'Maíz',
  'Itambé', 'La Serenísima', 'Crème fraîche', 'Gruyère', 'Straße',
  'Ølsuppe', 'Łosoś', 'Þorramatur', 'Æbleskiver', 'Whole milk', 'OAT', '',
  null, undefined, 42,
];

test('the client and server copies fold identically', () => {
  for (const s of SAMPLES) assert.equal(serverFoldText(s), foldText(s), `differs for ${String(s)}`);
});

test('folding drops accents and leaves plain text alone', () => {
  assert.equal(foldText('Orégano'), 'oregano');
  assert.equal(foldText('Crème fraîche'), 'creme fraiche');
  assert.equal(foldText('Whole Milk'), 'whole milk');
  // Letters with no combining mark to strip, so NFD alone cannot fold them.
  assert.equal(foldText('Straße'), 'strasse');
  assert.equal(foldText('Ølsuppe'), 'olsuppe');
  assert.equal(foldText('Łosoś'), 'losos');
  assert.equal(foldText('Æbleskiver'), 'aebleskiver');
});

test('folding is idempotent and never throws on junk', () => {
  for (const s of SAMPLES) assert.equal(foldText(foldText(s)), foldText(s));
  assert.equal(foldText(null), '');
  assert.equal(foldText(undefined), '');
});

test('includesFolded matches either side accented, and an empty query matches', () => {
  assert.ok(includesFolded('Orégano seco', 'oregano'));
  assert.ok(includesFolded('Oregano seco', 'orégano'));
  assert.ok(includesFolded('Café con leche', 'CAFE'));
  assert.ok(includesFolded('anything', ''));
  assert.ok(!includesFolded('Orégano', 'basil'));
});

test('coversFolded takes the tokens in any order', () => {
  assert.ok(coversFolded('Whole milk Itambé', 'itambe milk'));
  assert.ok(!coversFolded('Whole milk', 'milk oat'));
});

test('the SQL fold() function makes LIKE accent-insensitive', async (t) => {
  const db = await openDb();
  if (!db) return t.skip('no SQLite engine loads under this Node');
  db.function('fold', { deterministic: true }, (s) => serverFoldText(s));
  db.exec('CREATE TABLE pantry_items (name TEXT, brand TEXT)');
  const ins = db.prepare('INSERT INTO pantry_items VALUES (?, ?)');
  ins.run('Orégano seco', null);
  ins.run('Leite', 'Itambé');
  ins.run('Whole milk', null);
  const find = (q) => db.prepare(
    `SELECT name FROM pantry_items WHERE fold(name) LIKE ? OR fold(brand) LIKE ?`
  ).all(`%${serverFoldText(q)}%`, `%${serverFoldText(q)}%`).map(r => r.name);
  assert.deepEqual(find('oregano'), ['Orégano seco']);
  assert.deepEqual(find('orégano'), ['Orégano seco']);
  assert.deepEqual(find('itambe'), ['Leite']);
  assert.deepEqual(find('milk'), ['Whole milk']);
  // A NULL column folds to '', so it does not match a real query.
  assert.deepEqual(find('zzz'), []);
});

test('the server search queries all go through fold()', () => {
  const sites = [
    ['../server/routes/pantry.js', /AND fold\(name\) LIKE \?/],
    ['../server/routes/api/v1/recipes.js', /fold\(name\) LIKE \? OR fold\(COALESCE\(description/],
    ['../server/lib/mcp/tools/search-recipes.js', /fold\(name\) LIKE \? ESCAPE/],
    ['../server/lib/mcp/tools/list-pantry.js', /fold\(name\) LIKE \? ESCAPE/],
  ];
  for (const [p, re] of sites) assert.match(read(p), re, p);
  // Registered once, next to the other connection setup.
  assert.match(read('../server/db.js'), /db\.function\('fold'/);
  // The needle has to be folded too, or fold(column) never matches.
  assert.doesNotMatch(read('../server/routes/pantry.js'), /String\(req\.query\.q\)\.trim\(\)\.toLowerCase\(\)/);
});

test('no search box compares raw lowercase text any more', () => {
  const swept = [
    '../src/routes/Recipes.svelte',
    '../src/routes/CookbookView.svelte',
    '../src/routes/CookDiary.svelte',
    '../src/routes/RecipeEditor.svelte',
    '../src/routes/Shopping.svelte',
    '../src/routes/Settings.svelte',
    '../src/components/ui/UnitPicker.svelte',
    '../src/components/ui/Combobox.svelte',
    '../src/components/ai/Trace.svelte',
    '../src/components/pantry/PantryItemSheet.svelte',
    '../src/components/manage/ManageTaxonomyList.svelte',
    '../src/components/manage/ManageRecipeCategories.svelte',
    '../src/components/manage/ManageCookbooks.svelte',
    '../src/components/manage/ManagePantryCategories.svelte',
    '../src/lib/pantry-variants.js',
  ];
  for (const p of swept) {
    const src = read(p);
    assert.doesNotMatch(src, /\.toLowerCase\(\)\.includes\(/, `${p} still compares unfolded text`);
    assert.match(src, /foldText\(/, `${p} should import the shared fold`);
  }
});
