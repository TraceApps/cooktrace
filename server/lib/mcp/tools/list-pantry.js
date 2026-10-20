/**
 * MCP tool: list_pantry
 *
 * List / search the user's pantry. Optional text query (name or brand)
 * and an in_stock filter. No server-side pantry search endpoint exists
 * today (the client fetches and filters locally, same situation as
 * recipes), so this queries the table directly.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { toolResult, pageOffset, pageFields } from '../_util.js';
import { foldText } from '../../search-text.js';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export function registerListPantry(server, { userId }) {
  server.registerTool(
    'list_pantry',
    {
      title: 'List Pantry',
      description:
        "List the user's pantry items, optionally filtered by a text query (name or " +
        'brand) and/or in-stock state. Returns id, name, brand, in_stock, quantity, unit, ' +
        'category, and expires_on for each item, a page at a time: total is every match, ' +
        'next_offset where the next page starts (null on the last). Default limit 50, max 100.',
      inputSchema: {
        query: z.string().optional(),
        in_stock_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ query, in_stock_only, limit, offset }) => {
      const cap = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
      const start = pageOffset(offset);
      const q = String(query || '').trim();
      const clauses = ['user_id = ?', 'deleted_at IS NULL'];
      const args = [userId];
      if (q) {
        const escaped = q.replace(/[\\%_]/g, c => '\\' + c);
        const like = `%${foldText(escaped)}%`;
        clauses.push(`(fold(name) LIKE ? ESCAPE '\\' OR fold(brand) LIKE ? ESCAPE '\\')`);
        args.push(like, like);
      }
      if (in_stock_only) clauses.push('in_stock = 1');
      const total = db.prepare(`SELECT COUNT(*) AS n FROM pantry_items WHERE ${clauses.join(' AND ')}`).get(...args).n;
      // Ties go by id, so pages never skip or repeat an item.
      const rows = db.prepare(
        `SELECT id, name, brand, in_stock, quantity, unit, category, expires_on, notes
           FROM pantry_items
          WHERE ${clauses.join(' AND ')}
          ORDER BY name COLLATE NOCASE ASC, id ASC
          LIMIT ? OFFSET ?`
      ).all(...args, cap, start);
      const items = rows.map(r => ({ ...r, in_stock: !!r.in_stock }));
      return toolResult({ count: items.length, limit: cap, ...pageFields(total, start, items.length), items });
    }
  );
}
