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
  /^\/api\/recipes\/\d+\/(comments|cooks|tools|tags)$/,
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

  // Your own profile: a name, a nickname, a picture. Nothing here decides
  // what anyone else can see, so it queues like the rest.
  if (path === '/api/auth/profile' && m === 'PUT') return { kind: 'profile', key: 'profile' };

  if (path === '/api/settings' && m === 'PUT') return { kind: 'setting', key: `setting:${body?.key}` };
  return null;
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
    byKey.set(op.key, op);
  }
  return [...byKey.values(), ...out].sort((a, b) => (a.seq || 0) - (b.seq || 0));
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
    return _withQueued(mirrored, ops, { create: 'recipe-create', update: 'recipe-update', remove: 'recipe-delete' });
  }
  const oneRecipe = path.match(/^\/api\/recipes\/(-?\d+)$/);
  if (oneRecipe && mirrored) {
    const id = Number(oneRecipe[1]);
    const edit = [...(ops || [])].reverse().find(op => op.kind === 'recipe-update' && Number(op.id) === id);
    return edit ? { ...mirrored, ...edit.body, _pending: true } : mirrored;
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
