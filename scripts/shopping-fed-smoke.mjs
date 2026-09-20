#!/usr/bin/env node
/**
 * scripts/shopping-fed-smoke.mjs: end-to-end check of the sister-app
 * shopping API (/api/v1/shopping with a `shopping` token), against a fresh
 * server with no users yet and no PUBLIC_API or MCP switches.
 *
 * Usage: node scripts/shopping-fed-smoke.mjs <BASE_URL>
 *
 * Registers the first user, makes a `shopping` token and an `mcp:read`
 * token, then lists, adds (with a pantry aisle and a duplicate), checks,
 * and clears, and confirms other tokens and no token are turned away.
 */
const BASE = (process.argv[2] || '').replace(/\/+$/, '');
if (!BASE) { console.error('usage: node scripts/shopping-fed-smoke.mjs <BASE_URL>'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (c, label, detail = '') => {
  console.log(`  ${c ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? '  ' + detail : ''}`);
  c ? pass++ : fail++;
};
async function call(method, path, { token, body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}

const creds = { username: 'shopper', password: 'Shop!Smoke-2026x' };
await call('POST', '/api/auth/register', { body: creds });
const login = await call('POST', '/api/auth/login', { body: creds });
const session = login.json?.token;
ok(!!session, 'first user signs in');

const mk = async (scopes) => (await call('POST', '/api/admin/api-tokens', { token: session, body: { name: `smoke ${scopes.join(' ')}`, scopes } })).json?.raw;
const shop = await mk(['shopping']);
const other = await mk(['mcp:read']);
ok(!!shop && !!other, 'tokens created');

// A pantry item in a category, so a typed name picks up its aisle (the category's default aisle, or its name).
const cats = (await call('GET', '/api/pantry/categories', { token: session })).json || [];
const list = Array.isArray(cats) ? cats : cats.categories || [];
const cat = list.find(c => /dairy/i.test(c.name)) || list[0] || null;
const expectAisle = cat ? ((cat.default_aisle && cat.default_aisle.trim()) || cat.name) : null;
if (cat) await call('POST', '/api/pantry', { token: session, body: { name: 'Oat Milk', category_id: cat.id } });

let r = await call('GET', '/api/v1/shopping', { token: shop });
ok(r.status === 200 && Array.isArray(r.json?.items) && r.json.items.length === 0, 'an empty list to start', `status ${r.status}`);

r = await call('POST', '/api/v1/shopping', { token: shop, body: { items: [{ name: 'oat milk' }, { name: 'Dish soap', quantity: 2, unit: 'bottles' }, { name: '' }] } });
ok(r.status === 201 && r.json?.added?.length === 2, 'adds several items, ignoring a blank one', `status ${r.status} ${JSON.stringify(r.json)}`);
const milk = r.json?.added?.find(i => i.name === 'Oat Milk');
ok(!!milk, 'names are title-cased like the app');
ok(!!cat && milk?.aisle === expectAisle && milk?.pantry_id != null, 'a name matching a pantry item gets its pantry link and aisle', `${milk?.aisle}`);

r = await call('POST', '/api/v1/shopping', { token: shop, body: { name: 'OAT MILK' } });
ok(r.status === 201 && r.json?.added?.length === 0 && r.json?.skipped?.length === 1, 'an item already on the list unchecked is not added twice');

r = await call('GET', '/api/v1/shopping', { token: shop });
const items = r.json?.items || [];
ok(items.length === 2 && items.every(i => 'aisle' in i && 'recipe_name' in i && 'checked' in i), 'the list has aisle, recipe, and checked for each item');
const soap = items.find(i => i.name === 'Dish soap');

r = await call('PATCH', `/api/v1/shopping/${soap?.id}/check`, { token: shop, body: { checked: true } });
ok(r.status === 200 && r.json?.checked === true, 'checks an item off');
r = await call('GET', '/api/v1/shopping?include_checked=false', { token: shop });
ok((r.json?.items || []).every(i => !i.checked) && r.json.items.length === 1, 'include_checked=false leaves checked items out');
r = await call('GET', '/api/v1/shopping', { token: shop });
ok(r.json?.items?.at(-1)?.name === 'Dish soap', 'checked items sort to the end');

r = await call('PATCH', '/api/v1/shopping/999999/check', { token: shop, body: { checked: true } });
ok(r.status === 404, 'checking an item that is not yours or not there is a 404');

r = await call('DELETE', '/api/v1/shopping/checked', { token: shop });
ok(r.status === 200 && r.json?.removed === 1, 'clears checked items');

r = await call('GET', '/api/v1/shopping', { token: other });
ok(r.status === 404, 'a token without the shopping scope still needs the public API switch', `status ${r.status}`);
r = await call('POST', '/api/v1/shopping', { token: other, body: { name: 'X' } });
ok(r.status === 404 || r.status === 403, 'and cannot add', `status ${r.status}`);
r = await call('GET', '/api/v1/shopping');
ok(r.status === 401, 'no token is turned away');
r = await call('GET', '/api/v1/recipes', { token: shop });
ok(r.status === 403, 'a shopping token reaches nothing else', `status ${r.status}`);

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
