/**
 * quantity.js: amounts and units, the same on the server and in the app.
 *
 * Two identical copies: src/lib/quantity.js (web and Android) and
 * server/lib/quantity.js (the server image has no src/). A test checks
 * they match, so edit one and copy it over.
 *
 * Recipe quantities are free text ("1", "1/2", "1 1/2", "½", "0,5",
 * "4-5", "to taste"). parseQty() gives a number when there is one,
 * parseQtyRange() also reads ranges, and anything unreadable stays as the
 * text it was: never NaN, never 0.
 */

// ── Reading a quantity ──────────────────────────────────────────────────

const VULGAR = {
  '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅕': '1/5', '⅖': '2/5',
  '⅗': '3/5', '⅘': '4/5', '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
};
const VULGAR_RX = /[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g;

// "1½" and "1 ½" become "1 1/2"; "1 and 1/2" becomes "1 1/2"; a decimal
// comma ("0,5") becomes a point. Only "d,d" or "d,dd": "1,000" is left.
function _normalize(s) {
  return String(s)
    .replace(VULGAR_RX, ch => ' ' + VULGAR[ch])
    .replace(/(\d+)\s+and\s+(\d+\s*\/\s*\d+)/gi, '$1 $2')
    .replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2')
    .replace(/\s+/g, ' ')
    .trim();
}

// One number: "2", "1.5", "1/2", "1 1/2".
function _number(str) {
  const mixed = str.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const d = parseInt(mixed[3], 10);
    if (!d) return null;
    return parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / d;
  }
  const frac = str.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const d = parseInt(frac[2], 10);
    if (!d) return null;
    return parseInt(frac[1], 10) / d;
  }
  if (!/^\d*\.?\d+$/.test(str)) return null;
  const n = Number(str);
  return Number.isFinite(n) ? n : null;
}

/** A single quantity as a number, or null ("to taste", "4-5", ""). */
export function parseQty(s) {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const str = _normalize(s);
  if (!str) return null;
  return _number(str);
}

// "4-5", "4 – 5" (en or em dash), "1/2 to 1", "2 or 3".
const DASHES = String.fromCharCode(0x2013, 0x2014);
const RANGE_RX = new RegExp('^(.+?)\\s*(?:-|[' + DASHES + ']|to|or)\\s*(.+)$', 'i');

/** A quantity or a range: { lo, hi } (equal for a single number), or null. */
export function parseQtyRange(s) {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? { lo: s, hi: s } : null;
  const str = _normalize(s);
  if (!str) return null;
  const one = _number(str);
  if (one != null) return { lo: one, hi: one };
  const m = str.match(RANGE_RX);
  if (!m) return null;
  const lo = _number(m[1].trim());
  const hi = _number(m[2].trim());
  if (lo == null || hi == null || hi < lo) return null;
  return { lo, hi };
}

/** The amount to buy: a range's upper end, so there's enough. */
export function qtyToBuy(s) {
  const r = parseQtyRange(s);
  return r ? r.hi : null;
}

// ── Writing a quantity ──────────────────────────────────────────────────

const COMMON_FRACTIONS = [
  [1/8, '1/8'], [1/4, '1/4'], [1/3, '1/3'], [3/8, '3/8'],
  [1/2, '1/2'], [5/8, '5/8'], [2/3, '2/3'], [3/4, '3/4'], [7/8, '7/8'],
];
const FRAC_TOL = 0.03;

/** A number as a cook writes it: 0.5 → "1/2", 1.333 → "1 1/3", 0.2 → "0.2". */
export function formatQty(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 0) return n.toString();
  const wholes = Math.floor(n);
  const frac = n - wholes;
  if (frac < FRAC_TOL)     return String(wholes);
  if (1 - frac < FRAC_TOL) return String(wholes + 1);
  for (const [val, str] of COMMON_FRACTIONS) {
    if (Math.abs(frac - val) < FRAC_TOL) return wholes ? `${wholes} ${str}` : str;
  }
  return n.toFixed(2).replace(/\.?0+$/, '');
}

/** A number trimmed to at most two decimals: 1.5 → "1.5", 100 → "100". */
export function formatDecimal(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, '');
}

/** Scale a quantity string; ranges scale both ends, text stays as it is. */
export function scaleQty(s, factor) {
  if (factor === 1 || factor == null) return s;
  const n = parseQty(s);
  if (n != null) return formatQty(n * factor);
  const r = parseQtyRange(s);
  if (r) return `${formatQty(r.lo * factor)}-${formatQty(r.hi * factor)}`;
  return s;
}

// Units where fractions are how people say it (1/4 cup); weights and
// metric volume stay decimal (1.5 g, 250 ml).
const FRACTION_UNITS = new Set(['tsp', 'tbsp', 'cup', 'pt', 'qt', 'gal', 'fl oz']);

/**
 * A quantity for reading, scaled and written the way its unit is:
 *   "0.25" + cup → "1/4", "1.5" + g → "1.5", "4-5" ×2 → "8-10",
 *   "to taste" → "to taste".
 */
export function displayQty(qty, unit, scale = 1) {
  if (qty == null || qty === '') return '';
  const fmt = FRACTION_UNITS.has(normalizeUnit(unit)) ? formatQty : formatDecimal;
  const n = parseQty(qty);
  if (n != null) return fmt(n * (scale || 1));
  const r = parseQtyRange(qty);
  if (r) return `${fmt(r.lo * (scale || 1))}-${fmt(r.hi * (scale || 1))}`;
  return String(qty);
}

/**
 * displayQty split for typography: { whole, fraction }.
 *   "1 1/2" → { whole: '1', fraction: '1/2' }, "1/2" → { whole: '', fraction: '1/2' },
 *   anything else → { whole: it, fraction: '' }.
 */
export function displayQtyParts(qty, unit, scale = 1) {
  const s = displayQty(qty, unit, scale);
  if (!s) return { whole: '', fraction: '' };
  const mixed = s.match(/^(\d+)\s+(\d+\/\d+)$/);
  if (mixed) return { whole: mixed[1], fraction: mixed[2] };
  if (/^\d+\/\d+$/.test(s)) return { whole: '', fraction: s };
  return { whole: s, fraction: '' };
}

// ── Units ───────────────────────────────────────────────────────────────

// Spellings recipes use, to the abbreviation the app stores.
const UNIT_VARIANTS = {
  tsp: 'tsp', tsps: 'tsp', t: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tbl: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  c: 'cup', cup: 'cup', cups: 'cup',
  pt: 'pt', pint: 'pt', pints: 'pt',
  qt: 'qt', quart: 'qt', quarts: 'qt',
  gal: 'gal', gallon: 'gal', gallons: 'gal',
  'fl oz': 'fl oz', 'fl. oz': 'fl oz', floz: 'fl oz', 'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
  ml: 'ml', millilitre: 'ml', milliliter: 'ml', millilitres: 'ml', milliliters: 'ml',
  cl: 'cl', centilitre: 'cl', centiliter: 'cl', centilitres: 'cl', centiliters: 'cl',
  dl: 'dl', decilitre: 'dl', deciliter: 'dl', decilitres: 'dl', deciliters: 'dl',
  l: 'l', litre: 'l', liter: 'l', litres: 'l', liters: 'l',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  mg: 'mg', milligram: 'mg', milligrams: 'mg',
  g: 'g', gram: 'g', grams: 'g', gr: 'g',
  kg: 'kg', kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg',
  pc: 'pc', pcs: 'pc', piece: 'pc', pieces: 'pc',
  clove: 'clove', cloves: 'clove',
  sprig: 'sprig', sprigs: 'sprig',
  slice: 'slice', slices: 'slice',
  stick: 'stick', sticks: 'stick',
  pinch: 'pinch', pinches: 'pinch',
  dash: 'dash', dashes: 'dash',
  drop: 'drop', drops: 'drop',
  splash: 'splash', splashes: 'splash',
  can: 'can', cans: 'can',
  jar: 'jar', jars: 'jar',
  pkg: 'pkg', package: 'pkg', packages: 'pkg',
  bottle: 'bottle', bottles: 'bottle',
};

function _unitWord(unit) {
  return String(unit).toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ').trim();
}

/** A unit as the app stores it: "Tablespoons" → "tbsp"; unknown units lowercased. */
export function normalizeUnit(unit) {
  if (unit == null) return '';
  const u = _unitWord(unit);
  return UNIT_VARIANTS[u] || u;
}

/** Whether a word is a unit the app knows ("cups", "g", "cloves"). */
export function isKnownUnit(word) {
  if (word == null) return false;
  return _unitWord(word) in UNIT_VARIANTS;
}

// How many base units (ml, g) one of each unit is.
const VOLUME_TO_ML = {
  ml: 1, cl: 10, dl: 100, l: 1000,
  tsp: 4.929, tbsp: 14.787, 'fl oz': 29.574,
  cup: 236.588, pt: 473.176, qt: 946.353, gal: 3785.411,
};
const WEIGHT_TO_G = { mg: 0.001, g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };

/** 'volume', 'weight', 'count' (pieces, cloves, unknown units), or null for none. */
export function unitFamily(unit) {
  if (!unit) return null;
  const u = normalizeUnit(unit);
  if (!u) return null;
  if (VOLUME_TO_ML[u] != null) return 'volume';
  if (WEIGHT_TO_G[u] != null) return 'weight';
  return 'count';
}

/** qty in fromUnit, as toUnit; only within one family (count units must match). */
export function convertWithinFamily(qty, fromUnit, toUnit) {
  if (qty == null || !Number.isFinite(qty)) return null;
  const fromFam = unitFamily(fromUnit);
  const toFam = unitFamily(toUnit);
  if (!fromFam || !toFam || fromFam !== toFam) return null;
  const fu = normalizeUnit(fromUnit);
  const tu = normalizeUnit(toUnit);
  if (fromFam === 'volume') return qty * VOLUME_TO_ML[fu] / VOLUME_TO_ML[tu];
  if (fromFam === 'weight') return qty * WEIGHT_TO_G[fu] / WEIGHT_TO_G[tu];
  return fu === tu ? qty : null;
}

/**
 * Like convertWithinFamily, and volume to weight (or back) when the
 * ingredient's grams per cup are known.
 */
export function convertQty(qty, fromUnit, toUnit, gPerCup) {
  if (qty == null || !Number.isFinite(qty)) return null;
  const same = convertWithinFamily(qty, fromUnit, toUnit);
  if (same != null) return same;
  if (!gPerCup || !Number.isFinite(gPerCup) || gPerCup <= 0) return null;
  const fromFam = unitFamily(fromUnit);
  const toFam = unitFamily(toUnit);
  const fu = normalizeUnit(fromUnit);
  const tu = normalizeUnit(toUnit);
  if (fromFam === 'volume' && toFam === 'weight') {
    const grams = qty * VOLUME_TO_ML[fu] * (gPerCup / VOLUME_TO_ML.cup);
    return grams / WEIGHT_TO_G[tu];
  }
  if (fromFam === 'weight' && toFam === 'volume') {
    const ml = qty * WEIGHT_TO_G[fu] / (gPerCup / VOLUME_TO_ML.cup);
    return ml / VOLUME_TO_ML[tu];
  }
  return null;
}

/**
 * Where amounts of one ingredient can be added up: volume with volume,
 * weight with weight, a count unit only with itself, and no unit with no
 * unit. Amounts with different keys stay apart.
 */
export function amountKey(unit) {
  const fam = unitFamily(unit);
  if (!fam) return 'each';
  if (fam === 'count') return 'count:' + normalizeUnit(unit);
  return fam;
}

// A volume or weight total, in the unit that reads best: the largest unit
// any part used that gives at least 1, else the smallest one used.
function _bestUnit(totalBase, units, table) {
  const used = [...new Set(units.map(normalizeUnit))].filter(u => table[u] != null)
    .sort((a, b) => table[b] - table[a]);
  for (const u of used) if (totalBase / table[u] >= 1 - FRAC_TOL) return u;
  return used[used.length - 1];
}

/**
 * Add amounts that share an amountKey: [{ qty: number|null, unit }].
 * Returns { qty, unit }: the total in the unit that reads best, qty null
 * when no part had a number. 1 cup + 120 ml → about 1.51 cup.
 */
export function sumAmounts(parts) {
  const withQty = parts.filter(p => p.qty != null && Number.isFinite(p.qty));
  const firstUnit = parts.find(p => p.unit)?.unit || '';
  if (!withQty.length) return { qty: null, unit: normalizeUnit(firstUnit) || null };
  const fam = unitFamily(withQty[0].unit);
  if (fam === 'volume' || fam === 'weight') {
    const table = fam === 'volume' ? VOLUME_TO_ML : WEIGHT_TO_G;
    const base = withQty.reduce((s, p) => s + p.qty * table[normalizeUnit(p.unit)], 0);
    const unit = _bestUnit(base, withQty.map(p => p.unit), table);
    return { qty: base / table[unit], unit };
  }
  return { qty: withQty.reduce((s, p) => s + p.qty, 0), unit: normalizeUnit(firstUnit) || null };
}

/** A total rounded for a shopping list: eighths where cooks use fractions, else two decimals. */
export function roundForList(qty, unit) {
  if (qty == null || !Number.isFinite(qty)) return null;
  if (FRACTION_UNITS.has(normalizeUnit(unit))) return Math.round(qty * 8) / 8;
  return Math.round(qty * 100) / 100;
}

// ── Names ───────────────────────────────────────────────────────────────

/**
 * The key two ingredient names match on: lowercase, accents and spacing
 * folded, and an English plural made singular ("Tomatoes" and "tomato",
 * "berries" and "berry"). For matching only; the name shown stays as typed.
 */
export function ingredientKey(name) {
  const s = String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!s) return '';
  const words = s.split(' ');
  words[words.length - 1] = _singular(words[words.length - 1]);
  return words.join(' ');
}

function _singular(w) {
  if (w.length <= 3) return w;
  if (/(?:ss|us|is)$/.test(w)) return w;                                 // glass, couscous, anise
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y';                        // berries, cherries
  if (/(?:oes|ches|shes|xes|sses|zes)$/.test(w)) return w.slice(0, -2);   // tomatoes, peaches
  if (/s$/.test(w)) return w.slice(0, -1);                                // onions, eggs
  return w;
}
