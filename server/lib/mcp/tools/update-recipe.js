/**
 * MCP tool: update_recipe (write)
 *
 * Change an existing recipe of the token owner's. Patch semantics: only
 * the fields sent change. ingredients, steps and tags replace their whole
 * list when sent; nutrition is merged key by key (../recipe-input.js), so
 * sending only `proteins` keeps calories, carbohydrates and the rest.
 *
 * Follows PUT /api/recipes/:id for a save that carries no _sync metadata
 * (an older page, an API client): the copy being replaced is kept as an
 * earlier version first (lib/recipe-versions.js, reason 'replaced'), so an
 * agent's edit can be restored from the recipe page like any other. Owner
 * only: an MCP token acts as its owner, so the admin and Kitchen Sous Chef
 * paths of the PUT route don't apply here.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';
import { saveRecipeVersion, sameContent } from '../../recipe-versions.js';
import { ingredientSchema, stepsSchema, nutritionSchema, toStoredIngredients, toStoredSteps, mergeNutrition } from '../recipe-input.js';

const minutes = () => z.number().int().min(0).max(10000).nullable().optional();

export function registerUpdateRecipe(server, { userId }) {
  server.registerTool(
    'update_recipe',
    {
      title: 'Update Recipe',
      description:
        'Change an existing recipe. Send only the fields to change. ingredients, steps ' +
        'and tags replace the whole list; nutrition (per serving) is merged, null removes ' +
        'a value. A time set to null is cleared. The previous copy is kept as an earlier ' +
        'version the user can restore. Use get_recipe first to read the current values.',
      inputSchema: {
        recipe_id:     z.number().int().positive(),
        name:          z.string().min(1).max(200).optional(),
        description:   z.string().max(2000).nullable().optional(),
        servings:      z.number().int().positive().max(1000).nullable().optional(),
        prep_minutes:  minutes(),
        cook_minutes:  minutes(),
        rest_minutes:  minutes(),
        total_minutes: minutes().describe('Only when it differs from prep + cook + rest; null goes back to the sum.'),
        ingredients:   z.array(ingredientSchema).min(1).optional(),
        steps:         stepsSchema.optional(),
        tags:          z.array(z.string().min(1).max(50)).max(20).optional(),
        source_url:    z.string().url().max(500).nullable().optional(),
        notes:         z.string().max(2000).nullable().optional(),
        nutrition:     nutritionSchema.optional(),
      },
    },
    async ({ recipe_id, ...changes }) => {
      const existing = db.prepare(
        `SELECT * FROM recipes WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
      ).get(recipe_id, userId);
      if (!existing) return toolError(`recipe_id ${recipe_id} not found in your recipes.`);

      const updates = {};
      if (changes.name !== undefined) {
        const name = changes.name.trim();
        if (!name) return toolError('name cannot be blank.');
        updates.name = name;
      }
      for (const f of ['description', 'servings', 'prep_minutes', 'cook_minutes', 'rest_minutes', 'total_minutes', 'source_url', 'notes']) {
        if (changes[f] !== undefined) updates[f] = changes[f];
      }
      if (changes.ingredients !== undefined) updates.ingredients = JSON.stringify(toStoredIngredients(changes.ingredients));
      if (changes.steps !== undefined)       updates.steps = JSON.stringify(toStoredSteps(changes.steps));
      if (changes.tags !== undefined)        updates.tags = JSON.stringify(changes.tags);
      if (changes.nutrition !== undefined)   updates.nutrition = mergeNutrition(existing.nutrition, changes.nutrition);

      const fields = Object.keys(updates);
      if (fields.length === 0) return toolError('Nothing to update: send at least one field besides recipe_id.');

      const updated = { ...existing, ...updates };
      if (sameContent(updated, existing)) {
        return toolResult({ ok: true, recipe_id, changed: [] });
      }

      db.transaction(() => {
        saveRecipeVersion(existing.id, existing.user_id, existing, {
          reason: 'replaced',
          editedBy: existing.last_edited_by ?? existing.user_id,
        });
        db.prepare(
          `UPDATE recipes SET ${fields.map(f => `${f} = ?`).join(', ')},
             last_edited_by = NULL, updated_at = datetime('now')
           WHERE id = ? AND user_id = ?`
        ).run(...fields.map(f => updates[f]), existing.id, userId);
      })();

      return toolResult({ ok: true, recipe_id, changed: fields });
    }
  );
}
