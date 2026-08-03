/**
 * nutriments.js — canonical nutrition facts catalog (mirrors NutriTrace's
 * order so the two apps look identical to users).
 *
 * Order follows the US FDA Nutrition Facts label: macros → cholesterol →
 * sodium → carbs (with sub-rows) → protein → vitamins → minerals → other.
 *
 * `default: true` rows appear in the box automatically. Users can show /
 * hide nutriments via the `visibleNutriments` setting (string[] of ids).
 *
 * `subOf` indicates the indented sub-row position on the FDA label (e.g.
 * Saturated Fat is a sub-row of Total Fat). Render with extra indent.
 *
 * `bold` flips the row to the bold weight on the label (Total Fat,
 * Cholesterol, Sodium, Total Carbohydrate, Protein).
 *
 * `dv` is the standard FDA Daily Value (2000 kcal diet) used for the
 * % Daily Value column. Null = no %DV displayed.
 *
 * `fdaBlock` controls FDA-panel placement: 'macros' renders ABOVE the
 * thick rule (fat group, cholesterol, sodium, carb group, protein),
 * 'micros' renders BELOW it (vitamins + mineral DV section). This is
 * deliberately separate from `category` because sodium is a mineral
 * biochemically but lives in the macros block on the actual FDA label.
 * Rows without an fdaBlock value (kilojoules, salt) don't render in
 * the box — kilojoules is derived from calories at display time, salt
 * from sodium via the EU regulatory factor.
 */

export const NUTRIMENTS = [
  // Energy
  { id: 'calories',            label: 'Calories',            unit: 'kcal', category: 'energy',  default: true,  bold: true,  dv: null },
  { id: 'kilojoules',          label: 'Kilojoules',          unit: 'kJ',   category: 'energy',  default: false, bold: false, dv: null },

  // Total Fat + sub-rows
  { id: 'fat',                 label: 'Total Fat',           unit: 'g',    category: 'macro',   default: true,  bold: true,  dv: 78,   fdaBlock: 'macros' },
  { id: 'saturated-fat',       label: 'Saturated Fat',       unit: 'g',    category: 'macro',   default: true,  bold: false, dv: 20,   subOf: 'fat',           fdaBlock: 'macros' },
  { id: 'trans-fat',           label: 'Trans Fat',           unit: 'g',    category: 'macro',   default: false, bold: false, dv: null, subOf: 'fat', italic: true, fdaBlock: 'macros' },
  { id: 'polyunsaturated-fat', label: 'Polyunsaturated Fat', unit: 'g',    category: 'macro',   default: false, bold: false, dv: null, subOf: 'fat',           fdaBlock: 'macros' },
  { id: 'monounsaturated-fat', label: 'Monounsaturated Fat', unit: 'g',    category: 'macro',   default: false, bold: false, dv: null, subOf: 'fat',           fdaBlock: 'macros' },

  // Cholesterol & Sodium (FDA layout: ABOVE the thick rule, between
  // the fat group and the carb group). Sodium's biochemical category
  // is 'mineral' but the FDA panel groups it with macros.
  { id: 'cholesterol',         label: 'Cholesterol',         unit: 'mg',   category: 'other',   default: false, bold: true,  dv: 300,  fdaBlock: 'macros' },
  { id: 'sodium',              label: 'Sodium',              unit: 'mg',   category: 'mineral', default: true,  bold: true,  dv: 2300, fdaBlock: 'macros' },
  { id: 'salt',                label: 'Salt',                unit: 'g',    category: 'macro',   default: false, bold: false, dv: null },

  // Total Carbohydrate + sub-rows
  { id: 'carbohydrates',       label: 'Total Carbohydrate',  unit: 'g',    category: 'macro',   default: true,  bold: true,  dv: 275,  fdaBlock: 'macros' },
  { id: 'fiber',               label: 'Dietary Fiber',       unit: 'g',    category: 'macro',   default: true,  bold: false, dv: 28,   subOf: 'carbohydrates', fdaBlock: 'macros' },
  { id: 'sugars',              label: 'Total Sugars',        unit: 'g',    category: 'macro',   default: true,  bold: false, dv: null, subOf: 'carbohydrates', fdaBlock: 'macros' },
  { id: 'added-sugars',        label: 'Added Sugars',        unit: 'g',    category: 'macro',   default: true,  bold: false, dv: 50,   subOf: 'sugars',        fdaBlock: 'macros' },

  // Protein
  { id: 'proteins',            label: 'Protein',             unit: 'g',    category: 'macro',   default: true,  bold: true,  dv: 50,   fdaBlock: 'macros' },

  // Vitamins & minerals (Nutrition-Facts label order: D, Ca, Fe, K)
  { id: 'vitamin-d',           label: 'Vitamin D',           unit: 'mcg',   category: 'vitamin', default: false, bold: false, dv: 20,   fdaBlock: 'micros' },
  { id: 'calcium',             label: 'Calcium',             unit: 'mg',   category: 'mineral', default: false, bold: false, dv: 1300, fdaBlock: 'micros' },
  { id: 'iron',                label: 'Iron',                unit: 'mg',   category: 'mineral', default: false, bold: false, dv: 18,   fdaBlock: 'micros' },
  { id: 'potassium',           label: 'Potassium',           unit: 'mg',   category: 'mineral', default: false, bold: false, dv: 4700, fdaBlock: 'micros' },

  // Additional vitamins
  { id: 'vitamin-a',           label: 'Vitamin A',           unit: 'mcg',   category: 'vitamin', default: false, bold: false, dv: 900,  fdaBlock: 'micros' },
  { id: 'vitamin-c',           label: 'Vitamin C',           unit: 'mg',   category: 'vitamin', default: false, bold: false, dv: 90,   fdaBlock: 'micros' },
  { id: 'vitamin-e',           label: 'Vitamin E',           unit: 'mg',   category: 'vitamin', default: false, bold: false, dv: 15,   fdaBlock: 'micros' },
  { id: 'vitamin-k',           label: 'Vitamin K',           unit: 'mcg',   category: 'vitamin', default: false, bold: false, dv: 120,  fdaBlock: 'micros' },
  { id: 'b1',                  label: 'Vitamin B1 (Thiamin)',unit: 'mg',   category: 'vitamin', default: false, bold: false, dv: 1.2,  fdaBlock: 'micros' },
  { id: 'b2',                  label: 'Vitamin B2 (Riboflavin)', unit: 'mg', category: 'vitamin', default: false, bold: false, dv: 1.3, fdaBlock: 'micros' },
  { id: 'b3',                  label: 'Vitamin B3 (Niacin)', unit: 'mg',   category: 'vitamin', default: false, bold: false, dv: 16,   fdaBlock: 'micros' },
  { id: 'b6',                  label: 'Vitamin B6',          unit: 'mg',   category: 'vitamin', default: false, bold: false, dv: 1.7,  fdaBlock: 'micros' },
  { id: 'b9',                  label: 'Folate (B9)',         unit: 'mcg',   category: 'vitamin', default: false, bold: false, dv: 400,  fdaBlock: 'micros' },
  { id: 'b12',                 label: 'Vitamin B12',         unit: 'mcg',   category: 'vitamin', default: false, bold: false, dv: 2.4,  fdaBlock: 'micros' },

  // Minerals
  { id: 'magnesium',           label: 'Magnesium',           unit: 'mg',   category: 'mineral', default: false, bold: false, dv: 420,  fdaBlock: 'micros' },
  { id: 'zinc',                label: 'Zinc',                unit: 'mg',   category: 'mineral', default: false, bold: false, dv: 11,   fdaBlock: 'micros' },
  { id: 'phosphorus',          label: 'Phosphorus',          unit: 'mg',   category: 'mineral', default: false, bold: false, dv: 1250, fdaBlock: 'micros' },

  // Other (no FDA-standard position, render in the micros block when present)
  { id: 'caffeine',            label: 'Caffeine',            unit: 'mg',   category: 'other',   default: false, bold: false, dv: null, fdaBlock: 'micros' },
  { id: 'alcohol',             label: 'Alcohol',             unit: 'g',    category: 'other',   default: false, bold: false, dv: null, fdaBlock: 'micros' },
];

/** Just the IDs of default-visible nutriments — used as the visibleNutriments setting default. */
export const DEFAULT_VISIBLE_NUTRIMENT_IDS = NUTRIMENTS.filter(n => n.default).map(n => n.id);

/** Compute a value's % Daily Value, or null if no DV is defined / value is invalid. */
export function dvPercent(nut, value) {
  if (!nut || !nut.dv || value == null || value === '') return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  return Math.round((v / nut.dv) * 100);
}

// Sodium ↔ salt regulatory conversion (matches NutriTrace).
// EU labeling factor 2.5 → sodium_mg = salt_g × 400; salt_g = sodium_mg / 400.
export const SODIUM_MG_PER_SALT_G = 400;

function _isPresent(v) {
  return v != null && v !== '' && Number(v) > 0;
}

/**
 * Mutates `nutrition` to fill in whichever of (sodium, salt) is missing.
 * Tags the filled field via `nutrition._derived = { sodium: true }` (or
 * `salt: true`) so the UI can render a calculator icon next to it.
 *
 * If both are present, leave alone (the user has both authoritative).
 * If neither, also leave alone — nothing to derive from.
 *
 * Returns the same nutrition object (mutated in place) for chaining.
 */
export function deriveSodiumSalt(nutrition) {
  if (!nutrition || typeof nutrition !== 'object') return nutrition;
  const hasSodium = _isPresent(nutrition.sodium);
  const hasSalt   = _isPresent(nutrition.salt);
  if (hasSodium === hasSalt) return nutrition;

  if (!nutrition._derived || typeof nutrition._derived !== 'object') {
    nutrition._derived = {};
  } else {
    // Clear stale derived flags before recomputing.
    delete nutrition._derived.sodium;
    delete nutrition._derived.salt;
  }

  if (hasSodium && !hasSalt) {
    nutrition.salt = Math.round((Number(nutrition.sodium) / SODIUM_MG_PER_SALT_G) * 1000) / 1000;
    nutrition._derived.salt = true;
  } else if (hasSalt && !hasSodium) {
    nutrition.sodium = Math.round(Number(nutrition.salt) * SODIUM_MG_PER_SALT_G * 10) / 10;
    nutrition._derived.sodium = true;
  }
  return nutrition;
}

/** True if the given nutriment id was auto-derived on the saved object. */
export function isDerived(nutrition, id) {
  return !!(nutrition && nutrition._derived && nutrition._derived[id]);
}

// Energy unit conversion. Stored value is ALWAYS kcal; the user's
// `energyUnit` setting controls display only. 1 kcal = 4.184 kJ.
const KCAL_TO_KJ = 4.184;

/**
 * Convert a stored kcal value to whichever unit the user is viewing.
 * Returns the rounded number (no string formatting). Pass `null` through.
 */
export function displayEnergy(kcal, unit) {
  if (kcal == null || kcal === '') return null;
  const n = Number(kcal);
  if (!Number.isFinite(n)) return null;
  if (unit === 'kJ') return Math.round(n * KCAL_TO_KJ);
  return Math.round(n);
}

/** "Calories" or "Energy" — the row label used in the Nutrition Facts box. */
export function energyLabel(unit) {
  return unit === 'kJ' ? 'Energy' : 'Calories';
}

/** "kcal" or "kJ" — the unit suffix shown next to the value. */
export function energyUnitSuffix(unit) {
  return unit === 'kJ' ? 'kJ' : 'kcal';
}

