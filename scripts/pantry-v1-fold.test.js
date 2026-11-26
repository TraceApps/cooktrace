/**
 * #109: GET /api/v1/pantry?q= (NutriTrace's CookTrace source in Foods)
 * matched lowercase text only, so "vacio" didn't find "Vacío", unlike every
 * other search in CookTrace.
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
      JWT_SECRET: 'pantry-v1-fold-secret--0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', MCP_ENABLED: '1', MCP_WRITE_ENABLED: '1', MCP_DESTROY_ENABLED: '1', ...env },
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



test('the federation pantry search ignores accents and case (#109)', { skip, timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-v1-fold-'));
  const srv = await boot(dir);
  try {
    const reg = await fetch(srv.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'cook', password: 'Str0ng-Pass-88!y' }) });
    assert.ok(reg.status < 300);
    const l = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'cook', password: 'Str0ng-Pass-88!y' }) });
    const jwt = l.headers.getSetCookie().map(c => c.split(';')[0].split('=')[1]).find(v => v?.startsWith('eyJ'));
    const call = async (method, path, body, auth) => {
      const r = await fetch(srv.base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body: body ? JSON.stringify(body) : undefined });
      return r.json();
    };
    const token = (await call('POST', '/api/admin/api-tokens', { name: 'nt', scopes: ['read:pantry'], password: 'Str0ng-Pass-88!y' }, jwt)).raw;
    await call('POST', '/api/pantry', { name: 'Vacío' }, jwt);
    await call('POST', '/api/pantry', { name: 'Champiñón' }, jwt);
    const cafe = await call('POST', '/api/pantry', { name: 'Café' }, jwt);
    await call('POST', '/api/pantry', { name: 'cafe molido', generic_parent_id: cafe.id }, jwt);
    const search = async q => (await call('GET', `/api/v1/pantry?q=${encodeURIComponent(q)}`, null, token)).items.map(i => i.name);
    assert.deepEqual(await search('vacio'), ['Vacío']);
    assert.deepEqual(await search('VACÍO'), ['Vacío']);
    assert.deepEqual(await search('champinon'), ['Champiñón']);
    // A variant that already names its parent isn't shown as "Café, cafe molido".
    assert.deepEqual(await search('molido'), ['cafe molido']);
  } finally {
    await srv.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
