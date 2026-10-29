/**
 * Each field of an edit keeps its own edit time (field_edits): a field the
 * phone or the web changed before a newer edit made elsewhere doesn't
 * overwrite it just because another field of the same row was changed
 * later, offline. And an edit made before a delete doesn't bring the row
 * back (lib/field-sync.js, the rule every Trace app shares). The real
 * routes on a scratch database (scripts/field-edits.harness.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

test("the web app's queued saves of one row keep each field's own time, also when one of them couldn't say what it changed", async () => {
  const { collapseOps } = await import('../src/lib/offline-edits.js');
  const op = (seq, extra) => ({ seq, method: 'PUT', path: '/api/shopping/7', kind: 'shopping-update', key: 'shopping:7', id: 7, ...extra });
  const T1 = '2026-10-01T10:00:00.000Z', T2 = '2026-10-01T10:30:00.000Z';
  // Both say: each field at its own save's time.
  let [one] = collapseOps([
    op(1, { body: { name: 'Oat milk' }, sync: { base_synced_at: 'S1', changed: ['name'], edited_at: T1 } }),
    op(2, { body: { name: 'Oat milk', checked: true }, sync: { base_synced_at: 'S2', changed: ['checked'], edited_at: T2 } }),
  ]);
  assert.deepEqual(one.sync, { base_synced_at: 'S1', changed: ['name', 'checked'], edited_at: T2, field_edits: { name: T1, checked: T2 } });
  // The first couldn't say (a whole save with no copy's stamp, sent as
  // before): the second's list no longer drops the first's change, and the
  // first's fields keep its own, older time. No copy to go by: each field
  // is judged by its time.
  [one] = collapseOps([
    op(1, { at: Date.parse(T1), body: { name: 'Oat milk', unit: 'l', quantity: 1 } }),
    op(2, { body: { name: 'Oat milk', unit: 'l', quantity: 1, checked: true, aisle: 'Dairy' }, sync: { base_synced_at: 'S2', changed: ['checked'], edited_at: T2 } }),
  ]);
  assert.deepEqual(one.sync, { base_synced_at: null, changed: ['name', 'unit', 'quantity', 'checked'], edited_at: T2, field_edits: { name: T1, unit: T1, quantity: T1, checked: T2 } },
    "never the rest of the second's body (its aisle is the copy it was made on)");
  // A later save that can't say goes as before: whole, on its own.
  [one] = collapseOps([
    op(1, { body: { name: 'A' }, sync: { base_synced_at: 'S1', changed: ['name'], edited_at: T1 } }),
    op(2, { body: { name: 'A', checked: true } }),
  ]);
  assert.equal(one.sync, undefined);
  // A delete then an edit of a created row stay as they were.
  assert.equal(collapseOps([op(1, { method: 'DELETE', kind: 'shopping-delete', body: null }), op(2, { body: { name: 'x' }, sync: { base_synced_at: 'S', changed: ['name'], edited_at: T2 } })])[0].sync.field_edits, undefined);
});

test('server: each field keeps its own edit time; an older edit does not bring back a delete; a restore keeps the times (real schema)', (t) => {
  try {
    createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  } catch {
    t.skip('better-sqlite3 is not built for this Node');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'ct-field-edits-'));
  try {
    const res = spawnSync(process.execPath, [new URL('./field-edits.harness.mjs', import.meta.url).pathname], {
      env: { ...process.env, DB_PATH: join(dir, 'test.db'), UPLOADS_PATH: join(dir, 'uploads'), JWT_SECRET: 'test-secret-for-field-edits' }, encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.slice(res.stdout.lastIndexOf('\n@@') + 3));

    assert.deepEqual(out.recipe.row, { name: 'Soup (web)', notes: 'phone notes' }, "the web's newer name stays, the phone's newer notes go in");
    assert.equal(out.recipe.kept, 'server', 'the phone pulls the name back');
    assert.deepEqual(out.recipe.versions, ['conflict:Soup (phone)'], "the phone's lost rename is kept as a version");
    assert.match(out.recipe.notesStamp, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, 'stamped with its own time');

    assert.deepEqual(out.pantry, { quantity: 2, unit: 'kg', notes: 'phone notes' }, "the web's newer amount stays, the phone's notes go in");

    assert.deepEqual(out.shopping, { name: 'Oat milk', checked: 1 }, "a web save replayed late: the phone's newer name stays, the check goes in");

    assert.deepEqual(out.deleted.older, { gone: 1, notes: 'n' }, 'an edit made before the delete does not bring it back');
    assert.deepEqual(out.deleted.newer, { gone: 0, notes: 'newer phone edit' }, 'one made after it does');

    assert.equal(out.restore.status, 200);
    assert.equal(out.restore.name, 'Stew', 'restored');
    assert.deepEqual(out.restore.nameStamp, ['2026-01-01 00:00:00.000', '2026-01-01 00:00:00'], "a restored row keeps each field's time");
    assert.deepEqual(out.restore.notesStamp, ['2026-02-02 00:00:00.000', '2026-02-02 00:00:00']);
    assert.ok(out.restore.same, 'all of them');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the phone's edit-time triggers are made after every column migration, so an update's new columns get theirs at once", async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/lib/db-native.js', import.meta.url), 'utf8');
  const init = src.slice(src.indexOf('export async function dbInit()'), src.indexOf('}', src.indexOf('export async function dbInit()')));
  const at = name => init.indexOf(`await ${name}();`);
  assert.ok(at('_keepEditTimes') > 0);
  for (const m of [...src.matchAll(/^async function (_migrate\w+)\(\)[\s\S]*?^}/gm)].filter(x => /ALTER TABLE/.test(x[0])).map(x => x[1])) {
    assert.ok(at(m) >= 0 && at(m) < at('_keepEditTimes'), `${m} adds columns: it runs before the triggers are made`);
  }
});
