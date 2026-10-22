/**
 * share.js — public-read endpoint for shared recipes.
 *
 * Mounted BEFORE the auth/setup-required gates so a recipient who
 * doesn't have a CookTrace account can view a recipe via its share
 * link. The token is the only authorization needed.
 */
import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';

const router = Router();

/**
 * The recipe behind a public token, projected to a clean read-only view
 * (no user_id, visibility, or anything else that could leak account
 * details). Null when the token is unknown or removed, or the recipe was
 * deleted. Also used for the link-preview tags on /r/<token>.
 */
export function getPublicRecipe(token) {
  token = String(token || '').trim();
  if (!token || token.length < 8 || token.length > 64) return null;
  // Lookup is index-backed (idx_recipes_share_token).
  const row = db.prepare(
    `SELECT r.*, rc.name AS category_name, rc.slug AS category_slug, rc.color AS category_color,
            u.full_name AS created_by_full_name
       FROM recipes r
       LEFT JOIN recipe_categories rc ON rc.id = r.category_id
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.share_token = ? AND r.deleted_at IS NULL`
  ).get(token);
  if (!row) return null;

  const _safeJson = (s, fallback) => {
    if (!s) return fallback;
    try { return JSON.parse(s); } catch { return fallback; }
  };
  const ingredients = _safeJson(row.ingredients, []);
  const steps = _safeJson(row.steps, []);
  const tags = _safeJson(row.tags, []);
  const tools = _safeJson(row.tools, []);
  const nutrition = _safeJson(row.nutrition, {});
  const flatIngredients = (() => {
    if (!Array.isArray(ingredients)) return [];
    if (ingredients.length === 0) return [];
    if (ingredients[0] && Array.isArray(ingredients[0].items)) {
      return ingredients.map(g => ({ name: g.name || '', items: g.items || [] }));
    }
    return [{ name: '', items: ingredients }];
  })();

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    img_url: row.img_url,
    servings: row.servings,
    yield_text: row.yield_text,
    prep_minutes: row.prep_minutes,
    cook_minutes: row.cook_minutes,
    rating: row.rating,
    ingredients: flatIngredients,
    steps,
    tags,
    tools,
    nutrition,
    source_url: row.source_url,
    notes: row.notes,
    created_by_username:  row.created_by_username,
    created_by_full_name: row.created_by_full_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_cooked_at: row.last_cooked_at,
    cook_count: row.cook_count,
    category: row.category_name ? {
      name: row.category_name, slug: row.category_slug, color: row.category_color,
    } : null,
  };
}

router.get('/:token', wrap((req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  const token = String(req.params.token || '').trim();
  if (!token || token.length < 8 || token.length > 64) {
    return res.status(400).json({ error: 'Invalid token' });
  }
  const recipe = getPublicRecipe(token);
  if (!recipe) return res.status(404).json({ error: 'Not found' });
  res.json(recipe);
}));

export default router;
