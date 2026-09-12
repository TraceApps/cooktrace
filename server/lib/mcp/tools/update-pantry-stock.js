/**
 * MCP tool: update_pantry_stock (write)
 *
 * Update an EXISTING pantry item's stock state and/or quantity. Mirrors
 * PATCH /api/pantry/:id/stock (extended to also allow a quantity update
 * in the same call, still touching only a row the user already owns —
 * does not create new pantry rows; see add_pantry_item for that).
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';
import { dispatchWebhookEvent } from '../../webhooks.js';

/**
 * Core write, shared by the MCP tool below and the public REST API at
 * PATCH /api/v1/pantry/:id/stock. Throws a plain Error on bad input.
 * Dispatches pantry.out_of_stock itself on an in-stock-to-out-of-stock
 * transition (routes/pantry.js's own PATCH /:id/stock and PUT /:id have
 * their own separate, duplicate dispatch since they don't call this
 * function). previous_in_stock is also returned so any future caller
 * can see the prior state without a second query.
 */
export function updatePantryStockCore(userId, { item_id, in_stock, quantity } = {}) {
  const existing = db.prepare(
    `SELECT id, name, in_stock, quantity FROM pantry_items WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).get(item_id, userId);
  if (!existing) throw new Error(`item_id ${item_id} not found in your pantry.`);
  if (in_stock === undefined && quantity === undefined) {
    throw new Error('Provide at least one of in_stock or quantity to update.');
  }

  const nextInStock = in_stock === undefined ? existing.in_stock : (in_stock ? 1 : 0);
  const nextQuantity = quantity === undefined ? existing.quantity : quantity;

  db.prepare(
    `UPDATE pantry_items SET in_stock = ?, quantity = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(nextInStock, nextQuantity, item_id);

  if (existing.in_stock === 1 && nextInStock === 0) {
    try {
      dispatchWebhookEvent(userId, 'pantry.out_of_stock', { pantry_item_id: item_id, name: existing.name });
    } catch (e) { /* never let a webhook failure block the save */ }
  }

  return {
    ok: true,
    item_id,
    name: existing.name,
    in_stock: !!nextInStock,
    quantity: nextQuantity,
    previous_in_stock: !!existing.in_stock,
  };
}

export function registerUpdatePantryStock(server, { userId }) {
  server.registerTool(
    'update_pantry_stock',
    {
      title: 'Update Pantry Stock',
      description:
        "Update an existing pantry item's in_stock flag and/or quantity. Use " +
        'list_pantry first to find the item_id. Does not create new pantry items — ' +
        'see add_pantry_item for that.',
      inputSchema: {
        item_id:  z.number().int().positive(),
        in_stock: z.boolean().optional(),
        quantity: z.number().min(0).max(1000000).optional(),
      },
    },
    async ({ item_id, in_stock, quantity }) => {
      try {
        return toolResult(updatePantryStockCore(userId, { item_id, in_stock, quantity }));
      } catch (e) {
        return toolError(e.message);
      }
    }
  );
}
