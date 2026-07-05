/**
 * db-native.js — SQLite database layer for the Capacitor native app.
 *
 * Uses @capacitor-community/sqlite to provide a local SQLite database that
 * mirrors the CookTrace server schema. All data in standalone (local-only)
 * mode lives here. In server-connected mode the same DB acts as an
 * offline-first cache that the differential sync engine reconciles with
 * the configured server.
 *
 * The local user_id is always 1 (single-user standalone semantics). When
 * connecting to a server the user_id stays 1 locally; the sync layer maps
 * to whatever user the auth token resolves to on the server side.
 *
 * Pattern lifted from /home/papa/Documents/claude_code/nutritrace/src/lib/db-native.js
 * — same SQLiteConnection setup, same SCHEMA constant approach, same
 * sync_status / server_id columns on every syncable table. Adapted for
 * CookTrace's domain tables (recipes, pantry_items, cook_diary, etc.).
 */

import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { isNative } from './platform.js';

export const LOCAL_USER_ID = 1;
const DB_NAME = 'cooktrace_local';
const DB_VERSION = 1;

const sqlite = new SQLiteConnection(CapacitorSQLite);
let _db = null;
let _initPromise = null;

// ── Schema ────────────────────────────────────────────────────────────
// Mirrors server/db.js with every ALTER baked into the CREATE so a
// fresh local DB lands at the same shape the live server would land at
// after every migration ran. Adds server_id + sync_status columns on
// every syncable table so the differential sync engine knows which
// rows are dirty and where they map to upstream.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS recipes (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id            INTEGER,
    user_id              INTEGER DEFAULT 1,
    name                 TEXT NOT NULL,
    description          TEXT,
    img_url              TEXT,
    servings             INTEGER DEFAULT 2,
    prep_minutes         INTEGER,
    cook_minutes         INTEGER,
    total_minutes        INTEGER,
    rest_minutes         INTEGER,
    ingredients          TEXT NOT NULL DEFAULT '[]',
    steps                TEXT NOT NULL DEFAULT '[]',
    tags                 TEXT NOT NULL DEFAULT '[]',
    tools                TEXT NOT NULL DEFAULT '[]',
    source_url           TEXT,
    video_url            TEXT,
    notes                TEXT,
    visibility           TEXT NOT NULL DEFAULT 'private',
    rating               INTEGER,
    yield_text           TEXT,
    last_cooked_at       TEXT,
    cook_count           INTEGER NOT NULL DEFAULT 0,
    nutrition            TEXT NOT NULL DEFAULT '{}',
    created_by_username  TEXT,
    favorite             INTEGER NOT NULL DEFAULT 0,
    category_id          INTEGER,
    share_token          TEXT,
    created_at           TEXT DEFAULT (datetime('now')),
    updated_at           TEXT DEFAULT (datetime('now')),
    deleted_at           TEXT DEFAULT NULL,
    sync_status          TEXT DEFAULT 'synced'
  );
  CREATE INDEX IF NOT EXISTS idx_recipes_user    ON recipes(user_id);
  CREATE INDEX IF NOT EXISTS idx_recipes_updated ON recipes(updated_at);
  CREATE INDEX IF NOT EXISTS idx_recipes_deleted ON recipes(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_recipes_server  ON recipes(server_id);
  CREATE INDEX IF NOT EXISTS idx_recipes_sync    ON recipes(sync_status);
  CREATE INDEX IF NOT EXISTS idx_recipes_category ON recipes(category_id);

  CREATE TABLE IF NOT EXISTS pantry_items (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id                   INTEGER,
    user_id                     INTEGER DEFAULT 1,
    name                        TEXT NOT NULL,
    brand                       TEXT,
    barcode                     TEXT,
    in_stock                    INTEGER NOT NULL DEFAULT 1,
    quantity                    REAL,
    unit                        TEXT,
    expires_on                  TEXT,
    nt_food_id                  INTEGER,
    img_url                     TEXT,
    notes                       TEXT,
    category                    TEXT,
    category_id                 INTEGER,
    serving_size                REAL,
    serving_unit                TEXT,
    serving_label               TEXT,
    nutrition                   TEXT,
    g_per_cup                   REAL,
    generic_parent_id           INTEGER,
    nutrition_source_variant_id INTEGER,
    created_at                  TEXT DEFAULT (datetime('now')),
    updated_at                  TEXT DEFAULT (datetime('now')),
    deleted_at                  TEXT DEFAULT NULL,
    sync_status                 TEXT DEFAULT 'synced'
  );
  CREATE INDEX IF NOT EXISTS idx_pantry_user           ON pantry_items(user_id);
  CREATE INDEX IF NOT EXISTS idx_pantry_updated        ON pantry_items(updated_at);
  CREATE INDEX IF NOT EXISTS idx_pantry_deleted        ON pantry_items(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_pantry_server         ON pantry_items(server_id);
  CREATE INDEX IF NOT EXISTS idx_pantry_sync           ON pantry_items(sync_status);
  CREATE INDEX IF NOT EXISTS idx_pantry_barcode        ON pantry_items(barcode);
  CREATE INDEX IF NOT EXISTS idx_pantry_category       ON pantry_items(category_id);
  -- idx_pantry_generic_parent is created by _migratePantryVariantColumns
  -- after the column has been added (or confirmed to exist). Putting it
  -- here was racing with the migration on existing local DBs whose
  -- pantry_items table predates the generic_parent_id column: the
  -- CREATE TABLE IF NOT EXISTS no-op'd, this index then errored with
  -- "no such column", and the whole multi-statement execute rolled
  -- back before the migration even got a chance to run.

  CREATE TABLE IF NOT EXISTS cook_diary (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id    INTEGER,
    user_id      INTEGER DEFAULT 1,
    recipe_id    INTEGER,
    date         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'cooked',
    servings     INTEGER,
    notes        TEXT,
    photo_url    TEXT,
    photos       TEXT,
    meal_type    TEXT,
    rating       INTEGER,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now')),
    deleted_at   TEXT DEFAULT NULL,
    sync_status  TEXT DEFAULT 'synced'
  );
  CREATE INDEX IF NOT EXISTS idx_cook_diary_user_date ON cook_diary(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_cook_diary_recipe    ON cook_diary(recipe_id);
  CREATE INDEX IF NOT EXISTS idx_cook_diary_server    ON cook_diary(server_id);
  CREATE INDEX IF NOT EXISTS idx_cook_diary_sync      ON cook_diary(sync_status);

  CREATE TABLE IF NOT EXISTS shopping_list (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id    INTEGER,
    user_id      INTEGER DEFAULT 1,
    name         TEXT NOT NULL,
    quantity     REAL,
    unit         TEXT,
    aisle        TEXT,
    checked      INTEGER NOT NULL DEFAULT 0,
    pantry_id    INTEGER,
    recipe_id    INTEGER,
    sort_order   INTEGER,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now')),
    deleted_at   TEXT DEFAULT NULL,
    sync_status  TEXT DEFAULT 'synced'
  );
  CREATE INDEX IF NOT EXISTS idx_shopping_user    ON shopping_list(user_id);
  CREATE INDEX IF NOT EXISTS idx_shopping_server  ON shopping_list(server_id);
  CREATE INDEX IF NOT EXISTS idx_shopping_sync    ON shopping_list(sync_status);

  CREATE TABLE IF NOT EXISTS recipe_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER,
    user_id     INTEGER DEFAULT 1,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    color       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    deleted_at  TEXT DEFAULT NULL,
    sync_status TEXT DEFAULT 'synced',
    UNIQUE(user_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_recipe_cat_server ON recipe_categories(server_id);
  CREATE INDEX IF NOT EXISTS idx_recipe_cat_sync   ON recipe_categories(sync_status);

  CREATE TABLE IF NOT EXISTS pantry_categories (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id      INTEGER,
    user_id        INTEGER DEFAULT 1,
    name           TEXT NOT NULL,
    slug           TEXT NOT NULL,
    icon           TEXT,
    color          TEXT,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    default_aisle  TEXT,
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now')),
    deleted_at     TEXT DEFAULT NULL,
    sync_status    TEXT DEFAULT 'synced',
    UNIQUE(user_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_pantry_cat_server ON pantry_categories(server_id);
  CREATE INDEX IF NOT EXISTS idx_pantry_cat_sync   ON pantry_categories(sync_status);

  CREATE TABLE IF NOT EXISTS custom_units (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER,
    user_id     INTEGER DEFAULT 1,
    abbr        TEXT NOT NULL,
    full_name   TEXT,
    category    TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    deleted_at  TEXT DEFAULT NULL,
    sync_status TEXT DEFAULT 'synced',
    UNIQUE(user_id, abbr)
  );
  CREATE INDEX IF NOT EXISTS idx_custom_units_server ON custom_units(server_id);
  CREATE INDEX IF NOT EXISTS idx_custom_units_sync   ON custom_units(sync_status);

  CREATE TABLE IF NOT EXISTS disabled_units (
    user_id  INTEGER DEFAULT 1,
    abbr     TEXT NOT NULL,
    PRIMARY KEY (user_id, abbr)
  );

  CREATE TABLE IF NOT EXISTS cookbooks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id         INTEGER,
    user_id           INTEGER DEFAULT 1,
    name              TEXT NOT NULL,
    slug              TEXT NOT NULL,
    description       TEXT,
    cover_image_url   TEXT,
    is_smart          INTEGER NOT NULL DEFAULT 0,
    smart_filter_json TEXT,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now')),
    deleted_at        TEXT DEFAULT NULL,
    sync_status       TEXT DEFAULT 'synced',
    UNIQUE(user_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_cookbooks_server ON cookbooks(server_id);
  CREATE INDEX IF NOT EXISTS idx_cookbooks_sync   ON cookbooks(sync_status);

  CREATE TABLE IF NOT EXISTS recipe_cookbook_links (
    cookbook_id  INTEGER NOT NULL,
    recipe_id    INTEGER NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    sync_status  TEXT DEFAULT 'synced',
    PRIMARY KEY (cookbook_id, recipe_id)
  );

  CREATE TABLE IF NOT EXISTS recipe_comments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id    INTEGER,
    user_id      INTEGER DEFAULT 1,
    recipe_id    INTEGER NOT NULL,
    parent_id    INTEGER,
    body         TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now')),
    updated_at   TEXT DEFAULT (datetime('now')),
    deleted_at   TEXT DEFAULT NULL,
    sync_status  TEXT DEFAULT 'synced'
  );
  CREATE INDEX IF NOT EXISTS idx_comments_recipe ON recipe_comments(recipe_id);
  CREATE INDEX IF NOT EXISTS idx_comments_server ON recipe_comments(server_id);
  CREATE INDEX IF NOT EXISTS idx_comments_sync   ON recipe_comments(sync_status);

  -- Settings table — every change writes here first (sync_status='pending'),
  -- the sync engine pushes pending rows to the server, server pull marks
  -- them 'synced' on success. PWA never touches this table.
  CREATE TABLE IF NOT EXISTS user_settings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER DEFAULT 1,
    key         TEXT NOT NULL,
    value       TEXT,
    updated_at  TEXT DEFAULT (datetime('now')),
    deleted_at  TEXT DEFAULT NULL,
    sync_status TEXT DEFAULT 'synced',
    UNIQUE(user_id, key)
  );

  CREATE TABLE IF NOT EXISTS ai_chat_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER,
    user_id     INTEGER DEFAULT 1,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    sync_status TEXT DEFAULT 'synced'
  );
  CREATE INDEX IF NOT EXISTS idx_chat_user ON ai_chat_history(user_id, created_at);

  -- Sync infrastructure tables — not mirrored on the server side.
  CREATE TABLE IF NOT EXISTS sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at   TEXT DEFAULT (datetime('now')),
    direction   TEXT NOT NULL,
    table_name  TEXT NOT NULL,
    record_id   INTEGER,
    status      TEXT NOT NULL DEFAULT 'ok',
    error       TEXT
  );
`;

// ── Initialisation ────────────────────────────────────────────────────
// Lazy on first use. Subsequent callers await the same promise so
// concurrent first-call requests don't race the connection setup.
//
// The plugin's `isConnection` check drifts from internal state on app
// reload (the JS side restarts but the plugin remembers the old
// connection). Don't trust it — always close any leftover connection
// first, then create fresh. Pattern lifted from NutriTrace's db-native
// after the same bug burned us there.
async function _closeAny() {
  await sqlite.checkConnectionsConsistency().catch(() => {});
  try { await sqlite.closeConnection(DB_NAME, true);  } catch {}
  try { await sqlite.closeConnection(DB_NAME, false); } catch {}
}

export async function getDb() {
  if (_db) return _db;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    if (!isNative) {
      throw new Error('db-native is only available in the Capacitor native shell');
    }
    await _closeAny();
    const conn = await sqlite.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false);
    await conn.open();
    await conn.execute(SCHEMA);
    _db = conn;
    return _db;
  })().catch(err => {
    // Reset so a retry from the catch path in main.js (or a later
    // explicit dbInit() call) doesn't get stuck on the failed promise.
    _initPromise = null;
    throw err;
  });
  return _initPromise;
}

/**
 * Boot hook. Called from main.js on native; no-op on web. Safe to call
 * multiple times; the underlying getDb() memoises.
 */
export async function dbInit() {
  if (!isNative) return;
  await getDb();
  await _migrateAiChatUpdatedAt();
  await _migratePantryVariantColumns();
  await _migrateRecipeTotalMinutes();
  await _migrateShoppingAisle();
  await _backfillShoppingNames();
}

// Shopping-list drag-to-reorder + pantry-category per-category
// default aisle (#6, #8). Older local DBs are missing the columns;
// ALTER them in place. Idempotent via PRAGMA table_info.
async function _migrateShoppingAisle() {
  try {
    const db = await getDb();
    const shopInfo = await db.query(`PRAGMA table_info(shopping_list)`);
    const shopCols = new Set((shopInfo?.values || []).map(c => c.name));
    if (!shopCols.has('sort_order')) {
      await db.run(`ALTER TABLE shopping_list ADD COLUMN sort_order INTEGER`);
    }
    const catInfo = await db.query(`PRAGMA table_info(pantry_categories)`);
    const catCols = new Set((catInfo?.values || []).map(c => c.name));
    if (!catCols.has('default_aisle')) {
      await db.run(`ALTER TABLE pantry_categories ADD COLUMN default_aisle TEXT`);
    }
  } catch { /* best-effort */ }
}

// Optional manual override for total time (recipes.total_minutes).
// Same idempotent ALTER pattern the variant columns use. Existing
// recipes stay auto (column NULL); a value here wins over prep+cook.
async function _migrateRecipeTotalMinutes() {
  try {
    const db = await getDb();
    const info = await db.query(`PRAGMA table_info(recipes)`);
    const cols = new Set((info?.values || []).map(c => c.name));
    if (!cols.has('total_minutes')) {
      await db.run(`ALTER TABLE recipes ADD COLUMN total_minutes INTEGER`);
    }
    if (!cols.has('rest_minutes')) {
      await db.run(`ALTER TABLE recipes ADD COLUMN rest_minutes INTEGER`);
    }
  } catch { /* best-effort */ }
}

// Mirror of the server migration: pantry_items gains generic_parent_id
// and nutrition_source_variant_id (Issue #4 / variants). Older local
// DBs are missing them — ALTER ADD here so dbApplyPull doesn't choke
// when the next server pull surfaces the new columns. Idempotent via
// PRAGMA table_info.
async function _migratePantryVariantColumns() {
  try {
    const db = await getDb();
    const info = await db.query(`PRAGMA table_info(pantry_items)`);
    const cols = new Set((info?.values || []).map(c => c.name));
    if (!cols.has('generic_parent_id')) {
      await db.run(`ALTER TABLE pantry_items ADD COLUMN generic_parent_id INTEGER`);
    }
    if (!cols.has('nutrition_source_variant_id')) {
      await db.run(`ALTER TABLE pantry_items ADD COLUMN nutrition_source_variant_id INTEGER`);
    }
    // Always create the index (idempotent). The column is guaranteed to
    // exist by this point — either CREATE TABLE in SCHEMA made it (fresh
    // install) or the ALTER above just added it. Putting the index in
    // SCHEMA itself races with the migration on upgrades, so it lives
    // here instead.
    await db.run(`CREATE INDEX IF NOT EXISTS idx_pantry_generic_parent ON pantry_items(generic_parent_id)`);
  } catch { /* best-effort */ }
}

// Mirror of the server migration: ai_chat_history used to only have
// created_at, but every other syncable table has updated_at and the
// sync pull writes that column into local rows. Older local DBs are
// missing it — ALTER ADD here so dbApplyPull doesn't choke with
// "no such column: updated_at". Idempotent via PRAGMA table_info.
//
// Some SQLite versions refuse non-constant DEFAULTs on ALTER ADD
// COLUMN (the Node.js binding in the Docker image crashed on
// DEFAULT (datetime('now'))). Use the same trigger pattern as the
// server — ALTER without default, backfill, then AFTER INSERT /
// AFTER UPDATE triggers populate updated_at automatically.
async function _migrateAiChatUpdatedAt() {
  try {
    const db = await getDb();
    const info = await db.query(`PRAGMA table_info(ai_chat_history)`);
    const has = (info?.values || []).some(c => c.name === 'updated_at');
    if (!has) {
      await db.run(`ALTER TABLE ai_chat_history ADD COLUMN updated_at TEXT`);
      await db.run(`UPDATE ai_chat_history SET updated_at = created_at WHERE updated_at IS NULL`);
    }
    await db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_ai_chat_history_updated_at_ins
      AFTER INSERT ON ai_chat_history
      FOR EACH ROW WHEN NEW.updated_at IS NULL
      BEGIN
        UPDATE ai_chat_history SET updated_at = datetime('now') WHERE id = NEW.id;
      END;
    `);
    await db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_ai_chat_history_updated_at_upd
      AFTER UPDATE ON ai_chat_history
      FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
      BEGIN
        UPDATE ai_chat_history SET updated_at = datetime('now') WHERE id = NEW.id;
      END;
    `);
  } catch { /* best-effort */ }
}

// One-time fix: title-case existing lowercase shopping_list names. Same
// migration as the server's; needed on Android local-mode because the
// rows were written before the title-case fix landed. Idempotent — only
// touches rows whose name === LOWER(name).
const _SHOPPING_MINOR = new Set([
  'a','an','and','as','at','but','by','for','if','in','nor','of','on','or','the','to','up','via',
]);
function _titleCaseLocal(raw) {
  if (raw == null) return raw;
  const s = String(raw).trim();
  if (!s) return s;
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s;
  return s.split(/(\s+)/).map((tok, i, arr) => {
    if (!tok.trim()) return tok;
    return tok.split('-').map((seg, segIdx) => {
      const lower = seg.toLowerCase();
      const isFirstToken = arr.slice(0, i).every(t => !t.trim());
      const isFirstSeg = segIdx === 0;
      if (_SHOPPING_MINOR.has(lower) && !(isFirstToken && isFirstSeg)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join('-');
  }).join('');
}
async function _backfillShoppingNames() {
  try {
    const db = await getDb();
    const rows = await db.query(
      `SELECT id, name FROM shopping_list
        WHERE name IS NOT NULL AND name = LOWER(name) AND deleted_at IS NULL`
    );
    const list = rows?.values || [];
    for (const row of list) {
      const cased = _titleCaseLocal(row.name);
      if (cased && cased !== row.name) {
        await db.run(`UPDATE shopping_list SET name = ?, sync_status = 'pending' WHERE id = ?`, [cased, row.id]);
      }
    }
  } catch { /* best-effort */ }
}

// ── Settings sync helpers ─────────────────────────────────────────────
// These existed as no-ops in the Phase A stub — we kept their shape so
// the JS layer (stores/settings.js) can call them without branching on
// `isNative`. Now they actually persist to the local user_settings
// table when running native.

export async function dbUpsertSetting(key, value) {
  if (!isNative) return;
  const db = await getDb();
  const v = value == null ? null : String(value);
  await db.run(
    `INSERT INTO user_settings (user_id, key, value, sync_status)
     VALUES (?, ?, ?, 'pending')
     ON CONFLICT(user_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = datetime('now'),
       sync_status = 'pending'`,
    [LOCAL_USER_ID, key, v]
  );
}

/**
 * Mark settings as synced AFTER a successful push, gated on updated_at
 * matching the snapshot. Closes a mid-flight write race: if the user
 * edited the same setting between the push snapshot and the push
 * response, the row's updated_at moved forward and the WHERE clause
 * won't match — the row stays pending and the next sync re-pushes the
 * fresh value. See NT commit b364c24 for the full race description.
 *
 * `rows` is an array of `{key, updated_at}` taken from the push snapshot.
 */
export async function dbMarkSettingsSynced(rows) {
  if (!isNative || !rows || rows.length === 0) return;
  const db = await getDb();
  for (const r of rows) {
    await db.run(
      `UPDATE user_settings SET sync_status = 'synced'
       WHERE user_id = ? AND key = ? AND updated_at = ?`,
      [LOCAL_USER_ID, r.key, r.updated_at]
    );
  }
}

export async function dbGetAllSettings() {
  if (!isNative) return {};
  const db = await getDb();
  const res = await db.query(
    `SELECT key, value FROM user_settings WHERE user_id = ? AND deleted_at IS NULL`,
    [LOCAL_USER_ID]
  );
  const out = {};
  for (const row of res?.values || []) out[row.key] = row.value;
  return out;
}

export async function dbGetPendingSettings() {
  if (!isNative) return [];
  const db = await getDb();
  const res = await db.query(
    `SELECT key, value FROM user_settings
      WHERE user_id = ? AND deleted_at IS NULL AND sync_status = 'pending'`,
    [LOCAL_USER_ID]
  );
  return res?.values || [];
}

// ── sync_meta helpers ─────────────────────────────────────────────────
// Used by platform.js (image_map cache) and the sync engine (last_pull
// timestamp). String-only — JSON callers stringify/parse themselves.

export async function dbGetMeta(key) {
  if (!isNative) return null;
  const db = await getDb();
  const res = await db.query(`SELECT value FROM sync_meta WHERE key = ?`, [key]);
  return res?.values?.[0]?.value ?? null;
}

export async function dbSetMeta(key, value) {
  if (!isNative) return;
  const db = await getDb();
  await db.run(
    `INSERT INTO sync_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value == null ? null : String(value)]
  );
}

// ── Sync helpers ──────────────────────────────────────────────────────
// Used by src/lib/sync.js to drive differential push/pull against
// /api/sync/{push,pull}. Each syncable table contributes pending rows;
// pulled rows are upserted by server_id with FK translation via the
// local server_id index on parent tables.

// Tables sync.js pushes. Keep in dependency order so server-side FK
// translation has parent ids minted by the time children push.
const SYNC_TABLES = [
  'recipe_categories', 'pantry_categories', 'custom_units', 'cookbooks',
  'recipes', 'pantry_items',
  'cook_diary', 'shopping_list', 'recipe_comments',
  'ai_chat_history',
];

/** All rows with sync_status='pending' grouped by table. */
export async function dbGetPendingChanges() {
  if (!isNative) return {};
  const db = await getDb();
  const out = {};
  for (const table of SYNC_TABLES) {
    const r = await db.query(
      `SELECT * FROM ${table} WHERE user_id = ? AND sync_status = 'pending'`,
      [LOCAL_USER_ID]
    );
    out[table] = r?.values || [];
  }
  // disabled_units: no sync_status — push the full set.
  const dis = await db.query(
    `SELECT abbr FROM disabled_units WHERE user_id = ?`,
    [LOCAL_USER_ID]
  );
  out.disabled_units = dis?.values || [];
  // recipe_cookbook_links: composite key. Push the full set; cheap.
  const links = await db.query(`SELECT cookbook_id, recipe_id, sort_order FROM recipe_cookbook_links`, []);
  out.recipe_cookbook_links = links?.values || [];
  return out;
}

/** Settings rows with sync_status='pending'. Separate because the sync
 *  endpoint takes a `settings` array, not a generic table. */
export async function dbGetPendingSettingsForPush() {
  if (!isNative) return [];
  const db = await getDb();
  const r = await db.query(
    `SELECT key, value, updated_at FROM user_settings
      WHERE user_id = ? AND deleted_at IS NULL AND sync_status = 'pending'`,
    [LOCAL_USER_ID]
  );
  return r?.values || [];
}

/**
 * Stamp the server_id on a freshly-pushed row and mark it synced.
 * Gated on updated_at matching the push snapshot so mid-flight edits
 * stay pending and get re-pushed next sync. See dbMarkSettingsSynced
 * for the full race description. If snapshotUpdatedAt is null (caller
 * didn't capture one), falls back to the old behaviour of stamping
 * unconditionally — but that path is unsafe and should be removed once
 * every caller is updated to pass the snapshot.
 */
export async function dbSetServerId(table, clientId, serverId, snapshotUpdatedAt = null) {
  if (!isNative || !table || !clientId) return;
  const db = await getDb();
  if (snapshotUpdatedAt) {
    await db.run(
      `UPDATE ${table} SET server_id = ?, sync_status = 'synced' WHERE id = ? AND updated_at = ?`,
      [serverId, clientId, snapshotUpdatedAt]
    );
    // If the row was edited mid-flight, the WHERE didn't match. Still stamp
    // the server_id (caller needs it for future PATCH/PUT routing), but
    // leave sync_status='pending' so the next push picks up the fresh value.
    await db.run(
      `UPDATE ${table} SET server_id = ? WHERE id = ? AND server_id IS NULL`,
      [serverId, clientId]
    );
  } else {
    await db.run(
      `UPDATE ${table} SET server_id = ?, sync_status = 'synced' WHERE id = ?`,
      [serverId, clientId]
    );
  }
}

/** Apply pulled rows from /api/sync/pull. For each table, upsert by
 *  server_id. Parent-table FK columns (category_id, recipe_id, etc.)
 *  are translated from server ids to local ids via the per-table
 *  server_id index.
 */
export async function dbApplyPull(payload) {
  if (!isNative || !payload?.tables) return;
  const db = await getDb();
  const parents = {
    category_id: ['recipe_categories', 'pantry_categories'],
    recipe_id: ['recipes'],
    pantry_id: ['pantry_items'],
    cookbook_id: ['cookbooks'],
    parent_id: ['recipe_comments'],
    // Variant feature (Issue #4). Both FKs point back at pantry_items;
    // translate server ids to local ids on pull so a parent or
    // nutrition-source variant referenced before its own row arrives
    // resolves correctly across the same pull payload.
    generic_parent_id: ['pantry_items'],
    nutrition_source_variant_id: ['pantry_items'],
  };

  // Build a per-table { server_id → local_id } map by scanning the
  // local server_id column once. Re-scanned per pull so it picks up
  // ids minted by parent-table upserts earlier in the same pull.
  async function mapFor(table) {
    const r = await db.query(`SELECT id, server_id FROM ${table} WHERE server_id IS NOT NULL`, []);
    const m = new Map();
    for (const row of r?.values || []) m.set(row.server_id, row.id);
    return m;
  }

  async function translateFK(value, candidates) {
    if (value == null) return null;
    for (const t of candidates) {
      const m = await mapFor(t);
      if (m.has(value)) return m.get(value);
    }
    return null;
  }

  for (const [table, rows] of Object.entries(payload.tables)) {
    if (!Array.isArray(rows)) continue;
    if (table === 'disabled_units' || table === 'recipe_cookbook_links' || table === 'settings') continue;

    for (const row of rows) {
      const existing = (await db.query(
        `SELECT id, sync_status FROM ${table} WHERE server_id = ? LIMIT 1`,
        [row.id]
      ))?.values?.[0];

      // Translate FK columns from server ids to local ids.
      const translated = { ...row };
      for (const [fk, candidates] of Object.entries(parents)) {
        if (fk in translated && translated[fk] != null) {
          translated[fk] = await translateFK(translated[fk], candidates);
        }
      }

      // Local pending edits shouldn't be overwritten by the server's
      // pre-edit snapshot for user-editable columns. But STRUCTURAL FK
      // columns (category_id, variant links) are managed by explicit
      // attach/detach flows, not free-text editing, so we still apply
      // those from the pull even when the row is pending. Without this
      // carveout, a user editing the stock on Greenwise while Whole
      // Milk sits in the pull payload would leave Greenwise stuck at
      // its stale generic_parent_id until the next push cleared the
      // pending flag AND another server-side change bumped updated_at.
      if (existing && existing.sync_status === 'pending') {
        const fkKeys = Object.keys(parents).filter(k => k in translated);
        if (fkKeys.length) {
          const setClause = fkKeys.map(k => `${k} = ?`).join(', ');
          const setValues = fkKeys.map(k => translated[k]);
          await db.run(
            `UPDATE ${table} SET ${setClause} WHERE id = ?`,
            [...setValues, existing.id]
          );
        }
        continue;
      }

      // Build column list dynamically from the row's keys (minus `id`).
      const cols = Object.keys(translated).filter(k => k !== 'id');
      const values = cols.map(k => {
        const v = translated[k];
        if (v == null) return null;
        if (typeof v === 'object') return JSON.stringify(v);
        return v;
      });

      if (existing) {
        const set = cols.map(c => `${c} = ?`).join(', ');
        await db.run(
          `UPDATE ${table} SET ${set}, sync_status = 'synced' WHERE id = ?`,
          [...values, existing.id]
        );
      } else {
        await db.run(
          `INSERT INTO ${table} (server_id, user_id, ${cols.join(', ')}, sync_status)
           VALUES (?, ?, ${cols.map(() => '?').join(', ')}, 'synced')`,
          [row.id, LOCAL_USER_ID, ...values]
        );
      }
    }
  }

  // disabled_units: replace local set with server set.
  if (Array.isArray(payload.tables.disabled_units)) {
    await db.run(`DELETE FROM disabled_units WHERE user_id = ?`, [LOCAL_USER_ID]);
    for (const r of payload.tables.disabled_units) {
      await db.run(
        `INSERT OR IGNORE INTO disabled_units (user_id, abbr) VALUES (?, ?)`,
        [LOCAL_USER_ID, r.abbr]
      );
    }
  }

  // recipe_cookbook_links: translate FKs server→local, then replace
  // local set for each cookbook present in the payload.
  if (Array.isArray(payload.tables.recipe_cookbook_links)) {
    const cookbookMap = await mapFor('cookbooks');
    const recipeMap = await mapFor('recipes');
    const links = payload.tables.recipe_cookbook_links
      .map(l => ({
        cookbook_id: cookbookMap.get(l.cookbook_id),
        recipe_id: recipeMap.get(l.recipe_id),
        sort_order: l.sort_order ?? 0,
      }))
      .filter(l => l.cookbook_id && l.recipe_id);
    const cookbookIds = [...new Set(links.map(l => l.cookbook_id))];
    if (cookbookIds.length) {
      const ph = cookbookIds.map(() => '?').join(',');
      await db.run(`DELETE FROM recipe_cookbook_links WHERE cookbook_id IN (${ph})`, cookbookIds);
    }
    for (const l of links) {
      await db.run(
        `INSERT OR IGNORE INTO recipe_cookbook_links (cookbook_id, recipe_id, sort_order, sync_status)
         VALUES (?, ?, ?, 'synced')`,
        [l.cookbook_id, l.recipe_id, l.sort_order]
      );
    }
  }

  // Settings: write each key into the local user_settings table as
  // 'synced' so the user can see the pulled value without it bouncing
  // back into the next push. Skip keys the user has a local pending
  // edit for — the pull would otherwise clobber the fresh value with
  // the server's pre-edit copy, same shape as the per-table guard above.
  if (Array.isArray(payload.tables.settings)) {
    for (const s of payload.tables.settings) {
      const localRow = (await db.query(
        `SELECT sync_status FROM user_settings WHERE user_id = ? AND key = ? LIMIT 1`,
        [LOCAL_USER_ID, s.key]
      ))?.values?.[0];
      if (localRow?.sync_status === 'pending') continue;

      const v = typeof s.value === 'string' ? s.value : (s.value == null ? null : JSON.stringify(s.value));
      await db.run(
        `INSERT INTO user_settings (user_id, key, value, updated_at, sync_status)
         VALUES (?, ?, ?, ?, 'synced')
         ON CONFLICT(user_id, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at,
           sync_status = 'synced'`,
        [LOCAL_USER_ID, s.key, v, s.updated_at || new Date().toISOString()]
      );
    }
  }
}

/**
 * Bulk-mark rows in a table 'synced' after a successful push. Gated on
 * updated_at matching the snapshot. `rows` is an array of `{id,
 * updated_at}` taken from the push snapshot. See dbMarkSettingsSynced
 * for the full race description.
 */
export async function dbMarkTableSynced(table, rows) {
  if (!isNative || !rows || !rows.length) return;
  const db = await getDb();
  for (const r of rows) {
    await db.run(
      `UPDATE ${table} SET sync_status = 'synced' WHERE id = ? AND updated_at = ?`,
      [r.id, r.updated_at]
    );
  }
}
