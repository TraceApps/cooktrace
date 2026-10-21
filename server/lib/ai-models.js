// The server's copy of Trace's model defaults, renames and shut-down list,
// for the proxy (routes/ai.js) and recipe imports (lib/recipe-ai-fallback.js).
// Kept identical to src/lib/aiChat.js (scripts/ai-models.test.js checks).

// Used when no model is chosen; an admin who set one keeps it.
export const AI_DEFAULT_MODELS = {
  claude: 'claude-haiku-5-5',
  openai: 'gpt-5.6-luna',
  gemini: 'gemini-3.8-flash',
};

// Model IDs that changed name: a saved old name is sent as the new one.
export const AI_MODEL_RENAMES = {
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
  'gpt-5.6': 'gpt-5.6-sol',
};
export const renamedModel = (model) => AI_MODEL_RENAMES[model] || model;

// Models Google has shut down (404). Saved configs pointing at any of these
// are remapped to the current default so a call doesn't 404 against a dead
// endpoint. Shut down per ai.google.dev/gemini-api/docs/deprecations (2026-10-09).
export const GEMINI_RETIRED = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-001', 'gemini-2.0-flash-lite', 'gemini-2.0-flash-lite-001',
  'gemini-2.0-flash-lite-preview', 'gemini-2.0-flash-lite-preview-02-05',
  'gemini-2.5-pro-preview-03-25', 'gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro-preview-06-05',
  'gemini-2.5-flash-preview-05-20', 'gemini-2.5-flash-preview-09-25', 'gemini-2.5-flash-lite-preview-09-2025',
  'gemini-3.1-flash-lite-preview',
]);
export function geminiModelFor(model) {
  const m = renamedModel(model || AI_DEFAULT_MODELS.gemini);
  return GEMINI_RETIRED.has(m) ? AI_DEFAULT_MODELS.gemini : m;
}

/** The model to send on a vendor's own API; OpenAI-compatible ones keep theirs. */
export function modelFor(provider, model) {
  if (provider === 'openai') return renamedModel(model);
  if (provider === 'gemini') return geminiModelFor(model);
  return model;
}
