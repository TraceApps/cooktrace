/**
 * watch-relay.js: the phone answering its watch in Local mode.
 *
 * With a server, the watch talks to it directly. In Local mode there is no
 * server, so the watch sends the same four requests to the phone over the
 * Wear connection (WearPairingPlugin), and they are answered here by the same
 * local handlers the phone's own screens use (api-native.js).
 *
 * Only what the watch asks for is answered: the shopping list, the recipe
 * being cooked, an item ticked off, and a recipe logged as cooked.
 */

/** The address a phone in Local mode gives its watch instead of a server's. */
export const PHONE_ADDRESS = 'phone:';

const SHOPPING = /^\/api\/shopping$/;
const RECIPE = /^\/api\/recipes\/(\d+)$/;
const CHECK = /^\/api\/shopping\/(\d+)\/check$/;
const COOKED = /^\/api\/cook-diary$/;

/**
 * Answer one request from the watch.
 *
 * @param {{ method?: string, path?: string, body?: string|null }} req
 * @param {{ localMode: boolean, api: object }} deps  api: CtApiNative
 * @returns {Promise<{ status: number, body: string, changed?: string[] }>}
 *   changed: the kinds of rows a write touched, for the pages on show.
 */
export async function answerWatchRequest(req, { localMode, api }) {
  const reply = (status, data) => ({ status, body: JSON.stringify(data) });
  // Switched to a server since the watch paired: it pairs again with that.
  if (!localMode) return reply(409, { error: 'The phone is connected to a server now.' });
  const method = String(req?.method || 'GET').toUpperCase();
  let path;
  try { path = new URL(String(req?.path || ''), 'http://phone').pathname; } catch { return reply(400, { error: 'Bad request' }); }
  let body = {};
  if (req?.body != null && req.body !== '') {
    try { body = JSON.parse(req.body) || {}; } catch { return reply(400, { error: 'Bad request' }); }
  }
  try {
    let m;
    if (method === 'GET' && SHOPPING.test(path)) {
      // Only what the watch reads (Kitchen.items): the answer travels over
      // the Wear connection, which is meant for small payloads.
      const list = await api.getShoppingList();
      return reply(200, list.map(({ id, name, quantity, unit, aisle, checked, recipe_name }) => ({ id, name, quantity, unit, aisle, checked, recipe_name })));
    }
    if (method === 'GET' && (m = RECIPE.exec(path))) {
      const recipe = await api.getRecipe(Number(m[1]));
      return recipe ? reply(200, recipe) : reply(404, { error: 'Not found' });
    }
    if (method === 'PATCH' && (m = CHECK.exec(path))) {
      const out = reply(200, await api.toggleShoppingChecked(Number(m[1]), !!body.checked));
      out.changed = ['shopping_list'];
      return out;
    }
    if (method === 'POST' && COOKED.test(path)) {
      // As the server asks (routes/cook-diary.js): a recipe that is here, on a real date.
      const recipeId = parseInt(body.recipe_id, 10);
      if (!Number.isFinite(recipeId)) return reply(400, { error: 'recipe_id required' });
      const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
      if (!date) return reply(400, { error: 'date (YYYY-MM-DD) required' });
      if (!(await api.getRecipe(recipeId))) return reply(404, { error: 'Recipe not found' });
      const kind = body.kind === 'cooked' ? 'cooked' : 'planned';
      const out = reply(200, await api.createDiaryEntry({ recipe_id: recipeId, date, kind }));
      out.changed = ['cook_diary', 'recipes'];
      return out;
    }
    return reply(404, { error: 'Not found' });
  } catch (e) {
    return reply(500, { error: e?.message || 'The phone could not answer' });
  }
}
