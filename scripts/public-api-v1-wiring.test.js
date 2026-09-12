/**
 * Static-analysis tests for the general public REST API wiring
 * (/api/v1/cook-diary, /api/v1/shopping, /api/v1/pantry write-parity).
 *
 * These do not exercise real HTTP requests; they guard against
 * accidental unwiring of the route mounts, the feature flags, or a
 * route calling something other than the shared xCore function during
 * future refactors. Pure text/regex checks over the source files, no
 * db.js import, so this runs without a compiled better-sqlite3 native
 * binding. Real verification requires a running dev server with
 * PUBLIC_API_ENABLED=1 and a curl/http client against it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexJs       = readFileSync(new URL('../server/routes/api/v1/index.js', import.meta.url), 'utf8');
const cookDiaryJs    = readFileSync(new URL('../server/routes/api/v1/cook-diary.js', import.meta.url), 'utf8');
const shoppingJs     = readFileSync(new URL('../server/routes/api/v1/shopping.js', import.meta.url), 'utf8');
const pantryWriteJs  = readFileSync(new URL('../server/routes/api/v1/pantry-write.js', import.meta.url), 'utf8');
const pantryJs       = readFileSync(new URL('../server/routes/api/v1/pantry.js', import.meta.url), 'utf8');
const recipesFedJs   = readFileSync(new URL('../server/routes/api/v1/recipes.js', import.meta.url), 'utf8');
const apiTokensJs    = readFileSync(new URL('../server/lib/api-tokens.js', import.meta.url), 'utf8');

test('cook-diary/shopping/pantry-write sub-routers are mounted under /api/v1/index.js', () => {
  assert.match(indexJs, /import cookDiaryRouter from '\.\/cook-diary\.js'/);
  assert.match(indexJs, /import shoppingRouter from '\.\/shopping\.js'/);
  assert.match(indexJs, /import pantryWriteRouter from '\.\/pantry-write\.js'/);
  assert.match(indexJs, /router\.use\('\/cook-diary',\s*cookDiaryRouter\)/);
  assert.match(indexJs, /router\.use\('\/shopping',\s*shoppingRouter\)/);
  assert.match(indexJs, /router\.use\('\/pantry',\s*pantryWriteRouter\)/);
});

test('each new sub-router is feature-flagged on PUBLIC_API_ENABLED', () => {
  for (const [name, src] of [['cook-diary.js', cookDiaryJs], ['shopping.js', shoppingJs], ['pantry-write.js', pantryWriteJs]]) {
    assert.match(src, /PUBLIC_API_ENABLED/, `${name} should check PUBLIC_API_ENABLED`);
  }
});

test('existing federation sub-routers (recipes, pantry) are untouched by the new flag', () => {
  for (const [name, src] of [['recipes.js', recipesFedJs], ['pantry.js', pantryJs]]) {
    assert.doesNotMatch(src, /PUBLIC_API_ENABLED/, `${name} should not gain the new base flag`);
  }
});

test('write routes require PUBLIC_API_WRITE_ENABLED independent of the base flag', () => {
  for (const [name, src] of [['cook-diary.js', cookDiaryJs], ['shopping.js', shoppingJs], ['pantry-write.js', pantryWriteJs]]) {
    assert.match(src, /PUBLIC_API_WRITE_ENABLED/, `${name} should check PUBLIC_API_WRITE_ENABLED`);
    assert.match(src, /requireWriteEnabled/, `${name} should use requireWriteEnabled`);
  }
});

test('every route reuses mcp:read/mcp:write, no new api:* scope introduced', () => {
  const combined = cookDiaryJs + shoppingJs + pantryWriteJs;
  assert.match(combined, /requireScope\('mcp:read'\)/);
  assert.match(combined, /requireScope\('mcp:write'\)/);
  assert.doesNotMatch(combined, /'api:read'|'api:write'|"api:read"|"api:write"/);
});

test('no DELETE route exists yet (destroy parity deliberately deferred)', () => {
  for (const src of [cookDiaryJs, shoppingJs, pantryWriteJs]) {
    assert.doesNotMatch(src, /router\.delete\(/);
  }
});

test('each route calls a shared xCore function rather than a fresh db.prepare', () => {
  for (const [name, src] of [['cook-diary.js', cookDiaryJs], ['shopping.js', shoppingJs], ['pantry-write.js', pantryWriteJs]]) {
    assert.doesNotMatch(src, /db\.prepare/, `${name} should not query the DB directly, only via xCore imports`);
  }
  assert.match(cookDiaryJs, /listCookDiaryCore/);
  assert.match(cookDiaryJs, /logCookCore/);
  assert.match(shoppingJs, /listShoppingListCore/);
  assert.match(shoppingJs, /checkShoppingItemCore/);
  assert.match(pantryWriteJs, /updatePantryStockCore/);
});

test('SCOPE_DESCRIPTIONS mentions the /api/v1 routes alongside MCP for mcp:read and mcp:write', () => {
  const desc = apiTokensJs.match(/SCOPE_DESCRIPTIONS = \{([\s\S]*?)\n\};/)[1];
  assert.match(desc, /\/api\/v1/);
});
