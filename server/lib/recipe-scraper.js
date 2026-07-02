/**
 * recipe-scraper.js — fetches a URL and extracts a recipe from its
 * schema.org/Recipe JSON-LD or microdata.
 *
 * Defenses:
 *   - http/https only
 *   - blocks private/loopback IPs (basic SSRF guard — node will reject
 *     localhost/private subnets too via their public-DNS resolution path)
 *   - 8s timeout
 *   - 5MB max response size
 *   - User-Agent header so blogs don't 403 us
 */
import * as cheerio from 'cheerio';

const MAX_BYTES   = 5 * 1024 * 1024;
const TIMEOUT_MS  = 8000;
const UA = 'CookTrace/1.0 (+https://github.com/traceapps/cooktrace; recipe scraper)';

const PRIVATE_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const PRIVATE_PREFIXES = ['10.', '127.', '192.168.', '169.254.'];

function _isPrivateHost(host) {
  if (!host) return true;
  if (PRIVATE_HOSTS.has(host)) return true;
  if (PRIVATE_PREFIXES.some(p => host.startsWith(p))) return true;
  // 172.16.0.0 – 172.31.255.255
  const m = host.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  return false;
}

export async function scrapeRecipe(rawUrl) {
  const { html, finalUrl } = await fetchRecipeHtml(rawUrl);
  const recipe = _extractRecipe(html, finalUrl);
  if (!recipe) throw new Error('No schema.org/Recipe data found on that page');
  return recipe;
}

/**
 * Fetch the page with the same SSRF guard, size cap, and timeout as
 * scrapeRecipe but return the raw HTML so callers can re-parse it
 * with a different strategy (recipe-scrapers sidecar, AI fallback).
 */
export async function fetchRecipeHtml(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new Error('Not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported');
  }
  if (_isPrivateHost(url.hostname)) {
    throw new Error('Refused: private / loopback hostnames are not allowed');
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
  } catch (e) {
    clearTimeout(t);
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw new Error('Could not fetch URL');
  }
  clearTimeout(t);
  if (!res.ok) throw new Error(`Source returned ${res.status}`);
  if (!/text\/html|application\/xhtml/i.test(res.headers.get('content-type') || '')) {
    throw new Error('Source did not return HTML');
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) throw new Error('Source page is too large');
    chunks.push(value);
  }
  const html = new TextDecoder('utf-8').decode(_concat(chunks));
  return { html, finalUrl: url.toString() };
}

/**
 * JSON-LD-only extractor that reuses pre-fetched HTML. Caller already
 * has the page bytes (e.g. from a tier-1 attempt) and wants to retry
 * with the same logic. Returns null if no recipe found.
 */
export function extractFromHtml(html, sourceUrl) {
  return _extractRecipe(html, sourceUrl);
}

function _concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Extract a normalised Recipe from a raw HTML blob (no fetch — caller
 * already has the page text). Used by the paste/upload import flow.
 */
export function extractRecipeFromHtml(html, sourceUrl = null) {
  return _extractRecipe(html, sourceUrl);
}

/**
 * Apply our shape-normalisation to a schema.org/Recipe-like JSON object.
 * Used by the paste/upload import flow when the user pastes raw JSON-LD.
 */
export function normaliseSchemaOrgRecipe(node, sourceUrl = null) {
  return _normalise(node, sourceUrl);
}

function _extractRecipe(html, sourceUrl) {
  const $ = cheerio.load(html);

  // Try every JSON-LD <script> looking for one whose @type contains "Recipe".
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const s of scripts) {
    const text = $(s).contents().text();
    if (!text || !text.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(text); } catch { continue; }
    const found = _findRecipe(parsed);
    if (found) {
      const recipe = _normalise(found, sourceUrl);
      // Fallback: if JSON-LD didn't include a video, sniff the page
      // for an embedded YouTube / Vimeo iframe. Most recipe blogs
      // embed a how-to video without including it in their JSON-LD.
      if (!recipe.video_url) {
        const fallback = _findEmbeddedVideo($);
        if (fallback) recipe.video_url = fallback;
      }
      return recipe;
    }
  }
  return null;
}

/**
 * Sniff an HTML page for an embedded YouTube / Vimeo video. Returns
 * the canonical embed URL when found, or null. Order of preference:
 *   1. <iframe src="...youtube.com|youtu.be|vimeo.com..."> (rendered)
 *   2. <a href="..."> pointing to the same hosts (linked-out)
 *   3. <meta property="og:video"> (rare)
 */
function _findEmbeddedVideo($) {
  const isVideoHost = (u) => /(?:youtube\.com|youtu\.be|player\.vimeo\.com|vimeo\.com)/i.test(u || '');
  // Iframes
  const iframes = $('iframe[src]').toArray();
  for (const el of iframes) {
    const src = $(el).attr('src');
    if (isVideoHost(src)) return src;
  }
  // Anchor links pointing to YouTube/Vimeo
  const anchors = $('a[href]').toArray();
  for (const el of anchors) {
    const href = $(el).attr('href');
    if (isVideoHost(href)) return href;
  }
  // og:video meta
  const og = $('meta[property="og:video"], meta[property="og:video:url"]').first().attr('content');
  if (isVideoHost(og)) return og;
  return null;
}

// JSON-LD payloads can be a recipe directly, an @graph wrapper, or an
// array of unrelated entities — walk them all looking for any node with
// @type Recipe.
function _findRecipe(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = _findRecipe(item);
      if (r) return r;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const types = [].concat(node['@type'] || []);
  if (types.includes('Recipe')) return node;
  if (node['@graph']) return _findRecipe(node['@graph']);
  return null;
}

function _normalise(r, sourceUrl) {
  const name = _str(r.name) || 'Imported recipe';
  const description = _str(r.description) || null;
  const imgUrl = _firstUrl(r.image) || null;
  const yieldText = _str(r.recipeYield);
  const servings = _parseServings(yieldText);
  const prepMinutes = _parseDuration(r.prepTime);
  const cookMinutes = _parseDuration(r.cookTime);
  const totalMinutes = _parseDuration(r.totalTime);
  // If we have only a total but no breakdown, surface it as cook time so
  // the meta row has something to show.
  const cook = cookMinutes ?? (prepMinutes == null && totalMinutes != null ? totalMinutes : null);
  // Keep totalTime distinctly when the source gives both a total AND at
  // least one of prep/cook (i.e. the site is telling us there's a
  // resting/marinating gap that prep+cook alone would understate).
  const totalCol = totalMinutes != null && (prepMinutes != null || cookMinutes != null)
    ? totalMinutes
    : null;

  // Ingredients — flat list under one unnamed group. Parse each schema.org
  // string into qty / unit / name / note so the pantry doesn't end up with
  // entries like "0.25 cup butter" — it should hold "butter".
  const items = (r.recipeIngredient || [])
    .map(s => _parseIngredientLine(_str(s)))
    .filter(i => i.name);

  // Steps — recipeInstructions can be:
  //   - string (whole block)
  //   - array of strings
  //   - array of HowToStep objects { name, text }
  //   - HowToSection containing itemListElement[] of HowToSteps
  const steps = _flattenSteps(r.recipeInstructions);

  const tags = [].concat(r.recipeCategory || [], r.recipeCuisine || [], r.keywords || [])
    .flatMap(s => typeof s === 'string' ? s.split(',') : [s])
    .map(s => _str(s)).filter(Boolean).slice(0, 12);

  // First recipeCategory (singular) becomes the recipe's primary category.
  // The catalog match happens server-side in _saveImportedRecipe — here we
  // just surface the raw name. If recipeCategory is missing, recipeCuisine
  // is a reasonable fallback.
  let categoryName = null;
  const _firstCat = [].concat(r.recipeCategory || [], r.recipeCuisine || [])
    .flatMap(s => typeof s === 'string' ? s.split(',') : [s])
    .map(s => _str(s)).filter(Boolean);
  if (_firstCat.length) categoryName = _firstCat[0];

  // Schema.org `tool` (array of strings or HowToTool objects).
  const tools = [].concat(r.tool || []).map(t => _str(t.name || t)).filter(Boolean);

  // Nutrition
  const n = r.nutrition || {};
  const nutrition = {};
  _setNum(nutrition, 'calories',      _parseNum(n.calories));
  _setNum(nutrition, 'fat',           _parseNum(n.fatContent));
  _setNum(nutrition, 'saturated-fat', _parseNum(n.saturatedFatContent));
  _setNum(nutrition, 'trans-fat',     _parseNum(n.transFatContent));
  _setNum(nutrition, 'cholesterol',   _parseNum(n.cholesterolContent));
  _setNum(nutrition, 'sodium',        _parseNum(n.sodiumContent));
  _setNum(nutrition, 'carbohydrates', _parseNum(n.carbohydrateContent));
  _setNum(nutrition, 'fiber',         _parseNum(n.fiberContent));
  _setNum(nutrition, 'sugars',        _parseNum(n.sugarContent));
  _setNum(nutrition, 'proteins',      _parseNum(n.proteinContent));

  return {
    name,
    description,
    imgUrl,
    servings,
    yield_text: yieldText || null,
    prep_minutes:  prepMinutes ?? null,
    cook_minutes:  cook ?? null,
    rest_minutes:  _parseDuration(r.restTime),
    total_minutes: totalCol,
    ingredients: items.length ? [{ name: '', items }] : [],
    steps,
    tags,
    tools,
    nutrition,
    source_url: sourceUrl,
    notes: null,
    category_name: categoryName,
    video_url: _extractVideoUrl(r),
  };
}

// schema.org/Recipe `video` field: VideoObject (or array of). We try
// `embedUrl` first, then `contentUrl`, then `url`. Returning whatever
// landing URL we can find — RecipeView's video block knows how to
// embed YouTube/Vimeo and falls back to a plain link otherwise.
function _extractVideoUrl(r) {
  const v = r?.video;
  if (!v) return null;
  const first = Array.isArray(v) ? v[0] : v;
  if (!first) return null;
  if (typeof first === 'string') return first.trim() || null;
  return _str(first.embedUrl) || _str(first.contentUrl) || _str(first.url) || null;
}

function _str(x) {
  if (x == null) return '';
  if (typeof x === 'string') return _decodeEntities(x).trim();
  if (Array.isArray(x)) return _str(x[0]);
  if (typeof x === 'object' && x['@value']) return _str(x['@value']);
  return _decodeEntities(String(x)).trim();
}

// Sites occasionally double-encode JSON-LD content — string values come
// out with literal HTML entities like `Tortine all&#8217;arancia` even
// though they live inside JSON. Decode the common named + numeric
// entities so user-visible text is clean. Hex (`&#xNN;`) and decimal
// (`&#NN;`) numeric forms cover most punctuation; the small named map
// catches the handful that show up in recipe content.
const _NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  deg: '°', frac12: '½', frac14: '¼', frac34: '¾',
};
function _decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g,            (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return _; } })
    .replace(/&([a-zA-Z]+);/g,       (m, n) => _NAMED_ENTITIES[n] != null ? _NAMED_ENTITIES[n] : m);
}
function _firstUrl(x) {
  if (!x) return null;
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return _firstUrl(x[0]);
  if (typeof x === 'object') return x.url || x['@id'] || null;
  return null;
}
function _parseDuration(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return null;
  return (parseInt(m[1] || '0', 10) * 60) + parseInt(m[2] || '0', 10);
}
function _parseServings(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function _parseNum(s) {
  if (s == null) return null;
  const m = String(s).match(/[\d.]+/);
  return m ? Number(m[0]) : null;
}
function _setNum(obj, key, val) { if (val != null && Number.isFinite(val)) obj[key] = val; }

// ── Ingredient line parser ─────────────────────────────────────────────────
// Splits "0.25 cup butter" → { qty: '0.25', unit: 'cup', name: 'butter' }.
// Mirrors the unit catalog in src/lib/units.js but kept self-contained so
// this module stays a leaf on the server.
const UNIT_VARIANTS = {
  // teaspoon / tablespoon
  'tsp': 'tsp', 'tsps': 'tsp', 't': 'tsp', 'teaspoon': 'tsp', 'teaspoons': 'tsp',
  'tbsp': 'tbsp', 'tbsps': 'tbsp', 'tbs': 'tbsp', 'tbl': 'tbsp', 'tablespoon': 'tbsp', 'tablespoons': 'tbsp',
  // cup / pint / quart / gallon
  'c': 'cup', 'cup': 'cup', 'cups': 'cup',
  'pt': 'pt', 'pint': 'pt', 'pints': 'pt',
  'qt': 'qt', 'quart': 'qt', 'quarts': 'qt',
  'gal': 'gal', 'gallon': 'gal', 'gallons': 'gal',
  // fluid ounce — handled as two-word match
  'fl oz': 'fl oz', 'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
  // metric volume
  'ml': 'ml', 'millilitre': 'ml', 'milliliter': 'ml', 'millilitres': 'ml', 'milliliters': 'ml',
  'cl': 'cl', 'centilitre': 'cl', 'centiliter': 'cl',
  'dl': 'dl', 'decilitre': 'dl', 'deciliter': 'dl',
  'l': 'l', 'litre': 'l', 'liter': 'l', 'litres': 'l', 'liters': 'l',
  // weight
  'oz': 'oz', 'ounce': 'oz', 'ounces': 'oz',
  'lb': 'lb', 'lbs': 'lb', 'pound': 'lb', 'pounds': 'lb',
  'mg': 'mg', 'milligram': 'mg', 'milligrams': 'mg',
  'g': 'g', 'gram': 'g', 'grams': 'g',
  'kg': 'kg', 'kilogram': 'kg', 'kilograms': 'kg',
  // count / descriptive
  'pc': 'pc', 'pcs': 'pc', 'piece': 'pc', 'pieces': 'pc',
  'clove': 'clove', 'cloves': 'clove',
  'sprig': 'sprig', 'sprigs': 'sprig',
  'slice': 'slice', 'slices': 'slice',
  'stick': 'stick', 'sticks': 'stick',
  'pinch': 'pinch', 'pinches': 'pinch',
  'dash': 'dash', 'dashes': 'dash',
  'drop': 'drop', 'drops': 'drop',
  'splash': 'splash', 'splashes': 'splash',
  'can': 'can', 'cans': 'can',
  'jar': 'jar', 'jars': 'jar',
  'package': 'pkg', 'packages': 'pkg', 'pkg': 'pkg',
  'bottle': 'bottle', 'bottles': 'bottle',
};

export function parseIngredientLine(line) { return _parseIngredientLine(line); }
function _parseIngredientLine(line) {
  if (!line || typeof line !== 'string') return { qty: '', unit: '', name: '', note: '' };
  const original = line.trim();

  // Pull anything in parens out as a note ("(divided)", "(or to taste)").
  let note = '';
  let working = original.replace(/\s*\(([^)]+)\)/g, (_, n) => {
    note = note ? note + '; ' + n.trim() : n.trim();
    return '';
  }).trim();

  // Quantity: integer | mixed (1 1/2) | fraction (1/2) | decimal (0.25).
  // Also accept unicode vulgar fractions (½, ¼, ¾, ⅓, ⅔) by mapping them.
  const VULGAR = { '½':'1/2','⅓':'1/3','⅔':'2/3','¼':'1/4','¾':'3/4','⅕':'1/5','⅖':'2/5','⅗':'3/5','⅘':'4/5','⅙':'1/6','⅚':'5/6','⅛':'1/8','⅜':'3/8','⅝':'5/8','⅞':'7/8' };
  working = working.replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, ch => ' ' + VULGAR[ch] + ' ').replace(/\s+/g, ' ').trim();

  // European-style tight metric units ("320g", "1.5kg", "100ml") —
  // inject a space between a leading numeric quantity and a known
  // metric/imperial unit so the qty + unit regexes below see them
  // as separate tokens. Limited to short unambiguous units; longer
  // English forms like "tsp"/"tbsp"/"cup" stay space-required to
  // avoid swallowing words that happen to start with the same letters.
  working = working.replace(/^(\d+(?:\.\d+)?)(kg|mg|ml|dl|cl|oz|lb|g|l)\b/i, '$1 $2');

  // Conjunctive mixed numbers: "1 and 1/2 cups" → "1 1/2 cups". Some
  // recipe sites (and recipe-scrapers' raw lines) write the integer +
  // fraction with "and" between them; without this normalize step the
  // qty regex below only matches the leading integer and the fraction
  // gets misparsed as the unit.
  working = working.replace(/^(\d+)\s+and\s+(\d+\s*\/\s*\d+)\b/i, '$1 $2');

  let qty = '';
  const qtyRx = /^([0-9]+(?:\s+[0-9]+\/[0-9]+)|[0-9]+\/[0-9]+|[0-9]+(?:\.[0-9]+)?)\s+/;
  const qm = working.match(qtyRx);
  if (qm) {
    qty = qm[1].trim();
    working = working.slice(qm[0].length);
  }

  // Unit. Try a two-word phrase first (so "fluid ounce" beats "fluid").
  let unit = '';
  const twoWord = working.match(/^([A-Za-z]+\s+[A-Za-z]+)\b/);
  if (twoWord) {
    const cand = twoWord[1].toLowerCase().replace(/\./g, '');
    if (UNIT_VARIANTS[cand]) {
      unit = UNIT_VARIANTS[cand];
      working = working.slice(twoWord[0].length).trim();
    }
  }
  if (!unit) {
    const oneWord = working.match(/^([A-Za-z]+)\.?\b/);
    if (oneWord) {
      const cand = oneWord[1].toLowerCase();
      if (UNIT_VARIANTS[cand]) {
        unit = UNIT_VARIANTS[cand];
        working = working.slice(oneWord[0].length).replace(/^\.\s*/, '').trim();
      }
    }
  }

  // Strip a leading particle that joins quantity to the name in many
  // languages: English "of", Italian "di / d'", Spanish "de", French "de
  // / d'", German "von". Only strip when there's a real name after it
  // (otherwise "of" might be the whole name, unlikely but cheap to guard).
  let name = working
    .replace(/^(?:of|di|de|von|do|da)\s+/i, '')
    .replace(/^d['’]/i, '')
    .trim();

  // Trailing "to taste" / "as needed" / "optional" patterns become notes.
  const tail = name.match(/^(.+?)[,\s]+(to taste|as needed|optional|divided|chopped|sifted)$/i);
  if (tail && tail[1].trim()) {
    name = tail[1].trim();
    note = note ? note + '; ' + tail[2] : tail[2];
  }

  return { qty, unit, name, note };
}

function _flattenSteps(instructions) {
  if (!instructions) return [];
  if (typeof instructions === 'string') {
    return instructions.split(/\n+|\r+|(?<=\.)\s+(?=[A-Z])/).map(t => t.trim()).filter(Boolean).map(t => ({ title: '', text: t }));
  }
  if (!Array.isArray(instructions)) return [];
  const out = [];
  for (const item of instructions) {
    if (typeof item === 'string') {
      out.push({ title: '', text: _str(item) });
      continue;
    }
    if (item['@type'] === 'HowToSection' && Array.isArray(item.itemListElement)) {
      for (const sub of item.itemListElement) {
        if (typeof sub === 'string') out.push({ title: _str(item.name), text: sub });
        else out.push({ title: _str(sub.name) || _str(item.name), text: _str(sub.text) });
      }
    } else {
      out.push({ title: _str(item.name), text: _str(item.text) || _str(item) });
    }
  }
  return out.filter(s => s.text);
}
