/**
 * Static-analysis tests for "members can edit shared recipes" on Kitchens.
 *
 * Pure text/regex checks over the source files, no db.js import, so this
 * runs without a compiled better-sqlite3 native binding. They guard the
 * pieces that have to stay wired together: the per-kitchen flag, the
 * owner-only toggle route, the PUT /recipes/:id permission, the fields a
 * member must not change, and the can_edit hint the recipe view reads.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const dbJs       = read('../server/db.js');
const kitchensJs = read('../server/routes/kitchens.js');
const recipesJs  = read('../server/routes/recipes.js');
const viewSvelte = read('../src/routes/RecipeView.svelte');
const settings   = read('../src/components/settings/SettingsKitchens.svelte');
const apiJs      = read('../src/lib/api.js');
const nativeJs   = read('../src/lib/api-native.js');

test('kitchens get a members_can_edit column, off by default', () => {
  assert.match(dbJs, /ALTER TABLE kitchens ADD COLUMN members_can_edit INTEGER NOT NULL DEFAULT 0/);
});

test('only the kitchen owner can flip members_can_edit', () => {
  const route = kitchensJs.slice(kitchensJs.indexOf("router.put('/:id/members-can-edit'"));
  assert.ok(route.length > 0, 'route exists');
  assert.match(route.slice(0, 600), /if \(!_isOwner\(id, u\)\) return res\.status\(403\)/);
  assert.match(kitchensJs, /members_can_edit: !!r\.members_can_edit/);
});

test('edit access comes from a kitchen share whose kitchen allows it, for a current member', () => {
  const fn = recipesJs.slice(recipesJs.indexOf('function _canEditViaKitchen'));
  assert.match(fn.slice(0, 700), /JOIN kitchens k ON k\.id = s\.via_kitchen_id/);
  assert.match(fn.slice(0, 700), /JOIN kitchen_members m ON m\.kitchen_id = k\.id AND m\.user_id = s\.grantee_id/);
  assert.match(fn.slice(0, 700), /k\.members_can_edit = 1/);
});

test('PUT /recipes/:id lets kitchen editors through but keeps owner-only fields', () => {
  const put = recipesJs.slice(recipesJs.indexOf("router.put('/:id',"));
  const body = put.slice(0, put.indexOf('}));'));
  assert.match(body, /const isKitchenEditor = !isOwner && !isAdmin && _canEditViaKitchen\(id, u\)/);
  assert.match(body, /if \(!isOwner && !isAdmin && !isKitchenEditor\) return res\.status\(403\)/);
  assert.match(body, /data\.visibility = existing\.visibility/);
  assert.match(body, /data\.category_id = existing\.category_id/);
});

test('delete stays owner or admin only', () => {
  const del = recipesJs.slice(recipesJs.indexOf("router.delete('/:id',"));
  assert.match(del.slice(0, 800), /if \(!isOwner && !isAdmin\) return res\.status\(403\)/);
  assert.doesNotMatch(del.slice(0, 800), /_canEditViaKitchen/);
});

test('the recipe view shows Edit when the server says can_edit', () => {
  assert.match(recipesJs, /res\.json\(\{ \.\.\._withCreatorAvatar\(_hydrate\(row\), row\), can_edit \}\)/);
  assert.match(viewSvelte, /recipe\.can_edit === true/);
});

test('settings toggle is owner-only and wired to the API, with a native stub', () => {
  assert.match(settings, /\{#if isOwner\(k\)\}[\s\S]*toggleMembersCanEdit\(k\)/);
  assert.match(apiJs, /setKitchenMembersCanEdit\(kitchenId, enabled\)/);
  assert.match(nativeJs, /async setKitchenMembersCanEdit\(\)/);
});
