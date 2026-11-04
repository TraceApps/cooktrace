/**
 * sync-refresh.js: what a sync changed on this phone, and a page asking to
 * hear of it (Android, server mode).
 *
 * A page reads its lists from the phone's database when it opens, and again
 * only when told. A sync that brings a row in, changes one or takes one
 * away (a recipe deleted on the web) changes the database under a page that
 * is open, so sync.js ends every sync with 'ct:sync-complete' and says which
 * kinds of rows it touched (detail.kinds: the names of the tables, and
 * 'settings'). A page calls onSyncChanges with the kinds it shows and reads
 * its data again when one of them is touched. A sync that touched nothing
 * says nothing.
 */

// Sent whole with every pull: only a change the phone really made to them
// (db-native.js dbApplyPull) counts, so they are not read from the pull.
export const REPLACE_SETS = ['disabled_units', 'recipe_cookbook_links'];

// Rows a server-side delete changes on the phone besides the deleted ones:
// a deleted category lets go of the recipes and pantry items in it.
const LET_GO = { recipe_categories: 'recipes', pantry_categories: 'pantry_items' };

/**
 * The kinds a pull brought: `tables` is the server's answer to
 * /api/sync/pull (body.tables). Deleted rows travel in the same lists as the
 * rest (deleted_at), and rows removed outright under `deletions`, so a
 * delete counts like any other change.
 */
export function pullKinds(tables) {
  const kinds = new Set();
  for (const [name, rows] of Object.entries(tables || {})) {
    if (name === 'deletions') {
      for (const [table, ids] of Object.entries(rows || {})) {
        if (!Array.isArray(ids) || !ids.length) continue;
        kinds.add(table);
        if (LET_GO[table]) kinds.add(LET_GO[table]);
      }
    } else if (Array.isArray(rows) && rows.length && !REPLACE_SETS.includes(name)) {
      kinds.add(name);
    }
  }
  return [...kinds];
}

/**
 * Whether a 'ct:sync-complete' event touched any of `kinds` (any at all when
 * none are given). An event that doesn't say what it touched (an older one)
 * counts when it brought rows.
 */
export function syncTouched(detail, kinds) {
  if (!detail) return false;
  if (Array.isArray(detail.kinds)) {
    if (!detail.kinds.length) return false;
    return !kinds || kinds.some(k => detail.kinds.includes(k));
  }
  return !!detail.ok && Number(detail.changed) > 0;
}

/**
 * Calls `fn(detail)` after a sync that touched any of `kinds`. Returns the
 * function that stops listening, so a page can hand it to onMount (a
 * non-async one: an async onMount's return is never run).
 */
export function onSyncChanges(fn, kinds) {
  if (typeof window === 'undefined') return () => {};
  const handler = e => { if (syncTouched(e?.detail, kinds)) fn(e.detail); };
  window.addEventListener('ct:sync-complete', handler);
  return () => window.removeEventListener('ct:sync-complete', handler);
}

/**
 * Two reads at once (a page opening while a sync ends, or two syncs): only
 * the newest one's answer stands. A page makes `const newest = newestRead();`
 * once, then `const isNewest = newest();` before each read and
 * `if (!isNewest()) return;` after it.
 */
export function newestRead() {
  let latest = 0;
  const start = () => { const mine = ++latest; return () => mine === latest; };
  return start;
}

// ── An editor open on a row a sync changed ──────────────────────────────

const _same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The fields of an editor's form that were changed since it opened: `now`
 * and `opened` are the form's values now and as it opened (or as it last
 * took a newer copy), in the same shape.
 */
export function touchedFields(now, opened) {
  return [...new Set([...Object.keys(now || {}), ...Object.keys(opened || {})])]
    .filter(k => !_same(now?.[k], opened?.[k]));
}

/**
 * An editor whose form is one object: `now` takes `fresh` (the newer copy,
 * as a form) in every field not changed since `opened`. Returns the form,
 * what it now counts as opened (a copy: a form's fields are changed in
 * place) and the fields kept.
 */
export function takeUntouched(now, opened, fresh) {
  const touched = touchedFields(now, opened);
  const form = {}, nextOpened = {};
  for (const k of new Set([...Object.keys(now || {}), ...Object.keys(fresh || {})])) {
    const keep = touched.includes(k);
    form[k] = keep ? now[k] : fresh[k];
    nextOpened[k] = keep ? opened[k] : fresh[k];
  }
  return { form, opened: JSON.parse(JSON.stringify(nextOpened)), touched };
}

/**
 * Calls `fn()` when the app comes back in front (the window shown again or
 * focused), for what a sync doesn't bring: views read from the server
 * only. Showing and focusing together count once. Returns the function
 * that stops listening.
 */
export function onBackInView(fn) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  let last = 0;
  const handler = () => {
    if (document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - last < 1000) return;
    last = now;
    fn();
  };
  document.addEventListener('visibilitychange', handler);
  window.addEventListener('focus', handler);
  return () => {
    document.removeEventListener('visibilitychange', handler);
    window.removeEventListener('focus', handler);
  };
}
