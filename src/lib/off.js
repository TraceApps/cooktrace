/**
 * off.js — Open Food Facts client helpers, scoped to pantry items.
 *
 * Mirrors NutriTrace's lib/api.js OFF integration, but normalises to
 * the pantry shape (name, brand, barcode, serving_size, serving_unit,
 * nutrition) instead of NT's foods shape.
 *
 * Routing:
 *   - Web (PWA): hits OFF through CookTrace's `/api/proxy?url=` so the
 *     browser's CORS layer is happy (the proxy allowlist already
 *     includes openfoodfacts.org).
 *   - Native server-connected: same proxy path — let the server handle
 *     the outbound request so it can be cached, rate-limited, etc.
 *   - Native LOCAL mode: no server exists, so route through
 *     CapacitorHttp which bypasses the WebView's CORS and reaches
 *     openfoodfacts.org directly.
 */
import { apiUrl, isNative, getServerUrl } from './platform.js';
import { deriveSodiumSalt } from './nutriments.js';

const OFF_BASE = 'https://world.openfoodfacts.org';

// Read the user's saved OFF country-filter preference from localStorage.
// Returns the OFF tag form (lowercase, dashes for spaces) or null when
// 'World' / unset. Store-free so this module doesn't take a settings dep.
function _getOffSearchCountry() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const userId = localStorage.getItem('wl:userId');
    const setKey = userId ? `wl_u${userId}_offSearchCountry` : 'wl_offSearchCountry';
    const raw = localStorage.getItem(setKey);
    if (!raw) return null;
    const country = JSON.parse(raw);
    if (!country || country === 'World') return null;
    return country.toLowerCase().replace(/\s+/g, '-');
  } catch { return null; }
}

// Read the user's saved OFF language preference. Passed to OFF as
// `lc=<code>` so product names / ingredients / categories come back
// translated when OFF has translations. Defaults to 'en'.
function _getOffSearchLanguage() {
  try {
    if (typeof localStorage === 'undefined') return 'en';
    const userId = localStorage.getItem('wl:userId');
    const setKey = userId ? `wl_u${userId}_offSearchLanguage` : 'wl_offSearchLanguage';
    const raw = localStorage.getItem(setKey);
    if (!raw) return 'en';
    const lang = JSON.parse(raw);
    if (!lang || typeof lang !== 'string') return 'en';
    return lang.slice(0, 2).toLowerCase();
  } catch { return 'en'; }
}

// Re-rank OFF search results within the fetched page so higher-quality
// entries surface first. OFF's server-side relevance is name-match based
// and doesn't consider completeness — a search for "yogurt" returns
// entries with 3 nutriment fields set alongside entries with 40 filled
// in. Sort by image presence, completeness score, then Nutri-Score
// presence. Missing fields degrade to 0.
function _rankOFFResults(items) {
  if (!Array.isArray(items) || items.length < 2) return items;
  return items.slice().sort((a, b) => {
    const aImg = a.img_url ? 1 : 0;
    const bImg = b.img_url ? 1 : 0;
    if (aImg !== bImg) return bImg - aImg;
    const aComp = a.completeness ?? 0;
    const bComp = b.completeness ?? 0;
    if (aComp !== bComp) return bComp - aComp;
    const aNs = a.nutriscore ? 1 : 0;
    const bNs = b.nutriscore ? 1 : 0;
    return bNs - aNs;
  });
}

// CapacitorHttp returns a different response shape than fetch — wrap
// it so callers can `.ok` / `.json()` it the same way.
function _wrapCapacitor(res) {
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    async json() {
      if (typeof res.data === 'string') return JSON.parse(res.data);
      return res.data;
    },
  };
}

async function _extFetch(url) {
  if (isNative && !getServerUrl()) {
    const { CapacitorHttp } = await import('@capacitor/core');
    const res = await CapacitorHttp.get({
      url,
      headers: { 'Accept': 'application/json' },
      responseType: 'json',
    });
    return _wrapCapacitor(res);
  }
  return fetch(apiUrl('/api/proxy?url=' + encodeURIComponent(url)));
}

/**
 * Normalize a barcode to its OFF canonical form. OFF stores 12-digit
 * UPC-A codes with a leading zero (canonical EAN-13 form), so a raw
 * 12-digit scan must be padded before lookup or it'll miss the product
 * even when OFF has it under EAN-13. Idempotent for codes that aren't
 * 12 digits (EAN-13, EAN-8, ITF-14, QR payloads pass through unchanged).
 * Ported from NutriTrace commit d338100 (#22 follow-up).
 */
export function canonicalizeBarcode(code) {
  const s = (code || '').toString().trim();
  return /^\d{12}$/.test(s) ? '0' + s : s;
}

/**
 * Look up a barcode on Open Food Facts. Returns a normalized object
 * shaped for the pantry editor, or null if no product / network error.
 */
export async function lookupBarcode(barcode) {
  const code = canonicalizeBarcode(barcode);
  if (!code) return null;
  try {
    const lc = _getOffSearchLanguage();
    const url = `${OFF_BASE}/api/v0/product/${encodeURIComponent(code)}.json?lc=${encodeURIComponent(lc)}`;
    const res = await _extFetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 1) return null;
    return _mapOFFProduct(data.product);
  } catch (e) {
    console.warn('[off] barcode lookup failed:', e);
    return null;
  }
}

/**
 * Search OFF by free-text product name. Returns up to 20 normalized
 * pantry-shape objects per page (no auth required).
 */
export async function searchByName(query, page = 1) {
  const q = (query || '').trim();
  if (!q) return [];
  try {
    const country = _getOffSearchCountry();
    const cq = country ? `&countries_tags_en=${encodeURIComponent(country)}` : '';
    const lc = `&lc=${encodeURIComponent(_getOffSearchLanguage())}`;
    const url = `https://search.openfoodfacts.org/search?q=${encodeURIComponent(q)}&json=1&page_size=20&page=${page}${cq}${lc}`;
    const res = await _extFetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const items = (data.hits || []).map(p => _mapOFFProduct(p)).filter(Boolean);
    return _rankOFFResults(items);
  } catch (e) {
    console.warn('[off] name search failed:', e);
    return [];
  }
}

/**
 * Submit a pantry item to Open Food Facts. Requires the user's OFF
 * account (offUsername / offPassword) configured in Settings — the
 * "nutritrace-app" / "nutritrace" guest account NT uses works as a
 * generic fallback but isn't ideal for attribution.
 */
export async function contributeToOFF(item, settings) {
  const { name, brand, barcode } = item;
  if (!name || !barcode) throw new Error('Name and barcode required');

  const username = (settings && settings.offUsername) || 'cooktrace-app';
  const password = (settings && settings.offPassword) || 'cooktrace';
  const uploadCountry = (settings && settings.offUploadCountry) || 'Auto';
  const lang = (typeof navigator !== 'undefined' && navigator.language || 'en').substring(0, 2);

  let params = 'code=' + encodeURIComponent(barcode);
  params += '&user_id=' + encodeURIComponent(username);
  params += '&password=' + encodeURIComponent(password);
  params += '&lang=' + lang;
  params += '&product_name_' + lang + '=' + encodeURIComponent(name);
  if (brand) params += '&brands=' + encodeURIComponent(brand);
  params += '&nutrition_data_per=100g';
  // Pantry serving size + unit feed OFF's serving_size field. Skip the
  // 100g default since OFF infers that from nutrition_data_per.
  const portion = item.serving_size;
  const portionUnit = item.serving_unit || 'g';
  if (portion && (parseFloat(portion) !== 100 || portionUnit !== 'g')) {
    params += '&serving_size=' + encodeURIComponent(portion + ' ' + portionUnit);
  }
  if (uploadCountry && uploadCountry !== 'Auto') {
    params += '&countries=' + encodeURIComponent(uploadCountry);
  }
  // Map the nutrition keys OFF expects.
  const nutMap = {
    calories: 'energy-kcal', kilojoules: 'energy', fat: 'fat',
    'saturated-fat': 'saturated-fat', carbohydrates: 'carbohydrates',
    sugars: 'sugars', fiber: 'fiber', proteins: 'proteins',
    salt: 'salt', sodium: 'sodium',
  };
  const nut = item.nutrition || {};
  for (const [key, field] of Object.entries(nutMap)) {
    if (nut[key] !== undefined && nut[key] !== '' && !isNaN(parseFloat(nut[key]))) {
      params += '&nutriment_' + field + '=' + nut[key];
    }
  }
  // OFF's contribute endpoint isn't proxy-allowlisted on the server-
  // side (only world.openfoodfacts.org GETs are), but it accepts the
  // form values via GET querystring so we can fire it directly.
  // Browsers + Capacitor WebView can both reach the public OFF host.
  const res = await fetch(`${OFF_BASE}/cgi/product_jqm2.pl?` + params);
  const json = await res.json();
  if (json.status !== 1) throw new Error(json.status_verbose || 'Upload failed');
  return true;
}

// ── Mapping ────────────────────────────────────────────────────────────
function _num(v, mult = 1) {
  if (v == null || v === '') return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n * mult : 0;
}

// Read a nutriment value from OFF's payload, respecting the per-nutrient
// _modifier field. When OFF flags a nutriment with _modifier === '~' the
// value is an algorithmic estimate / contributor guess, not a label-
// derived fact — OFF's own product page hides it from the nutrition
// facts table. Returning 0 keeps our import in line with what the user
// would see on openfoodfacts.org. Other modifiers ('<', '>', '<=', '>=')
// pass through unchanged since those represent real measured boundaries.
// Ported from NutriTrace commit 881df67.
function _numNut(n, baseField, mult = 1) {
  const baseKey = baseField.replace(/_100g$/, '');
  if (n[baseKey + '_modifier'] === '~') return 0;
  return _num(n[baseField], mult);
}

function _mapOFFProduct(p) {
  if (!p || !p.product_name) return null;
  const n = p.nutriments || {};
  const kcal = _numNut(n, 'energy-kcal_100g') || (n.energy_100g ? _numNut(n, 'energy_100g') / 4.184 : 0);

  // OFF data is per 100g unless the product specifies otherwise. We
  // store serving_size = 100, serving_unit = 'g' and trust OFF's
  // nutriment_*_100g fields. The user can change the serving on
  // their pantry item afterwards if they want to scale.
  const nutrition = deriveSodiumSalt({
    calories:        Math.round(kcal * 10) / 10,
    kilojoules:      _numNut(n, 'energy_100g'),
    fat:                   _numNut(n, 'fat_100g'),
    'saturated-fat':       _numNut(n, 'saturated-fat_100g'),
    'trans-fat':           _numNut(n, 'trans-fat_100g'),
    'polyunsaturated-fat': _numNut(n, 'polyunsaturated-fat_100g'),
    'monounsaturated-fat': _numNut(n, 'monounsaturated-fat_100g'),
    carbohydrates:         _numNut(n, 'carbohydrates_100g'),
    sugars:          _numNut(n, 'sugars_100g'),
    'added-sugars':  _numNut(n, 'added-sugars_100g'),
    fiber:           _numNut(n, 'fiber_100g'),
    proteins:        _numNut(n, 'proteins_100g'),
    salt:            _numNut(n, 'salt_100g'),
    sodium:          _numNut(n, 'sodium_100g', 1000),
    potassium:       _numNut(n, 'potassium_100g', 1000),
    cholesterol:     _numNut(n, 'cholesterol_100g', 1000),
  });

  // Quality signals lifted from OFF for the pantry search UI. Used by
  // _rankOFFResults to sort within a fetched page and by the Pantry
  // page's completeness dot + Nutri-Score / NOVA / origin-flag
  // decorations. Any missing field degrades gracefully.
  const completeness = typeof p.completeness === 'number' ? p.completeness : null;
  const nutriscore   = (p.nutriscore_grade || p.nutrition_grades || '').toLowerCase() || null;
  const nova         = typeof p.nova_group === 'number' ? p.nova_group : null;
  // origins_tags is the real manufacturing origin per OFF's taxonomy;
  // fall back to manufacturing_places_tags. countries_tags (where sold)
  // is deliberately NOT used — flagging a US-sold French product with
  // a US flag would be misleading.
  const originTag = (Array.isArray(p.origins_tags) && p.origins_tags[0])
                 || (Array.isArray(p.manufacturing_places_tags) && p.manufacturing_places_tags[0])
                 || null;

  return {
    name:         (p.product_name || '').trim(),
    brand:        (Array.isArray(p.brands) ? (p.brands[0] || '') : (p.brands || '').split(',')[0] || '').trim(),
    barcode:      p.code || p._id || p.id || '',
    serving_size: 100,
    serving_unit: 'g',
    img_url:      p.image_front_display_url || p.image_front_url || p.image_url || p.image_front_small_url || '',
    nutrition,
    completeness,
    nutriscore,
    nova,
    originTag,
    _source:      'off',
  };
}

/**
 * Native: scan a barcode via @capacitor-mlkit/barcode-scanning if
 * available. Returns null on web or if the user cancels. Caller is
 * expected to handle the no-scanner case (the editor's scan icon
 * just no-ops on web in v1; full web-side scanner port is a follow-up).
 */
export async function scanBarcodeNative() {
  if (!isNative) return null;
  try {
    const mod = await import('@capacitor-mlkit/barcode-scanning');
    const { BarcodeScanner } = mod;
    const granted = await BarcodeScanner.requestPermissions();
    if (granted?.camera !== 'granted') return null;
    const result = await BarcodeScanner.scan({ formats: [] }); // any format
    const code = result?.barcodes?.[0]?.rawValue || result?.barcodes?.[0]?.displayValue;
    return code ? String(code).trim() : null;
  } catch {
    return null;
  }
}
