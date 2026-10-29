// Run by scripts/field-edits.test.js in a child process, with DB_PATH set to
// a scratch database: the server's real sync and REST routes on its real
// schema (single-user mode), driven over HTTP as the Android app and the web
// app drive them. Each field of an edit keeps its own edit time (field_edits),
// so a field changed before a newer edit made elsewhere doesn't overwrite it
// just because another field of the same row was changed later. Prints what
// it saw as JSON.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const express = require('express');
const { default: db } = await import('../server/db.js');
const { default: syncRoutes } = await import('../server/routes/sync.js');
const { default: recipeRoutes } = await import('../server/routes/recipes.js');
const { default: pantryRoutes } = await import('../server/routes/pantry.js');
const { default: shoppingRoutes } = await import('../server/routes/shopping.js');
const { default: backupRoutes } = await import('../server/routes/full-backup.js');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/sync', syncRoutes);
app.use('/api/recipes', recipeRoutes);
app.use('/api/pantry', pantryRoutes);
app.use('/api/shopping', shoppingRoutes);
app.use('/api/full-backup', backupRoutes);
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const j = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
const fmt = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const ago = min => fmt(Date.now() - min * 60000);
const iso = min => new Date(Date.now() - min * 60000).toISOString();
const out = {};
const backdate = (table, id) => db.prepare(`UPDATE ${table} SET created_at = datetime('now', '-1 day') WHERE id = ?`).run(id);
const pulledAll = async () => (await j('GET', '/api/sync/pull?since=1970-01-01&synced_at=1')).body.tables;
const phoneRow = (copy, changes, extra) => {
  const row = { ...copy, ...changes, client_id: 900 + copy.id, server_id: copy.id, server_synced_at: copy.synced_at, edit_clock: 'server', ...extra };
  delete row.id; delete row.synced_at;
  return row;
};
const push = (table, rows) => j('POST', '/api/sync/push', { tables: { [table]: rows }, fk_ids: 'server', client_now: new Date().toISOString() });
const webSave = (path, page, body, at, extra = {}) => j('PUT', path, { ...body, _sync: { base_synced_at: page.synced_at, edited_at: at, client_now: new Date().toISOString(), ...extra } });
const versions = async id => (await j('GET', `/api/recipes/${id}/versions`)).body;

// 1. A recipe: the phone renamed it 30 minutes ago and changed its notes 5
// minutes ago, offline; the web renamed it 15 minutes ago. The web's name
// is newer than the phone's rename, the phone's notes are newest.
{
  const made = await j('POST', '/api/recipes', { name: 'Soup', ingredients: [{ items: [{ name: 'water' }] }], steps: ['Boil'], notes: 'first' });
  const id = made.body.id;
  backdate('recipes', id);
  const copy = (await pulledAll()).recipes.find(r => r.id === id);
  const page = (await j('GET', `/api/recipes/${id}`)).body;
  await webSave(`/api/recipes/${id}`, page, { name: 'Soup (web)' }, iso(15), { changed: ['name'] });
  const r = await push('recipes', [phoneRow(copy, { name: 'Soup (phone)', notes: 'phone notes' }, {
    updated_at: ago(5), changed: ['name', 'notes'], field_edits: { name: ago(30), notes: ago(5) },
  })]);
  const row = db.prepare(`SELECT name, notes FROM recipes WHERE id = ?`).get(id);
  const v = await versions(id);
  out.recipe = { row, kept: r.body.tables.recipes[0].kept ?? null, versions: (Array.isArray(v) ? v : v?.versions || []).map(x => `${x.reason}:${(typeof x.data === 'string' ? JSON.parse(x.data) : x.data)?.name ?? x.name}`) };
  const st = JSON.parse(db.prepare(`SELECT field_stamps FROM recipes WHERE id = ?`).get(id).field_stamps);
  out.recipe.notesStamp = st.notes?.[1];
}

// 2. A pantry item, the same way: quantity changed long ago on the phone,
// the web changed it since, the phone's notes are newer.
{
  const made = await j('POST', '/api/pantry', { name: 'Flour', quantity: 1, unit: 'kg', notes: 'n' });
  const id = made.body.id;
  backdate('pantry_items', id);
  const copy = (await pulledAll()).pantry_items.find(r => r.id === id);
  const page = (await j('GET', `/api/pantry/${id}`)).body;
  await webSave(`/api/pantry/${id}`, page, { ...page, quantity: 2, unit: 'kg' }, iso(15), { changed: ['quantity'] });
  await push('pantry_items', [phoneRow(copy, { quantity: 5, notes: 'phone notes' }, {
    updated_at: ago(5), changed: ['quantity', 'notes'], field_edits: { quantity: ago(30), notes: ago(5) },
  })]);
  out.pantry = db.prepare(`SELECT quantity, unit, notes FROM pantry_items WHERE id = ?`).get(id);
}

// 3. The web app replaying two saves of one shopping row made offline: the
// name 30 minutes ago, checked off 5 minutes ago; renamed on the phone 15
// minutes ago.
{
  const made = await j('POST', '/api/shopping', { name: 'Milk' });
  const id = made.body.id;
  backdate('shopping_list', id);
  const page = (await j('GET', '/api/shopping')).body.find?.(r => r.id === id)
    ?? (await j('GET', '/api/shopping')).body.items?.find(r => r.id === id);
  const copy = (await pulledAll()).shopping_list.find(r => r.id === id);
  await push('shopping_list', [phoneRow(copy, { name: 'Oat milk' }, { updated_at: ago(15), changed: ['name'] })]);
  await webSave(`/api/shopping/${id}`, page, { ...page, name: 'Whole milk', checked: 1 }, iso(5), {
    changed: ['name', 'checked'], field_edits: { name: iso(30), checked: iso(5) },
  });
  out.shopping = db.prepare(`SELECT name, checked FROM shopping_list WHERE id = ?`).get(id);
}

// 4. A phone with no copy to compare (no base: every field counts) pushes a
// row it changed 20 minutes ago that was deleted on the web 10 minutes ago:
// the delete is newer and stays. One changed just now brings it back.
{
  const make = async (name) => {
    const r = await j('POST', '/api/pantry', { name, notes: 'n' });
    backdate('pantry_items', r.body.id);
    return r.body.id;
  };
  const a = await make('Rice'), b = await make('Beans');
  const all = (await pulledAll()).pantry_items;
  const ca = all.find(r => r.id === a), cb = all.find(r => r.id === b);
  for (const id of [a, b]) {
    await j('DELETE', `/api/pantry/${id}`);
    db.prepare(`UPDATE pantry_items SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(ago(10), ago(10), id);
    db.prepare(`UPDATE pantry_items SET field_stamps = json_set(field_stamps, '$.deleted_at', json_array(json_extract(field_stamps, '$.deleted_at[0]'), ?)) WHERE id = ?`).run(ago(10), id);
  }
  const noBase = (copy, changes, at) => { const r = phoneRow(copy, changes, { updated_at: at }); delete r.server_synced_at; return r; };
  await push('pantry_items', [noBase(ca, { notes: 'older phone edit' }, ago(20)), noBase(cb, { notes: 'newer phone edit' }, fmt(Date.now()))]);
  out.deleted = {
    older: db.prepare(`SELECT deleted_at IS NOT NULL AS gone, notes FROM pantry_items WHERE id = ?`).get(a),
    newer: db.prepare(`SELECT deleted_at IS NOT NULL AS gone, notes FROM pantry_items WHERE id = ?`).get(b),
  };
}

// 5. A backup and its restore keep when each field last changed: a
// restored row isn't stamped as changed at the restore in every field.
{
  const made = await j('POST', '/api/recipes', { name: 'Stew', ingredients: [{ items: [{ name: 'water' }] }], steps: ['Boil'], notes: 'kept' });
  const id = made.body.id;
  db.prepare(`UPDATE recipes SET field_stamps = json_set(field_stamps, '$.name', json_array('2026-01-01 00:00:00.000', '2026-01-01 00:00:00'), '$.notes', json_array('2026-02-02 00:00:00.000', '2026-02-02 00:00:00')) WHERE id = ?`).run(id);
  const stamps = () => JSON.parse(db.prepare(`SELECT field_stamps FROM recipes WHERE id = ?`).get(id).field_stamps);
  const before = stamps();
  const backup = await j('POST', '/api/full-backup');
  db.prepare(`UPDATE recipes SET name = 'Stew (changed since)' WHERE id = ?`).run(id);
  const restored = await j('POST', `/api/full-backup/${encodeURIComponent(backup.body.filename)}/restore`);
  const after = stamps();
  out.restore = { status: restored.status, name: db.prepare(`SELECT name FROM recipes WHERE id = ?`).get(id).name, nameStamp: after.name, notesStamp: after.notes, same: JSON.stringify(after) === JSON.stringify(before) };
  // And no answer carries them (lib/private-fields.js is mounted in index.js).
}

server.close();
console.log('\n@@' + JSON.stringify(out));
process.exit(0);
