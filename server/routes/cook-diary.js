/**
 * cook-diary.js — Cook Diary endpoints (past cooks + planned cooks).
 *
 * Past cooks come from POST /api/recipes/:id/cooked (already wired in
 * recipes.js). This route handles:
 *   - listing entries in a date range (both past + planned)
 *   - creating planned entries
 *   - updating entries (move date, edit notes)
 *   - converting planned → cooked
 *   - deleting entries
 *
 * The recipes route's _recomputeCookAggregates keeps recipe.last_cooked_at
 * + recipe.cook_count honest after deletes / converts.
 */
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const userClause = (u) => u == null ? 'user_id IS NULL' : 'user_id = ?';
const userArgs   = (u) => u == null ? [] : [u];

// ── GET /stats — diary summary metrics for the stats card ────────────
// Returns:
//   cooks_this_week  — count of kind='cooked' entries in last 7 days
//   cooks_this_month — count in last 30 days
//   total_cooks      — all-time count
//   top_recipe       — { id, name, count } for most-cooked recipe in
//                       last 30 days (null if none)
//   current_streak   — consecutive days back from today with >=1 cook
//                       (today counts if it has a cook; otherwise we
//                       start from yesterday so a not-yet-cooked-today
//                       streak isn't reset)
//   longest_streak   — longest run of consecutive days ever
// MUST be declared before GET /:id so /stats doesn't get captured
// as an :id param.
router.get('/stats', wrap((req, res) => {
  const u = uid(req);
  const where = `WHERE ${userClause(u).replace(/user_id/g, 'cd.user_id')} AND cd.deleted_at IS NULL AND cd.kind = 'cooked'`;
  const args = [...userArgs(u)];

  const cooksThisWeek  = db.prepare(`SELECT COUNT(*) AS n FROM cook_diary cd ${where} AND cd.date >= date('now', '-6 days')`).get(...args).n;
  const cooksThisMonth = db.prepare(`SELECT COUNT(*) AS n FROM cook_diary cd ${where} AND cd.date >= date('now', '-29 days')`).get(...args).n;
  const totalCooks     = db.prepare(`SELECT COUNT(*) AS n FROM cook_diary cd ${where}`).get(...args).n;

  const top = db.prepare(`
    SELECT cd.recipe_id, r.name, COUNT(*) AS n
    FROM cook_diary cd
    LEFT JOIN recipes r ON r.id = cd.recipe_id
    ${where} AND cd.date >= date('now', '-29 days') AND cd.recipe_id IS NOT NULL
    GROUP BY cd.recipe_id
    ORDER BY n DESC, r.name COLLATE NOCASE ASC
    LIMIT 1
  `).get(...args);
  const topRecipe = top ? { id: top.recipe_id, name: top.name || 'Recipe', count: top.n } : null;

  // Distinct cooked-on dates (DESC) — compute both streaks against
  // this list. SQLite returns date strings YYYY-MM-DD which sort
  // correctly as strings.
  const dates = db.prepare(`
    SELECT DISTINCT cd.date AS d FROM cook_diary cd ${where} ORDER BY cd.date DESC
  `).all(...args).map(r => r.d);

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = (() => {
    const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10);
  })();
  const dateSet = new Set(dates);

  // Current streak: walk back from today (or yesterday if today has
  // no cook so a not-yet-cooked-today doesn't reset the streak).
  let current = 0;
  let cursor = dateSet.has(today) ? today : (dateSet.has(yesterday) ? yesterday : null);
  while (cursor && dateSet.has(cursor)) {
    current++;
    const d = new Date(cursor + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    cursor = d.toISOString().slice(0, 10);
  }

  // Longest streak: scan distinct dates ascending, count consecutive runs.
  const asc = [...dates].reverse();
  let longest = 0, run = 0, prev = null;
  for (const d of asc) {
    if (prev) {
      const p = new Date(prev + 'T00:00:00');
      p.setDate(p.getDate() + 1);
      const expected = p.toISOString().slice(0, 10);
      run = (d === expected) ? run + 1 : 1;
    } else {
      run = 1;
    }
    if (run > longest) longest = run;
    prev = d;
  }

  res.json({
    cooks_this_week:  cooksThisWeek,
    cooks_this_month: cooksThisMonth,
    total_cooks:      totalCooks,
    top_recipe:       topRecipe,
    current_streak:   current,
    longest_streak:   longest,
  });
}));

// ── GET /heatmap — daily cook-count map for the contribution-graph viz ──
// Returns a compact array of { date: 'YYYY-MM-DD', count } for the
// last `days` days (clamped 30–730, default 365). Drives the GitHub-
// style heatmap on the Diary page. MUST be declared before GET /:id.
router.get('/heatmap', wrap((req, res) => {
  const u = uid(req);
  const raw = parseInt(req.query.days, 10);
  const days = Math.min(Math.max(Number.isFinite(raw) ? raw : 365, 30), 730);
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  const sinceIso = since.toISOString().slice(0, 10);
  const rows = db.prepare(
    `SELECT date, COUNT(*) AS count
       FROM cook_diary
      WHERE ${userClause(u)} AND deleted_at IS NULL AND kind = 'cooked'
        AND date >= ?
      GROUP BY date
      ORDER BY date ASC`
  ).all(...userArgs(u), sinceIso);
  res.json(rows);
}));

// ── GET / — list entries, optionally filtered by date range ────────────
router.get('/', wrap((req, res) => {
  const u = uid(req);
  const from = req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
  const to   = req.query.to   && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)   ? req.query.to   : null;
  const kind = req.query.kind === 'planned' || req.query.kind === 'cooked' ? req.query.kind : null;

  let sql = `
    SELECT cd.*, r.name AS recipe_name, r.img_url AS recipe_img_url,
           u.username AS cooked_by_username, u.full_name AS cooked_by_full_name
    FROM cook_diary cd
    LEFT JOIN recipes r ON r.id = cd.recipe_id
    LEFT JOIN users u   ON u.id = cd.user_id
    WHERE ${userClause(u).replace(/user_id/g, 'cd.user_id')} AND cd.deleted_at IS NULL
  `;
  const args = [...userArgs(u)];
  if (from) { sql += ' AND cd.date >= ?'; args.push(from); }
  if (to)   { sql += ' AND cd.date <= ?'; args.push(to); }
  if (kind) { sql += ' AND cd.kind = ?';  args.push(kind); }
  sql += ` ORDER BY cd.date DESC, cd.created_at DESC`;

  const rows = db.prepare(sql).all(...args);
  res.json(rows);
}));

// ── POST / — create a planned cook ─────────────────────────────────────
router.post('/', wrap((req, res) => {
  const u = uid(req);
  const body = req.body || {};
  const recipeId = parseInt(body.recipe_id, 10);
  if (!Number.isFinite(recipeId)) return res.status(400).json({ error: 'recipe_id required' });
  const date = (typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : null;
  if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });

  const recipe = db.prepare(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`).get(recipeId);
  if (!recipe) return res.status(404).json({ error: 'Recipe not found' });

  const kind = body.kind === 'cooked' ? 'cooked' : 'planned';
  const notes = body.notes ? String(body.notes).trim() || null : null;
  const photoUrl = body.photo_url ?? null;
  const servings = body.servings != null ? Number(body.servings) || null : null;
  const mealType = _coerceMealType(body.meal_type);
  const rating   = _coerceRating(body.rating);

  const result = db.prepare(
    `INSERT INTO cook_diary (user_id, recipe_id, date, kind, servings, notes, photo_url, meal_type, rating)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(u, recipeId, date, kind, servings, notes, photoUrl, mealType, rating);

  if (kind === 'cooked') recomputeRecipeAggregates(recipeId);

  const row = db.prepare(`SELECT * FROM cook_diary WHERE id = ?`).get(result.lastInsertRowid);
  res.status(201).json(row);
}));

// ── PUT /:id — update entry (incl. converting planned → cooked) ────────
router.put('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(`SELECT * FROM cook_diary WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if ((u == null && existing.user_id != null) || (u != null && existing.user_id !== u)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const body = req.body || {};
  const date = (typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : existing.date;
  const kind = body.kind === 'cooked' || body.kind === 'planned' ? body.kind : existing.kind;
  const notes = body.notes !== undefined ? (body.notes ? String(body.notes).trim() || null : null) : existing.notes;
  const photoUrl = body.photo_url !== undefined ? (body.photo_url ?? null) : existing.photo_url;
  const servings = body.servings !== undefined ? (body.servings === '' || body.servings == null ? null : Number(body.servings)) : existing.servings;
  const mealType = body.meal_type !== undefined ? _coerceMealType(body.meal_type) : existing.meal_type;
  const rating   = body.rating    !== undefined ? _coerceRating(body.rating)      : existing.rating;

  db.prepare(
    `UPDATE cook_diary SET date = ?, kind = ?, notes = ?, photo_url = ?, servings = ?,
        meal_type = ?, rating = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(date, kind, notes, photoUrl, servings, mealType, rating, id);

  // Recompute aggregates if cooked-state or recipe changed.
  if (existing.kind !== kind || existing.recipe_id) recomputeRecipeAggregates(existing.recipe_id);
  res.json({ ok: true });
}));

// ── DELETE /:id — soft delete ──────────────────────────────────────────
router.delete('/:id', wrap((req, res) => {
  const u = uid(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare(`SELECT * FROM cook_diary WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if ((u == null && existing.user_id != null) || (u != null && existing.user_id !== u)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.prepare(`UPDATE cook_diary SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  if (existing.recipe_id) recomputeRecipeAggregates(existing.recipe_id);
  res.json({ ok: true });
}));

// Whitelist meal-type strings; everything else stores as NULL.
// Matches the planner / log-dialog options.
const _MEAL_TYPES = new Set(['breakfast', 'lunch', 'dinner', 'snack']);
function _coerceMealType(v) {
  if (v == null || v === '') return null;
  const norm = String(v).toLowerCase().trim();
  return _MEAL_TYPES.has(norm) ? norm : null;
}
function _coerceRating(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(5, n)) || null;
}

// Used by POST + PUT + DELETE — keeps recipe.cook_count + last_cooked_at
// honest after every cook_diary change. cook_diary.date is YYYY-MM-DD;
// stash MAX(date) as a date-only string. The earlier composite SQL
// (date || ' ' || COALESCE(created_at, '00:00:00')) produced garbage
// because created_at is itself a full timestamp.
export function recomputeRecipeAggregates(recipeId) {
  if (!recipeId) return;
  const stats = db.prepare(
    `SELECT COUNT(*) AS n, MAX(date) AS last
       FROM cook_diary
      WHERE recipe_id = ? AND deleted_at IS NULL AND kind = 'cooked'`
  ).get(recipeId);
  db.prepare(
    `UPDATE recipes SET cook_count = ?, last_cooked_at = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(stats.n || 0, stats.last || null, recipeId);
}

export default router;
