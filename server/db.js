import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.DB_PATH || './cooktrace.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Core tables ────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    full_name     TEXT,
    nickname      TEXT,
    birthday      TEXT,
    gender        TEXT,
    avatar_url    TEXT,
    role          TEXT NOT NULL DEFAULT 'user',
    email         TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT DEFAULT NULL,
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used       INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS invite_tokens (
    token      TEXT PRIMARY KEY,
    email      TEXT,
    role       TEXT NOT NULL DEFAULT 'user',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at TEXT NOT NULL,
    used       INTEGER DEFAULT 0
  );

  -- Personal access tokens. Currently the auth mechanism for the MCP
  -- endpoint (/api/mcp); a general-purpose token store so a future
  -- federation-style API can reuse it without a schema change. Raw
  -- token value is never stored, only its SHA-256 hash.
  CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    scopes       TEXT NOT NULL DEFAULT '[]',  -- JSON array of scope strings
    expires_at   TEXT,                         -- NULL = never expires
    last_used_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
`);

// ── AI assistant chat history (per user) ───────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_chat_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_chat_history_user ON ai_chat_history(user_id, created_at);
`);

// ── OIDC / SSO ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_state (
    state       TEXT PRIMARY KEY,
    user_id     INTEGER,
    provider    TEXT NOT NULL,
    data        TEXT NOT NULL DEFAULT '{}',
    expires_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oidc_providers (
    id                            INTEGER PRIMARY KEY AUTOINCREMENT,
    issuer_url                    TEXT NOT NULL,
    client_id                     TEXT NOT NULL,
    client_secret                 TEXT,
    redirect_uris                 TEXT NOT NULL DEFAULT '[]',
    scope                         TEXT NOT NULL DEFAULT 'openid profile email',
    token_endpoint_auth_method    TEXT NOT NULL DEFAULT 'client_secret_post',
    response_types                TEXT NOT NULL DEFAULT '["code"]',
    id_token_signed_response_alg  TEXT NOT NULL DEFAULT 'RS256',
    userinfo_signed_response_alg  TEXT NOT NULL DEFAULT 'none',
    request_timeout_ms            INTEGER NOT NULL DEFAULT 30000,
    auto_register                 INTEGER NOT NULL DEFAULT 0,
    auto_link_verified_email      INTEGER NOT NULL DEFAULT 1,
    auto_register_new_users       INTEGER NOT NULL DEFAULT 0,
    admin_group_claim             TEXT,
    admin_group_value             TEXT,
    display_name                  TEXT,
    logo_url                      TEXT,
    is_active                     INTEGER NOT NULL DEFAULT 1,
    created_at                    TEXT DEFAULT (datetime('now')),
    updated_at                    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_oidc_links (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    oidc_provider_id  INTEGER NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
    oidc_sub          TEXT NOT NULL,
    email_verified    INTEGER DEFAULT 0,
    last_login_at     TEXT,
    created_at        TEXT DEFAULT (datetime('now')),
    UNIQUE (oidc_provider_id, oidc_sub)
  );
  CREATE INDEX IF NOT EXISTS idx_user_oidc_links_user ON user_oidc_links(user_id);
`);

// ── CookTrace domain tables (Phase 1+) ─────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS recipes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT,
    img_url       TEXT,
    servings      INTEGER DEFAULT 2,
    prep_minutes  INTEGER,
    cook_minutes  INTEGER,
    ingredients   TEXT NOT NULL DEFAULT '[]',
    steps         TEXT NOT NULL DEFAULT '[]',
    tags          TEXT NOT NULL DEFAULT '[]',
    source_url    TEXT,
    notes         TEXT,
    visibility    TEXT NOT NULL DEFAULT 'private',
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    deleted_at    TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recipes_user    ON recipes(user_id);
  CREATE INDEX IF NOT EXISTS idx_recipes_updated ON recipes(updated_at);
  CREATE INDEX IF NOT EXISTS idx_recipes_deleted ON recipes(deleted_at);

  CREATE TABLE IF NOT EXISTS pantry_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    in_stock      INTEGER NOT NULL DEFAULT 1,
    quantity      REAL,
    unit          TEXT,
    expires_on    TEXT,
    nt_food_id    INTEGER,                -- optional NutriTrace food link (Phase 2)
    img_url       TEXT,
    notes         TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    deleted_at    TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pantry_user    ON pantry_items(user_id);
  CREATE INDEX IF NOT EXISTS idx_pantry_updated ON pantry_items(updated_at);
  CREATE INDEX IF NOT EXISTS idx_pantry_deleted ON pantry_items(deleted_at);

  CREATE TABLE IF NOT EXISTS cook_diary (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    recipe_id     INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
    date          TEXT NOT NULL,           -- YYYY-MM-DD
    kind          TEXT NOT NULL DEFAULT 'cooked', -- 'cooked' | 'planned'
    servings      INTEGER,
    notes         TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    deleted_at    TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cook_diary_user_date ON cook_diary(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_cook_diary_recipe    ON cook_diary(recipe_id);
  CREATE INDEX IF NOT EXISTS idx_cook_diary_updated   ON cook_diary(updated_at);
  CREATE INDEX IF NOT EXISTS idx_cook_diary_deleted   ON cook_diary(deleted_at);

  CREATE TABLE IF NOT EXISTS shopping_list (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    quantity      REAL,
    unit          TEXT,
    aisle         TEXT,
    checked       INTEGER NOT NULL DEFAULT 0,
    pantry_id     INTEGER REFERENCES pantry_items(id) ON DELETE SET NULL,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    deleted_at    TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shopping_user    ON shopping_list(user_id);
  CREATE INDEX IF NOT EXISTS idx_shopping_updated ON shopping_list(updated_at);
  CREATE INDEX IF NOT EXISTS idx_shopping_deleted ON shopping_list(deleted_at);
`);

// ── Migrations ─────────────────────────────────────────────────────────────
// Idempotent: each block adds a column only if it doesn't already exist.
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col);
}

// Slice 2A — recipe metadata expansion
if (!columnExists('recipes', 'rating')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN rating INTEGER`);
}
if (!columnExists('recipes', 'yield_text')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN yield_text TEXT`);
}
if (!columnExists('recipes', 'last_cooked_at')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN last_cooked_at TEXT`);
}
if (!columnExists('recipes', 'cook_count')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN cook_count INTEGER NOT NULL DEFAULT 0`);
}
if (!columnExists('recipes', 'tools')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'`);
}
if (!columnExists('recipes', 'nutrition')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN nutrition TEXT NOT NULL DEFAULT '{}'`);
}
// Denormalized for display speed (avoids a join on every recipe fetch).
// Set on INSERT only — not chased on username changes (rare).
if (!columnExists('recipes', 'created_by_username')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN created_by_username TEXT`);
}
if (!columnExists('recipes', 'favorite')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recipes_favorite ON recipes(favorite)`);
}
// Optional manual override for Total Time. NULL means "auto = prep +
// cook"; a value here wins. Lets a user account for time the two
// component fields don't cover — resting, marinating, waiting for
// oven preheat, etc.
if (!columnExists('recipes', 'total_minutes')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN total_minutes INTEGER`);
}
// Rest / rise / wait / marinate / chill time — the generic hands-off
// slot. Rolls into the auto-calc for total_minutes when that
// override is NULL.
if (!columnExists('recipes', 'rest_minutes')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN rest_minutes INTEGER`);
}

// NT federation: when a recipe has been pushed to NutriTrace via the
// Push to NutriTrace flow, we record the NT meals row id here so the
// next push upserts the same row instead of duplicating. Set on the
// first successful push, cleared if the user manually unlinks. NULL on
// recipes that were never pushed. See server/routes/nt-federation.js
// push-recipe endpoint and the /api/v1/recipes upsert on the NT side.
if (!columnExists('recipes', 'nt_meal_id')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN nt_meal_id INTEGER`);
}

// ai_chat_history was originally append-only with just created_at, but
// /api/sync/pull SELECTs updated_at on every table in TABLES (including
// this one). Without the column, the pull SQL errors with "no such
// column: updated_at" and the whole sync fails — every other entity
// shows up empty on a freshly-connected device.
//
// SQLite refuses non-constant DEFAULTs (datetime('now')) on ALTER ADD
// COLUMN, so we add the column with no default and use a pair of
// AFTER INSERT / AFTER UPDATE triggers to populate it. Existing rows
// are backfilled from created_at so the WHERE updated_at > ? filter
// behaves sensibly until the next mutation touches them.
if (!columnExists('ai_chat_history', 'updated_at')) {
  db.exec(`ALTER TABLE ai_chat_history ADD COLUMN updated_at TEXT`);
  db.exec(`UPDATE ai_chat_history SET updated_at = created_at WHERE updated_at IS NULL`);
}
db.exec(`
  CREATE TRIGGER IF NOT EXISTS trg_ai_chat_history_updated_at_ins
  AFTER INSERT ON ai_chat_history
  FOR EACH ROW WHEN NEW.updated_at IS NULL
  BEGIN
    UPDATE ai_chat_history SET updated_at = datetime('now') WHERE id = NEW.id;
  END;
`);
db.exec(`
  CREATE TRIGGER IF NOT EXISTS trg_ai_chat_history_updated_at_upd
  AFTER UPDATE ON ai_chat_history
  FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
  BEGIN
    UPDATE ai_chat_history SET updated_at = datetime('now') WHERE id = NEW.id;
  END;
`);

// Cook log entries get optional photo_url for the dialog flow.
if (!columnExists('cook_diary', 'photo_url')) {
  db.exec(`ALTER TABLE cook_diary ADD COLUMN photo_url TEXT`);
}
// Multi-photo upgrade: photos is a JSON array of URLs. photo_url is
// kept for backwards compatibility (old rows + legacy clients) and
// always mirrors photos[0] going forward.
if (!columnExists('cook_diary', 'photos')) {
  db.exec(`ALTER TABLE cook_diary ADD COLUMN photos TEXT`);
}

// Diary v2 — meal-type slot per entry (Breakfast / Lunch / Dinner /
// Snack / null), and a per-cook rating distinct from the recipe's
// overall rating ("how did it turn out THIS time?"). Both optional;
// existing rows keep working with NULL values.
if (!columnExists('cook_diary', 'meal_type')) {
  db.exec(`ALTER TABLE cook_diary ADD COLUMN meal_type TEXT`);
}
if (!columnExists('cook_diary', 'rating')) {
  db.exec(`ALTER TABLE cook_diary ADD COLUMN rating INTEGER`);
}

// Pantry schema upgrade: categories + per-item nutrition + serving
// size. Together these unlock recipe-nutrition auto-calc and let a
// NutriTrace food import as a complete pantry row.
if (!columnExists('pantry_items', 'brand')) {
  db.exec(`ALTER TABLE pantry_items ADD COLUMN brand TEXT`);
}
if (!columnExists('pantry_items', 'barcode')) {
  db.exec(`ALTER TABLE pantry_items ADD COLUMN barcode TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pantry_barcode ON pantry_items(barcode)`);
}
if (!columnExists('pantry_items', 'category')) {
  db.exec(`ALTER TABLE pantry_items ADD COLUMN category TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pantry_category ON pantry_items(category)`);
}
if (!columnExists('pantry_items', 'serving_size')) {
  db.exec(`ALTER TABLE pantry_items ADD COLUMN serving_size REAL`);
}
if (!columnExists('pantry_items', 'serving_unit')) {
  db.exec(`ALTER TABLE pantry_items ADD COLUMN serving_unit TEXT`);
}
if (!columnExists('pantry_items', 'serving_label')) {
  db.exec(`ALTER TABLE pantry_items ADD COLUMN serving_label TEXT`);
}
if (!columnExists('pantry_items', 'nutrition')) {
  db.exec(`ALTER TABLE pantry_items ADD COLUMN nutrition TEXT`);
}
// Density bridges volume↔weight for ingredient-aware nutrition auto-calc.
// Stored as grams per cup (the most common cooking volume in our 37-unit
// catalog). Convert to other volume units in client code via the unit
// table. NULL = unknown, fall back to "skip with badge" behavior.
if (!columnExists('pantry_items', 'g_per_cup')) {
  db.exec(`ALTER TABLE pantry_items ADD COLUMN g_per_cup REAL`);
}

// ── Pantry variants (Issue #4) ─────────────────────────────────────────
// Lets one pantry item be a "generic" with multiple brand-specific
// children (e.g. parent "Milk" with variants "Milk (Brand A)" and
// "Milk (Brand B)"). Hierarchy is intentionally one-level: a row is
// either flat (both columns NULL), a generic (rows pointing at it via
// generic_parent_id), or a variant (its own generic_parent_id is set).
//
// generic_parent_id   FK to pantry_items(id). NULL for flat items and
//                     for generics themselves. Set on every variant.
// nutrition_source_variant_id
//                     FK to pantry_items(id). When set, the parent row
//                     pulls its effective nutrition from this variant
//                     for recipe calculations. NULL = use the parent's
//                     own nutrition field (current behaviour). Only
//                     valid on rows that are themselves generics.
if (!columnExists('pantry_items', 'generic_parent_id')) {
  db.exec(`ALTER TABLE pantry_items ADD COLUMN generic_parent_id INTEGER REFERENCES pantry_items(id) ON DELETE SET NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pantry_generic_parent ON pantry_items(generic_parent_id)`);
}
if (!columnExists('pantry_items', 'nutrition_source_variant_id')) {
  db.exec(`ALTER TABLE pantry_items ADD COLUMN nutrition_source_variant_id INTEGER REFERENCES pantry_items(id) ON DELETE SET NULL`);
}

// ── Recipe categories ──────────────────────────────────────────────────────
// One category per recipe (Paprika/Crouton model — simple and matches how
// people think about meal types). The catalog is shared per-user; admin
// edits the list in Settings → Categories.
db.exec(`
  CREATE TABLE IF NOT EXISTS recipe_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    color       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_recipe_categories_user ON recipe_categories(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_categories_user_slug ON recipe_categories(user_id, slug);
`);
if (!columnExists('recipes', 'category_id')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN category_id INTEGER REFERENCES recipe_categories(id) ON DELETE SET NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recipes_category ON recipes(category_id)`);
}
// Public-link share token. Random url-safe string minted on demand;
// null until the user opts into a public link. Lookup must be O(1)
// for the public read path so we index it.
if (!columnExists('recipes', 'share_token')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN share_token TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recipes_share_token ON recipes(share_token)`);
}
// Video Instructions — either an external URL (YouTube, Vimeo,
// Instagram, TikTok, ...) or a local path under /uploads/. The
// RecipeView block hides itself entirely when this is null/blank.
if (!columnExists('recipes', 'video_url')) {
  db.exec(`ALTER TABLE recipes ADD COLUMN video_url TEXT`);
}

// Seed default cookbook-chapter categories per user. Idempotent — only
// runs for users who don't already have a category set.
{
  const DEFAULTS = [
    ['Breakfast',  'breakfast',  '#f59e0b'],
    ['Lunch',      'lunch',      '#84cc16'],
    ['Dinner',     'dinner',     '#ef4444'],
    ['Appetizer',  'appetizer',  '#a855f7'],
    ['Side',       'side',       '#06b6d4'],
    ['Soup',       'soup',       '#f97316'],
    ['Salad',      'salad',      '#22c55e'],
    ['Bread',      'bread',      '#d97706'],
    ['Dessert',    'dessert',    '#ec4899'],
    ['Drink',      'drink',      '#3b82f6'],
    ['Snack',      'snack',      '#14b8a6'],
    ['Sauce',      'sauce',      '#6366f1'],
    ['Preserves',  'preserves',  '#9f1239'],
  ];
  const userIds = db.prepare(`SELECT id FROM users`).all().map(r => r.id);
  // Single-user mode (no users table rows): seed under user_id NULL too.
  const targets = userIds.length ? userIds : [null];
  const hasAny = db.prepare(
    `SELECT 1 FROM recipe_categories WHERE ${targets[0] == null ? 'user_id IS NULL' : 'user_id = ?'} LIMIT 1`
  );
  const ins = db.prepare(
    `INSERT INTO recipe_categories (user_id, name, slug, color, sort_order) VALUES (?, ?, ?, ?, ?)`
  );
  for (const u of targets) {
    const args = u == null ? [] : [u];
    if (hasAny.get(...args)) continue;
    DEFAULTS.forEach(([name, slug, color], i) => ins.run(u, name, slug, color, i));
  }
}

// ── Recipe comments ────────────────────────────────────────────────────────
// Flat threading for v1; parent_id is reserved so threading can light up
// later without a migration. created_by_username is denormalized so old
// comments survive a user delete (cascade clears user_id but keeps the
// display name).
db.exec(`
  CREATE TABLE IF NOT EXISTS recipe_comments (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id            INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
    parent_id            INTEGER REFERENCES recipe_comments(id) ON DELETE CASCADE,
    body                 TEXT NOT NULL,
    created_by_username  TEXT,
    created_at           TEXT DEFAULT (datetime('now')),
    updated_at           TEXT DEFAULT (datetime('now')),
    deleted_at           TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recipe_comments_recipe  ON recipe_comments(recipe_id);
  CREATE INDEX IF NOT EXISTS idx_recipe_comments_user    ON recipe_comments(user_id);
  CREATE INDEX IF NOT EXISTS idx_recipe_comments_deleted ON recipe_comments(deleted_at);
`);

// ── Pantry categories ──────────────────────────────────────────────────────
// Promoted from a hardcoded constant list (`src/lib/pantry-categories.js`)
// to a per-user DB table so users can add/rename/recolor their own. The
// existing `pantry_items.category` text column stores the *slug* and stays
// in place for backwards compat — `category_id` is the new authoritative
// link. The seed migration below stamps category_id for every existing
// pantry row whose category slug matches a seeded row.
db.exec(`
  CREATE TABLE IF NOT EXISTS pantry_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    icon        TEXT,
    color       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pantry_categories_user ON pantry_categories(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pantry_categories_user_slug ON pantry_categories(user_id, slug);
`);
if (!columnExists('pantry_items', 'category_id')) {
  db.exec(`ALTER TABLE pantry_items ADD COLUMN category_id INTEGER REFERENCES pantry_categories(id) ON DELETE SET NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pantry_items_category_id ON pantry_items(category_id)`);
}

// Stamp the recipe a shopping-list row was added from (when imported via
// "Add from Recipe"). Lets the client render a small recipe chip next to
// each row and group / bulk-remove by recipe later. Manually-added rows
// keep recipe_id NULL. SET NULL on recipe delete so the row sticks
// around as a plain shopping item rather than disappearing under the
// shopper's feet.
if (!columnExists('shopping_list', 'recipe_id')) {
  db.exec(`ALTER TABLE shopping_list ADD COLUMN recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shopping_recipe_id ON shopping_list(recipe_id)`);
}
// Optional per-item sort order for drag-to-reorder within a group.
// NULL means "use the default sort (alphabetical name within group)";
// a value here wins. Set by the client on drag; cleared when the user
// resets a group to auto-sort.
if (!columnExists('shopping_list', 'sort_order')) {
  db.exec(`ALTER TABLE shopping_list ADD COLUMN sort_order INTEGER`);
}
// Optional per-category default aisle. When set, new shopping items
// linked to this category inherit this string as their aisle; the
// user still overrides per item after auto-assignment. Free text
// (numbers, section names, walking-route hints).
if (!columnExists('pantry_categories', 'default_aisle')) {
  db.exec(`ALTER TABLE pantry_categories ADD COLUMN default_aisle TEXT`);
}

// Seed defaults per user (idempotent — only runs for users who don't yet
// have any pantry_categories rows). Mirrors the legacy hardcoded list in
// src/lib/pantry-categories.js so existing UI keeps working through the
// transition.
{
  const PANTRY_DEFAULTS = [
    ['Produce',         'produce',   'eco'],
    ['Meat',            'meat',      'restaurant'],
    ['Poultry',         'poultry',   'egg_alt'],
    ['Seafood',         'seafood',   'set_meal'],
    ['Dairy & Eggs',    'dairy',     'local_drink'],
    ['Grains & Pasta',  'grain',     'grain'],
    ['Baking',          'baking',    'cake'],
    ['Spices & Herbs',  'spice',     'local_florist'],
    ['Condiments',      'condiment', 'lunch_dining'],
    ['Oils & Vinegar',  'oil',       'opacity'],
    ['Canned & Jarred', 'canned',    'inventory_2'],
    ['Frozen',          'frozen',    'ac_unit'],
    ['Beverages',       'beverage',  'local_cafe'],
    ['Snacks',          'snack',     'cookie'],
    ['Other',           'other',     'kitchen'],
  ];
  const userIds = db.prepare(`SELECT id FROM users`).all().map(r => r.id);
  const targets = userIds.length ? userIds : [null];
  const hasAny = db.prepare(
    `SELECT 1 FROM pantry_categories WHERE ${targets[0] == null ? 'user_id IS NULL' : 'user_id = ?'} LIMIT 1`
  );
  const ins = db.prepare(
    `INSERT INTO pantry_categories (user_id, name, slug, icon, sort_order) VALUES (?, ?, ?, ?, ?)`
  );
  for (const u of targets) {
    const args = u == null ? [] : [u];
    if (hasAny.get(...args)) continue;
    PANTRY_DEFAULTS.forEach(([name, slug, icon], i) => ins.run(u, name, slug, icon, i));
  }
}

// One-time heal: an earlier server bug stored last_cooked_at as a
// malformed "YYYY-MM-DD YYYY-MM-DD HH:MM:SS" string (the SQL
// concatenated `date` and `created_at` instead of just date). Detect
// rows where the value isn't parseable as a date and rebuild from
// the latest cook_diary.date for that recipe.
db.exec(`
  UPDATE recipes
     SET last_cooked_at = (
       SELECT MAX(date) FROM cook_diary cd
        WHERE cd.recipe_id = recipes.id
          AND cd.deleted_at IS NULL
          AND cd.kind = 'cooked'
     )
   WHERE last_cooked_at IS NOT NULL
     AND last_cooked_at NOT GLOB '????-??-??*'
     OR  (last_cooked_at IS NOT NULL
          AND length(last_cooked_at) > 19)
`);

// One-time backfill: stamp pantry_items.category_id from the legacy
// pantry_items.category slug. Only touches rows that have a slug but no
// category_id yet, so it's safe to re-run.
db.exec(`
  UPDATE pantry_items
     SET category_id = (
       SELECT pc.id FROM pantry_categories pc
        WHERE pc.slug = pantry_items.category
          AND (
            pc.user_id = pantry_items.user_id
            OR (pc.user_id IS NULL AND pantry_items.user_id IS NULL)
          )
        LIMIT 1
     )
   WHERE category_id IS NULL
     AND category IS NOT NULL
     AND category != ''
`);

// ── Custom + disabled units ────────────────────────────────────────────────
// The 37 built-in cooking units live in `src/lib/units.js`. Users get to:
//   - hide built-ins they don't use (per-user, no data loss)
//   - add their own custom units (e.g. "head" for garlic)
//
// Built-ins are referenced by their abbreviation (the stable id used as
// the value in recipe ingredients). disabled_units stores one row per
// (user, abbr) pair the user has hidden.
db.exec(`
  CREATE TABLE IF NOT EXISTS custom_units (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    abbr        TEXT NOT NULL,
    full_name   TEXT NOT NULL,
    category    TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_custom_units_user ON custom_units(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_units_user_abbr ON custom_units(user_id, abbr);

  CREATE TABLE IF NOT EXISTS disabled_units (
    user_id  INTEGER,
    abbr     TEXT NOT NULL,
    PRIMARY KEY (user_id, abbr)
  );
`);

// ── Cookbooks ──────────────────────────────────────────────────────────────
// User-curated recipe collections. A recipe can live in many cookbooks
// via the join table. `is_smart` + `smart_filter_json` are reserved for
// the smart-filter cookbook follow-up; left null on regular ones.
db.exec(`
  CREATE TABLE IF NOT EXISTS cookbooks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    slug              TEXT NOT NULL,
    description       TEXT,
    cover_image_url   TEXT,
    is_smart          INTEGER NOT NULL DEFAULT 0,
    smart_filter_json TEXT,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now')),
    deleted_at        TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cookbooks_user    ON cookbooks(user_id);
  CREATE INDEX IF NOT EXISTS idx_cookbooks_deleted ON cookbooks(deleted_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cookbooks_user_slug ON cookbooks(user_id, slug);

  CREATE TABLE IF NOT EXISTS recipe_cookbook_links (
    cookbook_id  INTEGER NOT NULL REFERENCES cookbooks(id) ON DELETE CASCADE,
    recipe_id    INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    added_at     TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (cookbook_id, recipe_id)
  );
  CREATE INDEX IF NOT EXISTS idx_rcb_recipe ON recipe_cookbook_links(recipe_id);
`);

// ── Per-user recipe sharing ────────────────────────────────────────────────
// Owner X explicitly grants user Y read access to a recipe. Different
// from `recipes.visibility = 'group'` (everyone) and `share_token` (any
// link recipient): this is a per-user grant that surfaces in Y's
// "Shared with me" view.
db.exec(`
  CREATE TABLE IF NOT EXISTS recipe_shares (
    recipe_id    INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    grantee_id   INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    granted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    granted_at   TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (recipe_id, grantee_id)
  );
  CREATE INDEX IF NOT EXISTS idx_recipe_shares_grantee ON recipe_shares(grantee_id);
`);

// ── Notification de-dupe log ───────────────────────────────────────────────
// Records every notification the scheduler has fired so the next tick
// doesn't double-send. (kind, ref_id, fired_date) is the dedup key.
db.exec(`
  CREATE TABLE IF NOT EXISTS notification_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    ref_id      INTEGER,
    fired_date  TEXT NOT NULL,
    fired_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notif_log_user ON notification_log(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_log_dedup ON notification_log(user_id, kind, ref_id, fired_date);
`);

// ── Kitchens ───────────────────────────────────────────────────────────────
// A "kitchen" is a soft group of users who share recipes (and, in
// future iterations, pantry / shopping / meal-plan). The MVP surface
// is: create a kitchen, invite users by username, share recipes with
// the kitchen as a single action that fans out to per-user shares
// using the existing recipe_shares table. No per-kitchen scope rule
// on recipes/pantry/etc. yet — sharing is the integration point.
db.exec(`
  CREATE TABLE IF NOT EXISTS kitchens (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    slug          TEXT NOT NULL,
    owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_kitchens_slug ON kitchens(slug);

  CREATE TABLE IF NOT EXISTS kitchen_members (
    kitchen_id INTEGER NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'member',
    joined_at  TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (kitchen_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_kitchen_members_user ON kitchen_members(user_id);
`);

// Per-user auto-share opt-in per kitchen. When 1, every recipe the user
// creates fans out per-user grants to every other kitchen member via
// recipe_shares, and enabling backfills the same for their existing
// recipes. On kitchen leave / remove we revoke every share tagged with
// via_kitchen_id = <that kitchen> so exiting = losing access, both
// directions.
if (!columnExists('kitchen_members', 'auto_share')) {
  db.exec(`ALTER TABLE kitchen_members ADD COLUMN auto_share INTEGER NOT NULL DEFAULT 0`);
}
if (!columnExists('recipe_shares', 'via_kitchen_id')) {
  db.exec(`ALTER TABLE recipe_shares ADD COLUMN via_kitchen_id INTEGER REFERENCES kitchens(id) ON DELETE SET NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recipe_shares_via_kitchen ON recipe_shares(via_kitchen_id)`);
}

// Per-user cookbook sharing — mirrors recipe_shares including the
// via_kitchen_id tag so kitchen leave / delete semantics stay
// consistent between recipes and cookbooks. Explicit only; no
// auto-share equivalent (cookbooks are personal curation, not raw
// material). Reads on a shared cookbook are read-only for the
// grantee; edits + membership stay owner-only.
db.exec(`
  CREATE TABLE IF NOT EXISTS cookbook_shares (
    cookbook_id    INTEGER NOT NULL REFERENCES cookbooks(id) ON DELETE CASCADE,
    grantee_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    granted_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    granted_at     TEXT DEFAULT (datetime('now')),
    via_kitchen_id INTEGER REFERENCES kitchens(id) ON DELETE SET NULL,
    PRIMARY KEY (cookbook_id, grantee_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cookbook_shares_grantee     ON cookbook_shares(grantee_id);
  CREATE INDEX IF NOT EXISTS idx_cookbook_shares_via_kitchen ON cookbook_shares(via_kitchen_id);
`);

// ── One-time fix: rewrite malformed recipe.last_cooked_at values ──────────
// The earlier recompute SQL concatenated cook_diary.date with a full
// timestamp via `date || ' ' || created_at`, producing strings like
// "2026-05-02 2026-05-16 14:30:00". They don't parse as Date, so the
// "Last cooked" line rendered blank in the UI even though cook entries
// existed. Detect any malformed value (length > 10 chars or contains a
// space-then-date pattern) and replace with MAX(date) for that recipe.
// Idempotent: subsequent boots are a no-op because the rewritten values
// are now well-formed date-only strings.
db.exec(`
  UPDATE recipes
     SET last_cooked_at = (
           SELECT MAX(date) FROM cook_diary
            WHERE recipe_id = recipes.id
              AND deleted_at IS NULL
              AND kind = 'cooked'
         ),
         cook_count = (
           SELECT COUNT(*) FROM cook_diary
            WHERE recipe_id = recipes.id
              AND deleted_at IS NULL
              AND kind = 'cooked'
         )
   WHERE last_cooked_at IS NOT NULL
     AND length(last_cooked_at) > 10;
`);

// ── One-time backfill: title-case existing shopping_list names ────────────
// Mealie's canonical food names land lowercase ("fresh lemon juice").
// Earlier versions copied them straight into shopping_list. The handler
// now title-cases on insert; this pass fixes rows already in the DB.
// Idempotent — only touches rows where name === LOWER(name), so
// already-cased entries and mixed-case manual entries pass through.
{
  const MINOR = new Set([
    'a','an','and','as','at','but','by','for','if','in','nor','of','on','or','the','to','up','via',
  ]);
  const _titleCase = (raw) => {
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
        if (MINOR.has(lower) && !(isFirstToken && isFirstSeg)) return lower;
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      }).join('-');
    }).join('');
  };
  const candidates = db.prepare(
    `SELECT id, name FROM shopping_list
      WHERE name IS NOT NULL AND name = LOWER(name) AND deleted_at IS NULL`
  ).all();
  if (candidates.length > 0) {
    const upd = db.prepare(`UPDATE shopping_list SET name = ? WHERE id = ?`);
    const tx = db.transaction(() => {
      for (const row of candidates) {
        const cased = _titleCase(row.name);
        if (cased && cased !== row.name) upd.run(cased, row.id);
      }
    });
    tx();
  }
}

// ── Seed default app_config rows ───────────────────────────────────────────
{
  const seeds = [
    ['enable_email_password_login', '1'],
  ];
  const ins = db.prepare(`INSERT OR IGNORE INTO app_config (key, value) VALUES (?, ?)`);
  for (const [k, v] of seeds) ins.run(k, v);
}

export default db;
