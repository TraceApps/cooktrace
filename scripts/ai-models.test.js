/**
 * The AI model picker and the IDs the app sends, in the browser/app
 * (src/lib/aiChat.js), in the server's proxy (server/routes/ai.js) and in
 * recipe imports (server/lib/recipe-ai-fallback.js), both through
 * server/lib/ai-models.js. The same lists as NutriTrace, LiftTrace and
 * NoteTrace.
 *
 * The lists were checked against the vendors' model and deprecation pages on
 * 2026-10-09 (again on 2026-10-16). These tests keep the copies identical,
 * keep shut-down and renamed IDs working for anyone who saved them, and keep
 * the picker to models a new user can actually use.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

globalThis.BroadcastChannel = undefined;
const client = await import('../src/lib/aiChat.js');
const server = await import('../server/lib/ai-models.js');
const { aiExtractRecipe } = await import('../server/lib/recipe-ai-fallback.js');

// The server's proxy, mounted on a scratch database (server/db.js opens
// DB_PATH when imported).
let db = null, dir = null, app = null, base = null;
const req = createRequire(new URL('../server/package.json', import.meta.url));
let sqlite = true;
try { req('better-sqlite3'); } catch { sqlite = false; /* not built for this Node: the proxy half skips */ }
if (sqlite) {
  dir = mkdtempSync(join(tmpdir(), 'ct-ai-models-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  const { default: aiRoutes } = await import('../server/routes/ai.js');
  const express = req('express');
  const web = express();
  web.use(express.json());
  web.use('/api/ai', aiRoutes);
  app = web.listen(0);
  base = `http://127.0.0.1:${app.address().port}`;
}
test.after(() => { app?.close(); try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

const ids = provider => client.AI_MODELS[provider].filter(v => v !== client.AI_MODEL_CUSTOM);

test('the picker lists the current models', () => {
  assert.deepEqual(ids('claude'), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1',
    'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8']);
  assert.deepEqual(ids('openai'), ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-4o-mini', 'gpt-4o']);
  // Trace needs tool calls over Chat Completions, which GPT-6.1 Sol and GPT-6 Astra don't do.
  assert.ok(!ids('openai').includes('gpt-6.1-sol') && !ids('openai').includes('gpt-6-astra'));
  assert.deepEqual(ids('gemini'), ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash',
    'gemini-3.1-pro-preview', 'gemini-3.6-flash']);
  for (const p of ['claude', 'openai', 'gemini']) assert.equal(client.AI_MODELS[p].at(-1), client.AI_MODEL_CUSTOM);
  assert.deepEqual(client.AI_MODELS.custom, []);
  // Gemini 2.5 is open to existing users only, gemini-3.1-pro never existed,
  // and gpt-5.6 is an alias the picker now names.
  assert.ok(!ids('gemini').some(v => v.startsWith('gemini-2.5')));
  assert.ok(!ids('gemini').includes('gemini-3.1-pro'));
  assert.ok(!ids('openai').includes('gpt-5.6'));
});

test('the picker is the same as the other Trace apps\' (NoteTrace has the same shape)', () => {
  // Kept literally so a change here is a change made on purpose in all four.
  assert.equal(JSON.stringify(client.AI_MODELS),
    '{"claude":["claude-haiku-5-5","claude-sonnet-5-5","claude-opus-5-5","claude-fable-5-1","claude-sonnet-5","claude-opus-5","claude-fable-5","claude-opus-4-8","__custom__"],' +
    '"openai":["gpt-6-luna","gpt-5.6-terra","gpt-5.6-sol","gpt-5.6-luna","gpt-4o-mini","gpt-4o","__custom__"],' +
    '"gemini":["gemini-3.1-flash-lite","gemini-3.5-flash-lite","gemini-3.8-flash","gemini-3.1-pro-preview","gemini-3.6-flash","__custom__"],"custom":[]}');
});

test('defaults: Claude Haiku 5.5 when none is chosen; a chosen model is kept', () => {
  const { custom, ...defaults } = client.AI_DEFAULT_MODELS;
  assert.deepEqual(defaults, { claude: 'claude-haiku-5-5', openai: 'gpt-5.6-luna', gemini: 'gemini-3.8-flash' });
  assert.equal(custom, '');
  for (const p of ['claude', 'openai', 'gemini']) assert.ok(ids(p).includes(client.AI_DEFAULT_MODELS[p]), `${p} default is in the picker`);
  // Settings shows a saved model that isn't listed as a custom one, so it keeps working,
  // and shows a renamed one under its new name (not for OpenAI Compatible).
  const trace = readFileSync(new URL('../src/components/settings/SettingsTrace.svelte', import.meta.url), 'utf8');
  assert.match(trace, /if \(saved && !isPreset && \$aiProvider !== 'custom'\) \{\s*aiModelSelectVal = AI_MODEL_CUSTOM;\s*aiCustomModelVal = saved;/);
  assert.match(trace, /if \(\$aiProvider !== 'custom' && \$aiProvider !== 'oai-compat' && \$aiModel && renamedModel\(\$aiModel\) !== \$aiModel\) \{\s*aiModel\.set\(renamedModel\(\$aiModel\)\);\s*\}\s*const saved = \$aiModel;/);
});

test('saved models: renamed ones go out under the new name, shut-down Gemini ones as the default, 2.5 as saved', () => {
  for (const g of [client.geminiModelFor, server.geminiModelFor]) {
    assert.equal(g('gemini-3.1-pro'), 'gemini-3.1-pro-preview');
    assert.equal(g('gemini-3-pro-preview'), 'gemini-3.1-pro-preview');
    for (const dead of ['gemini-2.0-flash', 'gemini-2.0-flash-001', 'gemini-2.0-flash-lite-001', 'gemini-3.1-flash-lite-preview',
      'gemini-2.5-pro-preview-03-25', 'gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro-preview-06-05',
      'gemini-2.5-flash-preview-09-25', 'gemini-2.5-flash-lite-preview-09-2025', 'gemini-1.5-pro']) {
      assert.equal(g(dead), 'gemini-3.8-flash', dead);
    }
    for (const kept of ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.6-flash']) assert.equal(g(kept), kept);
    assert.equal(g(''), 'gemini-3.8-flash');
  }
  assert.equal(client.renamedModel('gpt-5.6'), 'gpt-5.6-sol');
  assert.equal(client.renamedModel('claude-opus-5'), 'claude-opus-5');
  // OpenAI-compatible endpoints name their own models: never renamed there.
  assert.equal(server.modelFor('oai-compat', 'gpt-5.6'), 'gpt-5.6');
  assert.equal(server.modelFor('custom', 'gemini-3.1-pro'), 'gemini-3.1-pro');
  assert.equal(server.modelFor('openai', 'gpt-5.6'), 'gpt-5.6-sol');
  assert.equal(server.modelFor('gemini', 'gemini-2.0-flash'), 'gemini-3.8-flash');
  assert.equal(server.modelFor('claude', 'claude-opus-5'), 'claude-opus-5');
  const src = readFileSync(new URL('../src/lib/aiChat.js', import.meta.url), 'utf8');
  assert.match(src, /case 'openai':\s+return _callOpenAIWithTools\(apiKey, renamedModel\(model\)/);
  assert.match(src, /_callOpenAIWithTools\(apiKey \|\| 'no-key', model,/);
});

test("the server's copy (proxy and recipe imports) uses the same defaults, renames and shut-down list", () => {
  const { custom: _custom, ...clientDefaults } = client.AI_DEFAULT_MODELS;
  assert.deepEqual(server.AI_DEFAULT_MODELS, clientDefaults);
  assert.deepEqual(server.AI_MODEL_RENAMES, client.AI_MODEL_RENAMES);
  assert.deepEqual([...server.GEMINI_RETIRED].sort(), [...client.GEMINI_RETIRED].sort());
  const src = readFileSync(new URL('../server/routes/ai.js', import.meta.url), 'utf8');
  assert.match(src, /const model\s+= modelFor\(provider, cfg\.ai_model \|\| AI_DEFAULT_MODELS\[provider\] \|\| ''\);/);
  assert.doesNotMatch(src, /claude-haiku|gemini-\d/, 'no second list in the proxy');
  const fallback = readFileSync(new URL('../server/lib/recipe-ai-fallback.js', import.meta.url), 'utf8');
  assert.match(fallback, /const model\s+= modelFor\(provider, cfg\.model \|\| _defaultModel\(provider\)\);/);
  assert.doesNotMatch(fallback, /claude-haiku|gemini-\d/, 'no second list in recipe imports');
});

// Every model CookTrace's picker offered before this change, a shut-down one,
// and none at all, as the vendor is asked for it now: kept as saved unless
// it was renamed or shut down.
const SAVED_BEFORE = [
  ['claude', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'],
  ['claude', 'claude-sonnet-5', 'claude-sonnet-5'],
  ['claude', 'claude-opus-5', 'claude-opus-5'],
  ['claude', 'claude-fable-5-1', 'claude-fable-5-1'],
  ['claude', 'claude-fable-5', 'claude-fable-5'],
  ['claude', 'claude-opus-4-8', 'claude-opus-4-8'],
  ['openai', 'gpt-5.6-luna', 'gpt-5.6-luna'],
  ['openai', 'gpt-5.6-terra', 'gpt-5.6-terra'],
  ['openai', 'gpt-5.6', 'gpt-5.6-sol'],
  ['openai', 'gpt-4o-mini', 'gpt-4o-mini'],
  ['openai', 'gpt-4o', 'gpt-4o'],
  ['gemini', 'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite'],
  ['gemini', 'gemini-3.6-flash', 'gemini-3.6-flash'],
  ['gemini', 'gemini-3.1-pro', 'gemini-3.1-pro-preview'],
  ['gemini', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-lite'],
  ['gemini', 'gemini-2.5-flash', 'gemini-2.5-flash'],
  ['gemini', 'gemini-2.5-pro', 'gemini-2.5-pro'],
  ['gemini', 'gemini-2.0-flash', 'gemini-3.8-flash'],
  ['gemini', '', 'gemini-3.8-flash'],
  ['claude', '', 'claude-haiku-5-5'],
  ['openai', '', 'gpt-5.6-luna'],
];
const VENDOR = /^https:\/\/(api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com)\//;
// Answers the vendors' APIs in-process and notes the model each was asked for;
// anything else (the test's own server) goes out for real.
function stubVendors(t, text = 'ok') {
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!VENDOR.test(u)) return real(url, init);
    const body = JSON.parse(init.body || '{}');
    let data;
    if (u.includes('anthropic')) { asked.push(body.model); data = { content: [{ type: 'text', text }], stop_reason: 'end_turn' }; }
    else if (u.includes('openai')) { asked.push(body.model); data = { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }; }
    else { asked.push(decodeURIComponent(u.match(/\/models\/([^:]+):/)[1])); data = { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }; }
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = real; });
  return asked;
}

test('the app: a model saved before this change reaches the vendor under its current name', async (t) => {
  const asked = stubVendors(t);
  for (const [provider, saved, sent] of SAVED_BEFORE) {
    // Trace, imports and label scans pass the saved model, or the default when none is saved.
    const model = saved || client.AI_DEFAULT_MODELS[provider];
    const reply = await client.callAI({ provider, apiKey: 'k', model, messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'You are Trace.' });
    assert.equal(reply, 'ok', `${provider} ${saved}`);
    assert.equal(asked.at(-1), sent, `${provider} ${saved || '(none)'}`);
  }
  // An OpenAI-compatible server is asked for exactly what was saved.
  await client.callAI({ provider: 'custom', model: 'gpt-5.6', baseUrl: 'https://api.openai.com/v1', messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'x' });
  assert.equal(asked.at(-1), 'gpt-5.6');
});

test("the server's proxy: a model an admin set before this change reaches the vendor under its current name", async (t) => {
  if (!db) { t.skip('better-sqlite3 is not built for this Node'); return; }
  const asked = stubVendors(t);
  const set = db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const drop = db.prepare('DELETE FROM app_config WHERE key = ?');
  const post = () => fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'You are Trace.' }) });
  // One request per row, plus one: keep the list under the proxy's 30 a minute.
  assert.ok(SAVED_BEFORE.length + 1 <= 30);
  for (const [provider, saved, sent] of SAVED_BEFORE) {
    set.run('ai_provider', provider); set.run('ai_api_key', 'k'); set.run('ai_env_locked', 'true');
    if (saved) set.run('ai_model', saved); else drop.run('ai_model');
    const r = await post();
    assert.deepEqual(await r.json(), { text: 'ok' }, `${provider} ${saved}`);
    assert.equal(asked.at(-1), sent, `${provider} ${saved || '(none)'}`);
  }
  // An OpenAI-compatible server (AI_PROVIDER=oai-compat) is asked for exactly what was set.
  set.run('ai_provider', 'oai-compat'); set.run('ai_base_url', 'https://api.openai.com'); set.run('ai_model', 'gpt-5.6');
  assert.deepEqual(await (await post()).json(), { text: 'ok' });
  assert.equal(asked.at(-1), 'gpt-5.6');
});

test('recipe imports: a saved model reaches the vendor under its current name', async (t) => {
  const asked = stubVendors(t, JSON.stringify({ name: 'Soup', ingredients: [], steps: [] }));
  for (const source of ['user', 'server']) {
    for (const [provider, saved, sent] of SAVED_BEFORE) {
      const recipe = await aiExtractRecipe('<h1>Soup</h1>', 'https://example.com/soup', { provider, apiKey: 'k', model: saved, baseUrl: '', source });
      assert.equal(recipe.name, 'Soup', `${source} ${provider} ${saved}`);
      assert.equal(asked.at(-1), sent, `${source} ${provider} ${saved || '(none)'}`);
    }
  }
});

test('Settings search finds the Trace section by the new model names', () => {
  const settings = readFileSync(new URL('../src/routes/Settings.svelte', import.meta.url), 'utf8');
  const ai = settings.match(/^\s*ai:\s*\[([^\]]*)\]/m)[1];
  for (const kw of ['fable', 'luna', 'sol', 'terra', 'flash']) assert.match(ai, new RegExp(`'${kw}'`), kw);
});
