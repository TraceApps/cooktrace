/**
 * allergens.js: what a recipe contains, and who in the household it's a
 * problem for. The same on the server and in the app.
 *
 * Two identical copies: src/lib/allergens.js (web and Android) and
 * server/lib/allergens.js (the server image has no src/). A test checks
 * they match, so edit one and copy it over.
 *
 * Allergens use Open Food Facts' codes for the EU's 14 (they cover the
 * US's nine). Two more codes are for diets, not labels: 'meat' and
 * 'honey'.
 *
 * Where a recipe's allergens come from, per ingredient:
 *   1. its pantry item's, when the item has them (from the label when
 *      scanned or looked up, or set by hand): `allergens` and `traces`,
 *      JSON lists of codes; NULL means not known;
 *   2. otherwise the words in the ingredient's name ("flour", "soy
 *      sauce", "parmesan");
 *   3. then the recipe's own correction: { add: [codes], remove: [codes] }
 *      (gluten-free flour the words can't know about).
 * A help, not a guarantee: worked out from names and labels.
 */

export const ALLERGENS = [
  'en:gluten', 'en:crustaceans', 'en:eggs', 'en:fish', 'en:peanuts', 'en:soybeans', 'en:milk',
  'en:nuts', 'en:celery', 'en:mustard', 'en:sesame-seeds', 'en:sulphur-dioxide-and-sulphites',
  'en:lupin', 'en:molluscs',
];
export const DIET_FLAGS = ['meat', 'honey'];
const _ORDER = [...ALLERGENS, ...DIET_FLAGS];
const _KNOWN = new Set(_ORDER);

// What each diet leaves out.
export const DIETS = {
  vegetarian: ['meat', 'en:fish', 'en:crustaceans', 'en:molluscs'],
  pescatarian: ['meat'],
  vegan: ['meat', 'en:fish', 'en:crustaceans', 'en:molluscs', 'en:milk', 'en:eggs', 'honey'],
  gluten_free: ['en:gluten'],
  dairy_free: ['en:milk'],
};

/** The i18n key part of a code: 'en:sesame-seeds' -> 'sesame_seeds'. */
export function allergenKey(code) {
  return String(code || '').replace(/^en:/, '').replace(/-/g, '_');
}

// Open Food Facts spellings that mean one of ours.
const _ALIASES = {
  'en:soy': 'en:soybeans', 'en:soya': 'en:soybeans', 'en:sesame': 'en:sesame-seeds',
  'en:sulphites': 'en:sulphur-dioxide-and-sulphites', 'en:sulfites': 'en:sulphur-dioxide-and-sulphites',
  'en:tree-nuts': 'en:nuts', 'en:egg': 'en:eggs', 'en:mollusc': 'en:molluscs', 'en:crustacean': 'en:crustaceans',
  'en:peanut': 'en:peanuts', 'en:lupine': 'en:lupin', 'en:wheat': 'en:gluten',
};

/** A list of codes (array or JSON text), known ones only, once each, in order. */
export function cleanCodes(list) {
  let arr = list;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = arr.split(','); } }
  if (!Array.isArray(arr)) return [];
  const set = new Set();
  for (const raw of arr) {
    let c = String(raw || '').trim().toLowerCase();
    if (!c) continue;
    if (!c.includes(':') && !_KNOWN.has(c)) c = 'en:' + c;
    c = _ALIASES[c] || c;
    if (_KNOWN.has(c)) set.add(c);
  }
  return _ORDER.filter(c => set.has(c));
}

/** A pantry item's allergens, or null when nobody knows them. */
export function knownCodes(value) {
  if (value == null || value === '') return null;
  return cleanCodes(value);
}

// ── Reading an ingredient's name ────────────────────────────────────────
// Each code: words that mean it, and phrases that look like them but don't
// ("peanut butter" isn't milk, "eggplant" isn't eggs). Names are folded to
// plain lowercase words first.

const W = s => new RegExp(`\\b(?:${s})\\b`);
const KEYWORDS = {
  'en:gluten': {
    yes: W('flours?|wheat|barley|rye|spelt|semolina|durum|bulgur|couscous|farro|seitan|bread|breads|breadcrumbs?|crumbs|panko|pasta|spaghetti|macaroni|penne|fusilli|linguine|fettuccine|lasagna|lasagne|orzo|ravioli|tortellini|gnocchi|noodles?|ramen|udon|tortillas?|pitas?|naan|bagels?|buns?|rolls|croutons?|crackers?|cookies?|biscuits?|cakes?|pastry|pastries|pie crust|puff pastry|phyllo|filo|dough|pizza|beer|malt|oats|oatmeal|rolled oats|soy sauce|shoyu|teriyaki|hoisin|graham|harina|trigo|cebada|centeno|avena|galletas?|cerveza'),
    no: W('gluten free.*|gf .*|rice flour|almond flour|coconut flour|corn flour|cornflour|chickpea flour|gram flour|tapioca flour|potato flour|buckwheat flour|cassava flour|oat flour gluten free|rice noodles?|glass noodles?|rice paper|corn tortillas?|tamari|rice cakes?|cauliflower crust|sin gluten.*'),
  },
  'en:milk': {
    yes: W('milk|cream|creams|butter|buttermilk|cheese|cheeses|parmesan|parmigiano|mozzarella|cheddar|feta|ricotta|mascarpone|gruyere|brie|camembert|gouda|pecorino|halloumi|paneer|provolone|emmental|manchego|burrata|yogurt|yoghurt|ghee|whey|casein|sour cream|creme fraiche|custard|ice cream|kefir|quark|leche|nata|mantequilla|queso|yogur'),
    no: W('coconut milk|coconut cream|almond milk|oat milk|soy milk|soya milk|rice milk|cashew milk|plant milk|peanut butter|almond butter|cashew butter|nut butter|sunflower butter|cocoa butter|shea butter|apple butter|butternut|butternut squash|butter beans?|butter lettuce|cream of tartar|dairy free.*|vegan.*|non dairy.*|plant based.*|leche de coco|leche de almendras?|leche de avena|leche de soja'),
  },
  'en:eggs': {
    yes: W('eggs?|egg yolks?|egg whites?|yolks?|mayonnaise|mayo|meringue|aioli|huevos?|yemas?'),
    no: W('eggplants?|egg free.*|vegan.*|eggless.*'),
  },
  'en:nuts': {
    yes: W('almonds?|walnuts?|pecans?|cashews?|pistachios?|hazelnuts?|filberts?|macadamias?|brazil nuts?|mixed nuts|nuts|praline|marzipan|frangipane|nutella|gianduja|almendras?|nuez|nueces|avellanas?|pistachos?|anacardos?'),
    no: W('nutmeg|butternut|doughnuts?|donuts?|coconuts?|water chestnuts?|chestnuts?|nutritional yeast|pine nuts?|nut free.*|tiger nuts?'),
  },
  'en:peanuts': {
    yes: W('peanuts?|peanut butter|peanut oil|groundnuts?|satay|cacahuetes?|mani'),
    no: W('peanut free.*'),
  },
  'en:soybeans': {
    yes: W('soy|soya|soybeans?|soy sauce|tofu|tempeh|edamame|miso|tamari|shoyu|soy lecithin|soja'),
    no: W('soy free.*'),
  },
  'en:sesame-seeds': {
    yes: W('sesame|sesame seeds?|sesame oil|tahini|tahina|benne|gomasio|sesamo|ajonjoli'),
  },
  'en:fish': {
    yes: W('fish|salmon|tuna|cod|anchov(?:y|ies)|sardines?|mackerel|trout|halibut|tilapia|haddock|pollock|snapper|sea bass|bass|swordfish|herring|catfish|monkfish|bonito|fish sauce|worcestershire|caesar dressing|pescado|atun|salmon|bacalao|anchoas?|sardinas?'),
    no: W('shellfish|fish free.*|vegan.*'),
  },
  'en:crustaceans': {
    yes: W('shrimps?|prawns?|crabs?|crab meat|lobsters?|crayfish|crawfish|langoustines?|scampi|shellfish|gambas?|camarones?|langostinos?|cangrejos?|langostas?'),
  },
  'en:molluscs': {
    yes: W('mussels?|clams?|oysters?|oyster sauce|scallops?|squid|calamari|octopus|snails?|escargots?|cockles?|abalone|mejillones?|almejas?|ostras?|calamares?|pulpo|vieiras?'),
    no: W('oyster mushrooms?'),
  },
  'en:celery': {
    yes: W('celery|celeriac|celery salt|celery seeds?|apio'),
  },
  'en:mustard': {
    yes: W('mustard|mustards|dijon|mustard seeds?|mustard greens|mostaza'),
  },
  'en:sulphur-dioxide-and-sulphites': {
    yes: W('wine|wines|sherry|port|vermouth|sulphites?|sulfites?|dried apricots?|vino|jerez'),
    no: W('wine free.*'),
  },
  'en:lupin': {
    yes: W('lupin|lupine|lupini|lupin flour|altramuces?'),
  },
  meat: {
    yes: W('meat|meats|beef|steak|steaks|veal|pork|bacon|ham|hams|prosciutto|pancetta|salami|pepperoni|chorizo|sausages?|bratwurst|hot dogs?|lamb|mutton|goat|chicken|chickens|turkey|duck|goose|venison|rabbit|mince|ground beef|ground pork|ground turkey|ribs|brisket|lard|gelatin|gelatine|bone broth|chicken stock|chicken broth|beef stock|beef broth|pollo|carne|cerdo|tocino|jamon|ternera|cordero|pavo|salchichas?'),
    no: W('vegan.*|vegetarian.*|plant based.*|meatless.*|impossible.*|beyond.*|veggie.*|mock.*|soy chorizo|eggplant bacon|coconut bacon|meat free.*|sin carne|goats? cheese|goats? milk|goats? yogurt'),
  },
  honey: {
    yes: W('honey|honeycomb|miel'),
    no: W('honeydew|honeycrisp|honey crisp|vegan.*'),
  },
};

function _fold(s) {
  return ' ' + String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

/** The codes an ingredient's name suggests (allergens and diet flags). */
export function nameCodes(name) {
  const text = _fold(name);
  if (!text.trim()) return [];
  const out = [];
  for (const code of _ORDER) {
    const k = KEYWORDS[code];
    if (!k) continue;
    const t = k.no ? text.replace(new RegExp(k.no.source, 'g'), ' ') : text;
    if (k.yes.test(t)) out.push(code);
  }
  return out;
}

// ── A recipe's allergens ────────────────────────────────────────────────

function _groups(ingredients) {
  let g = ingredients;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = []; } }
  if (!Array.isArray(g)) return [];
  if (g.every(x => x && !Array.isArray(x.items))) return [{ items: g }];
  return g;
}

/** Recipe corrections: { add, remove }, from an object or JSON text. */
export function cleanOverrides(value) {
  let v = value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  const add = cleanCodes(v?.add);
  const remove = cleanCodes(v?.remove).filter(c => !add.includes(c));
  return { add, remove };
}

/**
 * One ingredient: { contains, traces, source }. `source` is 'label' or
 * 'you' when its pantry item says, else 'name'.
 *   pantryById: Map of pantry id -> row (allergens, traces, allergens_source, name)
 */
export function itemAllergens(item, pantryById) {
  const p = item?.pantry_item_id != null && pantryById ? pantryById.get(item.pantry_item_id) : null;
  const fromNames = new Set([...nameCodes(item?.name), ...(p ? nameCodes(p.name) : [])]);
  const label = p ? knownCodes(p.allergens) : null;
  if (label) {
    // The label is the word on allergens; the names still tell a diet.
    const contains = new Set(label);
    for (const f of DIET_FLAGS) if (fromNames.has(f)) contains.add(f);
    return { contains: _ORDER.filter(c => contains.has(c)), traces: knownCodes(p.traces) || [], source: p.allergens_source === 'user' ? 'you' : 'label' };
  }
  return { contains: _ORDER.filter(c => fromNames.has(c)), traces: p ? (knownCodes(p.traces) || []) : [], source: 'name' };
}

/**
 * A recipe's allergens: { contains: [{ code, items, source }], traces: [{ code, items }] }
 * where `items` are the ingredient names responsible ([] for one added by
 * hand) and `source` is 'label', 'you' or 'name' (the strongest of them).
 */
export function recipeAllergens(recipe, pantryById, overrides = recipe?.allergen_overrides) {
  const fix = cleanOverrides(overrides);
  const contains = new Map(); // code -> { items: [], sources: Set }
  const traces = new Map();
  for (const g of _groups(recipe?.ingredients)) {
    for (const it of g?.items || []) {
      if (!it?.name) continue;
      const a = itemAllergens(it, pantryById);
      for (const c of a.contains) {
        if (!contains.has(c)) contains.set(c, { items: [], sources: new Set() });
        const e = contains.get(c);
        if (!e.items.includes(it.name)) e.items.push(it.name);
        e.sources.add(a.source);
      }
      for (const c of a.traces) {
        if (!traces.has(c)) traces.set(c, { items: [] });
        if (!traces.get(c).items.includes(it.name)) traces.get(c).items.push(it.name);
      }
    }
  }
  for (const c of fix.remove) { contains.delete(c); traces.delete(c); }
  for (const c of fix.add) {
    if (!contains.has(c)) contains.set(c, { items: [], sources: new Set() });
    contains.get(c).sources.add('you');
    traces.delete(c);
  }
  for (const c of contains.keys()) traces.delete(c);
  const best = s => (s.has('you') ? 'you' : s.has('label') ? 'label' : 'name');
  return {
    contains: _ORDER.filter(c => contains.has(c)).map(c => ({ code: c, items: contains.get(c).items, source: best(contains.get(c).sources) })),
    traces: _ORDER.filter(c => traces.has(c)).map(c => ({ code: c, items: traces.get(c).items })),
  };
}

/** Codes only, for a recipe card: { contains: [codes], traces: [codes] }. */
export function allergenSummary(recipe, pantryById) {
  const a = recipeAllergens(recipe, pantryById);
  return { contains: a.contains.map(x => x.code), traces: a.traces.map(x => x.code) };
}

// ── The household ───────────────────────────────────────────────────────
// A member: { id, name, allergies: [codes], diet: [diet ids],
// dislikes: [words], days: [0-6, Sunday 0] } where no days means every day.

/** Members as stored (a setting), cleaned. */
export function cleanHousehold(list) {
  let arr = list;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return arr.filter(m => m && String(m.name || '').trim()).map((m, i) => ({
    id: String(m.id || `m${i + 1}`),
    name: String(m.name).trim().slice(0, 60),
    allergies: cleanCodes(m.allergies).filter(c => ALLERGENS.includes(c)),
    diet: (Array.isArray(m.diet) ? m.diet : []).filter(d => d in DIETS),
    dislikes: (Array.isArray(m.dislikes) ? m.dislikes : []).map(d => String(d || '').trim()).filter(Boolean).slice(0, 30),
    days: [...new Set((Array.isArray(m.days) ? m.days : []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort(),
  }));
}

function _weekday(date) {
  const m = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay() : null;
}

/** Who's home on a date (YYYY-MM-DD); with no date, everyone. */
export function homeOn(members, date) {
  const d = date ? _weekday(date) : null;
  return (members || []).filter(m => d == null || !m.days?.length || m.days.includes(d));
}

/** What a member avoids: their allergies and their diets' codes. */
export function avoids(member) {
  const set = new Set(member?.allergies || []);
  for (const d of member?.diet || []) for (const c of DIETS[d] || []) set.add(c);
  return set;
}

/**
 * The household members a recipe is a problem for:
 * { contains: [{ code, who: [names] }], traces: [{ code, who }] }.
 * `summary` is recipeAllergens() or allergenSummary() output; with a
 * date, only those home that day count.
 */
export function conflicts(summary, members, { date } = {}) {
  const people = homeOn(members, date);
  const codesOf = list => (list || []).map(x => (typeof x === 'string' ? x : x.code));
  const find = codes => codes.map(code => ({ code, who: people.filter(m => avoids(m).has(code)).map(m => m.name) })).filter(x => x.who.length);
  return { contains: find(codesOf(summary?.contains)), traces: find(codesOf(summary?.traces)) };
}

/** Ingredients someone home that day doesn't like: [{ item, who: [names] }]. */
export function dislikesIn(recipe, members, { date } = {}) {
  const people = homeOn(members, date).filter(m => m.dislikes?.length);
  if (!people.length) return [];
  const out = [];
  for (const g of _groups(recipe?.ingredients)) {
    for (const it of g?.items || []) {
      const text = _fold(it?.name);
      const who = people.filter(m => m.dislikes.some(d => {
        const w = _fold(d).trim();
        return w && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:e?s)?\\b`).test(text);
      })).map(m => m.name);
      if (who.length && !out.some(o => o.item === it.name)) out.push({ item: it.name, who });
    }
  }
  return out;
}
