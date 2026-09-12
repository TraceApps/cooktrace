/**
 * MCP tool: list_shopping_list
 *
 * The user's current shopping list. Unchecked items only by default —
 * an agent asking "what's on my shopping list" almost always means
 * "what do I still need to buy".
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult } from '../_util.js';

/**
 * Core lookup, shared by the MCP tool below and the public REST API at
 * GET /api/v1/shopping.
 */
export function listShoppingListCore(userId, { include_checked } = {}) {
  const clauses = ['user_id = ?', 'deleted_at IS NULL'];
  const args = [userId];
  if (!include_checked) clauses.push('checked = 0');
  const rows = db.prepare(
    `SELECT id, name, quantity, unit, aisle, checked
       FROM shopping_list
      WHERE ${clauses.join(' AND ')}
      ORDER BY checked ASC, COALESCE(aisle, 'zzz') ASC, name COLLATE NOCASE ASC`
  ).all(...args);
  const items = rows.map(r => ({ ...r, checked: !!r.checked }));
  return { count: items.length, items };
}

export function registerListShoppingList(server, { userId }) {
  server.registerTool(
    'list_shopping_list',
    {
      title: 'List Shopping List',
      description:
        "The user's current shopping list, sorted by aisle then name. Unchecked items " +
        'only by default; pass include_checked=true to also see items already checked off.',
      inputSchema: {
        include_checked: z.boolean().optional(),
      },
    },
    async ({ include_checked }) => {
      return toolResult(listShoppingListCore(userId, { include_checked }));
    }
  );
}
