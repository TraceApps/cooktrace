import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;

// Tables scoped by user_id that have a soft-delete column. DELETE +
// live-export both filter deleted_at IS NULL so users only see rows
// they can still see in the UI.
const TABLES = ['recipes', 'pantry_items', 'cook_diary', 'shopping_list'];

// User-owned tables that also carry deleted_at (soft-delete). Same
// filter as TABLES on export; not touched by DELETE / because DELETE
// is scoped to the primary content set only (recipes / pantry /
// diary / shopping).
const TABLES_SOFT_DELETE_EXTRA = ['user_settings', 'cookbooks', 'recipe_comments'];

// User-owned tables with no deleted_at — hard-delete only. Include
// everything on export.
const TABLES_HARD = [
  'ai_chat_history',
  'recipe_categories',
  'pantry_categories',
  'custom_units',
  'disabled_units',
];

router.delete('/', wrap((req, res) => {
  const u = uid(req);
  for (const t of TABLES) {
    if (u == null) {
      db.prepare(`UPDATE ${t} SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE deleted_at IS NULL`).run();
    } else {
      db.prepare(`UPDATE ${t} SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND deleted_at IS NULL`).run(u);
    }
  }
  res.json({ ok: true });
}));

router.get('/export', wrap((req, res) => {
  const u = uid(req);
  const out = { exportedAt: new Date().toISOString() };

  // Primary user content — recipes, pantry, diary, shopping.
  for (const t of TABLES) {
    out[t] = u == null
      ? db.prepare(`SELECT * FROM ${t} WHERE deleted_at IS NULL`).all()
      : db.prepare(`SELECT * FROM ${t} WHERE user_id = ? AND deleted_at IS NULL`).all(u);
  }

  // Additional soft-delete user-owned tables: settings, cookbooks,
  // recipe comments. Same user_id + deleted_at IS NULL filter.
  for (const t of TABLES_SOFT_DELETE_EXTRA) {
    out[t] = u == null
      ? db.prepare(`SELECT * FROM ${t} WHERE deleted_at IS NULL`).all()
      : db.prepare(`SELECT * FROM ${t} WHERE user_id = ? AND deleted_at IS NULL`).all(u);
  }

  // Hard-delete user-owned tables: AI chat, categories, custom units.
  for (const t of TABLES_HARD) {
    out[t] = u == null
      ? db.prepare(`SELECT * FROM ${t}`).all()
      : db.prepare(`SELECT * FROM ${t} WHERE user_id = ?`).all(u);
  }

  // Join / relationship tables — need custom scoping because rows
  // reference the user indirectly (via a cookbook they own, a
  // sharing grant they issued or received, a kitchen they belong
  // to).
  if (u == null) {
    out.recipe_cookbook_links = db.prepare(`SELECT * FROM recipe_cookbook_links`).all();
    out.recipe_shares         = db.prepare(`SELECT * FROM recipe_shares`).all();
    out.cookbook_shares       = db.prepare(`SELECT * FROM cookbook_shares`).all();
    out.kitchens              = db.prepare(`SELECT * FROM kitchens`).all();
    out.kitchen_members       = db.prepare(`SELECT * FROM kitchen_members`).all();
  } else {
    out.recipe_cookbook_links = db.prepare(
      `SELECT * FROM recipe_cookbook_links
        WHERE cookbook_id IN (
          SELECT id FROM cookbooks WHERE user_id = ? AND deleted_at IS NULL
        )`
    ).all(u);
    // Shares in both directions so the export is symmetric — recipes
    // this user shared out AND recipes shared to them.
    out.recipe_shares = db.prepare(
      `SELECT * FROM recipe_shares WHERE granted_by = ? OR grantee_id = ?`
    ).all(u, u);
    out.cookbook_shares = db.prepare(
      `SELECT * FROM cookbook_shares WHERE granted_by = ? OR grantee_id = ?`
    ).all(u, u);
    // Kitchens the user owns OR belongs to.
    out.kitchens = db.prepare(
      `SELECT * FROM kitchens
        WHERE owner_user_id = ?
           OR id IN (SELECT kitchen_id FROM kitchen_members WHERE user_id = ?)`
    ).all(u, u);
    out.kitchen_members = db.prepare(
      `SELECT * FROM kitchen_members WHERE user_id = ?`
    ).all(u);
  }

  res.json(out);
}));

export default router;
