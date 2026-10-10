/**
 * server/lib/mcp/recipe-input.js
 *
 * Input shapes shared by the MCP tools that write a recipe (create_recipe,
 * update_recipe), so the two can't drift on how an ingredient, a step or a
 * nutrition value is accepted and stored.
 */
import { z } from 'zod';
import { deriveSodiumSalt } from '../nutrition-derive.js';
import { safeJson } from './_util.js';

export const ingredientSchema = z.object({
  name: z.string().min(1).max(200),
  qty:  z.union([z.string(), z.number()]).optional(),
  unit: z.string().max(20).optional(),
  note: z.string().max(200).optional(),
});

export const stepsSchema = z.array(z.string().min(1).max(2000)).min(1);

// Keys are the nutriment ids the app stores (src/lib/nutriments.js); the
// common ones are listed in the description so an agent doesn't guess
// "protein" for "proteins". null removes a value on update_recipe.
export const nutritionSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9-]*$/).max(40), z.number().min(0).max(100000).nullable())
  .describe(
    'Per-serving values keyed by nutriment id: calories (kcal), proteins, carbohydrates, ' +
    'fat, saturated-fat, fiber, sugars (g), sodium, cholesterol (mg), plus any other id the ' +
    "app's Nutrition Facts box uses. On update_recipe, keys you omit keep their value and " +
    'null removes one.'
  );

export function toStoredIngredients(ingredients) {
  return ingredients.map(it => ({
    name: it.name.trim(),
    qty:  it.qty != null ? String(it.qty) : '',
    unit: it.unit || '',
    note: it.note || '',
  }));
}

export function toStoredSteps(steps) {
  return steps.map(s => ({ title: '', text: s.trim(), refIds: [], imgUrl: '' }));
}

/**
 * The nutrition JSON to store: `incoming` merged over what the recipe has
 * (null removes a key), with sodium/salt derived the way the recipe routes
 * derive them on save.
 */
export function mergeNutrition(existingJson, incoming) {
  const merged = { ...safeJson(existingJson, {}) };
  const touched = Object.keys(incoming || {});
  const derived = merged._derived && typeof merged._derived === 'object' ? { ...merged._derived } : null;
  if (derived) {
    merged._derived = derived;
    // A value set here is no longer derived; and when sodium or salt
    // changes, the one derived from the other is dropped so
    // deriveSodiumSalt recomputes it instead of keeping a stale figure.
    const sourceChanged = touched.includes('sodium') || touched.includes('salt');
    for (const key of Object.keys(derived)) {
      if (touched.includes(key)) delete derived[key];
      else if (sourceChanged && (key === 'sodium' || key === 'salt')) { delete merged[key]; delete derived[key]; }
    }
  }
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value == null) delete merged[key];
    else merged[key] = value;
  }
  return JSON.stringify(deriveSodiumSalt(merged));
}
