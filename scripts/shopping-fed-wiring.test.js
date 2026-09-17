/**
 * Static checks for the sister-app shopping API (server/routes/api/v1/shopping-fed.js):
 * mounted ahead of the public API router, gated only by the `shopping` scope,
 * and built on the shared shopping-items helpers. Text checks only, so this
 * runs without the better-sqlite3 native binding. The end-to-end check is
 * scripts/shopping-fed-smoke.mjs against a running server.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const indexJs = read('../server/routes/api/v1/index.js');
const fedJs = read('../server/routes/api/v1/shopping-fed.js');
const tokensJs = read('../server/lib/api-tokens.js');
const appShoppingJs = read('../server/routes/shopping.js');

test('the sister-app router is mounted on /shopping before the public API router', () => {
  const fed = indexJs.indexOf("router.use('/shopping', shoppingFedRouter)");
  const pub = indexJs.indexOf("router.use('/shopping', shoppingRouter)");
  assert.ok(fed > -1 && pub > -1 && fed < pub);
});

test('only a token with the shopping scope is served; others fall through', () => {
  assert.match(fedJs, /scopes\.includes\('shopping'\)/);
  assert.match(fedJs, /next\('router'\)/);
  assert.doesNotMatch(fedJs, /process\.env/, 'no server switch gates these routes');
});

test('list, add, check, and clear checked are all there', () => {
  assert.match(fedJs, /router\.get\('\/'/);
  assert.match(fedJs, /router\.post\('\/'/);
  assert.match(fedJs, /router\.patch\('\/:id\/check'/);
  assert.match(fedJs, /router\.delete\('\/checked'/);
});

test('the shopping scope is known and described', () => {
  assert.match(tokensJs, /\n  'shopping',\n/);
  assert.match(tokensJs, /'shopping':\s+"/);
});

test('the app and the API share the naming and aisle rules', () => {
  assert.match(appShoppingJs, /from '\.\.\/lib\/shopping-items\.js'/);
  assert.match(fedJs, /from '\.\.\/\.\.\/\.\.\/lib\/shopping-items\.js'/);
});
