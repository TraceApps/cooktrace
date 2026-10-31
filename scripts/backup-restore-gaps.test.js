/**
 * What a full backup restore brings back, and what devices learn of it,
 * against the real server on a scratch database:
 *
 * - Devices drop what the restore took away: recipes, pantry items, cooks,
 *   shopping items, cookbooks, comments and recipe versions made after the
 *   backup are sent as deleted, and categories and units as gone.
 * - A table the backup holds no rows of is emptied too (a kitchen or an
 *   invite made after the backup doesn't stay).
 * - API tokens and webhooks survive the restore.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { const D = serverRequire('better-sqlite3'); new D(':memory:').close(); ready = true; } catch { /* server packages missing: skip */ }
const skip = !ready && 'server packages missing';

const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const PW = 'Str0ng-Pass-77!x';
const JWT_SECRET = 'restore-gaps-test-0123456789abcdef01234567';
const serverDir = fileURLToPath(new URL('../server/', import.meta.url));

function server() {
  const s = { tok: {}, ids: {} };
  s.dir = mkdtempSync(join(tmpdir(), 'ct-restore-gaps-'));
  s.env = () => ({ ...cleanEnv(), DB_PATH: join(s.dir, 'ct.db'), UPLOADS_PATH: join(s.dir, 'uploads'), BACKUPS_PATH: join(s.dir, 'backups'), JWT_SECRET, INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' });
  s.boot = async () => {
    const port = await freePort();
    s.base = `http://127.0.0.1:${port}`;
    s.proc = spawn(process.execPath, ['index.js'], { cwd: serverDir, env: { ...s.env(), PORT: String(port) }, stdio: ['ignore', 'ignore', process.env.SRV_LOG ? 'inherit' : 'ignore'] });
    for (let i = 0; i < 300; i++) {
      try { if ((await fetch(s.base + '/api/auth/status')).ok) return; } catch { /* not up yet */ }
      await sleep(100);
    }
    throw new Error('server did not start');
  };
  s.stop = async () => { const p = s.proc; s.proc = null; if (p && p.exitCode == null && p.signalCode == null) await new Promise((r) => { p.once('exit', r); p.kill(); }); };
  s.call = async (who, method, path, body) => {
    const h = { 'Content-Type': 'application/json' };
    if (who) h.Authorization = `Bearer ${s.tok[who]}`;
    const r = await fetch(s.base + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  };
  s.ok = async (...a) => { const r = await s.call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r.data; };
  s.db = () => new (serverRequire('better-sqlite3'))(join(s.dir, 'ct.db'));
  s.sql = (fn) => { const d = s.db(); try { return fn(d); } finally { d.close(); } };
  s.sign = (id, username, role) => serverRequire('jsonwebtoken').sign({ id, username, role }, JWT_SECRET, { expiresIn: '1h' });
  s.setup = async () => {
    await s.boot();
    await s.ok(null, 'POST', '/api/auth/register', { username: 'admin', password: PW, full_name: 'Ada Admin' });
    s.tok.admin = (await s.ok(null, 'POST', '/api/auth/login', { username: 'admin', password: PW })).token;
    const cook = (await s.ok('admin', 'POST', '/api/auth/register', { username: 'cook', password: PW, full_name: 'Cass Cook', role: 'user' })).user;
    s.ids.cook = cook.id;
    s.tok.cook = s.sign(cook.id, 'cook', cook.role);
  };
  s.backup = async () => (await s.ok('admin', 'POST', '/api/full-backup')).filename;
  s.restore = async (filename) => s.ok('admin', 'POST', `/api/full-backup/${encodeURIComponent(filename)}/restore`);
  // A backup file, its database.json changed by `edit`, restored by upload.
  s.uploadRestore = async (zipPath, edit = () => {}) => {
    const AdmZip = serverRequire('adm-zip');
    const zip = new AdmZip(zipPath);
    const data = JSON.parse(zip.readAsText('database.json'));
    edit(data);
    zip.updateFile('database.json', Buffer.from(JSON.stringify(data)));
    const form = new FormData();
    form.append('backup', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'backup.zip');
    const r = await fetch(s.base + '/api/full-backup/upload-restore', { method: 'POST', headers: { Authorization: `Bearer ${s.tok.admin}` }, body: form });
    assert.ok(r.ok, await r.text());
  };
  s.close = async () => { await s.stop(); rmSync(s.dir, { recursive: true, force: true }); };
  return s;
}


let S;
test.before(async () => {
  if (!ready) return;
  S = server();
  await S.setup();
});
test.after(async () => { await S?.close(); });

const pull = async (since) => S.ok('cook', 'GET', `/api/sync/pull?schema=2&synced_at=1${since ? `&since=${encodeURIComponent(since)}` : ''}`);

test('devices drop every row the restore took away', { skip }, async () => {
  const u = S.ids.cook;
  const kept = S.sql((d) => d.prepare(`INSERT INTO recipes (user_id, name) VALUES (?, 'Kept Soup')`).run(u).lastInsertRowid);
  const filename = await S.backup();
  // Made after the backup, one of each.
  const made = S.sql((d) => {
    const ins = (sql, ...a) => d.prepare(sql).run(u, ...a).lastInsertRowid;
    const recipe = ins(`INSERT INTO recipes (user_id, name, share_token) VALUES (?, 'After Stew', 'tok-after')`);
    const pantry = ins(`INSERT INTO pantry_items (user_id, name) VALUES (?, 'After Flour')`);
    return {
      recipes: recipe,
      pantry_items: pantry,
      cook_diary: ins(`INSERT INTO cook_diary (user_id, recipe_id, date) VALUES (?, ?, '2026-05-01')`, recipe),
      shopping_list: ins(`INSERT INTO shopping_list (user_id, name, pantry_id, recipe_id) VALUES (?, 'After Eggs', ?, ?)`, pantry, recipe),
      cookbooks: ins(`INSERT INTO cookbooks (user_id, name, slug) VALUES (?, 'After Book', 'after-book')`),
      recipe_comments: ins(`INSERT INTO recipe_comments (user_id, recipe_id, body) VALUES (?, ?, 'tasty')`, kept),
      recipe_revisions: ins(`INSERT INTO recipe_revisions (user_id, recipe_id, rev, data) VALUES (?, ?, 'r-after', '{}')`, kept),
    };
  });
  const gone = S.sql((d) => ({
    recipe_categories: d.prepare(`INSERT INTO recipe_categories (user_id, name, slug) VALUES (?, 'After Cat', 'after-cat')`).run(u).lastInsertRowid,
    pantry_categories: d.prepare(`INSERT INTO pantry_categories (user_id, name, slug) VALUES (?, 'After Aisle', 'after-aisle')`).run(u).lastInsertRowid,
    custom_units: d.prepare(`INSERT INTO custom_units (user_id, abbr, full_name) VALUES (?, 'pinch2', 'big pinch')`).run(u).lastInsertRowid,
  }));
  const cursor = (await pull()).now;
  await sleep(50);
  await S.restore(filename);
  const p = await pull(cursor);
  for (const [t, id] of Object.entries(made)) {
    const rows = (p.tables[t] || []).filter((r) => r.id === id);
    assert.ok(rows.length && rows.every((r) => r.deleted_at), `${t}: the row made after the backup is sent as deleted`);
    assert.equal(S.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE id = ? AND deleted_at IS NULL`).get(id).n), 0, `${t}: not alive on the server`);
  }
  for (const [t, id] of Object.entries(gone)) {
    assert.ok((p.tables.deletions?.[t] || []).includes(id), `${t}: the row made after the backup is sent as gone`);
  }
  assert.ok(p.tables.recipes.some((r) => r.id === kept && !r.deleted_at), 'the kept recipe is sent again');
  // The share link of a recipe the restore took away no longer opens it.
  assert.equal(S.sql((d) => d.prepare(`SELECT share_token FROM recipes WHERE id = ?`).get(made.recipes).share_token), null);
});

test('a deletion devices had yet to hear of before the restore still reaches them', { skip }, async () => {
  const u = S.ids.cook;
  const cursor = (await pull()).now;
  await sleep(50);
  const cat = S.sql((d) => d.prepare(`INSERT INTO recipe_categories (user_id, name, slug) VALUES (?, 'Short Lived', 'short-lived')`).run(u).lastInsertRowid);
  const filename = await S.backup();
  S.sql((d) => d.prepare('DELETE FROM recipe_categories WHERE id = ?').run(cat));
  await S.restore(filename);
  // The backup holds the category: it is back, not gone.
  assert.ok(!((await pull(cursor)).tables.deletions?.recipe_categories || []).includes(cat));
  // Deleted again, then the same backup without it restored.
  S.sql((d) => d.prepare('DELETE FROM recipe_categories WHERE id = ?').run(cat));
  await S.uploadRestore(join(S.dir, 'backups', filename), (data) => { data.recipe_categories = data.recipe_categories.filter((c) => c.id !== cat); });
  S.tok.cook = S.sign(u, 'cook', 'user');
  assert.ok(((await pull(cursor)).tables.deletions?.recipe_categories || []).includes(cat), 'the delete reaches a device that had the category');
});

test('a recipe made after the backup and edited offline before the restore stays deleted', { skip }, async () => {
  const filename = await S.backup();
  const id = S.sql((d) => d.prepare(`INSERT INTO recipes (user_id, name) VALUES (?, 'Offline Pie')`).run(S.ids.cook).lastInsertRowid);
  const row = (await pull()).tables.recipes.find((r) => r.id === id);
  const editedAt = new Date().toISOString().replace('T', ' ').replace('Z', '');
  await sleep(50);
  await S.restore(filename);
  // The phone pushes its edit made before the restore, from its copy.
  await S.ok('cook', 'POST', '/api/sync/push', { tables: { recipes: [{ ...row, server_id: id, client_id: 99, name: 'Offline Pie 2', updated_at: editedAt }] }, client_now: new Date().toISOString() });
  assert.ok(S.sql((d) => d.prepare('SELECT deleted_at FROM recipes WHERE id = ?').get(id)?.deleted_at), 'the restore is newer than the edit');
  assert.equal(S.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM recipes WHERE name LIKE 'Offline Pie%' AND deleted_at IS NULL`).get().n), 0);
});

test('a cookbook made after the backup under a name a restored one has now still leaves devices', { skip }, async () => {
  const u = S.ids.cook;
  const old = S.sql((d) => d.prepare(`INSERT INTO cookbooks (user_id, name, slug) VALUES (?, 'Weeknights', 'weeknights')`).run(u).lastInsertRowid);
  const filename = await S.backup();
  // Renamed after the backup, and a new one takes the old name.
  const made = S.sql((d) => {
    d.prepare(`UPDATE cookbooks SET name = 'Old Weeknights', slug = 'old-weeknights' WHERE id = ?`).run(old);
    return d.prepare(`INSERT INTO cookbooks (user_id, name, slug) VALUES (?, 'Weeknights', 'weeknights')`).run(u).lastInsertRowid;
  });
  const cursor = (await pull()).now;
  await sleep(50);
  await S.restore(filename);
  const rows = (await pull(cursor)).tables.cookbooks.filter((c) => c.id === made);
  assert.ok(rows.length && rows.every((c) => c.deleted_at), 'sent as deleted');
  assert.equal(S.sql((d) => d.prepare('SELECT slug FROM cookbooks WHERE id = ?').get(old).slug), 'weeknights', 'the restored one keeps its name');
});

test('a table the backup holds nothing of is emptied by the restore', { skip }, async () => {
  const filename = await S.backup();
  S.sql((d) => {
    d.prepare(`INSERT INTO kitchens (name, slug, owner_user_id) VALUES ('After Kitchen', 'after-kitchen', ?)`).run(S.ids.cook);
    d.prepare(`INSERT INTO invite_tokens (token, email, role, created_by, expires_at) VALUES ('inv-after', 'x@example.com', 'user', ?, datetime('now', '+7 days'))`).run(S.ids.cook);
  });
  await S.restore(filename);
  assert.equal(S.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM kitchens WHERE slug = 'after-kitchen'`).get().n), 0);
  assert.equal(S.sql((d) => d.prepare(`SELECT COUNT(*) AS n FROM invite_tokens WHERE token = 'inv-after'`).get().n), 0);
});

test('API tokens and webhooks survive a restore', { skip }, async () => {
  const made = await S.ok('admin', 'POST', '/api/admin/api-tokens', { name: 'NutriTrace', scopes: ['read:recipes'], password: PW });
  assert.ok(made.raw);
  S.sql((d) => d.prepare(`INSERT INTO webhooks (user_id, url, secret_encrypted, events, enabled) VALUES (?, 'https://example.com/hook', 'x', '["recipe.created"]', 1)`).run(S.ids.cook));
  const q = { tokens: 'SELECT id, user_id, name, token_hash, scopes FROM api_tokens ORDER BY id', hooks: 'SELECT id, user_id, url, secret_encrypted, events, enabled FROM webhooks ORDER BY id' };
  const read = () => S.sql((d) => ({ tokens: d.prepare(q.tokens).all(), hooks: d.prepare(q.hooks).all() }));
  const before = read();
  const filename = await S.backup();
  await S.restore(filename);
  assert.deepEqual(read(), before);
  const r = await fetch(S.base + '/api/v1/recipes', { headers: { Authorization: `Bearer ${made.raw}` } });
  assert.equal(r.status, 200);
});

test('a backup from before these restores, every row of it', { skip }, async () => {
  // A 1.4 backup: no tokens or webhooks, and cooks without the columns
  // added since (any_day, a NOT NULL column, and recipe_rev).
  const u = S.ids.cook;
  S.sql((d) => {
    const r = d.prepare(`INSERT INTO recipes (user_id, name) VALUES (?, 'Old Chili')`).run(u).lastInsertRowid;
    d.prepare(`INSERT INTO cook_diary (user_id, recipe_id, date) VALUES (?, ?, '2026-02-01')`).run(u, r);
    d.prepare(`INSERT INTO shopping_list (user_id, name) VALUES (?, 'Old Beans')`).run(u);
  });
  const count = () => S.sql((d) => ['recipes', 'cook_diary', 'shopping_list'].map((t) => d.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE deleted_at IS NULL`).get().n));
  const before = count();
  const filename = await S.backup();
  await S.uploadRestore(join(S.dir, 'backups', filename), (data) => {
    delete data.api_tokens; delete data.webhooks;
    for (const c of data.cook_diary) { delete c.any_day; delete c.recipe_rev; }
    for (const i of data.shopping_list) { delete i.sources; delete i.notes; }
  });
  assert.deepEqual(count(), before, 'every cook and shopping item comes back');
  assert.equal(S.sql((d) => d.prepare(`SELECT any_day FROM cook_diary WHERE date = '2026-02-01'`).get()?.any_day), 0);
  assert.equal(S.sql((d) => d.prepare('SELECT COUNT(*) AS n FROM api_tokens').get().n), 0);
});

// Every table is in the backup, so one added later can't go missing from a
// restore without this failing (columns come back by the table's own
// list, _bulkRestoreSchemaDriven). Short-lived or server-kept ones aren't.
const NOT_BACKED_UP = new Set(['oauth_state', 'sync_deletions', 'password_reset_tokens', 'notification_log', 'create_keys', 'user_email_changes', 'oidc_link_grants']);
test('every table is backed up', { skip }, async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/routes/full-backup.js', import.meta.url), 'utf8');
  const dump = src.slice(src.indexOf('function dumpDatabase'));
  const tables = S.sql((d) => d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name));
  for (const t of tables) if (!NOT_BACKED_UP.has(t)) assert.match(dump, new RegExp(`\\b${t}:`), `${t} is in the backup`);
});
