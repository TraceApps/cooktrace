/**
 * #89: an outside agent plans meals and deletes recipes over MCP, on a real
 * server. plan_cook and update_plan work as the app's Plan a Cook dialog
 * does (servings only when said, any day of a week, the shopping list
 * following a cook it holds, never a logged cook); delete_recipe deletes
 * only your own recipe, keeps logged cooks, and is refused while the recipe
 * is still planned. Only the tokens with the right access see the tools.
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
      JWT_SECRET: 'mcp-plan-test-secret--0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', MCP_ENABLED: '1', MCP_WRITE_ENABLED: '1', MCP_DESTROY_ENABLED: '1', ...env },
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
  const dir = mkdtempSync(join(tmpdir(), 'ct-mcp-plan-'));
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

test('MCP: plan meals, change a plan, and delete a recipe', { skip, timeout: 120000 }, async () => {
  const t = await start();
  try {
    const writer = t.mcp(await (async () => (await t.json('POST', '/api/admin/api-tokens', { name: 'w', scopes: ['mcp:read', 'mcp:write'], password: 'Str0ng-Pass-88!y' }, t.admin)).raw)());
    const all = await t.agent('tools/list');
    for (const name of ['plan_cook', 'update_plan', 'delete_recipe']) assert.ok(all.includes(name), name);
    const w = await writer('tools/list');
    assert.ok(w.includes('plan_cook') && w.includes('update_plan'), 'planning is a write');
    assert.ok(!w.includes('delete_recipe'), 'deleting a recipe needs mcp:destroy');
    const r = await t.reader('tools/list');
    assert.ok(!r.includes('plan_cook') && !r.includes('update_plan') && !r.includes('delete_recipe'), 'mcp:read alone gets none');

    const today = new Date().toLocaleDateString('sv-SE');
    const rice = await t.json('POST', '/api/pantry', { name: 'Rice', in_stock: 0 }, t.admin);
    const curry = await t.json('POST', '/api/recipes', { name: 'Curry', servings: 2, ingredients: [{ group: '', items: [
      { name: 'Rice', qty: '150', unit: 'g', pantry_item_id: rice.id }, { name: 'Onion', qty: '1' },
    ] }] }, t.admin);
    const soup = await t.json('POST', '/api/recipes', { name: 'Soup', servings: 2, ingredients: [{ group: '', items: [{ name: 'Leek', qty: '1' }] }] }, t.admin);
    const patsOwn = await t.json('POST', '/api/recipes', { name: 'Pat Stew', servings: 1, ingredients: [{ group: '', items: [{ name: 'water' }] }] }, t.member);

    // Planned, not logged: no servings unless said, the cook count untouched.
    const p1 = await writer('plan_cook', { recipe_id: curry.id, date: shift(today, 1), meal_type: 'dinner' });
    assert.equal(p1.error, null, p1.error);
    assert.deepEqual({ ...p1.data.planned, entry_id: 0 }, { entry_id: 0, recipe_id: curry.id, recipe_name: 'Curry', date: shift(today, 1), any_day: false, meal_type: 'dinner', servings: null, notes: null });
    assert.equal((await t.json('GET', `/api/recipes/${curry.id}`, null, t.admin)).cook_count || 0, 0, 'planning never logs a cook');
    const diary = await t.json('GET', `/api/cook-diary?from=${today}&to=${shift(today, 7)}`, null, t.admin);
    assert.equal(diary.find(e => e.id === p1.data.planned.entry_id)?.kind, 'planned', 'the app shows it as a plan');

    // Any day of a week; list_cook_diary says so.
    const p2 = await writer('plan_cook', { recipe_id: soup.id, date: shift(today, 2), any_day: true, servings: 3 });
    assert.equal(p2.data.planned.any_day, true);
    assert.equal(p2.data.planned.servings, 3);
    const listed = await writer('list_cook_diary', { kind: 'planned' });
    assert.equal(listed.data.items.find(e => e.id === p2.data.planned.entry_id).any_day, true);
    assert.equal(listed.data.items.find(e => e.id === p1.data.planned.entry_id).any_day, false);

    // Someone else's recipe, a bad date.
    assert.match((await writer('plan_cook', { recipe_id: patsOwn.id, date: today })).error, /not found/);
    assert.ok((await writer('plan_cook', { recipe_id: curry.id, date: 'friday' })).error);

    // The list built from the plan follows a change to it (#81).
    await t.json('POST', `/api/shopping/from-plan?from=${today}&to=${shift(today, 6)}`, {}, t.admin);
    const list = async () => Object.fromEntries((await t.json('GET', '/api/shopping', null, t.admin)).filter(x => !x.deleted_at).map(x => [x.name, x.quantity]));
    assert.deepEqual(await list(), { Rice: 150, Onion: 1, Leek: 2 });
    const up = await writer('update_plan', { entry_id: p1.data.planned.entry_id, servings: 4 });
    assert.equal(up.error, null, up.error);
    assert.deepEqual(up.data.changed, ['servings']);
    assert.ok(up.data.shopping_list, 'says the list followed');
    assert.deepEqual(await list(), { Rice: 300, Onion: 2, Leek: 2 });

    // Only what's sent changes; null clears; the same again changes nothing.
    const meal = await writer('update_plan', { entry_id: p1.data.planned.entry_id, meal_type: null, notes: 'double batch' });
    assert.deepEqual(meal.data.changed.sort(), ['meal_type', 'notes']);
    assert.equal(meal.data.planned.servings, 4);
    assert.equal(meal.data.shopping_list, undefined, 'no amount changed');
    assert.deepEqual((await writer('update_plan', { entry_id: p1.data.planned.entry_id, servings: 4 })).data.changed, []);
    const cleared = await writer('update_plan', { entry_id: p1.data.planned.entry_id, servings: null });
    assert.equal(cleared.data.planned.servings, null);
    assert.deepEqual(await list(), { Rice: 150, Onion: 1, Leek: 2 }, "back to the recipe's own");

    // A set day takes an any-day plan off "any day".
    const pinned = await writer('update_plan', { entry_id: p2.data.planned.entry_id, date: shift(today, 3) });
    assert.deepEqual([pinned.data.planned.date, pinned.data.planned.any_day], [shift(today, 3), false]);
    const back = await writer('update_plan', { entry_id: p2.data.planned.entry_id, any_day: true });
    assert.deepEqual([back.data.planned.date, back.data.planned.any_day], [shift(today, 3), true]);

    // A logged cook isn't a plan; another account's entry isn't found.
    const logged = await writer('log_cook', { recipe_id: soup.id, date: today });
    assert.match((await writer('update_plan', { entry_id: logged.data.logged.entry_id, servings: 2 })).error, /logged cook/);
    const patsPlan = await t.json('POST', '/api/cook-diary', { recipe_id: patsOwn.id, date: today, kind: 'planned' }, t.member);
    assert.match((await writer('update_plan', { entry_id: patsPlan.id, servings: 2 })).error, /not found/);

    // delete_recipe: confirm, your own only, and not while it's planned.
    assert.match((await t.agent('delete_recipe', { recipe_id: soup.id, confirm: false })).error, /confirm=true/);
    assert.match((await t.agent('delete_recipe', { recipe_id: patsOwn.id, confirm: true })).error, /not found/);
    const planned = await t.agent('delete_recipe', { recipe_id: soup.id, confirm: true });
    assert.match(planned.error, new RegExp(`entry_id ${p2.data.planned.entry_id} on ${shift(today, 3)} \\(any day that week\\)`));
    assert.ok((await t.json('GET', `/api/recipes/${soup.id}`, null, t.admin)).id, 'still there');

    await t.agent('delete_cook_diary_entry', { entry_id: p2.data.planned.entry_id, confirm: true });
    const gone = await t.agent('delete_recipe', { recipe_id: soup.id, confirm: true });
    assert.equal(gone.error, null, gone.error);
    assert.deepEqual(gone.data, { ok: true, deleted: { recipe_id: soup.id, name: 'Soup' }, logged_cooks_kept: 1 });
    assert.match((await t.agent('get_recipe', { recipe_id: soup.id })).error || '', /not found/i, 'gone from the agent');
    const recipes = await t.json('GET', '/api/recipes', null, t.admin);
    assert.ok(!recipes.some(x => x.id === soup.id), 'gone from the app');
    const kept = await t.json('GET', `/api/cook-diary?from=${today}&to=${today}`, null, t.admin);
    assert.ok(kept.some(e => e.id === logged.data.logged.entry_id), 'the logged cook stays in the diary');
    assert.match((await writer('plan_cook', { recipe_id: soup.id, date: today })).error, /not found/, 'a deleted recipe is not planned');

    // A plan in the past doesn't hold a recipe back.
    const old = await t.json('POST', '/api/cook-diary', { recipe_id: curry.id, date: shift(today, -30), kind: 'planned' }, t.admin);
    assert.ok(old.id);
    await t.agent('delete_cook_diary_entry', { entry_id: p1.data.planned.entry_id, confirm: true });
    assert.equal((await t.agent('delete_recipe', { recipe_id: curry.id, confirm: true })).error, null);
  } finally { await t.stop(); }
});
