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
import { mapSmartFilterCategory } from './smart-cookbook.js';
import { mapSourceIds } from './shopping-plan.js';

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
    sync_status          TEXT DEFAULT 'synced',
    server_synced_at     TEXT,
    server_base          TEXT
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
    any_day      INTEGER NOT NULL DEFAULT 0,
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
    sources      TEXT,
    notes        TEXT,
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
  -- Rows deleted outright on this device that the server still has, by
  -- server id, sent with the next push. A cookbook link carries both ids.
  CREATE TABLE IF NOT EXISTS sync_deletes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    server_id  INTEGER NOT NULL,
    recipe_server_id INTEGER
  );

  -- The edit time the server stored for this phone's own last push of a
  -- row, so the copy of it that comes back in a pull is known as its own.
  CREATE TABLE IF NOT EXISTS sync_echoes (
    table_name TEXT NOT NULL,
    row_id     INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (table_name, row_id)
  );

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
  await _migrateServerCopy();
  await _migrateShoppingAisle();
  await _backfillShoppingNames();
  await _migrateIngredientLinks();
}

/**
 * A recipe's ingredients (JSON text) with each pantry link (pantry_item_id)
 * put through `map(id)`: the id it should hold, or null to take the link
 * out, or undefined when it can't be told yet. The phone keeps its own ids
 * in these links, as everywhere else; the server keeps its ids. Returns
 * { json, unknown }: unknown counts links `map` couldn't tell.
 */
export function mapIngredientLinks(json, map) {
  let groups;
  try { groups = typeof json === 'string' ? JSON.parse(json) : json; } catch { return { json, unknown: 0 }; }
  if (!Array.isArray(groups)) return { json, unknown: 0 };
  let changed = false, unknown = 0;
  const fix = it => {
    if (!it || typeof it !== 'object' || it.pantry_item_id == null) return it;
    const to = map(Number(it.pantry_item_id));
    if (to === undefined) { unknown++; return it; }
    if (to === Number(it.pantry_item_id)) return it;
    changed = true;
    if (to == null) { const { pantry_item_id, ...rest } = it; return rest; }
    return { ...it, pantry_item_id: to };
  };
  const out = groups.map(g => (g && Array.isArray(g.items) ? { ...g, items: g.items.map(fix) } : fix(g)));
  return { json: changed ? (typeof json === 'string' ? JSON.stringify(out) : out) : json, unknown };
}

// One time: ingredient links pulled before the phone translated them held
// the server's ids. A link that is the server id of a pantry item here
// becomes that item's own id, except in a recipe edited here that links an
// item not sent yet; anything else stays as it was.
async function _migrateIngredientLinks() {
  try {
    const db = await getDb();
    const done = (await db.query(`SELECT value FROM sync_meta WHERE key = 'ingredient_links_local'`, []))?.values?.[0];
    if (done) return;
    const pantry = (await db.query(`SELECT id, server_id FROM pantry_items`, []))?.values || [];
    const byServer = new Map(pantry.filter(p => p.server_id != null).map(p => [Number(p.server_id), p.id]));
    const unsent = new Set(pantry.filter(p => p.server_id == null).map(p => p.id));
    if (byServer.size) {
      const recipes = (await db.query(`SELECT id, ingredients, sync_status FROM recipes`, []))?.values || [];
      for (const r of recipes) {
        // A recipe edited here may hold a link picked here (this phone's id,
        // to an item not sent yet); one that isn't holds the server's copy.
        const edited = r.sync_status === 'pending';
        const { json } = mapIngredientLinks(r.ingredients, id => (edited && unsent.has(id) ? id : byServer.has(id) ? byServer.get(id) : id));
        if (json !== r.ingredients) await db.run(`UPDATE recipes SET ingredients = ? WHERE id = ?`, [json, r.id]);
      }
    }
    await db.run(`INSERT INTO sync_meta (key, value) VALUES ('ingredient_links_local', '1') ON CONFLICT(key) DO NOTHING`, []);
  } catch (e) { console.warn('[db-native] ingredient links:', e?.message); }
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
    // Where a row's amount came from (shopping-plan.js).
    if (!shopCols.has('sources')) {
      await db.run(`ALTER TABLE shopping_list ADD COLUMN sources TEXT`);
    }
    if (!shopCols.has('notes')) {
      await db.run(`ALTER TABLE shopping_list ADD COLUMN notes TEXT`);
    }
    // A planned cook for some day of its week (date = the week's Monday).
    const diaryInfo = await db.query(`PRAGMA table_info(cook_diary)`);
    const diaryCols = new Set((diaryInfo?.values || []).map(c => c.name));
    if (!diaryCols.has('any_day')) {
      await db.run(`ALTER TABLE cook_diary ADD COLUMN any_day INTEGER NOT NULL DEFAULT 0`);
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

// Per synced row: server_synced_at, the server's stamp of the copy this
// phone has, sent back with an edit so the server can tell what changed
// there since; server_base, that copy field by field, in short, so a push
// can say which fields this phone changed (rowBase / rowChanges); and
// edit_clock, 'server' when the edit time was stamped on the server's clock
// as the edit was made (the triggers below), so a clock fixed or broken
// before the push doesn't move it. Rows pulled before the columns existed
// have no stamp, so the next pull starts over once and brings them down.
async function _migrateServerCopy() {
  try {
    const db = await getDb();
    let reset = false;
    for (const table of SYNC_TABLES) {
      const info = await db.query(`PRAGMA table_info(${table})`);
      const cols = new Set((info?.values || []).map(c => c.name));
      for (const col of ['server_base', 'edit_clock']) {
        if (!cols.has(col)) await db.run(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
      }
      if (!cols.has('server_synced_at')) {
        await db.run(`ALTER TABLE ${table} ADD COLUMN server_synced_at TEXT`);
        reset = true;
      }
      // An edit made here (the row goes pending with a new time, or is
      // deleted) is stamped with the server's clock, by the offset the
      // server last measured, when there is one.
      const soft = (SYNC_FIELDS[table] || []).includes('deleted_at');
      const at = soft ? `CASE WHEN NEW.deleted_at IS NOT OLD.deleted_at AND NEW.deleted_at IS NOT NULL THEN NEW.deleted_at ELSE NEW.updated_at END` : 'NEW.updated_at';
      const shift = `printf('%+.3f seconds', CAST((SELECT value FROM sync_meta WHERE key = 'clock_offset_ms') AS REAL) / 1000.0)`;
      const has = `EXISTS (SELECT 1 FROM sync_meta WHERE key = 'clock_offset_ms')`;
      await db.execute(`
        DROP TRIGGER IF EXISTS trg_${table}_edit_clock_upd;
        CREATE TRIGGER trg_${table}_edit_clock_upd AFTER UPDATE ON ${table}
        FOR EACH ROW WHEN NEW.sync_status = 'pending' AND ${has}
          AND (NEW.updated_at IS NOT OLD.updated_at${soft ? ' OR NEW.deleted_at IS NOT OLD.deleted_at' : ''})
        BEGIN
          UPDATE ${table} SET updated_at = strftime('%Y-%m-%d %H:%M:%S', ${at}, ${shift}), edit_clock = 'server' WHERE id = NEW.id;
        END;
        DROP TRIGGER IF EXISTS trg_${table}_edit_clock_ins;
        CREATE TRIGGER trg_${table}_edit_clock_ins AFTER INSERT ON ${table}
        FOR EACH ROW WHEN NEW.sync_status = 'pending' AND ${has}
        BEGIN
          UPDATE ${table} SET updated_at = strftime('%Y-%m-%d %H:%M:%S', COALESCE(NEW.updated_at, datetime('now')), ${shift}), edit_clock = 'server' WHERE id = NEW.id;
        END;
      `);
    }
    if (reset) await db.run(`DELETE FROM sync_meta WHERE key = 'last_pull_at'`);
  } catch (e) { console.warn('[db-native] server copy columns:', e?.message); }
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

/** Which local row each synced id column points at, per table. Mirrors
 *  TABLES[...].parents in server/routes/sync.js. Ids differ between the
 *  phone and the server, so these columns are translated both ways: on
 *  pull (server id to local id) and on push (local id to server id). */
// Unique per account, so one made on two devices is one row.
const NATURAL_KEYS = { recipe_categories: 'slug', pantry_categories: 'slug', cookbooks: 'slug', custom_units: 'abbr' };
// The fields that go with each one (server/lib/sync-fields.js SYNC_GROUPS).
const NAME_GROUPS = { recipe_categories: ['name', 'slug'], pantry_categories: ['name', 'slug'], cookbooks: ['name', 'slug'], custom_units: ['abbr', 'full_name', 'category'] };
// Timestamps from either side, comparable as text.
const _ts = v => String(v || '').replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '');
// The same, as a time: SQLite's datetime('now') is UTC with no zone.
const _utcMs = v => Date.parse(_ts(v).replace(' ', 'T') + 'Z');
// Whether the server's copy is newer than an edit made here. The server
// keeps edit times on its own clock and says how far this phone's is
// behind (clockOffsetMs); a server that doesn't say keeps this phone's
// times as sent, so they compare as they are.
function _serverNewer(serverAt, localAt, clockOffsetMs = 0) {
  const a = _utcMs(serverAt), b = _utcMs(localAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return _ts(serverAt) > _ts(localAt);
  return a > b + clockOffsetMs;
}

export const SYNC_DELETABLE = ['recipe_categories', 'pantry_categories', 'custom_units', 'ai_chat_history'];

// The fields of each synced table (sync-fields.js). A push says which of
// them this phone changed on the copy it had.
export { SYNC_FIELDS } from './sync-fields.js';
import { SYNC_FIELDS } from './sync-fields.js';
const _BOOLEAN_FIELDS = new Set(['favorite', 'in_stock', 'checked', 'is_smart']);
function _stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(_stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${_stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
// One field as a short key. The same value written another way (null or
// '', a number as text, JSON re-serialized, true or 1) gives the same key,
// so saving a rating, which writes every field back, changes nothing else.
function _fieldKey(f, v) {
  if (v === undefined || v === '') v = null;
  if (f === 'deleted_at') v = v == null ? 0 : 1;
  else if (_BOOLEAN_FIELDS.has(f)) v = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
  else if (f === 'visibility') v = v || 'private';
  else {
    if (typeof v === 'string' && /^\s*[[{]/.test(v)) { try { v = JSON.parse(v); } catch { /* text */ } }
    if (Array.isArray(v) && v.length === 0) v = null;
    else if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) v = null;
    else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) v = Number(v);
  }
  const s = _stableJson(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${s.length}:${(h >>> 0).toString(36)}`;
}
/** A row's fields, as keys: kept for the copy the server has. */
export function rowBase(table, row) {
  return JSON.stringify(Object.fromEntries((SYNC_FIELDS[table] || []).map(f => [f, _fieldKey(f, row?.[f])])));
}
/** The fields a row changed since the copy the server has; null if unknown. */
export function rowChanges(table, row) {
  let base = null;
  try { base = row?.server_base ? JSON.parse(row.server_base) : null; } catch { base = null; }
  if (!base) return null;
  return (SYNC_FIELDS[table] || []).filter(f => base[f] !== _fieldKey(f, row[f]));
}

export const SYNC_PARENTS = {
  recipes: { category_id: 'recipe_categories' },
  pantry_items: {
    category_id: 'pantry_categories',
    generic_parent_id: 'pantry_items',
    nutrition_source_variant_id: 'pantry_items',
  },
  cook_diary: { recipe_id: 'recipes' },
  shopping_list: { pantry_id: 'pantry_items', recipe_id: 'recipes' },
  recipe_comments: { recipe_id: 'recipes', parent_id: 'recipe_comments' },
};

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
  // recipe_cookbook_links: the links added or reordered here since the
  // last push. The server keeps the rest.
  const links = await db.query(`SELECT cookbook_id, recipe_id, sort_order FROM recipe_cookbook_links WHERE sync_status = 'pending'`, []);
  out.recipe_cookbook_links = links?.values || [];
  const dels = await db.query(`SELECT * FROM sync_deletes ORDER BY id`, []);
  out.deletes = dels?.values || [];
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
/** The edit time the server stored for a row this phone pushed. */
export async function dbRememberEcho(table, rowId, updatedAt) {
  if (!isNative) return;
  const db = await getDb();
  await db.run(
    `INSERT INTO sync_echoes (table_name, row_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(table_name, row_id) DO UPDATE SET updated_at = excluded.updated_at`,
    [table, rowId, updatedAt]
  );
}

export async function dbApplyPull(payload, { clockOffsetMs = 0, live = () => true } = {}) {
  // live(): false once the copy is changing hands (another account signing
  // in, lib/local-account.js): nothing more of this pull is written.
  if (!isNative || !payload?.tables) return true;
  const db = await getDb();
  const install = await dbInstallId();

  // Build a per-table { server_id → local_id } map by scanning the
  // local server_id column once. Re-scanned per pull so it picks up
  // ids minted by parent-table upserts earlier in the same pull.
  async function mapFor(table) {
    const r = await db.query(`SELECT id, server_id FROM ${table} WHERE server_id IS NOT NULL`, []);
    const m = new Map();
    for (const row of r?.values || []) m.set(row.server_id, row.id);
    return m;
  }

  async function translateFK(value, table) {
    if (value == null) return null;
    const m = await mapFor(table);
    return m.has(value) ? m.get(value) : null;
  }

  // Pantry items before recipes, so an ingredient's link to an item in the
  // same pull finds it.
  const order = t => (t === 'pantry_items' ? -1 : 0);
  const tablesInOrder = Object.entries(payload.tables).sort((x, y) => order(x[0]) - order(y[0]));
  for (const [table, rows] of tablesInOrder) {
    if (!Array.isArray(rows)) continue;
    if (table === 'disabled_units' || table === 'recipe_cookbook_links' || table === 'settings') continue;

    for (const row of rows) {
      if (!live()) return false;
      let existing = (await db.query(
        `SELECT * FROM ${table} WHERE server_id = ? LIMIT 1`,
        [row.id]
      ))?.values?.[0];
      // One made here before it synced, with the same name (slug) as one
      // made elsewhere: they're the same, and inserting a second would
      // break the unique name and stop every sync. Join them.
      const key = NATURAL_KEYS[table];
      if (!existing && key && row[key] != null) {
        existing = (await db.query(
          `SELECT * FROM ${table} WHERE user_id = ? AND ${key} = ? AND server_id IS NULL LIMIT 1`,
          [LOCAL_USER_ID, row[key]]
        ))?.values?.[0];
        if (existing) await db.run(`UPDATE ${table} SET server_id = ? WHERE id = ?`, [row.id, existing.id]);
      }

      // One this phone made, whose push went in but whose answer was lost
      // on the way back (it carries this install's key for that row): the
      // same row, not a second one.
      const made = typeof row.client_key === 'string' ? row.client_key : null;
      if (!existing && made && install && made.startsWith(`${install}:${table}:`)) {
        const localId = Number(made.slice(`${install}:${table}:`.length).split('@')[0]);
        const mine = Number.isFinite(localId) ? (await db.query(
          `SELECT * FROM ${table} WHERE id = ? AND server_id IS NULL LIMIT 1`, [localId]
        ))?.values?.[0] : undefined;
        // The same row only if the key is the one it would be sent with now.
        if (mine && createKeyOf(install, table, mine) === made) {
          existing = mine;
          await db.run(`UPDATE ${table} SET server_id = ? WHERE id = ?`, [row.id, existing.id]);
        }
      }

      // Translate FK columns from server ids to local ids, each through
      // its own parent table (a pantry item's category_id is a pantry
      // category, never a recipe category). Parents in the same pull
      // resolve too: parent tables come first, and self-references
      // (variants, replies) arrive parent first.
      const parents = SYNC_PARENTS[table] || {};
      const translated = { ...row };
      delete translated.client_key;
      // The server's stamp of this copy.
      if ('synced_at' in translated) {
        translated.server_synced_at = translated.synced_at;
        delete translated.synced_at;
      }
      for (const [fk, parentTable] of Object.entries(parents)) {
        if (fk in translated && translated[fk] != null) {
          translated[fk] = await translateFK(translated[fk], parentTable);
        }
      }
      // An ingredient's pantry link: the server's id there, this phone's
      // here. One to an item the phone doesn't have is taken out.
      if (table === 'recipes' && translated.ingredients != null) {
        const pantryHere = await mapFor('pantry_items');
        translated.ingredients = mapIngredientLinks(translated.ingredients, id => (pantryHere.has(id) ? pantryHere.get(id) : null)).json;
      }
            // A smart cookbook's category is an id too.
      if (table === 'cookbooks' && translated.smart_filter_json) {
        const cats = await mapFor('recipe_categories');
        translated.smart_filter_json = mapSmartFilterCategory(translated.smart_filter_json, id => cats.get(id));
      }
      // So are the recipes and planned cooks a list row's amount came from.
      if (table === 'shopping_list' && translated.sources) {
        const recipesHere = await mapFor('recipes');
        const diaryHere = await mapFor('cook_diary');
        translated.sources = mapSourceIds(translated.sources,
          id => (recipesHere.has(id) ? recipesHere.get(id) : null),
          id => (diaryHere.has(id) ? diaryHere.get(id) : null)).json;
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
      // Only where the server's copy is newer than the edit waiting here,
      // or this side has none: every push comes back in the next pull, and
      // that echo of an earlier push must not undo a newer edit. The
      // stamp and fields of the copy this phone has stay too: the edit
      // waiting here was made on it.
      if (existing && existing.sync_status === 'pending') {
        // This phone's own earlier push coming back is never newer than an
        // edit made here since. Anything else compares by time, on one clock.
        const echo = (await db.query(`SELECT updated_at FROM sync_echoes WHERE table_name = ? AND row_id = ?`, [table, existing.id]))?.values?.[0];
        const serverNewer = echo?.updated_at !== translated.updated_at
          && _serverNewer(translated.updated_at, existing.updated_at, existing.edit_clock === 'server' ? 0 : clockOffsetMs);
        const fkKeys = Object.keys(parents).filter(k => k in translated && (serverNewer || existing[k] == null));
        if (fkKeys.length) {
          const setClause = fkKeys.map(k => `${k} = ?`).join(', ');
          const setValues = fkKeys.map(k => translated[k]);
          await db.run(
            `UPDATE ${table} SET ${setClause} WHERE id = ?`,
            [...setValues, existing.id]
          );
        }
        // Its name (slug) on the server, when the edit waiting here didn't
        // change it: the copy here keeps up, and frees the old name for a
        // row that has it now (the server's names are unique). It doesn't
        // count as changed here, so the edit still sends only its own fields.
        if (key && translated[key] != null && translated[key] !== existing[key]) {
          const group = NAME_GROUPS[table] || [key];
          const changedHere = rowChanges(table, existing) || [];
          if (!group.some(f => changedHere.includes(f))) {
            const fields = group.filter(f => f in translated);
            let base = {};
            try { base = existing.server_base ? JSON.parse(existing.server_base) : {}; } catch { base = {}; }
            for (const f of fields) base[f] = _fieldKey(f, translated[f]);
            await db.run(
              `UPDATE ${table} SET ${fields.map(f => `${f} = ?`).join(', ')}, server_base = ? WHERE id = ?`,
              [...fields.map(f => translated[f]), existing.server_base ? JSON.stringify(base) : null, existing.id]
            );
          }
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

      // The name (slug) is unique here as on the server. A row here that
      // has it but is another server row is a stale copy of that row (its
      // name changed there; its new copy comes in this pull): it steps
      // aside rather than stop every pull on the unique name.
      if (key && translated[key] != null) {
        await db.run(
          `UPDATE ${table} SET ${key} = ${key} || '~' || id WHERE user_id = ? AND ${key} = ? AND server_id IS NOT NULL AND server_id != ? AND id != ? AND COALESCE(sync_status, 'synced') != 'pending'`,
          [LOCAL_USER_ID, translated[key], row.id, existing?.id ?? -1]
        );
        // Held by an edit waiting here that gave a row this name: the row
        // coming down keeps it under a name of its own until that edit has
        // gone up and the server has settled the two, rather than stop
        // every pull on the unique name.
        const held = (await db.query(
          `SELECT id FROM ${table} WHERE user_id = ? AND ${key} = ? AND id != ? LIMIT 1`,
          [LOCAL_USER_ID, translated[key], existing?.id ?? -1]
        ))?.values?.[0];
        if (held) {
          const i = cols.indexOf(key);
          if (i > -1) values[i] = `${translated[key]}~s${row.id}`;
        }
      }
      if (existing) {
        // When a row here was made stays as it is: for a row this phone
        // made, the server's is when it got there. It's part of the key
        // the row is sent with (createKeyOf), which must never change, or
        // the same row sent again (Upload a second time) makes a second.
        const keep = c => c === 'created_at' && existing.created_at != null;
        const set = cols.map(c => (keep(c) ? null : `${c} = ?`)).filter(Boolean).join(', ');
        await db.run(
          `UPDATE ${table} SET ${set}, sync_status = 'synced' WHERE id = ?`,
          [...values.filter((v, i) => !keep(cols[i])), existing.id]
        );
      } else {
        await db.run(
          `INSERT INTO ${table} (server_id, user_id, ${cols.join(', ')}, sync_status)
           VALUES (?, ?, ${cols.map(() => '?').join(', ')}, 'synced')`,
          [row.id, LOCAL_USER_ID, ...values]
        );
      }
      // The copy this phone now has from the server, as it reads it back.
      if (SYNC_FIELDS[table]) {
        const here = (await db.query(`SELECT * FROM ${table} WHERE server_id = ? LIMIT 1`, [row.id]))?.values?.[0];
        if (here) await db.run(`UPDATE ${table} SET server_base = ?, edit_clock = NULL WHERE id = ?`, [rowBase(table, here), here.id]);
      }
      if (existing) await db.run(`DELETE FROM sync_echoes WHERE table_name = ? AND row_id = ?`, [table, existing.id]);
    }
  }

  if (!live()) return false;
  // Rows the server deleted outright: drop them here too, like the REST
  // deletes do (a category's recipes and pantry items stay, without it).
  const gone = payload.tables.deletions;
  if (gone && typeof gone === 'object') {
    const children = { recipe_categories: 'recipes', pantry_categories: 'pantry_items' };
    for (const [table, ids] of Object.entries(gone)) {
      if (!SYNC_DELETABLE.includes(table) || !Array.isArray(ids)) continue;
      for (const sid of ids) {
        const local = (await db.query(`SELECT id FROM ${table} WHERE server_id = ?`, [sid]))?.values?.[0];
        if (!local) continue;
        if (children[table]) await db.run(`UPDATE ${children[table]} SET category_id = NULL WHERE category_id = ?`, [local.id]);
        await db.run(`DELETE FROM ${table} WHERE id = ?`, [local.id]);
      }
    }
  }

  if (!live()) return false;
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
  // local set for every cookbook the server has. Its links here become
  // the server's, apart from links added here that haven't gone up yet
  // and links taken out here that the server hasn't heard about yet. A
  // cookbook whose last link went on another device ends up empty.
  if (!live()) return false;
  if (Array.isArray(payload.tables.recipe_cookbook_links)) {
    const cookbookMap = await mapFor('cookbooks');
    const recipeMap = await mapFor('recipes');
    const removed = new Set(((await db.query(
      `SELECT server_id, recipe_server_id FROM sync_deletes WHERE table_name = 'recipe_cookbook_links'`, []
    ))?.values || []).map(d => `${d.server_id}:${d.recipe_server_id}`));
    const links = payload.tables.recipe_cookbook_links
      .filter(l => !removed.has(`${l.cookbook_id}:${l.recipe_id}`))
      .map(l => ({
        cookbook_id: cookbookMap.get(l.cookbook_id),
        recipe_id: recipeMap.get(l.recipe_id),
        sort_order: l.sort_order ?? 0,
      }))
      .filter(l => l.cookbook_id && l.recipe_id);
    const known = [...cookbookMap.values()];
    if (known.length) {
      const ph = known.map(() => '?').join(',');
      await db.run(
        `DELETE FROM recipe_cookbook_links
          WHERE cookbook_id IN (${ph}) AND COALESCE(sync_status, 'synced') != 'pending'`,
        known
      );
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
  if (!live()) return false;
  if (Array.isArray(payload.tables.settings)) {
    for (const s of payload.tables.settings) {
      if (!live()) return false;
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
  return true;
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

// ── Whose copy (lib/local-account.js) ────────────────────────────────────

/** Changes made here that haven't reached the server: rows waiting to go
 *  up, cookbook links, deletes, and settings. */
export async function dbCountUnsynced() {
  if (!isNative) return 0;
  const db = await getDb();
  const n = async sql => Number((await db.query(sql, []))?.values?.[0]?.n || 0);
  let total = 0;
  for (const t of SYNC_TABLES) total += await n(`SELECT COUNT(*) AS n FROM ${t} WHERE sync_status = 'pending'`);
  total += await n(`SELECT COUNT(*) AS n FROM recipe_cookbook_links WHERE sync_status = 'pending'`);
  total += await n(`SELECT COUNT(*) AS n FROM sync_deletes`);
  total += await n(`SELECT COUNT(*) AS n FROM user_settings WHERE sync_status = 'pending'`);
  return total;
}

// Every account row the phone mirrors, and what the sync knows about the
// copy (the pull cursor, the echoes of its pushes, deletes waiting): gone,
// so the next sync fills it from the account now signed in. One-time
// markers, this install's id and the server's clock in sync_meta stay.
const _ACCOUNT_TABLES = [...SYNC_TABLES, 'recipe_cookbook_links', 'disabled_units', 'user_settings', 'sync_deletes', 'sync_echoes', 'sync_log'];
export async function dbClearUserData() {
  if (!isNative) return;
  const db = await getDb();
  // One statement per call: the Android plugin's execute() runs only the
  // first statement of each line it splits a script into, so a script of
  // deletes silently left most tables as they were.
  for (const t of _ACCOUNT_TABLES) await db.run(`DELETE FROM ${t}`, []);
  await db.run(`DELETE FROM sync_meta WHERE key = 'last_pull_at'`, []);
  // Read back: a copy that still holds anything is never shown as cleared
  // (lib/local-account.js shows the error screen instead).
  for (const t of _ACCOUNT_TABLES) {
    const left = Number((await db.query(`SELECT COUNT(*) AS n FROM ${t}`, []))?.values?.[0]?.n || 0);
    if (left) throw new Error(`could not clear ${t}`);
  }
  if ((await db.query(`SELECT 1 FROM sync_meta WHERE key = 'last_pull_at'`, []))?.values?.length) throw new Error('could not clear the pull cursor');
}

/**
 * Connecting to a server after an upload from Settings (lib/migrate.js):
 * every row is this account's now, and none has an id on its server yet,
 * except the rows that went up, which take the ids the server gave them
 * (`uploaded`: { table: [[localId, serverId], ...] }) and come down from it
 * on the next pull. The rest goes up with the next sync as new rows, with
 * what points at the uploaded ones translated to the server's ids. Deletes
 * meant for another server go, and the pull starts over.
 */
export async function dbKeepForNewServer(uploaded = {}) {
  if (!isNative) return;
  const db = await getDb();
  for (const t of SYNC_TABLES) {
    if (t !== 'ai_chat_history') await db.run(`DELETE FROM ${t} WHERE deleted_at IS NOT NULL`, []);
    await db.run(`UPDATE ${t} SET server_id = NULL, server_synced_at = NULL, server_base = NULL, sync_status = 'pending'`, []);
    for (const pair of (Array.isArray(uploaded[t]) ? uploaded[t] : [])) {
      const [localId, serverId] = (pair || []).map(Number);
      if (!Number.isFinite(localId) || !Number.isFinite(serverId)) continue;
      await db.run(`UPDATE ${t} SET server_id = ?, sync_status = 'synced' WHERE id = ?`, [serverId, localId]);
    }
  }
  // One statement per call (see dbClearUserData).
  await db.run(`UPDATE recipe_cookbook_links SET sync_status = 'pending'`, []);
  await db.run(`DELETE FROM sync_deletes`, []);
  await db.run(`DELETE FROM sync_echoes`, []);
  await db.run(`DELETE FROM sync_meta WHERE key = 'last_pull_at'`, []);
}

/** This install's id: with a row's own id and when it was made, the key
 *  the server knows a create by, so one sent twice is made once
 *  (server/lib/create-keys.js).
 *
 *  The id is kept in this database, which Android backs up and puts back
 *  on a new phone (or a second one), and also outside it, in a marker that
 *  backups leave out (InstallMarkerPlugin). When the two differ, or the
 *  marker is missing, this database came from elsewhere (or from before
 *  the marker existed): this install takes a new id, so two phones never
 *  send the same key for different rows. A new id is always safe; the cost
 *  is that a create sent just before, whose answer never came, can be made
 *  a second time, once. */
let _installId = null;
let _installIdPromise = null;
let _markerPlugin = null;
async function _installMarker() {
  try {
    if (!_markerPlugin) { const { registerPlugin } = await import('@capacitor/core'); _markerPlugin = registerPlugin('InstallMarker'); }
    const got = await _markerPlugin.get();
    return { kept: got?.value ?? null, set: value => _markerPlugin.set({ value }) };
  } catch { return null; } // a shell without the plugin: the database's id stands
}
export function dbInstallId() {
  if (_installId) return Promise.resolve(_installId);
  if (!isNative) return Promise.resolve(null);
  _installIdPromise ||= (async () => {
    const db = await getDb();
    let id = (await db.query(`SELECT value FROM sync_meta WHERE key = 'install_id'`, []))?.values?.[0]?.value || null;
    const marker = await _installMarker();
    if (!id || (marker && marker.kept !== id)) {
      id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      await db.run(`INSERT INTO sync_meta (key, value) VALUES ('install_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [id]);
      if (marker) await marker.set(id);
    }
    _installId = id;
    return id;
  })().finally(() => { _installIdPromise = null; });
  return _installIdPromise;
}

/** The key a row this install made is sent with: the install, the table,
 *  the row's own id, and when it was made (a second guard, should two
 *  copies of one database ever share an install id). */
export function createKeyOf(install, table, row) {
  if (!install || row?.id == null) return undefined;
  return `${install}:${table}:${row.id}${row.created_at ? `@${row.created_at}` : ''}`;
}
