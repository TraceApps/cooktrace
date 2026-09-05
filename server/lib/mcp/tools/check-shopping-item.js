/**
 * MCP tool: check_shopping_item (write)
 *
 * Toggle a shopping list item's checked state. Mirrors
 * PATCH /api/shopping/:id/check.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';

export function registerCheckShoppingItem(server, { userId }) {
  server.registerTool(
    'check_shopping_item',
    {
      title: 'Check/Uncheck Shopping List Item',
      description:
        'Mark one shopping list item checked (bought) or unchecked. Use ' +
        'list_shopping_list first to find the item_id.',
      inputSchema: {
        item_id: z.number().int().positive(),
        checked: z.boolean(),
      },
    },
    async ({ item_id, checked }) => {
      const existing = db.prepare(
        `SELECT id, name FROM shopping_list WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
      ).get(item_id, userId);
      if (!existing) return toolError(`item_id ${item_id} not found on your shopping list.`);

      db.prepare(
        `UPDATE shopping_list SET checked = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(checked ? 1 : 0, item_id);

      return toolResult({ ok: true, item_id, name: existing.name, checked });
    }
  );
}
