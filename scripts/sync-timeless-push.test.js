/**
 * POST /api/sync/push and rows deleted on the server (the rule LiftTrace's
 * push follows too): a pushed copy with no readable updated_at (none, text
 * that isn't a time, a number like 1e20) can't be told from a stale one, so
 * it never brings back a row deleted here, and no such time fails the push.
 * An edit made after the delete still does. Settings follow the same rule
 * against Clear All Settings, and a reset comes down with the pull.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import test from 'node:test';

let skip = false;
try { createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3'); } catch { skip = 'needs the server dependencies'; }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

let proc = null, dir = null, base = null, token = null;
test.before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'ct-timeless-'));
  const port = await freePort();
  proc = spawn(process.execPath, ['index.js'], {
    cwd: new URL('../server/', import.meta.url),
    env: { ...process.env, PORT: String(port), DB_PATH: join(dir, 'app.db'), UPLOADS_PATH: join(dir, 'uploads'),
      JWT_SECRET: 'timeless-push-test-secret-0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { await fetch(base + '/api/auth/me'); break; } catch { await sleep(100); }
    if (i > 150) throw new Error('server did not start');
  }
  const reg = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'cook', password: 'Str0ng-Pass-88!y' }),
  });
  token = reg.headers.getSetCookie().map(c => c.split(';')[0].split('=')[1]).find(v => v?.startsWith('eyJ'));
});
test.after(() => { proc?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function call(method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}
const push = (tables, extra = {}) => call('POST', '/api/sync/push', { tables, fk_ids: 'server', client_now: new Date().toISOString(), ...extra });
const pulled = async (table, id) => (await call('GET', '/api/sync/pull?since=1970-01-01&synced_at=1&schema=2')).body.tables[table].find(r => r.id === id);

async function deletedItem() {
  const { id } = (await call('POST', '/api/shopping', { name: 'Milk' })).body;
  await call('DELETE', `/api/shopping/${id}`);
  return id;
}
async function deletedRecipe() {
  const { id } = (await call('POST', '/api/recipes', { name: 'Soup', ingredients: [{ items: [{ name: 'water' }] }], steps: ['Boil'] })).body;
  await call('DELETE', `/api/recipes/${id}`);
  return id;
}

const TIMELESS = [['no updated_at', undefined], ['null', null], ['text that is no time', 'yesterday'], ['1e20', 1e20], ['-1e20', -1e20]];

for (const [label, at] of TIMELESS) {
  for (const app of ['this app', 'an app that sends no client_now']) {
    test(`a pushed copy with ${label} leaves a deleted row deleted (${app})`, { skip }, async () => {
      const extra = app === 'this app' ? {} : { client_now: undefined };
      const item = await deletedItem(), recipe = await deletedRecipe();
      await sleep(1100); // it arrives later than the delete, as it would
      const row = (id, v) => ({ client_id: id, server_id: id, ...v, deleted_at: null, ...(at === undefined ? {} : { updated_at: at }) });
      const r = await push({
        shopping_list: [row(item, { name: 'Milk (phone)', checked: 0 })],
        recipes: [row(recipe, { name: 'Soup (phone)', ingredients: [{ items: [{ name: 'water' }] }], steps: ['Boil'] })],
      }, extra);
      assert.equal(r.status, 200);
      assert.notEqual((await pulled('shopping_list', item)).deleted_at, null);
      assert.notEqual((await pulled('recipes', recipe)).deleted_at, null);
    });
  }
}

test('an edit made after the delete still brings the row back', { skip }, async () => {
  const item = await deletedItem();
  await sleep(1100);
  const r = await push({ shopping_list: [{ client_id: 1, server_id: item, name: 'Milk (phone)', checked: 0, updated_at: new Date().toISOString(), deleted_at: null }] });
  assert.equal(r.status, 200);
  assert.equal((await pulled('shopping_list', item)).deleted_at, null);
});

test('a new row that only shares a deleted one\'s name is made as before, time or not', { skip }, async () => {
  const made = (await call('POST', '/api/cookbooks', { name: 'Desserts' })).body;
  const { id, slug } = made.cookbook || made;
  await call('DELETE', `/api/cookbooks/${id}`);
  await sleep(1100);
  const r = await push({ cookbooks: [{ client_id: 3, name: 'Desserts', slug, is_smart: 0, sort_order: 0 }] }, { client_now: undefined });
  assert.equal(r.status, 200);
  assert.equal((await pulled('cookbooks', id)).deleted_at, null);
});

test('no pushed time fails the push: the other rows in it go in', { skip }, async () => {
  const now = new Date().toISOString();
  const r = await push({ shopping_list: [
    { client_id: 7, name: 'Eggs', checked: 0, updated_at: now },
    { client_id: 8, name: 'Big', checked: 0, updated_at: 1e20 },
    { client_id: 9, name: 'Small', checked: 0, updated_at: -1e20 },
  ] });
  assert.equal(r.status, 200);
  assert.equal(r.body.tables.shopping_list.length, 3);
});

test('Clear All Settings: the pull says which settings were reset, and only a change made after it brings one back', { skip }, async () => {
  await call('PUT', '/api/settings', { key: 'measurementSystem', value: 'metric' });
  await call('PUT', '/api/settings', { key: 'defaultServings', value: 3 });
  await call('PUT', '/api/settings', { key: 'energyUnit', value: 'kJ' });
  const before = new Date(Date.now() - 2000).toISOString();
  await call('DELETE', '/api/settings');
  const reset = (await call('GET', '/api/sync/pull?since=1970-01-01&synced_at=1&schema=2')).body.tables.settings;
  assert.ok(reset.length >= 3 && reset.every(s => s.deleted_at), 'every setting comes down as reset');
  await sleep(1100);
  const r = await push({}, { settings: [
    { key: 'measurementSystem', value: 'metric', updated_at: before },          // made before the reset
    { key: 'energyUnit', value: 'kJ' },                                           // no time of its own
    { key: 'defaultServings', value: 6, updated_at: new Date().toISOString() },  // made after it
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual((await call('GET', '/api/settings')).body, { defaultServings: 6 });
  const after = Object.fromEntries((await call('GET', '/api/sync/pull?since=1970-01-01&synced_at=1&schema=2')).body.tables.settings.map(s => [s.key, s.deleted_at]));
  assert.equal(after.defaultServings, null);
  assert.ok(after.measurementSystem && after.energyUnit, 'still reset');
});
