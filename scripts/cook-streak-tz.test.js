/**
 * Cook streaks count calendar days in every time zone.
 *
 * The streak walk read each date as local midnight, stepped a day in local
 * time and took the UTC date. East of UTC (all of Europe, Asia, Australia)
 * local midnight is the day before in UTC, so every step skipped a day: a
 * three-day run read as 2, or 1, and the longest streak never grew past 1.
 * "Today" was also the UTC date, a day off for part of every night. The
 * server (GET /api/cook-diary/stats) and the phone's own copy
 * (getCookDiaryStats in api-native.js) now step calendar days in UTC from
 * the local today.
 *
 * The real server, on a clock set to a known moment, and the phone's copy
 * run from its source, in several time zones.
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
const clock = (iso) => `data:text/javascript,${encodeURIComponent(`
  const R = Date, OFF = ${Date.parse(iso)} - R.now();
  globalThis.Date = class extends R { constructor(...a) { if (a.length === 0) super(R.now() + OFF); else super(...a); } static now() { return R.now() + OFF; } };
`)}`;
const shift = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Cooked today and the two days before, plus an older run of four days.
const cooked = (today) => [0, -1, -2, -10, -11, -12, -13].map((n) => shift(today, n));
const CASES = [
  { TZ: 'Europe/Berlin', now: '2026-10-15T12:00:00Z', today: '2026-10-15', why: 'Berlin at 14:00' },
  { TZ: 'Australia/Sydney', now: '2026-10-15T02:00:00Z', today: '2026-10-15', why: 'Sydney at 13:00' },
  { TZ: 'Europe/Berlin', now: '2026-10-15T22:30:00Z', today: '2026-10-16', why: 'Berlin at 00:30, already the 16th' },
  { TZ: 'America/New_York', now: '2026-10-16T03:30:00Z', today: '2026-10-15', why: 'New York at 23:30, still the 15th' },
  { TZ: 'UTC', now: '2026-10-15T12:00:00Z', today: '2026-10-15', why: 'UTC at noon' },
];

async function serverStats(TZ, now, dates) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-streak-tz-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dbPath = join(dir, 'ct.db');
  const proc = spawn(process.execPath, ['--import', clock(now), 'index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), TZ, PORT: String(port), DB_PATH: dbPath, UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'cook-streak-tz-test-0123456789abcdef0123', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
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
    assert.ok(up, `server did not start in ${TZ}: ${stderr.slice(-500)}`);
    // The first account, then its cooks recorded straight into the database.
    const PW = 'Str0ng-Pass-77!x';
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const reg = await (await post('/api/auth/register', { username: 'cook', password: PW })).json();
    const { token } = await (await post('/api/auth/login', { username: 'cook', password: PW })).json();
    assert.ok(token, `sign-in in ${TZ}: ${JSON.stringify(reg).slice(0, 200)}`);
    const Database = serverRequire('better-sqlite3');
    const db = new Database(dbPath);
    const uid = db.prepare(`SELECT id FROM users WHERE username = 'cook'`).get().id;
    const ins = db.prepare(`INSERT INTO cook_diary (user_id, date, kind) VALUES (?, ?, 'cooked')`);
    for (const d of dates) ins.run(uid, d);
    db.close();
    const r = await fetch(base + '/api/cook-diary/stats', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r.status, 200, `stats in ${TZ}: ${r.status}`);
    return await r.json();
  } finally {
    await new Promise((res) => { if (proc.exitCode != null || proc.signalCode != null) return res(); proc.once('exit', res); proc.kill('SIGKILL'); });
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const c of CASES) {
  test(`server streaks in ${c.TZ}: ${c.why}`, { skip: !ready && 'server packages missing' }, async () => {
    const r = await serverStats(c.TZ, c.now, cooked(c.today));
    assert.equal(r.current_streak, 3);
    assert.equal(r.longest_streak, 4);
  });
}

// The phone's copy, from its source, with its database read stood in for.
const native = readFileSync(new URL('../src/lib/api-native.js', import.meta.url), 'utf8');
const from = native.indexOf('  async getCookDiaryStats() {');
const method = native.slice(from, native.indexOf('\n  },\n', from) + 4);

for (const c of CASES) {
  test(`phone streaks in ${c.TZ}: ${c.why}`, () => {
    const script = `
      const R = Date, OFF = ${Date.parse(c.now)} - R.now();
      globalThis.Date = class extends R { constructor(...a) { if (a.length === 0) super(R.now() + OFF); else super(...a); } static now() { return R.now() + OFF; } };
      const dates = ${JSON.stringify(cooked(c.today))};
      const LOCAL_USER_ID = 1;
      const _query = async (sql) => /DISTINCT date/.test(sql) ? dates.map(d => ({ d })) : /COUNT/.test(sql) ? [{ n: 0 }] : [];
      const api = {\n${method}\n};
      api.getCookDiaryStats().then(r => process.stdout.write(JSON.stringify(r)));`;
    const r = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: c.TZ }, encoding: 'utf8' }));
    assert.equal(r.current_streak, 3);
    assert.equal(r.longest_streak, 4);
  });
}
