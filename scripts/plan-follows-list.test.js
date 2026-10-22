/**
 * The shopping list follows the plan (#81), on the real server.
 *
 * A planned cook that's on the list takes its share with it when it's
 * edited, moved, deleted or cooked, without building the week again; what
 * was bought and cleared stays off, and an edit that changes nothing on the
 * list writes nothing. A cook moved to another week and that week built is
 * counted once. Before, an edit or a delete left the list as it was until
 * the week was built again, and a moved cook was counted twice.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { serverRequire('better-sqlite3'); ready = true; } catch { /* server packages missing: skip */ }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};
const shift = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('the shopping list follows the plan', { skip: !ready && 'server packages not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-plan-list-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(dir, 'ct.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'plan-follows-list-test-0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  try {
    let up = false;
    for (let i = 0; i < 600 && !up; i++) {
      if (proc.exitCode != null) throw new Error(`server exited: ${stderr.slice(-500)}`);
      try { up = (await fetch(base + '/api/auth/status')).ok; } catch { /* not up yet */ }
      if (!up) await sleep(200);
    }
    assert.ok(up, 'server did not start');
    const PW = 'Str0ng-Pass-81!x';
    let token = null;
    const call = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text();
      assert.ok(r.ok, `${method} ${p} -> ${r.status} ${t.slice(0, 200)}`);
      return t ? JSON.parse(t) : null;
    };
    await call('POST', '/api/auth/register', { username: 'cook', password: PW });
    token = (await call('POST', '/api/auth/login', { username: 'cook', password: PW })).token;

    const rice = await call('POST', '/api/pantry', { name: 'Rice', in_stock: 0 });
    const salt = await call('POST', '/api/pantry', { name: 'Salt', in_stock: 1 });
    const fried = await call('POST', '/api/recipes', { name: 'Fried Rice', servings: 2, ingredients: [{ group: '', items: [
      { name: 'Rice', qty: '300', unit: 'g', pantry_item_id: rice.id }, { name: 'Eggs', qty: '2' }, { name: 'Salt', qty: '1', unit: 'tsp', pantry_item_id: salt.id },
    ] }] });
    const curry = await call('POST', '/api/recipes', { name: 'Curry', servings: 2, ingredients: [{ group: '', items: [
      { name: 'Rice', qty: '150', unit: 'g', pantry_item_id: rice.id }, { name: 'Onion', qty: '1' },
    ] }] });

    const today = new Date().toISOString().slice(0, 10);
    const plan = (recipe, n, servings = 2) => call('POST', '/api/cook-diary', { recipe_id: recipe.id, date: shift(today, n), kind: 'planned', servings });
    const a = await plan(fried, 1);
    const b = await plan(curry, 2);
    await plan(curry, 9);
    const rows = async () => (await call('GET', '/api/shopping')).filter((r) => !r.deleted_at);
    const list = async () => Object.fromEntries((await rows()).map((r) => [r.name, r.quantity]));

    // This week; the salt is in stock.
    await call('POST', `/api/shopping/from-plan?from=${today}&to=${shift(today, 6)}`, {});
    assert.deepEqual(await list(), { Rice: 450, Eggs: 2, Onion: 1 });

    // Only the meal changes: the list is left as it is, and nothing says otherwise.
    const meal = await call('PUT', `/api/cook-diary/${b.id}`, { meal_type: 'lunch' });
    assert.equal(meal.list, undefined);

    // The curry for 4.
    const edited = await call('PUT', `/api/cook-diary/${b.id}`, { servings: 4 });
    assert.ok(edited.list, 'the server says the list followed');
    assert.deepEqual(await list(), { Rice: 600, Eggs: 2, Onion: 2 });

    // The eggs bought and cleared, then the fried rice for 4: the rice
    // follows, the eggs stay off.
    const eggs = (await rows()).find((r) => r.name === 'Eggs');
    await call('DELETE', `/api/shopping/${eggs.id}`);
    await call('PUT', `/api/cook-diary/${a.id}`, { servings: 4 });
    assert.deepEqual(await list(), { Rice: 900, Onion: 2 });

    // The fried rice moved to next week: still on the list, once, and
    // nothing to say about the list (no amount changed).
    const moved = await call('PUT', `/api/cook-diary/${a.id}`, { date: shift(today, 8) });
    assert.equal(moved.list, undefined);
    assert.deepEqual(await list(), { Rice: 900, Onion: 2 });
    // Next week built: the moved cook and the other curry, the moved one
    // counted once (its eggs come back with a build, as any build adds them).
    await call('POST', `/api/shopping/from-plan?from=${shift(today, 7)}&to=${shift(today, 13)}`, {});
    assert.deepEqual(await list(), { Rice: 1050, Onion: 3, Eggs: 4 }, '600 + 300 + 150 g');

    // This week's curry deleted: its share comes off.
    const removed = await call('DELETE', `/api/cook-diary/${b.id}`);
    assert.ok(removed.list);
    assert.deepEqual(await list(), { Rice: 750, Onion: 1, Eggs: 4 });

    // The fried rice cooked: the rest of its share isn't needed.
    await call('PUT', `/api/cook-diary/${a.id}`, { kind: 'cooked' });
    assert.deepEqual(await list(), { Rice: 150, Onion: 1 });

    // A cook the list doesn't hold changes nothing on it.
    const d = await plan(fried, 20);
    const untouched = await call('PUT', `/api/cook-diary/${d.id}`, { servings: 6 });
    assert.equal(untouched.list, undefined);
    assert.deepEqual(await list(), { Rice: 150, Onion: 1 });
  } finally {
    await new Promise((res) => { if (proc.exitCode != null || proc.signalCode != null) return res(); proc.once('exit', res); proc.kill('SIGKILL'); });
    rmSync(dir, { recursive: true, force: true });
  }
});
