/**
 * Smart cookbooks (#76).
 *
 * The count a cookbook shows in the list must be what opening it shows:
 * for a smart cookbook, what its filter matches (it has no links, so it
 * read 0), and for a plain one, links to recipes that still exist
 * (deleting a recipe keeps its link). The Android app's own database
 * works a smart cookbook out by the same rules as the server, and editing
 * one there keeps it smart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesSmartFilter, parseSmartFilter } from '../src/lib/smart-cookbook.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const serverJs = read('../server/routes/cookbooks.js');
const nativeJs = read('../src/lib/api-native.js');

const recipe = (o = {}) => ({
  id: 1, deleted_at: null, category_id: null, favorite: 0, rating: null,
  prep_minutes: null, cook_minutes: null, tags: '[]', ...o,
});

test('the server and the app share one copy of the rules', () => {
  assert.equal(read('../src/lib/smart-cookbook.js'), read('../server/lib/smart-cookbook.js'));
});

test('an empty filter holds every recipe that is not deleted', () => {
  assert.equal(matchesSmartFilter(recipe(), {}), true);
  assert.equal(matchesSmartFilter(recipe({ deleted_at: '2026-10-05' }), {}), false);
  assert.equal(matchesSmartFilter(recipe(), null), false);
  assert.equal(matchesSmartFilter(recipe(), 5), false);
});

test('tags match without regard to case, and every tag is needed', () => {
  const f = { tags: ['quick', 'Veg'] };
  assert.equal(matchesSmartFilter(recipe({ tags: '["Quick","veg","kids"]' }), f), true);
  assert.equal(matchesSmartFilter(recipe({ tags: ['QUICK', 'VEG'] }), f), true, 'tags already parsed');
  assert.equal(matchesSmartFilter(recipe({ tags: '["quick"]' }), f), false);
  assert.equal(matchesSmartFilter(recipe({ tags: 'not json' }), f), false);
  assert.equal(matchesSmartFilter(recipe({ tags: null }), f), false);
});

test('category, favorites, rating and time match like the old SQL', () => {
  assert.equal(matchesSmartFilter(recipe({ category_id: 3 }), { category_id: 3 }), true);
  assert.equal(matchesSmartFilter(recipe({ category_id: 4 }), { category_id: 3 }), false);
  assert.equal(matchesSmartFilter(recipe(), { category_id: 3 }), false, 'no category never matches one');
  assert.equal(matchesSmartFilter(recipe({ favorite: 1 }), { favorites_only: true }), true);
  assert.equal(matchesSmartFilter(recipe({ favorite: 0 }), { favorites_only: true }), false);
  assert.equal(matchesSmartFilter(recipe({ rating: 4 }), { min_rating: 4 }), true);
  assert.equal(matchesSmartFilter(recipe({ rating: 3 }), { min_rating: 4 }), false);
  assert.equal(matchesSmartFilter(recipe({ rating: null }), { min_rating: 0 }), false, 'unrated is not rated 0');
  assert.equal(matchesSmartFilter(recipe({ prep_minutes: 10, cook_minutes: 20 }), { max_total_minutes: 30 }), true);
  assert.equal(matchesSmartFilter(recipe({ prep_minutes: 10, cook_minutes: 21 }), { max_total_minutes: 30 }), false);
  assert.equal(matchesSmartFilter(recipe({ prep_minutes: null, cook_minutes: null }), { max_total_minutes: 0 }), true, 'missing times count as 0');
});

test('a saved filter is read from the row', () => {
  assert.deepEqual(parseSmartFilter('{"tags":["quick"]}'), { tags: ['quick'] });
  assert.equal(parseSmartFilter(null), null);
  assert.equal(parseSmartFilter(''), null);
  assert.equal(parseSmartFilter('{broken'), null);
});

test('the server counts what opening the cookbook shows', () => {
  assert.doesNotMatch(serverJs, /COUNT\(\*\) FROM recipe_cookbook_links l\s+WHERE l\.cookbook_id = c\.id/,
    'counting links alone gives a smart cookbook 0 and counts deleted recipes');
  const count = serverJs.slice(serverJs.indexOf('function _recipeCount'));
  const body = count.slice(0, count.indexOf('\n}'));
  assert.match(body, /if \(cb\.is_smart\)/);
  assert.match(body, /matchesSmartFilter/);
  assert.match(body, /JOIN recipes r ON r\.id = l\.recipe_id[\s\S]*r\.deleted_at IS NULL/);
  for (const route of ["router.get('/',", "router.get('/shared-with-me',", "router.post('/',", "router.put('/:id',"]) {
    const r = serverJs.slice(serverJs.indexOf(route));
    assert.match(r.slice(0, r.indexOf('\n}));')), /_recipeCount\(/, `${route} counts with _recipeCount`);
  }
  const open = serverJs.slice(serverJs.indexOf("router.get('/:id',"));
  assert.match(open.slice(0, open.indexOf('\n}));')), /_evalSmartFilter\(cb\.user_id, parseSmartFilter\(cb\.smart_filter_json\) \|\| \{\}\)/);
});

test('the Android app opens and counts a smart cookbook by its filter', () => {
  assert.match(nativeJs, /import \{ matchesSmartFilter \} from '\.\/smart-cookbook\.js'/);
  assert.doesNotMatch(nativeJs, /SELECT COUNT\(\*\) FROM recipe_cookbook_links l WHERE l\.cookbook_id = c\.id/);
  const open = nativeJs.slice(nativeJs.indexOf('async getCookbook(id)'));
  assert.match(open.slice(0, open.indexOf('\n  },')), /out\.is_smart\s*\? await _smartCookbookRecipes\(out\.smart_filter \|\| \{\}\)/);
  const list = nativeJs.slice(nativeJs.indexOf('async getCookbooks()'));
  assert.match(list.slice(0, list.indexOf('\n  },')), /recipe_count = await _cookbookCount\(cb, cache\)/);
});

test('editing a cookbook in the Android app keeps what was not sent', () => {
  const upd = nativeJs.slice(nativeJs.indexOf('async updateCookbook(id, d)'));
  const body = upd.slice(0, upd.indexOf('\n  },'));
  assert.match(body, /d\.name != null \? [^:]+: existing\.name/);
  assert.match(body, /d\.cover_image_url !== undefined \? [^:]+: existing\.cover_image_url/);
  assert.match(body, /d\.is_smart !== undefined \? _bool\(d\.is_smart\) : existing\.is_smart/);
  assert.match(body, /let filterJson = existing\.smart_filter_json/);
  assert.doesNotMatch(body, /\[d\.name, d\.description \|\| null/, 'a rename blanked the filter and a cover change blanked the name');
});
