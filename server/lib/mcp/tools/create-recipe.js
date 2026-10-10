/**
 * MCP tool: create_recipe (destructive)
 *
 * Insert a new recipe. Semi-destructive because the row persists
 * across sessions and shows up in Recipes / search / Kitchen shares;
 * an agent that fabricates recipes can pollute the library in a way a
 * user has to hand-clean.
 *
 * Ingredients accept the simple flat shape ([{name, qty, unit, note}]);
 * normaliseIngredientGroups (recipe-hydrate.js) already wraps a flat
 * array into a single unnamed group on read, matching how the app
 * treats legacy-shape data, so callers don't need to know about
 * ingredient groups at all.
 *
 * Runs the same Kitchen auto-share hook POST /api/recipes does
 * (autoShareNewRecipe) so an MCP-created recipe fans out to Kitchen
 * members identically to one created in the app — the exact class of
 * bug that shipped for the native-Android write path before it was
 * fixed (see server/lib/auto-share.js).
 *
 * Ingredient, step and nutrition shapes come from ../recipe-input.js,
 * shared with update_recipe.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';
import { autoShareNewRecipe } from '../../auto-share.js';
import { ingredientSchema, stepsSchema, nutritionSchema, toStoredIngredients, toStoredSteps, mergeNutrition } from '../recipe-input.js';

export function registerCreateRecipe(server, { userId }) {
  server.registerTool(
    'create_recipe',
    {
      title: 'Create Recipe',
      description:
        'Add a new recipe. Requires confirm=true. Ingredients are a flat list of ' +
        '{name, qty, unit, note} objects (no need to group them). Steps are a plain ' +
        'list of instruction strings, one per step. nutrition is per serving.',
      inputSchema: {
        confirm:      z.boolean(),
        name:         z.string().min(1).max(200),
        description:  z.string().max(2000).optional(),
        servings:     z.number().int().positive().max(1000).optional(),
        prep_minutes: z.number().int().min(0).max(10000).optional(),
        cook_minutes: z.number().int().min(0).max(10000).optional(),
        rest_minutes: z.number().int().min(0).max(10000).optional(),
        total_minutes: z.number().int().min(0).max(10000).optional()
          .describe('Only when it differs from prep + cook + rest, e.g. when steps overlap.'),
        ingredients:  z.array(ingredientSchema).min(1),
        steps:        stepsSchema,
        tags:         z.array(z.string().min(1).max(50)).max(20).optional(),
        source_url:   z.string().url().max(500).optional(),
        notes:        z.string().max(2000).optional(),
        nutrition:    nutritionSchema.optional(),
      },
    },
    async ({ confirm, name, description, servings, prep_minutes, cook_minutes, rest_minutes, total_minutes, ingredients, steps, tags, source_url, notes, nutrition }) => {
      if (confirm !== true) {
        return toolError(
          'create_recipe requires confirm=true. This safeguards against accidental ' +
          "library pollution. Set the confirm argument to true and re-invoke if you're sure."
        );
      }
      const cleanName = name.trim();
      if (!cleanName) return toolError('name is required and cannot be blank.');

      const storedIngredients = toStoredIngredients(ingredients);
      const storedSteps = toStoredSteps(steps);

      const result = db.prepare(
        `INSERT INTO recipes
           (user_id, name, description, servings, prep_minutes, cook_minutes,
            rest_minutes, total_minutes, ingredients, steps, tags, source_url, notes,
            nutrition, visibility)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private')`
      ).run(
        userId,
        cleanName,
        description || null,
        servings ?? null,
        prep_minutes ?? null,
        cook_minutes ?? null,
        rest_minutes ?? null,
        total_minutes ?? null,
        JSON.stringify(storedIngredients),
        JSON.stringify(storedSteps),
        JSON.stringify(tags || []),
        source_url || null,
        notes || null,
        nutrition ? mergeNutrition(null, nutrition) : '{}',
      );

      const recipeId = result.lastInsertRowid;
      try { autoShareNewRecipe(userId, recipeId); } catch { /* non-fatal — recipe is already saved */ }

      return toolResult({
        ok: true,
        created: {
          id: recipeId,
          name: cleanName,
          servings: servings ?? null,
          ingredient_count: storedIngredients.length,
          step_count: storedSteps.length,
        },
      });
    }
  );
}
