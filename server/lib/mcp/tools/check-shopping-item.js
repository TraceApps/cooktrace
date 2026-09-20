/**
 * MCP tool: check_shopping_item (write)
 *
 * Toggle a shopping list item's checked state. Mirrors
 * PATCH /api/shopping/:id/check.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';
import { dispatchWebhookEvent } from '../../webhooks.js';

/**
 * Core write, shared by the MCP tool below and the public REST API at
 * PATCH /api/v1/shopping/:id/check. Throws a plain Error on a missing
 * item.
 */
export function checkShoppingItemCore(userId, { item_id, checked } = {}) {
  const existing = db.prepare(
    `SELECT id, name, checked FROM shopping_list WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).get(item_id, userId);
  if (!existing) throw new Error(`item_id ${item_id} not found on your shopping list.`);

  const next = checked ? 1 : 0;
  db.prepare(
    `UPDATE shopping_list SET checked = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(next, item_id);

  // Only a genuine 0-to-1 transition can newly complete the list; a
  // redundant re-check of an already-checked item must not re-fire.
  if (next === 1 && existing.checked !== 1) {
    try {
      const remaining = db.prepare(
        `SELECT COUNT(*) AS n FROM shopping_list WHERE user_id = ? AND deleted_at IS NULL AND checked = 0`
      ).get(userId);
      const total = db.prepare(
        `SELECT COUNT(*) AS n FROM shopping_list WHERE user_id = ? AND deleted_at IS NULL`
      ).get(userId);
      if (remaining.n === 0 && total.n > 0) {
        dispatchWebhookEvent(userId, 'shopping_list.completed', { items_count: total.n });
      }
    } catch (e) { /* never let a webhook failure block the save */ }
  }

  return { ok: true, item_id, name: existing.name, checked };
}

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
      try {
        return toolResult(checkShoppingItemCore(userId, { item_id, checked }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
