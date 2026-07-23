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
 *   3. Repeat up to MAX_ROUNDS, then return text
 *
 * The tool catalog is defined alongside the executor in this file
 * (see TOOLS below). Trace.svelte owns the executor implementation
 * via setToolHandler(), keeping the catalog and execution code
 * loosely coupled so we can iterate on either independently.
 */

// ── Provider catalog (kept in CookTrace's `id`-keyed shape so the
//    existing SettingsTrace dropdown keeps working). ───────────────────────
export const AI_PROVIDERS = [
  { id: 'claude',  label: 'Anthropic Claude' },
  { id: 'openai',  label: 'OpenAI' },
  { id: 'gemini',  label: 'Google Gemini' },
  { id: 'custom',  label: 'OpenAI Compatible' },
];

export const AI_DEFAULT_MODELS = {
  claude:  'claude-haiku-4-5-20251001',
  openai:  'gpt-4o-mini',
  gemini:  'gemini-2.5-flash',
  custom:  '',
};

// Sentinel appended to each branded provider's model list. When the select
// value is this sentinel, the UI reveals a free-text input so users can
// enter a model ID we haven't hardcoded (e.g. after a vendor renames).
export const AI_MODEL_CUSTOM = '__custom__';

export const AI_MODELS = {
  claude:  ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-8', AI_MODEL_CUSTOM],
  openai:  ['gpt-4o-mini', 'gpt-4o', AI_MODEL_CUSTOM],
  gemini:  ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro', AI_MODEL_CUSTOM],
  custom:  [],
};

// ── Tool definitions (cooking-domain) ────────────────────────────────────────
export const TOOLS = [
  // Read tools
  {
    name: 'get_recipes',
    description: "Get the user's recipe library. Returns each recipe's id, name, description, image, servings, prep+cook minutes, rating, favorite, last_cooked_at, cook_count, category, tags, and pantry_match (have/need ingredients in stock). Use this to find a recipe by name or browse the library.",
    parameters: {
      type: 'object',
      properties: {
        query:    { type: 'string', description: 'Optional case-insensitive name/description/tag filter. Omit to return all (capped at 100).' },
        category: { type: 'string', description: 'Optional case-insensitive category name filter (e.g. "Desserts", "Italian"). Use list_recipe_categories first to see what exists.' },
        favorite: { type: 'boolean', description: 'If true, only return favorited recipes.' },
      },
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

export async function callAI({ provider, apiKey, model, messages, systemPrompt, tools, onToolCall, onToolResult, baseUrl }) {
  // 'custom' is the legacy CookTrace name for the same OpenAI-compatible
  // path that NutriTrace calls 'oai-compat'. Both are accepted.
  if (!apiKey && provider !== 'custom' && provider !== 'oai-compat') {
    throw new Error('No API key configured. Add one in Settings → Trace Assistant.');
  }
  const cb = { onToolCall, onToolResult };
  switch (provider) {
    case 'claude':     return _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, cb);
    case 'openai':     return _callOpenAIWithTools(apiKey, model, messages, systemPrompt, tools, cb, 'https://api.openai.com');
    case 'gemini':     return _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, cb);
    case 'oai-compat':
    case 'custom': {
      if (!baseUrl) throw new Error('OpenAI-compatible provider needs a Base URL. Set one in Settings → Trace.');
      if (!model)   throw new Error('OpenAI-compatible provider needs a model name. Set one in Settings → Trace.');
      return _callOpenAIWithTools(apiKey || 'no-key', model, messages, systemPrompt, tools, cb, baseUrl.replace(/\/+$/, ''));
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
    throw new Error(data.error || `AI proxy error ${res.status}`);
  }
  return data.text || data.content || data.message || (data.choices?.[0]?.message?.content) || '';
}

// ── Anthropic Claude (with tool use) ────────────────────────────────────────
async function _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, cb) {
  const { onToolCall, onToolResult } = cb || {};
  const claudeTools = (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
  let currentMessages = [...messages];
  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = {
      model: model || AI_DEFAULT_MODELS.claude,
      max_tokens: 4096,
      system: systemPrompt,
      messages: currentMessages,
    };
    if (claudeTools.length) body.tools = claudeTools;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Claude API error ${res.status}`);

    const toolUses = (data.content || []).filter(b => b.type === 'tool_use');
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    if (toolUses.length === 0 || data.stop_reason !== 'tool_use') {
      return textBlocks.map(b => b.text).join('\n') || '';
    }
    currentMessages.push({ role: 'assistant', content: data.content });
    const toolResults = [];
    for (const tu of toolUses) {
      if (onToolCall) onToolCall(tu.name, tu.input);
      const result = await _executeTool(tu.name, tu.input);
      if (onToolResult) onToolResult(tu.name, result);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    currentMessages.push({ role: 'user', content: toolResults });
  }
  throw new Error('Too many tool call rounds');
}

// ── OpenAI / OpenAI-compatible ─────────────────────────────────────────────
async function _callOpenAIWithTools(apiKey, model, messages, systemPrompt, tools, cb, baseUrl = 'https://api.openai.com') {
  const { onToolCall, onToolResult } = cb || {};
  const openaiTools = (tools || []).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  let currentMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];
  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = {
      model: model || AI_DEFAULT_MODELS.openai,
      max_tokens: 4096,
      messages: currentMessages,
    };
    if (openaiTools.length) body.tools = openaiTools;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey && apiKey !== 'no-key') headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `AI API error ${res.status}`);

    const choice = data.choices[0];
    const msg = choice.message;
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || '';
    }
    currentMessages.push(msg);
    for (const tc of msg.tool_calls) {
      if (onToolCall) onToolCall(tc.function.name, JSON.parse(tc.function.arguments || '{}'));
      const args = JSON.parse(tc.function.arguments || '{}');
      const result = await _executeTool(tc.function.name, args);
      if (onToolResult) onToolResult(tc.function.name, result);
      currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  throw new Error('Too many tool call rounds');
}

// ── Google Gemini ──────────────────────────────────────────────────────────
// Models Google has shut down or scheduled for shutdown. Saved selections
// pointing at any of these are quietly remapped to the current default so
// users who never opened Settings after a bump don't suddenly hit 404s.
const GEMINI_RETIRED = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-lite',
]);

async function _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, cb) {
  const { onToolCall, onToolResult } = cb || {};
  let m = model || AI_DEFAULT_MODELS.gemini;
  if (GEMINI_RETIRED.has(m)) m = AI_DEFAULT_MODELS.gemini;
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

  const MAX_ROUNDS = 5;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
    };
    if (geminiTools) body.tools = geminiTools;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Gemini API error ${res.status}`);
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);
    const textParts = parts.filter(p => p.text);
    if (functionCalls.length === 0) {
      return textParts.map(p => p.text).join('\n') || '';
    }
    contents.push({ role: 'model', parts });
    const responseParts = [];
    for (const fc of functionCalls) {
      if (onToolCall) onToolCall(fc.functionCall.name, fc.functionCall.args || {});
      const result = await _executeTool(fc.functionCall.name, fc.functionCall.args || {});
      if (onToolResult) onToolResult(fc.functionCall.name, result);
      responseParts.push({ functionResponse: { name: fc.functionCall.name, response: result } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }
  throw new Error('Too many tool call rounds');
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
