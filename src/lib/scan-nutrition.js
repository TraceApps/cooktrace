/**
 * scan-nutrition.js — Extract nutrition facts from a photographed label.
 *
 * Direct port of NutriTrace's FoodEditor scan-label flow (v1.0.0-rc.52
 * era). Same prompt, same providers, same JSON parsing; only the
 * application step differs by app (CookTrace maps portion/unit into
 * serving_size/serving_unit, NT keeps portion/unit as-is).
 *
 * Usage:
 *
 *   const parsed = await scanNutritionLabel({ fileInput });
 *   if (parsed) applyToDraft(parsed);
 *
 * `fileInput` is only needed on web (the hidden `<input type=file
 * capture=environment>` element the caller must render). On native
 * (Capacitor), the Camera plugin drives capture instead.
 *
 * Returns the parsed JSON blob (or null if canceled / failed) so the
 * caller decides which fields to overwrite.
 */
import { isNative } from './platform.js';
import { callAI, callAIProxy } from './aiChat.js';
import { get } from 'svelte/store';
import { aiProvider, aiApiKey, aiModel, aiBaseUrl } from '../stores/settings.js';

/**
 * Capture a photo of the label via the platform's camera path.
 * Native → @capacitor/camera at 80% quality, 1600px wide.
 * Web    → the caller's hidden file input with capture=environment.
 *
 * @param {HTMLInputElement | null} fileInput — required on web, ignored on native
 * @returns {Promise<{base64: string, mimeType: string} | null>}
 */
export async function captureLabelPhoto(fileInput) {
  if (isNative) {
    try {
      const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
      const photo = await Camera.getPhoto({
        quality: 80,
        resultType: CameraResultType.Base64,
        source: CameraSource.Camera,
        width: 1600,
      });
      return { base64: photo.base64String, mimeType: `image/${photo.format || 'jpeg'}` };
    } catch {
      return null; // user canceled or camera unavailable
    }
  }
  // Web fallback — resolve on the file input's change event.
  if (!fileInput) return null;
  return new Promise((resolve) => {
    const handler = (e) => {
      fileInput.removeEventListener('change', handler);
      const file = e.target.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
        if (!m) { resolve(null); return; }
        resolve({ mimeType: m[1], base64: m[2] });
      };
      reader.readAsDataURL(file);
    };
    fileInput.addEventListener('change', handler);
    fileInput.value = '';
    fileInput.click();
  });
}

const LABEL_PROMPT = [
  'Extract nutrition facts from this label image.',
  'Return ONLY a JSON object with these keys (omit keys you cannot read):',
  '  name (string, product name), brand (string), portion (number), unit (string, one of g/ml/oz/fl oz/cup/tsp/tbsp/lb/kg/l/each),',
  '  per_serving (boolean, true if the listed values are per serving, false if per 100g),',
  '  calories (kcal), kilojoules (kJ),',
  '  fat (g), saturated-fat (g), trans-fat (g), polyunsaturated-fat (g), monounsaturated-fat (g),',
  '  carbohydrates (g), sugars (g), added-sugars (g), fiber (g),',
  '  proteins (g),',
  '  sodium (mg), salt (g), potassium (mg), cholesterol (mg),',
  '  calcium (mg), iron (mg), magnesium (mg), zinc (mg), phosphorus (mg),',
  '  vitamin-d (µg), vitamin-a (µg), vitamin-c (mg), vitamin-e (mg), vitamin-k (µg),',
  '  b1 (mg), b2 (mg), b3 (mg), b6 (mg), b9 (µg), b12 (µg),',
  '  caffeine (mg), alcohol (g)',
  'Use numbers, not strings. Use the units specified, not the label\'s.',
  'No commentary, no markdown — JSON only.',
].join('\n');

/**
 * Build the provider-specific multimodal message payload.
 * Each provider has its own image + text convention.
 */
function buildLabelMessages(provider, image) {
  if (provider === 'claude') {
    return [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } },
      { type: 'text', text: LABEL_PROMPT },
    ]}];
  }
  if (provider === 'openai' || provider === 'oai-compat') {
    return [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
      { type: 'text', text: LABEL_PROMPT },
    ]}];
  }
  if (provider === 'gemini') {
    return [{ role: 'user', content: LABEL_PROMPT, _image: image }];
  }
  return [{ role: 'user', content: LABEL_PROMPT }];
}

/**
 * Extract JSON from the AI's reply. Handles the common failure modes:
 * markdown code fences, and models that added prose around the object.
 */
function parseJsonFromReply(text) {
  if (!text) return null;
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/**
 * Full flow: capture → prompt → parse. Returns the parsed JSON blob
 * (or null on cancel / failure). The caller decides which fields to
 * overwrite on the draft.
 *
 * @param {object} opts
 * @param {HTMLInputElement | null} opts.fileInput — hidden `<input>` for web capture (ignored on native)
 * @param {boolean} opts.aiProxy — when true, route via server proxy (env-locked mode); when false, call provider directly
 * @returns {Promise<object | null>}
 */
export async function scanNutritionLabel({ fileInput = null, aiProxy = false } = {}) {
  const image = await captureLabelPhoto(fileInput);
  if (!image || !image.base64) return null;
  const provider = get(aiProvider) || 'claude';
  const messages = buildLabelMessages(provider, image);
  const systemPrompt = 'You are a nutrition label parser. Return JSON only.';
  const reply = aiProxy
    ? await callAIProxy({ messages, systemPrompt })
    : await callAI({
        provider,
        apiKey: get(aiApiKey),
        model: get(aiModel),
        baseUrl: get(aiBaseUrl),
        messages,
        systemPrompt,
      });
  return parseJsonFromReply(reply);
}
