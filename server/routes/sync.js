/**
 * sync.js — Differential push / pull for the Capacitor native app.
 *
 * The native app keeps a full local SQLite copy of every domain table
 * (db-native.js + api-native.js). When a server URL is configured,
 * local writes mark rows sync_status='pending' and the client-side
 * orchestrator (src/lib/sync.js) periodically reconciles via these
 * endpoints.
 *
 * Contract (kept close to NutriTrace's so the orchestrator pattern
 * ports without surgery):
 *
 *   POST /api/sync/push
 *     body: { tables: { [name]: [row, ...] }, settings: [{ key, value, updated_at }],
 *             client_now?: ISO }
 *     row shape: { client_id, server_id?, ...table-columns, updated_at, deleted_at,
 *                  recipes also: server_synced_at?, changed?: [field], base_meta? }
 *     response: { tables: { [name]: [{ client_id, server_id, synced_at?, updated_at?, kept? }] },
 *                 clock_offset_ms }
 *
 *   GET /api/sync/pull?since=<ISO>[&synced_at=1]
 *     response: { now: 'ISO', tables: { [name]: [{ id, ...cols, updated_at, deleted_at }] } }
 *
 * Two edits of one row: apps that send client_now are judged, and the newer
 * edit stays (lib/sync-clock.js; recipes field by field, with the other
 * copy kept as an earlier version: lib/recipe-versions.js). Older apps'
 * edits go in as they always have.
 *
 * Tables handled: recipes, pantry_items, cook_diary, shopping_list,
 * recipe_categories, pantry_categories, custom_units, cookbooks,
 * recipe_comments, ai_chat_history (structural) plus disabled_units +
 * recipe_cookbook_links (replace-by-set) plus user_settings (key-value).
 *
 * FK translation on push: tables process in dependency order so parent
 * client_id → server_id mappings are available by the time child rows
 * (cook_diary.recipe_id, shopping_list.pantry_id, etc.) are written.
 * On pull, parent tables arrive before children and the client side
 * translates FKs via `WHERE server_id = ?` lookups in db-native.
 */

import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { isEmptyForGuard } from '../lib/recipe-guards.js';
import { autoShareNewRecipe } from '../lib/auto-share.js';
import { dispatchWebhookEvent } from '../lib/webhooks.js';
import { mapSmartFilterCategory } from '../lib/smart-cookbook.js';
import { saveRecipeVersion, mergeRecipe, sameContent, VERSION_FIELDS } from '../lib/recipe-versions.js';
import { mergeFields } from '../lib/field-merge.js';
import { SYNC_FIELDS, SYNC_GROUPS } from '../lib/sync-fields.js';
import { stampFields } from '../lib/field-stamps.js';
import { repairVariantTree } from '../lib/pantry-tree.js';
import { clockOffset, editTime, latestTime, utcMs } from '../lib/sync-clock.js';
import { cleanCreateKey, findByCreateKey, setCreateKey } from '../lib/create-keys.js';

// Unique per account (server/db.js), so one made on two devices is one row.
const NATURAL_KEYS = { recipe_categories: 'slug', pantry_categories: 'slug', cookbooks: 'slug', custom_units: 'abbr' };

// Option E guard (2026-08-11): the recipe UPDATE path replaces nested
// JSON fields (ingredients/steps/tags/tools/nutrition) wholesale. A
// stale mobile client whose local recipe was truncated would wipe the
// server's real content on sync. Fix: for the recipes table only, if
// an incoming nested field is empty AND the server has content, keep
// the server value in the bound arguments. Applied inline here rather
// than in _buildUpdateSql because the guard needs the current server
// row (which the generic builder doesn't have access to).
function _guardRecipeValuesForUpdate(values, spec, serverRow) {
  const FIELDS = { ingredients: 'ingredients', steps: 'array', tags: 'array', tools: 'array', nutrition: 'object' };
  const out = values.slice();
  for (let i = 0; i < spec.cols.length; i++) {
    const col = spec.cols[i];
    const kind = FIELDS[col];
    if (!kind) continue;
    let incoming;
    try { incoming = JSON.parse(out[i] ?? 'null'); } catch { incoming = null; }
    if (!isEmptyForGuard(incoming, kind)) continue;
    // Incoming empty; check server. Server row's field is already a
    // string in the row shape (raw column). If server has content,
    // preserve it in the bind slot.
    let existing;
    try { existing = JSON.parse(serverRow?.[col] ?? 'null'); } catch { existing = null; }
    if (!isEmptyForGuard(existing, kind)) out[i] = serverRow[col];
  }
  return out;
}

const router = Router();
router.use(requireAuth);

const uid = req => userMgmtActive() ? req.user.id : null;
const userClause = (u) => u == null ? 'user_id IS NULL' : 'user_id = ?';
const userArgs   = (u) => u == null ? [] : [u];

// ── Table specs ──────────────────────────────────────────────────────
// `cols` — columns the client may WRITE via push. id / user_id /
//          created_at / sync_status / server_id are server-managed on
//          push. NOTE: the pull endpoint below still emits created_at
//          separately so the client can preserve the original creation
//          timestamp when it INSERTs the pulled row into its local DB.
// `parents` — FK columns + the table they reference, used to rewrite
//             client-local ids into server ids during a push.
// `softDelete` — uses deleted_at instead of hard delete.
const TABLES = {
  recipe_categories: {
    cols: ['name', 'slug', 'color', 'sort_order'],
    parents: {},
    softDelete: false,
  },
  pantry_categories: {
    cols: ['name', 'slug', 'icon', 'color', 'sort_order', 'default_aisle'],
    parents: {},
    softDelete: false,
  },
  custom_units: {
    cols: ['abbr', 'full_name', 'category', 'sort_order'],
    parents: {},
    softDelete: false,
  },
  cookbooks: {
    cols: ['name', 'slug', 'description', 'cover_image_url', 'is_smart', 'smart_filter_json', 'sort_order'],
    parents: {},
    softDelete: true,
  },
  recipes: {
    cols: [
      'name', 'description', 'img_url', 'servings', 'prep_minutes', 'cook_minutes', 'total_minutes', 'rest_minutes',
      'ingredients', 'steps', 'tags', 'tools', 'source_url', 'video_url', 'notes',
      'visibility', 'rating', 'yield_text', 'last_cooked_at', 'cook_count',
      'nutrition', 'favorite', 'category_id',
    ],
    // Sent to devices so they know a public link exists, never taken from
    // them: only POST/DELETE /api/recipes/:id/share set it. A device still
    // holding a removed link would otherwise bring it back with its next edit.
    pullCols: ['share_token'],
    parents: { category_id: 'recipe_categories' },
    softDelete: true,
  },
  pantry_items: {
    cols: [
      'name', 'brand', 'barcode', 'in_stock', 'quantity', 'unit', 'expires_on',
      'nt_food_id', 'img_url', 'notes', 'category', 'category_id',
      'serving_size', 'serving_unit', 'serving_label', 'nutrition', 'g_per_cup',
      // Variant feature (Issue #4). Both are FKs back into pantry_items;
      // declared here so the differential sync push includes them and
      // pull translates the server ids to local ids via the same
      // pantry_items lookup the shopping_list uses for pantry_id.
      'generic_parent_id', 'nutrition_source_variant_id',
    ],
    parents: {
      category_id: 'pantry_categories',
      generic_parent_id: 'pantry_items',
      nutrition_source_variant_id: 'pantry_items',
    },
    softDelete: true,
  },
  cook_diary: {
    cols: ['recipe_id', 'date', 'kind', 'servings', 'notes', 'photo_url', 'photos', 'meal_type', 'rating'],
    parents: { recipe_id: 'recipes' },
    softDelete: true,
  },
  shopping_list: {
    cols: ['name', 'quantity', 'unit', 'aisle', 'checked', 'pantry_id', 'recipe_id', 'sort_order'],
    parents: { pantry_id: 'pantry_items', recipe_id: 'recipes' },
    softDelete: true,
  },
  recipe_comments: {
    cols: ['recipe_id', 'parent_id', 'body'],
    parents: { recipe_id: 'recipes', parent_id: 'recipe_comments' },
    softDelete: true,
  },
  ai_chat_history: {
    cols: ['role', 'content'],
    parents: {},
    softDelete: false,
  },
};

// The fields lib/field-merge.js merges are exactly the columns a device
// writes (plus deleted_at): a column added to one and not the other fails
// here, at start, rather than merging the wrong fields.
for (const [t, spec] of Object.entries(TABLES)) {
  const want = [...spec.cols, ...(spec.softDelete ? ['deleted_at'] : [])].join(',');
  if ((SYNC_FIELDS[t] || []).join(',') !== want) throw new Error(`lib/sync-fields.js is out of step with routes/sync.js for ${t}`);
}

// Tables a device deletes rows from outright (no deleted_at column).
const DELETABLE = ['recipe_categories', 'pantry_categories', 'custom_units', 'ai_chat_history'];

// Process tables in dependency order so parents land first within a
// single push and child FKs can resolve against the freshly-minted ids.
const PUSH_ORDER = [
  'recipe_categories', 'pantry_categories', 'custom_units', 'cookbooks',
  'recipes', 'pantry_items',
  'cook_diary', 'shopping_list', 'recipe_comments',
  'ai_chat_history',
];

// ── POST /push ────────────────────────────────────────────────────────
router.post('/push', wrap((req, res) => {
  const u = uid(req);
  const tables = req.body?.tables || {};
  // Apps that send fk_ids: 'server' put the server's own ids in id
  // columns, apart from those listed in a row's _local_fks. Older apps
  // send the phone's ids.
  const serverIds = req.body?.fk_ids === 'server';
  // How far the device's clock is behind the server's, so its edit times
  // compare with the server's. Apps that say what time it is on them can be
  // judged: the newer edit stays. Older apps' edits go in as before.
  const offsetMs = clockOffset(req.body?.client_now, req.receivedAt);
  const modern = typeof req.body?.client_now === 'string' && Number.isFinite(utcMs(req.body.client_now));
  // Recipes whose cooks changed in this push: their cook counts are
  // counted again from the diary afterwards, as the REST routes do.
  const cooksChanged = new Set();
  // Pantry items written in this push: their variant tree is checked after.
  const pantryTouched = new Set();

  const idMaps = {};       // tableName → { client_id: server_id }
  const results = {};
  // Webhook events seen in this push. Collected per table and only kept
  // once that table's transaction commits, then sent after the response
  // is built, so a rolled-back write never announces itself.
  const webhookEvents = [];
  let shoppingNewlyChecked = false;

  for (const name of PUSH_ORDER) {
    if (!Array.isArray(tables[name])) { results[name] = []; continue; }
    const spec = TABLES[name];
    const rows = tables[name];
    idMaps[name] = idMaps[name] || {};
    // A table that fails rolls back, and so do the ids it handed out.
    const idsBefore = { ...idMaps[name] };
    results[name] = [];

    const insertSql = _buildInsertSql(name, spec);
    const updateSql = _buildUpdateSql(name, spec);
    const tableEvents = [];
    let tableNewlyChecked = false;

    const txn = db.transaction(() => {
      for (const row of rows) {
        const translated = _translateParents(row, spec, idMaps, u, serverIds);
        if (!translated) continue; // its parent didn't go in; the app sends it again next sync
        if (name === 'cookbooks') _translateFilterCategory(translated, idMaps, serverIds);
        let values = spec.cols.map(c => _coerce(translated[c]));
        const val = (col) => values[spec.cols.indexOf(col)];
        const deleted = spec.softDelete && translated.deleted_at != null;
        // A row the app made, sent before (two syncs at once, a retry, an
        // answer lost on the way back): the one made then, as an edit of it.
        const createKey = row.server_id ? null : cleanCreateKey(row.client_key);
        if (createKey) {
          const made = findByCreateKey(name, u, createKey);
          if (made) row.server_id = made.id;
        }
        // A name the account already has (a category, cookbook or unit made
        // on two devices, or kept on the phone through a reconnect): that
        // one, as an edit of it. A second would break the unique name and
        // stop every push of the table.
        const natural = NATURAL_KEYS[name];
        if (!row.server_id && natural && translated[natural] != null) {
          const same = db.prepare(`SELECT id FROM ${name} WHERE ${userClause(u)} AND ${natural} = ?`).get(...userArgs(u), translated[natural]);
          if (same) row.server_id = same.id;
        }

        if (row.server_id) {
          // Fetch enough of the existing row to (a) authorize the write
          // and (b) fuel the recipes empty-guard.
          const existing = db.prepare(
            `SELECT * FROM ${name} WHERE id = ?`
          ).get(row.server_id);
          if (!existing) continue;
          if ((u == null && existing.user_id != null) || (u != null && existing.user_id !== u)) continue;
          if (name === 'recipes') {
            values = _guardRecipeValuesForUpdate(values, spec, existing);
          }
          // The edit's time on the server's clock. Apps that stamp edits with
          // the server's clock as they're made say so (edit_clock); older
          // rows are moved by the offset measured on this push. A delete on
          // an older phone doesn't move updated_at: the delete is the edit.
          const corrected = row.edit_clock === 'server';
          const editedAt = editTime(
            !corrected && translated.deleted_at != null && existing.deleted_at == null
              ? latestTime(translated.updated_at, translated.deleted_at) : translated.updated_at,
            corrected ? 0 : offsetMs);
          if (modern) {
            // Field by field (lib/field-merge.js): what the app says it
            // changed on the copy it had (changed, server_synced_at).
            const incoming = Object.fromEntries(spec.cols.map((c, i) => [c, values[i]]));
            if (spec.softDelete) incoming.deleted_at = translated.deleted_at ?? null;
            const opts = {
              base: row.server_synced_at,
              changed: Array.isArray(row.changed) ? new Set(row.changed) : null,
              editedAt,
            };
            const m = name === 'recipes'
              ? mergeRecipe(existing, incoming, opts)
              : mergeFields(existing, incoming, { ...opts, fields: SYNC_FIELDS[name], groups: SYNC_GROUPS[name] });
            for (const k of m.keep || []) {
              saveRecipeVersion(row.server_id, existing.user_id, k.row, {
                reason: k.reason,
                editedBy: k.side === 'incoming' ? (u ?? existing.user_id) : (existing.last_edited_by ?? existing.user_id),
              });
            }
            if (m.write) {
              const cols = m.applied;
              // The owner's own edit: content that goes in is theirs.
              const byOwner = name === 'recipes' && cols.some(c => VERSION_FIELDS.includes(c));
              db.prepare(
                `UPDATE ${name} SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ?${byOwner ? ', last_edited_by = NULL' : ''} WHERE id = ?`
              ).run(...cols.map(c => m.row[c] ?? null), m.updatedAt, row.server_id);
              stampFields(name, row.server_id, cols, m.fieldAt);
            } else if (m.devicePulls) {
              // Nothing of the edit stays: the copy here is stamped again so
              // the device's next pull brings it down. Its edit times stay.
              db.prepare(`UPDATE ${name} SET synced_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = ?`).run(row.server_id);
            }
            results[name].push({
              client_id: row.client_id, server_id: row.server_id,
              ...(m.write ? { ..._syncedAt(name, row.server_id), updated_at: m.updatedAt } : {}),
              // What the device has isn't what stays here: it pulls it down.
              ...(m.devicePulls ? { kept: 'server' } : {}),
            });
            idMaps[name][row.client_id] = row.server_id;
            if (m.write && !deleted) {
              if (name === 'cook_diary' && existing.kind !== 'cooked' && m.row.kind === 'cooked') {
                tableEvents.push(_mealCookedEvent(c => (c in m.row ? m.row[c] : existing[c])));
              } else if (name === 'pantry_items' && _on(existing.in_stock) && !_on(m.row.in_stock)) {
                tableEvents.push(['pantry.out_of_stock', { pantry_item_id: row.server_id, name: m.row.name ?? existing.name }]);
              } else if (name === 'shopping_list' && !_on(existing.checked) && _on(m.row.checked)) {
                tableNewlyChecked = true;
              }
            }
            if (name === 'cook_diary' && m.write) { cooksChanged.add(existing.recipe_id); cooksChanged.add(m.row.recipe_id); }
            if (name === 'pantry_items' && m.write) pantryTouched.add(row.server_id);
            continue;
          }
          // Older apps can't say what their copy was or when, by the
          // server's clock: their edit goes in, as before. For a recipe,
          // the copy it replaces is kept, without pointing at it, in case
          // it was someone else's newer edit.
          if (name === 'recipes' && existing.deleted_at == null && translated.deleted_at == null) {
            const incoming = Object.fromEntries(spec.cols.map((c, i) => [c, values[i]]));
            incoming.category_id ??= existing.category_id; // as the UPDATE's COALESCE
            if (!sameContent(incoming, existing)) {
              saveRecipeVersion(row.server_id, existing.user_id, existing, { reason: 'replaced', editedBy: existing.last_edited_by ?? existing.user_id });
            }
          }
          // deleted_at only on tables that have one (categories and
          // units don't), or the statement has one value too many.
          db.prepare(updateSql).run(
            ...values,
            editedAt,
            ...(spec.softDelete ? [translated.deleted_at ?? null] : []),
            row.server_id
          );
          // The edit time stored, for the device to know this row's echo.
          results[name].push({ client_id: row.client_id, server_id: row.server_id, ..._syncedAt(name, row.server_id), updated_at: editedAt });
          idMaps[name][row.client_id] = row.server_id;
          // Same transitions the REST routes fire on. The Android app
          // saves through this push, so without these its changes never
          // reached webhooks.
          if (!deleted) {
            if (name === 'cook_diary' && existing.kind !== 'cooked' && val('kind') === 'cooked') {
              tableEvents.push(_mealCookedEvent(val));
            } else if (name === 'pantry_items' && _on(existing.in_stock) && !_on(val('in_stock'))) {
              tableEvents.push(['pantry.out_of_stock', { pantry_item_id: row.server_id, name: val('name') ?? existing.name }]);
            } else if (name === 'shopping_list' && !_on(existing.checked) && _on(val('checked'))) {
              tableNewlyChecked = true;
            }
          }
          if (name === 'cook_diary') { cooksChanged.add(existing.recipe_id); cooksChanged.add(val('recipe_id')); }
        } else {
          const insertedAt = editTime(translated.updated_at, row.edit_clock === 'server' ? 0 : offsetMs);
          const info = db.prepare(insertSql).run(
            u,
            ...values,
            insertedAt,
            ...(spec.softDelete ? [translated.deleted_at ?? null] : [])
          );
          const serverId = info.lastInsertRowid;
          setCreateKey(name, serverId, createKey);
          results[name].push({ client_id: row.client_id, server_id: serverId, ..._syncedAt(name, serverId), updated_at: insertedAt });
          if (name === 'cook_diary') cooksChanged.add(val('recipe_id'));
          if (name === 'pantry_items' && modern) pantryTouched.add(serverId);
          idMaps[name][row.client_id] = serverId;
          // Auto-share fan-out for native-created recipes. The REST
          // POST /api/recipes route calls this same helper; without
          // it here, Android-native recipe creates never fanned out
          // to Kitchen members. Same fix rules: idempotent, no-op
          // when the user has no auto_share kitchens.
          if (name === 'recipes') {
            try { autoShareNewRecipe(u, serverId); }
            catch (e) { console.warn('[sync] auto-share fan-out failed for recipe', serverId, e?.message); }
          }
          if (name === 'cook_diary' && !deleted && val('kind') === 'cooked') {
            tableEvents.push(_mealCookedEvent(val));
          }
        }
      }
    });
    try {
      txn();
      webhookEvents.push(...tableEvents);
      if (tableNewlyChecked) shoppingNewlyChecked = true;
    }
    catch (e) { results[name] = { error: e.message || 'push failed' }; idMaps[name] = idsBefore; }
  }

  // Two devices' variant links, each fine alone, can break the tree's rules
  // together: the newer stays (lib/pantry-tree.js).
  if (pantryTouched.size) {
    try { db.transaction(() => repairVariantTree([...pantryTouched]))(); } catch (e) { console.warn('[sync] variant tree:', e?.message); }
  }

  // Cook counts follow the diary, as when cooks are logged on the web: a
  // count sent by a device could be older than cooks logged since.
  try {
    const own = db.prepare(`SELECT 1 FROM recipes WHERE id = ? AND ${userClause(u)}`);
    const stats = db.prepare(`SELECT COUNT(*) AS n, MAX(date) AS last FROM cook_diary WHERE recipe_id = ? AND deleted_at IS NULL AND kind = 'cooked'`);
    const set = db.prepare(`UPDATE recipes SET cook_count = ?, last_cooked_at = ? WHERE id = ? AND (cook_count IS NOT ? OR last_cooked_at IS NOT ?)`);
    for (const id of cooksChanged) {
      if (id == null || !own.get(id, ...userArgs(u))) continue;
      const st = stats.get(id);
      set.run(st.n || 0, st.last || null, id, st.n || 0, st.last || null);
    }
  } catch (e) { console.warn('[sync] cook counts:', e?.message); }

  // ── disabled_units: replace-by-set ────────────────────────────────
  //
  // Option E guard: only DELETE-then-INSERT when the client has actually
  // sent entries. An empty array from a stale/wiped client used to
  // silently truncate the user's whole disabled-units set. If the client
  // genuinely wants to clear the set, the app can add an explicit flag
  // later — no current UI path does this.
  if (Array.isArray(tables.disabled_units) && tables.disabled_units.length > 0) {
    const txn = db.transaction(() => {
      db.prepare(`DELETE FROM disabled_units WHERE ${userClause(u)}`).run(...userArgs(u));
      const ins = db.prepare(`INSERT OR IGNORE INTO disabled_units (user_id, abbr) VALUES (?, ?)`);
      for (const r of tables.disabled_units) ins.run(u, r.abbr);
    });
    try { txn(); } catch {}
  }

  // ── Deletes from the device ─────────────────────────────────────────
  // Rows the device removed outright, by server id: categories, units
  // and chat (no deleted_at), and links taken out of a cookbook (the
  // link push only adds). Applied before the links below, so a link
  // taken out and put back in on the phone ends up in. Same effect as
  // the REST deletes: a
  // category's recipes and pantry items keep going, without it.
  const deletes = req.body?.deletes;
  const deleted = {};
  if (serverIds && deletes && typeof deletes === 'object') {
    const ids = v => (Array.isArray(v) ? v : []).map(n => parseInt(n, 10)).filter(Number.isFinite);
    const txn = db.transaction(() => {
      for (const t of DELETABLE) {
        const list = ids(deletes[t]);
        const del = db.prepare(`DELETE FROM ${t} WHERE id = ? AND ${userClause(u)}`);
        for (const id of list) del.run(id, ...userArgs(u));
        if (list.length) deleted[t] = list.length;
      }
      const links = Array.isArray(deletes.recipe_cookbook_links) ? deletes.recipe_cookbook_links : [];
      const own = db.prepare(`SELECT 1 FROM cookbooks WHERE id = ? AND ${userClause(u)}`);
      const del = db.prepare(`DELETE FROM recipe_cookbook_links WHERE cookbook_id = ? AND recipe_id = ?`);
      for (const l of links) {
        const cb = parseInt(l?.cookbook_id, 10), r = parseInt(l?.recipe_id, 10);
        if (Number.isFinite(cb) && Number.isFinite(r) && own.get(cb, ...userArgs(u))) del.run(cb, r);
      }
      if (links.length) deleted.recipe_cookbook_links = links.length;
    });
    // Kept by the device until the server answers `deleted`.
    try { txn(); } catch (e) { for (const k of Object.keys(deleted)) delete deleted[k]; console.warn('[sync] deletes failed:', e?.message); }
  }

  // ── recipe_cookbook_links: translate FKs, replace per cookbook ────
  if (Array.isArray(tables.recipe_cookbook_links)) {
    // Same rules as the rows above: ids are mapped, and a link only goes
    // into this account's own cookbook, to a recipe it may add there
    // (its own, or one shared with it, as POST /api/cookbooks/:id/recipes).
    const linkSpec = { parents: { cookbook_id: 'cookbooks', recipe_id: 'recipes' } };
    const translated = tables.recipe_cookbook_links
      .map(r => _translateParents({ ...r }, linkSpec, idMaps, u, serverIds, { recipes: _recipeLinkable, cookbooks: _ownsRow }))
      .filter(r => r && r.cookbook_id && r.recipe_id)
      .map(r => ({ cookbook_id: r.cookbook_id, recipe_id: r.recipe_id, sort_order: r.sort_order ?? 0 }));
    // Option E guard (2026-08-11): additive-only. Prior behavior
    // DELETE-then-INSERTed all links for every cookbook in the
    // payload, so a stale client whose local cache had fewer links
    // for cookbook X than the server would truncate the server's
    // set on push. Removing a link from a cookbook now needs the
    // explicit `DELETE /api/cookbooks/:id/links/:recipe_id` route;
    // sync push only adds. Insertion order per link is preserved via
    // sort_order on the row.
    const txn = db.transaction(() => {
      // A link already there takes the device's order: devices that send
      // fk_ids send only links added or reordered on them.
      const ins = db.prepare(serverIds
        ? `INSERT INTO recipe_cookbook_links (cookbook_id, recipe_id, sort_order) VALUES (?, ?, ?)
           ON CONFLICT(cookbook_id, recipe_id) DO UPDATE SET sort_order = excluded.sort_order`
        : `INSERT OR IGNORE INTO recipe_cookbook_links (cookbook_id, recipe_id, sort_order) VALUES (?, ?, ?)`
      );
      for (const r of translated) ins.run(r.cookbook_id, r.recipe_id, r.sort_order);
    });
    try { txn(); } catch {}
  }

  // ── user_settings: key-value, server-side already has its own table.
  if (Array.isArray(req.body?.settings)) {
    const ins = db.prepare(
      `INSERT INTO user_settings (user_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    );
    const txn = db.transaction(() => {
      for (const s of req.body.settings) {
        ins.run(u, s.key, typeof s.value === 'string' ? s.value : JSON.stringify(s.value), s.updated_at || _now());
      }
    });
    try { txn(); } catch {}
  }

  res.json({ tables: results, deleted, clock_offset_ms: offsetMs });

  try {
    for (const [event, data] of webhookEvents) dispatchWebhookEvent(u, event, data);
    // One completion event per push, however many items it checked,
    // and only when the list is now fully checked (as the REST route).
    if (shoppingNewlyChecked) {
      const remaining = db.prepare(
        `SELECT COUNT(*) AS n FROM shopping_list WHERE ${userClause(u)} AND deleted_at IS NULL AND checked = 0`
      ).get(...userArgs(u));
      const total = db.prepare(
        `SELECT COUNT(*) AS n FROM shopping_list WHERE ${userClause(u)} AND deleted_at IS NULL`
      ).get(...userArgs(u));
      if (remaining.n === 0 && total.n > 0) {
        dispatchWebhookEvent(u, 'shopping_list.completed', { items_count: total.n });
      }
    }
  } catch (e) { /* never let a webhook failure block the save */ }
}));

function _on(v) {
  return v === 1 || v === true || v === '1' || v === 'true';
}

function _mealCookedEvent(val) {
  const recipeId = val('recipe_id') ?? null;
  const recipe = recipeId != null ? db.prepare(`SELECT name FROM recipes WHERE id = ?`).get(recipeId) : null;
  return ['meal.cooked', {
    date: val('date'), recipe_id: recipeId, recipe_name: recipe?.name ?? null,
    kind: 'cooked', servings: val('servings') ?? null, rating: val('rating') ?? null,
    meal_type: val('meal_type') ?? null,
  }];
}

// ── GET /pull ─────────────────────────────────────────────────────────
router.get('/pull', wrap((req, res) => {
  const u = uid(req);
  const since = (typeof req.query.since === 'string' && req.query.since) || '1970-01-01T00:00:00';
  // Apps that keep which copy of each row they have ask for its stamp.
  // Older apps write every key of a row into their own table, so it's
  // only sent when asked for.
  const withSyncedAt = req.query.synced_at === '1';
  // Server time, taken before the queries, so a write racing this pull
  // is picked up by the next one (>= below makes an overlap harmless:
  // pulls are upserts). Rows are picked by synced_at, the server's
  // time of the write, not updated_at, the device's time of the edit.
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');

  const out = {};
  for (const [name, spec] of Object.entries(TABLES)) {
    // created_at is included so the client can preserve the real
    // creation timestamp. Without it, dbApplyPull's INSERT omits the
    // column and SQLite's local `DEFAULT (datetime('now'))` stamps
    // every synced row with the pull-time clock — every recipe ends
    // up looking like it was created on first-connect day.
    const cols = ['id', ...spec.cols, ...(spec.pullCols || []), 'created_at', 'updated_at'];
    if (spec.softDelete) cols.push('deleted_at');
    // And the key the app made a row with (lib/create-keys.js), so a row
    // whose push answer was lost is known as its own when it comes down.
    if (withSyncedAt) cols.push('synced_at', 'client_key');
    // Sort self-referencing tables so parents come before children in
    // the pull payload. The client's dbApplyPull scans server_id →
    // local_id fresh for each row, so a parent that arrives before its
    // child is available for FK translation on the child. Without
    // this ordering, a variant row that lands before its generic
    // parent in the payload would translate the parent FK to null and
    // the relationship silently disappears on the first sync after
    // it was attached (SQLite orders NULLs first in ASC by default,
    // so top-level parents naturally lead).
    const selfRef = Object.entries(spec.parents || {})
      .find(([, parentTable]) => parentTable === name);
    const orderBy = selfRef ? ` ORDER BY ${selfRef[0]} ASC, id ASC` : '';
    out[name] = db.prepare(
      `SELECT ${cols.join(', ')} FROM ${name}
        WHERE ${userClause(u)} AND synced_at >= ?${orderBy}`
    ).all(...userArgs(u), since);
  }

  // Replace-sets: small enough to ship in full every pull.
  out.disabled_units = db.prepare(
    `SELECT abbr FROM disabled_units WHERE ${userClause(u)}`
  ).all(...userArgs(u));
  out.recipe_cookbook_links = db.prepare(
    `SELECT l.cookbook_id, l.recipe_id, l.sort_order
       FROM recipe_cookbook_links l
       JOIN cookbooks c ON c.id = l.cookbook_id
      WHERE ${userClause(u).replace(/user_id/g, 'c.user_id')}`
  ).all(...userArgs(u));

  // Rows deleted outright since the last pull, for the device to drop.
  out.deletions = {};
  // Ids never come back in normal use (AUTOINCREMENT); one that exists
  // again was put back by a restore, so it isn't gone.
  for (const r of db.prepare(
    `SELECT table_name, row_id FROM sync_deletions WHERE ${userClause(u)} AND synced_at >= ?`
  ).all(...userArgs(u), since)) {
    if (!DELETABLE.includes(r.table_name)) continue;
    if (db.prepare(`SELECT 1 FROM ${r.table_name} WHERE id = ?`).get(r.row_id)) continue;
    (out.deletions[r.table_name] ||= []).push(r.row_id);
  }

  // Settings: only the keys that changed since the last pull.
  out.settings = db.prepare(
    `SELECT key, value, updated_at FROM user_settings
      WHERE ${userClause(u)} AND synced_at >= ?`
  ).all(...userArgs(u), since);

  res.json({ now, tables: out });
}));

// ── Helpers ──────────────────────────────────────────────────────────

function _now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// The server's stamp of a row just written, for the device to keep as the
// copy it has.
function _syncedAt(name, id) {
  const r = db.prepare(`SELECT synced_at FROM ${name} WHERE id = ?`).get(id);
  return r?.synced_at ? { synced_at: r.synced_at } : {};
}


function _coerce(v) {
  if (v === undefined) return null;
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return v;
}

// Whether account u may point a row at this parent.
function _ownsRow(table, id, u) {
  const p = db.prepare(`SELECT user_id FROM ${table} WHERE id = ?`).get(id);
  return !!p && ((u == null && p.user_id == null) || (u != null && p.user_id === u));
}
// A recipe: its own, or one shared with it (comments, cooked entries and
// shopping items can be about a shared recipe).
function _recipeLinkable(table, id, u) {
  if (_ownsRow(table, id, u)) return true;
  return u != null && !!db.prepare(
    `SELECT 1 FROM recipe_shares WHERE recipe_id = ? AND grantee_id = ?`
  ).get(id, u);
}
const PARENT_CHECKS = { recipes: _recipeLinkable };

// Id columns in a pushed row, as the server's ids. A parent created in
// the same push is mapped from the app's id. Any other id must be a row
// this account may point at, or it's dropped: an id from the phone's own
// numbering (older apps) or another account's row never links across.
// Returns null when a parent created in this push didn't go in, so the
// row waits for the next sync.
function _translateParents(row, spec, idMaps, u, serverIds, checks = PARENT_CHECKS) {
  if (!spec.parents) return row;
  const out = { ...row };
  const local = new Set(Array.isArray(row._local_fks) ? row._local_fks : []);
  for (const [fk, parentTable] of Object.entries(spec.parents)) {
    const raw = out[fk];
    if (raw == null) continue;
    const mapped = idMaps[parentTable]?.[raw];
    if (local.has(fk)) {
      if (!mapped) return null;
      out[fk] = mapped;
      continue;
    }
    // Older apps: a parent from this same push is still found by its
    // app id, as before.
    if (!serverIds && mapped) { out[fk] = mapped; continue; }
    const ok = (checks[parentTable] || _ownsRow)(parentTable, raw, u);
    if (!ok) out[fk] = null;
  }
  return out;
}

// A smart cookbook's category, sent as the app's id when the category
// went up in this same push.
function _translateFilterCategory(row, idMaps, serverIds) {
  if (!row._local_filter_category && serverIds) return;
  row.smart_filter_json = mapSmartFilterCategory(row.smart_filter_json, id => idMaps.recipe_categories?.[id]);
}

function _buildInsertSql(table, spec) {
  const cols = ['user_id', ...spec.cols, 'updated_at'];
  if (spec.softDelete) cols.push('deleted_at');
  const ph = cols.map(() => '?').join(', ');
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph})`;
}

function _buildUpdateSql(table, spec) {
  // FK columns keep the server's value when the client pushes NULL.
  // The client always sends its full row (SELECT * on pending rows),
  // so a mobile push whose local row hasn't yet picked up a PWA-side
  // attach would clobber the server's newly-set FK with NULL. COALESCE
  // preserves the server's value unless the client explicitly sends a
  // non-null. Detaches still go through the explicit PUT route
  // (server/routes/pantry.js), which uses body.X !== undefined
  // semantics and correctly writes NULL when asked.
  const fkCols = new Set(Object.keys(spec.parents || {}));
  const setCols = spec.cols.map(c => (
    fkCols.has(c) ? `${c} = COALESCE(?, ${c})` : `${c} = ?`
  ));
  setCols.push('updated_at = ?');
  if (spec.softDelete) setCols.push('deleted_at = ?');
  return `UPDATE ${table} SET ${setCols.join(', ')} WHERE id = ?`;
}

export default router;
