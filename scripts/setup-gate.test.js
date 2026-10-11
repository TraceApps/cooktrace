/**
 * A tab left on setup while the first account was made in another tab or on
 * another device must not stay trapped there (its own account creation would
 * be refused, and every page sent it back to setup until a reload). Before
 * sending a tab back to setup, and when it comes back into view, the server
 * is asked again (src/lib/setup-gate.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writable, get } from 'svelte/store';
import { createSetupCheck } from '../src/lib/setup-gate.js';

function rig(serverSaysSetup) {
  const setupRequired = writable(true);
  const went = [];
  let reloads = 0;
  const check = createSetupCheck({
    reload: async () => { reloads++; await new Promise((r) => setTimeout(r, 5)); setupRequired.set(serverSaysSetup()); },
    setupRequired,
    goWizard: () => went.push('wizard'),
    goHome: () => went.push('home'),
  });
  return { check, went, setupRequired, reloads: () => reloads };
}

test('setup done elsewhere: the tab leaves setup (for sign-in)', async () => {
  const r = rig(() => false);
  await r.check();
  assert.deepEqual(r.went, ['home']);
  assert.equal(get(r.setupRequired), false);
});

test('setup still needed: the tab goes back to setup', async () => {
  const r = rig(() => true);
  await r.check();
  assert.deepEqual(r.went, ['wizard']);
});

test('a server that cannot be asked leaves the tab where it was told', async () => {
  const setupRequired = writable(true);
  const went = [];
  const check = createSetupCheck({ reload: async () => { throw new TypeError('Failed to fetch'); }, setupRequired, goWizard: () => went.push('wizard'), goHome: () => went.push('home') });
  await check();
  assert.deepEqual(went, ['wizard']);
});

test('checks asked for at once share one request', async () => {
  const r = rig(() => false);
  await Promise.all([r.check(), r.check(), r.check()]);
  assert.equal(r.reloads(), 1);
  assert.deepEqual(r.went, ['home']);
  await r.check();
  assert.equal(r.reloads(), 2, 'a later one asks again');
});

test('the app and the wizard use it', () => {
  const app = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
  assert.match(app, /\$: if \(_setupRouted && _setupPending\) _recheckSetup\(\);/, 'before sending a tab back to setup');
  assert.match(app, /document\.addEventListener\('visibilitychange', _backInView\);/);
  assert.match(app, /window\.addEventListener\('focus', _backInView\);/);
  const wizard = readFileSync(new URL('../src/routes/Wizard.svelte', import.meta.url), 'utf8');
  assert.match(wizard, /if \(_forceAccountCreation\) \{\s*await loadAuthState\(\);\s*if \(!get\(setupRequired\)\) \{ replace\('\/'\); return; \}/, 'a refused first account checks why');
});
