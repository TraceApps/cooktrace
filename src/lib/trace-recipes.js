/**
 * Trace's recipe reads: get_recipes (a page of the library, found by name,
 * description, tag or ingredient) and read_recipes (several recipes in
 * full). Going through a whole library takes pages and batches, not one
 * recipe a call (TraceApps/notetrace#34).
 */
import { foldText } from './search-text.js';
import { cardAllergens } from './allergens.js';

export const RECIPE_PAGE_MAX = 100;
export const READ_MAX_RECIPES = 25;
// One read_recipes answer, measured as the JSON the model gets.
const READ_BUDGET = 16000;

export function summariseRecipe(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description || null,
    servings: r.servings,
    prep_minutes: r.prep_minutes,
    cook_minutes: r.cook_minutes,
    rest_minutes: r.rest_minutes,
    total_minutes: r.total_minutes != null ? r.total_minutes : (r.prep_minutes || 0) + (r.cook_minutes || 0) + (r.rest_minutes || 0),
    rating: r.rating,
    favorite: !!r.favorite,
    last_cooked_at: r.last_cooked_at,
    cook_count: r.cook_count,
    category: r.category?.name || null,
    tags: r.tags || [],
    pantry_match: r.pantry_match || null,
    // The same shape on every path: the list carries them, a full read works them out.
    allergens: cardAllergens(r),
  };
}

export function fullRecipe(r) {
  return {
    ...summariseRecipe(r),
    yield_text: r.yield_text,
    ingredients: r.ingredients || [],
    steps: r.steps || [],
    tools: r.tools || [],
    source_url: r.source_url,
    notes: r.notes,
    nutrition: r.nutrition || null,
  };
}

// Every ingredient line of a recipe as it reads: grouped, flat or plain text.
function _ingredientLines(r) {
  const line = (i) => {
    if (typeof i === 'string') return i;
    if (!i || typeof i !== 'object') return '';
    const text = [i.qty, i.unit, i.name].filter((x) => x != null && String(x).trim()).join(' ');
    return i.note ? `${text} (${i.note})` : text;
  };
  return (Array.isArray(r.ingredients) ? r.ingredients : [])
    .flatMap((g) => (g && Array.isArray(g.items) ? g.items : [g]))
    .map(line)
    .filter(Boolean);
}

/**
 * One page of get_recipes. Name then id, so the same library always comes
 * in the same order and pages never skip or repeat a recipe.
 */
export function listRecipes(all, args = {}) {
  const q = foldText(args.query).trim();
  const cat = foldText(args.category).trim();
  let found = (all || []).map((r) => ({ r, matched: null }));
  if (q) {
    found = found
      .map(({ r }) => {
        const own = foldText(r.name).includes(q) || foldText(r.description).includes(q) || (r.tags || []).some((t) => foldText(t).includes(q));
        const matched = _ingredientLines(r).filter((l) => foldText(l).includes(q));
        return { r, own, matched: own || !matched.length ? null : matched.slice(0, 5), hit: own || matched.length > 0 };
      })
      .filter((x) => x.hit);
  }
  if (cat) found = found.filter(({ r }) => foldText(r.category?.name) === cat || foldText(r.category?.slug) === cat);
  if (args.favorite) found = found.filter(({ r }) => !!r.favorite);
  // A recipe that matched by its name, description or tags comes before one
  // that only uses the ingredient, so a name lookup isn't buried; then name,
  // then id, so the same library always comes in the same order.
  found.sort((a, b) => (q ? Number(!a.own) - Number(!b.own) : 0) || String(a.r.name || '').localeCompare(String(b.r.name || ''), undefined, { sensitivity: 'base' }) || (Number(a.r.id) || 0) - (Number(b.r.id) || 0));
  const limit = Math.min(RECIPE_PAGE_MAX, Math.max(1, Number(args.limit) || RECIPE_PAGE_MAX));
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const page = found.slice(offset, offset + limit);
  const next = offset + page.length < found.length ? offset + page.length : null;
  return {
    count: found.length,
    offset,
    returned: page.length,
    next_offset: next,
    complete: next == null,
    // Said in words too: a model that skims the numbers still sees there's more.
    ...(next != null ? { more: `This is recipes ${offset + 1} to ${offset + page.length} of ${found.length}: call get_recipes again with offset ${next} for the rest.` } : {}),
    recipes: page.map(({ r, matched }) => ({ ...summariseRecipe(r), ...(matched ? { matched_ingredients: matched } : {}) })),
  };
}

/** read_recipes: several recipes in full, within what one answer holds. */
export async function readRecipes(rawIds, getRecipe) {
  const ids = [...new Set((Array.isArray(rawIds) ? rawIds : []).map(Number).filter(Number.isFinite))];
  if (!ids.length) return { error: 'ids is required: recipe ids, from get_recipes.' };
  const recipes = [], notRead = [], notFound = [], failed = [];
  let budget = READ_BUDGET;
  for (const id of ids.slice(0, READ_MAX_RECIPES)) {
    if (notRead.length) { notRead.push(id); continue; }
    // A recipe that's gone is just not found, never the whole batch. Any
    // other failure (offline, the server down) says so: it may well be there.
    let r;
    try { r = await getRecipe(id); } catch (e) {
      if (e?.status === 404) r = null;
      else { failed.push({ id, error: String(e?.message || e) }); continue; }
    }
    if (!r) { notFound.push(id); continue; }
    const full = fullRecipe(r);
    const size = JSON.stringify(full).length;
    if (size <= budget) { recipes.push(full); budget -= size; continue; }
    // Doesn't fit what's left: the next call reads it. One too big for any
    // call on its own says so.
    if (recipes.length) notRead.push(id);
    else recipes.push({ id: full.id, name: full.name, too_long: 'Too long to read along with others: read it with get_recipe.' });
  }
  notRead.push(...ids.slice(READ_MAX_RECIPES));
  return {
    recipes,
    ...(notRead.length ? { not_read: notRead, more: 'Over what one call holds: read these with another read_recipes call.' } : {}),
    ...(notFound.length ? { not_found: notFound } : {}),
    ...(failed.length ? { failed } : {}),
  };
}
