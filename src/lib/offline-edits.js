/**
 * offline-edits.js: the pure half of the browser's offline mode.
 *
 * No IndexedDB, no fetch, no Svelte. Every function here is plain data in,
 * plain data out, so it can be tested without a browser
 * (scripts/offline-edits.test.js). offline-api.js does the storage and the
 * sending, and api.js is where it meets the app.
 *
 * Every call the app makes goes through one place (`_fetch(method, path,
 * body)`), so offline work is kept as the request the app tried to make:
 *
 *   { seq, method: 'PATCH', path: '/api/shopping/12/check', body: {...}, key, kind, at }
 *
 * Going back online replays those requests against the same routes, so the
 * server does what it would have done anyway and there is no second merge
 * path to keep in step. A supermarket with no signal is the case this is
 * built for: ticking things off a list has to work.
 */

import { SYNC_FIELDS } from './sync-fields.js';

/** Was this the server being unreachable, rather than a real answer? */
export function isOfflineError(err) {
  if (!err) return false;
  if (err.offline) return true;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = String(err.message || err);
  // fetch() rejects with a TypeError when the network is gone; a request the
  // app gave up on aborts instead.
  return /Failed to fetch|NetworkError|Load failed|network|timeout|aborted|The operation was aborted/i.test(msg);
}

/** The path without its query, for matching. */
export const pathOf = (url) => String(url).split('?')[0].replace(/^https?:\/\/[^/]+/, '');
/** What a kept answer is filed under: the path and its query together. */
export const mirrorKey = (url) => String(url).replace(/^https?:\/\/[^/]+/, '');

// Reads worth keeping a copy of: everything a screen needs to open in a
// kitchen or a shop. Anything else still asks the server and says so when it
// can't be reached.
export const MIRRORED_GETS = [
  /^\/api\/recipes$/,
  /^\/api\/recipes\/\d+$/,
  /^\/api\/recipes\/\d+\/(comments|cooks|tools|tags|versions)$/,
  /^\/api\/recipes\/categories$/,
  /^\/api\/cookbooks$/,
  /^\/api\/cookbooks\/\d+$/,
  /^\/api\/pantry$/,
  /^\/api\/pantry\/categories$/,
  /^\/api\/pantry\/\d+$/,
  /^\/api\/shopping$/,
  /^\/api\/cook-diary(\/|$)/,
  /^\/api\/units$/,
  /^\/api\/settings$/,
  /^\/api\/tags$/,
  /^\/api\/tools$/,
  // Who is signed in. Without these the app reads an unreachable server as
  // "nobody is signed in" and starts forgetting what depends on it.
  /^\/api\/auth\/(me|status)$/,
];

export const isMirroredGet = (url) => MIRRORED_GETS.some(re => re.test(pathOf(url)));

/**
 * The work this layer takes on without a connection, and how to collapse it.
 *
 * Deliberately NOT here: sharing a recipe or a cookbook, kitchens and their
 * members, imports, uploads, AI and anything admin. Sharing decides who can
 * see your food; doing that against a list pulled down hours ago is how
 * someone keeps access they should have lost.
 */
export function writeOp(method, url, body) {
  const path = pathOf(url);
  const m = (method || 'GET').toUpperCase();
  let match;

  // ── The shopping list: the reason this exists ─────────────────────
  if (path === '/api/shopping' && m === 'POST') return { kind: 'shopping-create', key: null };
  match = path.match(/^\/api\/shopping\/(-?\d+)$/);
  if (match && (m === 'PUT' || m === 'DELETE')) {
    return { kind: m === 'PUT' ? 'shopping-update' : 'shopping-delete', key: `shopping:${match[1]}`, id: Number(match[1]) };
  }
  match = path.match(/^\/api\/shopping\/(-?\d+)\/check$/);
  if (match && m === 'PATCH') return { kind: 'shopping-check', key: `shopping-check:${match[1]}`, id: Number(match[1]) };
  if (path === '/api/shopping/checked' && m === 'DELETE') return { kind: 'shopping-clear', key: 'shopping:clear-checked' };
  if (path === '/api/shopping/reorder' && m === 'POST') return { kind: 'shopping-reorder', key: 'shopping:order' };

  // ── The pantry: counted and ticked in the kitchen ─────────────────
  if (path === '/api/pantry' && m === 'POST') return { kind: 'pantry-create', key: null };
  match = path.match(/^\/api\/pantry\/(-?\d+)$/);
  if (match && (m === 'PUT' || m === 'DELETE')) {
    return { kind: m === 'PUT' ? 'pantry-update' : 'pantry-delete', key: `pantry:${match[1]}`, id: Number(match[1]) };
  }
  match = path.match(/^\/api\/pantry\/(-?\d+)\/stock$/);
  if (match && m === 'PATCH') return { kind: 'pantry-stock', key: `pantry-stock:${match[1]}`, id: Number(match[1]) };

  // ── What you cooked ───────────────────────────────────────────────
  // "I cooked this" from a recipe, and the diary's own entries, are the same
  // thing arriving by two doors.
  match = path.match(/^\/api\/recipes\/(-?\d+)\/cooked$/);
  if (match && m === 'POST') return { kind: 'diary-create', key: null };
  match = path.match(/^\/api\/recipes\/(-?\d+)\/cooks\/(-?\d+)$/);
  if (match && (m === 'PUT' || m === 'DELETE')) {
    return { kind: m === 'PUT' ? 'diary-update' : 'diary-delete', key: `diary:${match[2]}`, id: Number(match[2]) };
  }
  if (path === '/api/cook-diary' && m === 'POST') return { kind: 'diary-create', key: null };
  match = path.match(/^\/api\/cook-diary\/(-?\d+)$/);
  if (match && (m === 'PUT' || m === 'DELETE')) {
    return { kind: m === 'PUT' ? 'diary-update' : 'diary-delete', key: `diary:${match[1]}`, id: Number(match[1]) };
  }

  // ── Recipes, and the notes people leave on them ───────────────────
  if (path === '/api/recipes' && m === 'POST') return { kind: 'recipe-create', key: null };
  match = path.match(/^\/api\/recipes\/(-?\d+)$/);
  if (match && (m === 'PUT' || m === 'DELETE')) {
    return { kind: m === 'PUT' ? 'recipe-update' : 'recipe-delete', key: `recipe:${match[1]}`, id: Number(match[1]) };
  }
  match = path.match(/^\/api\/recipes\/(-?\d+)\/comments$/);
  if (match && m === 'POST') return { kind: 'comment-create', key: null };
  // A recipe's allergen correction ({ allergen_overrides }): the latest wins.
  match = path.match(/^\/api\/recipes\/(-?\d+)\/allergens$/);
  if (match && m === 'PUT') return { kind: 'recipe-allergens', key: `recipe-allergens:${match[1]}`, id: Number(match[1]) };

  // Your own profile: a name, a nickname, a picture. Nothing here decides
  // what anyone else can see, so it queues like the rest.
  if (path === '/api/auth/profile' && m === 'PUT') return { kind: 'profile', key: 'profile' };

  if (path === '/api/settings' && m === 'PUT') return { kind: 'setting', key: `setting:${body?.key}` };
  return null;
}

// The fields of a recipe a save may change, as the server compares two
// copies (server/lib/recipe-versions.js VERSION_FIELDS and META_FIELDS).
const RECIPE_FIELDS = [
  'name', 'description', 'ingredients', 'steps', 'tags', 'tools', 'notes',
  'servings', 'prep_minutes', 'cook_minutes', 'total_minutes', 'rest_minutes',
  'nutrition', 'category_id', 'img_url', 'source_url', 'video_url', 'yield_text',
  'rating', 'favorite', 'visibility', 'allergen_overrides',
];
const FIELDS = { ...SYNC_FIELDS, recipes: RECIPE_FIELDS };

/**
 * The copy of a recipe a page shows, as a save made on it describes it:
 * the server's stamp of that copy and its fields, the picture as a save
 * sends it. Pages pass it with a save as `_base`.
 */
export function recipeBaseOf(recipe) {
  if (!recipe || typeof recipe !== 'object') return null;
  const out = { synced_at: typeof recipe.synced_at === 'string' ? recipe.synced_at : null };
  for (const f of RECIPE_FIELDS) out[f] = recipe[f] ?? null;
  out.img_url = recipe.imgUrl || recipe.img_url || null;
  return out;
}

// A field's value as two copies on a page compare: the same value written
// another way is the same.
function _norm(v) {
  if (v === undefined || v === '' || v === false) v = v === false ? 0 : null;
  if (v === true) v = 1;
  if (Array.isArray(v) && v.length === 0) v = null;
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) v = null;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) v = Number(v);
  return v;
}
function _stable(v) {
  v = _norm(v);
  if (Array.isArray(v)) return `[${v.map(_stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${_stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
// Ingredients grouped or as the older flat list: the same ingredients.
function _groups(v) {
  if (!Array.isArray(v) || !v.length) return v;
  if (v.every(g => g && typeof g === 'object' && !Array.isArray(g.items))) return [{ name: '', items: v }];
  return v.map(g => ({ name: g?.name || '', items: Array.isArray(g?.items) ? g.items : [] }));
}
const _val = (o, f) => {
  const v = f === 'img_url' ? (o?.imgUrl ?? o?.img_url) : o?.[f];
  return f === 'ingredients' ? _groups(v) : v;
};

/** The fields a save changes on its page's copy (only those it sends). */
export function changedFields(table, body, base) {
  return (FIELDS[table] || []).filter(f => f !== 'deleted_at' && _val(body, f) !== undefined && _stable(_val(body, f)) !== _stable(_val(base, f)));
}
export const recipeChangedFields = (body, base) => changedFields('recipes', body, base);

/**
 * Which row a save is to, by its address: { table, id }, or null for a
 * request that isn't one.
 */
export function saveTarget(method, url) {
  const m = (method || '').toUpperCase();
  const path = pathOf(url);
  const rules = [
    ['PUT', /^\/api\/recipes\/categories\/(\d+)$/, 'recipe_categories'],
    ['PUT', /^\/api\/recipes\/\d+\/cooks\/(\d+)$/, 'cook_diary'],
    ['PUT', /^\/api\/recipes\/\d+\/comments\/(\d+)$/, 'recipe_comments'],
    ['PUT', /^\/api\/recipes\/(\d+)$/, 'recipes'],
    ['PUT', /^\/api\/pantry\/categories\/(\d+)$/, 'pantry_categories'],
    ['PUT', /^\/api\/pantry\/(\d+)$/, 'pantry_items'],
    ['PATCH', /^\/api\/pantry\/(\d+)\/stock$/, 'pantry_items'],
    ['PUT', /^\/api\/shopping\/(\d+)$/, 'shopping_list'],
    ['PATCH', /^\/api\/shopping\/(\d+)\/check$/, 'shopping_list'],
    ['PUT', /^\/api\/cook-diary\/(\d+)$/, 'cook_diary'],
    ['PUT', /^\/api\/cookbooks\/(\d+)$/, 'cookbooks'],
    ['PUT', /^\/api\/units\/(\d+)$/, 'custom_units'],
  ];
  for (const [rm, re, table] of rules) {
    const hit = m === rm && path.match(re);
    if (hit) return { table, id: Number(hit[1]), toggle: rm === 'PATCH' };
  }
  return null;
}

/** Which table the rows of a read belong to, by its address. */
export function readTable(url) {
  const path = pathOf(url);
  if (/^\/api\/recipes\/categories$/.test(path)) return 'recipe_categories';
  if (/^\/api\/recipes\/\d+\/cooks$/.test(path)) return 'cook_diary';
  if (/^\/api\/recipes\/\d+\/comments$/.test(path)) return 'recipe_comments';
  if (/^\/api\/recipes(\/\d+)?$/.test(path)) return 'recipes';
  if (/^\/api\/pantry\/categories$/.test(path)) return 'pantry_categories';
  if (/^\/api\/pantry(\/\d+)?$/.test(path)) return 'pantry_items';
  if (/^\/api\/shopping$/.test(path)) return 'shopping_list';
  if (/^\/api\/cook-diary(\/|$)/.test(path)) return 'cook_diary';
  if (/^\/api\/cookbooks(\/\d+)?$/.test(path)) return 'cookbooks';
  if (/^\/api\/units$/.test(path)) return 'custom_units';
  return null;
}

/** The rows in an answer that carry the server's stamp: its own, a list, or `items` / `custom`. */
export function stampedRows(answer) {
  const out = [];
  const take = r => { if (r && typeof r === 'object' && r.id != null && typeof r.synced_at === 'string') out.push(r); };
  if (Array.isArray(answer)) answer.forEach(take);
  else if (answer && typeof answer === 'object') {
    take(answer);
    for (const k of ['items', 'custom', 'entries']) if (Array.isArray(answer[k])) answer[k].forEach(take);
  }
  return out;
}

/**
 * What a save says about the copy it was made on, for the server to keep
 * the newer of two edits (and, for a recipe, the other as an earlier
 * version) and to leave alone what the save didn't change: the server's
 * stamp of the page's copy, and the fields the save changes. The page's
 * copy is `_base`, or the row this browser showed with the stamp the body
 * carries (seen(table, id, stamp)); a toggle (PATCH) changes the fields it
 * sends. Null when the save can't say (sent as before).
 */
export function saveBase(method, url, body, seen, editedAt) {
  const t = saveTarget(method, url);
  if (!t || !body || typeof body !== 'object') return null;
  if (t.toggle) {
    const changed = Object.keys(body).filter(f => !f.startsWith('_') && (FIELDS[t.table] || []).includes(f));
    return { base_synced_at: null, changed, edited_at: editedAt };
  }
  const fields = FIELDS[t.table] || [];
  const page = body._base && typeof body._base === 'object' ? body._base : null;
  const stamp = page?.synced_at ?? body.synced_at;
  const said = Array.isArray(body._changed) ? body._changed.filter(f => fields.includes(f)) : null;
  if (typeof stamp !== 'string' || !stamp) {
    // No copy's stamp: a save of a few fields (not a whole row) changes the
    // fields it sends, or what it says; one with a page's copy but no stamp
    // changes what differs from it. Otherwise it can't say.
    const sent = Object.keys(body).filter(f => !f.startsWith('_') && fields.includes(f));
    if (said) return { base_synced_at: null, changed: said, edited_at: editedAt };
    if (page) return { base_synced_at: null, changed: changedFields(t.table, body, page), edited_at: editedAt };
    if (body.id == null && sent.length) return { base_synced_at: null, changed: sent, edited_at: editedAt };
    return null;
  }
  const copy = page || (typeof seen === 'function' ? seen(t.table, t.id, stamp) : null);
  let changed = null;
  if (said) changed = said;
  else if (copy) changed = changedFields(t.table, body, copy);
  return { base_synced_at: stamp, changed, edited_at: editedAt };
}

/** A recipe save's base, the kept copy standing in when it is the same copy. */
export function recipeSaveBase(body, kept, editedAt) {
  return saveBase('PUT', `/api/recipes/${body?.id ?? 0}`, body,
    (table, id, stamp) => (kept && typeof kept === 'object' && kept.synced_at === stamp ? recipeBaseOf(kept) : null), editedAt);
}

/** A save's body with what it says about its copy, and this device's time. */
export function withSaveBase(body, sync, now = new Date().toISOString()) {
  if (!body || typeof body !== 'object') return body;
  const { _sync, _base, _changed, ...rest } = body;
  return sync ? { ...rest, _sync: { ...sync, client_now: now } } : rest;
}

/** Creates that make a row, so they need a temporary id to hold on to. */
export const MAKES_A_ROW = ['shopping-create', 'pantry-create', 'diary-create', 'recipe-create', 'comment-create'];

/**
 * One request per thing, newest state winning. Something created and then
 * deleted before the connection returns never goes up at all, and a create
 * followed by edits goes up as a single create with the latest values.
 */
export function collapseOps(ops) {
  const byKey = new Map();
  const out = [];

  for (const op of ops || []) {
    if (!op) continue;
    if (!op.key) { out.push(op); continue; }
    const prev = byKey.get(op.key);
    if (prev && MAKES_A_ROW.includes(prev.kind)) {
      if (String(op.kind).endsWith('-delete')) { byKey.delete(op.key); continue; }
      if (String(op.kind).endsWith('-update')) {
        byKey.set(op.key, { ...prev, body: { ...prev.body, ...op.body }, seq: op.seq });
        continue;
      }
    }
    // Two saves of one recipe go up as one, the latest body: it says the
    // first one's copy, and every field either changed, or the second
    // save's copy (which already showed the first) would hide the first.
    byKey.set(op.key, prev?.sync && op.sync ? { ...op, sync: combineSaveBases(prev.sync, op.sync) } : op);
  }
  return [...byKey.values(), ...out].sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

/** Two saves of one recipe as one: the first copy, every field changed. */
export function combineSaveBases(first, second) {
  const changed = Array.isArray(first.changed) && Array.isArray(second.changed)
    ? [...new Set([...first.changed, ...second.changed])] : null;
  return { ...second, base_synced_at: first.base_synced_at ?? second.base_synced_at, changed };
}

/**
 * Which queued requests a replay accounted for: the ones whose key went up
 * successfully, plus any that cancelled each other out and were never sent.
 */
export function sentSeqs(ops, doneKeys) {
  const done = new Set(doneKeys || []);
  const queued = new Set(collapseOps(ops).map(op => op.key).filter(Boolean));
  return (ops || [])
    .filter(op => !op.key || done.has(op.key) || !queued.has(op.key))
    .map(op => op.seq);
}

// ── What the screens see while work is waiting ──────────────────────

const _list = (mirrored) => (Array.isArray(mirrored) ? mirrored : mirrored === undefined ? [] : null);

/** Apply queued creates, edits and deletions to a list that was kept. */
function _withQueued(mirrored, ops, { create, update, remove, patches = [] }) {
  const made = (ops || []).filter(op => op.kind === create);
  const changed = new Map((ops || []).filter(op => op.kind === update).map(op => [Number(op.id), op.body]));
  for (const kind of patches) {
    for (const op of (ops || []).filter(o => o.kind === kind)) {
      changed.set(Number(op.id), { ...(changed.get(Number(op.id)) || {}), ...op.body });
    }
  }
  const gone = new Set((ops || []).filter(op => op.kind === remove).map(op => Number(op.id)));
  if (!made.length && !changed.size && !gone.size) return mirrored;
  const base = _list(mirrored);
  if (base === null) return mirrored;
  return base
    .filter(r => !gone.has(Number(r.id)))
    .map(r => (changed.has(Number(r.id)) ? { ...r, ...changed.get(Number(r.id)), _pending: true } : r))
    .concat(made.map(op => ({ ...op.body, id: op.tempId, _pending: true })));
}

/**
 * The kept answer with queued work applied, so a list ticked off in a shop
 * shows what you ticked rather than what the server last knew.
 */
export function answerWithOps(url, mirrored, ops) {
  const path = pathOf(url);

  if (path === '/api/shopping') {
    const cleared = (ops || []).some(op => op.kind === 'shopping-clear');
    const shown = _withQueued(mirrored, ops, {
      create: 'shopping-create', update: 'shopping-update', remove: 'shopping-delete',
      patches: ['shopping-check'],
    });
    if (!cleared || !Array.isArray(shown)) return shown;
    // "Clear checked" empties the trolley of everything already ticked.
    return shown.filter(r => !r.checked);
  }
  if (path === '/api/pantry') {
    return _withQueued(mirrored, ops, {
      create: 'pantry-create', update: 'pantry-update', remove: 'pantry-delete',
      patches: ['pantry-stock'],
    });
  }
  if (path === '/api/cook-diary') {
    return _withQueued(mirrored, ops, { create: 'diary-create', update: 'diary-update', remove: 'diary-delete' });
  }
  if (path === '/api/recipes') {
    return _withQueued(mirrored, ops, { create: 'recipe-create', update: 'recipe-update', remove: 'recipe-delete', patches: ['recipe-allergens'] });
  }
  const oneRecipe = path.match(/^\/api\/recipes\/(-?\d+)$/);
  if (oneRecipe && mirrored) {
    const id = Number(oneRecipe[1]);
    const edit = [...(ops || [])].reverse().find(op => op.kind === 'recipe-update' && Number(op.id) === id);
    const fix = [...(ops || [])].reverse().find(op => op.kind === 'recipe-allergens' && Number(op.id) === id);
    if (!edit && !fix) return mirrored;
    return { ...mirrored, ...(edit?.body || {}), ...(fix?.body || {}), _pending: true };
  }
  const comments = path.match(/^\/api\/recipes\/(-?\d+)\/comments$/);
  if (comments) {
    const made = (ops || []).filter(op => op.kind === 'comment-create' && op.path === path);
    if (!made.length) return mirrored;
    const base = _list(mirrored);
    if (base === null) return mirrored;
    return base.concat(made.map(op => ({ ...op.body, id: op.tempId, _pending: true })));
  }
  if (path === '/api/settings') {
    const queued = (ops || []).filter(op => op.kind === 'setting');
    if (!queued.length) return mirrored;
    const settings = { ...(mirrored || {}) };
    for (const op of queued) if (op.body?.key) settings[op.body.key] = op.body.value;
    return settings;
  }
  return mirrored;
}

/**
 * The answer a queued write hands back, shaped like the route's own.
 *
 * The screens read these, so the shape matters as much as the status. A
 * cook logged from a recipe answers with the RECIPE, for instance, because
 * that screen puts the answer straight back into what it is showing.
 */
export function queuedReply(op, body, tempId, { recipe } = {}) {
  const now = new Date().toISOString();
  const queued = { queued: true, offline: true };
  switch (op?.kind) {
    case 'diary-create':
      // From a recipe ("I cooked this") the route answers with the recipe;
      // from the diary it answers with the entry.
      if (/\/api\/recipes\/-?\d+\/cooked$/.test(String(op.path || ''))) {
        return recipe
          ? { ...recipe, last_cooked_at: body?.date || now, cook_count: (recipe.cook_count || 0) + 1, ...queued }
          : { ...(body || {}), id: tempId, ...queued };
      }
      return { ...(body || {}), id: tempId, created_at: now, ...queued };
    case 'profile':
      return { user: { ...(body || {}) }, ...queued };
    case 'shopping-create':
    case 'pantry-create':
    case 'recipe-create':
    case 'comment-create':
      return { ...(body || {}), id: tempId, created_at: now, updated_at: now, ...queued };
    case 'shopping-update':
    case 'shopping-check':
    case 'pantry-update':
    case 'pantry-stock':
    case 'diary-update':
    case 'recipe-update':
    case 'recipe-allergens':
      return { ...(body || {}), id: op.id, updated_at: now, ...queued };
    default:
      return { ok: true, ...(body || {}), ...queued };
  }
}

/**
 * Which kept answers to let go of, oldest first, once there are more than
 * `keep`. The copy this browser holds has to have a ceiling: a database with
 * no room left would refuse the outbox too, and then nothing could be
 * changed offline at all, which is the one thing that must not happen.
 */
export function staleAnswerKeys(rows, keep) {
  const held = (rows || []).filter(r => r && r.key != null);
  if (held.length <= keep) return [];
  return held
    .slice()
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .slice(0, held.length - keep)
    .map(r => r.key);
}

/**
 * A queued change in a few words, for telling someone their server refused
 * it. Never the raw path: "PATCH /api/shopping/12/check" means nothing to
 * the person who ticked it off in a shop.
 */
export function describeOp(op) {
  const named = op?.body?.name ? ` "${op.body.name}"` : '';
  switch (op?.kind) {
    case 'shopping-create':  return `the${named || ' item'} you added to your shopping list`;
    case 'shopping-update':  return 'a shopping list item you changed';
    case 'shopping-delete':  return 'a shopping list item you removed';
    case 'shopping-check':   return 'an item you ticked off';
    case 'shopping-clear':   return 'clearing what you had ticked off';
    case 'shopping-reorder': return 'the order of your shopping list';
    case 'pantry-create':    return `the${named || ' item'} you added to your pantry`;
    case 'pantry-update':    return 'a pantry item you changed';
    case 'pantry-delete':    return 'a pantry item you removed';
    case 'pantry-stock':     return 'a pantry item you marked in or out of stock';
    case 'diary-create':     return 'the cook you logged';
    case 'diary-update':     return 'a cook you changed';
    case 'diary-delete':     return 'a cook you removed';
    case 'recipe-create':    return `the recipe${named} you wrote`;
    case 'recipe-update':    return 'a recipe you changed';
    case 'recipe-delete':    return 'a recipe you deleted';
    case 'recipe-allergens': return 'the allergens you corrected on a recipe';
    case 'comment-create':   return 'the note you left on a recipe';
    case 'profile':          return 'your profile';
    case 'setting':          return `the "${op.body?.key || 'setting'}" setting`;
    default:                 return 'a change you made';
  }
}

/**
 * Will trying again ever help? A server that is struggling (5xx), busy (429)
 * or slow (408) deserves another go. So does a session that has expired or
 * lost its footing (401, 403): signing in again fixes that, and throwing the
 * work away because a cookie timed out would be inexcusable. Everything else
 * is the server's considered answer, and repeating it changes nothing.
 */
export const shouldRetryStatus = (status) =>
  !status || status >= 500 || status === 408 || status === 429 || status === 401 || status === 403;

// ── Rows made with no connection ────────────────────────────────────

let _tempSeq = 0;
/** An id that cannot be mistaken for one the server gave out. */
export const newTempId = () => -(Date.now() * 1000 + (++_tempSeq % 1000));
export const isTempId = (id) => Number(id) < 0;

/** The real id a replayed create came back with. */
export function createdId(response) {
  const id = response?.id ?? response?.item?.id ?? response?.recipe?.id ?? response?.entry?.id;
  return id != null && Number(id) > 0 ? Number(id) : null;
}

/** Point everything at the real ids once the server has given them out. */
export function remapIds(value, map) {
  if (!map || !Object.keys(map).length) return value;
  const swap = (id) => (map[Number(id)] != null ? map[Number(id)] : id);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = { ...v };
      for (const key of ['id', 'recipe_id', 'pantry_id', 'parent_id', 'cookbook_id']) {
        if (out[key] != null && isTempId(out[key])) out[key] = swap(out[key]);
      }
      for (const [k, val] of Object.entries(out)) {
        if (val && typeof val === 'object') out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

/** A path that still names a temporary id, pointed at the real one. */
export function remapPath(path, map) {
  return String(path).replace(/\/(-\d+)(\b|$)/, (all, id) => {
    const real = map?.[Number(id)];
    return real != null ? `/${real}` : all;
  });
}
