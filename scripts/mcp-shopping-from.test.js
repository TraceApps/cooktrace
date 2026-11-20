/**
 * An outside agent builds the shopping list from a recipe or from the plan
 * over MCP, on a real server, the way the Shopping screen does: amounts add
 * up, in-stock pantry items are skipped, and a week built again replaces
 * its share. Both are write tools.
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
      JWT_SECRET: 'mcp-shop-test-secret--0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', MCP_ENABLED: '1', MCP_WRITE_ENABLED: '1', MCP_DESTROY_ENABLED: '1', ...env },
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
  const dir = mkdtempSync(join(tmpdir(), 'ct-mcp-shopping-from-'));
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
      srv, json, admin, member, mcp, stop,
      agent: mcp(await tokenFor(admin, ['mcp:read', 'mcp:write', 'mcp:destroy'])),
      reader: mcp(await tokenFor(admin, ['mcp:read'])),
    };
  } catch (e) { await stop(); throw e; }
}

const shift = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

test('MCP: add a recipe or the plan to the shopping list', { skip, timeout: 120000 }, async () => {
  const t = await start();
  try {
    const writer = t.mcp((await t.json('POST', '/api/admin/api-tokens', { name: 'w', scopes: ['mcp:read', 'mcp:write'], password: 'Str0ng-Pass-88!y' }, t.admin)).raw);
    const w = await writer('tools/list');
    assert.ok(w.includes('add_recipe_to_shopping_list') && w.includes('add_plan_to_shopping_list'), 'both are writes');
    const r = await t.reader('tools/list');
    assert.ok(!r.includes('add_recipe_to_shopping_list') && !r.includes('add_plan_to_shopping_list'), 'mcp:read alone gets neither');

    const salt = await t.json('POST', '/api/pantry', { name: 'Salt', in_stock: 1 }, t.admin);
    const chilli = await t.json('POST', '/api/recipes', { name: 'Chilli', servings: 4, ingredients: [{ group: '', items: [
      { name: 'Beef mince', qty: '800', unit: 'g' }, { name: 'Salt', qty: '1', unit: 'tsp', pantry_item_id: salt.id },
    ] }] }, t.admin);
    const patsOwn = await t.json('POST', '/api/recipes', { name: 'Pat Stew', servings: 1, ingredients: [{ group: '', items: [{ name: 'water' }] }] }, t.member);

    const a = await writer('add_recipe_to_shopping_list', { recipe_id: chilli.id, servings: 2 });
    assert.equal(a.error, null, a.error);
    let list = await t.json('GET', '/api/shopping', null, t.admin);
    const items = list.items || list;
    const beef = items.find(i => /beef/i.test(i.name));
    assert.equal(Number(beef.quantity), 400, 'scaled to the servings asked');
    assert.ok(!items.some(i => /salt/i.test(i.name)), 'in stock, skipped');

    await writer('add_recipe_to_shopping_list', { recipe_id: chilli.id, servings: 2, only_missing: false });
    list = await t.json('GET', '/api/shopping', null, t.admin);
    const again = list.items || list;
    assert.equal(Number(again.find(i => /beef/i.test(i.name)).quantity), 800, 'amounts add up');
    assert.ok(again.some(i => /salt/i.test(i.name)), 'only_missing=false keeps stocked items');

    assert.match((await writer('add_recipe_to_shopping_list', { recipe_id: patsOwn.id })).error, /not found/);

    const today = new Date().toLocaleDateString('sv-SE');
    const soup = await t.json('POST', '/api/recipes', { name: 'Soup', servings: 2, ingredients: [{ group: '', items: [{ name: 'Leek', qty: '2' }] }] }, t.admin);
    await writer('plan_cook', { recipe_id: soup.id, date: shift(today, 1), servings: 4 });
    const p = await writer('add_plan_to_shopping_list', { from: today, to: shift(today, 6) });
    assert.equal(p.error, null, p.error);
    assert.equal(p.data.planned_cooks, 1);
    await writer('add_plan_to_shopping_list', { from: today, to: shift(today, 6) });
    list = await t.json('GET', '/api/shopping', null, t.admin);
    const leeks = (list.items || list).filter(i => /leek/i.test(i.name));
    assert.equal(leeks.length, 1);
    assert.equal(Number(leeks[0].quantity), 4, 'built again, not doubled');
    assert.ok((await writer('add_plan_to_shopping_list', { from: shift(today, 3), to: today })).error);
  } finally { await t.stop(); }
});
