/**
 * MCP tool: delete_recipe (destructive) (#89)
 *
 * Delete one of the token owner's own recipes the way the app does
 * (DELETE /api/recipes/:id: a deleted_at stamp, which phones pick up on
 * their next sync). Logged cooks of it stay in the diary as history. A
 * recipe still planned for today or later is refused, with those plans
 * listed, so an agent never leaves a week holding a recipe that's gone:
 * it moves or removes them first (update_plan, delete_cook_diary_entry).
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';
import { localToday, shiftDay } from '../../calendar-day.js';

export function deleteRecipeCore(userId, recipeId) {
  const recipe = db.prepare(
    `SELECT id, name FROM recipes WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).get(recipeId, userId);
  if (!recipe) throw new Error(`recipe_id ${recipeId} not found in your own recipes.`);

  // Today or later; an "any day" plan is dated in its week, so one up to six
  // days back can still be this week's.
  const today = localToday();
  const plans = db.prepare(
    `SELECT id AS entry_id, date, any_day, meal_type FROM cook_diary
      WHERE user_id = ? AND recipe_id = ? AND kind = 'planned' AND deleted_at IS NULL
        AND (date >= ? OR (any_day = 1 AND date >= ?))
      ORDER BY date, id`
  ).all(userId, recipeId, today, shiftDay(today, -6));
  if (plans.length) {
    const err = new Error(
      `${recipe.name} is still planned (${plans.map(p => `entry_id ${p.entry_id} on ${p.date}${p.any_day ? ' (any day that week)' : ''}`).join(', ')}). ` +
      'Remove those with delete_cook_diary_entry or plan something else with update_plan first, then delete the recipe.'
    );
    throw err;
  }

  db.prepare(
    `UPDATE recipes SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(recipeId);
  const cooks = db.prepare(
    `SELECT COUNT(*) AS n FROM cook_diary WHERE user_id = ? AND recipe_id = ? AND kind = 'cooked' AND deleted_at IS NULL`
  ).get(userId, recipeId).n;
  return { ok: true, deleted: { recipe_id: recipeId, name: recipe.name }, logged_cooks_kept: cooks };
}

export function registerDeleteRecipe(server, { userId }) {
  server.registerTool(
    'delete_recipe',
    {
      title: 'Delete Recipe',
      description:
        'Delete one of your own recipes, as the app\'s Delete does. Requires confirm=true. ' +
        'Logged cooks of it stay in the diary. Refused while the recipe is planned for today ' +
        'or later: the error lists those plans; remove or change them first.',
      inputSchema: {
        recipe_id: z.number().int().positive(),
        confirm:   z.boolean(),
      },
    },
    async ({ recipe_id, confirm }) => {
      if (confirm !== true) {
        return toolError(
          'delete_recipe requires confirm=true. This safeguards against accidental ' +
          "destructive tool calls. Set the confirm argument to true and re-invoke if you're sure."
        );
      }
      try { return toolResult(deleteRecipeCore(userId, recipe_id)); } catch (e) { return toolError(e.message); }
    }
  );
}
