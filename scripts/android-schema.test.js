/**
 * The phone's database, built as the Android SQLite plugin runs a script:
 * split on ";\n" only, each piece's first statement run and the rest of
 * it silently dropped (scripts/android-sync/sqlite.mjs). Every table,
 * index and trigger the app's scripts make must be there, and clearing an
 * account's copy must leave none of its rows.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as nodeModule from 'node:module';
import test from 'node:test';

const root = new URL('../', import.meta.url);
let skip = false;
try {
  const Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  new Database(':memory:').close();
  createRequire(new URL('../package.json', import.meta.url)).resolve('svelte/store');
  if (typeof nodeModule.register !== 'function') skip = 'needs module hooks';
} catch { skip = 'needs the server and app dependencies, built for this Node'; }

function onPhone(code) {
  const r = spawnSync(process.execPath, ['--import', './scripts/android-sync/register.mjs', '--input-type=module', '-e', `
    globalThis.window = globalThis; globalThis.addEventListener ??= () => {}; globalThis.dispatchEvent ??= () => true;
    const store = new Map();
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), key: i => [...store.keys()][i] ?? null, get length() { return store.size; } }, configurable: true });
    const dbn = await import('./src/lib/db-native.js');
    await dbn.dbInit();
    const db = await dbn.getDb();
    ${code}
  `], { cwd: root, encoding: 'utf8', env: { ...process.env, CT_SERVER: '' } });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  if (!line) throw new Error(`phone run failed:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(7));
}

test('the schema and its triggers are all there, run as the Android plugin runs a script', { skip }, () => {
  const src = readFileSync(new URL('../src/lib/db-native.js', import.meta.url), 'utf8');
  const schema = src.slice(src.indexOf('const SCHEMA = `'), src.indexOf('`;', src.indexOf('const SCHEMA = `')));
  const code = schema.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
  const want = [...code.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS (\w+)/g)].map(m => m[1]);
  assert.ok(want.length > 15, 'read the schema');
  const got = onPhone(`
    const names = (await db.query("SELECT name FROM sqlite_master", [])).values.map(r => r.name);
    console.log('RESULT ' + JSON.stringify(names));
  `);
  for (const n of want) assert.ok(got.includes(n), `${n} made`);
  for (const t of ['recipes', 'pantry_items', 'cook_diary', 'shopping_list', 'recipe_categories', 'pantry_categories', 'custom_units', 'cookbooks', 'recipe_comments', 'ai_chat_history']) {
    assert.ok(got.includes(`trg_${t}_edit_clock_upd`), `${t}: edit clock trigger (update)`);
    assert.ok(got.includes(`trg_${t}_edit_clock_ins`), `${t}: edit clock trigger (insert)`);
  }
});

test("clearing an account's copy leaves none of its rows, every table", { skip }, () => {
  const r = onPhone(`
    const { CtApiNative: api } = await import('./src/lib/api-native.js');
    const r1 = await api.createRecipe({ name: 'Soup', ingredients: [], steps: [] });
    await api.createPantryItem({ name: 'Rice' });
    await api.addShoppingItem({ name: 'Milk' });
    await api.createRecipeCategory({ name: 'Mains' });
    await api.createCookbook({ name: 'Weeknights' });
    await db.run("INSERT INTO sync_deletes (table_name, server_id) VALUES ('recipes', 9)", []);
    await db.run("INSERT INTO user_settings (key, value) VALUES ('x', '1')", []);
    await db.run("INSERT INTO sync_meta (key, value) VALUES ('last_pull_at', '2026-01-01')", []);
    const tables = ['recipes', 'pantry_items', 'shopping_list', 'recipe_categories', 'cookbooks', 'sync_deletes', 'user_settings'];
    const count = async () => Object.fromEntries(await Promise.all(tables.map(async t => [t, (await db.query('SELECT COUNT(*) AS n FROM ' + t, [])).values[0].n])));
    const before = await count();
    await dbn.dbClearUserData();
    console.log('RESULT ' + JSON.stringify({ before, after: await count(), cursor: (await db.query("SELECT value FROM sync_meta WHERE key = 'last_pull_at'", [])).values.length }));
  `);
  for (const [t, n] of Object.entries(r.before)) assert.ok(n > 0, `${t} had rows`);
  assert.deepEqual(Object.values(r.after), Object.values(r.after).map(() => 0), JSON.stringify(r.after));
  assert.equal(r.cursor, 0);
});

test('a script with two statements on a line runs only the first on the phone, as on Android', { skip }, () => {
  const r = onPhone(`
    await db.execute("CREATE TABLE a (x); CREATE TABLE b (x);\\nCREATE TABLE c (x);\\n");
    const names = (await db.query("SELECT name FROM sqlite_master WHERE name IN ('a','b','c')", [])).values.map(r => r.name).sort();
    console.log('RESULT ' + JSON.stringify(names));
  `);
  assert.deepEqual(r, ['a', 'c'], 'the stand-in drops what the plugin drops');
});
