// Auto-share fan-out helper. Called after every code path that
// INSERTs a recipe (manual REST create, URL scrape, ZIP import, paste
// import, native-app sync push). If the recipe's owner has auto_share=1
// for any Kitchen they belong to, fan out per-user grants into
// recipe_shares for every other member of that Kitchen.
//
// Extracted here so recipes.js AND sync.js can both call it — the
// original in-file helper in recipes.js was skipped by the /sync/push
// path, which is how Android-native recipe creations silently fell out
// of auto-share and members stopped seeing each other's libraries.
//
// Idempotent via UNIQUE(recipe_id, grantee_id). Safe to call multiple
// times for the same recipe with no side-effects.
import db from '../db.js';

export function autoShareNewRecipe(userId, recipeId) {
  if (userId == null || !Number.isFinite(recipeId)) return;
  const kitchens = db.prepare(
    `SELECT kitchen_id FROM kitchen_members WHERE user_id = ? AND auto_share = 1`
  ).all(userId);
  if (kitchens.length === 0) return;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO recipe_shares (recipe_id, grantee_id, granted_by, via_kitchen_id)
     VALUES (?, ?, ?, ?)`
  );
  let grants = 0, added = 0;
  for (const k of kitchens) {
    const members = db.prepare(
      `SELECT user_id FROM kitchen_members WHERE kitchen_id = ? AND user_id != ?`
    ).all(k.kitchen_id, userId);
    for (const m of members) {
      grants++;
      const res = ins.run(recipeId, m.user_id, userId, k.kitchen_id);
      if (res.changes > 0) added++;
    }
  }
  if (grants > 0) {
    console.info(`[auto-share] recipe=${recipeId} user=${userId} kitchens=${kitchens.length} grants=${grants} inserted=${added}`);
  }
}
