/**
 * #101: MCP sets a recipe's category, favorite and rating, lists categories
 * and cookbooks, and adds recipes to or takes them out of a cookbook, on a
 * real server. Changes go through the app's own code: favorite and rating
 * don't make a new version, a category change is an edit like the app's,
 * and a cookbook changes only for its owner or a kitchen's Sous Chef. A
 * smart cookbook is refused (its filter decides).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
      JWT_SECRET: 'mcp-cookbook-test-secr-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', MCP_ENABLED: '1', MCP_WRITE_ENABLED: '1', MCP_DESTROY_ENABLED: '1', ...env },
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
  const dir = mkdtempSync(join(tmpdir(), 'ct-mcp-cookbooks-'));
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
      // The member's own token (any signed-in account makes its own).
      patAgent: mcp((await json('POST', '/api/tokens', { name: 'agent', scopes: ['mcp:read', 'mcp:write'], password: 'Str0ng-Pass-77!z' }, member)).raw),
    };
  } catch (e) { await stop(); throw e; }
}


test('MCP: category, favorite and rating on update_recipe', { skip, timeout: 120000 }, async () => {
  const t = await start();
  try {
    const tools = await t.reader('tools/list');
    for (const name of ['list_recipe_categories', 'list_cookbooks']) assert.ok(tools.includes(name), name);
    assert.ok(!tools.includes('add_recipe_to_cookbook') && !tools.includes('remove_recipe_from_cookbook'), 'mcp:read alone can only list');

    const made = await t.agent('create_recipe', { confirm: true, name: 'Lentil Soup', servings: 4, ingredients: [{ name: 'lentils', qty: 1, unit: 'cup' }], steps: ['Simmer.'] });
    const rid = made.data.created.id;
    const catCount = async () => (await t.json('GET', '/api/recipes/categories', null, t.admin)).length;
    const seeded = await catCount();
    const soups = await t.json('POST', '/api/recipes/categories', { name: 'Soups' }, t.admin);
    const cafe = await t.json('POST', '/api/recipes/categories', { name: 'Ñoquis Café' }, t.admin);
    await t.json('POST', '/api/recipes/categories', { name: 'Twin' }, t.admin);
    await t.json('POST', '/api/recipes/categories', { name: 'twin' }, t.admin);
    const patsCat = await t.json('POST', '/api/recipes/categories', { name: 'Pat Only' }, t.member);

    const versions = async () => (await t.json('GET', `/api/recipes/${rid}/versions`, null, t.admin)).length;
    const revs = async () => (await t.json('GET', `/api/recipes/${rid}/revisions`, null, t.admin)).revisions.length;
    const v0 = await versions(), h0 = await revs();

    // Favorite and rating: set, and no new version or history entry.
    const fav = await t.agent('update_recipe', { recipe_id: rid, favorite: true, rating: 4 });
    assert.equal(fav.error, null, fav.error);
    assert.deepEqual(fav.data.changed.sort(), ['favorite', 'rating']);
    let r = await t.json('GET', `/api/recipes/${rid}`, null, t.admin);
    assert.deepEqual([!!r.favorite, r.rating], [true, 4]);
    assert.equal(await revs(), h0, 'a favorite or rating is not a new version in the history');
    assert.equal(await versions(), v0, 'and keeps no replaced copy');
    // null takes the rating off; out of range is refused, not clamped.
    await t.agent('update_recipe', { recipe_id: rid, rating: null, favorite: false });
    r = await t.json('GET', `/api/recipes/${rid}`, null, t.admin);
    assert.deepEqual([!!r.favorite, r.rating], [false, null]);
    assert.ok((await t.agent('update_recipe', { recipe_id: rid, rating: 7 })).error, 'rating 7 refused');
    assert.ok((await t.agent('update_recipe', { recipe_id: rid, rating: 3.5 })).error, 'half stars refused');
    assert.ok((await t.agent('update_recipe', { recipe_id: rid, rating: 0 })).error, '0 refused: no rating is null, as in the app');

    // Category by id, by name in any case (accents too), and off again.
    const byId = await t.agent('update_recipe', { recipe_id: rid, category: soups.id });
    assert.equal(byId.error, null, byId.error);
    assert.deepEqual(byId.data.changed, ['category']);
    assert.equal((await t.json('GET', `/api/recipes/${rid}`, null, t.admin)).category_id, soups.id);
    assert.deepEqual((await t.agent('update_recipe', { recipe_id: rid, category: 'soups' })).data.changed, [], 'the same category again changes nothing');
    await t.agent('update_recipe', { recipe_id: rid, category: '  ñoquis café ' });
    assert.equal((await t.json('GET', `/api/recipes/${rid}`, null, t.admin)).category_id, cafe.id);
    assert.equal((await t.agent('get_recipe', { recipe_id: rid })).data.category.name, 'Ñoquis Café', 'get_recipe says the category');
    await t.agent('update_recipe', { recipe_id: rid, category: null });
    assert.equal((await t.json('GET', `/api/recipes/${rid}`, null, t.admin)).category_id, null);
    // Unknown, ambiguous, or someone else's: an error, and nothing made.
    assert.match((await t.agent('update_recipe', { recipe_id: rid, category: 'Stews' })).error, /No category called "Stews"/);
    assert.match((await t.agent('update_recipe', { recipe_id: rid, category: 'TWIN' })).error, /More than one category/);
    assert.match((await t.agent('update_recipe', { recipe_id: rid, category: patsCat.id })).error, /not found in your categories/);
    assert.match((await t.agent('update_recipe', { recipe_id: rid, category: 'Pat Only' })).error, /No category called/);
    assert.equal(await catCount(), seeded + 4, 'no category was made');

    // list_recipe_categories: the app's order, counts of this account's recipes only.
    await t.agent('update_recipe', { recipe_id: rid, category: soups.id });
    const cats = (await t.agent('list_recipe_categories')).data.categories;
    const app = (await t.json('GET', '/api/recipes/categories', null, t.admin)).map(c => c.id);
    assert.deepEqual(cats.map(c => c.id), app, "the app's categories, in the app's order");
    assert.deepEqual(cats.slice(-4).map(c => c.name), ['Soups', 'Ñoquis Café', 'Twin', 'twin']);
    assert.equal(cats.find(c => c.id === soups.id).recipe_count, 1);
    assert.ok(!cats.some(c => c.id === patsCat.id), "not another account's");
  } finally { await t.stop(); }
});

test('MCP: list cookbooks and add or remove recipes', { skip, timeout: 120000 }, async () => {
  const t = await start();
  try {
    const mk = async name => (await t.agent('create_recipe', { confirm: true, name, servings: 2, ingredients: [{ name: 'salt' }], steps: ['Cook.'] })).data.created.id;
    const [a, b, c] = [await mk('Alpha'), await mk('Bravo'), await mk('Charlie')];
    const week = await t.json('POST', '/api/cookbooks', { name: 'Weeknights' }, t.admin);
    const smart = await t.json('POST', '/api/cookbooks', { name: 'Favorites', is_smart: true, smart_filter: { favorites_only: true } }, t.admin);
    const patsSoup = await t.json('POST', '/api/recipes', { name: 'Pat Soup', servings: 1, ingredients: [{ title: '', items: [{ name: 'water' }] }], steps: [{ title: '', text: 'Boil.' }] }, t.member);

    // Add: several at once, a repeat, someone else's recipe, a missing id.
    const add = await t.agent('add_recipe_to_cookbook', { cookbook_id: week.id, recipe_ids: [a, b, a] });
    assert.equal(add.error, null, add.error);
    assert.deepEqual([add.data.added, add.data.already_in, add.data.not_found], [[a, b], [], []]);
    const add2 = await t.agent('add_recipe_to_cookbook', { cookbook_id: week.id, recipe_ids: [b, c, patsSoup.id, 999999] });
    assert.deepEqual([add2.data.added, add2.data.already_in, add2.data.not_found], [[c], [b], [patsSoup.id, 999999]]);
    // In the app, in the order added.
    const open = await t.json('GET', `/api/cookbooks/${week.id}`, null, t.admin);
    assert.deepEqual(open.recipes.map(r => r.id), [a, b, c]);
    // get_recipe says which cookbooks.
    assert.deepEqual((await t.agent('get_recipe', { recipe_id: a })).data.cookbooks, [{ id: week.id, name: 'Weeknights' }]);

    // Remove: some there, one not; the recipe itself stays.
    const rm = await t.agent('remove_recipe_from_cookbook', { cookbook_id: week.id, recipe_ids: [a, patsSoup.id] });
    assert.equal(rm.error, null, rm.error);
    assert.deepEqual([rm.data.removed, rm.data.not_in], [[a], [patsSoup.id]]);
    assert.deepEqual((await t.json('GET', `/api/cookbooks/${week.id}`, null, t.admin)).recipes.map(r => r.id), [b, c]);
    assert.equal((await t.json('GET', `/api/recipes/${a}`, null, t.admin)).name, 'Alpha');
    assert.deepEqual((await t.agent('get_recipe', { recipe_id: a })).data.cookbooks, []);

    // A smart cookbook is refused both ways, with why.
    assert.match((await t.agent('add_recipe_to_cookbook', { cookbook_id: smart.id, recipe_ids: [a] })).error, /smart cookbook/);
    assert.match((await t.agent('remove_recipe_from_cookbook', { cookbook_id: smart.id, recipe_ids: [a] })).error, /smart cookbook/);
    await t.agent('update_recipe', { recipe_id: a, favorite: true });

    // list_cookbooks: own, with counts; smart says so and isn't editable.
    let list = (await t.agent('list_cookbooks')).data.cookbooks;
    const byName = n => list.find(x => x.name === n);
    assert.deepEqual([byName('Weeknights').recipe_count, byName('Weeknights').can_edit, byName('Weeknights').smart], [2, true, false]);
    assert.deepEqual([byName('Favorites').recipe_count, byName('Favorites').can_edit, byName('Favorites').smart], [1, false, true]);
    assert.deepEqual(byName('Favorites').smart_filter, { favorites_only: true });

    // Pat's own cookbook is out of reach until shared; shared to read, it
    // lists but can't be changed.
    const patsBook = await t.json('POST', '/api/cookbooks', { name: 'Pat Book' }, t.member);
    assert.match((await t.agent('add_recipe_to_cookbook', { cookbook_id: patsBook.id, recipe_ids: [a] })).error, /not found/);
    assert.ok(!(await t.agent('list_cookbooks')).data.cookbooks.some(x => x.id === patsBook.id));
    const me = async jwt => (await t.json('GET', '/api/auth/me', null, jwt)).user;
    const cookId = (await me(t.admin)).id, patId = (await me(t.member)).id;
    await t.json('POST', `/api/cookbooks/${patsBook.id}/shares`, { user_ids: [cookId] }, t.member);
    list = (await t.agent('list_cookbooks')).data.cookbooks;
    assert.deepEqual([byName('Pat Book').can_edit, byName('Pat Book').shared_by], [false, 'pat']);
    assert.match((await t.agent('add_recipe_to_cookbook', { cookbook_id: patsBook.id, recipe_ids: [a] })).error, /shared with you to read/);
    assert.match((await t.agent('remove_recipe_from_cookbook', { cookbook_id: patsBook.id, recipe_ids: [a] })).error, /shared with you to read/);

    // Through a kitchen where Pat is Sous Chef, Pat may change Weeknights.
    const kitchen = await t.json('POST', '/api/kitchens', { name: 'Home' }, t.admin);
    await t.json('POST', `/api/kitchens/${kitchen.id}/members`, { username: 'pat', role: 'member' }, t.admin);
    await t.json('POST', `/api/kitchens/${kitchen.id}/share-cookbook`, { cookbook_id: week.id }, t.admin);
    const lineCook = await t.patAgent('add_recipe_to_cookbook', { cookbook_id: week.id, recipe_ids: [patsSoup.id] });
    assert.match(lineCook.error, /shared with you to read/, 'a Line Cook only reads');
    await t.json('PUT', `/api/kitchens/${kitchen.id}/members/${patId}/role`, { role: 'sous' }, t.admin);
    const patList = (await t.patAgent('list_cookbooks')).data.cookbooks;
    assert.equal(patList.find(x => x.id === week.id).can_edit, true);
    const sous = await t.patAgent('add_recipe_to_cookbook', { cookbook_id: week.id, recipe_ids: [patsSoup.id] });
    assert.equal(sous.error, null, sous.error);
    assert.deepEqual(sous.data.added, [patsSoup.id]);
    const sousRm = await t.patAgent('remove_recipe_from_cookbook', { cookbook_id: week.id, recipe_ids: [b] });
    assert.deepEqual(sousRm.data.removed, [b]);
    assert.deepEqual((await t.json('GET', `/api/cookbooks/${week.id}`, null, t.admin)).recipes.map(r => r.id), [c, patsSoup.id]);

    // The app's own routes still answer as before.
    const viaApp = await t.json('POST', `/api/cookbooks/${week.id}/recipes`, { recipe_ids: [a] }, t.admin);
    assert.deepEqual(viaApp, { ok: true, added: 1 });
    assert.equal((await t.json('DELETE', `/api/cookbooks/${week.id}/recipes/${a}`, null, t.admin)).ok, true);
    assert.equal(await fetch(t.srv.base + `/api/cookbooks/${patsBook.id}/recipes`, { method: 'POST' }).then(r => r.status) >= 400, true);
  } finally { await t.stop(); }
});
