/**
 * MCP tool: list_cook_diary
 *
 * Cook diary entries (both logged cooks and planned ones), optionally
 * filtered by date range. Unlike NutriTrace's diary (one JSON blob per
 * day), CookTrace's cook_diary is a normal row-per-entry table, so this
 * is a plain range query rather than a blob read.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, toolResult, toolError } from '../_util.js';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export function registerListCookDiary(server, { userId }) {
  server.registerTool(
    'list_cook_diary',
    {
      title: 'List Cook Diary',
      description:
        'List cook diary entries (logged cooks and planned cooks), newest first. ' +
        'Optionally bound by date_from / date_to (YYYY-MM-DD, inclusive). Without a ' +
        'range, returns the most recent entries regardless of date. Default limit 20, ' +
        'max 100.',
      inputSchema: {
        date_from: z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        date_to:   z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        kind:      z.enum(['cooked', 'planned']).optional(),
        limit:     z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
    },
    async ({ date_from, date_to, kind, limit }) => {
      if (date_from && !DATE_RE.test(date_from)) return toolError(`Invalid date_from '${date_from}'; expected YYYY-MM-DD.`);
      if (date_to && !DATE_RE.test(date_to)) return toolError(`Invalid date_to '${date_to}'; expected YYYY-MM-DD.`);
      const cap = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));

      const clauses = ['cd.user_id = ?', 'cd.deleted_at IS NULL'];
      const args = [userId];
      if (date_from) { clauses.push('cd.date >= ?'); args.push(date_from); }
      if (date_to)   { clauses.push('cd.date <= ?'); args.push(date_to); }
      if (kind)      { clauses.push('cd.kind = ?');  args.push(kind); }
      args.push(cap);

      const rows = db.prepare(
        `SELECT cd.id, cd.recipe_id, r.name AS recipe_name, cd.date, cd.kind,
                cd.servings, cd.notes, cd.meal_type, cd.rating
           FROM cook_diary cd
           LEFT JOIN recipes r ON r.id = cd.recipe_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY cd.date DESC, cd.created_at DESC
          LIMIT ?`
      ).all(...args);
      return toolResult({ count: rows.length, limit: cap, items: rows });
    }
  );
}
