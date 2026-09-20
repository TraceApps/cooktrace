/**
 * MCP tool: remove_shopping_item (destructive)
 *
 * Soft-delete one shopping list item, matching DELETE
 * /api/shopping/:id's semantics exactly (deleted_at stamp).
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';

export function registerRemoveShoppingItem(server, { userId }) {
  server.registerTool(
    'remove_shopping_item',
    {
      title: 'Remove Shopping List Item',
      description:
        'Remove one item from the shopping list entirely. Requires confirm=true. Use ' +
        'check_shopping_item instead if you just want to mark it bought without removing ' +
        'it from the list.',
      inputSchema: {
        item_id: z.number().int().positive(),
        confirm: z.boolean(),
      },
    },
    async ({ item_id, confirm }) => {
      if (confirm !== true) {
        return toolError(
          'remove_shopping_item requires confirm=true. This safeguards against ' +
          'accidental destructive tool calls. Set the confirm argument to true and ' +
          "re-invoke if you're sure."
        );
      }
      const existing = db.prepare(
        `SELECT id, name FROM shopping_list WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
      ).get(item_id, userId);
      if (!existing) return toolError(`item_id ${item_id} not found on your shopping list.`);

      db.prepare(
        `UPDATE shopping_list SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).run(item_id);

      return toolResult({ ok: true, removed: { item_id, name: existing.name } });
    }
  );
}
