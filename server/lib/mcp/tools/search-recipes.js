/**
 * MCP tool: search_recipes
 *
 * Text-search the user's own recipes by name or description. recipes.js
 * has no server-side search of its own (the client fetches everything
 * and filters locally), so this queries the table directly rather than
 * delegating to an existing route handler.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, toolError } from '../_util.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export function registerSearchRecipes(server, { userId }) {
  server.registerTool(
    'search_recipes',
    {
      title: 'Search Recipes',
      description:
        "Text-search the user's own recipes by name or description. Returns id, name, " +
        'description, servings, prep/cook/total minutes, rating, and tags for each match. ' +
        'Default limit 20, max 50.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async ({ query, limit }) => {
      const q = String(query || '').trim();
      if (!q) return toolError('query is required and cannot be empty.');
      const cap = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
      // Escape LIKE wildcards so a recipe named "50% Whole Wheat" is
      // searchable by "50%" without matching every row.
      const escaped = q.replace(/[\\%_]/g, c => '\\' + c);
      const like = `%${escaped}%`;
      const rows = db.prepare(
        `SELECT id, name, description, servings, prep_minutes, cook_minutes, total_minutes, rating, tags
           FROM recipes
          WHERE user_id = ?
            AND deleted_at IS NULL
            AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
          ORDER BY name COLLATE NOCASE ASC
          LIMIT ?`
      ).all(userId, like, like, cap);
      const items = rows.map(r => ({
        id: r.id,
        name: r.name,
        description: r.description || null,
        servings: r.servings,
        prep_minutes: r.prep_minutes,
        cook_minutes: r.cook_minutes,
        total_minutes: r.total_minutes,
        rating: r.rating,
        tags: (() => { try { return JSON.parse(r.tags || '[]'); } catch { return []; } })(),
      }));
      return toolResult({ query: q, count: items.length, limit: cap, items });
    }
  );
}
