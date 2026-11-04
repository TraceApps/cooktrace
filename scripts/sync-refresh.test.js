/**
 * What a sync changed on the phone, and a page asking to hear of it
 * (src/lib/sync-refresh.js). Pages read their data once, when they open;
 * a sync that changes rows under an open page announces the kinds of rows it
 * touched, and the page reads again only if it shows one of them.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pullKinds, syncTouched, onSyncChanges, newestRead, REPLACE_SETS, touchedFields, takeUntouched, onBackInView } from '../src/lib/sync-refresh.js';

test('pullKinds: the tables a pull brought rows for, deletes included', () => {
  assert.deepEqual(pullKinds({}), []);
  assert.deepEqual(pullKinds(null), []);
  assert.deepEqual(pullKinds({ recipes: [], cookbooks: [] }), [], 'empty lists are nothing');
  assert.deepEqual(pullKinds({ recipes: [{ id: 1 }], cook_diary: [{ id: 2 }], settings: [{ key: 'a' }] }).sort(), ['cook_diary', 'recipes', 'settings']);
  assert.deepEqual(pullKinds({ recipes: [{ id: 1, deleted_at: 'x' }] }), ['recipes'], 'a soft delete is a change');
  assert.deepEqual(pullKinds({ deletions: { custom_units: [3] } }), ['custom_units'], 'deleted outright');
  assert.deepEqual(pullKinds({ deletions: { recipe_categories: [1] } }).sort(), ['recipes', 'recipe_categories'].sort(), 'its recipes let go of it');
  assert.deepEqual(pullKinds({ deletions: { pantry_categories: [1] } }).sort(), ['pantry_categories', 'pantry_items']);
  assert.deepEqual(pullKinds({ deletions: { custom_units: [] } }), []);
});

test('pullKinds: the sets sent whole every time are not read off the pull', () => {
  assert.deepEqual(REPLACE_SETS.sort(), ['disabled_units', 'recipe_cookbook_links']);
  assert.deepEqual(pullKinds({ disabled_units: [{ abbr: 'tsp' }], recipe_cookbook_links: [{ cookbook_id: 1 }] }), []);
});

test('syncTouched: kinds decide, nothing announced is nothing to read', () => {
  assert.equal(syncTouched(null, ['recipes']), false);
  assert.equal(syncTouched({ ok: true, changed: 0, kinds: [] }, ['recipes']), false);
  assert.equal(syncTouched({ ok: true, changed: 0, kinds: [] }), false);
  assert.equal(syncTouched({ ok: true, changed: 2, kinds: ['pantry_items'] }, ['recipes']), false);
  assert.equal(syncTouched({ ok: true, changed: 2, kinds: ['recipes', 'pantry_items'] }, ['recipes']), true);
  assert.equal(syncTouched({ ok: true, changed: 2, kinds: ['pantry_items'] }), true, 'a page that shows everything');
  assert.equal(syncTouched({ ok: false, error: 'x', kinds: ['recipes'] }, ['recipes']), true, 'a sync that failed after its pull');
  assert.equal(syncTouched({ ok: false, error: 'x', kinds: [] }, ['recipes']), false);
  // An event that does not say what it touched counts when it brought rows.
  assert.equal(syncTouched({ ok: true, changed: 1 }, ['recipes']), true);
  assert.equal(syncTouched({ ok: true, changed: 0 }, ['recipes']), false);
  assert.equal(syncTouched({ ok: false, error: 'x' }, ['recipes']), false);
});

test('onSyncChanges: calls for the kinds it shows, and stops when told', () => {
  const listeners = new Map();
  globalThis.window = {
    addEventListener: (t, f) => { listeners.set(t, [...(listeners.get(t) || []), f]); },
    removeEventListener: (t, f) => { listeners.set(t, (listeners.get(t) || []).filter(x => x !== f)); },
  };
  try {
    const fire = detail => (listeners.get('ct:sync-complete') || []).slice().forEach(f => f({ detail }));
    const seen = [];
    const off = onSyncChanges(d => seen.push(['a', d.kinds]), ['recipes']);
    const offAll = onSyncChanges(d => seen.push(['all', d.kinds]));
    assert.equal(listeners.get('ct:sync-complete').length, 2);
    fire({ ok: true, changed: 1, kinds: ['pantry_items'] });
    fire({ ok: true, changed: 1, kinds: ['recipes'] });
    fire({ ok: true, changed: 0, kinds: [] });
    assert.deepEqual(seen, [['all', ['pantry_items']], ['a', ['recipes']], ['all', ['recipes']]]);
    off(); offAll();
    assert.equal(listeners.get('ct:sync-complete').length, 0, 'nothing left behind');
  } finally { delete globalThis.window; }
});

test('newestRead: only the newest read stands', () => {
  const newest = newestRead();
  const first = newest();
  const second = newest();
  assert.equal(first(), false);
  assert.equal(second(), true);
  const third = newest();
  assert.equal(second(), false);
  assert.equal(third(), true);
});

// ── An open editor and a sync that changed its row ──

test('touchedFields: what the form changed since it opened', () => {
  const opened = { name: 'Flour', brand: '', quantity: 2, nutrition: { kcal: 364 } };
  assert.deepEqual(touchedFields(opened, JSON.parse(JSON.stringify(opened))), []);
  assert.deepEqual(touchedFields({ ...opened, brand: 'King' }, opened), ['brand']);
  assert.deepEqual(touchedFields({ ...opened, nutrition: { kcal: 360 } }, opened), ['nutrition'], 'inside a field too');
  assert.deepEqual(touchedFields({ name: 'Flour', brand: null }, { name: 'Flour' }), [], 'nothing and null are the same');
});

test('takeUntouched: the newer copy fills only what the form left as it was', () => {
  const opened = { name: 'Flour', brand: '', notes: 'old', quantity: 2 };
  const now = { ...opened, notes: 'mine' };
  const fresh = { name: 'Bread Flour', brand: 'King', notes: 'theirs', quantity: 2, unit: 'kg' };
  const took = takeUntouched(now, opened, fresh);
  assert.deepEqual(took.form, { name: 'Bread Flour', brand: 'King', notes: 'mine', quantity: 2, unit: 'kg' }, 'what was typed here stays');
  assert.deepEqual(took.touched, ['notes']);
  assert.deepEqual(took.opened, { name: 'Bread Flour', brand: 'King', notes: 'old', quantity: 2, unit: 'kg' }, 'and still counts as changed');
  // The next sync: still the same field kept, and a later web change to it is still not taken.
  const again = takeUntouched(took.form, took.opened, { ...fresh, notes: 'theirs again', quantity: 5 });
  assert.equal(again.form.notes, 'mine');
  assert.equal(again.form.quantity, 5);
  // Its opened copy is its own: a form changed in place doesn't change it.
  const form = took.form; form.name = 'typed';
  assert.equal(took.opened.name, 'Bread Flour');
});

test('onBackInView: once when the app is back in front, not while hidden', () => {
  const on = new Map();
  const target = () => ({
    addEventListener: (t, f) => { on.set(t, [...(on.get(t) || []), f]); },
    removeEventListener: (t, f) => { on.set(t, (on.get(t) || []).filter(x => x !== f)); },
  });
  globalThis.window = target();
  globalThis.document = { ...target(), visibilityState: 'visible' };
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    let n = 0;
    const off = onBackInView(() => { n++; });
    const fire = t => (on.get(t) || []).forEach(f => f());
    fire('visibilitychange'); fire('focus');
    assert.equal(n, 1, 'shown and focused together count once');
    clock += 5000;
    globalThis.document.visibilityState = 'hidden';
    fire('visibilitychange');
    assert.equal(n, 1, 'going away is not coming back');
    globalThis.document.visibilityState = 'visible';
    fire('visibilitychange');
    assert.equal(n, 2);
    off();
    assert.equal((on.get('focus') || []).length + (on.get('visibilitychange') || []).length, 0, 'nothing left behind');
  } finally { Date.now = realNow; delete globalThis.window; delete globalThis.document; }
});

// ── Wiring: every listener is taken away, every page that reads once listens ──

const root = new URL('../', import.meta.url).pathname;
function files(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(svelte|js)$/.test(f)) out.push(p);
  }
  return out;
}
const sources = files(join(root, 'src')).map(p => [p.slice(root.length), readFileSync(p, 'utf8')]);

test('every page listens inside a non-async onMount, so its listener is taken away', () => {
  for (const [name, src] of sources) {
    if (name === 'src/lib/sync-refresh.js') continue;
    const calls = [...src.matchAll(/onSyncChanges\(/g)].map(m => m.index).filter(i => !/import\b[^\n]*$/.test(src.slice(src.lastIndexOf('\n', i) + 1, i)));
    for (const i of calls) {
      const before = src.slice(Math.max(0, i - 40), i);
      if (name === 'src/stores/unitsOverlay.js') { assert.match(before, /\n$/, 'the store listens once, for the life of the app'); continue; }
      assert.match(before, /onMount\(\(\) => $/, `${name}: onSyncChanges is returned from a plain onMount(() => ...)`);
    }
  }
});

test('no sync listener hides in an async onMount', () => {
  for (const [name, src] of sources) {
    for (const m of src.matchAll(/onMount\(async\b/g)) {
      const body = src.slice(m.index, m.index + 4000);
      const end = body.search(/\n  \}\);/);
      assert.doesNotMatch(end > 0 ? body.slice(0, end) : body, /onSyncChanges|ct:sync-complete/, `${name}: an async onMount's cleanup never runs`);
    }
  }
});

// What each page that reads once shows, as the kinds it listens for.
const PAGES = {
  'src/routes/CookbookView.svelte': ['cookbooks', 'recipes', 'recipe_cookbook_links'],
  'src/routes/RecipeView.svelte': ['recipes', 'cook_diary', 'recipe_revisions', 'pantry_items'],
  'src/routes/RecipeVersion.svelte': ['recipes', 'recipe_revisions', 'cook_diary'],
  'src/components/recipe/RecipeComments.svelte': ['recipe_comments'],
  'src/components/manage/ManageRecipeCategories.svelte': ['recipe_categories', 'recipes'],
  'src/components/manage/ManagePantryCategories.svelte': ['pantry_categories', 'pantry_items'],
  'src/components/manage/ManageUnits.svelte': ['custom_units', 'disabled_units', 'recipes'],
  'src/components/manage/ManageCookbooks.svelte': ['cookbooks', 'recipe_cookbook_links', 'recipes', 'recipe_categories'],
  'src/components/manage/ManageTaxonomyList.svelte': ['recipes'],
  'src/stores/unitsOverlay.js': ['custom_units', 'disabled_units'],
  'src/components/diary/PlanCookDialog.svelte': ['recipes'],
  'src/components/pantry/PantryItemSheet.svelte': ['pantry_categories', 'pantry_items'],
  'src/routes/RecipeEditor.svelte': ['recipes'],
  'src/routes/PantryEditor.svelte': ['pantry_items'],
};
// The text of each onSyncChanges(...) call in a source, up to its closing parenthesis.
function callsOf(src) {
  const out = [];
  for (const m of src.matchAll(/onSyncChanges\(/g)) {
    if (/import\b/.test(src.slice(src.lastIndexOf('\n', m.index) + 1, m.index))) continue;
    let depth = 0, q = null;
    for (let i = m.index + 'onSyncChanges'.length; i < src.length; i++) {
      const c = src[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) { out.push(src.slice(m.index, i + 1)); break; }
    }
  }
  return out;
}
for (const [page, kinds] of Object.entries(PAGES)) {
  test(`${page} listens for ${kinds.join(', ')}`, () => {
    const calls = callsOf(readFileSync(join(root, page), 'utf8'));
    assert.ok(calls.length >= 1, 'listens');
    // The kinds are the array that ends the call: onSyncChanges(fn, ['a', 'b']).
    const listened = new Set(calls.flatMap(c => [...((c.match(/,\s*\[([^\]]*)\]\s*\)$/) || [])[1] || '').matchAll(/'([a-z_]+)'/g)].map(m => m[1])));
    for (const k of kinds) assert.ok(listened.has(k), `${k} is among the kinds it listens for (${[...listened]})`);
  });
}

// The views a sync doesn't bring (read from the server only) read again when
// the app is back in front, from a plain onMount so the listener goes too.
for (const view of ['src/components/ai/Trace.svelte', 'src/components/settings/SettingsKitchens.svelte', 'src/components/settings/SettingsUserManagement.svelte']) {
  test(`${view} reads again when the app is back in front`, () => {
    const src = readFileSync(join(root, view), 'utf8');
    assert.match(src, /onMount\(\(\) => onBackInView\(/);
  });
}
