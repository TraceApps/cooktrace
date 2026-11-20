/**
 * MCP tools for recipe categories and cookbooks (#101):
 * list_recipe_categories and list_cookbooks (read tier),
 * add_recipe_to_cookbook and remove_recipe_from_cookbook (write tier).
 *
 * Adding and removing go through the same code as the app's cookbook
 * routes (routes/cookbooks.js), so who may change a cookbook is the
 * app's rule: its owner, or a Sous Chef of a kitchen it's shared with.
 * A smart cookbook fills itself from its filter, so it's refused here,
 * as the app offers no way to add to one either.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError, safeJson } from '../_util.js';
import {
  addRecipesToCookbook, removeRecipeFromCookbook, canEditCookbook, cookbookRecipeCount,
} from '../../../routes/cookbooks.js';

// A cookbook this account can see: its own, or one shared with it.
function _visibleCookbook(id, userId) {
  return db.prepare(
    `SELECT c.* FROM cookbooks c
      WHERE c.id = ? AND c.deleted_at IS NULL
        AND (c.user_id = ? OR EXISTS (SELECT 1 FROM cookbook_shares s WHERE s.cookbook_id = c.id AND s.grantee_id = ?))`
  ).get(id, userId, userId);
}

const _recipeIds = z.array(z.number().int().positive()).min(1).max(100);

export function registerListRecipeCategories(server, { userId }) {
  server.registerTool(
    'list_recipe_categories',
    {
      title: 'List Recipe Categories',
      description:
        'Your recipe categories, in the order the app shows them, each with how many of your ' +
        'recipes are in it. update_recipe takes a category by its id or its name.',
      inputSchema: {},
    },
    async () => {
      const rows = db.prepare(
        `SELECT c.id, c.name,
                (SELECT COUNT(*) FROM recipes r
                  WHERE r.category_id = c.id AND r.user_id = ? AND r.deleted_at IS NULL) AS recipe_count
           FROM recipe_categories c
          WHERE c.user_id = ?
          ORDER BY c.sort_order ASC, c.name ASC`
      ).all(userId, userId);
      return toolResult({ categories: rows });
    }
  );
}

export function registerListCookbooks(server, { userId }) {
  server.registerTool(
    'list_cookbooks',
    {
      title: 'List Cookbooks',
      description:
        'Your cookbooks and the ones shared with you, each with its recipe count. smart is true ' +
        'for a cookbook that fills itself from a filter (recipes can\'t be added to it or taken ' +
        'out); can_edit says whether you may add or remove recipes.',
      inputSchema: {},
    },
    async () => {
      const own = db.prepare(
        `SELECT c.* FROM cookbooks c
          WHERE c.user_id = ? AND c.deleted_at IS NULL
          ORDER BY c.sort_order ASC, c.name ASC`
      ).all(userId);
      const shared = db.prepare(
        `SELECT c.*, gu.username AS shared_by
           FROM cookbook_shares s
           JOIN cookbooks c ON c.id = s.cookbook_id
           LEFT JOIN users gu ON gu.id = s.granted_by
          WHERE s.grantee_id = ? AND c.deleted_at IS NULL AND c.user_id IS NOT ?
          ORDER BY c.name ASC`
      ).all(userId, userId);
      const cache = new Map();
      const seen = new Set();
      const out = [];
      for (const c of [...own, ...shared]) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push({
          id: c.id,
          name: c.name,
          description: c.description || null,
          smart: !!c.is_smart,
          ...(c.is_smart ? { smart_filter: safeJson(c.smart_filter_json, null) } : {}),
          recipe_count: cookbookRecipeCount(c, cache),
          shared_by: c.user_id === userId ? null : (c.shared_by || null),
          can_edit: !c.is_smart && canEditCookbook(c, userId),
        });
      }
      return toolResult({ cookbooks: out });
    }
  );
}

// Which of the ids are in the cookbook now.
function _linked(cookbookId, ids) {
  return new Set(db.prepare(
    `SELECT recipe_id FROM recipe_cookbook_links
      WHERE cookbook_id = ? AND recipe_id IN (SELECT value FROM json_each(?))`
  ).all(cookbookId, JSON.stringify(ids)).map(r => r.recipe_id));
}

// The cookbook, or the error to give: not there, smart, or not yours to change.
function _editable(cookbookId, userId) {
  const cb = _visibleCookbook(cookbookId, userId);
  if (!cb) return { error: `cookbook_id ${cookbookId} not found in your cookbooks or the ones shared with you.` };
  if (cb.is_smart) return { error: `"${cb.name}" is a smart cookbook: its filter decides which recipes are in it. Change the filter in the app instead.` };
  if (!canEditCookbook(cb, userId)) return { error: `"${cb.name}" is shared with you to read; only its owner or a Sous Chef can change it.` };
  return { cb };
}

export function registerAddRecipeToCookbook(server, { userId }) {
  server.registerTool(
    'add_recipe_to_cookbook',
    {
      title: 'Add Recipe to Cookbook',
      description:
        'Put one or more recipes in a cookbook, after the ones already there. Use list_cookbooks ' +
        'for the cookbook_id. Recipes already in it stay where they are; ids you can\'t open are ' +
        'listed as not_found and skipped.',
      inputSchema: {
        cookbook_id: z.number().int().positive(),
        recipe_ids:  _recipeIds,
      },
    },
    async ({ cookbook_id, recipe_ids }) => {
      const { cb, error } = _editable(cookbook_id, userId);
      if (error) return toolError(error);
      const ids = [...new Set(recipe_ids)];
      const before = _linked(cb.id, ids);
      const r = addRecipesToCookbook(cb.id, userId, ids);
      if (r.status !== 200) return toolError(r.body?.error || `Couldn't change the cookbook (${r.status}).`);
      const after = _linked(cb.id, ids);
      return toolResult({
        ok: true,
        cookbook: { id: cb.id, name: cb.name },
        added: ids.filter(id => after.has(id) && !before.has(id)),
        already_in: ids.filter(id => before.has(id)),
        not_found: ids.filter(id => !after.has(id)),
      });
    }
  );
}

export function registerRemoveRecipeFromCookbook(server, { userId }) {
  server.registerTool(
    'remove_recipe_from_cookbook',
    {
      title: 'Remove Recipe from Cookbook',
      description:
        'Take one or more recipes out of a cookbook. The recipes themselves stay in your library ' +
        'and in any other cookbook. Ids that weren\'t in it are listed as not_in.',
      inputSchema: {
        cookbook_id: z.number().int().positive(),
        recipe_ids:  _recipeIds,
      },
    },
    async ({ cookbook_id, recipe_ids }) => {
      const { cb, error } = _editable(cookbook_id, userId);
      if (error) return toolError(error);
      const ids = [...new Set(recipe_ids)];
      const before = _linked(cb.id, ids);
      for (const id of ids) {
        if (!before.has(id)) continue;
        const r = removeRecipeFromCookbook(cb.id, userId, id);
        if (r.status !== 200) return toolError(r.body?.error || `Couldn't change the cookbook (${r.status}).`);
      }
      return toolResult({
        ok: true,
        cookbook: { id: cb.id, name: cb.name },
        removed: ids.filter(id => before.has(id)),
        not_in: ids.filter(id => !before.has(id)),
      });
    }
  );
}
