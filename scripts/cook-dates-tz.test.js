/**
 * A cook with no date, the heatmap and Shop From Plan use the local day.
 *
 * "Today" was the UTC date: a cook marked with no date on a New York evening
 * went on tomorrow, and on a Sydney morning on yesterday. The heatmap's first
 * day and Shop From Plan's default range (today to a week out) were a day
 * off the same way. On the server, today is now the server's local date
 * (lib/calendar-day.js), and days move as calendar days; the phone's copy
 * (api-native.js) does the same with the phone's own today.
 *
 * The real server on a clock set near midnight in several zones, and the
 * phone's helpers run from its source in the same zones.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const fakeClock = (iso) => `const R = Date, OFF = ${Date.parse(iso)} - R.now();
  globalThis.Date = class extends R { constructor(...a) { if (a.length === 0) super(R.now() + OFF); else super(...a); } static now() { return R.now() + OFF; } };`;
const shift = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const CASES = [
  { TZ: 'America/New_York', now: '2026-10-16T03:30:00Z', today: '2026-10-15', why: '23:30, already the 16th in UTC' },
  { TZ: 'Australia/Sydney', now: '2026-10-15T20:30:00Z', today: '2026-10-16', why: '07:30, still the 15th in UTC' },
  { TZ: 'UTC', now: '2026-10-15T12:00:00Z', today: '2026-10-15', why: 'noon in UTC' },
];

async function onServer({ TZ, now, today }) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-dates-tz-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dbPath = join(dir, 'ct.db');
  const proc = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(fakeClock(now))}`, 'index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), TZ, PORT: String(port), DB_PATH: dbPath, UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'cook-dates-tz-test-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  try {
    let up = false;
    for (let i = 0; i < 600 && !up; i++) {
      if (proc.exitCode != null) throw new Error(`server exited in ${TZ}: ${stderr.slice(-500)}`);
      try { up = (await fetch(base + '/api/auth/status')).ok; } catch { /* not up yet */ }
      if (!up) await sleep(200);
    }
    assert.ok(up, `server did not start in ${TZ}`);
    const PW = 'Str0ng-Pass-77!x';
    let token = null;
    const call = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text();
      assert.ok(r.ok, `${method} ${p} -> ${r.status} ${t.slice(0, 200)}`);
      return t ? JSON.parse(t) : null;
    };
    await call('POST', '/api/auth/register', { username: 'cook', password: PW });
    token = (await call('POST', '/api/auth/login', { username: 'cook', password: PW })).token;
    const recipe = await call('POST', '/api/recipes', { name: 'Soup', servings: 2, ingredients: [{ group: '', items: [{ name: 'carrot', quantity: 2, unit: '' }] }] });
    // A cook marked with no date.
    await call('POST', `/api/recipes/${recipe.id}/cooked`, {});
    // Planned cooks yesterday, today, a week out and eight days out.
    for (const n of [-1, 0, 7, 8]) await call('POST', '/api/cook-diary', { recipe_id: recipe.id, date: shift(today, n), kind: 'planned' });
    const plan = await call('POST', '/api/shopping/from-plan', {});
    // Cooks 29 and 30 days back: a 30-day heatmap holds the first only.
    const Database = serverRequire('better-sqlite3');
    const db = new Database(dbPath);
    const uid = db.prepare(`SELECT id FROM users WHERE username = 'cook'`).get().id;
    const cookedDates = db.prepare(`SELECT date FROM cook_diary WHERE user_id = ? AND kind = 'cooked' ORDER BY id`).all(uid).map((r) => r.date);
    const ins = db.prepare(`INSERT INTO cook_diary (user_id, recipe_id, date, kind) VALUES (?, ?, ?, 'cooked')`);
    ins.run(uid, recipe.id, shift(today, -29)); ins.run(uid, recipe.id, shift(today, -30));
    db.close();
    const heat = await call('GET', '/api/cook-diary/heatmap?days=30');
    return { cookedDates, plan, heat };
  } finally {
    await new Promise((res) => { if (proc.exitCode != null || proc.signalCode != null) return res(); proc.once('exit', res); proc.kill('SIGKILL'); });
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const c of CASES) {
  test(`server, ${c.TZ} at ${c.why}`, { skip: !ready && 'server packages missing' }, async () => {
    const r = await onServer(c);
    assert.deepEqual(r.cookedDates, [c.today], 'a cook with no date is on the local today');
    assert.equal(r.plan.from, c.today);
    assert.equal(r.plan.to, shift(c.today, 7));
    assert.equal(r.plan.planned_cooks, 2, 'today and a week out');
    const days = (Array.isArray(r.heat) ? r.heat : r.heat.days || r.heat.rows || []).map((d) => d.date);
    assert.ok(days.includes(shift(c.today, -29)), `29 days back is in: ${days.join(',')}`);
    assert.ok(!days.includes(shift(c.today, -30)), '30 days back is out');
  });
}

// The phone's copy: its day helpers, run from its source, and the three
// places that use them.
const native = readFileSync(new URL('../src/lib/api-native.js', import.meta.url), 'utf8');
const helpers = ['_localToday', '_shiftDay'].map((n) => { const a = native.indexOf(`function ${n}(`); return native.slice(a, native.indexOf('\n', a)); }).join('\n');

for (const c of CASES) {
  test(`phone, ${c.TZ} at ${c.why}`, () => {
    const script = `${fakeClock(c.now)}\n${helpers}\nprocess.stdout.write(JSON.stringify({ today: _localToday(), week: _shiftDay(_localToday(), 7), since: _shiftDay(_localToday(), -29) }));`;
    const r = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: c.TZ }, encoding: 'utf8' }));
    assert.deepEqual(r, { today: c.today, week: shift(c.today, 7), since: shift(c.today, -29) });
  });
}

test('the phone marks cooks, starts the heatmap and plans the shop from its own today', () => {
  const method = (name) => { const a = native.indexOf(`  async ${name}(`); return native.slice(a, native.indexOf('\n  },\n', a)); };
  assert.match(method('markCooked'), /payload\.date \|\| _localToday\(\)/);
  assert.match(method('getCookDiaryHeatmap'), /_shiftDay\(_localToday\(\), -\(cap - 1\)\)/);
  assert.match(method('shopFromPlan'), /const today = _localToday\(\);[\s\S]*to = _shiftDay\(today, 7\)/);
  for (const n of ['markCooked', 'getCookDiaryHeatmap', 'shopFromPlan']) assert.doesNotMatch(method(n), /toISOString\(\)\.slice\(0, 10\)/, n);
});

test('Trace logs a cook with no date on this device\'s today', () => {
  const trace = readFileSync(new URL('../src/components/ai/Trace.svelte', import.meta.url), 'utf8');
  const block = trace.slice(trace.indexOf("case 'log_cook':"), trace.indexOf("case 'log_cook':") + 900);
  assert.match(block, /const payload = \{ date: args\?\.date \|\| isoDay\(new Date\(\)\) \};/);
});
