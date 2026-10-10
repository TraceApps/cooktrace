/**
 * Trace still answers when the model can't use tools (TraceApps/nutritrace#259).
 *
 * An OpenAI-compatible endpoint refused every request carrying `tools` for a
 * model without tool support, and Trace failed with the refusal. CookTrace
 * sends tools from the app's direct call (a personal setup): the chat, and
 * the recipe imports, which save the recipe through a tool. The server's
 * chat proxy sends no tools, so it is not affected. These run the direct
 * call against a stand-in endpoint that refuses tools as the report shows.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NO_TOOLS_NOTE } from '../src/lib/tool-support.js';

const upstream = { error_type: 'TOOL_USE_NOT_SUPPORTED', id: '2d1b4ad3-1622-4732-92b7-096410d39b1a', message: 'invalid request: tool use is not supported by the provided model: command-a-vision-07-2025' };
const REFUSAL = [400, { error: { message: `[400]: ${JSON.stringify(upstream)}` } }];
const reply = (message) => [200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', ...message } }] }];
const toolless = (b) => (b.tools ? REFUSAL : reply({ content: 'Answer without tools.' }));
let answer = toolless;
const seen = [];
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    seen.push(body);
    const [status, data] = answer(body);
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  });
});
await new Promise(r => endpoint.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${endpoint.address().port}`;
test.after(() => endpoint.close());
const fresh = (fn) => { seen.length = 0; answer = fn; };
const toldNoTools = (body) => body.messages[0].role === 'system' && body.messages[0].content.endsWith(`\n\n${NO_TOOLS_NOTE}`);

const client = await import('../src/lib/aiChat.js');
client.setToolHandler(async (name) => ({ ok: true, name }));
const direct = (model, extra = {}) => client.callAI({
  provider: 'oai-compat', baseUrl: ENDPOINT, model, apiKey: '',
  messages: [{ role: 'user', content: 'What can I cook tonight?' }], systemPrompt: 'You are Trace.',
  tools: client.TOOLS, ...extra,
});

test('chat: a model that refuses tools answers without them, and Trace is told', async () => {
  fresh(toolless);
  let told = 0;
  const info = [];
  assert.equal(await direct('command-a-vision-07-2025', { onToolsUnsupported: (i) => { told++; info.push(i); } }), 'Answer without tools.');
  assert.equal(told, 1);
  assert.deepEqual(info, [{ routed: false }]);
  assert.equal(seen.length, 2);
  assert.ok(seen[0].tools && !seen[1].tools);
  assert.ok(!toldNoTools(seen[0]) && toldNoTools(seen[1]), 'the retry tells the model no tools are available');

  fresh(toolless);
  assert.equal(await direct('command-a-vision-07-2025', { onToolsUnsupported: () => told++ }), 'Answer without tools.');
  assert.equal(told, 2);
  assert.equal(seen.length, 1, 'the next message skips the doomed first attempt');
});

test('chat: a combo model is asked again without tools, not remembered, and Trace is told it was routed', async () => {
  const told = [];
  for (let i = 0; i < 2; i++) {
    fresh(toolless);
    assert.equal(await direct('my-20-model-combo', { onToolsUnsupported: (x) => told.push(x) }), 'Answer without tools.');
    assert.equal(seen.length, 2, 'tools are offered again: the next pick may take them');
  }
  assert.deepEqual(told, [{ routed: true }, { routed: true }]);
});

test("the legacy 'custom' provider name gets the same", async () => {
  fresh(toolless);
  const r = await client.callAI({
    provider: 'custom', baseUrl: ENDPOINT, model: 'custom-toolless', apiKey: '',
    messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'You are Trace.', tools: client.TOOLS,
  });
  assert.equal(r, 'Answer without tools.');
});

test('chat: an unrelated 400 still fails, after one request', async () => {
  fresh(() => [400, { error: { message: 'Invalid API key format' } }]);
  await assert.rejects(direct('another-model'), /Invalid API key format/);
  assert.equal(seen.length, 1);
});

test('chat: a model that takes tools still uses them', async () => {
  fresh((b) => (b.messages.some(m => m.role === 'tool')
    ? reply({ content: 'Make the pasta.' })
    : reply({ content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_pantry', arguments: '{}' } }] })));
  let told = 0;
  assert.equal(await direct('model-with-tools', { onToolsUnsupported: () => told++ }), 'Make the pasta.');
  assert.equal(told, 0);
  assert.equal(seen.length, 2);
  assert.ok(seen.every(b => b.tools?.length));
});

test('chat: a gateway that turns tool-less mid-answer gets the tool round as text', async () => {
  fresh((b) => (seen.length === 1
    ? reply({ content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_pantry', arguments: '{}' } }] })
    : toolless(b)));
  assert.equal(await direct('per-request-gateway'), 'Answer without tools.');
  assert.equal(seen.length, 3);
  assert.ok(seen[2].messages.every(m => m.role !== 'tool' && !m.tool_calls));
});

test('import: a model that refuses tools is not asked again, and the import says why', async () => {
  fresh(toolless);
  let told = 0;
  await assert.rejects(direct('import-toolless', { toolsRequired: true, onToolsUnsupported: () => told++ }), /tool use is not supported/);
  assert.equal(told, 1);
  assert.equal(seen.length, 1, 'no second request without the tool that saves the recipe');
});

test('import: an unrelated refusal is reported as before', async () => {
  fresh(() => [400, { error: { message: 'Image too large' } }]);
  let told = 0;
  await assert.rejects(direct('import-other', { toolsRequired: true, onToolsUnsupported: () => told++ }), /Image too large/);
  assert.equal(told, 0);
});

test('Trace adds the note once per conversation and never sends it; the imports say why where they show', () => {
  const trace = readFileSync(new URL('../src/components/ai/Trace.svelte', import.meta.url), 'utf8');
  assert.match(trace, /tools: TOOLS,\n.*onToolCall.*\n\s*onToolsUnsupported,\n\s*\}\);/);
  assert.match(trace, /toolsNote = routed \? 'trace_ai_ct\.tools_unsupported_routed' : 'trace_ai_ct\.tools_unsupported';/);
  assert.match(trace, /messages = \[\.\.\.messages, \{ role: 'assistant', content: reply2, time: _fmtTime\(\) \}\];\s*if \(toolsNote\) messages = toolsNotice\.add\(messages, \$_\(toolsNote\)\);/);
  assert.match(trace, /messages = \[\];\s*toolsNotice\.reset\(\);/, 'a cleared chat is a new conversation');
  assert.match(trace, /const apiMessages = forModel\(messages\)/, 'the note is never sent to a model');
  assert.match(trace, /\{#if m\.role === 'note'\}\s*<div class="msg-note" role="status">/);
  for (const f of ['FileImportDialog', 'BulkFileImportDialog', 'CookbookImportDialog']) {
    const src = readFileSync(new URL(`../src/components/recipe/${f}.svelte`, import.meta.url), 'utf8');
    assert.match(src, /toolsRequired: true,\s*onToolsUnsupported: \(\) => \{ toolsUnsupported = true; \},/, f);
    assert.match(src, /toolsUnsupported \? \$_\('trace_ai_ct\.tools_unsupported_import'\)/, f);
  }
  // Bulk Import's AI errors show on the row: a toast would sit under the dialog.
  const bulk = readFileSync(new URL('../src/components/recipe/BulkFileImportDialog.svelte', import.meta.url), 'utf8');
  assert.match(bulk, /_aiError\(item\.id, toolsUnsupported \? \$_\('trace_ai_ct\.tools_unsupported_import'\)/);
  assert.match(bulk, /<div class="row-ai-error" role="alert">\{aiErrors\[item\.id\]\}<\/div>/);
  const tryWithAi = bulk.slice(bulk.indexOf('async function _tryWithAi'), bulk.indexOf('async function commit'));
  assert.doesNotMatch(tryWithAi, /showError\(/);
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
  assert.match(en.trace_ai_ct.tools_unsupported, /Settings/);
  assert.match(en.trace_ai_ct.tools_unsupported_routed, /nothing was looked up or changed/);
  assert.match(en.trace_ai_ct.tools_unsupported_import, /import recipes/);
});
