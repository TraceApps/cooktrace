/**
 * MCP tool: add_shopping_item (write)
 *
 * Append one item to the shopping list. Mirrors POST /api/shopping — a
 * plain additive insert, no dedupe (the app's own endpoint doesn't
 * dedupe on this path either; duplicates are cleaned up in the UI like
 * any manually-added item).
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';

function _titleCase(s) {
  return s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

export function registerAddShoppingItem(server, { userId }) {
  server.registerTool(
    'add_shopping_item',
    {
      title: 'Add Shopping List Item',
      description:
        'Add one item to the shopping list. Everything it writes shows up as a normal ' +
        'entry in the Shopping UI, editable and checkable like anything else.',
      inputSchema: {
        name:     z.string().min(1).max(200),
        quantity: z.number().positive().max(100000).optional(),
        unit:     z.string().max(20).optional(),
        aisle:    z.string().max(50).optional(),
      },
    },
    async ({ name, quantity, unit, aisle }) => {
      const cleanName = name.trim();
      if (!cleanName) return toolError('name is required and cannot be blank.');

      const result = db.prepare(
        `INSERT INTO shopping_list (user_id, name, quantity, unit, aisle, checked)
         VALUES (?, ?, ?, ?, ?, 0)`
      ).run(userId, _titleCase(cleanName), quantity ?? null, unit || null, aisle?.trim() || null);

      return toolResult({
        ok: true,
        added: {
          item_id: result.lastInsertRowid,
          name: _titleCase(cleanName),
          quantity: quantity ?? null,
          unit: unit || null,
          aisle: aisle?.trim() || null,
        },
      });
    }
  );
}
