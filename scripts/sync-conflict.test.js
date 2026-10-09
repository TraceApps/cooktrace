/**
 * Two edits of one row: the newer edit stays, and a recipe edit that
 * doesn't stay is kept as an earlier version the owner can restore.
 *
 * A phone that was offline used to overwrite whatever the server had,
 * however much newer. Now apps that say what time it is on them (client_now)
 * are judged: edit times are moved onto the server's clock and the newer
 * edit stays; an edit made on the copy the server still has always goes
 * in; for recipes, only the fields an edit changed count. Older apps and
 * pages keep their old behavior, and what they replace is kept quietly.
 * The real-schema part runs the server's sync and recipe routes on a
 * scratch database (scripts/sync-conflict.harness.mjs); the Android app's
 * own sync code runs against a real server in android-sync.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { utcMs, clockOffset, editTime, latestTime, serverIsNewer } from '../server/lib/sync-clock.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('edit times are read the same in every format either side writes', () => {
  const t = Date.UTC(2026, 9, 6, 12, 30, 5);
  assert.equal(utcMs('2026-10-06 12:30:05'), t, "SQLite's datetime('now') is UTC");
  assert.equal(utcMs('2026-10-06 12:30:05.250'), t + 250);
  assert.equal(utcMs('2026-10-06T12:30:05Z'), t);
  assert.equal(utcMs('2026-10-06T12:30:05.000Z'), t);
  assert.equal(utcMs('2026-10-06T14:30:05+02:00'), t);
  assert.equal(utcMs('2026-10-06'), Date.UTC(2026, 9, 6));
  assert.ok(Number.isNaN(utcMs('')));
  assert.ok(Number.isNaN(utcMs(null)));
  assert.ok(Number.isNaN(utcMs('soon')));
});

test("a device's clock is corrected however far off it is", () => {
  const near = clockOffset(new Date(Date.now() - 10 * 60000).toISOString());
  assert.ok(Math.abs(near - 10 * 60000) < 5000, `ten minutes slow, got ${near}`);
  const far = clockOffset(new Date(Date.now() - 40 * 86400000).toISOString());
  assert.ok(Math.abs(far - 40 * 86400000) < 5000, 'a clock reset weeks back is still the same device, editing now');
  assert.equal(clockOffset(undefined), 0, 'older apps send none');
  assert.equal(clockOffset('later'), 0);
  assert.equal(clockOffset(12345), 0);
  assert.equal(clockOffset('2026-01-06T12:00:00.000Z', Date.UTC(2026, 0, 6, 12, 0, 3)), 3000, 'measured from when the push arrived');
});

test("an edit time moves onto the server's clock and compares by time, not text", () => {
  assert.equal(editTime('2026-01-06 12:00:00', 10 * 60000), '2026-01-06 12:10:00');
  assert.equal(editTime('2026-01-06T12:00:00.000Z', 0), '2026-01-06 12:00:00');
  assert.equal(editTime('not a time', 5000), 'not a time', 'kept as it came');
  assert.match(editTime(null, 0), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.ok(editTime(new Date(Date.now() + 3600000).toISOString(), 0) <= editTime(null, 0), 'no edit is from the future');
  assert.equal(serverIsNewer('2026-10-06 12:00:05', '2026-10-06 12:00:00'), true);
  assert.equal(serverIsNewer('2026-10-06 12:00:00', '2026-10-06 12:00:00'), false, 'a tie goes to the edit arriving');
  assert.equal(serverIsNewer('2026-01-06 12:00:00', editTime('2026-01-06 12:00:00', -300)), false, 'rounding is a tie');
  // As text, "2026-10-06T..." sorts after "2026-10-06 ..." whatever the time.
  assert.equal(serverIsNewer('2026-10-06T09:00:00Z', '2026-10-06 12:00:00'), false);
  assert.equal(serverIsNewer('garbage', '2026-10-06 12:00:00'), false);
  assert.equal(latestTime('2026-10-06 12:00:00', '2026-10-07 08:00:00'), '2026-10-07 08:00:00');
  assert.equal(latestTime('2026-10-06 12:00:00', null), '2026-10-06 12:00:00');
  assert.equal(latestTime(null, '2026-10-06 12:00:00'), '2026-10-06 12:00:00');
});

test('the app sends its clock, its copy and what it changed, and asks for the stamp', () => {
  const sync = read('../src/lib/sync.js');
  const dbNative = read('../src/lib/db-native.js');
  assert.match(sync, /client_now: new Date\(\)\.toISOString\(\)/);
  assert.match(sync, /\/api\/sync\/pull\?since=\$\{encodeURIComponent\(since\)\}&synced_at=1/);
  assert.match(sync, /const changed = rowChanges\(table, r\);/, 'every table says which fields it changed');
  assert.match(sync, /if \(!r\.kept && r\.client_id\)/, "the server's copy is the phone's only once a pull stored it");
  assert.match(dbNative, /ADD COLUMN server_synced_at TEXT/);
  assert.match(dbNative, /translated\.server_synced_at = translated\.synced_at/);
  assert.match(dbNative, /delete translated\.synced_at/, 'never written into a table that lacks the column');
  assert.match(dbNative, /FROM sync_echoes WHERE table_name = \? AND row_id = \?/, "the phone knows its own push's echo");
  assert.match(dbNative, /edit_clock = 'server'/, 'edits are stamped on the server clock as they are made');
});

test('the phone, the web app and the server merge the same fields', async () => {
  const server = await import('../server/lib/sync-fields.js');
  const client = await import('../src/lib/sync-fields.js');
  assert.deepEqual(client.SYNC_FIELDS, server.SYNC_FIELDS);
  assert.match(read('../src/lib/db-native.js'), /export \{ SYNC_FIELDS \} from '\.\/sync-fields\.js'/);
  for (const [t, groups] of Object.entries(server.SYNC_GROUPS)) {
    for (const g of groups) for (const f of g) assert.ok(server.SYNC_FIELDS[t].includes(f), `${t}: ${f} in a group is a synced field`);
  }
});

test('only apps that ask get the stamp in a pull (older apps write every key)', () => {
  const route = read('../server/routes/sync.js');
  assert.match(route, /const withSyncedAt = req\.query\.synced_at === '1'/);
  assert.match(route, /if \(withSyncedAt\) cols\.push\('synced_at'(, 'client_key')?\)/);
});

test("the web app's recipe saves say which copy they were made on, and which fields they change", async () => {
  const { recipeSaveBase, withSaveBase, recipeBaseOf, recipeChangedFields, collapseOps } = await import('../src/lib/offline-edits.js');
  const page = { id: 4, name: 'A', notes: 'n', rating: 3, favorite: false, imgUrl: '/uploads/a.jpg', servings: null, synced_at: '2026-10-06 10:00:00.000' };
  const pageBase = recipeBaseOf(page);
  assert.equal(pageBase.synced_at, '2026-10-06 10:00:00.000');
  assert.equal(pageBase.img_url, '/uploads/a.jpg', 'the picture as a save sends it');
  assert.deepEqual(recipeSaveBase({ name: 'B' }, null, 'x').changed, ['name'], 'a save of a few fields changes those');
  assert.equal(recipeSaveBase({ id: 4, name: 'B', notes: 'n' }, null, 'x'), null, "a whole row with no copy's stamp can't say: saved as before");
  const b = recipeSaveBase({ ...page, name: 'B', _base: pageBase }, null, '2026-10-06T10:05:00.000Z');
  assert.equal(b.base_synced_at, '2026-10-06 10:00:00.000');
  assert.deepEqual(b.changed, ['name'], 'only what differs from the copy the page had');
  assert.equal(b.edited_at, '2026-10-06T10:05:00.000Z', 'when the save was made, not when it goes up');
  assert.deepEqual(recipeSaveBase({ ...page, favorite: true, _base: pageBase, _changed: ['favorite'] }, null, 'x').changed, ['favorite'], 'a toggle says its one field');
  assert.deepEqual(recipeChangedFields({ ...page, img_url: '/uploads/a.jpg', servings: '' }, pageBase), [], 'the same value written another way is no change');
  // Another tab read a newer copy since: this tab's save is still about its own.
  const newer = { ...page, name: 'Other tab', synced_at: '2026-10-06 10:09:00.000' };
  assert.equal(recipeSaveBase({ ...page, rating: 5, _base: pageBase }, newer, 'x').base_synced_at, '2026-10-06 10:00:00.000');
  assert.equal(recipeSaveBase({ ...page, rating: 5 }, newer, 'x').changed, null, "the kept copy isn't this page's: it can't say");
  assert.deepEqual(recipeSaveBase({ ...page, rating: 5 }, { ...page }, 'x').changed, ['rating'], 'the kept copy is this one');
  // Two saves queued for one recipe go up as one: the first copy, both changes.
  const op = (seq, sync) => ({ seq, kind: 'recipe-update', key: 'recipe:4', id: 4, body: {}, sync });
  const [one] = collapseOps([op(1, { base_synced_at: 'A', changed: ['name'], edited_at: '1' }), op(2, { base_synced_at: 'B', changed: ['rating'], edited_at: '2' })]);
  assert.deepEqual(one.sync, { base_synced_at: 'A', changed: ['name', 'rating'], edited_at: '2' });
  const sent = withSaveBase({ name: 'B', _base: pageBase, _changed: ['name'], _sync: { stale: true } }, b, 'NOW');
  assert.equal(sent._sync.client_now, 'NOW');
  assert.equal(sent._sync.stale, undefined);
  assert.equal(sent._base, undefined);
  assert.equal(sent._changed, undefined);
  const api = read('../src/lib/offline-api.js');
  assert.match(api, /_http\._fetch\(op\.method, path, withSaveBase\(body, op\.sync\)\)/, 'a replayed save carries its copy and the time');
  assert.match(read('../src/routes/RecipeView.svelte'), /addEventListener\('ct:offline-synced', _onOfflineSynced\)/, 'the page shows the copy that stayed');
  assert.match(read('../src/routes/RecipeView.svelte'), /rating: next, _base: recipeBaseOf\(recipe\), _changed: \['rating'\]/);
  assert.match(read('../src/routes/Recipes.svelte'), /favorite: !r\.favorite, _base: recipeBaseOf\(r\), _changed: \['favorite'\]/, 'the list says its toggle too');
  assert.match(read('../src/routes/RecipeEditor.svelte'), /_base: loadedBase/);
});

test('every web save of a synced row says its copy and what it changed', async () => {
  const { saveBase, saveTarget, readTable, stampedRows, collapseOps } = await import('../src/lib/offline-edits.js');
  assert.deepEqual(saveTarget('PUT', '/api/shopping/7'), { table: 'shopping_list', id: 7, toggle: false });
  assert.deepEqual(saveTarget('PATCH', '/api/pantry/3/stock'), { table: 'pantry_items', id: 3, toggle: true });
  assert.deepEqual(saveTarget('PUT', '/api/recipes/categories/2'), { table: 'recipe_categories', id: 2, toggle: false });
  assert.deepEqual(saveTarget('PUT', '/api/recipes/5/cooks/9'), { table: 'cook_diary', id: 9, toggle: false });
  for (const [m, u] of [['PUT', '/api/pantry/categories/1'], ['PUT', '/api/cookbooks/1'], ['PUT', '/api/units/1'], ['PUT', '/api/cook-diary/1'], ['PATCH', '/api/shopping/1/check']]) {
    assert.ok(saveTarget(m, u), `${m} ${u} says its copy`);
  }
  assert.equal(saveTarget('POST', '/api/shopping'), null, 'creates have no copy');
  assert.equal(readTable('/api/shopping'), 'shopping_list');
  assert.equal(readTable('/api/units'), 'custom_units');
  assert.equal(stampedRows({ builtin: [], custom: [{ id: 1, synced_at: 's' }] }).length, 1);
  // The row a page showed: only what the save changed on it.
  const shown = { id: 7, name: 'Milk', quantity: 1, unit: 'l', checked: 0, synced_at: 'S1' };
  const seen = (t, id, st) => (t === 'shopping_list' && id === 7 && st === 'S1' ? shown : null);
  assert.deepEqual(saveBase('PUT', '/api/shopping/7', { ...shown, checked: true }, seen, 'E'), { base_synced_at: 'S1', changed: ['checked'], edited_at: 'E' });
  assert.equal(saveBase('PUT', '/api/shopping/7', { ...shown, synced_at: 'S2', checked: true }, seen, 'E').changed, null, 'a copy not shown here: it can\'t say');
  assert.deepEqual(saveBase('PATCH', '/api/shopping/7/check', { checked: true }, seen, 'E').changed, ['checked'], 'a toggle changes what it sends');
  assert.deepEqual(saveBase('PUT', '/api/shopping/7', { aisle: 'Dairy' }, seen, 'E'), { base_synced_at: null, changed: ['aisle'], edited_at: 'E' }, 'a save of a few fields changes those');
  assert.deepEqual(saveBase('PUT', '/api/shopping/7', { name: 'x', unit: 'l', _base: { name: 'Milk', unit: 'l' } }, seen, 'E').changed, ['name'], "a form with the row it opened, that row has no stamp: what differs from it");
  assert.equal(saveBase('PUT', '/api/shopping/7', { id: 7, name: 'x', unit: 'l' }, seen, 'E'), null, "a whole row with no copy's stamp: saved as before");
  // Two queued saves of one item: the first copy, every changed field.
  const op = (seq, sync) => ({ seq, kind: 'shopping-update', key: 'shopping:7', id: 7, body: {}, sync });
  const [one] = collapseOps([op(1, { base_synced_at: 'S1', changed: ['name'], edited_at: '1' }), op(2, { base_synced_at: 'S2', changed: ['quantity'], edited_at: '2' })]);
  assert.deepEqual(one.sync, { base_synced_at: 'S1', changed: ['name', 'quantity'], edited_at: '2' });
  const api = read('../src/lib/offline-api.js');
  assert.match(api, /_noteShown\(path, answer\)/, 'rows read are remembered by their stamp');
  assert.match(api, /return _straight\(http, m, target, withSaveBase\(body, sync\)\)/, 'saves that go straight up say their copy too');
});

test('earlier versions are a server-only call on Android, empty on a phone alone', () => {
  const api = read('../src/lib/api.js');
  const native = read('../src/lib/api-native.js');
  const block = api.slice(api.indexOf('const SERVER_ONLY_METHODS'), api.indexOf(']);', api.indexOf('const SERVER_ONLY_METHODS')));
  for (const m of ['getRecipeVersions', 'markRecipeVersionsSeen', 'restoreRecipeVersion']) {
    assert.ok(block.includes(`'${m}'`), `${m} goes to the server`);
    assert.match(native, new RegExp(`async ${m}\\(`), `${m} has a local stub`);
  }
});

test('server: newer edit wins, versions kept, restore and undo (real schema)', (t) => {
  try {
    createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  } catch {
    t.skip('better-sqlite3 is not built for this Node');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'ct-conflict-'));
  try {
    const res = spawnSync(process.execPath, [new URL('./sync-conflict.harness.mjs', import.meta.url).pathname], {
      env: { ...process.env, DB_PATH: join(dir, 'test.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET: 'test-secret-for-sync-conflict' }, encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.slice(res.stdout.lastIndexOf('\n@@') + 3));

    assert.ok(!out.pullWithoutFlag.includes('synced_at'), 'older apps never see a key they have no column for');
    assert.ok(out.pullWithFlag.includes('synced_at'));

    assert.equal(out.olderPhone.result.kept, 'server', 'the phone is told its row is in, and that the server kept its own');
    assert.equal(out.olderPhone.server, 'Soup (web)', "the phone's older edit doesn't overwrite the web's");
    assert.ok(out.olderPhone.restamped, 'stamped again so the phone pulls the winning copy');
    assert.deepEqual(out.olderPhone.versions, [{ reason: 'conflict', seen: false, name: 'Soup (phone)', notes: 'phone edit' }]);

    assert.equal(out.newerPhone.server, 'Stew (phone)');
    assert.deepEqual(out.newerPhone.versions, ['Stew (web)'], "the web's overwritten copy is kept");
    assert.match(out.newerPhone.result.synced_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
    assert.match(out.newerPhone.result.updated_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, 'the edit time stored, to know the echo');

    assert.equal(out.noConflict.server, 'Bread (phone again)', 'an edit on the current copy goes in, whatever the clock says');
    assert.equal(out.noConflict.versions, 0, 'no conflict, nothing kept (twice in a row either)');

    assert.equal(out.slowNewer.got, out.slowNewer.want, 'clock 10 minutes slow');
    assert.equal(out.fastOlder.got, out.fastOlder.want, 'clock 10 minutes fast');
    assert.ok(Math.abs(out.slowNewer.offset - 600000) < 5000);
    assert.equal(out.offset_missing, 0);
    assert.equal(out.offset_garbage, 0);
    assert.ok(Math.abs(out.offset_farOff - 40 * 86400000) < 5000, 'a clock 40 days off is corrected');

    assert.equal(out.oldApp.first.kept, undefined, "older apps' edits go in, as before");
    assert.equal(out.oldApp.server, 'Rice (old app, newer)');
    assert.deepEqual(out.oldApp.versions, ['replaced:Rice (old app):true', 'replaced:Rice (web):true'], 'each copy they replace is kept, quietly');
    assert.equal(out.oldAppPantry, 'old app', 'other rows from older apps too, as before');

    assert.equal(out.pantry.result.kept, 'server');
    assert.equal(out.pantry.notes, 'web later');
    assert.equal(out.pantry.newVersions, 0, 'only recipes keep versions');

    assert.deepEqual(out.restore.restored, { name: 'Curry (phone)', steps: ['Phone step'] });
    assert.ok(out.restore.syncsOut, 'a restore gets a new edit time and stamp, so it syncs out');
    assert.deepEqual(out.restore.backup, { name: 'Curry (web)', seen: true }, 'the replaced copy is kept first');
    assert.deepEqual(out.restore.undone, { name: 'Curry (web)', steps: ['Web step'] }, 'and restoring it undoes the restore');
    assert.equal(out.restore.unseenBefore, 1);
    assert.equal(out.restore.unseenAfter, 0);
    assert.equal(out.restore.wrongRecipe, 404, "another recipe's version can't be restored onto this one");
    assert.equal(out.restore.missing, 404);

    assert.equal(out.cap.count, 20, 'the newest 20 are kept');
    assert.equal(out.cap.newest, 'newest');
    assert.equal(out.cap.conflictsKept, 3, 'copies kept only to be safe go first');
    assert.equal(out.cascade, 0, "a recipe's versions go with it");

    assert.ok(!out.phoneDelete.result.kept, 'a delete made after the web edit goes in');
    assert.ok(out.phoneDelete.deleted);

    assert.ok(out.cookLogged.cookStatus < 300, `cook logged (${out.cookLogged.cookStatus})`);
    assert.equal(out.cookLogged.server, 'Chili (phone)', "a cook or a share link doesn't beat an edit of the recipe");
    assert.equal(out.cookLogged.versions, 0, 'and nothing is kept: the content never changed on the server');

    const t3 = out.threeDevices;
    assert.equal(t3.a, 'server', "phone A's 09:00 edit loses to the web's 10:00");
    assert.deepEqual(t3.afterA, { name: 'Tart (web)', updated_at: t3.web, name_at: t3.web }, "A's lost push leaves the edit times alone");
    assert.equal(t3.b, 'in', "phone B's 10:30 edit still beats the web's");
    assert.deepEqual(t3.afterB, { name: 'Tart (phone B)', updated_at: t3.bAt });
    assert.deepEqual(t3.versions, ['Tart (web)', 'Tart (phone A)'], 'both copies that did not stay are kept');
    assert.equal(t3.pantryA, 'server');
    assert.deepEqual(t3.pAfterA, { notes: 'web', updated_at: t3.web });
    assert.deepEqual(t3.pantryB, { notes: 'phone B', updated_at: t3.bAt });

    assert.equal(out.changedOnly.result, 'server', 'the phone pulls the content back');
    assert.deepEqual(out.changedOnly.row, { name: 'Dal (web)', steps: '["Web"]', cook_count: 0 }, "a push that changed nothing doesn't put back old content (counts follow the diary)");
    assert.equal(out.changedOnly.versions, 0, 'and nothing is kept');
    assert.deepEqual(out.changedOnly.ratingRow, { name: 'Dal 2 (web)', rating: 3 }, 'a rating changed on the phone goes in, the content stays');
    assert.equal(out.changedOnly.ratingVersions, 0);

    assert.equal(out.webSave.lost.kept, 'server', 'a web save replayed late is told the server kept its own');
    assert.equal(out.webSave.lost.answer, 'Cake (phone)', 'and gets the copy that stayed');
    assert.equal(out.webSave.lost.server, 'Cake (phone)');
    assert.deepEqual(out.webSave.lost.versions, ['Cake (web, offline)']);
    assert.equal(out.webSave.won.kept, null);
    assert.equal(out.webSave.won.server, 'Pasta (web)');
    assert.deepEqual(out.webSave.won.versions, ['Pasta (phone)']);
    assert.deepEqual(out.webSave.rated.row, { name: 'Salad (phone)', rating: 5 }, "a rating from an old page doesn't put back old content");
    assert.equal(out.webSave.rated.versions, 0);
    assert.deepEqual(out.webSave.editorKeepsFavorite, { name: 'Fav (edited)', favorite: 1 }, "an editor's save doesn't clear the favorite");
    assert.equal(out.webSave.plain, 'Toast (plain)', 'a save from an older page goes in, as before');
    assert.deepEqual(out.webSave.plainKept, ['replaced:Toast:true'], 'and what it replaced is kept, quietly');

    for (const k of ['renameThenRate', 'renameThenEdit']) {
      assert.equal(out[k].sent, 1, `${k}: the queue sends one save`);
      assert.equal(out[k].row.name, 'Pie (renamed offline)', `${k}: the first offline edit isn't dropped`);
      assert.equal(out[k].versions, 0);
    }
    assert.deepEqual(out.renameThenRate.changed, ['name', 'rating']);
    assert.equal(out.renameThenRate.row.rating, 4);
    assert.equal(out.renameThenEdit.row.notes, 'second edit');

    assert.deepEqual(out.listFavorite.row, { name: 'Stew (other device)', notes: 'new notes', favorite: 1 }, "a favorite from an older list doesn't put back its content");
    assert.equal(out.listFavorite.versions, 0);

    assert.equal(out.noStamp.result, 'in', 'an edit with no stamp goes in when it is newer');
    assert.equal(out.noStamp.row.rating, 5);
    assert.deepEqual(out.noStamp.versions, ['replaced:Rice (web)'], 'and the copy it replaced is kept, quietly');
    assert.deepEqual(out.forgedStamp.versions, ['replaced:Rice (web)'], 'a stamp from the future counts as none');

    assert.equal(out.reorder.status, 200, 'the reorder route is reached (it was shadowed by /categories/:id)');
    assert.equal(out.reorder.updated_at, '2020-01-01 00:00:00', "a reorder doesn't move updated_at");
    assert.equal(out.reorder.sort_order, 1);
    assert.ok(out.reorder.sortStampedNow, 'sort_order is stamped as changed now');
    assert.ok(out.reorder.nameUntouched);

    assert.deepEqual(out.shoppingFields.row, { name: 'Oat milk', checked: 1 }, 'checked off on the phone, renamed on the web: both kept');
    assert.equal(out.shoppingFields.result, 'server', 'the phone pulls the new name');

    assert.equal(out.notBackwards.after.updated_at, out.notBackwards.before, "updated_at doesn't go back");
    assert.equal(out.notBackwards.after.notes, 'newer');
    assert.equal(out.notBackwards.after.rating, 3, 'the rating it changed still goes in');
    assert.deepEqual(out.notBackwards.versions, ['older'], 'its lost notes are kept');

    assert.deepEqual(out.symmetric.row, { notes: 'phone notes', rating: 5 }, "the server's newer rating stays, the phone's notes go in");
    assert.equal(out.symmetric.versions, 0, 'no content was lost: nothing kept');

    assert.equal(out.absurdClock.pantry.name.name, 'Flour (phone)', 'an edit from a clock that cannot be right goes in');
    assert.ok(out.absurdClock.pantry.name.updated_at.startsWith('20'), 'taken as made now');
    assert.equal(out.absurdClock.recipe.name, 'Loaf (phone)');
    assert.deepEqual(out.absurdClock.recipe.versions, ['conflict:Loaf (web)'], 'and the copy it replaced is kept');

    for (const [table, r] of Object.entries(out.legacy)) {
      if (table === 'versions') continue;
      assert.ok(r.baseline, `${table}: a row from before the stamps gets a baseline`);
      assert.ok(r.phone, `${table}: the phone's offline edit goes in`);
      assert.ok(r.web, `${table}: the web's change stays`);
    }
    assert.equal(out.legacy.versions, 0, 'nothing was lost: no version, no notice');

    assert.deepEqual(out.groups, { quantity: 3, unit: 'lb' }, 'an amount and its unit stay together (never 3 g)');
    assert.equal(out.reorderDelete.deleted, 1, "a reorder doesn't bring back an item deleted offline");

    assert.deepEqual(out.rest.shopping, { name: 'Green tea', checked: 1 }, 'a web save on an older copy changes only its field');
    assert.deepEqual(out.rest.pantry, { name: 'Basmati rice', notes: 'for pilaf', quantity: 1, unit: 'kg' });
    assert.deepEqual(out.rest.stock, { status: 200, in_stock: 0 });
    assert.deepEqual(out.rest.category, { name: 'Baking', color: '#00ff00' });

    assert.equal(out.variants.broken, 0, 'the variant tree keeps every rule the pantry route enforces');
    assert.equal(out.variants.rows['Whole milk'].parent, out.variants.ids.Q, "the web's newer link stays");
    assert.equal(out.variants.rows['Brand milk'].parent, null, "the phone's older link that broke a rule is taken out");
    assert.equal(out.variants.rows['Whole milk'].source, null, 'a variant has no nutrition source');

    // A new row sent twice is made once (server/lib/create-keys.js).
    assert.equal(out.once.ids[0], out.once.ids[1], 'the second send is the row the first made');
    assert.deepEqual(out.once.rows, ['second send, edited'], 'one row, with what the second send changed');
    assert.ok(out.once.otherKey, 'another key is another row');
    assert.equal(out.once.pulledKey, 'phone-1:recipes:5', 'the pull hands the key back to the app that made it');
    assert.equal(out.once.oldAppKey, false, 'older apps never see a key they have no column for');
    assert.deepEqual(out.once.category, { error: null, same: true, count: 1 }, 'a name the account has is that row, not a second that stops the push');
    assert.deepEqual(out.once.versions, ['Twice Soup (phone)'], 'the same lost copy kept once');
    assert.deepEqual(out.once.uploads, [1, 1, 1], 'an upload sent twice makes each row once');

    // Photos taken with no connection are stored as files, from the push and by the startup repair.
    const file = /^\/uploads\/[\w-]+\.png$/;
    assert.match(out.photos.made, file, 'a new recipe pushed with an embedded photo stores a file');
    assert.match(out.photos.edited, file, 'a photo changed on the phone too');
    assert.equal(out.photos.editResult, null, "the phone's edit stands: nothing to pull back");
    assert.equal(out.photos.filesAdded, 1);
    assert.equal(out.photos.versions, 0, 'storing a photo as a file makes no version');
    assert.equal(out.photos.otherField.files, 0, "a photo the push didn't change isn't stored again");
    assert.equal(out.photos.otherField.img.img_url, out.photos.edited, 'and stays as it was');
    assert.equal(out.photos.otherField.img.name, 'Photo Soup (renamed)');
    assert.match(out.photos.cook.photo_url, file);
    const list = JSON.parse(out.photos.cook.photos);
    assert.equal(list.length, 2); assert.match(list[0], file); assert.equal(list[1], '/uploads/kept.jpg');
    assert.match(out.photos.cover, file);
    assert.match(out.photos.pantry, file);
    const r = out.photos.repair;
    assert.match(r.stored, file, 'a photo stored embedded becomes a file at startup');
    assert.equal(r.updatedKept, true, 'its edit time stays');
    assert.equal(r.stampsKept, true, 'and its field stamps');
    assert.equal(r.syncMoved, true, 'the sync stamp moves, so phones pull the path');
    assert.equal(r.deleted, 'data:', 'deleted rows are left alone');
    assert.equal(r.meanwhile, '/uploads/edited-meanwhile.jpg', 'an edit made meanwhile stays');
    assert.equal(r.broken, 'data:', "what can't be stored is left for the next startup");
    assert.equal(r.external, 'https://example.com/a.jpg', 'other addresses are never touched');
    assert.equal(r.versions, 0);
    assert.ok(r.result.failed >= 1);
    assert.equal(out.photos.retry.failed, r.result.failed, 'and tried again');
    assert.equal(out.photos.retry.repaired, 0);

    assert.deepEqual(out.keptAgain, ['Copy V:restore', 'Other 2:conflict', 'Other 1:conflict', 'Other 0:conflict'], 'kept once, as the newest, for the new reason');

    // The managers' saves say their copy, as every other save does.
    const m = out.managers;
    for (const t of ['recipe_categories', 'pantry_categories', 'custom_units', 'cookbooks']) {
      assert.ok(m[t].listed, `${t}: the list carries the server's stamp`);
      assert.ok(m[t].shown, `${t}: the browser notes the row it showed`);
      assert.ok(m[t].base, `${t}: the save sends the stamp of the copy it was made on`);
      assert.ok(m[t].answered, `${t}: the answer carries the new stamp, for the next save`);
    }
    assert.deepEqual(m.recipe_categories.changed, ['color']);
    assert.deepEqual(m.recipe_categories.row, { name: 'Side dishes', color: '#ff8800' }, "another device's rename stays, the manager's color goes in");
    assert.deepEqual(m.pantry_categories.changed, ['default_aisle']);
    assert.deepEqual(m.pantry_categories.row, { name: 'Canned goods', default_aisle: 'Aisle 4' });
    assert.deepEqual(m.custom_units.changed, ['full_name']);
    assert.deepEqual(m.custom_units.row, { abbr: 'pinch', full_name: 'small pinch', sort_order: 7 }, "a phone's move stays");
    assert.deepEqual(m.cookbooks.changed, ['description']);
    assert.deepEqual(m.cookbooks.row, { name: 'Weeknight dinners', description: 'Fast ones' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
