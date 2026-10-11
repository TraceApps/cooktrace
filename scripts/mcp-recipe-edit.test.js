/**
 * #74: MCP edits a recipe after it's made, sets its nutrition and photo,
 * and imports from a URL, on a real server. Edits save the way the app's
 * own do: the replaced copy is kept, a change to what you cook is a new
 * version in the history, pantry links stay by name, and only your own
 * recipes. A photo by URL goes through the address guard; base64 must be
 * an image.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
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
      JWT_SECRET: 'mcp-edit-test-secret-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', MCP_ENABLED: '1', MCP_WRITE_ENABLED: '1', MCP_DESTROY_ENABLED: '1', ...env },
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


const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PAGE = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Recipe', name: 'Lemon Rice', recipeYield: '2',
  recipeIngredient: ['1 cup rice', '1 lemon'], recipeInstructions: ['Cook the rice.', 'Stir in the lemon.'],
})}</script></head><body>Lemon Rice</body></html>`;

// A web server on this machine: a photo, a page with a recipe, something
// that isn't an image.
function site() {
  return new Promise(res => {
    const s = httpServer((req, r) => {
      if (req.url === '/dish.png') { r.writeHead(200, { 'Content-Type': 'image/png' }); r.end(Buffer.from(PNG, 'base64')); return; }
      if (req.url === '/recipe') { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(PAGE); return; }
      r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('not an image at all, just some text');
    });
    s.listen(0, '127.0.0.1', () => res({ base: `http://127.0.0.1:${s.address().port}`, close: () => s.close() }));
  });
}

async function start(env = { ALLOW_PRIVATE_RECIPE_URLS: '1' }) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-mcp-edit-'));
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
  const tokenFor = async (jwt, scopes) => (await json('POST', '/api/admin/api-tokens', { name: 'agent', scopes }, jwt)).raw;
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

test('MCP: update a recipe, its nutrition and photo, and import one from a URL', { skip, timeout: 120000 }, async () => {
  const t = await start();
  const web = await site();
  try {
    const tools = await t.agent('tools/list');
    for (const name of ['update_recipe', 'set_recipe_image', 'import_recipe_from_url']) assert.ok(tools.includes(name), name);
    const readTools = await t.reader('tools/list');
    assert.ok(!readTools.includes('update_recipe') && !readTools.includes('set_recipe_image'), 'mcp:read alone gets neither');

    // Made with the macros the source states.
    const made = await t.agent('create_recipe', { confirm: true, name: 'Chicken Bowl', servings: 2,
      ingredients: [{ name: 'chicken', qty: 300, unit: 'g' }, { name: 'broccoli', qty: 1 }], steps: ['Cook it.'],
      nutrition: { calories: 410, proteins: 32 } });
    assert.equal(made.error, null, made.error);
    const rid = made.data.created.id;
    assert.deepEqual((await t.agent('get_recipe', { recipe_id: rid })).data.nutrition, { calories: 410, proteins: 32 });

    // A pantry link on chicken, set in the app.
    const pantry = await t.json('POST', '/api/pantry', { name: 'Chicken' }, t.admin);
    const r0 = await t.json('GET', `/api/recipes/${rid}`, null, t.admin);
    r0.ingredients[0].items[0].pantry_item_id = pantry.id;
    await t.json('PUT', `/api/recipes/${rid}`, r0, t.admin);
    const before = (await t.json('GET', `/api/recipes/${rid}/revisions`, null, t.admin)).revisions.length;

    // Only what's sent changes; nutrition merges; null takes a value out.
    const up = await t.agent('update_recipe', { recipe_id: rid, servings: 4, nutrition: { fat: 12, calories: null } });
    assert.equal(up.error, null, up.error);
    let r = await t.json('GET', `/api/recipes/${rid}`, null, t.admin);
    assert.equal(r.servings, 4);
    assert.equal(r.name, 'Chicken Bowl');
    assert.deepEqual({ proteins: r.nutrition.proteins, fat: r.nutrition.fat, calories: r.nutrition.calories }, { proteins: 32, fat: 12, calories: undefined });
    assert.equal(r.ingredients[0].items[0].pantry_item_id, pantry.id, 'the link is still there');
    const chickenId = r.ingredients[0].items[0].id;
    // The replaced copy is kept as an earlier version, so the edit can be undone.
    const kept = await t.json('GET', `/api/recipes/${rid}/versions`, null, t.admin);
    assert.ok(kept.some(v => v.reason === 'replaced' && v.data.servings === 2), 'the copy before the edit is kept');

    // Sodium and salt are one value: setting one drops the other, which the
    // save works out again; a stale pair never stays.
    await t.agent('update_recipe', { recipe_id: rid, nutrition: { sodium: 400 } });
    r = await t.json('GET', `/api/recipes/${rid}`, null, t.admin);
    assert.equal(r.nutrition.salt, 1, 'salt from sodium');
    await t.agent('update_recipe', { recipe_id: rid, nutrition: { salt: 2 } });
    r = await t.json('GET', `/api/recipes/${rid}`, null, t.admin);
    assert.deepEqual([r.nutrition.salt, r.nutrition.sodium], [2, 800], 'sodium follows the new salt');
    // Nutrition can't be emptied (the save would keep it): said, not pretended.
    const empty = await t.agent('update_recipe', { recipe_id: rid, nutrition: { proteins: null, fat: null, salt: null, sodium: null } });
    assert.match(empty.error, /nutrition would end up empty/);

    // New ingredients replace the list, keeping chicken's link by name; a new version.
    const ing = await t.agent('update_recipe', { recipe_id: rid, ingredients: [{ name: 'Chicken', qty: 400, unit: 'g' }, { name: 'rice', qty: 1, unit: 'cup' }] });
    assert.equal(ing.error, null, ing.error);
    r = await t.json('GET', `/api/recipes/${rid}`, null, t.admin);
    assert.deepEqual(r.ingredients[0].items.map(i => [i.name, i.qty, i.pantry_item_id ?? null]), [['Chicken', '400', pantry.id], ['rice', '1', null]]);
    assert.equal(r.ingredients[0].items[0].id, chickenId, "chicken keeps its id (steps' ingredient chips point at it)");
    assert.ok(r.ingredients[0].items[1].id && r.ingredients[0].items[1].id !== chickenId, 'rice gets its own');
    const after = (await t.json('GET', `/api/recipes/${rid}/revisions`, null, t.admin)).revisions.length;
    assert.ok(after > before, `history has the edit (${before} -> ${after})`);

    // Nothing to change, another's recipe, both or neither image.
    assert.match((await t.agent('update_recipe', { recipe_id: rid })).error, /Nothing to change/);
    const patsOwn = await t.json('POST', '/api/recipes', { name: 'Pat Soup', servings: 1, ingredients: [{ title: '', items: [{ name: 'water' }] }], steps: [{ title: '', text: 'Boil.' }] }, t.member);
    assert.match((await t.agent('update_recipe', { recipe_id: patsOwn.id, servings: 9 })).error, /not found/, "only the token owner's own recipes");
    assert.match((await t.agent('set_recipe_image', { recipe_id: patsOwn.id, image_data: PNG })).error, /not found/);
    assert.match((await t.agent('set_recipe_image', { recipe_id: rid })).error, /either image_url or image_data/);

    // A photo by URL (the owner may reach this machine), and as base64.
    const byUrl = await t.agent('set_recipe_image', { recipe_id: rid, image_url: `${web.base}/dish.png` });
    assert.equal(byUrl.error, null, byUrl.error);
    assert.match(byUrl.data.updated.img_url, /^\/uploads\/.+\.png$/);
    const served = await fetch(t.srv.base + byUrl.data.updated.img_url);
    assert.equal(served.status, 200);
    // A real photo's size (a frame from a video): 3 MB.
    const big = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(3 * 1024 * 1024, 7)]).toString('base64');
    const bigOne = await t.agent('set_recipe_image', { recipe_id: rid, image_data: big });
    assert.equal(bigOne.error, null, bigOne.error);
    const byData = await t.agent('set_recipe_image', { recipe_id: rid, image_data: `data:image/png;base64,${PNG}` });
    assert.equal(byData.error, null, byData.error);
    assert.notEqual(byData.data.updated.img_url, byUrl.data.updated.img_url);
    assert.match((await t.agent('set_recipe_image', { recipe_id: rid, image_data: Buffer.from('<html>no</html> plus padding text').toString('base64') })).error, /not an image/);
    assert.match((await t.agent('set_recipe_image', { recipe_id: rid, image_url: `${web.base}/note.txt` })).error, /not an image/);

    // Import: confirm first, then once, then not twice.
    assert.match((await t.agent('import_recipe_from_url', { confirm: false, url: `${web.base}/recipe` })).error, /confirm=true/);
    const imp = await t.agent('import_recipe_from_url', { confirm: true, url: `${web.base}/recipe`, tier: 'standard' });
    assert.equal(imp.error, null, imp.error);
    assert.equal(imp.data.created.name, 'Lemon Rice');
    assert.deepEqual([imp.data.created.ingredient_count, imp.data.created.step_count], [2, 2]);
    assert.equal(imp.data.tier, 'standard');
    const again = await t.agent('import_recipe_from_url', { confirm: true, url: `${web.base}/recipe` });
    assert.equal(again.data.skipped, 'already in your library');
    assert.equal(again.data.existing_id, imp.data.created.id);
    assert.match((await t.agent('import_recipe_from_url', { confirm: true, url: `${web.base}/recipe`, tier: 'smart' })).error, /AI provider/);
  } finally { web.close(); await t.stop(); }
});

test('the nutrient keys MCP takes are the app\'s', async () => {
  const { NUTRIMENTS } = await import('../src/lib/nutriments.js');
  const { NUTRIENT_KEYS } = await import('../server/lib/mcp/tools/recipe-edit.js').catch(() => ({}));
  if (!NUTRIENT_KEYS) return; // the server's packages are needed to load it
  assert.deepEqual([...NUTRIENT_KEYS].sort(), NUTRIMENTS.map(n => n.id).sort());
});

test("a photo by URL from this server's own network is refused unless allowed", { skip, timeout: 60000 }, async () => {
  const web = await site();
  try {
    const { downloadImage } = await import('../server/lib/image-localizer.js');
    await assert.rejects(downloadImage(`${web.base}/dish.png`), /^Error: could not fetch the image$/, 'refused, without saying why to someone who may not reach it');
    await assert.rejects(downloadImage(`${web.base}/dish.png`, { allowPrivate: false }), /could not fetch the image/);
    await assert.rejects(downloadImage('file:///etc/passwd'), /http/);
  } finally { web.close(); }
});

test("over MCP, the server's own network is out of reach unless the owner allows it, admin or not", { skip, timeout: 120000 }, async () => {
  const t = await start({});
  const web = await site();
  try {
    const made = await t.agent('create_recipe', { confirm: true, name: 'Soup', ingredients: [{ name: 'water' }], steps: ['Boil.'] });
    const img = await t.agent('set_recipe_image', { recipe_id: made.data.created.id, image_url: `${web.base}/dish.png` });
    assert.match(img.error, /could not fetch the image/);
    const imp = await t.agent('import_recipe_from_url', { confirm: true, url: `${web.base}/recipe`, tier: 'standard' });
    assert.match(imp.error, /Could not fetch URL/);
    const files = await t.json('GET', `/api/recipes/${made.data.created.id}`, null, t.admin);
    assert.equal(files.img_url ?? files.imgUrl ?? null, null, 'nothing saved');
  } finally { web.close(); await t.stop(); }
});
