/**
 * AI Chat — multi-provider Trace assistant with tool use (function calling).
 *
 * Mirrors the NutriTrace + LiftTrace pattern so users get a consistent
 * Trace experience across all three apps. Supports Anthropic Claude,
 * OpenAI, Google Gemini, and OpenAI-compatible endpoints (Ollama, LM
 * Studio, vLLM, DeepSeek, Groq, etc.).
 *
 * Tool use flow:
 *   1. Send messages + tool definitions to the model
 *   2. If model responds with tool_use, execute via the registered
 *      handler and feed results back
 *   3. Repeat up to TOOL_ROUNDS; when they run out, one last request
 *      with the tools off asks for an answer from what was found
 *
 * The tool catalog is defined alongside the executor in this file
 * (see TOOLS below). Trace.svelte owns the executor implementation
 * via setToolHandler(), keeping the catalog and execution code
 * loosely coupled so we can iterate on either independently.
 */
import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { getOpenAIChatParams, openAIBase } from './openai-chat-params.js';
import { createToolSupportMemory, sendWithToolFallback, isToolsUnsupported } from './tool-support.js';
import { geminiToolResponse } from './gemini-tool-response.js';
import { REPLY_MAX_TOKENS, sendForReply, sendWithLengthFallback, stoppedShort, stoppedShortError } from './trace-reply.js';

// An import (toolsRequired) that already saved something isn't asked again
// after an empty reply: told to always save, the model could save the same
// recipe twice. The dialog keeps what it saved (TraceApps/nutritrace#286).
const _sendForReply = (format, body, send, cb, round) => (cb?.toolsRequired && round > 0
  ? sendWithLengthFallback(body, send)
  : sendForReply(format, body, send));

// A reply that stopped short, said in the app's language (trace-reply.js).
function _inLanguage(e) {
  if (!/^trace_stopped_/.test(e?.code || '')) return e;
  try {
    const t = get(_);
    const said = typeof t === 'function' ? t(`trace_reply.${e.code.slice('trace_'.length)}`) : null;
    if (said && !said.startsWith('trace_reply.')) e.message = said;
  } catch { /* i18n not ready: the English line */ }
  return e;
}
const _stoppedShort = (why) => _inLanguage(stoppedShortError(why));

// An import that needs its tools (toolsRequired) and ran out of rounds or
// room: an answer without them is no use to it, so it hears it stopped early.
export const OUT_OF_ROUNDS_CODE = 'trace_out_of_rounds';
// A reply with no words and no tool call, after it was asked for once more (trace-reply.js).
export const EMPTY_REPLY_CODE = 'trace_stopped_empty';
function _outOfRounds() {
  let message = 'That took more steps than one request allows. Try a smaller part at a time.';
  try {
    const said = get(_)('trace_reply.out_of_rounds_import');
    if (said && !said.startsWith('trace_reply.')) message = said;
  } catch { /* i18n not ready: the English line */ }
  return Object.assign(new Error(message), { code: OUT_OF_ROUNDS_CODE });
}

// The last round's answer, or, when a model gave none at all, why there's none.
function _finalAnswer(text) {
  if (String(text || '').trim()) return text;
  try {
    const said = get(_)('trace_reply.out_of_rounds');
    if (said && !said.startsWith('trace_reply.')) return said;
  } catch { /* i18n not ready: the English line */ }
  return 'That took more steps than one answer allows, and nothing came back. Ask for less at once, such as one category or a narrower search.';
}

// ── Provider catalog (kept in CookTrace's `id`-keyed shape so the
//    existing SettingsTrace dropdown keeps working). ───────────────────────
export const AI_PROVIDERS = [
  { id: 'claude',  label: 'Anthropic Claude' },
  { id: 'openai',  label: 'OpenAI' },
  { id: 'gemini',  label: 'Google Gemini' },
  { id: 'custom',  label: 'OpenAI Compatible' },
];

// Used when no model is chosen. Someone who picked a model keeps it.
export const AI_DEFAULT_MODELS = {
  claude:  'claude-haiku-5-5',
  openai:  'gpt-5.6-luna',
  gemini:  'gemini-3.8-flash',
  custom:  '',
};

// Sentinel appended to each branded provider's model list. When the select
// value is this sentinel, the UI reveals a free-text input so users can
// enter a model ID we haven't hardcoded (e.g. after a vendor renames).
export const AI_MODEL_CUSTOM = '__custom__';

// Checked against the vendors' model and deprecation pages on 2026-10-09
// (again on 2026-10-16: platform.claude.com, developers.openai.com,
// ai.google.dev), the same lists as NutriTrace, LiftTrace and NoteTrace. A
// saved model that is no longer listed (Gemini 2.5 is open to existing users
// only) keeps working: the picker shows it as a custom model.
// GPT-6.1 Sol and GPT-6 Astra are left out: Trace calls tools through Chat
// Completions, which those two don't support (only the Responses API does).
export const AI_MODELS = {
  claude:  ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8', AI_MODEL_CUSTOM],
  openai:  ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-4o-mini', 'gpt-4o', AI_MODEL_CUSTOM],
  gemini:  ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.6-flash', AI_MODEL_CUSTOM],
  custom:  [],
};

// Model IDs that changed name: a saved old name is sent as the new one.
// gemini-3.1-pro never existed (only the preview does), and Google points
// the shut-down gemini-3-pro-preview at it. gpt-5.6 is the alias of
// gpt-5.6-sol, which the picker now names.
export const AI_MODEL_RENAMES = {
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
  'gpt-5.6': 'gpt-5.6-sol',
};
export const renamedModel = (model) => AI_MODEL_RENAMES[model] || model;

// ── Tool definitions (cooking-domain) ────────────────────────────────────────
export const TOOLS = [
  // Read tools
  {
    name: 'get_recipes',
    description: "Get the user's recipe library, a page at a time, by name. Returns count (every match), a page of recipes (id, name, description, servings, prep+cook minutes, rating, favorite, last_cooked_at, cook_count, category, tags, and pantry_match: have/need ingredients in stock) and, when a recipe matched by an ingredient, matched_ingredients: the lines that did. next_offset is where the next page starts (null when this page is the last); complete is true when every match has been returned. Use this to find a recipe by name or ingredient, or to go through the whole library page by page.",
    parameters: {
      type: 'object',
      properties: {
        query:    { type: 'string', description: 'Optional case-insensitive filter on name, description, tags and ingredients. Omit to list every recipe.' },
        category: { type: 'string', description: 'Optional case-insensitive category name filter (e.g. "Desserts", "Italian"). Use list_recipe_categories first to see what exists.' },
        favorite: { type: 'boolean', description: 'If true, only return favorited recipes.' },
        limit:    { type: 'integer', description: 'Recipes per page, up to 100. Default 100.' },
        offset:   { type: 'integer', description: 'Where the page starts: 0 first, then the next_offset of the page before.' },
      },
    },
  },
  {
    name: 'read_recipes',
    description: 'Read several recipes in full in one call, up to 25 ids: for each, what get_recipe gives. Answers are kept to a size limit: recipes past it come back in not_read, to read with another call, a recipe too big to read along with others says too_long (read that one with get_recipe), not_found lists ids that are gone, and failed lists recipes that couldn\'t be read just now, with why. Use this to go through many recipes, for example every recipe get_recipes found.',
    parameters: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'integer' }, description: 'Recipe ids, from get_recipes.' } },
      required: ['ids'],
    },
  },
  {
    name: 'list_recipe_categories',
    description: "List all recipe categories in the user's catalog with name, slug, color, and how many recipes are in each. Use before filtering get_recipes by category to know what's available.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_recipe',
    description: 'Get a single recipe with full ingredients (grouped), steps, tools (Kitchen Gear), tags, source URL, notes, and per-serving nutrition.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Recipe id' } },
      required: ['id'],
    },
  },
  {
    name: 'get_recipe_history',
    description: "A recipe's versions (every change to its ingredients, steps, servings or times is kept), oldest first: each with its number, name if given, date, what changed from the one before, and the cooks made from it with their ratings and notes. Also the best-rated version and what changed from it to the recipe now. Use for 'what did I change since my best batch?', 'which version did I like most?', 'when did I add the sugar?'.",
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Recipe id' } },
      required: ['id'],
    },
  },
  {
    name: 'get_pantry',
    description: "Get the user's pantry inventory. Each item has id, name, brand, in_stock, quantity, unit, expires_on, category, serving size + nutrition (when set), barcode, and notes. Use this to answer 'do I have X?' or feed into find_recipes_from_pantry.",
    parameters: {
      type: 'object',
      properties: {
        in_stock_only: { type: 'boolean', description: 'If true, only return items currently in stock.' },
        query:    { type: 'string', description: 'Optional case-insensitive name filter.' },
        category: { type: 'string', description: 'Optional case-insensitive category name filter (e.g. "Dairy & Eggs", "Produce"). Use list_pantry_categories first to see what exists.' },
      },
    },
  },
  {
    name: 'list_pantry_categories',
    description: "List all pantry categories in the user's catalog with name, slug, icon. Use before filtering get_pantry by category to know what's available.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'find_recipes_from_pantry',
    description: "Find recipes the user can mostly cook from what's currently in stock. Returns recipes ranked by pantry match ratio (have / need). Useful for 'what can I cook tonight?'.",
    parameters: {
      type: 'object',
      properties: {
        min_ratio: { type: 'number', description: 'Minimum match ratio 0-1 (default 0.7 = at least 70% in stock).' },
      },
    },
  },
  {
    name: 'get_diary',
    description: "Get the user's cook diary (past + planned cooks) for a date range. Returns date, kind ('cooked' | 'planned'), recipe_id, recipe_name, meal_type ('breakfast' | 'lunch' | 'dinner' | 'snack' | null), rating (1-5 or null — distinct from the recipe's overall rating; this is how THIS cook turned out), servings, notes, has_photo.",
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        to:   { type: 'string', description: 'End date (YYYY-MM-DD)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_shopping_list',
    description: "Get the user's current shopping list. Each row: name, quantity, unit, aisle, checked status, pantry_id link, recipe_id, recipe_name (set when added from a recipe).",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_cookbooks',
    description: "Get the user's cookbook collections. Returns id, name, slug, description, recipe_count, is_smart, smart_filter (for smart cookbooks).",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_cookbook',
    description: 'Get one cookbook with the recipes inside (smart cookbooks evaluate the saved filter live).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Cookbook id' } },
      required: ['id'],
    },
  },

  // Write tools
  {
    name: 'log_cook',
    description: "Mark a recipe as cooked on a given date. Updates the recipe's last_cooked_at + cook_count and creates a cook_diary entry. Use this when the user says 'I cooked this' / 'just made the lasagna' / 'log that I made tacos last night'.",
    parameters: {
      type: 'object',
      properties: {
        recipe_id: { type: 'integer', description: 'Recipe id' },
        date:      { type: 'string',  description: 'YYYY-MM-DD; defaults to today.' },
        notes:     { type: 'string',  description: 'Optional cook notes.' },
        meal_type: { type: 'string',  description: "Optional meal slot — one of 'breakfast' | 'lunch' | 'dinner' | 'snack'. Use if the user mentioned which meal it was." },
        rating:    { type: 'integer', description: 'Optional 1-5 rating for THIS cook (not the recipe as a whole). Use when the user says "it turned out great" / "5 stars" / "meh".' },
      },
      required: ['recipe_id'],
    },
  },
  {
    name: 'plan_cook',
    description: "Schedule a recipe to be cooked on a future date (creates a kind='planned' diary entry). Use for 'plan tacos for Friday' / 'put pasta on the menu next Tuesday'.",
    parameters: {
      type: 'object',
      properties: {
        recipe_id: { type: 'integer', description: 'Recipe id' },
        date:      { type: 'string',  description: 'YYYY-MM-DD' },
        notes:     { type: 'string',  description: 'Optional notes.' },
        meal_type: { type: 'string',  description: "Optional meal slot — 'breakfast' | 'lunch' | 'dinner' | 'snack'." },
        servings:  { type: 'integer', description: "Optional servings to cook; the shopping list scales the recipe to it. Only set it when the user says how many; leave it out otherwise, and the plan has no servings and the list buys the recipe as written." },
        any_day:   { type: 'boolean', description: "Optional: true to plan it for any day of the week the date falls in (the user said 'sometime this week'), not a set day." },
      },
      required: ['recipe_id', 'date'],
    },
  },
  {
    name: 'add_to_shopping',
    description: "Add one or more items to the user's shopping list. Each item is { name, quantity?, unit?, aisle? }. The server auto-links to existing pantry rows by name (case-insensitive).",
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Array of items to add.',
          items: {
            type: 'object',
            properties: {
              name:     { type: 'string',  description: 'Item name (e.g. "tomato")' },
              quantity: { type: 'number',  description: 'Optional numeric quantity.' },
              unit:     { type: 'string',  description: 'Optional unit (e.g. "cup", "lb").' },
              aisle:    { type: 'string',  description: 'Optional aisle (e.g. "Produce").' },
            },
            required: ['name'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'add_to_pantry',
    description: "Add a new pantry item (or update an existing one by name). Use for 'I just bought 2 lbs of chicken' / 'add olive oil to my pantry'.",
    parameters: {
      type: 'object',
      properties: {
        name:     { type: 'string',  description: 'Item name' },
        in_stock: { type: 'boolean', description: 'Whether currently in stock (default true)' },
        quantity: { type: 'number',  description: 'Optional numeric quantity' },
        unit:     { type: 'string',  description: 'Optional unit' },
        brand:    { type: 'string',  description: 'Optional brand' },
        notes:    { type: 'string',  description: 'Optional notes' },
      },
      required: ['name'],
    },
  },
  {
    name: 'set_pantry_density',
    description: "Set the volume↔weight density of a pantry item (grams per cup) so the recipe nutrition auto-calc can convert across families. Use this when the user asks 'set density for everything' / 'fill in densities for the dry goods'. Pull a sane default from your training: flour ~120, sugar ~200, oil ~218, butter ~227, honey ~340, water ~240, etc. The user can override per item later.",
    parameters: {
      type: 'object',
      properties: {
        pantry_id: { type: 'integer', description: 'Pantry item id' },
        g_per_cup: { type: 'number',  description: 'Grams per cup. Use null/0 to clear.' },
      },
      required: ['pantry_id', 'g_per_cup'],
    },
  },
  {
    name: 'set_pantry_stock',
    description: "Toggle whether a pantry item is in stock. Use for 'I'm out of butter' / 'I just restocked olive oil'. Pass the pantry_id from get_pantry.",
    parameters: {
      type: 'object',
      properties: {
        pantry_id: { type: 'integer', description: 'Pantry item id' },
        in_stock:  { type: 'boolean', description: 'true = in stock, false = out' },
      },
      required: ['pantry_id', 'in_stock'],
    },
  },
  {
    name: 'add_to_cookbook',
    description: 'Add one or more recipes to a (regular, non-smart) cookbook.',
    parameters: {
      type: 'object',
      properties: {
        cookbook_id: { type: 'integer', description: 'Cookbook id' },
        recipe_ids:  { type: 'array', items: { type: 'integer' }, description: 'Recipe ids to add' },
      },
      required: ['cookbook_id', 'recipe_ids'],
    },
  },
  {
    name: 'import_recipe_from_url',
    description: "Scrape a recipe from a public URL and save it. Works on most food blogs / publisher sites that publish schema.org/Recipe JSON-LD (which is the vast majority). Use this when the user pastes a URL or says 'import this from <site>'. The new recipe lands in their library and you should reference it by id afterwards (e.g. for log_cook).",
    parameters: {
      type: 'object',
      properties: {
        url:           { type: 'string',  description: 'Full URL of the recipe page.' },
        add_to_pantry: { type: 'boolean', description: 'If true (default), auto-create pantry rows for any new ingredient names. Set false if the user wants the recipe imported in isolation.' },
        apply_tags:    { type: 'boolean', description: 'If true, copy the publisher\'s tags onto the new recipe. Default false because publisher tags are usually noisy.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'create_recipe',
    description: "Create a brand-new recipe from scratch in chat. Use this when the user DICTATES a recipe (typed or via voice) OR attaches a photo of a cookbook page / handwritten card and asks you to import it. For a public web URL prefer import_recipe_from_url instead — it's cleaner and grabs the publisher's metadata. Ingredients should be the grouped shape: [{ name: '', items: [{ qty: '', unit: '', name: '', note: '' }, ...] }]. Steps as [{ title: '', text: '' }].",
    parameters: {
      type: 'object',
      properties: {
        name:         { type: 'string',  description: 'Recipe name (required).' },
        description:  { type: 'string',  description: 'Optional 1-2 sentence description.' },
        servings:     { type: 'integer', description: 'Optional servings count.' },
        yield_text:   { type: 'string',  description: 'Optional yield text, e.g. "12 cookies".' },
        prep_minutes: { type: 'integer', description: 'Optional prep minutes.' },
        cook_minutes: { type: 'integer', description: 'Optional cook minutes.' },
        ingredients: {
          type: 'array',
          description: 'Grouped ingredients. Single unnamed group is fine.',
          items: {
            type: 'object',
            properties: {
              name:  { type: 'string', description: 'Group name (e.g. "Sauce"). Empty string for default group.' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    qty:  { type: 'string', description: 'Quantity ("1", "1/2", "1.5")' },
                    unit: { type: 'string', description: 'Unit (cup, tbsp, oz, etc.)' },
                    name: { type: 'string', description: 'Ingredient name' },
                    note: { type: 'string', description: 'Optional prep note ("chopped", "sifted").' },
                  },
                  required: ['name'],
                },
              },
            },
            required: ['items'],
          },
        },
        steps: {
          type: 'array',
          description: 'Numbered instructions.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Optional short title (e.g. "Preheat Oven").' },
              text:  { type: 'string', description: 'Step text.' },
            },
            required: ['text'],
          },
        },
        tags:       { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        tools:      { type: 'array', items: { type: 'string' }, description: 'Optional Kitchen Gear list.' },
        source_url: { type: 'string',  description: 'Optional URL the recipe came from.' },
        notes:      { type: 'string',  description: 'Optional author notes.' },
      },
      required: ['name', 'ingredients', 'steps'],
    },
  },
];

// ── Main entry point ────────────────────────────────────────────────────────

// onToolsUnsupported runs when the model can't use tools and answered
// without them (TraceApps/nutritrace#259). With toolsRequired (a recipe
// import, which only works through a tool), there is no answer without
// them: onToolsUnsupported runs and the refusal is thrown.
/**
 * fetch() to a provider from this browser. Its "Failed to fetch" says
 * nothing: the browser gives it when the address can't be reached, and when
 * the answer doesn't allow this site to read it (CORS), which is what a proxy
 * that adds CORS headers only to successful answers does to every error,
 * such as a model refusing tools (TraceApps/notetrace#18). Say what to check.
 */
export async function fetchProvider(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    // Only a network failure is reworded (Chrome: "Failed to fetch", Firefox:
    // "NetworkError when attempting to fetch resource.", Safari: "Load
    // failed"). A cancelled request, or one fetch refused to send (a header
    // it can't carry, say), stays as it was.
    if (!(err instanceof TypeError) || !/failed to fetch|networkerror|load failed/i.test(err.message || '')) throw err;
    let host = '';
    try { host = new URL(url).host; } catch { /* not a URL */ }
    host = host || String(url);
    const page = typeof location !== 'undefined' ? location : null;
    const official = /(^|\.)(openai\.com|anthropic\.com|googleapis\.com)$/i.test(host);
    // An https page can't call a plain-http address (localhost aside). The
    // Android app can (allowMixedContent), so there it's the usual advice.
    const native = !!globalThis.Capacitor?.isNativePlatform?.();
    const insecure = !native && page?.protocol === 'https:' && /^http:/i.test(String(url)) && !/^(localhost|127\.|\[::1\])/i.test(host);
    const key = official ? 'unreachable_official' : insecure ? 'unreachable_insecure' : 'unreachable';
    let message = `Couldn't get an answer from ${host}.`;
    try {
      const t = get(_);
      if (typeof t === 'function') message = t(`trace_ai_ct.${key}`, { values: { host, origin: page?.origin || 'this site' } });
    } catch { /* i18n not ready: the plain line above */ }
    const e = new Error(message);
    e.cause = err;
    // Not "you're offline": this says what it is (CookTrace's messages.js
    // would otherwise read words in the host name as a lost connection).
    e.offline = false;
    throw e;
  }
}

export async function callAI({ provider, apiKey, model, messages, systemPrompt, tools, onToolCall, onToolResult, onToolsUnsupported, toolsRequired = false, baseUrl }) {
  // 'custom' is the legacy CookTrace name for the same OpenAI-compatible
  // path that NutriTrace calls 'oai-compat'. Both are accepted.
  if (!apiKey && provider !== 'custom' && provider !== 'oai-compat') {
    throw new Error('No API key configured. Add one in Settings → Trace Assistant.');
  }
  const cb = { onToolCall, onToolResult, onToolsUnsupported, toolsRequired };
  switch (provider) {
    case 'claude':     return _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, cb);
    case 'openai':     return _callOpenAIWithTools(apiKey, renamedModel(model), messages, systemPrompt, tools, cb, 'https://api.openai.com');
    case 'gemini':     return _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, cb);
    case 'oai-compat':
    case 'custom': {
      const base = openAIBase(baseUrl);
      if (!base)  throw new Error('OpenAI-compatible provider needs a Base URL. Set one in Settings → Trace.');
      if (!model) throw new Error('OpenAI-compatible provider needs a model name. Set one in Settings → Trace.');
      return _callOpenAIWithTools(apiKey || 'no-key', model, messages, systemPrompt, tools, cb, base);
    }
    default: throw new Error(`Unknown AI provider: ${provider}`);
  }
}

/** Server-proxy fallback for env-locked installs. Text-only — tools
 *  aren't relayed because the server can't execute client-side. */
export async function callAIProxy({ messages, systemPrompt }) {
  const { apiUrl, isNative, getServerUrl, getAuthToken } = await import('./platform.js');
  const headers = { 'Content-Type': 'application/json' };
  if (isNative && getServerUrl()) {
    // Native server mode: cookies don't survive WebView reloads, fall back
    // to the same Bearer token api.js uses. Without this, env-locked AI
    // calls return 401 from /api/ai/chat on Android.
    const token = getAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } else {
    const csrf = typeof localStorage !== 'undefined' ? localStorage.getItem('ct:csrf') : null;
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(apiUrl('/api/ai/chat'), {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ messages, systemPrompt }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error('Not signed in — sign in again to use AI features.');
    throw _inLanguage(Object.assign(new Error(data.error || `AI proxy error ${res.status}`), { code: data.code }));
  }
  return data.text || data.content || data.message || (data.choices?.[0]?.message?.content) || '';
}

// ── Anthropic Claude (with tool use) ────────────────────────────────────────
// Rounds of tool calls in one answer. Going through a whole library (a page
// of recipes, a batch read, the next page...) needs more than a handful
// (TraceApps/notetrace#34); a model that loops forever still stops.
export const TOOL_ROUNDS = 12;
// Said to the model when the rounds run out: the answer comes from what it has.
export const OUT_OF_ROUNDS = "You can't call more tools for this request. Answer now from what you found. If you couldn't go through everything you needed to, say so plainly: what you covered and what's left, so the user can ask for the rest or narrow it down.";
// What the tool calls and their answers may add to the conversation, in
// bytes, before Trace wraps up early the same way: in tokens about what a
// 128k-token model can hold, Japanese or Chinese included. A photo the user
// attached (a cookbook page, a scanned PDF) is already there and doesn't count.
export const HISTORY_MAX_BYTES = 300000;
const _bytes = (x) => new TextEncoder().encode(JSON.stringify(x)).length;
// The last request: out of rounds, or the tools have added as much as they should.
const _lastRound = (round, history, start) => round === TOOL_ROUNDS || (round > 0 && _bytes(history) - start > HISTORY_MAX_BYTES);
// Said for a tool call left unrun because one round's answers already passed
// HISTORY_MAX_BYTES: a model that asks for many at once can't pass it by much.
export const TOOL_SKIPPED = "Not run: this answer has already gathered as much as it can hold. Answer from what you have, and say what's left.";
const _room = (history, start) => ({ left: HISTORY_MAX_BYTES - (_bytes(history) - start) });
async function _runTool(name, args, room) {
  if (room.left <= 0) return { error: TOOL_SKIPPED };
  const result = await _executeTool(name, args);
  room.left -= _bytes(JSON.stringify(result)); // as it's sent: a JSON string inside the request
  return result;
}

async function _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, cb) {
  const { onToolCall, onToolResult } = cb || {};
  const claudeTools = (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
  let currentMessages = [...messages];
  const startBytes = _bytes(currentMessages);

  for (let round = 0; round <= TOOL_ROUNDS; round++) {
    const last = _lastRound(round, currentMessages, startBytes);
    if (last && cb?.toolsRequired) throw _outOfRounds();
    const body = {
      model: model || AI_DEFAULT_MODELS.claude,
      max_tokens: REPLY_MAX_TOKENS,
      // Out of rounds: told to answer in the system prompt, so the
      // conversation itself stays in the order the provider expects.
      system: last ? `${systemPrompt}\n\n${OUT_OF_ROUNDS}` : systemPrompt,
      messages: currentMessages,
    };
    if (claudeTools.length) body.tools = claudeTools;
    // The tools stay declared (the history has tool calls in it), but can't be called.
    if (last && claudeTools.length) body.tool_choice = { type: 'none' };
    // A model that can't write that many is asked again as before, and an
    // empty reply once more (trace-reply.js).
    const res = await _sendForReply('claude', body, async (b) => {
      const r = await fetchProvider('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(b),
      });
      return { ok: r.ok, status: r.status, data: await r.json() };
    }, cb, round);
    const data = res.data;
    if (!res.ok) throw new Error(data.error?.message || `Claude API error ${res.status}`);
    const short = stoppedShort('claude', data);
    // Out of rounds, nothing at all is said as before (_finalAnswer), after it was asked for once more.
    if (short && !(last && short === 'empty')) throw _stoppedShort(short);

    const toolUses = (data.content || []).filter(b => b.type === 'tool_use');
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    if (last) return _finalAnswer(textBlocks.map(b => b.text).join('\n'));
    if (toolUses.length === 0 || data.stop_reason !== 'tool_use') {
      return textBlocks.map(b => b.text).join('\n') || '';
    }
    // Measured before the model's own message: only what the tools answer
    // counts, so calls whose arguments are already sent (a recipe it wrote)
    // aren't skipped for nothing.
    const room = _room(currentMessages, startBytes);
    currentMessages.push({ role: 'assistant', content: data.content });
    const toolResults = [];
    for (const tu of toolUses) {
      if (onToolCall) onToolCall(tu.name, tu.input);
      const result = await _runTool(tu.name, tu.input, room);
      if (onToolResult) onToolResult(tu.name, result);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    currentMessages.push({ role: 'user', content: toolResults });
  }
  return _finalAnswer(''); // not reached: the last round always answers
}

// ── OpenAI / OpenAI-compatible ─────────────────────────────────────────────
// Models found unable to use tools, by base URL and model (TraceApps/nutritrace#259).
const toolSupport = createToolSupportMemory();

async function _callOpenAIWithTools(apiKey, model, messages, systemPrompt, tools, cb, baseUrl = 'https://api.openai.com') {
  const { onToolCall, onToolResult, onToolsUnsupported, toolsRequired } = cb || {};
  const openaiTools = (tools || []).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  let currentMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];
  const startBytes = _bytes(currentMessages);

  for (let round = 0; round <= TOOL_ROUNDS; round++) {
    const last = _lastRound(round, currentMessages, startBytes);
    if (last && toolsRequired) throw _outOfRounds();
    const selectedModel = model || AI_DEFAULT_MODELS.openai;
    const body = {
      model: selectedModel,
      // Out of rounds: told to answer in the system prompt (see Claude above).
      messages: last ? [{ role: 'system', content: `${systemPrompt}\n\n${OUT_OF_ROUNDS}` }, ...currentMessages.slice(1)] : currentMessages,
      ...getOpenAIChatParams({
        baseUrl,
        model: selectedModel,
        hasTools: openaiTools.length > 0,
        maxTokens: REPLY_MAX_TOKENS,
      }),
    };
    if (openaiTools.length) body.tools = openaiTools;
    if (last && openaiTools.length) body.tool_choice = 'none';
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (apiKey && apiKey !== 'no-key') headers['Authorization'] = `Bearer ${apiKey}`;
    // A server that won't take the longer reply is asked again as before,
    // and an empty reply once more (trace-reply.js).
    const send = (body) => _sendForReply('openai', body, async (b) => {
      const res = await fetchProvider(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(b),
      });
      return { ok: res.ok, status: res.status, data: await res.json() };
    }, cb, round);
    // A model that can't use tools gets the request again without them,
    // unless the caller can't do without them.
    const sendOnce = async () => (toolsRequired
      ? { ...(await send(body)), toolsDropped: false, toolsRouted: false }
      : sendWithToolFallback(body, send, { memory: toolSupport, baseUrl, model: selectedModel }));
    let sent = await sendOnce();
    // A server that refuses tool_choice "none" is asked once more without it.
    if (last && !sent.ok && (sent.status === 400 || sent.status === 422) && body.tool_choice) {
      delete body.tool_choice;
      sent = await sendOnce();
    }
    const { ok, status, data, toolsDropped, toolsRouted } = sent;
    if (!ok) {
      if (toolsRequired && isToolsUnsupported(status, data)) onToolsUnsupported?.();
      throw new Error(data.error?.message || `AI API error ${status}`);
    }
    if (toolsDropped) onToolsUnsupported?.({ routed: toolsRouted });
    // Cut off, a rewrite would be half a recipe and a tool call half its arguments.
    const short = stoppedShort('openai', data);
    // Out of rounds, nothing at all is said as before (_finalAnswer), after it was asked for once more.
    if (short && !(last && short === 'empty')) throw _stoppedShort(short);

    const choice = data.choices[0];
    const msg = choice.message;
    // A server that ignores tool_choice may still ask for a tool on the last
    // round: its text, if any, is the answer.
    if (last) return _finalAnswer(msg.content);
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || '';
    }
    const room = _room(currentMessages, startBytes); // before the model's message (see Claude above)
    currentMessages.push(msg);
    for (const tc of msg.tool_calls) {
      if (onToolCall) onToolCall(tc.function.name, JSON.parse(tc.function.arguments || '{}'));
      const args = JSON.parse(tc.function.arguments || '{}');
      const result = await _runTool(tc.function.name, args, room);
      if (onToolResult) onToolResult(tc.function.name, result);
      currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return _finalAnswer(''); // not reached: the last round always answers
}

// ── Google Gemini ──────────────────────────────────────────────────────────
// Models Google has shut down. Saved selections pointing at any of these are
// quietly remapped to the current default so users who never opened Settings
// after a bump don't suddenly hit 404s.
// Shut down per ai.google.dev/gemini-api/docs/deprecations (2026-10-09).
export const GEMINI_RETIRED = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-001', 'gemini-2.0-flash-lite', 'gemini-2.0-flash-lite-001',
  'gemini-2.0-flash-lite-preview', 'gemini-2.0-flash-lite-preview-02-05',
  'gemini-2.5-pro-preview-03-25', 'gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro-preview-06-05',
  'gemini-2.5-flash-preview-05-20', 'gemini-2.5-flash-preview-09-25', 'gemini-2.5-flash-lite-preview-09-2025',
  'gemini-3.1-flash-lite-preview',
]);
/** The Gemini model to call for a saved one: renamed ones by their new name, shut-down ones by the default. */
export function geminiModelFor(model) {
  const m = renamedModel(model || AI_DEFAULT_MODELS.gemini);
  return GEMINI_RETIRED.has(m) ? AI_DEFAULT_MODELS.gemini : m;
}

async function _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, cb) {
  const { onToolCall, onToolResult } = cb || {};
  const m = geminiModelFor(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const geminiTools = (tools || []).length ? [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }] : undefined;

  let contents = messages.map(msg => {
    const parts = [];
    if (msg._image) {
      parts.push({ inlineData: { mimeType: msg._image.mimeType, data: msg._image.base64 } });
    }
    parts.push({ text: typeof msg.content === 'string' ? msg.content : (msg.content || '') });
    return { role: msg.role === 'assistant' ? 'model' : 'user', parts };
  });
  const startBytes = _bytes(contents);

  for (let round = 0; round <= TOOL_ROUNDS; round++) {
    const last = _lastRound(round, contents, startBytes);
    if (last && cb?.toolsRequired) throw _outOfRounds();
    const body = {
      // Out of rounds: told to answer in the system prompt (see Claude above).
      systemInstruction: { parts: [{ text: last ? `${systemPrompt}\n\n${OUT_OF_ROUNDS}` : systemPrompt }] },
      contents,
    };
    if (geminiTools) body.tools = geminiTools;
    if (last && geminiTools) body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    // An empty reply is asked for once more (trace-reply.js).
    const sent = await _sendForReply('gemini', body, async (b) => {
      const r = await fetchProvider(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(b),
      });
      return { ok: r.ok, status: r.status, data: await r.json() };
    }, cb, round);
    const data = sent.data;
    if (!sent.ok) throw new Error(data.error?.message || `Gemini API error ${sent.status}`);
    const short = stoppedShort('gemini', data);
    // Out of rounds, nothing at all is said as before (_finalAnswer), after it was asked for once more.
    if (short && !(last && short === 'empty')) throw _stoppedShort(short);
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);
    const textParts = parts.filter(p => p.text);
    if (last) return _finalAnswer(textParts.map(p => p.text).join('\n'));
    if (functionCalls.length === 0) {
      return textParts.map(p => p.text).join('\n') || '';
    }
    const room = _room(contents, startBytes); // before the model's message (see Claude above)
    contents.push({ role: 'model', parts });
    const responseParts = [];
    for (const fc of functionCalls) {
      if (onToolCall) onToolCall(fc.functionCall.name, fc.functionCall.args || {});
      const result = await _runTool(fc.functionCall.name, fc.functionCall.args || {}, room);
      if (onToolResult) onToolResult(fc.functionCall.name, result);
      responseParts.push({ functionResponse: { name: fc.functionCall.name, response: geminiToolResponse(result) } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }
  return _finalAnswer(''); // not reached: the last round always answers
}

// ── Tool execution ──────────────────────────────────────────────────────────
let _toolHandler = null;
export function setToolHandler(handler) { _toolHandler = handler; }

async function _executeTool(name, args) {
  if (!_toolHandler) return { error: 'Tool handler not registered' };
  try {
    return await _toolHandler(name, args);
  } catch (e) {
    return { error: e.message || 'Tool execution failed' };
  }
}
