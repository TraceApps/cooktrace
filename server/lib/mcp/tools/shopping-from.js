/**
 * MCP tools: add_recipe_to_shopping_list, add_plan_to_shopping_list (write)
 *
 * The Shopping screen's "add recipe" and "build from plan": ingredients
 * fold into the list the same way (amounts of one ingredient add up,
 * in-stock pantry items are skipped unless only_missing=false, and a
 * week built again replaces its share instead of doubling it).
 */
import { z } from 'zod';
import { DATE_RE, toolResult, toolError } from '../_util.js';
import { addRecipeToList, addPlanToList } from '../../../routes/shopping.js';

export function registerAddRecipeToShoppingList(server, { userId }) {
  server.registerTool(
    'add_recipe_to_shopping_list',
    {
      title: 'Add Recipe to Shopping List',
      description:
        "Add a recipe's ingredients to the shopping list, scaled to `servings` when given. " +
        'Amounts of an ingredient already on the list add up. Ingredients whose pantry item ' +
        'is in stock are skipped unless only_missing=false.',
      inputSchema: {
        recipe_id:    z.number().int().positive(),
        servings:     z.number().positive().max(1000).optional(),
        only_missing: z.boolean().optional(),
      },
    },
    async ({ recipe_id, servings, only_missing }) => {
      const result = addRecipeToList(userId, recipe_id, { servings, onlyMissing: only_missing !== false });
      if (!result) return toolError(`recipe_id ${recipe_id} not found.`);
      return toolResult({ ok: true, recipe_id, ...result });
    }
  );
}

export function registerAddPlanToShoppingList(server, { userId }) {
  server.registerTool(
    'add_plan_to_shopping_list',
    {
      title: 'Build Shopping List from Plan',
      description:
        'Add the ingredients of every planned cook (plan_cook) from `from` to `to` ' +
        '(default today to 7 days ahead), each scaled to its planned servings. Building the ' +
        'same range again replaces its share, and cooks no longer planned leave the list. ' +
        'In-stock pantry items are skipped unless only_missing=false.',
      inputSchema: {
        from:         z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        to:           z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        only_missing: z.boolean().optional(),
      },
    },
    async ({ from, to, only_missing }) => {
      if (from && to && from > to) return toolError('from must not be after to.');
      return toolResult({ ok: true, ...addPlanToList(userId, { from, to, onlyMissing: only_missing !== false }) });
    }
  );
}
