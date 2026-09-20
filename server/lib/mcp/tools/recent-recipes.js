/**
 * MCP tool: recent_recipes
 *
 * The user's most recently updated recipes — a browsing entry point
 * for an agent that doesn't have a search term yet ("what can I cook
 * with what I have" style prompts often start here before get_recipe).
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult } from '../_util.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export function registerRecentRecipes(server, { userId }) {
  server.registerTool(
    'recent_recipes',
    {
      title: 'Recent Recipes',
      description:
        "The user's most recently added or updated recipes, newest first. " +
        'Default limit 20, max 50.',
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async ({ limit }) => {
      const cap = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
      const rows = db.prepare(
        `SELECT id, name, description, servings, prep_minutes, cook_minutes, total_minutes,
                rating, cook_count, last_cooked_at, updated_at
           FROM recipes
          WHERE user_id = ? AND deleted_at IS NULL
          ORDER BY updated_at DESC
          LIMIT ?`
      ).all(userId, cap);
      return toolResult({ count: rows.length, limit: cap, items: rows });
    }
  );
}
