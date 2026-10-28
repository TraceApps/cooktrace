import { Router } from 'express';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { wrap } from '../logger.js';
import { getAiConfig } from '../ai.js';
import { makeRateLimiter } from '../middleware/rate-limit.js';
import { getOpenAIChatParams, openAIBase } from '../lib/openai-chat-params.js';
import { AI_DEFAULT_MODELS, geminiModelFor, modelFor } from '../lib/ai-models.js';
import { REPLY_MAX_TOKENS, sendForReply, stoppedShort, stoppedShortError } from '../lib/trace-reply.js';
import db from '../db.js';

const router = Router();
const aiChatLimit = makeRateLimiter({ max: 30, windowMs: 60_000, label: 'ai' });

const uid = req => userMgmtActive() ? req.user.id : null;
const MAX_HISTORY = 200; // rows kept per user

// ── GET /api/ai/history ───────────────────────────────────────────────────────
router.get('/history', requireAuth, wrap((req, res) => {
  const u = uid(req);
  // The newest 100, oldest first. id breaks ties: a question and its
  // answer are often saved in the same second.
  const rows = u == null
    ? db.prepare(`SELECT role, content, created_at FROM (SELECT id, role, content, created_at FROM ai_chat_history WHERE user_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 100) ORDER BY created_at ASC, id ASC`).all()
    : db.prepare(`SELECT role, content, created_at FROM (SELECT id, role, content, created_at FROM ai_chat_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100) ORDER BY created_at ASC, id ASC`).all(u);
  res.json(rows);
}));

// ── POST /api/ai/history ──────────────────────────────────────────────────────
router.post('/history', requireAuth, wrap((req, res) => {
  const { role, content } = req.body;
  if (!role || !content) return res.status(400).json({ error: 'role and content required' });
  const u = uid(req);

  if (u == null) {
    db.prepare(`INSERT INTO ai_chat_history (user_id, role, content) VALUES (NULL, ?, ?)`).run(role, content);
    // Trim oldest beyond MAX_HISTORY
    db.prepare(`DELETE FROM ai_chat_history WHERE user_id IS NULL AND id NOT IN (SELECT id FROM ai_chat_history WHERE user_id IS NULL ORDER BY created_at DESC LIMIT ?)`).run(MAX_HISTORY);
  } else {
    db.prepare(`INSERT INTO ai_chat_history (user_id, role, content) VALUES (?, ?, ?)`).run(u, role, content);
    db.prepare(`DELETE FROM ai_chat_history WHERE user_id = ? AND id NOT IN (SELECT id FROM ai_chat_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`).run(u, u, MAX_HISTORY);
  }
  res.json({ ok: true });
}));

// ── DELETE /api/ai/history ────────────────────────────────────────────────────
router.delete('/history', requireAuth, wrap((req, res) => {
  const u = uid(req);
  if (u == null) {
    db.prepare(`DELETE FROM ai_chat_history WHERE user_id IS NULL`).run();
  } else {
    db.prepare(`DELETE FROM ai_chat_history WHERE user_id = ?`).run(u);
  }
  res.json({ ok: true });
}));

/**
 * POST /api/ai/chat
 * Server-side proxy for AI calls — used when AI config is env-locked.
 * The API key never leaves the server; clients send only messages + systemPrompt.
 */
// Payload caps to bound a misbehaving client (or compromised account) from
// burning through the admin's AI API budget with one giant request.
const AI_MAX_MESSAGES   = 60;
const AI_MAX_BYTES      = 200_000; // ~200 KB combined messages + system prompt

// Normalise any image content part on an incoming message to the OpenAI
// wire shape `{type:'image_url', image_url:{url:'data:...'}}` so the
// oai-compat forward path never sees Anthropic-shape (which LiteLLM /
// strict schema proxies reject with `invalid content type=image`).
// Idempotent; non-array content untouched. Defense-in-depth against
// NT #114-class client drift.
function _normaliseImagePartsToOpenAI(msg) {
  if (!msg || !Array.isArray(msg.content)) return msg;
  const normalised = msg.content.map(part => {
    if (!part || typeof part !== 'object') return part;
    if (part.type === 'image' && part.source?.type === 'base64' && part.source.media_type && part.source.data) {
      return {
        type: 'image_url',
        image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` },
      };
    }
    if (part.type === 'image' && typeof part.dataUrl === 'string') {
      return { type: 'image_url', image_url: { url: part.dataUrl } };
    }
    return part;
  });
  return { ...msg, content: normalised };
}

router.post('/chat', requireAuth, aiChatLimit, wrap(async (req, res) => {
  const { messages: rawMessages, systemPrompt } = req.body;
  if (!Array.isArray(rawMessages)) return res.status(400).json({ error: 'messages array required' });
  const messages = rawMessages.map(_normaliseImagePartsToOpenAI);
  if (messages.length > AI_MAX_MESSAGES) {
    return res.status(413).json({ error: `Too many messages (max ${AI_MAX_MESSAGES})` });
  }
  const payloadBytes = JSON.stringify(messages).length + (typeof systemPrompt === 'string' ? systemPrompt.length : 0);
  if (payloadBytes > AI_MAX_BYTES) {
    return res.status(413).json({ error: `Payload too large (${payloadBytes} bytes; max ${AI_MAX_BYTES})` });
  }

  const cfg = getAiConfig();
  const provider = cfg.ai_provider || 'claude';
  // Renamed models go out under their new name, shut-down Gemini ones as
  // the default (lib/ai-models.js); an OpenAI-compatible server's as set.
  const model    = modelFor(provider, cfg.ai_model || AI_DEFAULT_MODELS[provider] || '');
  const apiKey   = cfg.ai_api_key;
  const baseUrl  = openAIBase(cfg.ai_base_url);

  // API key required for cloud providers; oai-compat local endpoints
  // (Ollama, LM Studio, etc.) often don't need one — mirror callAI().
  if (!apiKey && provider !== 'oai-compat') {
    return res.status(503).json({ error: 'AI not configured on server. Set AI_API_KEY in environment.' });
  }
  if (provider === 'oai-compat') {
    if (!baseUrl) return res.status(503).json({ error: 'AI_PROVIDER=oai-compat requires AI_BASE_URL in environment.' });
    if (!model)   return res.status(503).json({ error: 'AI_PROVIDER=oai-compat requires AI_MODEL in environment.' });
  }

  let text;
  try {
    switch (provider) {
      case 'claude':     text = await _callClaude(apiKey, model, messages, systemPrompt); break;
      case 'openai':     text = await _callOpenAI(apiKey, model, messages, systemPrompt, 'https://api.openai.com'); break;
      case 'gemini':     text = await _callGemini(apiKey, model, messages, systemPrompt); break;
      case 'oai-compat': text = await _callOpenAI(apiKey || 'no-key', model, messages, systemPrompt, baseUrl.replace(/\/+$/, '')); break;
      default: return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }
  } catch (e) {
    // A reply that stopped short: said, with a code the app says in its
    // language (422, not 5xx: a proxy may put its own page in place of those).
    if (/^trace_stopped_/.test(e?.code || '')) return res.status(422).json({ error: e.message, code: e.code });
    throw e;
  }
  res.json({ text });
}));

export default router;

// ── Provider implementations (server-side) ────────────────────────────────────

async function _callClaude(apiKey, model, messages, systemPrompt) {
  // The app's limit (it was 1,024 here, which cut a long rewrite off); a
  // model that can't write that many is asked again as before (lib/trace-reply.js).
  const body = { model, max_tokens: REPLY_MAX_TOKENS, system: systemPrompt, messages };
  // An empty reply is asked for once more (lib/trace-reply.js).
  const { ok, status, data } = await sendForReply('claude', body, async (b) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(b),
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  });
  if (!ok) throw new Error(data.error?.message || `Claude API error ${status}`);
  const short = stoppedShort('claude', data);
  if (short) throw stoppedShortError(short);
  return data.content[0].text;
}

// The app's limit (it was 1,024 here, which cut a long rewrite off); a
// server or model that won't take that many is asked again as before
// (lib/trace-reply.js).
async function _callOpenAI(apiKey, model, messages, systemPrompt, baseUrl = 'https://api.openai.com') {
  const body = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    ...getOpenAIChatParams({ baseUrl, model, hasTools: false, maxTokens: REPLY_MAX_TOKENS }),
  };
  // An empty reply is asked for once more (lib/trace-reply.js).
  const { ok, status, data } = await sendForReply('openai', body, async (b) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(b),
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  });
  if (!ok) throw new Error(data.error?.message || data.message || `OpenAI API error ${status}`);
  const short = stoppedShort('openai', data);
  if (short) throw stoppedShortError(short);
  return data.choices[0].message.content;
}

async function _callGemini(apiKey, model, messages, systemPrompt) {
  const m = geminiModelFor(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
  };
  // An empty reply is asked for once more (lib/trace-reply.js).
  const sent = await sendForReply('gemini', body, async (b) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    });
    return { ok: res.ok, status: res.status, data: await res.json() };
  });
  const data = sent.data;
  if (!sent.ok) throw new Error(data.error?.message || `Gemini API error ${sent.status}`);
  const short = stoppedShort('gemini', data);
  if (short) throw stoppedShortError(short);
  return data.candidates[0].content.parts[0].text;
}
