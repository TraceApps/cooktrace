import db from '../db.js';

// ── Claim anonymous (single-user mode) data for the first real account ────
// Single-user mode has no users row, so `uid()` writes NULL for everything.
// Creating the first account has to re-point that data at it, or the new
// admin sees an empty instance (TraceApps/docs#2).
//
// recipe_categories / pantry_categories are per-user copies of the default
// set (see the seeder in db.js, which targets user_id NULL when no users
// exist), so claiming them is correct — they are not a shared catalog.
//
// Deliberately NOT claimed:
//   recipe_comments — user_id is ON DELETE SET NULL, so NULL there means
//   "written by a since-deleted account", not "anonymous". Claiming would
//   re-attribute other people's comments to the new admin. The comment's
//   created_by_username column already preserves the original display name.
//   oauth_state — short-lived OIDC CSRF state, not user data.
//   user_settings, password_reset_tokens, user_oidc_links, kitchen_members
//   — user_id is NOT NULL, so these are never anonymous.
//
// There are two ways to become the first account (password registration and
// OIDC first-login bootstrap), so this lives here rather than in either
// route and both call it.
export const CLAIM_NULL = [
  'recipes', 'pantry_items', 'cook_diary', 'shopping_list',
  'recipe_categories', 'pantry_categories', 'custom_units',
  'disabled_units', 'cookbooks', 'ai_chat_history', 'notification_log',
];

const ORPHAN_EXTRA_COUNTS = [];

export const claimAnonymousData = db.transaction((userId) => {
  for (const t of CLAIM_NULL) {
    db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id IS NULL`).run(userId);
  }
  // Re-enabling user management: clear the single_user_mode flag set by a
  // prior DELETE /management or POST /recover. Without this, /status keeps
  // reporting single_user_mode=true even though a real account now exists.
  db.prepare(`DELETE FROM app_config WHERE key = 'single_user_mode'`).run();
});

// ── One-time repair for instances that upgraded past the old bug ──────────
// The claim above only runs while the first account is being created, so an
// instance that enabled user management on an older build already has its
// single-user data stranded and will never get it back on its own.
//
// This is safe to run automatically because a NULL owner can only mean
// "written while the instance had no accounts". Deleting a user never
// produces one: the FK-bearing tables cascade the rows away, and the tables
// without an FK keep the departed user's id rather than going NULL.
//
// Guarded on there being exactly one account, which is the only situation
// where the rightful owner is unambiguous. Zero accounts is normal
// single-user mode and must be left alone; two or more means the rows
// cannot be attributed without asking a human, so they are reported and
// left in place.
export function countOrphanedRows() {
  let n = 0;
  for (const t of CLAIM_NULL) n += db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE user_id IS NULL`).get().c;
  ORPHAN_EXTRA_COUNTS.forEach(sql => { n += db.prepare(sql).get().c; });
  return n;
}

export function repairOrphanedData() {
  const users = db.prepare('SELECT id FROM users').all();
  if (users.length === 0) return { repaired: 0, rows: 0 };   // single-user mode, nothing to do
  const rows = countOrphanedRows();
  if (rows === 0) return { repaired: 0, rows: 0 };
  if (users.length > 1) return { repaired: 0, rows, ambiguous: true };
  claimAnonymousData(users[0].id);
  return { repaired: users[0].id, rows };
}

// ── Purge what the FK cascade cannot reach, on disable ────────────────────
// DELETE /management drops every account and the confirmation dialog states
// the data cannot be recovered. Most tables honour that through ON DELETE
// CASCADE, but the ones below deliberately carry no FK to users(id) (that is
// what lets the wearable pollers store their 0 sentinel), so a plain user
// delete left them behind: wearable history, and live OAuth refresh tokens
// for an account the UI said was gone.
//
// Only rows owned by a real account are removed. Genuinely anonymous rows
// (NULL, or the 0 sentinel) belong to single-user mode, which is the state
// the instance is returning to, so they stay readable.
const NO_CASCADE_TABLES = ['disabled_units', 'oauth_state'];

export const purgeUnreferencedUserData = db.transaction(() => {
  for (const t of NO_CASCADE_TABLES) {
    db.prepare(`DELETE FROM ${t} WHERE user_id IS NOT NULL AND user_id != 0`).run();
  }
});

/** Same purge, scoped to one account — for the admin "delete user" action,
 *  which otherwise leaves this user's rows (wearable history, live OAuth
 *  refresh tokens) behind because these tables have no FK to users(id). */
export const purgeUserRows = db.transaction((userId) => {
  for (const t of NO_CASCADE_TABLES) {
    db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
  }
});
