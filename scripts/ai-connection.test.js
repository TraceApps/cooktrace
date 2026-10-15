/**
 * Trace with an OpenAI-compatible provider (found with TraceApps/notetrace#18;
 * NoteTrace has the same tests).
 *
 * - A Base URL given with /v1 (as OpenAI's own SDKs take it), or as the whole
 *   /v1/chat/completions endpoint, was used as given and /v1 was added again:
 *   every request went to /v1/v1/chat/completions.
 * - Settings tested a field the moment it was saved, against a reactive value
 *   that hadn't caught up yet, so the last field filled in always read as
 *   missing; an OpenAI-compatible server with no key could never be tested.
 * - The Test button lived only in the status banner, which shows nothing
 *   before the first test or after a change.
 * - A provider the browser couldn't read (unreachable, or a proxy that adds
 *   CORS headers only to successful answers) said only "Failed to fetch".
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { openAIBase as clientBase, getOpenAIChatParams } from '../src/lib/openai-chat-params.js';
import { openAIBase as serverBase } from '../server/lib/openai-chat-params.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

for (const [name, base] of [['client', clientBase], ['server', serverBase]]) {
  test(`${name}: the Base URL works with or without /v1`, () => {
    const cases = {
      'https://ai.example.com': 'https://ai.example.com',
      'https://ai.example.com/': 'https://ai.example.com',
      'https://ai.example.com/v1': 'https://ai.example.com',
      'https://ai.example.com/v1/': 'https://ai.example.com',
      'https://ai.example.com/V1': 'https://ai.example.com',
      'https://ai.example.com/v1/chat/completions': 'https://ai.example.com',
      'https://ai.example.com/v1/chat/completions/': 'https://ai.example.com',
      '  https://ai.example.com/v1  ': 'https://ai.example.com',
      'http://localhost:11434': 'http://localhost:11434',
      // A provider under a path keeps it (Groq: https://api.groq.com/openai/v1).
      'https://api.groq.com/openai/v1': 'https://api.groq.com/openai',
      'https://openrouter.ai/api/v1': 'https://openrouter.ai/api',
      // Only a whole /v1 segment at the end goes.
      'https://ai.example.com/v10': 'https://ai.example.com/v10',
      'https://ai.example.com/apiv1': 'https://ai.example.com/apiv1',
      '': '',
    };
    for (const [given, want] of Object.entries(cases)) assert.equal(base(given), want, given);
    assert.equal(base(undefined), '');
    assert.equal(base(null), '');
  });
}

test('OpenAI given as https://api.openai.com/v1 gets OpenAI\'s own parameters', () => {
  assert.deepEqual(
    getOpenAIChatParams({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna', hasTools: false }),
    { stream: false, max_completion_tokens: 4096 },
  );
});

test('every place that adds /v1 to a Base URL takes it through openAIBase', () => {
  const chat = read('../src/lib/aiChat.js');
  assert.match(chat, /const base = openAIBase\(baseUrl\);/);
  assert.doesNotMatch(chat, /baseUrl\.replace\(\/\\\/\+\$\/, ''\)/);
  const server = read('../server/routes/ai.js');
  assert.match(server, /const baseUrl {2}= openAIBase\(cfg\.ai_base_url\);/);
  assert.doesNotMatch(server, /cfg\.ai_base_url[,;]/);
  // Recipe imports fall back to the person's own provider, from the server.
  const fallback = read('../server/lib/recipe-ai-fallback.js');
  assert.match(fallback, /userText, openAIBase\(cfg\.baseUrl\), cfg\)/);
  assert.doesNotMatch(fallback, /cfg\.baseUrl \|\| ''\)\.replace/);
});

test('a provider the browser can\'t read says what to check, not "Failed to fetch"', async () => {
  const { addMessages, init, waitLocale } = await import('svelte-i18n');
  addMessages('en', JSON.parse(read('../src/i18n/en.json')));
  init({ fallbackLocale: 'en', initialLocale: 'en' });
  await waitLocale('en');
  const { fetchProvider } = await import('../src/lib/aiChat.js');
  const real = globalThis.fetch;
  const hadLocation = 'location' in globalThis;
  const fail = (msg) => async () => { throw new TypeError(msg); };
  const message = async (url) => {
    try { await fetchProvider(url, {}); } catch (e) { return e; }
    throw new Error('did not throw');
  };
  try {
    globalThis.location = { protocol: 'https:', origin: 'https://notes.example.com' };
    // Chrome, Firefox and Safari word a network failure differently.
    for (const m of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
      globalThis.fetch = fail(m);
      const e = await message('https://ai.example.com/v1/chat/completions');
      assert.match(e.message, /ai\.example\.com/, m);
      assert.match(e.message, /https:\/\/notes\.example\.com/, 'names this page\'s own address');
      assert.match(e.message, /always/);
      assert.doesNotMatch(e.message, /Failed to fetch|NetworkError|Load failed/);
      assert.equal(e.cause?.message, m);
      assert.equal(e.offline, false);
    }
    globalThis.fetch = fail('Failed to fetch');
    // An https page can't call plain http (localhost aside).
    assert.match((await message('http://ollama.lan:11434/v1/chat/completions')).message, /HTTPS[\s\S]*https:\/\//);
    assert.doesNotMatch((await message('http://localhost:11434/v1/chat/completions')).message, /plain HTTP/);
    // The Android app may call plain http (allowMixedContent): not that advice there.
    globalThis.Capacitor = { isNativePlatform: () => true };
    try { assert.doesNotMatch((await message('http://ollama.lan:11434/v1/chat/completions')).message, /plain HTTP/); }
    finally { delete globalThis.Capacitor; }
    // The big providers allow every site: there it's the connection.
    assert.match((await message('https://api.openai.com/v1/chat/completions')).message, /connection/);
    // A Base URL with no scheme still names something.
    assert.match((await message('localhost:11434/v1/chat/completions')).message, /localhost:11434/);
    // Not a network failure: stays what it was.
    const header = new TypeError("Failed to execute 'fetch' on 'Window': Invalid value");
    globalThis.fetch = async () => { throw header; };
    assert.equal(await message('https://ai.example.com/x'), header);
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    globalThis.fetch = async () => { throw abort; };
    assert.equal(await message('https://ai.example.com/x'), abort);
    // An answer, any answer, passes through untouched.
    const res = { ok: false, status: 404 };
    globalThis.fetch = async () => res;
    assert.equal(await fetchProvider('https://ai.example.com/x', {}), res);
  } finally {
    globalThis.fetch = real;
    if (!hadLocation) delete globalThis.location;
  }
});

test('direct provider requests go through fetchProvider', () => {
  const chat = read('../src/lib/aiChat.js');
  for (const call of ["fetchProvider('https://api.anthropic.com/v1/messages'", 'fetchProvider(`${baseUrl}/v1/chat/completions`', 'const res = await fetchProvider(url, {']) {
    assert.ok(chat.includes(call), call);
  }
  // The only plain fetches left: fetchProvider's own, and the app's server.
  const rest = chat.replace(/export async function fetchProvider[\s\S]*?\n\}\n/, '');
  for (const m of rest.matchAll(/await fetch\(([^,]+),/g)) assert.match(m[1], /^apiUrl\(/, m[0]);
});

test('Settings tests against what was just saved, needs no key for OpenAI Compatible, and always shows Test', () => {
  const s = read('../src/components/settings/SettingsTrace.svelte');
  assert.doesNotMatch(s, /\$: canTest/);
  assert.match(s, /const _canTest = \(\) =>/);
  assert.match(s, /\$aiProvider === 'custom'\s*\? !!\$aiBaseUrl\?\.trim\(\) && !!\$aiModel\?\.trim\(\)\s*: !!\$aiApiKey\?\.trim\(\)\)/);
  assert.match(s, /if \(!_canTest\(\) && !envLocks\.ai\)/);
  // The Test row sits outside the banner, with its own button.
  assert.match(s, /settings_trace_ct\.test_connection'\)[\s\S]{0,400}on:click=\{\(\) => testConnection\(\)\} disabled=\{testing\}/);
  assert.doesNotMatch(s, /onRetest=/);
  assert.match(s, /placeholder="https:\/\/api\.example\.com"/);
  // Whichever field is saved last tests, once everything is filled in, and
  // the model box never tests per keystroke.
  assert.match(s, /async function _autoTest\(\) \{\s*if \(!_canTest\(\)\) return;[\s\S]{0,200}await testConnection\(\{ silentOk: false, quietFail: keyMayFollow \}\)/);
  // A result counts only for the settings it tested; one asked for while a
  // test runs waits its turn; the banner says why it failed.
  assert.equal((s.match(/if \(stale\(\)\) return;/g) || []).length, 2);
  // A stale result just goes: no test of its own (a provider switch would
  // send the old key to the new provider; a model being typed would test
  // half a name).
  const staleFn = s.match(/const stale = \(\) => \{[\s\S]*?\n {4}\};/)[0];
  assert.doesNotMatch(staleFn, /_testAgain/);
  assert.match(s, /if \(testing\) \{\s*\/\/[^\n]*\n\s*_testAgain = /);
  assert.match(s, /error=\{testStatus === 'fail' \? testError : ''\}/);
  assert.match(s, /testError = failed\('fail\.ai_test', e\);/);
  // Changing the provider doesn't test: the saved key is the old provider's.
  const providerChange = s.slice(s.indexOf('function onProviderChange'), s.indexOf('async function testConnection'));
  assert.doesNotMatch(providerChange, /_autoTest|testConnection\(/);
  assert.match(s, /const keyMayFollow = \$aiProvider === 'custom' && !\$aiApiKey\?\.trim\(\);/);
  assert.match(s, /if \(!quietFail\) showError/);
  for (const m of s.matchAll(/on:input=\{[^}]*\}/g)) assert.doesNotMatch(m[0], /_autoTest|testConnection/);
  assert.match(s, /on:change=\{e => \{ aiModel\.set\(e\.target\.value\); _invalidate\(\); _autoTest\(\); \}\}/);
  const en = JSON.parse(read('../src/i18n/en.json'));
  for (const k of ['test_connection', 'test_connection_desc', 'test', 'testing']) assert.ok(en.settings_trace_ct[k], k);
  assert.ok(en.settings_trace_ct.toast.fill_fields_custom);
  assert.match(en.trace_ai_ct.unreachable, /\{host\}/);
  assert.match(en.trace_ai_ct.unreachable_official, /\{host\}/);
});

test('Trace chats when the server turns it on (AI_ENABLED), as the floating button already shows', () => {
  const trace = read('../src/components/ai/Trace.svelte');
  assert.doesNotMatch(trace, /!\$aiEnabled\b/);
  assert.match(trace, /if \(!\$aiEffectivelyEnabled\) \{\s*showError\(\$_\('trace_ai_ct\.toast\.trace_disabled'\)\)/);
});

test('a reworded provider error is never read as "offline", whatever the host is called', async () => {
  const { isOfflineError } = await import('../src/lib/offline-edits.js');
  const e = Object.assign(new Error("Couldn't get an answer from ai.homenetwork.lan."), { offline: false });
  assert.equal(isOfflineError(e), false);
  // Everything else as before.
  assert.equal(isOfflineError(new TypeError('Failed to fetch')), true);
  assert.equal(isOfflineError(Object.assign(new Error('x'), { offline: true })), true);
});
