/**
 * Android sync: ids, the pull cursor and deletes.
 *
 * Ids differ between a phone and the server. The phone sends the server's
 * id in every id column, listing a parent made in the same push in
 * _local_fks, and the server keeps a pushed id only when the row it names
 * belongs to the account. The pull picks rows by synced_at, the server's
 * time of the write, so an edit made offline still reaches other devices.
 * Rows deleted outright (categories, units, chat) and links taken out of
 * a cookbook sync both ways.
 *
 * The end-to-end check (the app's db-native.js and sync.js against a real
 * server) needs node:sqlite, which Node 20 lacks; these tests pin the
 * pieces, and run the server's real schema when better-sqlite3 loads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mapSmartFilterCategory, cleanSmartFilter } from '../src/lib/smart-cookbook.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const serverSync = read('../server/routes/sync.js');
const clientSync = read('../src/lib/sync.js');
const dbNative = read('../src/lib/db-native.js');
const apiNative = read('../src/lib/api-native.js');

// The server's TABLES[...].parents, read from the source.
function serverParents() {
  const out = {};
  const re = /^  (\w+): \{\n    cols:[\s\S]*?\n    parents: (\{[\s\S]*?\}),\n/gm;
  for (const m of serverSync.matchAll(re)) {
    const body = m[2].replace(/\/\/.*$/gm, '');
    const map = {};
    for (const p of body.matchAll(/(\w+): '(\w+)'/g)) map[p[1]] = p[2];
    if (Object.keys(map).length) out[m[1]] = map;
  }
  return out;
}

test('the phone translates the same id columns the server declares', () => {
  const block = dbNative.slice(dbNative.indexOf('export const SYNC_PARENTS = {'));
  const client = {};
  for (const m of block.slice(0, block.indexOf('\n};')).matchAll(/^  (\w+): \{([^}]*)\}/gm)) {
    client[m[1]] = Object.fromEntries([...m[2].matchAll(/(\w+): '(\w+)'/g)].map(x => [x[1], x[2]]));
  }
  assert.deepEqual(client, serverParents());
  assert.ok(client.pantry_items.category_id === 'pantry_categories', "a pantry item's category is a pantry category");
});

test('a pull maps each id through its own parent table', () => {
  const pull = dbNative.slice(dbNative.indexOf('export async function dbApplyPull'));
  assert.match(pull, /const parents = SYNC_PARENTS\[table\] \|\| \{\}/);
  assert.doesNotMatch(pull, /category_id: \['recipe_categories', 'pantry_categories'\]/);
});

test('a push sends server ids, and lists parents from the same push', () => {
  const push = clientSync.slice(clientSync.indexOf('async function _toServerIds'));
  assert.match(push, /if \(!map\.has\(row\[fk\]\)\) row\[fk\] = null/);
  assert.match(push, /else localFks\.push\(fk\)/);
  assert.match(push, /row\._local_fks = localFks/);
  assert.match(clientSync, /fk_ids: 'server'/);
  assert.match(clientSync, /\{ cookbook_id: 'cookbooks', recipe_id: 'recipes' \}/, 'cookbook links go up as server ids too');
});

test('the server keeps a pushed id only for a row the account may use', () => {
  const fn = serverSync.slice(serverSync.indexOf('function _translateParents('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(local\.has\(fk\)\) \{\s*if \(!mapped\) return null;/);
  assert.match(body, /if \(!serverIds && mapped\)/);
  assert.match(body, /if \(!ok\) out\[fk\] = null/);
  assert.match(serverSync, /function _recipeLinkable[\s\S]*?recipe_shares/);
  assert.match(serverSync, /_translateParents\(\{ \.\.\.r \}, linkSpec, idMaps, u, serverIds, \{ recipes: _recipeLinkable, cookbooks: _ownsRow \}\)/,
    'a cookbook link only goes into the account\'s own cookbook');
});

test('tables without deleted_at take a push', () => {
  assert.doesNotMatch(serverSync, /spec\.softDelete \? \(translated\.deleted_at \?\? null\) : null/,
    'an extra deleted_at value made every category, unit and chat push fail');
  assert.equal((serverSync.match(/\.\.\.\(spec\.softDelete \? \[translated\.deleted_at \?\? null\] : \[\]\)/g) || []).length, 2);
});

test('the pull picks rows by the server time of the write', () => {
  const pull = serverSync.slice(serverSync.indexOf("router.get('/pull'"));
  assert.match(pull, /synced_at >= \?\$\{orderBy\}/);
  assert.match(pull, /AND synced_at >= \?`/);
  assert.doesNotMatch(pull, /updated_at > \?/);
  assert.match(pull, /FROM sync_deletions/);
});

test('deletes and removed links go up from the phone', () => {
  for (const fn of ['deleteRecipeCategory', 'deletePantryCategory', 'deleteCustomUnit']) {
    const body = apiNative.slice(apiNative.indexOf(`async ${fn}(`)).split('\n  },')[0];
    assert.match(body, /_noteDelete\(/, `${fn} notes the delete`);
  }
  assert.match(apiNative.slice(apiNative.indexOf('async clearAiChat(')).split('\n  },')[0], /INSERT INTO sync_deletes/);
  assert.match(apiNative.slice(apiNative.indexOf('async removeRecipeFromCookbook(')).split('\n  },')[0], /'recipe_cookbook_links'/);
  assert.match(clientSync, /JSON\.stringify\(\{ tables: tablesToSend, settings, deletes, fk_ids: 'server' \}\)/);
  assert.match(clientSync, /if \(deleteIds\.length && body\.deleted\)/, 'kept until a server that knows deletes takes them');
});

test("a pull keeps the phone's unsent links and drops what the server deleted", () => {
  const pull = dbNative.slice(dbNative.indexOf('export async function dbApplyPull'));
  assert.match(pull, /COALESCE\(sync_status, 'synced'\) != 'pending'/);
  assert.match(pull, /const known = \[\.\.\.cookbookMap\.values\(\)\]/, 'every cookbook the server has, even one left with no links');
  assert.match(pull, /payload\.tables\.deletions/);
  assert.match(dbNative, /WHERE sync_status = 'pending'`/, 'only links added or reordered here go up');
});

test("a smart cookbook's category is translated both ways", () => {
  const m = new Map([[3, 41]]);
  assert.equal(mapSmartFilterCategory('{"category_id":3,"tags":["a"]}', id => m.get(id)), '{"category_id":41,"tags":["a"]}');
  assert.equal(mapSmartFilterCategory('{"category_id":9}', id => m.get(id)), '{"category_id":9}', 'unknown ids stay');
  assert.equal(mapSmartFilterCategory('{"tags":["a"]}', id => m.get(id)), '{"tags":["a"]}');
  assert.equal(mapSmartFilterCategory(null, id => m.get(id)), null);
  assert.equal(mapSmartFilterCategory('{bad', id => m.get(id)), '{bad');
  assert.deepEqual(cleanSmartFilter({ category_id: '7', tags: [' a ', ''], favorites_only: 'yes', min_rating: '4', junk: 1 }),
    { category_id: 7, tags: ['a'], min_rating: 4 });
  assert.match(dbNative, /mapSmartFilterCategory\(translated\.smart_filter_json, id => cats\.get\(id\)\)/);
  assert.match(clientSync, /row\._local_filter_category = true/);
});

// The real schema: open server/db.js on a scratch database in a child
// process (it opens DB_PATH when imported) and check the triggers.
test('server schema: writes are stamped, deletes are recorded', (t) => {
  try {
    createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  } catch {
    t.skip('better-sqlite3 is not built for this Node');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'ct-sync-'));
  try {
    const script = `
      const { default: db } = await import(${JSON.stringify(new URL('../server/db.js', import.meta.url).href)});
      const u = db.prepare("INSERT INTO users (username, password_hash) VALUES ('t', 'x')").run().lastInsertRowid;
      const cat = db.prepare("INSERT INTO recipe_categories (user_id, name, slug) VALUES (?, 'C', 'c')").run(u).lastInsertRowid;
      const r = db.prepare("INSERT INTO recipes (user_id, name, category_id, updated_at) VALUES (?, 'R', ?, '2020-01-01 00:00:00')").run(u, cat).lastInsertRowid;
      const before = db.prepare('SELECT synced_at FROM recipes WHERE id = ?').get(r).synced_at;
      await new Promise(res => setTimeout(res, 15));
      db.prepare("UPDATE recipes SET name = 'R2', updated_at = '2020-01-02 00:00:00' WHERE id = ?").run(r);
      const after = db.prepare('SELECT synced_at, updated_at FROM recipes WHERE id = ?').get(r);
      db.prepare('DELETE FROM recipe_categories WHERE id = ?').run(cat);
      const del = db.prepare("SELECT table_name, row_id, user_id FROM sync_deletions").all();
      const recat = db.prepare('SELECT category_id FROM recipes WHERE id = ?').get(r).category_id;
      const chat = db.prepare("INSERT INTO ai_chat_history (user_id, role, content, updated_at) VALUES (?, 'user', 'hi', '2020-01-01 00:00:00')").run(u).lastInsertRowid;
      db.prepare("UPDATE ai_chat_history SET content = 'yo', updated_at = '2020-01-03 00:00:00' WHERE id = ?").run(chat);
      const chatRow = db.prepare('SELECT updated_at, synced_at FROM ai_chat_history WHERE id = ?').get(chat);
      db.prepare("UPDATE ai_chat_history SET content = 'no time' WHERE id = ?").run(chat);
      const chatBumped = db.prepare('SELECT updated_at FROM ai_chat_history WHERE id = ?').get(chat).updated_at;
      process.stdout.write(JSON.stringify({ before, after, del, recat, chatRow, chatBumped, cat: Number(cat), u: Number(u) }));
    `;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, DB_PATH: join(dir, 'test.db') }, encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{"before"')));
    assert.match(out.before, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/, 'an insert is stamped with the server time');
    assert.ok(out.after.synced_at > out.before, 'an update moves the stamp');
    assert.equal(out.after.updated_at, '2020-01-02 00:00:00', "the device's edit time is kept");
    assert.deepEqual(out.del, [{ table_name: 'recipe_categories', row_id: out.cat, user_id: out.u }]);
    assert.equal(out.recat, null, "a deleted category's recipes stay, without it");
    assert.equal(out.chatRow.updated_at, '2020-01-03 00:00:00', "the stamp doesn't reset a chat row's edit time");
    assert.notEqual(out.chatBumped, '2020-01-03 00:00:00', 'an edit without a time still gets one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
