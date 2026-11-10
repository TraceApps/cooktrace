/**
 * SMTP_* in the environment and the lock on Settings > Email (SMTP)
 * (server/email.js). The env manages SMTP only when SMTP_HOST names a server;
 * the stock docker-compose.yml passes it empty.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const req = createRequire(new URL('../server/package.json', import.meta.url));
let sqlite = true;
try { req('better-sqlite3'); } catch { sqlite = false; }

let db = null, dir = null, seedSmtpFromEnv, isSmtpEnvLocked;
if (sqlite) {
  dir = mkdtempSync(join(tmpdir(), 'ct-smtp-env-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  ({ seedSmtpFromEnv, isSmtpEnvLocked } = await import('../server/email.js'));
}
test.after(() => { try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

const KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
const withEnv = (env, fn) => {
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try { fn(); } finally {
    for (const k of KEYS) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
  }
};
const smtpRows = () => Object.fromEntries(
  db.prepare("SELECT key, value FROM app_config WHERE key LIKE 'smtp_%'").all().map(r => [r.key, r.value]));
const reset = () => db.prepare("DELETE FROM app_config WHERE key LIKE 'smtp_%'").run();
const save = (rows) => {
  const put = db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(rows)) put.run(k, v);
};
// What the stock docker-compose.yml passes when .env sets none of them.
const STOCK_COMPOSE = { SMTP_HOST: '', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '' };

test('the stock compose file leaves Settings > Email to the admin', { skip: !sqlite }, () => {
  reset();
  save({ smtp_host: 'mail.admin.example', smtp_port: '465', smtp_from: 'admin@example.com' });
  withEnv(STOCK_COMPOSE, seedSmtpFromEnv);
  assert.equal(isSmtpEnvLocked(), false);
  assert.deepEqual(smtpRows(), { smtp_host: 'mail.admin.example', smtp_port: '465', smtp_from: 'admin@example.com' });
});

test('with SMTP_HOST set, the env wins and locks the form', { skip: !sqlite }, () => {
  reset();
  save({ smtp_host: 'mail.admin.example', smtp_user: 'admin' });
  withEnv({ SMTP_HOST: 'mail.env.example', SMTP_PORT: '587', SMTP_FROM: 'env@example.com' }, seedSmtpFromEnv);
  assert.equal(isSmtpEnvLocked(), true);
  assert.deepEqual(smtpRows(), {
    smtp_host: 'mail.env.example', smtp_port: '587', smtp_from: 'env@example.com',
    smtp_user: 'admin', smtp_env_locked: 'true',
  });
});

test('removing SMTP_* unlocks the form and drops what the env wrote', { skip: !sqlite }, () => {
  reset();
  withEnv({ SMTP_HOST: 'mail.env.example', SMTP_PORT: '587', SMTP_PASS: 'secret' }, seedSmtpFromEnv);
  assert.equal(isSmtpEnvLocked(), true);
  withEnv({}, seedSmtpFromEnv);
  assert.equal(isSmtpEnvLocked(), false);
  assert.deepEqual(smtpRows(), {});
});

test('emptying SMTP_HOST, as the stock compose does, unlocks it too', { skip: !sqlite }, () => {
  reset();
  withEnv({ SMTP_HOST: 'mail.env.example', SMTP_FROM: 'env@example.com' }, seedSmtpFromEnv);
  withEnv(STOCK_COMPOSE, seedSmtpFromEnv);
  assert.equal(isSmtpEnvLocked(), false);
  assert.deepEqual(smtpRows(), {});
});

test('a server set up in Settings stays when the env never named one', { skip: !sqlite }, () => {
  reset();
  save({ smtp_host: 'mail.admin.example', smtp_pass: 'p' });
  withEnv({}, seedSmtpFromEnv);
  withEnv({}, seedSmtpFromEnv);
  assert.equal(isSmtpEnvLocked(), false);
  assert.deepEqual(smtpRows(), { smtp_host: 'mail.admin.example', smtp_pass: 'p' });
});
