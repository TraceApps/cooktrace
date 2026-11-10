/**
 * MCP tools: plan_cook and update_plan (write) (#89)
 *
 * A planned cook, made and changed the way the app's own Plan a Cook
 * dialog does it (POST and PUT /api/cook-diary): the account's own recipe
 * or one shared with it, servings only when said, "any day" of a week,
 * and the shopping list following a planned cook that's already on it.
 * Planning never logs a cook: nothing here touches cook counts.
 */
import { z } from 'zod';
import db from '../../../db.js';
import { DATE_RE, toolResult, toolError } from '../_util.js';
import { linkableRecipeId } from '../../link-checks.js';
import { saveRow } from '../../rest-merge.js';
import { followPlan } from '../../../routes/shopping.js';

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

const _entry = (id, userId) => db.prepare(
  `SELECT cd.id AS entry_id, cd.recipe_id, r.name AS recipe_name, cd.date, cd.any_day,
          cd.meal_type, cd.servings, cd.notes
     FROM cook_diary cd LEFT JOIN recipes r ON r.id = cd.recipe_id
    WHERE cd.id = ? AND cd.user_id = ?`
).get(id, userId);
const _shape = e => e && { ...e, any_day: !!e.any_day };

export function planCookCore(userId, { recipe_id, date, any_day, meal_type, servings, notes } = {}) {
  if (!DATE_RE.test(date || '')) throw new Error(`Invalid date '${date}'; expected YYYY-MM-DD.`);
  const recipe = linkableRecipeId(recipe_id, userId) != null
    ? db.prepare(`SELECT id FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(recipe_id) : null;
  if (!recipe) throw new Error(`recipe_id ${recipe_id} not found in your recipes or the ones shared with you.`);
  const r = db.prepare(
    `INSERT INTO cook_diary (user_id, recipe_id, date, kind, servings, notes, meal_type, any_day)
     VALUES (?, ?, ?, 'planned', ?, ?, ?, ?)`
  ).run(userId, recipe_id, date, servings ?? null, notes?.trim() || null, meal_type || null, any_day ? 1 : 0);
  return { ok: true, planned: _shape(_entry(r.lastInsertRowid, userId)) };
}

export function updatePlanCore(userId, entryId, b = {}) {
  const existing = db.prepare(
    `SELECT * FROM cook_diary WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).get(entryId, userId);
  if (!existing) throw new Error(`entry_id ${entryId} not found in your cook diary.`);
  if (existing.kind !== 'planned') throw new Error(`entry_id ${entryId} is a logged cook, not a plan.`);
  if (b.date !== undefined && !DATE_RE.test(b.date)) throw new Error(`Invalid date '${b.date}'; expected YYYY-MM-DD.`);

  const next = {
    date:      b.date ?? existing.date,
    // A set day given without any_day: it's on that day now, as when the
    // app moves an "any day" cook onto one.
    any_day:   b.any_day !== undefined ? (b.any_day ? 1 : 0) : b.date !== undefined ? 0 : existing.any_day,
    meal_type: b.meal_type !== undefined ? b.meal_type : existing.meal_type,
    servings:  b.servings !== undefined ? b.servings : existing.servings,
    notes:     b.notes !== undefined ? (b.notes?.trim() || null) : existing.notes,
  };
  const changed = Object.keys(next).filter(k => (next[k] ?? null) !== (existing[k] ?? null));
  if (changed.length) saveRow('cook_diary', entryId, existing, next);
  // Its share of the shopping list follows it (#81).
  const list = changed.length ? followPlan(userId, entryId) : null;
  return {
    ok: true, changed, planned: _shape(_entry(entryId, userId)),
    ...(list ? { shopping_list: { added: list.added, changed: list.changed, removed: list.removed } } : {}),
  };
}

export function registerPlanCook(server, { userId }) {
  server.registerTool(
    'plan_cook',
    {
      title: 'Plan Cook',
      description:
        'Plan a recipe for a day: a planned cook in the diary, shown in the app\'s week ' +
        'view and used when the shopping list is built from the plan. Planning never logs ' +
        'a cook. recipe_id from search_recipes / recent_recipes. any_day=true plans it for ' +
        'some day of the week that date falls in, not a set day. servings: leave out unless ' +
        'the user said how many; the shopping list then uses the recipe\'s own. ' +
        'list_cook_diary kind=planned lists plans, update_plan changes one, ' +
        'delete_cook_diary_entry removes one.',
      inputSchema: {
        recipe_id: z.number().int().positive(),
        date:      z.string().regex(DATE_RE, 'YYYY-MM-DD'),
        any_day:   z.boolean().optional(),
        meal_type: z.enum(MEAL_TYPES).optional(),
        servings:  z.number().positive().max(1000).optional(),
        notes:     z.string().max(1000).optional(),
      },
    },
    async (args) => {
      try { return toolResult(planCookCore(userId, args)); } catch (e) { return toolError(e.message); }
    }
  );
}

export function registerUpdatePlan(server, { userId }) {
  server.registerTool(
    'update_plan',
    {
      title: 'Update Plan',
      description:
        'Change a planned cook: move it to another date, make it any day of a week, or ' +
        'change its meal, servings or notes. Only the fields sent change; null clears ' +
        'meal_type, servings or notes. A date sent without any_day puts it on that day. ' +
        'entry_id from list_cook_diary kind=planned. When the shopping list already holds ' +
        'this cook\'s ingredients, it follows the change, as it does in the app.',
      inputSchema: {
        entry_id:  z.number().int().positive(),
        date:      z.string().regex(DATE_RE, 'YYYY-MM-DD').optional(),
        any_day:   z.boolean().optional(),
        meal_type: z.enum(MEAL_TYPES).nullable().optional(),
        servings:  z.number().positive().max(1000).nullable().optional(),
        notes:     z.string().max(1000).nullable().optional(),
      },
    },
    async ({ entry_id, ...rest }) => {
      try { return toolResult(updatePlanCore(userId, entry_id, rest)); } catch (e) { return toolError(e.message); }
    }
  );
}
