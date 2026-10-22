// Smart import's AI: which one it uses, and what it sends
// (TraceApps/nutritrace#258).
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { aiExtractRecipe, importAiConfig } from '../server/lib/recipe-ai-fallback.js';

// The chosen AI without where it came from, to compare with how it was picked before.
const picked = (cfg) => { if (!cfg) return cfg; const { source: _source, ...rest } = cfg; return rest; };

// How 1.4.0-dev04 picked, before keyless endpoints counted.
function before(user, env) {
  const { provider, apiKey, model, baseUrl } = user;
  if (provider && apiKey) return { provider, apiKey, model: model || '', baseUrl: baseUrl || '' };
  if (env.AI_API_KEY) return { provider: env.AI_PROVIDER || 'claude', apiKey: env.AI_API_KEY, model: env.AI_MODEL || '', baseUrl: env.AI_BASE_URL || '' };
  return null;
}

const users = [
  {},
  { provider: 'claude', apiKey: 'sk-user' },
  { provider: 'custom', apiKey: 'k', baseUrl: 'http://lan:11434', model: 'llama3' },
  { provider: 'custom', baseUrl: 'http://localhost:11434', model: 'llama3' },
  { provider: 'openai' },
];
const envs = [
  {},
  { AI_PROVIDER: 'claude', AI_API_KEY: 'sk-env', AI_MODEL: 'm' },
  { AI_PROVIDER: 'oai-compat', AI_API_KEY: 'k', AI_BASE_URL: 'http://gw:4000', AI_MODEL: 'm' },
  { AI_PROVIDER: 'oai-compat', AI_BASE_URL: 'http://ollama:11434', AI_MODEL: 'm' },
];

test('every setup that had an AI before keeps the same one', () => {
  for (const u of users) for (const e of envs) {
    const was = before(u, e);
    if (was) assert.deepEqual(picked(importAiConfig(u, e)), was, JSON.stringify({ u, e }));
  }
});

test("the server's AI stays ahead of a keyless endpoint set in the app", () => {
  const u = { provider: 'custom', baseUrl: 'http://localhost:11434', model: 'llama3' };
  assert.equal(importAiConfig(u, { AI_API_KEY: 'sk-env' }).apiKey, 'sk-env');
});

test('keyless OpenAI-compatible endpoints now count', () => {
  assert.deepEqual(importAiConfig({}, { AI_PROVIDER: 'oai-compat', AI_BASE_URL: 'http://ollama:11434', AI_MODEL: 'm' }),
    { provider: 'oai-compat', apiKey: '', model: 'm', baseUrl: 'http://ollama:11434', source: 'server' });
  assert.deepEqual(importAiConfig({ provider: 'custom', baseUrl: 'http://lan:11434', model: 'llama3' }, {}),
    { provider: 'custom', apiKey: '', model: 'llama3', baseUrl: 'http://lan:11434', source: 'user' });
  assert.equal(importAiConfig({ provider: 'claude', apiKey: 'k' }, {}).source, 'user');
  assert.equal(importAiConfig({ provider: 'openai' }, {}), null, 'a cloud provider still needs a key');
});

async function sent(cfg) {
  const real = globalThis.fetch;
  let req;
  globalThis.fetch = async (url, opts) => {
    req = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"name":"Tomato Soup","steps":["Simmer"]}' } }] }), { status: 200 });
  };
  try { return { recipe: await aiExtractRecipe('<h1>Soup</h1>', 'https://example.com/soup', cfg), req }; }
  finally { globalThis.fetch = real; }
}

test('an OpenAI-compatible endpoint is asked for one JSON answer', async () => {
  for (const provider of ['custom', 'oai-compat']) {
    const { recipe, req } = await sent({ provider, apiKey: '', model: 'm', baseUrl: 'http://ollama:11434/' });
    assert.equal(recipe.name, 'Tomato Soup');
    assert.equal(req.url, 'http://ollama:11434/v1/chat/completions');
    assert.equal(req.body.stream, false);
    assert.equal(req.headers.accept, 'application/json');
    assert.equal(req.headers.Authorization, undefined, 'no placeholder key sent');
  }
  const { req } = await sent({ provider: 'oai-compat', apiKey: 'k', model: 'm', baseUrl: 'http://gw:4000' });
  assert.equal(req.headers.Authorization, 'Bearer k');
});

// A local stand-in for an AI endpoint: answers like OpenAI, or like an
// internal service that refuses (with a body that must not reach the user).
async function endpoint(handler) {
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => handler(req, res, raw));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test("a user's own AI address on the server's network: the owner may, others may not", async () => {
  const ep = await endpoint((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"name":"Soup"}' } }] }));
  });
  try {
    const cfg = { provider: 'custom', apiKey: '', model: 'm', baseUrl: ep.base, source: 'user' };
    // Refused with the same words as an address that doesn't answer, so a
    // refusal can't tell an account which names exist on the network.
    await assert.rejects(aiExtractRecipe('<h1>x</h1>', 'https://example.com', { ...cfg, allowPrivate: false }), /^Error: Could not reach the AI address$/);
    assert.equal((await aiExtractRecipe('<h1>x</h1>', 'https://example.com', { ...cfg, allowPrivate: true })).name, 'Soup');
    // The server's own AI (AI_* env vars) is the owner's: no address check.
    assert.equal((await aiExtractRecipe('<h1>x</h1>', 'https://example.com', { ...cfg, source: 'server' })).name, 'Soup');
  } finally { ep.close(); }
});

test("a provider's refusal shows its status and message, never the raw reply", async () => {
  let body = 'INTERNAL ADMIN DATA: db_password=hunter2';
  const ep = await endpoint((req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(body); });
  try {
    const cfg = { provider: 'custom', apiKey: '', model: 'm', baseUrl: ep.base, source: 'user', allowPrivate: true };
    await assert.rejects(aiExtractRecipe('<h1>x</h1>', 'https://example.com', cfg), (e) => {
      assert.equal(e.message, 'OpenAI returned 500');
      return true;
    });
    body = JSON.stringify({ error: { message: 'model "m" not found' } });
    await assert.rejects(aiExtractRecipe('<h1>x</h1>', 'https://example.com', cfg), /OpenAI returned 500: model "m" not found/);
  } finally { ep.close(); }
});

test("a user's AI address can't redirect to cloud metadata", async () => {
  const ep = await endpoint((req, res) => { res.writeHead(307, { location: 'http://169.254.169.254/' }); res.end(); });
  try {
    const cfg = { provider: 'custom', apiKey: '', model: 'm', baseUrl: ep.base, source: 'user', allowPrivate: true };
    await assert.rejects(aiExtractRecipe('<h1>x</h1>', 'https://example.com', cfg), /cloud-metadata/);
  } finally { ep.close(); }
});
