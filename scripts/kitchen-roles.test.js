/**
 * Static-analysis tests for kitchen roles (Head Chef / Sous Chef / Line Cook).
 *
 * Text checks over the source, in the style of the other *-wiring tests,
 * so this runs without a compiled better-sqlite3 binding. The behaviour
 * itself (who may save what) is exercised end to end against the real
 * routes by scripts/kitchen-roles-harness/, which needs node:sqlite.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const dbJs       = read('../server/db.js');
const kitchensJs = read('../server/routes/kitchens.js');
const recipesJs  = read('../server/routes/recipes.js');
const viewSvelte = read('../src/routes/RecipeView.svelte');
const settings   = read('../src/components/settings/SettingsKitchens.svelte');
const apiJs      = read('../src/lib/api.js');
const nativeJs   = read('../src/lib/api-native.js');
const cachedJs   = read('../src/lib/api-cached.js');
const cookbooksJs = read('../server/routes/cookbooks.js');
const cbView      = read('../src/routes/CookbookView.svelte');

test('roles reuse the existing kitchen_members.role column, no new flag', () => {
  assert.match(dbJs, /CREATE TABLE IF NOT EXISTS kitchen_members[\s\S]{0,300}role\s+TEXT NOT NULL DEFAULT 'member'/);
  assert.doesNotMatch(dbJs, /members_can_edit/, 'a per-kitchen boolean would duplicate the role column');
});

test('only the kitchen owner can change a role, and not their own', () => {
  const route = kitchensJs.slice(kitchensJs.indexOf("router.put('/:id/members/:userId/role'"));
  assert.ok(route.length > 0, 'role route exists');
  const body = route.slice(0, route.indexOf('}));'));
  assert.match(body, /if \(!_isOwner\(id, u\)\) return res\.status\(403\)/);
  assert.match(body, /_isOwner\(id, target\)[\s\S]{0,80}400/, "the owner's own role is not editable");
  assert.match(body, /EDITABLE_ROLES\.has\(role\)/);
  assert.match(kitchensJs, /EDITABLE_ROLES = new Set\(\['sous', 'member'\]\)/);
});

test('edit access is read live from the share plus current membership', () => {
  const fn = recipesJs.slice(recipesJs.indexOf('function _canEditViaKitchen'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /FROM recipe_shares s/);
  assert.match(body, /JOIN kitchen_members m/);
  assert.match(body, /m\.role = 'sous'/);
  assert.match(body, /s\.via_kitchen_id IS NOT NULL/, 'one-to-one shares must not grant edit');
});

test('PUT /recipes/:id admits a Sous Chef but keeps the owner-only fields', () => {
  const put = recipesJs.slice(recipesJs.indexOf("router.put('/:id',"));
  const body = put.slice(0, put.indexOf('\n}));'));
  assert.match(body, /const isKitchenEditor = !isOwner && !isAdmin && _canEditViaKitchen\(id, u\)/);
  assert.match(body, /if \(!isOwner && !isAdmin && !isKitchenEditor\)/);
  for (const field of ['visibility', 'category_id', 'rating', 'favorite']) {
    assert.match(body, new RegExp(`data\\.${field}\\s*=\\s*existing\\.${field}`), `${field} stays the owner's`);
  }
});

test('pantry links resolve against the recipe owner, never the editor', () => {
  const put = recipesJs.slice(recipesJs.indexOf("router.put('/:id',"));
  const body = put.slice(0, put.indexOf('\n}));'));
  assert.match(body, /const pantryOwner = isOwner \? u : existing\.user_id/);
  assert.match(body, /_linkIngredientsToPantry\(pantryOwner, body\.ingredients\)/);
  assert.doesNotMatch(body, /_linkIngredientsToPantry\(u,/, 'the editor of a shared recipe must not repoint it at their own pantry');
});

test('a non-owner save is recorded, and delete stays owner or admin only', () => {
  assert.match(dbJs, /ALTER TABLE recipes ADD COLUMN last_edited_by INTEGER/);
  const put = recipesJs.slice(recipesJs.indexOf("router.put('/:id',"));
  assert.match(put.slice(0, put.indexOf('\n}));')), /isOwner \? null : u/);
  const del = recipesJs.slice(recipesJs.indexOf("router.delete('/:id',"));
  assert.match(del.slice(0, 900), /if \(!isOwner && !isAdmin\) return res\.status\(403\)/);
  assert.doesNotMatch(del.slice(0, 900), /_canEditViaKitchen/);
});

test('the recipe view trusts the server can_edit, and shows who edited last', () => {
  assert.match(recipesJs, /can_edit,/);
  assert.match(recipesJs, /last_edited_by_name/);
  assert.match(viewSvelte, /recipe\.can_edit === true/);
  assert.match(viewSvelte, /recipe\.last_edited_by_name/);
});

test('settings exposes the role picker to the owner, with a native stub', () => {
  assert.match(settings, /role_sous/);
  assert.match(settings, /setKitchenMemberRole/);
  assert.match(settings, /\{#if isOwner\(k\) && m\.role !== 'owner'\}/);
  assert.match(apiJs, /setKitchenMemberRole\(id, userId, role\)/);
  assert.match(nativeJs, /async setKitchenMemberRole\(\)/);
});

test('the app sends a shared-recipe save straight to the server, not through sync', () => {
  const fn = cachedJs.slice(cachedJs.indexOf('wrapped.updateRecipe'));
  const body = fn.slice(0, fn.indexOf('\n};'));
  assert.match(body, /CtApiNative\.updateRecipe/, 'owned recipes keep the offline-first path');
  assert.match(body, /method: 'PUT'/, 'a recipe with no local row goes to the API');
  assert.match(body, /navigator\.onLine === false/, 'and refuses clearly when offline');
});

test('an owner can pick the role when inviting, and anything odd joins read-only', () => {
  const post = kitchensJs.slice(kitchensJs.indexOf("router.post('/:id/members'"));
  const body = post.slice(0, post.indexOf('\n}));'));
  assert.match(body, /EDITABLE_ROLES\.has\(\(req\.body\?\.role \|\| ''\)/);
  assert.match(body, /: 'member';/, 'an unknown role falls back to Line Cook');
  assert.match(body, /VALUES \(\?, \?, \?\)/, 'the chosen role is what gets inserted');
});

test('handing a kitchen over moves the row and both member roles together', () => {
  const route = kitchensJs.slice(kitchensJs.indexOf("router.put('/:id/owner'"));
  const body = route.slice(0, route.indexOf('\n}));'));
  assert.match(body, /if \(!_isOwner\(id, u\)\) return res\.status\(403\)/);
  assert.match(body, /if \(!_isMember\(id, target\)\) return res\.status\(404\)/);
  assert.match(body, /UPDATE kitchens SET owner_user_id = \? WHERE id = \?/);
  assert.match(body, /SET role = 'owner' WHERE kitchen_id = \? AND user_id = \?/);
  assert.match(body, /SET role = 'sous' WHERE kitchen_id = \? AND user_id = \?/);
  assert.match(body, /db\.transaction/, 'ownership and the member rows move together or not at all');
});

test('a Sous Chef can edit a cookbook shared into the kitchen, but not delete or reshare it', () => {
  assert.match(cookbooksJs, /function _canEditViaKitchen/);
  const fn = cookbooksJs.slice(cookbooksJs.indexOf('function _canEditViaKitchen'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /FROM cookbook_shares s[\s\S]*m\.role = 'sous'/);
  for (const route of ["router.put('/:id',", "router.post('/:id/recipes',", "router.put('/:id/recipes/order',", "router.delete('/:id/recipes/:recipeId',"]) {
    const block = cookbooksJs.slice(cookbooksJs.indexOf(route));
    assert.match(block.slice(0, 700), /!isOwner && !_canEditViaKitchen\(id, u\)/, `${route} admits a Sous Chef`);
  }
  for (const route of ["router.delete('/:id',", "router.post('/:id/shares',"]) {
    const block = cookbooksJs.slice(cookbooksJs.indexOf(route));
    assert.doesNotMatch(block.slice(0, 700), /_canEditViaKitchen/, `${route} stays owner only`);
  }
  assert.match(cookbooksJs, /can_edit: isOwner \|\| _canEditViaKitchen\(id, u\)/);
  assert.match(cbView, /cookbook\.can_edit === true/);
});
