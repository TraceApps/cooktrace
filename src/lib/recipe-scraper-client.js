/**
 * recipe-scraper-client.js — client-side recipe scraper for Capacitor
 * native local mode. Ports the server-side parsing logic from
 * server/lib/recipe-scraper.js to the browser (DOMParser instead of
 * cheerio, CapacitorHttp instead of node fetch) so URL imports work
 * end-to-end in offline-Android-mode without round-tripping a server.
 *
 * Parity with the server scraper:
 *   - Walks every <script type="application/ld+json"> looking for a
 *     schema.org/Recipe node (direct, @graph wrapper, or nested in an
 *     array of unrelated entities).
 *   - Pulls name / description / image / yield / prep+cook / steps /
 *     tags / tools / nutrition / category / video.
 *   - Falls back to scanning <iframe> / <a> / <meta og:video> for a
 *     YouTube/Vimeo embed when JSON-LD didn't include one.
 *   - Same ingredient-line parser (qty + unit + name + note, vulgar
 *     fractions, conjunctive mixed numbers, European tight metric
 *     units, multilingual particle stripping).
 *   - Same step flattening (string, array of strings, HowToStep,
 *     HowToSection with itemListElement).
 *
 * Differences vs server:
 *   - SSRF guard simplified — Android WebView is sandboxed and the
 *     user is fetching their own URLs interactively; no multi-tenant
 *     attack surface to defend against.
 *   - Uses CapacitorHttp to bypass WebView CORS so most recipe sites
 *     return a 200 instead of a CORS-blocked failure.
 */

import { parseIngredientLine } from './ingredient-line.js';
// One ingredient line split into amount, unit, name and note (shared with the server).
export { parseIngredientLine };

const UA = 'CookTrace/0.11.0 (Android local mode; +https://github.com/TraceApps)';

/**
 * Top-level: fetch + parse + return a normalised recipe object.
 * Mirrors the server's scrapeRecipe export shape.
 */
export async function scrapeRecipeNative(rawUrl) {
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new Error('Not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported');
  }

  const html = await _fetchHtml(url.toString());
  const recipe = _extractRecipe(html, url.toString());
  if (!recipe) {
    throw new Error('No schema.org/Recipe data found on that page');
  }
  return recipe;
}

async function _fetchHtml(url) {
  const { CapacitorHttp } = await import('@capacitor/core');
  const res = await CapacitorHttp.get({
    url,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
    },
    responseType: 'text',
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Source returned ${res.status}`);
  }
  const html = typeof res.data === 'string' ? res.data : String(res.data ?? '');
  if (!html) throw new Error('Empty response');
  return html;
}

/**
 * Helpers exported for recipe-importers-client.js (paste/upload flow).
 * Mirrors the server scraper's public API so the importer port can use
 * the same surface.
 */
export function extractRecipeFromHtml(html, sourceUrl = null) {
  return _extractRecipe(html, sourceUrl);
}
export function normaliseSchemaOrgRecipe(node, sourceUrl = null) {
  return _normalise(node, sourceUrl);
}

function _extractRecipe(html, sourceUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const s of scripts) {
    const text = (s.textContent || '').trim();
    if (!text) continue;
    let parsed;
    try { parsed = JSON.parse(text); } catch { continue; }
    const found = _findRecipe(parsed);
    if (found) {
      const recipe = _normalise(found, sourceUrl);
      if (!recipe.video_url) {
        const fallback = _findEmbeddedVideo(doc);
        if (fallback) recipe.video_url = fallback;
      }
      return recipe;
    }
  }
  return null;
}

function _findEmbeddedVideo(doc) {
  const isVideoHost = (u) => /(?:youtube\.com|youtu\.be|player\.vimeo\.com|vimeo\.com)/i.test(u || '');
  for (const el of doc.querySelectorAll('iframe[src]')) {
    const src = el.getAttribute('src');
    if (isVideoHost(src)) return src;
  }
  for (const el of doc.querySelectorAll('a[href]')) {
    const href = el.getAttribute('href');
    if (isVideoHost(href)) return href;
  }
  const og = doc.querySelector('meta[property="og:video"], meta[property="og:video:url"]')?.getAttribute('content');
  if (isVideoHost(og)) return og;
  return null;
}

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
  // If the source only exposes a total, keep the old behaviour of
  // stashing it in cook so the user still sees SOME time. When both
  // prep AND cook are present, still capture totalTime distinctly so
  // any resting/marinating gap the source encodes is preserved.
  const cook = cookMinutes ?? (prepMinutes == null && totalMinutes != null ? totalMinutes : null);
  const totalCol = totalMinutes != null && (prepMinutes != null || cookMinutes != null)
    ? totalMinutes
    : null;

  const items = (r.recipeIngredient || [])
    .map(s => parseIngredientLine(_str(s)))
    .filter(i => i.name);

  const steps = _flattenSteps(r.recipeInstructions);

  const tags = [].concat(r.recipeCategory || [], r.recipeCuisine || [], r.keywords || [])
    .flatMap(s => typeof s === 'string' ? s.split(',') : [s])
    .map(s => _str(s)).filter(Boolean).slice(0, 12);

  let categoryName = null;
  const _firstCat = [].concat(r.recipeCategory || [], r.recipeCuisine || [])
    .flatMap(s => typeof s === 'string' ? s.split(',') : [s])
    .map(s => _str(s)).filter(Boolean);
  if (_firstCat.length) categoryName = _firstCat[0];

  const tools = [].concat(r.tool || []).map(t => _str(t.name || t)).filter(Boolean);

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
    img_url: imgUrl,
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

const _NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
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
