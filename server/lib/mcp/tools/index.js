/**
 * MCP tool registrar. Called once per request when the McpServer is
 * built. Each tool is registered against the user identified by
 * ctx.userId — the token that hit the MCP endpoint owns the scope
 * of every query. No cross-user access is possible from an MCP
 * handler; every DB query in each tool prepends `WHERE user_id = ?`
 * (recipes additionally allow a Kitchen-shared 'group' recipe where
 * the app itself allows it — log_cook and get_recipe's shared-view
 * counterparts).
 *
 * Write tools are registered ONLY when the request context reports
 * writes: true — that requires BOTH the server-side MCP_WRITE_ENABLED
 * flag AND the caller's token holding the `mcp:write` scope. Destroy
 * tools require BOTH MCP_DESTROY_ENABLED AND `mcp:destroy`. If either
 * half of a gate is absent the corresponding tools don't appear in
 * tools/list at all, so an agent has no way to attempt them.
 */
import { registerSearchRecipes } from './search-recipes.js';
import { registerGetRecipe } from './get-recipe.js';
import { registerRecentRecipes } from './recent-recipes.js';
import { registerListPantry } from './list-pantry.js';
import { registerListShoppingList } from './list-shopping-list.js';
import { registerListCookDiary } from './list-cook-diary.js';
import { registerLogCook } from './log-cook.js';
import { registerAddShoppingItem } from './add-shopping-item.js';
import { registerCheckShoppingItem } from './check-shopping-item.js';
import { registerUpdatePantryStock } from './update-pantry-stock.js';
import { registerCreateRecipe } from './create-recipe.js';
import { registerAddPantryItem } from './add-pantry-item.js';
import { registerDeleteCookDiaryEntry } from './delete-cook-diary-entry.js';
import { registerRemoveShoppingItem } from './remove-shopping-item.js';

export function registerReadTools(server, ctx) {
  registerSearchRecipes(server, ctx);
  registerGetRecipe(server, ctx);
  registerRecentRecipes(server, ctx);
  registerListPantry(server, ctx);
  registerListShoppingList(server, ctx);
  registerListCookDiary(server, ctx);
}

export function registerWriteTools(server, ctx) {
  registerLogCook(server, ctx);
  registerAddShoppingItem(server, ctx);
  registerCheckShoppingItem(server, ctx);
  registerUpdatePantryStock(server, ctx);
}

export function registerDestroyTools(server, ctx) {
  registerCreateRecipe(server, ctx);
  registerAddPantryItem(server, ctx);
  registerDeleteCookDiaryEntry(server, ctx);
  registerRemoveShoppingItem(server, ctx);
}
