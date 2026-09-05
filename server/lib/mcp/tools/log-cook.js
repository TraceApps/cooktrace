/**
 * MCP tool: log_cook (write)
 *
 * Log that the user cooked a recipe. Mirrors POST /api/recipes/:id/cooked
 * exactly (same ownership/visibility check, same aggregate recompute)
 * so an MCP-logged cook shows up identically to one logged through the
 * app's own "I cooked this" dialog — including in Kitchen-shared views.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, todayLocal, toolResult, toolError } from '../_util.js';
import { recomputeRecipeAggregates } from '../../../routes/cook-diary.js';

const MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snack']);

export function registerLogCook(server, { userId }) {
  server.registerTool(
    'log_cook',
    {
      title: 'Log Cook',
      description:
        'Log that the user cooked a recipe today (or on a given date). Requires ' +
        'recipe_id from search_recipes / recent_recipes. Bumps the recipe\'s cook_count ' +
        'and last_cooked_at the same way the app\'s own "I cooked this" dialog does.',
      inputSchema: {
        recipe_id: z.number().int().positive(),
        date:      z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        servings:  z.number().positive().max(1000).optional(),
        notes:     z.string().max(1000).optional(),
        meal_type: z.enum(['breakfast', 'lunch', 'dinner', 'snack']).optional(),
        rating:    z.number().int().min(0).max(5).optional(),
      },
    },
    async ({ recipe_id, date, servings, notes, meal_type, rating }) => {
      const recipe = db.prepare(
        `SELECT id, name, user_id, visibility FROM recipes WHERE id = ? AND deleted_at IS NULL`
      ).get(recipe_id);
      if (!recipe) return toolError(`recipe_id ${recipe_id} not found.`);
      if (recipe.user_id !== userId && recipe.visibility !== 'group') {
        return toolError(`recipe_id ${recipe_id} isn't yours and isn't shared with your Kitchen.`);
      }

      const day = date || todayLocal();
      if (!DATE_RE.test(day)) return toolError(`Invalid date '${day}'; expected YYYY-MM-DD.`);
      const mealType = meal_type && MEAL_TYPES.has(meal_type) ? meal_type : null;
      const cleanRating = Number.isInteger(rating) ? Math.max(0, Math.min(5, rating)) || null : null;

      const result = db.prepare(
        `INSERT INTO cook_diary (user_id, recipe_id, date, kind, servings, notes, meal_type, rating)
         VALUES (?, ?, ?, 'cooked', ?, ?, ?, ?)`
      ).run(userId, recipe_id, day, servings ?? null, notes || null, mealType, cleanRating);

      recomputeRecipeAggregates(recipe_id);
      const updated = db.prepare(`SELECT cook_count, last_cooked_at FROM recipes WHERE id = ?`).get(recipe_id);

      return toolResult({
        ok: true,
        logged: {
          entry_id: result.lastInsertRowid,
          recipe_id,
          recipe_name: recipe.name,
          date: day,
          servings: servings ?? null,
          meal_type: mealType,
          rating: cleanRating,
        },
        recipe_cook_count: updated?.cook_count ?? null,
        recipe_last_cooked_at: updated?.last_cooked_at ?? null,
      });
    }
  );
}
