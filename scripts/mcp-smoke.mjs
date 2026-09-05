#!/usr/bin/env node
/**
 * scripts/mcp-smoke.mjs — end-to-end MCP smoke test.
 *
 * Usage:
 *   node scripts/mcp-smoke.mjs <BASE_URL> <MCP_TOKEN>
 *   node scripts/mcp-smoke.mjs <BASE_URL> <MCP_TOKEN> --writes
 *   node scripts/mcp-smoke.mjs <BASE_URL> <MCP_TOKEN> --writes --destroy
 *
 * Reads-only mode:  token must hold `mcp:read` (default).
 * Writes mode:      add `--writes`; token must ALSO hold `mcp:write`
 *                   and MCP_WRITE_ENABLED=1 on the server. Tests
 *                   log_cook against a real recipe_id looked up from
 *                   this instance's own library via search_recipes,
 *                   add_shopping_item, check_shopping_item, and
 *                   update_pantry_stock (all additive/reversible in
 *                   the UI).
 * Destroy mode:     add `--destroy`; token must ALSO hold `mcp:destroy`
 *                   and MCP_DESTROY_ENABLED=1. Tests confirm=false
 *                   rejection only, so no real data is mutated by the
 *                   smoke script itself.
 *
 * Prints one line per check with PASS / FAIL. Exits non-zero if any
 * check failed. Negative-path checks (401 / 403) are required — if they
 * pass, auth or origin gating is broken.
 */

const argv = process.argv.slice(2);
const WRITE_MODE   = argv.includes('--writes');
const DESTROY_MODE = argv.includes('--destroy');
const positional = argv.filter(a => !a.startsWith('--'));
const [BASE, TOKEN] = positional;
if (!BASE || !TOKEN) {
  console.error('usage: node scripts/mcp-smoke.mjs <BASE_URL> <MCP_TOKEN> [--writes] [--destroy]');
  process.exit(2);
}

const URL_ = BASE.replace(/\/+$/, '') + '/api/mcp';
const HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

let pass = 0;
let fail = 0;
let id = 0;

function line(status, label, detail = '') {
  const tag = status === 'PASS' ? '\x1b[32mPASS\x1b[0m'
            : status === 'FAIL' ? '\x1b[31mFAIL\x1b[0m'
            : '\x1b[33mSKIP\x1b[0m';
  console.log(`  ${tag}  ${label}${detail ? '  ' + detail : ''}`);
  if (status === 'PASS') pass++;
  else if (status === 'FAIL') fail++;
}

async function mcp(method, params) {
  const body = { jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) };
  const r = await fetch(URL_, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  // Streamable HTTP replies can be application/json OR text/event-stream.
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    // Take the last `data:` frame; SDK typically emits one for stateless.
    const lines = text.split('\n').filter(l => l.startsWith('data:'));
    const last = lines[lines.length - 1] || '';
    try { json = JSON.parse(last.slice(5).trim()); } catch { /* keep null */ }
  } else {
    try { json = JSON.parse(text); } catch { /* keep null */ }
  }
  return { status: r.status, json, raw: text };
}

async function callTool(name, args = {}) {
  return mcp('tools/call', { name, arguments: args });
}

console.log(`\n\x1b[1mMCP smoke test\x1b[0m  ${URL_}\n`);

// --- Handshake ---
{
  const r = await mcp('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'ct-smoke', version: '1' },
  });
  const info = r.json?.result?.serverInfo;
  if (r.status === 200 && info?.name === 'cooktrace') {
    line('PASS', `initialize`, `serverInfo=${info.name}@${info.version}`);
  } else {
    line('FAIL', `initialize`, `status=${r.status} body=${r.raw.slice(0, 200)}`);
  }
}

// --- tools/list ---
const READ_TOOLS = [
  'search_recipes',
  'get_recipe',
  'recent_recipes',
  'list_pantry',
  'list_shopping_list',
  'list_cook_diary',
];
const WRITE_TOOLS = ['log_cook', 'add_shopping_item', 'check_shopping_item', 'update_pantry_stock'];
const DESTROY_TOOLS = ['create_recipe', 'add_pantry_item', 'delete_cook_diary_entry', 'remove_shopping_item'];
const expected = new Set([
  ...READ_TOOLS,
  ...(WRITE_MODE   ? WRITE_TOOLS   : []),
  ...(DESTROY_MODE ? DESTROY_TOOLS : []),
]);
{
  const r = await mcp('tools/list');
  const tools = r.json?.result?.tools || [];
  const names = new Set(tools.map(t => t.name));
  const missing = [...expected].filter(n => !names.has(n));
  const leaked = [];
  if (!WRITE_MODE)   leaked.push(...WRITE_TOOLS.filter(n => names.has(n)));
  if (!DESTROY_MODE) leaked.push(...DESTROY_TOOLS.filter(n => names.has(n)));
  if (r.status === 200 && missing.length === 0 && leaked.length === 0) {
    line('PASS', `tools/list`, `${tools.length} tools`);
  } else {
    const notes = [];
    if (missing.length) notes.push(`missing=[${missing.join(',')}]`);
    if (leaked.length)  notes.push(`gated tools leaked: [${leaked.join(',')}]`);
    line('FAIL', `tools/list`, `status=${r.status} ${notes.join(' ')}`);
  }
}

// --- Each read tool ---
// Tools whose output legitimately depends on this instance's own data
// (a recipe existing, a pantry item existing) accept either a clean
// structuredContent OR a clean isError — both mean "the tool ran
// correctly", since a fresh/empty install has no recipes yet either.
async function checkTool(name, args, resultKey, note) {
  const r = await callTool(name, args);
  const sc = r.json?.result?.structuredContent;
  if (r.status === 200 && sc && (resultKey ? resultKey in sc : true)) {
    const preview = resultKey ? JSON.stringify(sc[resultKey]).slice(0, 80) : '';
    line('PASS', name, note ? `${note} ${preview}` : preview);
  } else if (r.status === 200 && r.json?.result?.isError) {
    line('FAIL', name, `tool returned isError: ${r.json.result.content?.[0]?.text}`);
  } else {
    line('FAIL', name, `status=${r.status} body=${r.raw.slice(0, 200)}`);
  }
}

let _writeRecipeId = null;
let _writeShoppingId = null;
let _writePantryId = null;

{
  const search = await callTool('search_recipes', { query: 'a', limit: 1 });
  _writeRecipeId = search.json?.result?.structuredContent?.items?.[0]?.id;
  await checkTool('search_recipes', { query: 'a', limit: 3 }, 'items', '(q=a)');
}
if (_writeRecipeId) {
  await checkTool('get_recipe', { recipe_id: _writeRecipeId }, 'id', `(recipe_id=${_writeRecipeId})`);
} else {
  line('SKIP', 'get_recipe', 'no recipe found in this instance\'s library to look up');
}
await checkTool('recent_recipes',    { limit: 3 }, 'items');
{
  const pantry = await callTool('list_pantry', { limit: 1 });
  _writePantryId = pantry.json?.result?.structuredContent?.items?.[0]?.id;
  await checkTool('list_pantry', { limit: 3 }, 'items');
}
{
  const shopping = await callTool('list_shopping_list', {});
  _writeShoppingId = shopping.json?.result?.structuredContent?.items?.[0]?.id;
  await checkTool('list_shopping_list', {}, 'items');
}
await checkTool('list_cook_diary', { limit: 3 }, 'items');

// --- Write tools (opt-in with --writes) ---
if (WRITE_MODE) {
  if (_writeRecipeId) {
    await checkTool('log_cook', { recipe_id: _writeRecipeId }, 'ok', `(recipe_id=${_writeRecipeId})`);
  } else {
    line('SKIP', 'log_cook', 'no recipe found in this instance\'s library to log against');
  }

  const added = await callTool('add_shopping_item', { name: 'MCP Smoke Test Item' });
  const addedId = added.json?.result?.structuredContent?.added?.item_id;
  if (addedId) {
    line('PASS', 'add_shopping_item', `(item_id=${addedId})`);
    await checkTool('check_shopping_item', { item_id: addedId, checked: true }, 'ok', `(item_id=${addedId})`);
  } else {
    line('FAIL', 'add_shopping_item', `status=${added.status} body=${added.raw.slice(0, 200)}`);
  }

  if (_writePantryId) {
    await checkTool('update_pantry_stock', { item_id: _writePantryId, in_stock: true }, 'ok', `(item_id=${_writePantryId})`);
  } else {
    line('SKIP', 'update_pantry_stock', 'no pantry item found in this instance to update');
  }
}

// --- Destructive tools (opt-in with --destroy) ---
// Confirm-refusal path only — no real data is mutated by the smoke
// script itself, since the confirm check runs before any DB query.
if (DESTROY_MODE) {
  {
    const r = await callTool('create_recipe', {
      name: 'MCP Smoke Test Recipe', ingredients: [{ name: 'x' }], steps: ['x'], confirm: false,
    });
    const err = r.json?.result?.isError;
    const msg = r.json?.result?.content?.[0]?.text || '';
    if (err && /confirm/i.test(msg)) line('PASS', 'create_recipe (no confirm → refused)');
    else                             line('FAIL', 'create_recipe (no confirm)', `err=${err} msg=${msg.slice(0, 60)}`);
  }
  {
    const r = await callTool('add_pantry_item', { name: 'MCP Smoke Test Item', confirm: false });
    const err = r.json?.result?.isError;
    const msg = r.json?.result?.content?.[0]?.text || '';
    if (err && /confirm/i.test(msg)) line('PASS', 'add_pantry_item (no confirm → refused)');
    else                             line('FAIL', 'add_pantry_item (no confirm)', `err=${err} msg=${msg.slice(0, 60)}`);
  }
  {
    const r = await callTool('delete_cook_diary_entry', { entry_id: 999999999, confirm: false });
    const err = r.json?.result?.isError;
    const msg = r.json?.result?.content?.[0]?.text || '';
    if (err && /confirm/i.test(msg)) line('PASS', 'delete_cook_diary_entry (no confirm → refused)');
    else                             line('FAIL', 'delete_cook_diary_entry (no confirm)', `err=${err} msg=${msg.slice(0, 60)}`);
  }
  {
    const r = await callTool('remove_shopping_item', { item_id: 999999999, confirm: false });
    const err = r.json?.result?.isError;
    const msg = r.json?.result?.content?.[0]?.text || '';
    if (err && /confirm/i.test(msg)) line('PASS', 'remove_shopping_item (no confirm → refused)');
    else                             line('FAIL', 'remove_shopping_item (no confirm)', `err=${err} msg=${msg.slice(0, 60)}`);
  }
}

// --- Negative: no bearer → 401 ---
{
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list' }),
  });
  if (r.status === 401) line('PASS', 'no-bearer → 401');
  else                  line('FAIL', 'no-bearer → 401', `got ${r.status}`);
}

// --- Negative: disallowed origin → 403 ---
{
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { ...HEADERS, origin: 'https://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 998, method: 'tools/list' }),
  });
  if (r.status === 403) line('PASS', 'bad-origin → 403');
  else                  line('FAIL', 'bad-origin → 403', `got ${r.status}`);
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
