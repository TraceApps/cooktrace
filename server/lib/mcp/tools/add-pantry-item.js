/**
 * MCP tool: add_pantry_item (destructive)
 *
 * Insert a new row into the user's pantry catalog. Semi-destructive
 * for the same reason create_recipe is: the row persists and shows up
 * in every pantry search / picker, so an agent that fabricates items
 * can pollute the catalog in a way a user has to hand-clean.
 *
 * Category is stored as free text only (no category_id resolution) —
 * a simplification versus the app's editor, which also resolves a
 * category_id for display grouping. An unmatched slug already falls
 * back to "Uncategorized" in the app (issue #41) rather than hiding
 * the item, so this is a safe simplification, not a dead end.
 *
 * Refuses to insert a duplicate top-level (non-variant) name; call
 * list_pantry first to see if a match already exists.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';

export function registerAddPantryItem(server, { userId }) {
  server.registerTool(
    'add_pantry_item',
    {
      title: 'Add Pantry Item',
      description:
        "Add a new item to the user's pantry catalog. Requires confirm=true. Refuses to " +
        'insert if a top-level item with the same name already exists — call list_pantry ' +
        "first if you're not sure. category is stored as free text (no resolution to the " +
        'app\'s category catalog).',
      inputSchema: {
        confirm:    z.boolean(),
        name:       z.string().min(1).max(200),
        quantity:   z.number().min(0).max(1000000).optional(),
        unit:       z.string().max(20).optional(),
        category:   z.string().max(50).optional(),
        in_stock:   z.boolean().optional(),
        expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
        notes:      z.string().max(1000).optional(),
      },
    },
    async ({ confirm, name, quantity, unit, category, in_stock, expires_on, notes }) => {
      if (confirm !== true) {
        return toolError(
          'add_pantry_item requires confirm=true. This safeguards against accidental ' +
          "catalog pollution. Set the confirm argument to true and re-invoke if you're sure."
        );
      }
      const cleanName = name.trim();
      if (!cleanName) return toolError('name is required and cannot be blank.');

      const existing = db.prepare(
        `SELECT id FROM pantry_items
          WHERE user_id = ? AND deleted_at IS NULL AND generic_parent_id IS NULL
            AND LOWER(name) = LOWER(?)
          LIMIT 1`
      ).get(userId, cleanName);
      if (existing) {
        return toolError(
          `A pantry item named '${cleanName}' already exists (id=${existing.id}). Use ` +
          'update_pantry_stock with that id, or edit the item in the app if it needs renaming.'
        );
      }

      const result = db.prepare(
        `INSERT INTO pantry_items (user_id, name, in_stock, quantity, unit, category, expires_on, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        userId,
        cleanName,
        in_stock === false ? 0 : 1,
        quantity ?? null,
        unit || null,
        category?.trim() || null,
        expires_on || null,
        notes || null,
      );

      return toolResult({
        ok: true,
        created: {
          id: result.lastInsertRowid,
          name: cleanName,
          in_stock: in_stock !== false,
          quantity: quantity ?? null,
          unit: unit || null,
          category: category?.trim() || null,
        },
      });
    }
  );
}
