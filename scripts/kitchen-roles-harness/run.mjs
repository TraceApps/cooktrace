import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import db from './db-shim.mjs';
const SERVER = new URL('../../server/', import.meta.url).pathname;
const express = createRequire(SERVER + 'package.json')('express');
globalThis.__pantryCalls = [];

db.exec(`
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, full_name TEXT, avatar_url TEXT, role TEXT DEFAULT 'user');
CREATE TABLE kitchens (id INTEGER PRIMARY KEY, name TEXT, slug TEXT, owner_user_id INTEGER, created_at TEXT);
CREATE TABLE kitchen_members (kitchen_id INTEGER, user_id INTEGER, role TEXT NOT NULL DEFAULT 'member', auto_share INTEGER DEFAULT 0, joined_at TEXT, PRIMARY KEY (kitchen_id, user_id));
CREATE TABLE recipe_shares (recipe_id INTEGER, grantee_id INTEGER, granted_by INTEGER, via_kitchen_id INTEGER, granted_at TEXT);
CREATE TABLE recipes (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, description TEXT, img_url TEXT, servings REAL,
  yield_text TEXT, prep_minutes INTEGER, cook_minutes INTEGER, total_minutes INTEGER, rest_minutes INTEGER, rating INTEGER,
  favorite INTEGER DEFAULT 0, ingredients TEXT, steps TEXT, tags TEXT, tools TEXT, nutrition TEXT, source_url TEXT, notes TEXT,
  visibility TEXT DEFAULT 'private', created_by_username TEXT, category_id INTEGER, video_url TEXT, share_token TEXT,
  last_cooked_at TEXT, cook_count INTEGER DEFAULT 0, nt_meal_id INTEGER, last_edited_by INTEGER,
  created_at TEXT, updated_at TEXT, deleted_at TEXT);
CREATE TABLE user_settings (user_id INTEGER, key TEXT, value TEXT, updated_at TEXT);
CREATE TABLE recipe_categories (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, slug TEXT, color TEXT, sort_order INTEGER);
CREATE TABLE cook_diary (id INTEGER PRIMARY KEY, user_id INTEGER, recipe_id INTEGER, date TEXT, kind TEXT, deleted_at TEXT);
CREATE TABLE recipe_comments (id INTEGER PRIMARY KEY, recipe_id INTEGER, user_id INTEGER, parent_id INTEGER, body TEXT, created_by_username TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
CREATE TABLE recipe_cookbook_links (cookbook_id INTEGER, recipe_id INTEGER, sort_order INTEGER DEFAULT 0, added_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (cookbook_id, recipe_id));
CREATE TABLE pantry_items (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, in_stock INTEGER, generic_parent_id INTEGER, deleted_at TEXT);
CREATE TABLE cookbooks (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, slug TEXT, description TEXT, cover_image_url TEXT,
  is_smart INTEGER DEFAULT 0, smart_filter_json TEXT, sort_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, deleted_at TEXT);
CREATE TABLE cookbook_shares (cookbook_id INTEGER, grantee_id INTEGER, granted_by INTEGER, granted_at TEXT, via_kitchen_id INTEGER, PRIMARY KEY (cookbook_id, grantee_id));

INSERT INTO users (id, username, full_name, role) VALUES (1,'ana','Ana','user'), (2,'ben','Ben','user'), (3,'cy','Cy','user'), (9,'root','Root','admin');
INSERT INTO kitchens (id,name,slug,owner_user_id) VALUES (1,'Home','home',1);
INSERT INTO kitchen_members (kitchen_id,user_id,role) VALUES (1,1,'owner'), (1,2,'member'), (1,3,'member');
INSERT INTO recipes (id,user_id,name,visibility,rating,favorite,category_id,ingredients,steps,updated_at)
  VALUES (10,1,'Ana Stew','private',5,1,77,'[{"items":[{"name":"Onion"}]}]','[]',datetime('now'));
INSERT INTO recipe_shares (recipe_id,grantee_id,granted_by,via_kitchen_id) VALUES (10,2,1,1),(10,3,1,1);
-- a one-to-one share, outside any kitchen
INSERT INTO recipes (id,user_id,name,visibility,ingredients,steps,updated_at) VALUES (11,1,'Direct','private','[]','[]',datetime('now'));
INSERT INTO recipe_shares (recipe_id,grantee_id,granted_by,via_kitchen_id) VALUES (11,2,1,NULL);
INSERT INTO user_settings (user_id,key,value) VALUES (1,'autoCreatePantryFromRecipes','true');
INSERT INTO cookbooks (id,user_id,name,slug) VALUES (20,1,'Family Bakes','family-bakes');
INSERT INTO cookbook_shares (cookbook_id,grantee_id,granted_by,via_kitchen_id) VALUES (20,2,1,1),(20,3,1,1);
INSERT INTO cookbooks (id,user_id,name,slug) VALUES (21,1,'Direct Book','direct-book');
INSERT INTO cookbook_shares (cookbook_id,grantee_id,granted_by,via_kitchen_id) VALUES (21,2,1,NULL);
`);

const { default: recipes } = await import(SERVER + 'routes/recipes.js');
const { default: kitchens } = await import(SERVER + 'routes/kitchens.js');
const { default: cookbooks } = await import(SERVER + 'routes/cookbooks.js');
const app = express();
app.use(express.json());
app.use('/api/recipes', recipes);
app.use('/api/kitchens', kitchens);
app.use('/api/cookbooks', cookbooks);
const server = app.listen(0);
const port = server.address().port;

const as = (id, role = 'user') => { globalThis.__user = { id, role }; };
const call = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const save = (who, id, patch = {}) => { as(who); return call('PUT', `/api/recipes/${id}`, { name: 'Ana Stew v2', ingredients: [{ items: [{ name: 'Onion' }] }], steps: [], ...patch }); };

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${JSON.stringify(got)}${ok ? '' : ' want ' + JSON.stringify(want)}`);
};

// Line Cook cannot edit
check('line cook save is refused', (await save(2, 10)).status, 403);
as(2); check('line cook sees can_edit false', (await call('GET', '/api/recipes/10')).body.can_edit, false);

// Only the owner may promote, and not themselves
as(2); check('member cannot promote anyone', (await call('PUT', '/api/kitchens/1/members/3/role', { role: 'sous' })).status, 403);
as(1); check('owner cannot change own role', (await call('PUT', '/api/kitchens/1/members/1/role', { role: 'member' })).status, 400);
as(1); check('bad role rejected', (await call('PUT', '/api/kitchens/1/members/2/role', { role: 'admin' })).status, 400);
as(1); check('owner promotes Ben to sous', (await call('PUT', '/api/kitchens/1/members/2/role', { role: 'sous' })).status, 200);

// Sous Chef can now edit, but only what is theirs to change
as(2); check('sous sees can_edit true', (await call('GET', '/api/recipes/10')).body.can_edit, true);
check('sous save accepted', (await save(2, 10, { visibility: 'group', rating: 1, favorite: 0, category_id: 999 })).status, 200);
const after = db.prepare('SELECT * FROM recipes WHERE id = 10').get();
check('name changed', after.name, 'Ana Stew v2');
check('visibility kept', after.visibility, 'private');
check('category kept', after.category_id, 77);
check('rating kept', after.rating, 5);
check('favorite kept', after.favorite, 1);
check('editor recorded', after.last_edited_by, 2);
check('pantry resolved against the owner', globalThis.__pantryCalls.at(-1)?.userId, 1);

// Scope: the other member, one-to-one shares, delete
check('other member still refused', (await save(3, 10)).status, 403);
check('one-to-one share not editable', (await save(2, 11)).status, 403);
as(2); check('sous cannot delete', (await call('DELETE', '/api/recipes/10')).status, 403);

// Revocation
as(1); await call('PUT', '/api/kitchens/1/members/2/role', { role: 'member' });
check('demoted, save refused again', (await save(2, 10)).status, 403);
as(1); await call('PUT', '/api/kitchens/1/members/2/role', { role: 'sous' });
db.prepare('DELETE FROM kitchen_members WHERE kitchen_id = 1 AND user_id = 2').run();
check('removed from kitchen, refused', (await save(2, 10)).status, 403);

// Owner and admin are unaffected
check('owner still saves', (await save(1, 10)).status, 200);
check('owner save clears the editor mark', db.prepare('SELECT last_edited_by AS e FROM recipes WHERE id = 10').get().e, null);
as(9, 'admin'); check('admin still saves', (await call('PUT', '/api/recipes/10', { name: 'Admin Edit', ingredients: [], steps: [] })).status, 200);

// ---- invite with a role -------------------------------------------------
as(1);
check('invite as sous lands as sous', (await call('POST', '/api/kitchens/1/members', { username: 'cy2', role: 'sous' })).status, 404);
db.prepare("INSERT INTO users (id,username,full_name,role) VALUES (4,'dee','Dee','user')").run();
as(1);
check('invite Dee as a Sous Chef', (await call('POST', '/api/kitchens/1/members', { username: 'dee', role: 'sous' })).body?.role, 'sous');
check('Dee stored as sous', db.prepare("SELECT role AS r FROM kitchen_members WHERE kitchen_id=1 AND user_id=4").get().r, 'sous');
db.prepare("INSERT INTO users (id,username,full_name,role) VALUES (5,'eve','Eve','user')").run();
as(1);
check('a bogus role falls back to Line Cook', (await call('POST', '/api/kitchens/1/members', { username: 'eve', role: 'admin' })).body?.role, 'member');

// ---- cookbooks shared into the kitchen ----------------------------------
as(1); await call('PUT', '/api/kitchens/1/members/3/role', { role: 'sous' });   // Cy is a Sous Chef
as(3);
check('sous renames a shared cookbook', (await call('PUT', '/api/cookbooks/20', { name: 'Family Bakes v2' })).status, 200);
check('name really changed', db.prepare('SELECT name AS n FROM cookbooks WHERE id=20').get().n, 'Family Bakes v2');
check('sous adds a recipe to it', (await call('POST', '/api/cookbooks/20/recipes', { recipe_ids: [10] })).status, 200);
check('link written', db.prepare('SELECT COUNT(*) AS n FROM recipe_cookbook_links WHERE cookbook_id=20').get().n, 1);
check('sous removes it again', (await call('DELETE', '/api/cookbooks/20/recipes/10')).status, 200);
check('sous cannot delete the cookbook', (await call('DELETE', '/api/cookbooks/20')).status, 403);
check('sous cannot share it onward', (await call('POST', '/api/cookbooks/20/shares', { user_ids: [5] })).status, 403);
{ const r = await call('GET', '/api/cookbooks/20'); console.log('   GET cookbook ->', r.status, JSON.stringify(r.body)?.slice(0,200)); check('cookbook can_edit true for sous', r.body?.can_edit, true); }
check('one-to-one cookbook share stays read-only', (await call('PUT', '/api/cookbooks/21', { name: 'nope' })).status, 403);
as(5); check('a line cook cannot edit the cookbook', (await call('PUT', '/api/cookbooks/20', { name: 'nope' })).status, 403);

// ---- handing the kitchen over -------------------------------------------
as(3); check('a member cannot hand the kitchen over', (await call('PUT', '/api/kitchens/1/owner', { user_id: 3 })).status, 403);
as(1); check('cannot hand it to a non-member', (await call('PUT', '/api/kitchens/1/owner', { user_id: 99 })).status, 404);
as(1); check('cannot hand it to yourself', (await call('PUT', '/api/kitchens/1/owner', { user_id: 1 })).status, 400);
as(1); check('hand over to Cy', (await call('PUT', '/api/kitchens/1/owner', { user_id: 3 })).status, 200);
check('kitchen row moved', db.prepare('SELECT owner_user_id AS o FROM kitchens WHERE id=1').get().o, 3);
check('Cy is owner on the member row', db.prepare("SELECT role AS r FROM kitchen_members WHERE kitchen_id=1 AND user_id=3").get().r, 'owner');
check('Ana kept editing as a sous', db.prepare("SELECT role AS r FROM kitchen_members WHERE kitchen_id=1 AND user_id=1").get().r, 'sous');
as(1); check('the old owner can no longer set roles', (await call('PUT', '/api/kitchens/1/members/4/role', { role: 'member' })).status, 403);
as(3); check('the new owner can', (await call('PUT', '/api/kitchens/1/members/4/role', { role: 'member' })).status, 200);

server.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
