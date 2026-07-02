/**
 * recipe-ai-fallback.js — AI-powered recipe extraction fallback.
 *
 * When JSON-LD scraping fails (no schema.org/Recipe in the page), we
 * hand the raw HTML to the user's configured AI provider with a strict
 * instruction prompt and ask it to return JSON in our recipe shape.
 *
 * Runs server-side so the per-user AI key (stored in user_settings)
 * never leaves the server. Strips HTML to a manageable size before
 * sending so we don't blow through token limits on long pages.
 */
import * as cheerio from 'cheerio';

// Cap the HTML payload sent to the LLM. Recipes virtually never need
// more than this; oversized pages get truncated.
const MAX_HTML_CHARS = 32_000;

const _SYS_PROMPT = `You extract recipes from web pages. Given the visible text + structured data of a recipe page, return ONLY a JSON object (no prose, no fences) matching this schema:

{
  "name": "string (required)",
  "description": "string or null",
  "imgUrl": "absolute URL or null",
  "servings": number or null,
  "yield_text": "string or null (e.g. '4 servings', '12 cookies')",
  "prep_minutes": number or null,
  "cook_minutes": number or null,
  "rest_minutes": number or null (any hands-off period the source names — rest / rise / proof / chill / marinate / soak / ferment / inactive / wait),
  "total_minutes": number or null (only if the source states total-time distinctly; leave null when total == prep+cook+rest and there's no unexplained gap),
  "ingredients": [{ "name": "qty unit name, optionally with note", "items": [{ "qty": "string", "unit": "string", "name": "string", "note": "string" }] }],
  "steps": [{ "title": "string", "text": "string" }],
  "tags": [],
  "tools": [],
  "nutrition": {},
  "source_url": "string or null",
  "notes": "string or null",
  "category_name": "string or null"
}

Rules:
- Output JSON ONLY. No markdown fences. No commentary.
- Group ingredients into one section by default with name "". Use multiple sections only if the page clearly has them (e.g. "For the sauce", "For the dough").
- Numbers are numbers, not strings. Times in minutes (integer).
- If you can't find a value, use null. Don't invent.
- If the page is not a recipe at all, return: {"error": "not a recipe"}`;

/**
 * Strip HTML to readable text + critical attributes (image URLs, recipe
 * JSON-LD if present) and cap to MAX_HTML_CHARS.
 */
function _condenseHtml(html, sourceUrl) {
  const $ = cheerio.load(html);
  // Throw away noise that never carries recipe content.
  $('script:not([type="application/ld+json"]), style, noscript, svg, iframe, link, meta').remove();
  $('header, footer, nav, aside').remove();
  $('[hidden], [aria-hidden="true"]').remove();
  // Pull JSON-LD blocks separately — they're high-signal even when
  // they don't strictly conform to schema.org/Recipe.
  const ldBlocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const t = $(el).text().trim();
    if (t) ldBlocks.push(t);
  });
  // Collapse remaining text.
  let text = $('body').text().replace(/\s+/g, ' ').trim();
  // Pluck the first og:image / twitter:image as a recipe-photo hint.
  // (We removed meta tags above; redo from a fresh load just for these.)
  let imgHint = '';
  try {
    const $$ = cheerio.load(html);
    imgHint = $$('meta[property="og:image"]').attr('content')
           || $$('meta[name="twitter:image"]').attr('content')
           || '';
  } catch {}

  let out = '';
  if (sourceUrl) out += `URL: ${sourceUrl}\n`;
  if (imgHint)   out += `OG_IMAGE: ${imgHint}\n`;
  if (ldBlocks.length) out += `\nJSON-LD:\n${ldBlocks.join('\n')}\n`;
  out += `\nVISIBLE TEXT:\n${text}`;
  if (out.length > MAX_HTML_CHARS) out = out.slice(0, MAX_HTML_CHARS);
  return out;
}

/**
 * Call the user's AI provider directly (server-side) with the
 * condensed HTML and parse the JSON response. Returns the recipe
 * object on success, throws on failure.
 *
 * aiCfg shape: { provider, apiKey, model, baseUrl }
 */
export async function aiExtractRecipe(html, sourceUrl, aiCfg) {
  if (!aiCfg?.provider || !aiCfg?.apiKey) {
    throw new Error('AI not configured');
  }
  const condensed = _condenseHtml(html, sourceUrl);
  const userPrompt = `Source URL: ${sourceUrl || '(unknown)'}\n\nExtract the recipe from this page:\n\n${condensed}`;
  const text = await _callProvider(aiCfg, _SYS_PROMPT, userPrompt);
  const json = _parseJsonish(text);
  if (!json || typeof json !== 'object') throw new Error('AI returned no recipe');
  if (json.error) throw new Error(`AI: ${json.error}`);
  if (!json.name) throw new Error('AI response missing recipe name');

  // Normalise to the shape the rest of the import flow expects. Most
  // fields pass through; a few defensive defaults for arrays/objects.
  return {
    name:         String(json.name).trim(),
    description:  json.description || null,
    imgUrl:       json.imgUrl || null,
    servings:     Number.isFinite(json.servings) ? json.servings : null,
    yield_text:   json.yield_text || null,
    prep_minutes:  Number.isFinite(json.prep_minutes)  ? json.prep_minutes  : null,
    cook_minutes:  Number.isFinite(json.cook_minutes)  ? json.cook_minutes  : null,
    rest_minutes:  Number.isFinite(json.rest_minutes)  ? json.rest_minutes  : null,
    total_minutes: Number.isFinite(json.total_minutes) ? json.total_minutes : null,
    ingredients:  Array.isArray(json.ingredients) ? json.ingredients : [],
    steps:        Array.isArray(json.steps) ? json.steps : [],
    tags:         Array.isArray(json.tags) ? json.tags : [],
    tools:        Array.isArray(json.tools) ? json.tools : [],
    nutrition:    json.nutrition && typeof json.nutrition === 'object' ? json.nutrition : {},
    source_url:   json.source_url || sourceUrl || null,
    notes:        json.notes || null,
    category_name: json.category_name || null,
  };
}

// Pull a JSON object out of a string that may have stray fences or
// leading/trailing prose (LLMs sometimes ignore "JSON only" rules).
function _parseJsonish(text) {
  if (!text || typeof text !== 'string') return null;
  // Try direct first.
  try { return JSON.parse(text); } catch {}
  // Strip ```json ... ``` fences.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  // Find the first balanced `{...}` block.
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try { return JSON.parse(slice); } catch { return null; }
      }
    }
  }
  return null;
}

// ── Provider calls (text-only, no tools) ──────────────────────────────────
async function _callProvider(cfg, systemPrompt, userText) {
  const provider = cfg.provider;
  const apiKey   = cfg.apiKey;
  const model    = cfg.model || _defaultModel(provider);
  switch (provider) {
    case 'claude': return _callClaude(apiKey, model, systemPrompt, userText);
    case 'openai': return _callOpenAI(apiKey, model, systemPrompt, userText);
    case 'gemini': return _callGemini(apiKey, model, systemPrompt, userText);
    case 'custom': return _callOpenAI(apiKey || 'no-key', model, systemPrompt, userText, (cfg.baseUrl || '').replace(/\/+$/, ''));
    default: throw new Error(`Unknown AI provider: ${provider}`);
  }
}
function _defaultModel(provider) {
  return ({
    claude: 'claude-haiku-4-5-20251001',
    openai: 'gpt-4o-mini',
    gemini: 'gemini-2.0-flash',
    custom: 'gpt-4o-mini',
  })[provider] || '';
}

async function _callClaude(apiKey, model, systemPrompt, userText) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!res.ok) throw new Error(`Claude returned ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

async function _callOpenAI(apiKey, model, systemPrompt, userText, baseUrl = 'https://api.openai.com') {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI returned ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function _callGemini(apiKey, model, systemPrompt, userText) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini returned ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}
