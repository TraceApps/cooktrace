/**
 * #94: a recipe whose ingredients are stored as a flat list (what MCP's
 * create_recipe stored before, and old rows) has them read as one group
 * everywhere, as the app's own pages always did: GET /api/v1/recipes/:id
 * (NutriTrace's import) sent `items: []` for one, and Settings > Units
 * didn't count its units, and the shopping list got none of them.
 * create_recipe now stores them in a group, as the
 * editor does. A grouped recipe is unchanged.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';

const root = new URL('../', import.meta.url);
let Database = null;
try {
  Database = createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  new Database(':memory:').close();
} catch { Database = null; }
const skip = Database ? false : 'needs the server dependencies, built for this Node';

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

async function boot(dir, env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: new URL('server/', root),
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'app.db'), UPLOADS_PATH: join(dir, 'uploads'),
      JWT_SECRET: 'flat-ing-test-secret--0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', MCP_ENABLED: '1', MCP_WRITE_ENABLED: '1', MCP_DESTROY_ENABLED: '1', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  proc.stderr.on('data', d => { errors += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { await fetch(base + '/api/auth/me'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
    if (i > 150) { proc.kill(); throw new Error('server did not start: ' + errors.slice(-500)); }
  }
  return { base, stop: () => new Promise(r => { proc.on('exit', r); proc.kill(); }) };
}

async function start(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-flat-ing-'));
  const srv = await boot(dir, env);
  try { return await _setup(dir, srv); } catch (e) { await srv.stop(); throw e; }
}
async function _setup(dir, srv) {
  const json = async (method, path, body, tok) => {
    const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (r.status >= 400) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };
  const jwtOf = async (username, password, adminJwt) => {
    const r = await fetch(srv.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(adminJwt ? { Authorization: `Bearer ${adminJwt}` } : {}) }, body: JSON.stringify({ username, password }) });
    assert.ok(r.status < 300, `register ${username}: ${r.status}`);
    const l = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return l.headers.getSetCookie().map(c => c.split(';')[0].split('=')[1]).find(v => v?.startsWith('eyJ'));
  };
  const admin = await jwtOf('cook', 'Str0ng-Pass-88!y');
  const member = await jwtOf('pat', 'Str0ng-Pass-77!z', admin);
  // API tokens are an admin's to make.
  const tokenFor = async (jwt, scopes) => (await json('POST', '/api/admin/api-tokens', { name: 'agent', scopes, password: 'Str0ng-Pass-88!y' }, jwt)).raw;
  let id = 0;
  const mcp = tok => async (name, args = {}) => {
    const r = await fetch(srv.base + '/api/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: name === 'tools/list' ? 'tools/list' : 'tools/call', ...(name === 'tools/list' ? {} : { params: { name, arguments: args } }) }),
    });
    const text = await r.text();
    const line = (r.headers.get('content-type') || '').includes('event-stream') ? text.split('\n').filter(l => l.startsWith('data:')).pop().slice(5) : text;
    const out = JSON.parse(line).result;
    if (name === 'tools/list') return out.tools.map(t => t.name);
    const body = out.content?.[0]?.text;
    let data = null; try { data = JSON.parse(body); } catch { /* an error message */ }
    return { error: out.isError ? body : null, data };
  };
  const stop = async () => { await srv.stop(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* closing */ } };
  try {
    return {
      srv, json, admin, member, mcp, stop, dbPath: join(dir, 'app.db'),
      agent: mcp(await tokenFor(admin, ['mcp:read', 'mcp:write', 'mcp:destroy'])),
      reader: mcp(await tokenFor(admin, ['mcp:read'])),
    };
  } catch (e) { await stop(); throw e; }
}


test('flat ingredient lists read as one group; create_recipe stores a group', { skip, timeout: 120000 }, async () => {
  const t = await start();
  try {
    // Over MCP, as an AI agent makes a recipe.
    const made = await t.agent('create_recipe', { confirm: true, name: 'Agent Soup', ingredients: [{ name: 'leek', qty: 2 }, { name: 'stock', qty: 1, unit: 'qt' }], steps: ['Simmer.'] });
    assert.equal(made.error, null);
    const id = made.data.created.id;
    const db = new Database(t.dbPath);
    try {
      // An old row, stored flat, and a grouped one.
      const uid = db.prepare(`SELECT id FROM users WHERE username = 'cook'`).get().id;
      const ins = db.prepare(`INSERT INTO recipes (user_id, name, ingredients, steps, visibility) VALUES (?, ?, ?, '[]', 'private')`);
      t.flatId = ins.run(uid, 'Old Flat', JSON.stringify([{ name: 'rice', qty: '200', unit: 'g' }, { name: 'saffron', qty: '1', unit: 'pinch' }])).lastInsertRowid;
      t.groupedId = ins.run(uid, 'Grouped', JSON.stringify([{ name: 'A', items: [{ name: 'egg', qty: '2', unit: 'pc' }] }, { name: 'B', items: [{ name: 'milk', qty: '1', unit: 'cup' }] }])).lastInsertRowid;
    } finally { db.close(); }

    const raw = (await t.json('POST', '/api/tokens', { name: 'nt', scopes: ['read:recipes'], password: 'Str0ng-Pass-88!y' }, t.admin)).raw;
    const v1 = async rid => (await t.json('GET', `/api/v1/recipes/${rid}`, null, raw)).items.map(i => i.name);
    assert.deepEqual(await v1(id), ['leek', 'stock']);
    assert.deepEqual(await v1(t.flatId), ['rice', 'saffron'], 'an old flat recipe sends its ingredients');
    assert.deepEqual(await v1(t.groupedId), ['egg', 'milk']);

    // The same ingredients MCP's get_recipe gives.
    const viaMcp = (await t.reader('get_recipe', { recipe_id: Number(t.flatId) })).data;
    const mcpNames = JSON.stringify(viaMcp).match(/"name":"(rice|saffron)"/g);
    assert.deepEqual(mcpNames, ['"name":"rice"', '"name":"saffron"']);

    // Settings > Units counts the units a flat recipe uses.
    const usage = (await t.json('GET', '/api/units', null, t.admin)).usage;
    assert.equal(usage.pinch, 1);
    assert.equal(usage.qt, 1);
    assert.equal(usage.cup, 1);

    // The shopping list gets a flat recipe's ingredients.
    const shop = await t.json('POST', `/api/shopping/from-recipe/${t.flatId}?only_missing=0`, null, t.admin);
    assert.equal(shop.added, 2);
    const list = (await t.json('GET', '/api/shopping', null, t.admin));
    const names = (Array.isArray(list) ? list : list.items || []).map(i => i.name).sort();
    assert.deepEqual(names.filter(x => /rice|saffron/i.test(x)), ['Rice', 'Saffron']);

    // Stored as one group, as the editor stores them.
    const db2 = new Database(t.dbPath, { readonly: true });
    const stored = JSON.parse(db2.prepare('SELECT ingredients FROM recipes WHERE id = ?').get(id).ingredients);
    db2.close();
    assert.equal(stored.length, 1, 'one group');
    assert.equal(stored[0].name, '');
    assert.deepEqual(stored[0].items.map(i => [i.name, i.qty, i.unit]), [['leek', '2', ''], ['stock', '1', 'qt']]);
  } finally { await t.stop(); }
});
