/**
 * A fresh install's welcome screen showed a "Setup required" error toast:
 * the app rendered the Recipes page for a moment before the wizard
 * redirect, and the server refuses every data request until the first
 * account exists. Nothing but the wizard may render, or ask the server for
 * data, while the server says setup is required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');

test('the web app renders nothing until a fresh install is on the wizard', () => {
  assert.match(app, /\$: _setupFirst = !isNative && \$setupRequired;/);
  assert.match(app, /\$: _setupPending = _setupFirst && \$location !== '\/wizard';/);
  assert.match(app, /\{:else if !authLoaded \|\| _setupPending\}/, 'the blank branch also covers the way to setup');
  // The blank branch comes before anything that mounts pages or the shell.
  assert.ok(app.indexOf('{:else if !authLoaded || _setupPending}') < app.indexOf('<Router {routes} />'));
});

test('going anywhere else before setup is done comes back to the wizard', () => {
  assert.match(app, /\$: if \(_setupRouted && _setupPending\) _recheckSetup\(\);/);
  assert.match(app, /goWizard: \(\) => \{ if \(getStore\(location\) !== '\/wizard'\) replace\('\/wizard'\); \}/);
  // Replaced, never pushed: Back from the wizard must not land on a page that can't load.
  assert.match(app, /if \(!isNative && \$setupRequired\) \{\s*(\/\/[^\n]*\n\s*)*replace\('\/wizard'\);/);
  // A failing OIDC callback can't stop the redirect.
  assert.match(app, /try \{ await handleOidcCallback\(\); \} catch/);
  // Armed only after the first routing decision, so it never runs ahead of the OIDC callback.
  assert.ok(app.indexOf('_setupRouted = true;') > app.indexOf('await handleOidcCallback();'));
  assert.doesNotMatch(app, /\$setupRequired\) \{\s*window\.location\.hash = '#\/wizard'/);
});

test('nothing in the shell asks for data the server refuses before setup', () => {
  assert.match(app, /if \(!\(\$userMgmtActive && !\$currentUser\) && \(isNative \|\| !\$setupRequired\)\) loadEnvLocks\(\);/, 'env locks wait for setup');
  assert.match(app, /\{#if !_setupFirst\}<Trace \/>\{\/if\}/, 'Trace (chat history) waits for setup');
  assert.doesNotMatch(app, /^<Trace \/>$/m);
});

test('once setup is done, what was held back loads', () => {
  // Signed in only: after registering over a dropped cookie it would just be refused (sign-in loads it).
  assert.match(app, /else if \(_wasSetupFirst\) \{ _wasSetupFirst = false; if \(!\(\$userMgmtActive && !\$currentUser\)\) loadEnvLocks\(\); \}/);
});

test('the server still answers data requests with Setup required before the first account', () => {
  const index = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(index, /res\.status\(503\)\.json\(\{ error: 'Setup required', setup_required: true \}\)/);
});
