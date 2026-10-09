// Run by scripts/sync-conflict.test.js in a child process, with DB_PATH set
// to a scratch database: the server's real sync and recipe routes on its real
// schema (single-user mode, so no sign-in), driven over HTTP the way the
// Android app and the web app drive them. Prints what it saw as JSON.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const express = require('express');
const { default: db } = await import('../server/db.js');
const { default: syncRoutes } = await import('../server/routes/sync.js');
const { default: recipeRoutes } = await import('../server/routes/recipes.js');
const { default: pantryRoutes } = await import('../server/routes/pantry.js');
const { default: shoppingRoutes } = await import('../server/routes/shopping.js');
const { default: unitRoutes } = await import('../server/routes/units.js');
const { default: cookbookRoutes } = await import('../server/routes/cookbooks.js');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/sync', syncRoutes);
app.use('/api/recipes', recipeRoutes);
app.use('/api/pantry', pantryRoutes);
app.use('/api/shopping', shoppingRoutes);
app.use('/api/units', unitRoutes);
app.use('/api/cookbooks', cookbookRoutes);
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const raw = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
// Recipe saves as the web app makes them: with the stamp of the copy the
// page had and the fields the save changes on it (offline-edits.js), unless
// marked _plain (an older page).
const { recipeChangedFields, recipeBaseOf, recipeSaveBase, withSaveBase, collapseOps, answerWithOps, saveBase, stampedRows, readTable } = await import('../src/lib/offline-edits.js');
const { stampFields } = await import('../server/lib/field-stamps.js');
const j = async (method, path, body) => {
  if (method === 'PUT' && /^\/api\/recipes\/\d+$/.test(path) && body && !body._sync) {
    if (body._plain) { const { _plain, ...rest } = body; return raw(method, path, rest); }
    const page = (await raw('GET', path)).body;
    const now = new Date().toISOString();
    return raw(method, path, { ...body, _sync: { base_synced_at: page.synced_at, changed: recipeChangedFields(body, recipeBaseOf(page)), edited_at: now, client_now: now } });
  }
  return raw(method, path, body);
};
const sql = (q, ...a) => db.prepare(q).get(...a);
const fmt = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const ago = min => fmt(Date.now() - min * 60000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = {};

// Rows made a day ago, so edit times in the scenarios (minutes ago) come
// after them, as real ones do.
const backdate = (table, id) => db.prepare(`UPDATE ${table} SET created_at = datetime('now', '-1 day') WHERE id = ?`).run(id);
async function newRecipe(name) {
  const r = await j('POST', '/api/recipes', { name, ingredients: [{ items: [{ name: 'water' }] }], steps: ['Boil'], notes: 'web' });
  backdate('recipes', r.body.id);
  return r.body.id;
}
// What the phone holds for a recipe: its row as the pull hands it over.
async function pulled(id) {
  const p = await j('GET', '/api/sync/pull?since=1970-01-01&synced_at=1');
  return p.body.tables.recipes.find(r => r.id === id);
}
// One row as the phone pushes it.
function phoneRow(copy, changes, { base = copy.synced_at } = {}) {
  const row = { ...copy, ...changes, client_id: 900 + copy.id, server_id: copy.id };
  delete row.id; delete row.synced_at;
  if (base != null) row.server_synced_at = base;
  return row;
}
const push = (rows, extra = {}) => j('POST', '/api/sync/push', { tables: { recipes: rows }, fk_ids: 'server', ...extra });
const now = () => ({ client_now: new Date().toISOString() });
const versions = async id => (await j('GET', `/api/recipes/${id}/versions`)).body;

// The pull only sends the stamp to apps that ask for it.
{
  const id = await newRecipe('Plain');
  const old = await j('GET', '/api/sync/pull?since=1970-01-01');
  out.pullWithoutFlag = Object.keys(old.body.tables.recipes.find(r => r.id === id));
  out.pullWithFlag = Object.keys(await pulled(id));
}

// 1. An offline phone edit, older than a web edit made since: the web's stays.
{
  const id = await newRecipe('Soup');
  const copy = await pulled(id);
  await sleep(20);
  await j('PUT', `/api/recipes/${id}`, { name: 'Soup (web)', ingredients: [{ items: [{ name: 'water' }] }], steps: ['Boil'], notes: 'web edit' });
  const stampBefore = sql('SELECT synced_at FROM recipes WHERE id = ?', id).synced_at;
  await sleep(20);
  const res = await push([phoneRow(copy, { name: 'Soup (phone)', notes: 'phone edit', updated_at: ago(60) })], now());
  const after = sql('SELECT name, notes, synced_at FROM recipes WHERE id = ?', id);
  out.olderPhone = {
    result: res.body.tables.recipes[0],
    server: after.name, restamped: after.synced_at > stampBefore,
    versions: (await versions(id)).map(v => ({ reason: v.reason, seen: v.seen, name: v.data.name, notes: v.data.notes })),
  };
}

// 2. The reverse: the phone's edit is newer, and the web's copy it replaces is kept.
{
  const id = await newRecipe('Stew');
  const copy = await pulled(id);
  await j('PUT', `/api/recipes/${id}`, { name: 'Stew (web)', ingredients: [], steps: ['Simmer'], notes: 'web' });
  const res = await push([phoneRow(copy, { name: 'Stew (phone)', updated_at: fmt(Date.now()) })], now());
  out.newerPhone = {
    result: res.body.tables.recipes[0],
    server: sql('SELECT name FROM recipes WHERE id = ?', id).name,
    versions: (await versions(id)).map(v => v.data.name),
  };
}

// 3. No conflict: an edit on the copy the server still has goes in, however
// old its clock says it is, and nothing is kept.
{
  const id = await newRecipe('Bread');
  const copy = await pulled(id);
  const res = await push([phoneRow(copy, { name: 'Bread (phone)', updated_at: ago(600) })], now());
  const second = await push([phoneRow({ ...copy, synced_at: res.body.tables.recipes[0].synced_at }, { name: 'Bread (phone again)', updated_at: ago(599) })], now());
  out.noConflict = {
    result: res.body.tables.recipes[0], second: second.body.tables.recipes[0],
    server: sql('SELECT name FROM recipes WHERE id = ?', id).name, versions: (await versions(id)).length,
  };
}

// 4. A phone clock ten minutes slow or fast still picks the right winner.
for (const [label, skewMin, editAgoMin, want] of [
  ['slowNewer', -10, -0.1, 'phone'], // edited after the web, clock 10 minutes behind
  ['fastOlder', 10, 2, 'web'],      // edited 2 minutes before the web, clock 10 minutes ahead
]) {
  const id = await newRecipe('Pie');
  const copy = await pulled(id);
  await j('PUT', `/api/recipes/${id}`, { name: 'Pie (web)', ingredients: [], steps: [], notes: '' });
  const phoneNow = Date.now() + skewMin * 60000;
  const res = await push([phoneRow(copy, { name: 'Pie (phone)', updated_at: fmt(phoneNow - editAgoMin * 60000) })], { client_now: new Date(phoneNow).toISOString() });
  out[label] = { want, got: sql('SELECT name FROM recipes WHERE id = ?', id).name === 'Pie (phone)' ? 'phone' : 'web', offset: res.body.clock_offset_ms };
}

// 5. client_now: missing or unreadable means an older app; any readable
// one is corrected, however far off (40 days slow here).
for (const [label, clientNow] of [['missing', undefined], ['garbage', 'yesterday'], ['farOff', new Date(Date.now() - 40 * 86400000).toISOString()]]) {
  const res = await j('POST', '/api/sync/push', { tables: {}, client_now: clientNow });
  out[`offset_${label}`] = res.body.clock_offset_ms;
}

// 6. An older app: no client_now, no stamp. Its edits go in, as before
// (it can't be judged), and each copy they replace is kept quietly.
{
  const id = await newRecipe('Rice');
  const copy = await pulled(id);
  await j('PUT', `/api/recipes/${id}`, { name: 'Rice (web)', ingredients: [], steps: [], notes: '' });
  const first = await push([phoneRow(copy, { name: 'Rice (old app)', updated_at: ago(30) }, { base: null })]);
  const second = await push([phoneRow(copy, { name: 'Rice (old app, newer)', updated_at: fmt(Date.now()) }, { base: null })]);
  out.oldApp = {
    first: first.body.tables.recipes[0], second: second.body.tables.recipes[0],
    server: sql('SELECT name FROM recipes WHERE id = ?', id).name,
    versions: (await versions(id)).map(v => `${v.reason}:${v.data.name}:${v.seen}`),
  };
  // A pantry item edited on the web after an older app's offline edit: the
  // older app's edit goes in, as it always has.
  const p = (await j('POST', '/api/pantry', { name: 'Oats', notes: 'web' })).body;
  db.prepare(`UPDATE pantry_items SET notes = 'web later', updated_at = ? WHERE id = ?`).run(fmt(Date.now()), p.id);
  await j('POST', '/api/sync/push', { tables: { pantry_items: [{ client_id: 4, server_id: p.id, name: 'Oats', in_stock: 1, notes: 'old app', updated_at: ago(5) }] } });
  out.oldAppPantry = sql('SELECT notes FROM pantry_items WHERE id = ?', p.id).notes;
}

// 7. Other tables, from apps that say their clock: newer edit wins, nothing kept.
{
  const vBefore = sql('SELECT COUNT(*) n FROM recipe_versions').n;
  const p = (await j('POST', '/api/pantry', { name: 'Flour', notes: 'web' })).body;
  backdate('pantry_items', p.id);
  db.prepare(`UPDATE pantry_items SET notes = 'web later', updated_at = ? WHERE id = ?`).run(fmt(Date.now()), p.id);
  stampFields('pantry_items', p.id, ['notes'], fmt(Date.now()));
  const res = await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { pantry_items: [{ client_id: 5, server_id: p.id, name: 'Flour', notes: 'phone older', in_stock: 1, updated_at: ago(5) }] } });
  out.pantry = { result: res.body.tables.pantry_items[0], notes: sql('SELECT notes FROM pantry_items WHERE id = ?', p.id).notes, newVersions: sql('SELECT COUNT(*) n FROM recipe_versions').n - vBefore };
}

// 8. Restore, undo, seen, the cap, and the cascade.
{
  const id = await newRecipe('Curry');
  const copy = await pulled(id);
  await j('PUT', `/api/recipes/${id}`, { name: 'Curry (web)', ingredients: [], steps: ['Web step'], notes: 'web' });
  await push([phoneRow(copy, { name: 'Curry (phone)', steps: JSON.stringify(['Phone step']), updated_at: ago(60) })], now());
  const [v] = await versions(id);
  const unseenBefore = (await versions(id)).filter(x => !x.seen).length;
  await j('POST', `/api/recipes/${id}/versions/seen`);
  const unseenAfter = (await versions(id)).filter(x => !x.seen).length;
  const stampBefore = sql('SELECT synced_at, updated_at FROM recipes WHERE id = ?', id);
  await sleep(1100);
  const restored = await j('POST', `/api/recipes/${id}/versions/${v.id}/restore`);
  const stampAfter = sql('SELECT synced_at, updated_at FROM recipes WHERE id = ?', id);
  const backup = (await versions(id)).find(x => x.reason === 'restore');
  const undone = await j('POST', `/api/recipes/${id}/versions/${backup.id}/restore`);
  const other = await newRecipe('Other');
  out.restore = {
    restored: { name: restored.body.name, steps: restored.body.steps },
    syncsOut: stampAfter.synced_at > stampBefore.synced_at && stampAfter.updated_at > stampBefore.updated_at,
    backup: { name: backup.data.name, seen: backup.seen },
    undone: { name: undone.body.name, steps: undone.body.steps },
    unseenBefore, unseenAfter,
    wrongRecipe: (await j('POST', `/api/recipes/${other}/versions/${v.id}/restore`)).status,
    missing: (await j('GET', '/api/recipes/99999/versions')).status,
  };
  const { saveRecipeVersion } = await import('../server/lib/recipe-versions.js');
  for (let i = 0; i < 25; i++) saveRecipeVersion(id, null, { name: `kept ${i}` }, { reason: i < 3 ? 'conflict' : 'replaced' });
  saveRecipeVersion(id, null, { name: 'newest' });
  const kept = await versions(id);
  out.cap = { count: kept.length, newest: kept[0].data.name, conflictsKept: kept.filter(x => /^kept [012]$/.test(x.data.name)).length };
  db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
  out.cascade = sql('SELECT COUNT(*) n FROM recipe_versions WHERE recipe_id = ?', id).n;
}

// 9. A delete on the phone leaves updated_at where it was: the delete is
// the edit, at the time it was made, and goes in after a web edit made
// before it.
{
  const p = (await j('POST', '/api/pantry', { name: 'Salt' })).body;
  backdate('pantry_items', p.id);
  db.prepare(`UPDATE pantry_items SET notes = 'web', updated_at = ? WHERE id = ?`).run(ago(60), p.id);
  stampFields('pantry_items', p.id, ['notes'], ago(60));
  const res = await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { pantry_items: [{ client_id: 6, server_id: p.id, name: 'Salt', in_stock: 1, updated_at: ago(120), deleted_at: fmt(Date.now()) }] } });
  out.phoneDelete = { result: res.body.tables.pantry_items[0], deleted: sql('SELECT deleted_at FROM pantry_items WHERE id = ?', p.id).deleted_at != null };
}

// 10. A cook logged or a share link made on the web after an offline phone
// edit isn't an edit of the recipe: the phone's edit goes in, nothing kept.
{
  const id = await newRecipe('Chili');
  const copy = await pulled(id);
  const edited = fmt(Date.now());
  await sleep(3100);
  const cooked = await j('POST', `/api/recipes/${id}/cooked`, { date: '2026-10-06' });
  await j('POST', `/api/recipes/${id}/share`);
  const res = await push([phoneRow(copy, { name: 'Chili (phone)', updated_at: edited, changed: ['name'] })], now());
  out.cookLogged = { cookStatus: cooked.status, result: res.body.tables.recipes[0], server: sql('SELECT name FROM recipes WHERE id = ?', id).name, versions: (await versions(id)).length };
}

// 11. Three devices. The web edits at 10:00; phone A's offline edit from
// 09:00 arrives and loses; phone B's offline edit from 10:30 arrives after
// and wins. A's lost push moves only the pull cursor, never the edit time.
{
  const id = await newRecipe('Tart');
  const copy = await pulled(id);
  await j('PUT', `/api/recipes/${id}`, { name: 'Tart (web)', ingredients: [], steps: [], notes: '' });
  const web = ago(60);
  db.prepare('UPDATE recipes SET updated_at = ? WHERE id = ?').run(web, id);
  stampFields('recipes', id, ['name', 'notes', 'ingredients', 'steps'], web);
  const a = await push([phoneRow(copy, { name: 'Tart (phone A)', updated_at: ago(120) })], now());
  const afterA = sql(`SELECT name, updated_at, json_extract(field_stamps, '$.name[1]') AS name_at FROM recipes WHERE id = ?`, id);
  const bAt = ago(30);
  const b = await push([phoneRow({ ...copy, client_id: 1 }, { name: 'Tart (phone B)', updated_at: bAt })], now());
  const afterB = sql('SELECT name, updated_at FROM recipes WHERE id = ?', id);
  const p = (await j('POST', '/api/pantry', { name: 'Eggs' })).body;
  backdate('pantry_items', p.id);
  db.prepare(`UPDATE pantry_items SET notes = 'web', updated_at = ? WHERE id = ?`).run(web, p.id);
  stampFields('pantry_items', p.id, ['notes'], web);
  const pa = await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { pantry_items: [{ client_id: 8, server_id: p.id, name: 'Eggs', in_stock: 1, notes: 'phone A', updated_at: ago(120) }] } });
  const pAfterA = sql('SELECT notes, updated_at FROM pantry_items WHERE id = ?', p.id);
  await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { pantry_items: [{ client_id: 9, server_id: p.id, name: 'Eggs', in_stock: 1, notes: 'phone B', updated_at: bAt }] } });
  out.threeDevices = {
    web, bAt,
    a: a.body.tables.recipes[0].kept, afterA, b: b.body.tables.recipes[0].kept ?? 'in', afterB,
    versions: (await versions(id)).map(v => v.data.name),
    pantryA: pa.body.tables.pantry_items[0].kept, pAfterA, pantryB: sql('SELECT notes, updated_at FROM pantry_items WHERE id = ?', p.id),
  };
}

// 12. What a push says it changed: only that goes in. A cook logged (no
// fields changed) after a web content edit, and a rating changed on the
// phone with the content changed on the web.
{
  const id = await newRecipe('Dal');
  const copy = await pulled(id);
  await j('PUT', `/api/recipes/${id}`, { name: 'Dal (web)', ingredients: [], steps: ['Web'], notes: 'web' });
  const res = await push([phoneRow(copy, { cook_count: 1, last_cooked_at: '2026-10-06', updated_at: fmt(Date.now()), changed: [] })], now());
  const older = await newRecipe('Dal 2');
  const copy2 = await pulled(older);
  await j('PUT', `/api/recipes/${older}`, { name: 'Dal 2 (web)', ingredients: [], steps: [], notes: '' });
  const meta = { rating: copy2.rating, favorite: copy2.favorite, visibility: copy2.visibility };
  const res2 = await push([phoneRow(copy2, { rating: 3, updated_at: ago(60), changed: ['rating'], base_meta: meta })], now());
  out.changedOnly = {
    result: res.body.tables.recipes[0].kept, row: sql('SELECT name, steps, cook_count FROM recipes WHERE id = ?', id), versions: (await versions(id)).length,
    ratingResult: res2.body.tables.recipes[0].kept, ratingRow: sql('SELECT name, rating FROM recipes WHERE id = ?', older), ratingVersions: (await versions(older)).length,
  };
}

// 13. The web app's saves say which copy they were made on (_sync), also
// when replayed after time with no connection.
{
  const page = async id => { const r = (await raw('GET', `/api/recipes/${id}`)).body; return { r, sync: { base_synced_at: r.synced_at } }; };
  const sent = (p, change, editedAt) => ({ ...p.r, ...change, _sync: { ...p.sync, changed: Object.keys(change), edited_at: editedAt, client_now: new Date().toISOString() } });
  // A save queued offline an hour ago meets a newer phone edit: the phone's stays.
  const a = await newRecipe('Cake');
  const pa = await page(a);
  const copyA = await pulled(a);
  await push([phoneRow(copyA, { name: 'Cake (phone)', updated_at: ago(10) })], now());
  const lost = await raw('PUT', `/api/recipes/${a}`, sent(pa, { name: 'Cake (web, offline)' }, new Date(Date.now() - 3600000).toISOString()));
  // A newer save replaces the phone's older one, which is kept.
  const b = await newRecipe('Pasta');
  const pb = await page(b);
  const copyB = await pulled(b);
  await push([phoneRow(copyB, { name: 'Pasta (phone)', updated_at: ago(10) })], now());
  const won = await raw('PUT', `/api/recipes/${b}`, sent(pb, { name: 'Pasta (web)' }, new Date().toISOString()));
  // A rating from a page opened before the phone's edit: the content stays the phone's.
  const c = await newRecipe('Salad');
  const pc = await page(c);
  const copyC = await pulled(c);
  await push([phoneRow(copyC, { name: 'Salad (phone)', updated_at: ago(1) })], now());
  const rated = await raw('PUT', `/api/recipes/${c}`, sent(pc, { rating: 5 }, new Date().toISOString()));
  // An editor's save leaves the favorite alone (it doesn't send one).
  const f = await newRecipe('Fav');
  const pf0 = await page(f);
  await raw('PUT', `/api/recipes/${f}`, sent(pf0, { favorite: true }, new Date().toISOString()));
  const pf = await page(f);
  const { favorite: _f, visibility: _v, ...editorBody } = pf.r;
  await raw('PUT', `/api/recipes/${f}`, { ...editorBody, name: 'Fav (edited)', _sync: { ...pf.sync, changed: recipeChangedFields({ ...editorBody, name: 'Fav (edited)' }, recipeBaseOf(pf.r)), edited_at: new Date().toISOString(), client_now: new Date().toISOString() } });
  // A save without it (older pages) writes as before.
  const d = await newRecipe('Toast');
  const plain = await j('PUT', `/api/recipes/${d}`, { name: 'Toast (plain)', ingredients: [], steps: [], _plain: true });
  out.webSave = {
    lost: { kept: lost.body.kept, answer: lost.body.name, server: sql('SELECT name FROM recipes WHERE id = ?', a).name, versions: (await versions(a)).map(v => v.data.name) },
    won: { kept: won.body.kept ?? null, server: sql('SELECT name FROM recipes WHERE id = ?', b).name, versions: (await versions(b)).map(v => v.data.name) },
    rated: { kept: rated.body.kept ?? null, row: sql('SELECT name, rating FROM recipes WHERE id = ?', c), versions: (await versions(c)).length },
    editorKeepsFavorite: sql('SELECT name, favorite FROM recipes WHERE id = ?', f),
    plain: plain.body.name, plainKept: (await versions(d)).map(v => `${v.reason}:${v.data.name}:${v.seen}`),
  };
}

// 14. Two saves made offline in the browser, collapsed into one by the
// queue: a rename then a rating, and a rename then another edit. Both edits
// stay (the combined save says the first copy and every changed field).
for (const [label, second] of [['renameThenRate', { rating: 4 }], ['renameThenEdit', { notes: 'second edit' }]]) {
  const id = await newRecipe('Pie');
  const kept = (await raw('GET', `/api/recipes/${id}`)).body;
  const ops = [];
  const at = new Date().toISOString();
  const body1 = { ...kept, name: 'Pie (renamed offline)', _base: recipeBaseOf(kept) };
  delete body1.synced_at;
  ops.push({ seq: 1, kind: 'recipe-update', key: `recipe:${id}`, id, method: 'PUT', path: `/api/recipes/${id}`, body: withSaveBase(body1, null), sync: recipeSaveBase(body1, kept, at) });
  const shown = answerWithOps(`/api/recipes/${id}`, kept, ops);
  const body2 = { ...shown, ...second, _base: recipeBaseOf(shown), ...(second.rating ? { _changed: ['rating'] } : {}) };
  ops.push({ seq: 2, kind: 'recipe-update', key: `recipe:${id}`, id, method: 'PUT', path: `/api/recipes/${id}`, body: withSaveBase(body2, null), sync: recipeSaveBase(body2, kept, at) });
  const sent = collapseOps(ops);
  for (const op of sent) await raw('PUT', op.path, withSaveBase(op.body, op.sync));
  out[label] = { sent: sent.length, changed: sent[0].sync.changed.sort(), row: sql('SELECT name, rating, notes FROM recipes WHERE id = ?', id), versions: (await versions(id)).length };
}

// 15. A favorite from the Recipes list, whose copy is older than an edit
// made on another device since: only the favorite changes.
{
  const id = await newRecipe('Stew');
  const listRow = (await raw('GET', '/api/recipes')).body.find(x => x.id === id);
  await sleep(1100);
  await j('PUT', `/api/recipes/${id}`, { ...(await raw('GET', `/api/recipes/${id}`)).body, name: 'Stew (other device)', notes: 'new notes' });
  const body = { ...listRow, favorite: true, _base: recipeBaseOf(listRow), _changed: ['favorite'] };
  await raw('PUT', `/api/recipes/${id}`, withSaveBase(body, recipeSaveBase(body, null, new Date().toISOString())));
  out.listFavorite = { row: sql('SELECT name, notes, favorite FROM recipes WHERE id = ?', id), versions: (await versions(id)).length };
}

// 16. An edit pending on a phone across the app update (no stamp, no
// fields): it goes in when newer, and what it replaces is kept, quietly.
// A forged stamp from the future counts as none.
for (const [label, base] of [['noStamp', null], ['forgedStamp', '9999-01-01 00:00:00.000']]) {
  const id = await newRecipe('Rice');
  const copy = await pulled(id);
  await sleep(1100);
  await j('PUT', `/api/recipes/${id}`, { ...(await raw('GET', `/api/recipes/${id}`)).body, name: 'Rice (web)', notes: 'web notes' });
  await sleep(1100);
  const res = await push([phoneRow(copy, { rating: 5, updated_at: fmt(Date.now()) }, { base })], now());
  out[label] = { result: res.body.tables.recipes[0].kept ?? 'in', row: sql('SELECT name, rating FROM recipes WHERE id = ?', id), versions: (await versions(id)).map(v => `${v.reason}:${v.data.name}`) };
}

// 17. A reorder isn't an edit: updated_at stays; only sort_order is new.
{
  const a = (await raw('POST', '/api/recipes/categories', { name: 'A' })).body;
  const b = (await raw('POST', '/api/recipes/categories', { name: 'B' })).body;
  db.prepare(`UPDATE recipe_categories SET updated_at = '2020-01-01 00:00:00' WHERE id IN (?, ?)`).run(a.id, b.id);
  const nameBefore = sql(`SELECT json_extract(field_stamps, '$.name') AS n FROM recipe_categories WHERE id = ?`, a.id).n;
  const status = (await raw('PUT', '/api/recipes/categories/order', { ids: [b.id, a.id] })).status;
  const row = sql(`SELECT updated_at, sort_order, json_extract(field_stamps, '$.sort_order[1]') AS sort_at, json_extract(field_stamps, '$.name') AS n FROM recipe_categories WHERE id = ?`, a.id);
  out.reorder = { status, updated_at: row.updated_at, sort_order: row.sort_order, sortStampedNow: row.sort_at > '2026-01-01', nameUntouched: row.n === nameBefore };
}

// 18. Other tables merge field by field too: an item checked off on a phone
// and renamed on the web since are both kept.
{
  const it = (await raw('POST', '/api/shopping', { name: 'Milk' })).body;
  backdate('shopping_list', it.id);
  const copy = (await j('GET', '/api/sync/pull?since=1970-01-01&synced_at=1')).body.tables.shopping_list.find(r => r.id === it.id);
  await sleep(1100);
  await raw('PUT', `/api/shopping/${it.id}`, { ...copy, name: 'Oat milk' });
  const res = await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { shopping_list: [{ ...copy, id: undefined, client_id: 3, server_id: it.id, server_synced_at: copy.synced_at, checked: 1, changed: ['checked'], updated_at: ago(0.5) }] } });
  out.shoppingFields = { result: res.body.tables.shopping_list[0].kept ?? 'in', row: sql('SELECT name, checked FROM shopping_list WHERE id = ?', it.id) };
}

// 19. updated_at never goes back: an older save's rating goes in, its
// content loses to a newer edit, and the row keeps the newer time.
{
  const id = await newRecipe('Pasta');
  const s0 = (await raw('GET', `/api/recipes/${id}`)).body;
  const old = new Date(Date.now() - 60_000).toISOString();
  await sleep(1100);
  await j('PUT', `/api/recipes/${id}`, { ...s0, notes: 'newer' });
  const before = sql('SELECT updated_at FROM recipes WHERE id = ?', id).updated_at;
  await raw('PUT', `/api/recipes/${id}`, { ...s0, notes: 'older', rating: 3, _sync: { base_synced_at: s0.synced_at, changed: ['notes', 'rating'], edited_at: old, client_now: new Date().toISOString() } });
  out.notBackwards = { before, after: sql('SELECT updated_at, notes, rating FROM recipes WHERE id = ?', id), versions: (await versions(id)).map(v => v.data.notes) };
}

// 20. The other way round, quietly: the server's copy wins one field, the
// edit's other field still goes in, and nothing is kept when nothing of
// the edit's content was lost.
{
  const id = await newRecipe('Bun');
  const copy = await pulled(id);
  await sleep(1100);
  await j('PUT', `/api/recipes/${id}`, { ...(await raw('GET', `/api/recipes/${id}`)).body, rating: 5 });
  const res = await push([phoneRow(copy, { rating: 2, notes: 'phone notes', updated_at: ago(30), changed: ['rating', 'notes'] })], now());
  out.symmetric = { result: res.body.tables.recipes[0].kept ?? 'in', row: sql('SELECT notes, rating FROM recipes WHERE id = ?', id), versions: (await versions(id)).length };
}

// 21. A device clock that jumped to the year 9999 after the edit: moved by
// that, the edit would be centuries old. It can't be judged, so it goes in
// as made now rather than being dropped, and for a recipe the copy it
// replaced is kept.
{
  const p = (await raw('POST', '/api/pantry', { name: 'Flour' })).body;
  const res = await j('POST', '/api/sync/push', { fk_ids: 'server', client_now: '9999-01-01T00:00:00Z', tables: { pantry_items: [{ client_id: 9, server_id: p.id, name: 'Flour (phone)', changed: ['name'], updated_at: ago(1) }] } });
  const id = await newRecipe('Loaf');
  const copy = await pulled(id);
  await j('PUT', `/api/recipes/${id}`, { ...(await raw('GET', `/api/recipes/${id}`)).body, name: 'Loaf (web)' });
  const r = await push([phoneRow(copy, { name: 'Loaf (phone)', updated_at: ago(1), changed: ['name'] })], { client_now: '9999-01-01T00:00:00Z' });
  out.absurdClock = {
    pantry: { result: res.body.tables.pantry_items[0].kept ?? 'in', name: sql('SELECT name, updated_at FROM pantry_items WHERE id = ?', p.id) },
    recipe: { result: r.body.tables.recipes[0].kept ?? 'in', name: sql('SELECT name FROM recipes WHERE id = ?', id).name, versions: (await versions(id)).map(v => `${v.reason}:${v.data.name}`) },
  };
}

// 22. Rows from before the field stamps, in every table: a field the phone
// changed offline goes in after the web changed another field of the row
// (or only touched the row), and nothing is kept. The stamps start from a
// baseline (db.js), never from the row's latest write.
{
  const r0 = await newRecipe('Base');
  const t = {
    recipes: { id: r0, phone: ['notes', 'phone notes'], web: ['name', 'Base (web)'] },
    pantry_items: { sql: `INSERT INTO pantry_items (name) VALUES ('Oil')`, phone: ['notes', 'phone'], web: ['name', 'Olive oil'] },
    shopping_list: { sql: `INSERT INTO shopping_list (name) VALUES ('Milk')`, phone: ['checked', 1], web: ['name', 'Oat milk'] },
    cook_diary: { sql: `INSERT INTO cook_diary (date) VALUES ('2026-10-01')`, phone: ['notes', 'phone'], web: ['servings', 3] },
    recipe_categories: { sql: `INSERT INTO recipe_categories (name, slug) VALUES ('Soups', 'soups-legacy')`, phone: ['color', '#ff0000'], web: ['name', 'Stews'] },
    pantry_categories: { sql: `INSERT INTO pantry_categories (name, slug) VALUES ('Dry', 'dry-legacy')`, phone: ['icon', 'grain'], web: ['name', 'Dry goods'] },
    custom_units: { sql: `INSERT INTO custom_units (abbr, full_name) VALUES ('pn', 'pinch')`, phone: ['sort_order', 5], web: ['full_name', 'small pinch'] },
    cookbooks: { sql: `INSERT INTO cookbooks (name, slug) VALUES ('Fall', 'fall-legacy')`, phone: ['description', 'phone'], web: ['name', 'Autumn'] },
    recipe_comments: { sql: `INSERT INTO recipe_comments (recipe_id, body) VALUES (${r0}, 'nice')`, phone: ['body', 'very nice'], web: null },
    ai_chat_history: { sql: `INSERT INTO ai_chat_history (role, content) VALUES ('user', 'hi')`, phone: ['content', 'hello'], web: null },
  };
  for (const [table, c] of Object.entries(t)) {
    c.id ??= db.prepare(c.sql).run().lastInsertRowid;
    db.prepare(`UPDATE ${table} SET created_at = datetime('now', '-2 days') WHERE id = ?`).run(c.id);
  }
  // As before the upgrade: no stamps. Then the server starts again (db.js
  // runs its migrations on this database) and fills in the baselines.
  for (const [table, c] of Object.entries(t)) db.prepare(`UPDATE ${table} SET field_stamps = NULL WHERE id = ?`).run(c.id);
  await import(`../server/db.js?again=${Date.now()}`);
  out.legacy = {};
  const pull = (await j('GET', '/api/sync/pull?since=1970-01-01&synced_at=1')).body.tables;
  await sleep(1100);
  const phoneAt = fmt(Date.now());
  await sleep(1100);
  for (const [table, c] of Object.entries(t)) {
    const baseline = sql(`SELECT json_extract(field_stamps, '$._base') AS b FROM ${table} WHERE id = ?`, c.id).b;
    // The web changes another field, or only touches the row.
    if (c.web) db.prepare(`UPDATE ${table} SET ${c.web[0]} = ?, updated_at = datetime('now') WHERE id = ?`).run(c.web[1], c.id);
    else db.prepare(`UPDATE ${table} SET updated_at = datetime('now') WHERE id = ?`).run(c.id);
    const copy = pull[table].find(r => r.id === c.id);
    const row = { ...copy, client_id: 70, server_id: c.id, server_synced_at: copy.synced_at, [c.phone[0]]: c.phone[1], changed: [c.phone[0]], updated_at: phoneAt, edit_clock: 'server' };
    delete row.id; delete row.synced_at;
    const res = await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { [table]: [row] } });
    const after = sql(`SELECT * FROM ${table} WHERE id = ?`, c.id);
    out.legacy[table] = {
      baseline: !!baseline,
      phone: String(after[c.phone[0]]) === String(c.phone[1]),
      web: c.web ? String(after[c.web[0]]) === String(c.web[1]) : true,
      result: res.body.tables[table][0]?.kept ?? 'in',
    };
  }
  out.legacy.versions = (await versions(r0)).length;
}

// 23. Fields that belong together merge as one: on one device 2 lb became
// 500 g; an older copy elsewhere changed the amount to 3 (still lb).
{
  const p = (await raw('POST', '/api/pantry', { name: 'Flour', quantity: 2, unit: 'lb', in_stock: 1 })).body;
  backdate('pantry_items', p.id);
  const copy = (await j('GET', '/api/sync/pull?since=1970-01-01&synced_at=1')).body.tables.pantry_items.find(r => r.id === p.id);
  const push1 = (row) => j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { pantry_items: [row] } });
  const base = { ...copy, client_id: 71, server_id: p.id, server_synced_at: copy.synced_at, edit_clock: 'server' };
  delete base.id; delete base.synced_at;
  await sleep(1100);
  const tA = fmt(Date.now()); await sleep(1100); const tB = fmt(Date.now());
  await push1({ ...base, quantity: 500, unit: 'g', updated_at: tA, changed: ['quantity', 'unit'] });
  await push1({ ...base, quantity: 3, updated_at: tB, changed: ['quantity'] });
  out.groups = sql('SELECT quantity, unit FROM pantry_items WHERE id = ?', p.id);
}

// 24. A reorder doesn't bring back an item deleted offline.
{
  const a = (await raw('POST', '/api/shopping', { name: 'Eggs' })).body;
  const b = (await raw('POST', '/api/shopping', { name: 'Bread' })).body;
  backdate('shopping_list', a.id);
  const copy = (await j('GET', '/api/sync/pull?since=1970-01-01&synced_at=1')).body.tables.shopping_list.find(r => r.id === a.id);
  await sleep(1100);
  const del = fmt(Date.now());
  await sleep(1100);
  await raw('POST', '/api/shopping/reorder', { items: [{ id: b.id, sort_order: 0 }, { id: a.id, sort_order: 1 }] });
  const row = { ...copy, client_id: 72, server_id: a.id, server_synced_at: copy.synced_at, deleted_at: del, updated_at: del, edit_clock: 'server', changed: ['deleted_at'] };
  delete row.id; delete row.synced_at;
  await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { shopping_list: [row] } });
  out.reorderDelete = sql('SELECT deleted_at IS NOT NULL AS deleted, sort_order FROM shopping_list WHERE id = ?', a.id);
}

// 25. Saves through the REST API with _sync, every table: a save made on an
// older copy changes only its field; a field changed elsewhere since stays.
{
  out.rest = {};
  const sync = (copy, changed) => ({ base_synced_at: copy.synced_at, changed, edited_at: new Date().toISOString(), client_now: new Date().toISOString() });
  const item = (await raw('POST', '/api/shopping', { name: 'Tea' })).body;
  const itemCopy = (await raw('GET', '/api/shopping')).body;
  const tea = (Array.isArray(itemCopy) ? itemCopy : itemCopy.items).find(x => x.id === item.id);
  await sleep(1100);
  await raw('PUT', `/api/shopping/${item.id}`, { name: 'Green tea' });
  await raw('PUT', `/api/shopping/${item.id}`, { ...tea, checked: true, _sync: sync(tea, ['checked']) });
  out.rest.shopping = sql('SELECT name, checked FROM shopping_list WHERE id = ?', item.id);
  const pi = (await raw('POST', '/api/pantry', { name: 'Rice', quantity: 1, unit: 'kg' })).body;
  const piCopy = (await raw('GET', `/api/pantry/${pi.id}`)).body;
  await sleep(1100);
  await raw('PUT', `/api/pantry/${pi.id}`, { name: 'Basmati rice' });
  await raw('PUT', `/api/pantry/${pi.id}`, { ...piCopy, notes: 'for pilaf', _sync: sync(piCopy, ['notes']) });
  out.rest.pantry = sql('SELECT name, notes, quantity, unit FROM pantry_items WHERE id = ?', pi.id);
  const toggled = await raw('PATCH', `/api/pantry/${pi.id}/stock`, { in_stock: false, _sync: { changed: ['in_stock'], edited_at: new Date().toISOString(), client_now: new Date().toISOString() } });
  out.rest.stock = { status: toggled.status, in_stock: sql('SELECT in_stock FROM pantry_items WHERE id = ?', pi.id).in_stock };
  const cat = (await raw('POST', '/api/recipes/categories', { name: 'Bakes' })).body;
  const catCopy = { ...sql('SELECT * FROM recipe_categories WHERE id = ?', cat.id) };
  await sleep(1100);
  await raw('PUT', `/api/recipes/categories/${cat.id}`, { name: 'Baking' });
  await raw('PUT', `/api/recipes/categories/${cat.id}`, { ...catCopy, color: '#00ff00', _sync: sync(catCopy, ['color']) });
  out.rest.category = sql('SELECT name, color FROM recipe_categories WHERE id = ?', cat.id);
}

// 26. Two devices' variant links, each fine alone: the phone makes V a
// variant of P (and P's nutrition source), the web made P a variant of Q
// since. The newer link stays and the tree stays valid.
{
  const mk = async n => { const x = (await raw('POST', '/api/pantry', { name: n })).body; backdate('pantry_items', x.id); return x; };
  const Q = await mk('Milk'), P = await mk('Whole milk'), V = await mk('Brand milk');
  const pulled = (await j('GET', '/api/sync/pull?since=1970-01-01&synced_at=1')).body.tables.pantry_items;
  const bp = pulled.find(r => r.id === P.id), bv = pulled.find(r => r.id === V.id);
  await sleep(1100); const tP = fmt(Date.now()); await sleep(2100);
  const web = await raw('PUT', `/api/pantry/${P.id}`, { generic_parent_id: Q.id });
  const rowOf = (copy, cid, sid, ch) => { const r = { ...copy, client_id: cid, server_id: sid, server_synced_at: copy.synced_at, updated_at: tP, edit_clock: 'server', ...ch, changed: Object.keys(ch) }; delete r.id; delete r.synced_at; return r; };
  await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { pantry_items: [
    rowOf(bv, 81, V.id, { generic_parent_id: P.id }),
    rowOf(bp, 82, P.id, { nutrition_source_variant_id: V.id }),
  ] } });
  const rows = Object.fromEntries([Q, P, V].map(x => [x.name, sql('SELECT generic_parent_id AS parent, nutrition_source_variant_id AS source FROM pantry_items WHERE id = ?', x.id)]));
  // Every rule PUT /api/pantry/:id holds.
  const all = db.prepare('SELECT id, generic_parent_id, nutrition_source_variant_id FROM pantry_items WHERE deleted_at IS NULL').all();
  const byId = new Map(all.map(r => [r.id, r]));
  const broken = all.filter(r => (r.generic_parent_id != null && (byId.get(r.generic_parent_id)?.generic_parent_id != null || all.some(k => k.generic_parent_id === r.id)))
    || (r.nutrition_source_variant_id != null && (r.generic_parent_id != null || byId.get(r.nutrition_source_variant_id)?.generic_parent_id !== r.id)));
  out.variants = { webStatus: web.status, rows, ids: { Q: Q.id, P: P.id, V: V.id }, broken: broken.length, stamps: [P.id, V.id].map(i => sql(`SELECT json_extract(field_stamps, '$.generic_parent_id') AS g FROM pantry_items WHERE id = ?`, i).g), tP };
}

// 27. The managers' lists (recipe and pantry categories, custom units,
// cookbooks) carry the server's stamp, so a save from one says which copy
// it was made on, as every other save does. The manager's page (or the
// offline copy it came from) was read before another device's change;
// its save changes only its own field, and the other change stays.
{
  out.managers = {};
  const listRows = (path, body) => (path === '/api/units' ? body.custom : body);
  const cases = [
    { table: 'recipe_categories', list: '/api/recipes/categories', make: () => raw('POST', '/api/recipes/categories', { name: 'Sides' }),
      put: id => `/api/recipes/categories/${id}`, other: r => ({ name: 'Side dishes', color: r.color }), mine: r => ({ name: r.name, color: '#ff8800' }), check: 'SELECT name, color FROM recipe_categories WHERE id = ?' },
    { table: 'pantry_categories', list: '/api/pantry/categories', make: () => raw('POST', '/api/pantry/categories', { name: 'Tins' }),
      put: id => `/api/pantry/categories/${id}`, other: r => ({ name: 'Canned goods', icon: r.icon, default_aisle: r.default_aisle }), mine: r => ({ name: r.name, icon: r.icon, default_aisle: 'Aisle 4' }), check: 'SELECT name, default_aisle FROM pantry_categories WHERE id = ?' },
    { table: 'custom_units', list: '/api/units', make: () => raw('POST', '/api/units', { abbr: 'pinch', full_name: 'pinch', category: 'volume' }),
      put: id => `/api/units/${id}`, other: null, mine: r => ({ abbr: r.abbr, full_name: 'small pinch', category: r.category }), check: 'SELECT abbr, full_name, sort_order FROM custom_units WHERE id = ?' },
    { table: 'cookbooks', list: '/api/cookbooks', make: () => raw('POST', '/api/cookbooks', { name: 'Weeknights' }),
      put: id => `/api/cookbooks/${id}`, other: r => ({ name: 'Weeknight dinners', description: r.description, cover_image_url: r.cover_image_url }), mine: r => ({ name: r.name, description: 'Fast ones', cover_image_url: r.cover_image_url }), check: 'SELECT name, description FROM cookbooks WHERE id = ?' },
  ];
  for (const c of cases) {
    const made = (await c.make()).body;
    backdate(c.table, made.id);
    // The manager's page: the list as read (and as the offline copy holds it).
    const listed = (await raw('GET', c.list)).body;
    const page = listRows(c.list, listed).find(r => r.id === made.id);
    const shown = stampedRows(listed).some(r => r.id === made.id) && readTable(c.list) === c.table;
    await sleep(1100);
    // Another device changes something else.
    if (c.other) {
      const fresh = listRows(c.list, (await raw('GET', c.list)).body).find(r => r.id === made.id);
      const body = { ...c.other(fresh), _base: fresh };
      await raw('PUT', c.put(made.id), withSaveBase(body, saveBase('PUT', c.put(made.id), body, null, new Date().toISOString())));
    } else {
      // A phone moves the unit in its list.
      const copy = (await j('GET', '/api/sync/pull?since=1970-01-01&synced_at=1')).body.tables.custom_units.find(r => r.id === made.id);
      const row = { ...copy, client_id: 90, server_id: made.id, server_synced_at: copy.synced_at, sort_order: 7, updated_at: fmt(Date.now()), edit_clock: 'server', changed: ['sort_order'] };
      delete row.id; delete row.synced_at;
      await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { custom_units: [row] } });
    }
    await sleep(1100);
    // The manager saves on the copy it read.
    const body = { ...c.mine(page), _base: page };
    const sync = saveBase('PUT', c.put(made.id), body, null, new Date().toISOString());
    const res = await raw('PUT', c.put(made.id), withSaveBase(body, sync));
    out.managers[c.table] = {
      listed: typeof page.synced_at === 'string', shown,
      base: sync?.base_synced_at === page.synced_at, changed: sync?.changed,
      answered: typeof res.body?.synced_at === 'string' && res.body.synced_at > page.synced_at,
      row: sql(c.check, made.id),
    };
  }
}

// 28. A new row sent twice (two syncs at once, a retry, a lost answer) is
// made once; a name the account has already is that row; the same lost
// copy kept twice is one version; an upload sent twice makes one row.
{
  out.once = {};
  const row = (extra = {}) => ({ client_id: 5, server_id: null, client_key: 'phone-1:recipes:5', name: 'Kill Test Recipe', ingredients: '[]', steps: '[]', tags: '[]', tools: '[]', nutrition: '{}', visibility: 'private', cook_count: 0, favorite: 0, servings: 2, updated_at: fmt(Date.now()), edit_clock: 'server', ...extra });
  const a = await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { recipes: [row()] } });
  const b = await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { recipes: [row({ notes: 'second send, edited' })] } });
  if (!Array.isArray(a.body?.tables?.recipes)) throw new Error('push: ' + JSON.stringify(a.body).slice(0, 300));
  out.once.ids = [a.body.tables.recipes[0].server_id, b.body.tables.recipes[0].server_id];
  out.once.rows = db.prepare(`SELECT notes FROM recipes WHERE name = 'Kill Test Recipe'`).all().map(r => r.notes);
  const other = await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { recipes: [row({ client_id: 6, client_key: 'phone-1:recipes:6', name: 'Another One' })] } });
  out.once.otherKey = other.body.tables.recipes[0].server_id !== a.body.tables.recipes[0].server_id;
  // The pull hands the key back, so the phone knows the row as its own.
  const pulledRow = (await j('GET', '/api/sync/pull?since=1970-01-01&synced_at=1')).body.tables.recipes.find(r => r.name === 'Kill Test Recipe');
  out.once.pulledKey = pulledRow?.client_key ?? null;
  const oldPull = (await j('GET', '/api/sync/pull?since=1970-01-01')).body.tables.recipes.find(r => r.name === 'Kill Test Recipe');
  out.once.oldAppKey = oldPull && 'client_key' in oldPull;
  // A category the account has (made on the web) pushed as new: the same one.
  const webCat = (await raw('POST', '/api/recipes/categories', { name: 'Soups' })).body;
  const catPush = await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { recipe_categories: [{ client_id: 9, server_id: null, name: 'Soups', slug: webCat.slug, color: '#123456', sort_order: 0, updated_at: fmt(Date.now()), edit_clock: 'server' }] } });
  out.once.category = { error: catPush.body.tables.recipe_categories.error || null, same: catPush.body.tables.recipe_categories[0]?.server_id === webCat.id, count: sql(`SELECT COUNT(*) AS n FROM recipe_categories WHERE slug = ?`, webCat.slug).n };
  // The same conflicting phone edit pushed twice: one version.
  const rid = await newRecipe('Twice Soup');
  const copy = await pulled(rid);
  await sleep(1100);
  await j('PUT', `/api/recipes/${rid}`, { name: 'Twice Soup (web)' });
  const older = phoneRow(copy, { name: 'Twice Soup (phone)', updated_at: ago(0.5) });
  await push([older], now());
  await push([older], now());
  out.once.versions = (await versions(rid)).map(v => v.data.name);
  // An upload sent twice with its keys: one row each.
  for (let n = 0; n < 2; n++) await raw('POST', '/api/recipes', { name: 'Uploaded Twice', ingredients: [], steps: [], client_key: 'phone-1:recipes:77' });
  for (let n = 0; n < 2; n++) await raw('POST', '/api/pantry', { name: 'Pantry Twice', client_key: 'phone-1:pantry_items:7' });
  for (let n = 0; n < 2; n++) await raw('POST', '/api/shopping', { name: 'Shopping Twice', client_key: 'phone-1:shopping_list:7' });
  out.once.uploads = ['recipes|Uploaded Twice', 'pantry_items|Pantry Twice', 'shopping_list|Shopping Twice'].map(x => { const [t, nm] = x.split('|'); return sql(`SELECT COUNT(*) AS n FROM ${t} WHERE name = ?`, nm).n; });
}

// 29. The same copy kept again moves to newest, with the new reason: a
// restore's undo point is never left marked 'replaced', nor trimmed first.
{
  const { saveRecipeVersion } = await import('../server/lib/recipe-versions.js');
  const rid = await newRecipe('Kept Twice');
  const base = sql('SELECT * FROM recipes WHERE id = ?', rid);
  const copy = n => ({ ...base, name: n });
  saveRecipeVersion(rid, base.user_id, copy('Copy V'), { reason: 'replaced' });
  for (let n = 0; n < 3; n++) saveRecipeVersion(rid, base.user_id, copy(`Other ${n}`), { reason: 'conflict' });
  saveRecipeVersion(rid, base.user_id, copy('Copy V'), { reason: 'restore' });
  out.keptAgain = db.prepare('SELECT data, reason FROM recipe_versions WHERE recipe_id = ? ORDER BY id DESC').all(rid)
    .map(v => `${JSON.parse(v.data).name}:${v.reason}`);
}

// 30. A photo taken with no connection comes embedded in its row (a data:
// URL): the push stores it as a file, and the startup repair does the same
// for photos stored embedded before.
{
  const fs = await import('node:fs');
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const files = () => { try { return fs.readdirSync(process.env.UPLOADS_PATH).length; } catch { return 0; } };
  out.photos = {};
  const base = { ingredients: '[]', steps: '[]', tags: '[]', tools: '[]', nutrition: '{}', visibility: 'private', cook_count: 0, favorite: 0, servings: 2, edit_clock: 'server' };
  // A new recipe with its photo.
  const made = await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { recipes: [{ ...base, client_id: 31, server_id: null, name: 'Photo Soup', img_url: PNG, updated_at: fmt(Date.now()) }] } });
  const rid = made.body.tables.recipes[0].server_id;
  out.photos.made = sql('SELECT img_url FROM recipes WHERE id = ?', rid).img_url;
  backdate('recipes', rid);
  // The photo changed on the phone, on the copy the server has: one file, no version, nothing to pull back.
  const copy = await pulled(rid);
  await sleep(1100);
  const before = files();
  const edit = await push([phoneRow(copy, { img_url: PNG, updated_at: fmt(Date.now()), changed: ['img_url'], edit_clock: 'server' })], now());
  out.photos.edited = sql('SELECT img_url FROM recipes WHERE id = ?', rid).img_url;
  out.photos.editResult = edit.body.tables.recipes[0].kept ?? null;
  out.photos.filesAdded = files() - before;
  out.photos.versions = (await versions(rid)).length;
  // Another field changed, with the photo still embedded on the phone: no file, the photo stays.
  const copy2 = await pulled(rid);
  await sleep(1100);
  const before2 = files();
  await push([phoneRow(copy2, { name: 'Photo Soup (renamed)', img_url: PNG, updated_at: fmt(Date.now()), changed: ['name'], edit_clock: 'server' })], now());
  out.photos.otherField = { files: files() - before2, img: sql('SELECT img_url, name FROM recipes WHERE id = ?', rid) };
  // A diary entry's photos list, and a cookbook cover.
  const cook = await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { cook_diary: [{ client_id: 32, server_id: null, recipe_id: rid, date: '2026-10-09', kind: 'cooked', photo_url: PNG, photos: JSON.stringify([PNG, '/uploads/kept.jpg']), updated_at: fmt(Date.now()), edit_clock: 'server' }] } });
  out.photos.cook = sql('SELECT photo_url, photos FROM cook_diary WHERE id = ?', cook.body.tables.cook_diary[0].server_id);
  const cb = await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { cookbooks: [{ client_id: 33, server_id: null, name: 'Covers', slug: 'covers', cover_image_url: PNG, is_smart: 0, sort_order: 0, updated_at: fmt(Date.now()), edit_clock: 'server' }] } });
  out.photos.cover = sql('SELECT cover_image_url FROM cookbooks WHERE id = ?', cb.body.tables.cookbooks[0].server_id).cover_image_url;
  const pi = await j('POST', '/api/sync/push', { fk_ids: 'server', ...now(), tables: { pantry_items: [{ client_id: 34, server_id: null, name: 'Photo Flour', in_stock: 1, img_url: PNG, updated_at: fmt(Date.now()), edit_clock: 'server' }] } });
  out.photos.pantry = sql('SELECT img_url FROM pantry_items WHERE id = ?', pi.body.tables.pantry_items[0].server_id).img_url;

  // The startup repair.
  const { repairInlinePhotos } = await import('../server/lib/inline-photos.js');
  const ins = (name, img, extra = '') => db.prepare(`INSERT INTO recipes (user_id, name, img_url, ingredients, steps, tags, tools, nutrition${extra ? ', deleted_at' : ''}) VALUES (?, ?, ?, '[]', '[]', '[]', '[]', '{}'${extra ? ', ?' : ''})`).run(...[null, name, img, ...(extra ? [extra] : [])]).lastInsertRowid;
  const owner = sql('SELECT user_id FROM recipes WHERE id = ?', rid).user_id;
  const insOwned = (name, img, deleted = null) => { const id = ins(name, img, deleted || ''); db.prepare('UPDATE recipes SET user_id = ? WHERE id = ?').run(owner, id); return id; };
  const stored = insOwned('Stored Inline', PNG);
  db.prepare(`UPDATE recipes SET updated_at = '2026-01-02 03:04:05' WHERE id = ?`).run(stored);
  const gone = insOwned('Deleted Inline', PNG, '2026-01-01 00:00:00');
  const editedMeanwhile = insOwned('Edited Meanwhile', PNG);
  const broken = insOwned('Broken Inline', 'data:image/png;base64,bm90IGFuIGltYWdl');
  const external = insOwned('External', 'https://example.com/a.jpg');
  const stamps = id => sql('SELECT updated_at, field_stamps, synced_at FROM recipes WHERE id = ?', id);
  const s0 = stamps(stored);
  const vBefore = db.prepare('SELECT COUNT(*) AS n FROM recipe_versions').get().n;
  await sleep(20);
  // An edit of one row lands while the repair is running.
  const run1 = repairInlinePhotos();
  db.prepare('UPDATE recipes SET img_url = ? WHERE id = ?').run('/uploads/edited-meanwhile.jpg', editedMeanwhile);
  const r1 = await run1;
  const s1 = stamps(stored);
  out.photos.repair = {
    result: r1,
    stored: sql('SELECT img_url FROM recipes WHERE id = ?', stored).img_url,
    updatedKept: s1.updated_at === s0.updated_at,
    stampsKept: s1.field_stamps === s0.field_stamps,
    syncMoved: s1.synced_at > s0.synced_at,
    deleted: sql('SELECT img_url FROM recipes WHERE id = ?', gone).img_url.slice(0, 5),
    meanwhile: sql('SELECT img_url FROM recipes WHERE id = ?', editedMeanwhile).img_url,
    broken: sql('SELECT img_url FROM recipes WHERE id = ?', broken).img_url.slice(0, 5),
    external: sql('SELECT img_url FROM recipes WHERE id = ?', external).img_url,
    versions: db.prepare('SELECT COUNT(*) AS n FROM recipe_versions').get().n - vBefore,
  };
  out.photos.retry = await repairInlinePhotos();
}

server.close();
process.stdout.write('\n@@' + JSON.stringify(out));
process.exit(0);
