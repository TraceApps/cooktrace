/**
 * MCP tool: delete_cook_diary_entry (destructive)
 *
 * Soft-delete one cook diary entry, matching DELETE
 * /api/cook-diary/:id's semantics exactly (deleted_at stamp, not a
 * hard row delete), and recompute the recipe's cook_count /
 * last_cooked_at afterward so they stay honest.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';
import { recomputeRecipeAggregates } from '../../../routes/cook-diary.js';

export function registerDeleteCookDiaryEntry(server, { userId }) {
  server.registerTool(
    'delete_cook_diary_entry',
    {
      title: 'Delete Cook Diary Entry',
      description:
        'Remove one cook diary entry (a logged or planned cook). Requires confirm=true. ' +
        'Use list_cook_diary first to find the entry_id. Recomputes the linked recipe\'s ' +
        'cook_count and last_cooked_at afterward.',
      inputSchema: {
        entry_id: z.number().int().positive(),
        confirm:  z.boolean(),
      },
    },
    async ({ entry_id, confirm }) => {
      if (confirm !== true) {
        return toolError(
          'delete_cook_diary_entry requires confirm=true. This safeguards against ' +
          'accidental destructive tool calls. Set the confirm argument to true and ' +
          "re-invoke if you're sure."
        );
      }
      const existing = db.prepare(
        `SELECT id, recipe_id, date, kind FROM cook_diary WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
      ).get(entry_id, userId);
      if (!existing) return toolError(`entry_id ${entry_id} not found in your cook diary.`);

      db.prepare(
        `UPDATE cook_diary SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).run(entry_id);

      if (existing.recipe_id) recomputeRecipeAggregates(existing.recipe_id);

      return toolResult({
        ok: true,
        removed: { entry_id, recipe_id: existing.recipe_id, date: existing.date, kind: existing.kind },
      });
    }
  );
}
