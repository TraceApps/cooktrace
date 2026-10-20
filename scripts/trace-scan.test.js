/**
 * Trace can go through a whole recipe library (TraceApps/notetrace#34, the
 * same fix as NoteTrace's).
 *
 * The report, in NoteTrace: "go through all my notes" ended in "Too many
 * tool call rounds". CookTrace had the same 5 rounds, get_recipes stopped at
 * 100 recipes without saying so, and MCP's search_recipes, list_pantry and
 * list_cook_diary had no way to the next page. Now Trace has 12 rounds and,
 * when they run out, a last request with the tools off answers from what was
 * found; get_recipes pages, finds ingredients too, and read_recipes reads a
 * batch; the MCP lists page.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// The server half runs on a scratch database where better-sqlite3 is built (CI).
let server = null, dir = null;
try {
  createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'cooktrace-trace-scan-'));
  process.env.DB_PATH = join(dir, 'test.db');
  server = {
    db: (await import('../server/db.js')).default,
    search: await import('../server/lib/mcp/tools/search-recipes.js'),
    pantry: await import('../server/lib/mcp/tools/list-pantry.js'),
    diary: await import('../server/lib/mcp/tools/list-cook-diary.js'),
  };
} catch { /* better-sqlite3 not built for this Node: the server half skips */ }
test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

// ── Trace's rounds, against a stand-in provider ─────────────────────────
// Each provider asks for a tool until its request turns the tools off (or
// until `stopAfter` rounds), then answers. `rejectChoice`: an OpenAI-
// compatible server that refuses tool_choice; `ignoreChoice`: one that
// ignores it and asks for a tool anyway, with no text.
let stopAfter = Infinity, rejectChoice = false, rejectStatus = 400, ignoreChoice = false, multi = 1, argPad = '';
const seen = [];
const toolRounds = (b, path) => (path.startsWith('/claude')
  ? (b.messages || []).filter((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')).length
  : path.startsWith('/gemini')
    ? (b.contents || []).filter((c) => c.parts?.some((p) => p.functionResponse)).length
    : (b.messages || []).filter((m) => m.role === 'tool').length);
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const b = JSON.parse(raw || '{}');
    seen.push({ path: req.url, body: b });
    const n = toolRounds(b, req.url);
    let out;
    if (req.url.startsWith('/claude')) {
      out = b.tool_choice?.type === 'none' || n >= stopAfter
        ? { content: [{ type: 'text', text: `answer after ${n}` }], stop_reason: 'end_turn' }
        : { content: Array.from({ length: multi }, (_, k) => ({ type: 'tool_use', id: `t${n}_${k}`, name: 'get_recipes', input: { offset: n * 100 + k, ...(argPad ? { pad: argPad } : {}) } })), stop_reason: 'tool_use' };
    } else if (req.url.startsWith('/gemini')) {
      out = b.toolConfig?.functionCallingConfig?.mode === 'NONE' || n >= stopAfter
        ? { candidates: [{ content: { parts: [{ text: `answer after ${n}` }] }, finishReason: 'STOP' }] }
        : { candidates: [{ content: { parts: Array.from({ length: multi }, () => ({ functionCall: { name: 'get_recipes', args: argPad ? { pad: argPad } : {} } })) }, finishReason: 'STOP' }] };
    } else {
      if (rejectChoice && b.tool_choice) return res.writeHead(rejectStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: "Unsupported value: 'tool_choice' none" } }));
      const answer = (b.tool_choice === 'none' && !ignoreChoice) || n >= stopAfter;
      out = { choices: [{ index: 0, finish_reason: answer ? 'stop' : 'tool_calls', message: answer
        ? { role: 'assistant', content: `answer after ${n}` }
        : { role: 'assistant', content: null, tool_calls: Array.from({ length: multi }, (_, k) => ({ id: `c${n}_${k}`, type: 'function', function: { name: 'get_recipes', arguments: JSON.stringify(argPad ? { pad: argPad } : {}) } })) } }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
  });
});
await new Promise((r) => endpoint.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${endpoint.address().port}`;
test.after(() => endpoint.close());
const _fetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.anthropic.com')) return _fetch(`${ENDPOINT}/claude`, opts);
  if (u.startsWith('https://generativelanguage.googleapis.com')) return _fetch(`${ENDPOINT}/gemini`, opts);
  return _fetch(url, opts);
};
const client = await import('../src/lib/aiChat.js');
let calls = 0, toolResult = [];
client.setToolHandler(async () => { calls++; return toolResult; });
const TOOLS = [client.TOOLS.find((t) => t.name === 'get_recipes')];
const fresh = (o = {}) => { seen.length = 0; calls = 0; stopAfter = o.stopAfter ?? Infinity; rejectChoice = !!o.rejectChoice; rejectStatus = o.rejectStatus ?? 400; ignoreChoice = !!o.ignoreChoice; toolResult = o.toolResult ?? []; multi = o.multi ?? 1; argPad = o.argPad ?? ''; };
const ask = (provider, extra = {}) => client.callAI({
  provider, apiKey: 'k', model: provider === 'custom' ? 'local' : undefined, baseUrl: provider === 'custom' ? ENDPOINT : undefined,
  messages: [{ role: 'user', content: 'Which of my recipes use cilantro?' }], systemPrompt: 'You are Trace.', tools: TOOLS, ...extra,
});
const PROVIDERS = ['custom', 'claude', 'gemini'];
const systemOf = (provider, body) => (provider === 'custom' ? body.messages[0].content : provider === 'claude' ? body.system : body.systemInstruction.parts[0].text);

test('12 rounds of tool calls: a scan that needs 8 finishes', async () => {
  for (const provider of PROVIDERS) {
    fresh({ stopAfter: 8 });
    assert.equal(await ask(provider), 'answer after 8', provider);
    assert.equal(calls, 8);
  }
  assert.equal(client.TOOL_ROUNDS, 12);
  assert.doesNotMatch(read('../src/lib/aiChat.js'), /Too many tool call rounds|MAX_ROUNDS = 5/);
});

test('out of rounds, a last request with the tools off answers from what was found', async () => {
  for (const provider of PROVIDERS) {
    fresh();
    assert.equal(await ask(provider), 'answer after 12', provider);
    assert.equal(calls, 12, `${provider}: 12 rounds of tools`);
    assert.equal(seen.length, 13);
    const last = seen[12].body, before = seen[11].body;
    const system = systemOf(provider, last);
    assert.ok(system.startsWith('You are Trace.') && system.endsWith(client.OUT_OF_ROUNDS), `${provider}: told to answer in the system prompt`);
    // Only the last request is: the rounds before go as they always did.
    assert.equal(systemOf(provider, before), 'You are Trace.');
    if (provider === 'custom') { assert.equal(last.tool_choice, 'none'); assert.ok(last.tools?.length); assert.equal(before.tool_choice, undefined); }
    if (provider === 'claude') { assert.deepEqual(last.tool_choice, { type: 'none' }); assert.ok(last.tools?.length); assert.equal(before.tool_choice, undefined); }
    if (provider === 'gemini') { assert.deepEqual(last.toolConfig, { functionCallingConfig: { mode: 'NONE' } }); assert.equal(before.toolConfig, undefined); }
    // The conversation itself isn't changed: the last message is the tool results.
    if (provider === 'custom') assert.equal(last.messages.at(-1).role, 'tool');
    if (provider === 'claude') assert.equal(last.messages.at(-1).content[0].type, 'tool_result');
    if (provider === 'gemini') assert.ok(last.contents.at(-1).parts[0].functionResponse);
  }
});

test('a server that refuses tool_choice is asked once more without it; one that ignores it still gets an answer said', async () => {
  fresh({ rejectChoice: true, stopAfter: 99 });
  const r = await ask('custom');
  assert.equal(seen.length, 14);
  assert.equal(seen[12].body.tool_choice, 'none');
  assert.equal(seen[13].body.tool_choice, undefined);
  assert.ok(seen[13].body.messages[0].content.endsWith(client.OUT_OF_ROUNDS));
  // That server then asked for a tool again with no text: Trace says why there's no answer.
  assert.match(r, /more steps than one answer allows/);
  fresh({ ignoreChoice: true });
  assert.match(await ask('custom'), /more steps than one answer allows/);
  assert.equal(calls, 12, 'and runs no 13th round of tools');
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.match(en.trace_reply.out_of_rounds, /more steps than one answer allows/);
  // 422 is a refusal too; any other failure is the error it always was, not asked again.
  fresh({ rejectChoice: true, rejectStatus: 422, stopAfter: 99 });
  await ask('custom');
  assert.equal(seen.length, 14);
  fresh({ rejectChoice: true, rejectStatus: 503, stopAfter: 99 });
  await assert.rejects(ask('custom'), /Unsupported value/);
  assert.equal(seen.length, 13);
});

test('an import that needs its tools hears that it stopped early, with what it saved so far', async () => {
  // A cookbook import: one create_recipe a round, and the model keeps going.
  for (const provider of PROVIDERS) {
    fresh();
    let saved = 0;
    await assert.rejects(ask(provider, { toolsRequired: true, onToolResult: () => { saved++; } }), (e) => {
      assert.equal(e.code, client.OUT_OF_ROUNDS_CODE);
      assert.match(e.message, /more steps than one request allows/);
      return true;
    }, provider);
    assert.equal(saved, 12, `${provider}: twelve recipes saved`);
    assert.equal(seen.length, 12, `${provider}: no tools-off request, no answer it would ignore`);
  }
  // The same when the room runs out first.
  fresh({ toolResult: [{ text: 'x'.repeat(200000) }] });
  await assert.rejects(ask('claude', { toolsRequired: true }), { code: client.OUT_OF_ROUNDS_CODE });
  assert.equal(calls, 2);
  assert.match(JSON.parse(read('../src/i18n/en.json')).trace_reply.out_of_rounds_import, /more steps than one request allows/);
  // The dialogs: the cookbook import says "stopped after N recipes" with it (its catch);
  // a single recipe saved before the rounds ran out is kept as saved.
  const cookbook = read('../src/components/recipe/CookbookImportDialog.svelte');
  assert.match(cookbook, /toolsRequired: true,[\s\S]*\} catch \(e\) \{\s*\/\/ If we collected SOME recipes[\s\S]{0,120}if \(createdRecipes\.length > 0\)[\s\S]{0,120}stopped_after/);
  assert.match(read('../src/components/recipe/FileImportDialog.svelte'), /if \(createdRecipe && e\?\.code === OUT_OF_ROUNDS_CODE\) \{ phase = 'done'/);
  assert.match(read('../src/components/recipe/BulkFileImportDialog.svelte'), /if \(!\(aiSaved && e\?\.code === OUT_OF_ROUNDS_CODE\)\) \{/);
});

test('one round of many big answers stops at the room left: the rest are skipped and said', async () => {
  for (const provider of PROVIDERS) {
    // Four calls in one round, each answer 300 kB: the first fills the room.
    fresh({ multi: 4, toolResult: { text: 'x'.repeat(300000) } });
    assert.match(await ask(provider), /^answer after \d$/, provider);
    assert.equal(calls, 1, `${provider}: one ran`);
    assert.equal(seen.length, 2, provider);
    const last = seen[1].body;
    const said = JSON.stringify(last).split(client.TOOL_SKIPPED.replace(/"/g, '\\"')).length - 1;
    assert.equal(said, 3, `${provider}: three told they weren't run`);
    if (provider === 'gemini') assert.deepEqual(last.toolConfig, { functionCallingConfig: { mode: 'NONE' } });
    else assert.ok(last.tool_choice, provider);
    assert.ok(Buffer.byteLength(JSON.stringify(last)) < 1_000_000, `${provider}: ${Buffer.byteLength(JSON.stringify(last))} bytes`);
  }
  // Small answers all run, as before.
  fresh({ multi: 4, stopAfter: 1 });
  await ask('claude');
  assert.equal(calls, 4);
  // Big arguments (a recipe the model wrote) aren't the tools' answers: all of them run.
  for (const provider of PROVIDERS) {
    fresh({ multi: 4, argPad: 'a'.repeat(100000), stopAfter: provider === 'custom' ? 4 : 1 });
    await ask(provider);
    assert.equal(calls, 4, `${provider}: all four ran`);
    assert.ok(!JSON.stringify(seen.map((s) => s.body)).includes('Not run: this answer'), `${provider}: none skipped`);
  }
});

test('a big cookbook import saves every recipe the model writes', async () => {
  // 30 recipes, 10 a round, each 12 kB: the arguments pass 300 kB, the answers are small.
  for (const provider of PROVIDERS) {
    fresh({ multi: 10, argPad: 'r'.repeat(12000), stopAfter: provider === 'custom' ? 30 : 3, toolResult: { ok: true, recipe: { id: 1 } } });
    let saved = 0;
    await ask(provider, { toolsRequired: true, onToolResult: (_n, r) => { if (r?.ok) saved++; } }).catch(() => {});
    assert.equal(saved, 30, `${provider}: every recipe saved`);
  }
});

test('a conversation that gets too big wraps up early the same way', async () => {
  assert.equal(client.HISTORY_MAX_BYTES, 300000);
  for (const provider of PROVIDERS) {
    // Each tool answer is 200 kB: after two, the next request is the last.
    fresh({ toolResult: [{ text: 'x'.repeat(200000) }] });
    assert.equal(await ask(provider), 'answer after 2', provider);
    assert.equal(calls, 2, provider);
    assert.equal(seen.length, 3, provider);
    const [, second, last] = seen.map((s) => s.body);
    if (provider === 'gemini') assert.deepEqual(last.toolConfig, { functionCallingConfig: { mode: 'NONE' } });
    else assert.ok(last.tool_choice, provider);
    assert.equal(second.tool_choice ?? second.toolConfig, undefined, provider);
  }
  // A photo the user attached (a cookbook page, say) doesn't count: only what the tools add does.
  for (const provider of PROVIDERS) {
    fresh({ stopAfter: 4 });
    const photo = { base64: 'A'.repeat(2_000_000), mimeType: 'image/jpeg' };
    const r = await ask(provider, { messages: [{ role: 'user', content: 'Add what this page needs to my shopping list.', _image: photo, ...(provider === 'gemini' ? {} : { content: [{ type: 'text', text: 'Add what this page needs.' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo.base64 } }] }) }] });
    assert.ok(Buffer.byteLength(JSON.stringify(seen[0].body)) > 2_000_000, `${provider}: the photo went with the question`);
    assert.equal(r, 'answer after 4', provider);
    assert.equal(calls, 4, `${provider}: every round the answer needed`);
  }
  // Japanese counts by its bytes, not its characters.
  fresh({ toolResult: [{ text: 'あ'.repeat(70000) }] });
  await ask('claude');
  assert.equal(calls, 2, '70,000 characters of Japanese are 210 kB');
});

// ── Trace's recipe tools ────────────────────────────────────────────────
const recipe = (id, name, extra = {}) => ({
  id, name, description: null, servings: 2, prep_minutes: 5, cook_minutes: 10, rest_minutes: 0, rating: null, favorite: false,
  last_cooked_at: null, cook_count: 0, category: null, tags: [], pantry_match: { have: 1, need: 2 },
  ingredients: [{ name: '', items: [{ qty: '1', unit: 'cup', name: 'rice', note: '' }] }], steps: [{ title: '', text: 'Cook.' }], ...extra,
});

test('get_recipes pages through every match, in the same order every time', async () => {
  const { listRecipes } = await import('../src/lib/trace-recipes.js');
  // Same names, any order in: name then id out, so pages never skip or repeat.
  const all = Array.from({ length: 230 }, (_, i) => recipe(230 - i, i % 2 ? 'Soup' : `Dish ${String(i).padStart(3, '0')}`));
  const first = listRecipes(all, {});
  assert.deepEqual([first.count, first.offset, first.returned, first.next_offset, first.complete], [230, 0, 100, 100, false]);
  assert.equal(first.more, 'This is recipes 1 to 100 of 230: call get_recipes again with offset 100 for the rest.');
  const ids = [];
  for (let page = first; ; page = listRecipes([...all].reverse(), { offset: page.next_offset })) {
    ids.push(...page.recipes.map((r) => r.id));
    if (page.complete) { assert.equal(page.more, undefined); break; }
  }
  assert.equal(new Set(ids).size, 230, 'every recipe, once');
  assert.deepEqual(ids, [...ids].sort((a, b) => {
    const ra = all.find((r) => r.id === a), rb = all.find((r) => r.id === b);
    return ra.name.localeCompare(rb.name, undefined, { sensitivity: 'base' }) || a - b;
  }));
  // Up to 100 a page; past the end, an empty last page.
  assert.equal(listRecipes(all, { limit: 500 }).returned, 100);
  assert.equal(listRecipes(all, { limit: 20 }).returned, 20);
  assert.deepEqual(listRecipes(all, { offset: 999 }).recipes, []);
  // The summary doesn't carry ingredients or steps: get_recipe / read_recipes do.
  assert.equal(first.recipes[0].ingredients, undefined);
});

test('get_recipes finds ingredients too, and says which matched', async () => {
  const { listRecipes } = await import('../src/lib/trace-recipes.js');
  const all = [
    recipe(1, 'Tacos', { ingredients: [{ name: 'Salsa', items: [{ qty: '1', unit: 'bunch', name: 'Cilantro', note: 'chopped' }, { name: 'lime' }] }] }),
    recipe(2, 'Pho', { ingredients: [{ name: '', items: [{ name: 'coriander leaves' }, { name: 'rice noodles' }] }], tags: ['soup'] }),
    recipe(3, 'Cilantro Rice'),
    recipe(4, 'Crème brûlée', { ingredients: [{ name: '', items: [{ name: 'Crème fraîche' }] }] }),
    recipe(5, 'Toast', { ingredients: ['butter'] }),
  ];
  const r = listRecipes(all, { query: 'cilantro' });
  assert.deepEqual(r.recipes.map((x) => x.id), [3, 1]);
  assert.deepEqual(r.recipes.find((x) => x.id === 1).matched_ingredients, ['1 bunch Cilantro (chopped)']);
  assert.equal(r.recipes.find((x) => x.id === 3).matched_ingredients, undefined, 'matched by name');
  // Accents fold, as in the app's search; tags still match; plain-string ingredients too.
  assert.deepEqual(listRecipes(all, { query: 'creme fraiche' }).recipes.map((x) => x.id), [4]);
  assert.deepEqual(listRecipes(all, { query: 'soup' }).recipes.map((x) => x.id), [2]);
  assert.deepEqual(listRecipes(all, { query: 'butter' }).recipes[0].matched_ingredients, ['butter']);
  // A recipe named for it comes before one that only uses it, so a name lookup isn't buried.
  const named = [recipe(8, 'Aioli', { ingredients: ['cilantro'] }), recipe(9, 'Zesty Cilantro Soup'), recipe(10, 'Beans', { ingredients: ['cilantro'] })];
  assert.deepEqual(listRecipes(named, { query: 'cilantro' }).recipes.map((x) => x.id), [9, 8, 10]);
  assert.deepEqual(listRecipes(named, {}).recipes.map((x) => x.id), [8, 10, 9], 'without a query, by name');
  // The allergens the system prompt tells the model about ride along.
  const listed = { contains: ['en:nuts'], traces: ['en:milk'] };
  assert.deepEqual(listRecipes([recipe(11, 'Pesto', { allergens: listed })], {}).recipes[0].allergens, listed);
  // Category and favorite filters stay.
  const cats = [recipe(6, 'A', { category: { name: 'Desserts', slug: 'desserts' }, favorite: true }), recipe(7, 'B', { category: { name: 'Desserts' } })];
  assert.deepEqual(listRecipes(cats, { category: 'desserts' }).recipes.map((x) => x.id), [6, 7]);
  assert.deepEqual(listRecipes(cats, { favorite: true }).recipes.map((x) => x.id), [6]);
  assert.equal(listRecipes(cats, { category: 'desserts' }).recipes[0].category, 'Desserts');
});

test('read_recipes reads a batch in full, within what one answer holds', async () => {
  const { readRecipes } = await import('../src/lib/trace-recipes.js');
  const lib = new Map(Array.from({ length: 30 }, (_, i) => [i + 1, recipe(i + 1, `R${i + 1}`)]));
  const get = async (id) => { if (!lib.has(id)) throw Object.assign(new Error('Recipe not found'), { status: 404 }); return JSON.parse(JSON.stringify(lib.get(id))); };
  const r = await readRecipes(Array.from({ length: 30 }, (_, i) => i + 1), get);
  assert.equal(r.recipes.length, 25);
  assert.deepEqual(r.not_read, [26, 27, 28, 29, 30]);
  assert.match(r.more, /another read_recipes call/);
  assert.deepEqual(r.recipes[0].ingredients, lib.get(1).ingredients);
  assert.deepEqual(r.recipes[0].steps, lib.get(1).steps);
  // A full read works the allergens out (a single recipe from the server or the phone has none on it): the list's shape, never null.
  const nutty = await readRecipes([1], async () => recipe(1, 'Pesto', { ingredients: [{ name: '', items: [{ name: 'pine nuts' }, { name: 'parmesan' }] }] }));
  assert.deepEqual(Object.keys(nutty.recipes[0].allergens).sort(), ['contains', 'traces']);
  assert.ok(nutty.recipes[0].allergens.contains.length > 0, JSON.stringify(nutty.recipes[0].allergens));
  // Within 16,000 characters of JSON; the rest wait, in order; one too big for any call says so.
  const long = (id) => recipe(id, `Long ${id}`, { steps: Array.from({ length: 40 }, (_, k) => ({ title: '', text: `Step ${k} ${'s'.repeat(200)}` })) });
  lib.set(101, long(101)); lib.set(102, long(102)); lib.set(103, recipe(103, 'Short'));
  lib.set(104, recipe(104, 'Huge', { steps: Array.from({ length: 200 }, (_, k) => ({ title: '', text: `Step ${k} ${'h'.repeat(200)}` })) }));
  const b = await readRecipes([101, 102, 103], get);
  assert.deepEqual([b.recipes.map((x) => x.id), b.not_read], [[101], [102, 103]]);
  assert.ok(JSON.stringify(b.recipes).length <= 16000);
  const h = await readRecipes([104, 103], get);
  assert.deepEqual(h.recipes[0], { id: 104, name: 'Huge', too_long: 'Too long to read along with others: read it with get_recipe.' });
  assert.equal(h.recipes[1].id, 103);
  // Not found, the same id twice, none at all, and a failure that isn't "not found".
  const odd = await readRecipes([1, 1, 777], get);
  assert.deepEqual([odd.recipes.map((x) => x.id), odd.not_found], [[1], [777]]);
  assert.match((await readRecipes([], get)).error, /ids is required/);
  const offline = async (id) => { if (id === 2) throw new Error('This needs a connection'); return get(id); };
  const f = await readRecipes([1, 2, 3], offline);
  assert.deepEqual([f.recipes.map((x) => x.id), f.not_found, f.failed], [[1, 3], undefined, [{ id: 2, error: 'This needs a connection' }]]);
  // Android connected mode's server fallback carries the status, so a recipe that's gone is not found there too.
  assert.match(read('../src/lib/api-cached.js'), /throw Object\.assign\(new Error\(`HTTP \$\{res\.status\}`\), \{ status: res\.status \}\)/);
  // Android's own database answers a missing recipe with nothing at all.
  const native = async (id) => (lib.has(id) ? lib.get(id) : null);
  assert.deepEqual((await readRecipes([1, 555], native)).not_found, [555]);
});

test('Trace offers the tools and is told how to go through a whole library', () => {
  const names = client.TOOLS.map((t) => t.name);
  assert.ok(names.includes('read_recipes'));
  const gr = client.TOOLS.find((t) => t.name === 'get_recipes');
  assert.equal(gr.parameters.properties.offset.type, 'integer');
  assert.equal(gr.parameters.properties.limit.type, 'integer');
  assert.deepEqual(client.TOOLS.find((t) => t.name === 'read_recipes').parameters.properties.ids.items, { type: 'integer' });
  const trace = read('../src/components/ai/Trace.svelte');
  assert.match(trace, /case 'get_recipes':[\s\S]{0,200}listRecipes\(/);
  assert.match(trace, /case 'read_recipes':[\s\S]{0,200}readRecipes\(/);
  assert.match(trace, /page through get_recipes with offset until complete is true/);
});

// ── MCP lists page too ──────────────────────────────────────────────────
// The tool's handler, as the MCP server would call it.
const handlerOf = (register) => {
  let fn = null;
  register({ registerTool: (_n, _d, h) => { fn = h; } }, { userId: 1 });
  return async (args) => JSON.parse((await fn(args)).content[0].text);
};

test('MCP search_recipes, list_pantry and list_cook_diary page through everything', { skip: !server && 'needs better-sqlite3' }, async () => {
  const { db } = server;
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (1, 'alice', 'x')").run();
  const insR = db.prepare('INSERT INTO recipes (user_id, name, description) VALUES (1, ?, ?)');
  for (let i = 0; i < 70; i++) insR.run(i % 3 ? `Soup ${i}` : 'Stew', 'A pot of something');
  const insP = db.prepare('INSERT INTO pantry_items (user_id, name, in_stock) VALUES (1, ?, 1)');
  for (let i = 0; i < 130; i++) insP.run(i % 2 ? 'Salt' : `Spice ${i}`);
  const rid = db.prepare('SELECT id FROM recipes LIMIT 1').get().id;
  const insD = db.prepare("INSERT INTO cook_diary (user_id, recipe_id, date, kind) VALUES (1, ?, ?, 'cooked')");
  for (let i = 0; i < 120; i++) insD.run(rid, `2026-0${1 + (i % 9)}-15`);

  const pageAll = async (call, args, limit) => {
    const ids = [];
    let page = { next_offset: 0 };
    let n = 0;
    while (page.next_offset != null) {
      page = await call({ ...args, limit, offset: page.next_offset });
      ids.push(...page.items.map((x) => x.id));
      if (++n > 50) throw new Error('never finished');
    }
    return { ids, last: page };
  };
  const search = handlerOf(server.search.registerSearchRecipes);
  const one = await search({ query: 'something', limit: 50 });
  // count stays what one page holds, as before; total is every match.
  assert.deepEqual([one.count, one.total, one.offset, one.next_offset, one.complete], [50, 70, 0, 50, false]);
  // Said without naming a tool: the REST API shares these words.
  assert.equal(one.more, 'This is 1 to 50 of 70: ask again with offset 50 for the rest.');
  const s = await pageAll(search, { query: 'something' }, 50);
  assert.equal(new Set(s.ids).size, 70);
  assert.equal(s.last.complete, true);
  // Without a query: every recipe.
  assert.equal((await search({})).total, 70);

  const pantry = handlerOf(server.pantry.registerListPantry);
  const p = await pageAll(pantry, {}, 100);
  assert.deepEqual([p.ids.length, new Set(p.ids).size], [130, 130]);

  const diary = handlerOf(server.diary.registerListCookDiary);
  const d = await pageAll(diary, {}, 100);
  assert.deepEqual([d.ids.length, new Set(d.ids).size], [120, 120]);
  // The public REST API shares the diary lookup: the same fields, nothing taken away.
  const core = server.diary.listCookDiaryCore(1, { limit: 5 });
  assert.deepEqual([core.count, core.limit, core.total, core.items.length], [5, 5, 120, 5]);
});
