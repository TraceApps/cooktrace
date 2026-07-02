/**
 * recipe-nutrition.js — auto-calculate a recipe's nutrition by summing
 * each ingredient's pantry-row contribution.
 *
 * Per-ingredient math:
 *   ratio = (recipe_qty in serving_unit) / pantry.serving_size
 *   contribution[k] = ratio * pantry.nutrition[k]
 *
 * Limitations (intentional v1):
 *   - Conversions only happen WITHIN a unit family (volume↔volume,
 *     weight↔weight). Volume↔weight requires per-ingredient density,
 *     which we don't model yet. Cross-family is reported as a "skip".
 *   - "Count" units (pc, clove, slice, etc.) only line up when both
 *     recipe and pantry use the same count unit.
 */
import { parseQty } from './qty.js';

// ── Unit conversion to base units (ml for volume, g for weight) ──────────
// Returned as { factor, family }. factor = how many BASE units per 1
// of the input unit.
const VOLUME_TO_ML = {
  ml: 1, cl: 10, dl: 100, l: 1000,
  tsp: 4.929,        // US teaspoon
  tbsp: 14.787,      // US tablespoon
  'fl oz': 29.574,
  cup: 236.588,
  pt: 473.176,
  qt: 946.353,
  gal: 3785.411,
};
const WEIGHT_TO_G = {
  mg: 0.001, g: 1, kg: 1000,
  oz: 28.3495,
  lb: 453.592,
};

export function unitFamily(unit) {
  if (!unit) return null;
  const u = unit.toLowerCase().trim();
  if (VOLUME_TO_ML[u] != null) return 'volume';
  if (WEIGHT_TO_G[u] != null) return 'weight';
  return 'count'; // pc, clove, slice, etc., or anything we don't know
}

export function convertWithinFamily(qty, fromUnit, toUnit) {
  if (qty == null || !Number.isFinite(qty)) return null;
  const fromFam = unitFamily(fromUnit);
  const toFam = unitFamily(toUnit);
  if (!fromFam || !toFam || fromFam !== toFam) return null;

  const fu = (fromUnit || '').toLowerCase().trim();
  const tu = (toUnit || '').toLowerCase().trim();

  if (fromFam === 'volume') {
    return qty * VOLUME_TO_ML[fu] / VOLUME_TO_ML[tu];
  }
  if (fromFam === 'weight') {
    return qty * WEIGHT_TO_G[fu] / WEIGHT_TO_G[tu];
  }
  // count-family: only pass through if the unit is identical
  return fu === tu ? qty : null;
}

/**
 * Built-in density table — grams per US cup for the most common
 * cooking ingredients. Used by the "Auto-fill density" button on the
 * recipe nutrition recompute panel and by PantryEditor's "Look it up".
 *
 * Lookup is name-based (case-insensitive contains). Order matters:
 * more specific entries first so "all-purpose flour" beats "flour".
 *
 * Source: USDA + King Arthur Flour weight-volume tables, rounded to
 * the nearest 5g. Where two common variants disagree (cake vs bread
 * flour), we use the all-purpose middle value.
 */
// Densities are grams per US cup (236.588 ml). Source: USDA + King
// Arthur Flour + Cook's Illustrated weight-volume tables, rounded
// to the nearest 5 g. ORDER MATTERS — substring scan in declaration
// order, so the most-specific names must come first ("almond flour"
// before "almonds" before "flour"; "brown rice flour" before
// "brown rice" before "flour"). When in doubt, prefer a more-
// specific entry over a sweeping default.
const COMMON_DENSITIES = [
  // ── Flours (must precede plain "flour" + raw seed/grain entries)
  ['almond flour',          96],
  ['almond meal',           96],
  ['hazelnut flour',        95],
  ['cake flour',           100],
  ['bread flour',          127],
  ['00 flour',             130],
  ['"00" flour',           130],
  ['semolina flour',       163],
  ['semolina',             163],
  ['rice flour',           158],
  ['brown rice flour',     158],
  ['oat flour',             90],
  ['coconut flour',        112],
  ['chickpea flour',       100],
  ['gram flour',           100],
  ['besan',                100],
  ['rye flour',            102],
  ['spelt flour',          120],
  ['buckwheat flour',      120],
  ['self-rising flour',    120],
  ['self rising flour',    120],
  ['self-raising flour',   120],
  ['self raising flour',   120],
  ['whole wheat flour',    120],
  ['whole-wheat flour',    120],
  ['ww flour',             120],
  ['all-purpose flour',    120],
  ['all purpose flour',    120],
  ['ap flour',             120],
  ['masa harina',          122],
  ['masa',                 122],
  ['corn flour',            93],   // UK "corn flour" = cornstarch (handled separately below)
  ['flour',                120],

  // ── Sugars
  ['confectioners sugar',  113],
  ['confectioner sugar',   113],
  ['powdered sugar',       113],
  ['icing sugar',          113],
  ['brown sugar',          213],
  ['light brown sugar',    213],
  ['dark brown sugar',     213],
  ['muscovado sugar',      225],
  ['muscovado',            225],
  ['demerara sugar',       205],
  ['demerara',             205],
  ['turbinado sugar',      205],
  ['turbinado',            205],
  ['raw sugar',            205],
  ['coconut sugar',        160],
  ['palm sugar',           185],
  ['date sugar',           150],
  ['granulated sugar',     200],
  ['caster sugar',         200],
  ['superfine sugar',      200],
  ['white sugar',          200],
  ['sugar',                200],

  // ── Fats / oils
  ['coconut oil',          218],
  ['sesame oil',           218],
  ['avocado oil',          218],
  ['olive oil',            218],
  ['vegetable oil',        218],
  ['canola oil',           218],
  ['sunflower oil',        218],
  ['peanut oil',           218],
  ['oil',                  218],
  ['butter',               227],
  ['margarine',            227],
  ['ghee',                 200],
  ['lard',                 205],
  ['shortening',           205],
  ['vegetable shortening', 205],

  // ── Cheeses (grated / shredded / soft)
  ['parmesan',             100],   // grated
  ['parmigiano',           100],
  ['pecorino',             100],
  ['shredded mozzarella',  113],
  ['mozzarella',           113],
  ['shredded cheddar',     113],
  ['cheddar',              113],
  ['shredded gruyere',     113],
  ['gruyere',              113],
  ['shredded swiss',       113],
  ['monterey jack',        113],
  ['feta',                 150],   // crumbled
  ['ricotta',              246],
  ['cottage cheese',       226],
  ['cream cheese',         232],
  ['mascarpone',           240],
  ['queso fresco',         110],
  ['blue cheese',          135],

  // ── Dairy + dairy alternatives
  ['heavy cream',          240],
  ['whipping cream',       240],
  ['half and half',        240],
  ['half-and-half',        240],
  ['buttermilk',           245],
  ['evaporated milk',      252],
  ['condensed milk',       306],   // sweetened condensed
  ['coconut milk',         240],
  ['coconut cream',        240],
  ['almond milk',          240],
  ['oat milk',             240],
  ['soy milk',             240],
  ['cashew milk',          240],
  ['rice milk',            240],
  ['skim milk',            245],
  ['whole milk',           240],
  ['milk',                 240],
  ['greek yogurt',         245],
  ['yogurt',               245],
  ['sour cream',           230],
  ['creme fraiche',        232],
  ['crème fraîche',        232],

  // ── Sweeteners (liquid + paste)
  ['honey',                340],
  ['maple syrup',          312],
  ['molasses',             337],
  ['corn syrup',           328],
  ['agave',                331],
  ['agave nectar',         331],
  ['agave syrup',          331],
  ['golden syrup',         335],
  ['date syrup',           330],
  ['rice syrup',           320],
  ['barley malt syrup',    320],

  // ── Other liquids
  ['water',                240],
  ['stock',                240],
  ['broth',                240],
  ['coffee',               240],
  ['brewed coffee',        240],
  ['coconut water',        240],
  ['apple cider vinegar',  240],
  ['cider vinegar',        240],
  ['balsamic vinegar',     240],
  ['rice vinegar',         240],
  ['white wine vinegar',   240],
  ['red wine vinegar',     240],
  ['malt vinegar',         240],
  ['vinegar',              240],
  ['soy sauce',            252],
  ['tamari',               252],
  ['fish sauce',           250],
  ['oyster sauce',         286],
  ['hoisin sauce',         286],
  ['hoisin',               286],
  ['worcestershire sauce', 250],
  ['worcestershire',       250],
  ['sriracha',             280],
  ['hot sauce',            245],
  ['mirin',                240],
  ['sake',                 235],
  ['sherry',               235],
  ['lemon juice',          240],
  ['lime juice',           240],
  ['orange juice',         240],
  ['apple juice',          240],
  ['grape juice',          255],
  ['white wine',           235],
  ['red wine',             235],
  ['wine',                 235],

  // ── Tomato products
  ['tomato paste',         262],
  ['tomato sauce',         245],
  ['marinara sauce',       245],
  ['marinara',             245],
  ['pasta sauce',          245],
  ['pizza sauce',          245],
  ['crushed tomatoes',     240],
  ['diced tomatoes',       240],
  ['canned tomatoes',      240],
  ['tomato passata',       245],
  ['passata',              245],
  ['tomato puree',         250],
  ['ketchup',              245],
  ['catsup',               245],

  // ── Other condiments / pastes
  ['mustard',              250],
  ['dijon mustard',        250],
  ['mayonnaise',           224],
  ['mayo',                 224],
  ['miso',                 268],
  ['miso paste',           268],
  ['pesto',                240],
  ['curry paste',          250],
  ['harissa',              260],
  ['salsa',                240],
  ['guacamole',            230],
  ['hummus',               246],
  ['nutella',              290],
  ['chocolate spread',     290],
  ['jam',                  320],
  ['jelly',                300],
  ['preserves',            320],
  ['marmalade',            320],
  ['applesauce',           244],
  ['apple sauce',          244],
  ['pumpkin puree',        245],
  ['pumpkin pie filling',  270],

  // ── Grains / starches
  ['rolled oats',           90],
  ['steel-cut oats',       170],
  ['steel cut oats',       170],
  ['oats',                  90],
  ['quinoa',               170],
  ['couscous',             175],
  ['bulgur',               140],
  ['farro',                170],
  ['barley',               200],
  ['millet',               200],
  ['amaranth',             195],
  ['buckwheat',            170],
  ['wheat berries',        180],
  ['arborio rice',         200],
  ['basmati rice',         180],
  ['jasmine rice',         190],
  ['white rice',           195],
  ['brown rice',           195],
  ['wild rice',            165],
  ['rice',                 195],
  ['cornmeal',             140],
  ['polenta',              140],
  ['cornstarch',           120],
  ['corn starch',          120],
  ['arrowroot',            128],
  ['arrowroot powder',     128],
  ['arrowroot starch',     128],
  ['tapioca starch',       125],
  ['tapioca flour',        125],
  ['tapioca',              152],   // pearls
  ['potato starch',        160],
  ['breadcrumbs',          108],
  ['bread crumbs',         108],
  ['panko',                 50],

  // ── Nuts + seeds (whole/chopped where ambiguous, USDA chopped)
  ['pine nuts',            135],
  ['pistachios',           123],
  ['hazelnuts',            135],
  ['hazelnut',             135],
  ['macadamia nuts',       134],
  ['macadamias',           134],
  ['brazil nuts',          133],
  ['almonds',              143],
  ['walnuts',              117],
  ['pecans',               109],
  ['cashews',              130],
  ['peanuts',              146],
  ['pumpkin seeds',        129],
  ['pepitas',              129],
  ['sunflower seeds',      140],
  ['sesame seeds',         144],
  ['hemp seeds',           160],
  ['hemp hearts',          160],
  ['poppy seeds',          145],
  ['chia seeds',           170],
  ['chia',                 170],
  ['flax seeds',           150],
  ['flaxseed',             150],
  ['ground flax',          112],
  ['flax meal',            112],
  ['peanut butter',        258],
  ['almond butter',        258],
  ['cashew butter',        258],
  ['sunflower butter',     258],
  ['tahini',               240],

  // ── Chocolate / cocoa
  ['cocoa powder',          85],
  ['cacao powder',          85],
  ['cacao nibs',           120],
  ['white chocolate chips',170],
  ['dark chocolate chips', 170],
  ['milk chocolate chips', 170],
  ['chocolate chips',      170],
  ['chopped chocolate',    175],
  ['chocolate',            175],

  // ── Coconut
  ['shredded coconut',      80],
  ['desiccated coconut',    90],
  ['coconut flakes',        60],
  ['coconut',               80],

  // ── Dried fruit
  ['raisins',              145],
  ['sultanas',             145],
  ['currants',             145],
  ['dried cranberries',    120],
  ['dried cherries',       150],
  ['dried apricots',       130],
  ['dried figs',           150],
  ['dates',                178],
  ['chopped dates',        178],
  ['prunes',               170],
  ['dried apples',          85],
  ['dried mango',          135],
  ['dried pineapple',      125],

  // ── Beans / lentils (cooked, drained)
  ['black beans',          172],
  ['kidney beans',         177],
  ['pinto beans',          171],
  ['navy beans',           182],
  ['white beans',          182],
  ['cannellini beans',     182],
  ['great northern beans', 175],
  ['chickpeas',            164],
  ['garbanzo beans',       164],
  ['lentils',              198],
  ['split peas',           196],
  ['edamame',              155],
  ['black-eyed peas',      170],

  // ── Vegetables (raw, chopped unless noted)
  ['chopped onion',        160],
  ['onion',                160],
  ['shallot',              160],
  ['scallion',              50],   // sliced
  ['green onion',           50],
  ['leek',                  90],   // sliced
  ['carrot',               128],
  ['celery',               101],
  ['bell pepper',          150],
  ['jalapeno',              90],
  ['tomato',               180],
  ['cherry tomato',        149],
  ['cucumber',             119],
  ['mushrooms',             70],   // sliced
  ['mushroom',              70],
  ['zucchini',             124],
  ['squash',               140],
  ['eggplant',              80],
  ['cabbage',               89],
  ['broccoli',              90],
  ['cauliflower',          100],
  ['corn',                 154],   // kernels
  ['peas',                 145],
  ['green beans',          110],
  ['spinach',               30],   // raw, packed
  ['cooked spinach',       180],
  ['kale',                  67],   // chopped raw
  ['arugula',               20],
  ['lettuce',               55],
  ['mixed greens',          20],
  ['parsley',               60],   // chopped
  ['cilantro',              16],   // chopped
  ['basil',                 24],   // chopped
  ['mint',                  32],   // chopped
  ['rosemary',              50],   // chopped
  ['thyme',                 50],   // chopped
  ['dill',                  10],   // chopped
  ['chives',                14],   // chopped
  ['minced garlic',        136],
  ['garlic',               136],
  ['ginger',                96],   // grated/minced
  ['mashed potato',        210],
  ['mashed banana',        225],
  ['avocado',              150],

  // ── Salts + leaveners + spices
  ['kosher salt',          240],   // varies wildly by brand
  ['table salt',           292],
  ['sea salt',             280],
  ['flaky salt',           120],
  ['salt',                 273],
  ['baking soda',          230],
  ['baking powder',        220],
  ['active dry yeast',     150],
  ['instant yeast',        150],
  ['yeast',                150],
  ['cinnamon',             132],
  ['nutmeg',               112],
  ['ginger powder',        100],
  ['ground ginger',        100],
  ['cloves',               140],
  ['allspice',             105],
  ['cardamom',             100],
  ['paprika',              108],
  ['smoked paprika',       108],
  ['cumin',                100],
  ['ground cumin',         100],
  ['coriander',             80],
  ['ground coriander',      80],
  ['turmeric',             132],
  ['ground turmeric',      132],
  ['black pepper',         140],
  ['ground black pepper',  140],
  ['white pepper',         132],
  ['cayenne',              108],
  ['chili powder',         128],
  ['chile powder',         128],
  ['curry powder',         103],
  ['garlic powder',        140],
  ['onion powder',         130],
  ['oregano',               60],   // dried
  ['dried oregano',         60],
  ['italian seasoning',     60],
  ['herbes de provence',    60],
  ['bay leaf',              25],
  ['mustard seed',         208],
  ['mustard powder',       100],
  ['vanilla extract',      208],
  ['vanilla',              208],
  ['almond extract',       205],

  // ── Misc helpful
  ['popcorn kernels',      200],
  ['rolled barley',         95],
  ['oat bran',              94],
  ['wheat bran',            58],
  ['wheat germ',           113],
  ['nutritional yeast',     60],
  ['gelatin',              200],
  ['agar',                  90],
];

/**
 * Look up a sane g_per_cup for a given ingredient name. Returns null
 * if no match. Uses a case-insensitive substring scan in declaration
 * order so the most specific names match first.
 */
export function lookupCommonDensity(name) {
  if (!name || typeof name !== 'string') return null;
  const n = name.toLowerCase().trim();
  for (const [key, dens] of COMMON_DENSITIES) {
    if (n.includes(key)) return dens;
  }
  return null;
}

/**
 * Convert qty + unit, allowing cross-family bridging via per-pantry-row
 * density (`g_per_cup`). Returns null when conversion is impossible.
 *
 *   - Same family: defers to convertWithinFamily.
 *   - volume → weight: ml = qty * VOLUME_TO_ML[fromUnit];
 *                       g  = ml * (g_per_cup / 236.588);
 *                       result = g / WEIGHT_TO_G[toUnit].
 *   - weight → volume: inverse.
 *   - count family: still no-op unless units match (count→volume/weight
 *                   would need per-piece weight, not modelled).
 */
export function convertQty(qty, fromUnit, toUnit, gPerCup) {
  if (qty == null || !Number.isFinite(qty)) return null;
  const same = convertWithinFamily(qty, fromUnit, toUnit);
  if (same != null) return same;
  const fromFam = unitFamily(fromUnit);
  const toFam   = unitFamily(toUnit);
  if (!gPerCup || !Number.isFinite(gPerCup) || gPerCup <= 0) return null;
  if (fromFam === 'volume' && toFam === 'weight') {
    const fu = (fromUnit || '').toLowerCase().trim();
    const tu = (toUnit || '').toLowerCase().trim();
    const ml = qty * VOLUME_TO_ML[fu];
    const grams = ml * (gPerCup / VOLUME_TO_ML.cup);
    return grams / WEIGHT_TO_G[tu];
  }
  if (fromFam === 'weight' && toFam === 'volume') {
    const fu = (fromUnit || '').toLowerCase().trim();
    const tu = (toUnit || '').toLowerCase().trim();
    const grams = qty * WEIGHT_TO_G[fu];
    const ml = grams / (gPerCup / VOLUME_TO_ML.cup);
    return ml / VOLUME_TO_ML[tu];
  }
  return null;
}

/**
 * Resolve which pantry row supplies nutrition for a recipe ingredient.
 * Variant feature (Issue #4): when a recipe ingredient links to a
 * generic pantry item AND that generic has nutrition_source_variant_id
 * set, pull the source variant's row instead. Otherwise just return
 * the originally-linked row (which may itself be a flat item, a
 * generic with its own manual nutrition, or a specific variant the
 * recipe linked directly).
 */
function _resolveNutritionSource(pantryById, pantryItemId) {
  if (!pantryById || pantryItemId == null) return null;
  const own = pantryById.get(pantryItemId);
  if (!own) return null;
  const sourceId = own.nutrition_source_variant_id;
  if (sourceId == null) return own;
  const sourceRow = pantryById.get(sourceId);
  // Defensive: source must still exist and still be a child of this row.
  if (!sourceRow || sourceRow.generic_parent_id !== own.id) return own;
  return sourceRow;
}

/**
 * Compute the nutrition totals for a recipe given its grouped
 * ingredients + a Map<pantry_item_id, pantry_row> for lookup.
 *
 * Returns { nutrition, used, skipped, total }:
 *   nutrition — { calories, fat, ..., kilojoules } summed across all
 *               contributing ingredients (kilojoules omitted; UI
 *               derives at display time from kcal).
 *   used      — count of ingredients whose pantry row had nutrition
 *               and matched the unit family.
 *   skipped   — array of { name, reason } for diagnostic UI.
 *   total     — total ingredient count (skipped + used + missing).
 */
export function computeRecipeNutrition(ingredients, pantryById) {
  const totals = {};
  const skipped = [];
  let used = 0;
  let total = 0;

  const groups = Array.isArray(ingredients) ? ingredients : [];
  for (const g of groups) {
    for (const it of (g.items || [])) {
      total++;
      if (!it || !it.name) continue;
      const pantry = _resolveNutritionSource(pantryById, it.pantry_item_id);
      if (!pantry || !pantry.nutrition || !pantry.serving_size || !pantry.serving_unit) {
        skipped.push({ name: it.name, reason: 'no nutrition data' });
        continue;
      }
      const qtyNum = parseQty(it.qty);
      if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
        // "to taste", missing qty, etc — skip silently
        skipped.push({ name: it.name, reason: 'no quantity' });
        continue;
      }
      // Try same-family first, then density-bridged cross-family if
      // the pantry row has a g_per_cup. Falling back is silent — the
      // caller doesn't need to know which path was used, only whether
      // the ingredient ended up contributing.
      const converted = convertQty(qtyNum, it.unit, pantry.serving_unit, pantry.g_per_cup);
      if (converted == null) {
        const reason = (it.unit && pantry.serving_unit && unitFamily(it.unit) !== unitFamily(pantry.serving_unit) && !pantry.g_per_cup)
          ? `unit mismatch — set density on "${it.name}" to enable cross-family conversion`
          : `unit mismatch (${it.unit || '—'} vs ${pantry.serving_unit})`;
        skipped.push({ name: it.name, reason });
        continue;
      }
      const ratio = converted / Number(pantry.serving_size);
      if (!Number.isFinite(ratio) || ratio <= 0) {
        skipped.push({ name: it.name, reason: 'serving size invalid' });
        continue;
      }
      for (const [k, v] of Object.entries(pantry.nutrition)) {
        if (!Number.isFinite(v)) continue;
        totals[k] = (totals[k] || 0) + v * ratio;
      }
      used++;
    }
  }

  // Round to 1 decimal so the FDA box stays readable.
  for (const k of Object.keys(totals)) {
    totals[k] = Math.round(totals[k] * 10) / 10;
  }

  return { nutrition: totals, used, skipped, total };
}

/**
 * Total grams of finished recipe, divided by servings. Used to render
 * "Serving Size  ~85g" on the FDA box only when every ingredient can be
 * converted to a mass. One un-massable ingredient flips `complete` to
 * false and the caller falls back to "1 of N" / "Per serving".
 *
 * Each ingredient resolves via:
 *   - mass unit (g, kg, oz, lb): direct convert to grams
 *   - volume unit (cup, tbsp, ml, ...): needs `g_per_cup` on the pantry
 *     row, then convertQty bridges via density
 *   - count unit (pc, slice, clove, ...): needs the pantry row's serving
 *     to be expressed in a mass unit (e.g. "1 piece = 50g"), so qty *
 *     serving_size in grams. If the pantry serving is in a volume unit
 *     AND g_per_cup is set, we bridge to grams that way too.
 *
 * `to taste` / blank-qty entries don't fail the check — they just
 * contribute zero mass. The tilde in the displayed value covers any
 * minor inaccuracy.
 */
export function computeRecipeMass(recipe, pantryById) {
  const groups = Array.isArray(recipe?.ingredients) ? recipe.ingredients : [];
  let totalG = 0;
  let complete = true;
  let anyMassUsed = false;

  for (const g of groups) {
    for (const it of (g.items || [])) {
      if (!it || !it.name) continue;
      const qty = parseQty(it.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        // "to taste" — neither contributes nor blocks.
        continue;
      }
      const pantry = _resolveNutritionSource(pantryById, it.pantry_item_id);
      const fam = unitFamily(it.unit);

      if (fam === 'weight') {
        const u = (it.unit || '').toLowerCase().trim();
        const grams = qty * WEIGHT_TO_G[u];
        if (!Number.isFinite(grams)) { complete = false; continue; }
        totalG += grams; anyMassUsed = true;
      } else if (fam === 'volume') {
        if (!pantry?.g_per_cup) { complete = false; continue; }
        const grams = convertQty(qty, it.unit, 'g', pantry.g_per_cup);
        if (grams == null) { complete = false; continue; }
        totalG += grams; anyMassUsed = true;
      } else {
        // count unit. Need a per-piece mass.
        if (!pantry?.serving_size || !pantry?.serving_unit) { complete = false; continue; }
        const psSize = Number(pantry.serving_size);
        const psUnit = (pantry.serving_unit || '').toLowerCase().trim();
        if (!Number.isFinite(psSize) || psSize <= 0) { complete = false; continue; }
        let perItemG = null;
        if (WEIGHT_TO_G[psUnit] != null) {
          perItemG = psSize * WEIGHT_TO_G[psUnit];
        } else if (VOLUME_TO_ML[psUnit] != null && pantry.g_per_cup) {
          const ml = psSize * VOLUME_TO_ML[psUnit];
          perItemG = ml * (pantry.g_per_cup / VOLUME_TO_ML.cup);
        }
        if (perItemG == null || !Number.isFinite(perItemG)) { complete = false; continue; }
        totalG += qty * perItemG; anyMassUsed = true;
      }
    }
  }

  if (!anyMassUsed) return { perServingG: null, complete: false };

  const servings = Number(recipe?.servings) || 1;
  const perServingG = Math.round(totalG / servings);
  return {
    perServingG: perServingG > 0 ? perServingG : null,
    complete,
  };
}
