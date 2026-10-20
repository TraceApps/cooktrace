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
import { toolResult, pageOffset, pageFields } from '../_util.js';
import { foldText } from '../../search-text.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export function registerSearchRecipes(server, { userId }) {
  server.registerTool(
    'search_recipes',
    {
      title: 'Search Recipes',
      description:
        "Text-search the user's own recipes by name or description, or list every recipe " +
        'when query is left out. Returns id, name, description, servings, prep/cook/total ' +
        'minutes, rating, and tags for each match, a page at a time: total is every match, ' +
        'next_offset where the next page starts (null on the last), complete true when ' +
        'everything has been returned. Default limit 20, max 50.',
      inputSchema: {
        query: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ query, limit, offset }) => {
      const q = String(query || '').trim();
      const cap = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
      const start = pageOffset(offset);
      const where = ['user_id = ?', 'deleted_at IS NULL'];
      const args = [userId];
      if (q) {
        // Escape LIKE wildcards so a recipe named "50% Whole Wheat" is
        // searchable by "50%" without matching every row.
        const escaped = q.replace(/[\\%_]/g, c => '\\' + c);
        const like = `%${foldText(escaped)}%`;
        where.push(`(fold(name) LIKE ? ESCAPE '\\' OR fold(description) LIKE ? ESCAPE '\\')`);
        args.push(like, like);
      }
      const total = db.prepare(`SELECT COUNT(*) AS n FROM recipes WHERE ${where.join(' AND ')}`).get(...args).n;
      // Ties go by id, so pages never skip or repeat a recipe.
      const rows = db.prepare(
        `SELECT id, name, description, servings, prep_minutes, cook_minutes, total_minutes, rating, tags
           FROM recipes
          WHERE ${where.join(' AND ')}
          ORDER BY name COLLATE NOCASE ASC, id ASC
          LIMIT ? OFFSET ?`
      ).all(...args, cap, start);
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
      return toolResult({ query: q, count: items.length, limit: cap, ...pageFields(total, start, items.length), items });
    }
  );
}
