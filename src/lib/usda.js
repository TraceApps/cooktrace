/**
 * usda.js — USDA FoodData Central client, scoped to pantry items.
 *
 * Mirrors NutriTrace's USDA helper, but normalises to the pantry shape
 * (name, brand, serving_size, serving_unit, nutrition, barcode).
 *
 * Routing: same `/api/proxy?url=…` pattern the OFF helper uses on PWA
 * and server-connected native, but local-mode native goes direct via
 * CapacitorHttp (no server to proxy through).
 */
import { apiUrl, isNative, getServerUrl } from './platform.js';
import { deriveSodiumSalt } from './nutriments.js';

const USDA_BASE = 'https://api.nal.usda.gov/fdc/v1';

// USDA data-type priority (lower = higher quality, surface first).
// Foundation Foods are laboratory-analyzed staples; SR Legacy is the
// classic USDA Standard Reference; Survey (FNDDS) is composite dietary
// data; Branded is manufacturer-submitted with widely varying quality;
// Experimental is tiny research data. Unknown/null sinks to the bottom.
const _USDA_TYPE_PRIORITY = {
  'Foundation':      1,
  'SR Legacy':       2,
  'Survey (FNDDS)':  3,
  'Branded':         4,
  'Experimental':    5,
};

// Re-rank USDA search results within each fetched page so higher-quality
// tiers surface above manufacturer-submitted Branded entries. USDA's
// server-side relevance is text-match based and doesn't consider tier
// quality, so a search for "chicken" returns dozens of branded chicken
// products before the one curated Foundation entry.
function _rankUSDAResults(items) {
  if (!Array.isArray(items) || items.length < 2) return items;
  return items.slice().sort((a, b) => {
    const aP = _USDA_TYPE_PRIORITY[a.dataType] || 99;
    const bP = _USDA_TYPE_PRIORITY[b.dataType] || 99;
    return aP - bP;
  });
}

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
    // Through lib/native-http.js: plain http:// only to a confirmed local server.
    const { NativeHttp } = await import('./native-http.js');
    const res = await NativeHttp.get({
      url,
      headers: { 'Accept': 'application/json' },
      responseType: 'json',
    });
    return _wrapCapacitor(res);
  }
  return fetch(apiUrl('/api/proxy?url=' + encodeURIComponent(url)));
}

// FDC nutrient ID → CookTrace nutrition object key (matches NT exactly).
const _USDA_NUTRIENT_MAP = {
  1008: 'calories',         // Energy kcal
  1062: 'kilojoules',       // Energy kJ
  1003: 'proteins',
  1004: 'fat',
  1258: 'saturated-fat',
  1257: 'trans-fat',
  1292: 'monounsaturated-fat',
  1293: 'polyunsaturated-fat',
  1005: 'carbohydrates',
  2000: 'sugars',
  1235: 'added-sugars',
  1079: 'fiber',
  1093: 'sodium',           // mg
  1253: 'cholesterol',      // mg
  1087: 'calcium',          // mg
  1089: 'iron',             // mg
  1092: 'potassium',        // mg
  1090: 'magnesium',        // mg
  1095: 'zinc',             // mg
  1091: 'phosphorus',       // mg
  1162: 'vitamin-c',        // mg
  1106: 'vitamin-a',        // mcg
  1114: 'vitamin-d',        // mcg
  1109: 'vitamin-e',        // mg
  1185: 'vitamin-k',        // mcg
  1165: 'b1',               // mg
  1166: 'b2',               // mg
  1167: 'b3',               // mg
  1175: 'b6',               // mg
  1177: 'b9',               // mcg (folate)
  1178: 'b12',              // mcg
  1170: 'b5',               // mg (pantothenic acid)
  1009: 'starch',           // g
  1100: 'iodine',           // mcg
  1103: 'selenium',         // mcg
  1098: 'copper',           // mg
  1101: 'manganese',        // mg
  1180: 'choline',          // mg (Choline, total)
};

// FoodData Central gives every nutrient per 100 g (or 100 ml), for every data
// type: the search's `value` and the detail's `amount`, Branded included. For
// Branded foods USDA works them out from the label's per-serving numbers, and
// `servingSize` only notes the label's serving. They were once scaled by
// 100 / servingSize as if per serving (TraceApps/nutritrace#290). Sources:
// https://fdc.nal.usda.gov/GBFPD_Documentation and food_nutrient.amount in
// https://fdc.nal.usda.gov/docs/Download_Field_Descriptions_Oct2020.pdf
export function mapUsdaFood(item) {
  const nutrition = {};

  for (const fn of (item.foodNutrients || [])) {
    const nid = fn.nutrientId || (fn.nutrient && fn.nutrient.id);
    const key = _USDA_NUTRIENT_MAP[nid];
    const raw = fn.value != null ? fn.value : fn.amount;
    if (key && raw != null) {
      nutrition[key] = Math.round(raw * 10000) / 10000;
    }
  }
  // Derive kJ from kcal if missing.
  if (nutrition.calories && !nutrition.kilojoules) {
    nutrition.kilojoules = Math.round(nutrition.calories * 4.184 * 10) / 10;
  }
  // Sodium ↔ salt derive (sets `_derived` so the UI badge can fire).
  deriveSodiumSalt(nutrition);
  // FDC's "Carbohydrate, by difference" includes fiber. Subtract so the
  // value matches OFF's net-carbs convention.
  if (nutrition.carbohydrates != null && nutrition.fiber != null) {
    let corrected = nutrition.carbohydrates - nutrition.fiber;
    if (corrected < (nutrition.sugars || 0)) corrected = nutrition.sugars || 0;
    nutrition.carbohydrates = Math.round(corrected * 10000) / 10000;
  }

  // Branded liquids are per 100 ml. USDA writes the unit as "ml" or "MLT".
  const rawUnit = (item.servingSizeUnit || 'g').toLowerCase();
  const unit = (rawUnit === 'ml' || rawUnit === 'mlt') ? 'ml' : 'g';

  return {
    name:         (item.description || '').trim(),
    brand:        (item.brandOwner || item.brandName || '').trim(),
    barcode:      item.gtinUpc || (item.fdcId ? 'fdcId_' + item.fdcId : ''),
    serving_size: 100,
    serving_unit: unit,
    img_url:      '',
    nutrition,
    // USDA's `dataType` distinguishes the source database (Foundation,
    // SR Legacy, Survey/FNDDS, Branded, Experimental). Feeds the tier
    // sort + the small badge shown next to each USDA result row.
    dataType:     item.dataType || null,
    _source:      'usda',
  };
}

/** Free-text search. Returns up to 20 normalized pantry-shape rows. */
export async function searchByName(query, page = 1, apiKey) {
  if (!apiKey) return [];
  const q = (query || '').trim();
  if (!q) return [];
  try {
    const url = `${USDA_BASE}/foods/search?query=${encodeURIComponent(q)}&pageSize=20&pageNumber=${page}&api_key=${encodeURIComponent(apiKey)}`;
    const res = await _extFetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const items = (data.foods || []).map(f => mapUsdaFood(f)).filter(f => f.name);
    return _rankUSDAResults(items);
  } catch (e) {
    console.warn('[usda] search failed:', e);
    return [];
  }
}

/** Branded barcode → pantry shape. Returns null when no UPC match. */
export async function lookupBarcode(barcode, apiKey) {
  if (!apiKey || !barcode) return null;
  try {
    const url = `${USDA_BASE}/foods/search?query=${encodeURIComponent(barcode)}&dataType=Branded&pageSize=10&api_key=${encodeURIComponent(apiKey)}`;
    const res = await _extFetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const match = (data.foods || []).find(f =>
      f.gtinUpc && (f.gtinUpc === barcode || f.gtinUpc === barcode.replace(/^0+/, ''))
    );
    if (!match) return null;
    return mapUsdaFood(match);
  } catch (e) {
    console.warn('[usda] barcode lookup failed:', e);
    return null;
  }
}

/** The fdcId in a barcode ("fdcId_171688"), or null. */
export function usdaFdcId(barcode) {
  const m = /^fdcId_(\d+)$/.exec(String(barcode || '').trim());
  return m ? m[1] : null;
}

/**
 * Refresh from USDA in the pantry sheet (TraceApps/nutritrace#290): the item
 * again: by its fdcId_ barcode, or by GTIN for a Branded item (those are kept
 * under their GTIN). Returns null when USDA does not have it. An fdcId_ lookup
 * throws when the request fails; a GTIN one reads that as not found, as
 * lookupBarcode always has.
 */
export async function lookupForRefresh(barcode, apiKey) {
  if (!apiKey || !barcode) return null;
  const fdcId = usdaFdcId(barcode);
  if (!fdcId) return lookupBarcode(barcode, apiKey);
  const res = await _extFetch(`${USDA_BASE}/food/${encodeURIComponent(fdcId)}?api_key=${encodeURIComponent(apiKey)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('USDA ' + res.status);
  const item = await res.json();
  return item && item.fdcId ? mapUsdaFood(item) : null;
}
