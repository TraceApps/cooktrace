/**
 * The right-hand column of the Nutrition Facts label, matching NutriTrace
 * (TraceApps/nutritrace#297).
 *
 * 'dv'     % Daily Value, the FDA label as it has always read (default).
 * 'per100' The amount in 100 g, or 100 ml for an item measured by volume,
 *          so items with different serving sizes can be compared.
 *
 * One column at a time. The setting is the synced user pref
 * 'nutritionFactsColumn' (stores/settings.js), the same key as NutriTrace.
 */
import { unitFamily, convertWithinFamily } from './quantity.js';

export const FACTS_COLUMN_DEFAULT = 'dv';
export const FACTS_COLUMNS = ['dv', 'per100'];

export function factsColumn(v) {
  return FACTS_COLUMNS.includes(v) ? v : FACTS_COLUMN_DEFAULT;
}

/**
 * A per-serving value scaled to 100 g / 100 ml. `base` is the serving as
 * { amount, basis } from servingInBase below; null when the
 * serving can't be weighed, and then so is the answer.
 */
export function per100(value, base) {
  if (value == null || value === '' || !base) return null;
  const v = Number(value);
  const a = Number(base.amount);
  if (!Number.isFinite(v) || !Number.isFinite(a) || a <= 0) return null;
  return v * 100 / a;
}

/**
 * A serving as grams or milliliters, through quantity.js's unit table.
 * Returns { amount, basis } with basis 'g' or 'ml', or null when the
 * serving can't be weighed: a count unit (1 piece, 1 clove), an unknown
 * unit, or a zero or missing amount. A weight reads per 100 g and a volume
 * per 100 ml, so nothing is converted across the two and no density is
 * guessed.
 */
export function servingInBase(portion, unit) {
  const p = Number(portion);
  if (!Number.isFinite(p) || p <= 0) return null;
  const fam = unitFamily(unit);
  if (fam === 'weight') return { amount: convertWithinFamily(p, unit, 'g'), basis: 'g' };
  if (fam === 'volume') return { amount: convertWithinFamily(p, unit, 'ml'), basis: 'ml' };
  return null;
}
