/**
 * A recipe's trash icon in the shopping list's By Recipe view, on the real
 * server: since adding a recipe adds to an item that's already there, one
 * item can hold several recipes' amounts. Removing one recipe takes out its
 * share and leaves the rest; it used to delete the whole item.
 *
 * (Harness as in plan-follows-list.test.js.)
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

test("removing one recipe's block leaves what another recipe wants", { skip: !ready && 'server packages not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-by-recipe-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), TZ: 'UTC', PORT: String(port), DB_PATH: join(dir, 'ct.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'shopping-by-recipe-test-0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
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
    const pancakes = await call('POST', '/api/recipes', { name: 'Pancakes', servings: 2, ingredients: [{ group: '', items: [{ name: 'Flour', qty: '1', unit: 'cup' }, { name: 'Eggs', qty: '2' }] }] });
    const bread = await call('POST', '/api/recipes', { name: 'Bread', servings: 1, ingredients: [{ group: '', items: [{ name: 'Flour', qty: '2', unit: 'cup' }] }] });
    await call('POST', `/api/shopping/from-recipe/${pancakes.id}?only_missing=0`, {});
    await call('POST', `/api/shopping/from-recipe/${bread.id}?only_missing=0`, {});
    const list = async () => Object.fromEntries((await call('GET', '/api/shopping')).filter((r) => !r.deleted_at).map((r) => [r.name, [r.quantity, r.recipe_id]]));
    assert.deepEqual(await list(), { Flour: [3, pancakes.id], Eggs: [2, pancakes.id] });

    await call('DELETE', `/api/shopping/by-recipe/${pancakes.id}`);
    assert.deepEqual(await list(), { Flour: [2, bread.id] }, "the bread's flour stays, now under the bread");
    await call('DELETE', `/api/shopping/by-recipe/${bread.id}`);
    assert.deepEqual(await list(), {});
  } finally {
    await new Promise((res) => { if (proc.exitCode != null || proc.signalCode != null) return res(); proc.once('exit', res); proc.kill('SIGKILL'); });
    rmSync(dir, { recursive: true, force: true });
  }
});
