/**
 * Static-analysis tests for the MCP endpoint wiring.
 *
 * These do not exercise the wire protocol; they only guard against
 * accidental unwiring of the route mount, the scope registration, or
 * the tool registrations during future refactors. End-to-end protocol
 * verification is done by running the server with MCP_ENABLED=1 and
 * pointing a real MCP client at it (docs/cooktrace/mcp.md covers setup).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexJs   = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const mcpRoute  = readFileSync(new URL('../server/routes/mcp.js', import.meta.url), 'utf8');
const mcpServer = readFileSync(new URL('../server/lib/mcp/server.js', import.meta.url), 'utf8');
const mcpTools  = readFileSync(new URL('../server/lib/mcp/tools/index.js', import.meta.url), 'utf8');
const apiTokens = readFileSync(new URL('../server/lib/api-tokens.js', import.meta.url), 'utf8');
const pkgJson   = JSON.parse(readFileSync(new URL('../server/package.json', import.meta.url), 'utf8'));

test('MCP route is mounted at /api/mcp on the main router', () => {
  assert.match(indexJs, /import mcpRoutes[\s\S]*from '\.\/routes\/mcp\.js'/);
  assert.match(indexJs, /router\.use\('\/api\/mcp',\s*mcpRoutes\)/);
});

test('API tokens admin route is mounted at /api/admin/api-tokens', () => {
  assert.match(indexJs, /import apiTokensRoutes[\s\S]*from '\.\/routes\/api-tokens\.js'/);
  assert.match(indexJs, /router\.use\('\/api\/admin\/api-tokens',\s*apiTokensRoutes\)/);
});

test('MCP route is feature-flagged on MCP_ENABLED and requires bearer + at-least-one mcp:* scope', () => {
  assert.match(mcpRoute, /MCP_ENABLED/);
  assert.match(mcpRoute, /bearerAuth/);
  // Any-of-mcp:* check: route-level gate accepts read, write, OR destroy
  // (so a write-only or destroy-only token isn't unusable). Per-tool
  // scope enforcement happens at registration time.
  assert.match(mcpRoute, /requireAnyMcpScope/);
  assert.match(mcpRoute, /'mcp:read'/);
  assert.match(mcpRoute, /'mcp:write'/);
  assert.match(mcpRoute, /'mcp:destroy'/);
});

test('MCP route validates Origin as a DNS-rebinding defense', () => {
  assert.match(mcpRoute, /_isOriginAllowed|Origin not allowed|origin_rejected/);
});

test('mcp:read scope is registered in KNOWN_SCOPES so tokens can hold it', () => {
  assert.match(apiTokens, /'mcp:read'/);
});

test('mcp:write scope is registered', () => {
  assert.match(apiTokens, /'mcp:write'/);
});

test('mcp:destroy scope is registered', () => {
  assert.match(apiTokens, /'mcp:destroy'/);
});

test('every KNOWN_SCOPES entry has a matching SCOPE_DESCRIPTIONS entry and vice versa', () => {
  // Locate each block by its declaration, not by the first textual
  // mention of the name — both blocks' own doc-comments reference the
  // other by name, so a naive indexOf(name) lands mid-comment.
  const descBlock  = apiTokens.slice(
    apiTokens.indexOf('SCOPE_DESCRIPTIONS = {'),
    apiTokens.indexOf('};', apiTokens.indexOf('SCOPE_DESCRIPTIONS = {'))
  );
  const knownBlock = apiTokens.slice(
    apiTokens.indexOf('KNOWN_SCOPES = new Set(['),
    apiTokens.indexOf(']);', apiTokens.indexOf('KNOWN_SCOPES = new Set(['))
  );
  const descScopes  = new Set([...descBlock.matchAll(/'([a-z]+:[a-z]+)':/g)].map(m => m[1]));
  const knownScopes = new Set([...knownBlock.matchAll(/'([a-z]+:[a-z]+)'/g)].map(m => m[1]));
  assert.ok(descScopes.size > 0, 'no scopes found in SCOPE_DESCRIPTIONS — block boundaries may be wrong');
  assert.ok(knownScopes.size > 0, 'no scopes found in KNOWN_SCOPES — block boundaries may be wrong');
  for (const s of knownScopes) {
    assert.ok(descScopes.has(s), `${s} is in KNOWN_SCOPES but missing from SCOPE_DESCRIPTIONS`);
  }
  for (const s of descScopes) {
    assert.ok(knownScopes.has(s), `${s} is in SCOPE_DESCRIPTIONS but missing from KNOWN_SCOPES`);
  }
});

test('MCP route computes write eligibility from MCP_WRITE_ENABLED + mcp:write scope', () => {
  assert.match(mcpRoute, /MCP_WRITE_ENABLED/);
  assert.match(mcpRoute, /mcp:write/);
  assert.match(mcpRoute, /req\.mcpWrites/);
});

test('MCP route computes destroy eligibility from MCP_DESTROY_ENABLED + mcp:destroy scope', () => {
  assert.match(mcpRoute, /MCP_DESTROY_ENABLED/);
  assert.match(mcpRoute, /mcp:destroy/);
  assert.match(mcpRoute, /req\.mcpDestroy/);
});

test('MCP server registers write tools only when req.mcpWrites is true', () => {
  assert.match(mcpServer, /registerWriteTools/);
  assert.match(mcpServer, /req\.mcpWrites/);
});

test('MCP server registers destroy tools only when req.mcpDestroy is true', () => {
  assert.match(mcpServer, /registerDestroyTools/);
  assert.match(mcpServer, /req\.mcpDestroy/);
});

test('MCP transport is stateless (no session id generator)', () => {
  assert.match(mcpServer, /sessionIdGenerator:\s*undefined/);
});

test('All read tools are registered', () => {
  const expected = [
    'registerSearchRecipes',
    'registerGetRecipe',
    'registerRecentRecipes',
    'registerListPantry',
    'registerListShoppingList',
    'registerListCookDiary',
  ];
  for (const fn of expected) {
    assert.match(mcpTools, new RegExp(`\\b${fn}\\s*\\(`), `expected ${fn}() call in tools/index.js`);
  }
});

test('All write tools are registered in registerWriteTools', () => {
  const expected = [
    'registerLogCook',
    'registerAddShoppingItem',
    'registerCheckShoppingItem',
    'registerUpdatePantryStock',
  ];
  for (const fn of expected) {
    assert.match(mcpTools, new RegExp(`\\b${fn}\\s*\\(`), `expected ${fn}() call in tools/index.js`);
  }
});

test('All destructive tools are registered in registerDestroyTools', () => {
  const expected = [
    'registerCreateRecipe',
    'registerAddPantryItem',
    'registerDeleteCookDiaryEntry',
    'registerRemoveShoppingItem',
  ];
  for (const fn of expected) {
    assert.match(mcpTools, new RegExp(`\\b${fn}\\s*\\(`), `expected ${fn}() call in tools/index.js`);
  }
});

test('Every destructive tool requires confirm=true', () => {
  const destroyFiles = [
    'create-recipe.js',
    'add-pantry-item.js',
    'delete-cook-diary-entry.js',
    'remove-shopping-item.js',
  ];
  for (const f of destroyFiles) {
    const src = readFileSync(new URL(`../server/lib/mcp/tools/${f}`, import.meta.url), 'utf8');
    assert.match(
      src,
      /confirm\s*!==\s*true/,
      `${f} does not appear to require confirm=true — check its input handling`
    );
    assert.match(
      src,
      /confirm:\s*z\.boolean\(\)/,
      `${f} does not declare confirm as a boolean in inputSchema`
    );
  }
});

test('@modelcontextprotocol/sdk and zod are declared as runtime dependencies', () => {
  const deps = pkgJson.dependencies || {};
  assert.ok(deps['@modelcontextprotocol/sdk'], 'missing @modelcontextprotocol/sdk in dependencies');
  assert.ok(deps['zod'], 'missing zod (SDK peer + used for tool inputSchema) in dependencies');
});

test('MCP tool DB queries scope on user_id — no cross-user access', () => {
  // Every tool that queries the DB directly must filter by user_id,
  // with one deliberate exception: log-cook.js's initial recipe lookup
  // is unscoped in SQL on purpose, mirroring POST /api/recipes/:id/cooked
  // exactly — it fetches the recipe regardless of owner, then checks
  // `recipe.user_id === userId || recipe.visibility === 'group'` in JS,
  // which is what lets logging a cook against a Kitchen-shared recipe
  // work at all. Its own write (the actual cook_diary INSERT) is scoped.
  const toolFiles = [
    'search-recipes.js',
    'get-recipe.js',
    'recent-recipes.js',
    'list-pantry.js',
    'list-shopping-list.js',
    'list-cook-diary.js',
    'add-shopping-item.js',
    'check-shopping-item.js',
    'update-pantry-stock.js',
    'create-recipe.js',
    'add-pantry-item.js',
    'delete-cook-diary-entry.js',
    'remove-shopping-item.js',
  ];
  for (const f of toolFiles) {
    const src = readFileSync(new URL(`../server/lib/mcp/tools/${f}`, import.meta.url), 'utf8');
    if (/db\.prepare|\.get\(|\.all\(|\.run\(/.test(src)) {
      // Either a WHERE-clause equality (reads/updates/deletes) or a
      // plain INSERT that carries user_id in its column list (creates
      // have no existing row to filter, so ownership comes from what
      // gets written, not a WHERE clause).
      assert.match(
        src,
        /user_id\s*=\s*\?|INSERT INTO \w+\s*\([^)]*\buser_id\b/i,
        `${f} queries the DB but does not appear to scope on user_id`
      );
    }
  }
});

test('log_cook checks recipe ownership/visibility before writing, and its INSERT is user-scoped', () => {
  const src = readFileSync(new URL('../server/lib/mcp/tools/log-cook.js', import.meta.url), 'utf8');
  assert.match(src, /recipe\.user_id\s*!==\s*userId/, 'expected an explicit ownership check before use');
  assert.match(src, /visibility\s*!==\s*'group'/, "expected the Kitchen-shared 'group' visibility exception");
  assert.match(src, /INSERT INTO cook_diary[\s\S]*user_id/i, 'the actual write must still be scoped to the caller');
});
