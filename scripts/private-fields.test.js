/**
 * When each field of a row last changed (field_stamps) is the server's own:
 * no answer to the web, the Android app, the public API or an agent (MCP)
 * carries it (server/lib/private-fields.js). Routes answer with rows as they
 * read them, so this goes through the real server, every kind of answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { withoutPrivateFields } from '../server/lib/private-fields.js';

test('taken out at any depth a row sits in an answer, nothing else touched', () => {
  const row = { id: 1, name: 'Soup', field_stamps: '{}' };
  const body = { recipe: row, items: [{ id: 2, field_stamps: 'x', nested: { field_stamps: 'y', keep: 1 } }], at: new Date(0), field_stampsish: 1 };
  withoutPrivateFields(body);
  assert.deepEqual(row, { id: 1, name: 'Soup' });
  assert.deepEqual(body.items, [{ id: 2, nested: { keep: 1 } }]);
  assert.ok(body.at instanceof Date);
  assert.equal(body.field_stampsish, 1);
  assert.deepEqual(withoutPrivateFields([{ field_stamps: 1, a: 2 }]), [{ a: 2 }]);
  assert.equal(withoutPrivateFields('text'), 'text');
  assert.equal(withoutPrivateFields(null), null);
});

const freePort = () => new Promise((res, rej) => {
  const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej);
});

test('no answer from the server carries field_stamps (real server)', { timeout: 120_000 }, async (t) => {
  try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); } catch { t.skip('better-sqlite3 is not built for this Node'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'ct-private-'));
  const port = await freePort();
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: new URL('../server/', import.meta.url),
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'a.db'), UPLOADS_PATH: join(dir, 'u'), JWT_SECRET: 'private-fields-test-secret-0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test', MCP_ENABLED: '1', MCP_WRITE_ENABLED: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = ''; proc.stderr.on('data', d => { errors += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; ; i++) {
      try { await fetch(base + '/api/auth/me'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
      if (i > 200) throw new Error('server did not start: ' + errors.slice(-500));
    }
    const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'cook', password: 'Str0ng-Pass-88!y' }) });
    const token = reg.headers.getSetCookie().map(c => c.split(';')[0].split('=')[1]).find(v => v?.startsWith('eyJ'));
    const leaks = [];
    let calls = 0;
    const call = async (method, path, body, auth = `Bearer ${token}`, extra = {}) => {
      const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: auth, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      calls++;
      if (text.includes('field_stamps')) leaks.push(`${method} ${path}`);
      try { return JSON.parse(text); } catch { return text; }
    };
    const recipe = await call('POST', '/api/recipes', { name: 'Soup', ingredients: [{ items: [{ name: 'water' }] }], steps: ['Boil'], notes: 'n' });
    await call('PUT', `/api/recipes/${recipe.id}`, { ...recipe, name: 'Soup 2' });
    const pantry = await call('POST', '/api/pantry', { name: 'Flour', quantity: 1, unit: 'kg' });
    await call('PUT', `/api/pantry/${pantry.id}`, { ...pantry, notes: 'x' });
    const shop = await call('POST', '/api/shopping', { name: 'Milk' });
    await call('PUT', `/api/shopping/${shop.id}`, { ...shop, name: 'Oat milk' });
    const cook = await call('POST', '/api/cook-diary', { recipe_id: recipe.id, date: '2026-10-01', kind: 'cooked', servings: 2 });
    await call('PUT', `/api/cook-diary/${cook.id}`, { ...cook, notes: 'tasty' });
    const cb = await call('POST', '/api/cookbooks', { name: 'Weeknights' });
    await call('PUT', `/api/cookbooks/${cb.id}`, { ...cb, description: 'd' });
    for (const p of ['/api/recipes', `/api/recipes/${recipe.id}`, '/api/pantry', `/api/pantry/${pantry.id}`, '/api/shopping', '/api/cook-diary',
      '/api/cookbooks', `/api/cookbooks/${cb.id}`, '/api/units', '/api/recipes/categories', '/api/pantry/categories', '/api/data/export',
      '/api/sync/pull?since=1970-01-01', '/api/sync/pull?since=1970-01-01&synced_at=1&schema=2']) await call('GET', p);
    // The public API and an agent, with a token.
    const tok = await call('POST', '/api/admin/api-tokens', { name: 'check', scopes: ['read:recipes', 'read:pantry', 'shopping', 'mcp:read', 'mcp:write'], password: 'Str0ng-Pass-88!y' });
    const bearer = `Bearer ${tok.raw}`;
    for (const p of ['/api/v1/recipes', `/api/v1/recipes/${recipe.id}`, '/api/v1/pantry', '/api/v1/shopping', '/api/v1/cook-diary']) await call('GET', p, undefined, bearer);
    const mcp = body => call('POST', '/api/mcp', { jsonrpc: '2.0', ...body }, bearer, { Accept: 'application/json, text/event-stream' });
    await mcp({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'check', version: '1' } } });
    for (const [name, args] of [['get_recipe', { recipe_id: recipe.id }], ['list_pantry', {}], ['list_shopping_list', {}], ['list_cook_diary', {}], ['recent_recipes', {}], ['search_recipes', { query: 'soup' }]]) {
      await mcp({ id: 2, method: 'tools/call', params: { name, arguments: args } });
    }
    assert.ok(calls > 30, `${calls} answers checked`);
    assert.deepEqual(leaks, []);
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
