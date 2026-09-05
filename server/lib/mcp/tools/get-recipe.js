/**
 * MCP tool: get_recipe
 *
 * Full detail of one recipe: ingredients (grouped), steps, nutrition,
 * and metadata. Reuses hydrateRecipe from recipe-hydrate.js so this
 * tool's output can never drift from what GET /api/recipes/:id and the
 * Cookbook view already resolve (category, normalised ingredient
 * groups, parsed JSON columns).
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';
import { hydrateRecipe, buildCategoryMap } from '../../recipe-hydrate.js';

export function registerGetRecipe(server, { userId }) {
  server.registerTool(
    'get_recipe',
    {
      title: 'Get Recipe',
      description:
        'Full detail of one of the user\'s own recipes: ingredients (grouped), steps, ' +
        'servings, timings, tags, tools, and nutrition. Use search_recipes or ' +
        'recent_recipes first to find a recipe_id.',
      inputSchema: {
        recipe_id: z.number().int().positive(),
      },
    },
    async ({ recipe_id }) => {
      const row = db.prepare(
        `SELECT * FROM recipes WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
      ).get(recipe_id, userId);
      if (!row) return toolError(`recipe_id ${recipe_id} not found in your recipes.`);
      const catMap = buildCategoryMap(userId);
      const hydrated = hydrateRecipe(row, catMap);
      return toolResult({
        id: hydrated.id,
        name: hydrated.name,
        description: hydrated.description,
        servings: hydrated.servings,
        yield_text: hydrated.yield_text,
        prep_minutes: hydrated.prep_minutes,
        cook_minutes: hydrated.cook_minutes,
        total_minutes: hydrated.total_minutes,
        rest_minutes: hydrated.rest_minutes,
        rating: hydrated.rating,
        favorite: hydrated.favorite,
        category: hydrated.category,
        tags: hydrated.tags,
        tools: hydrated.tools,
        ingredients: hydrated.ingredients,
        steps: hydrated.steps,
        nutrition: hydrated.nutrition,
        source_url: hydrated.source_url,
        notes: hydrated.notes,
        cook_count: hydrated.cook_count,
        last_cooked_at: hydrated.last_cooked_at,
      });
    }
  );
}
