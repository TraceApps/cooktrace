/**
 * full-backup.js — full DB + uploads ZIP. Mirrors NutriTrace's
 * implementation, scoped to CookTrace's schema (recipes / pantry /
 * cook_diary / shopping_list / users / settings / OIDC).
 *
 * Endpoints (admin-only):
 *   GET    /api/full-backup           — list backups on disk
 *   POST   /api/full-backup           — create a new backup ZIP
 *   GET    /api/full-backup/:name/download
 *   DELETE /api/full-backup/:name
 *   POST   /api/full-backup/:name/restore
 *   POST   /api/full-backup/upload-restore (multipart `backup` field)
 */
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import multer from 'multer';
import db, { backfillRevisions, rekeyRevisions } from '../db.js';
import { logger } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { isValidTimeZone, processTimeZone } from '../lib/zoned-time.js';
import { effectiveTimeZone, nextBackupAt, backupFileStamp, newestFirst } from '../lib/backup-schedule.js';
// Makes the two-step sign-in tables a backup reads and restores (nutritrace#222).
import { logAfterRestore as logTwoStepAfterRestore } from '../lib/two-step.js';
import { keepSessionVersions } from '../lib/session-version.js';

const router = express.Router();
router.use(requireAuth);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UPLOADS_DIR = process.env.UPLOADS_PATH || path.resolve(__dirname, '..', '..', 'uploads');
const BACKUPS_DIR = process.env.BACKUPS_PATH || path.join(UPLOADS_DIR, 'backups');

fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// ── Schedule config (admin-global, stored in app_config) ──────────────────
// Mirrors NutriTrace's scheduled-backup feature 1:1 for TraceApps parity.
// See server/routes/full-backup.js in the nutritrace repo for the
// canonical design notes; same env-lock contract (BACKUP_SCHEDULE /
// BACKUP_TIME / BACKUP_RETENTION) so ops operators can bake the policy
// into Compose.
const SCHEDULES = new Set(['off', 'daily', 'weekly', 'monthly']);
const DEFAULT_SCHEDULE = 'off';
const DEFAULT_TIME = '03:00';
const DEFAULT_RETENTION = 7;

export function isBackupEnvLocked() {
  return !!(process.env.BACKUP_SCHEDULE
         || process.env.BACKUP_TIME
         || process.env.BACKUP_RETENTION);
}

function _cfg(key) {
  return db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value;
}
function _setCfg(key, value) {
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? '' : String(value));
}

export function getScheduleConfig() {
  const envSchedule  = process.env.BACKUP_SCHEDULE;
  const envTime      = process.env.BACKUP_TIME;
  const envRetention = process.env.BACKUP_RETENTION;
  const schedule = SCHEDULES.has(envSchedule) ? envSchedule
                 : SCHEDULES.has(_cfg('backup_schedule')) ? _cfg('backup_schedule')
                 : DEFAULT_SCHEDULE;
  const time     = (envTime && /^\d{1,2}:\d{2}$/.test(envTime)) ? envTime
                 : (_cfg('backup_time') && /^\d{1,2}:\d{2}$/.test(_cfg('backup_time'))) ? _cfg('backup_time')
                 : DEFAULT_TIME;
  const retention = Math.max(1, Math.min(99, parseInt(envRetention || _cfg('backup_retention') || DEFAULT_RETENTION, 10) || DEFAULT_RETENTION));
  // The zone the time is in: saved with it from the browser that set it
  // (TraceApps/notetrace#44); none (older installs, a schedule set by
  // environment) runs in the server's own zone, TZ or UTC.
  const saved = isBackupEnvLocked() ? null : (_cfg('backup_time_zone') || null);
  const timeZone = isValidTimeZone(saved) ? saved : null;
  const lastAutoRun = _cfg('backup_last_auto_run') || null;
  const setAt = _cfg('backup_schedule_set_at') || null;
  return {
    schedule, time, retention,
    timeZone,
    runsIn:        effectiveTimeZone(timeZone),
    serverTimeZone: processTimeZone(),
    setAt,
    nextRunAt:     nextBackupAt({ schedule, time, timeZone, lastAutoRun, setAt }),
    lastAutoRun,
    lastAutoError: _cfg('backup_last_auto_error') || null,
    envLocked:     isBackupEnvLocked(),
  };
}

export function setScheduleConfig({ schedule, time, retention, timeZone }) {
  if (isBackupEnvLocked()) {
    const err = new Error('Backup schedule is locked by environment variable');
    err.code = 'ENV_LOCKED';
    throw err;
  }
  // Every field checked before any is saved: a bad one changes nothing.
  const writes = [];
  if (schedule != null) {
    if (!SCHEDULES.has(schedule)) throw new Error('schedule must be one of: off, daily, weekly, monthly');
    writes.push(['backup_schedule', schedule]);
  }
  if (time != null) {
    if (!/^\d{1,2}:\d{2}$/.test(time)) throw new Error('time must be HH:MM');
    const [h, m] = time.split(':').map(n => parseInt(n, 10));
    if (h < 0 || h > 23 || m < 0 || m > 59) throw new Error('time out of range');
    writes.push(['backup_time', `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`]);
  }
  if (retention != null) {
    const r = parseInt(retention, 10);
    if (!Number.isFinite(r) || r < 1 || r > 99) throw new Error('retention must be 1-99');
    writes.push(['backup_retention', String(r)]);
  }
  // An IANA zone such as "America/New_York"; '' goes back to the server's zone.
  if (timeZone !== undefined) {
    if (timeZone === null || timeZone === '') writes.push(['backup_time_zone', '']);
    else if (!isValidTimeZone(timeZone)) throw new Error('timeZone must be an IANA time zone, such as America/New_York');
    else writes.push(['backup_time_zone', timeZone]);
  }
  // When it was set, for a first run that comes at its time (backup-schedule.js).
  if (schedule != null || time != null || timeZone !== undefined) writes.push(['backup_schedule_set_at', new Date().toISOString()]);
  db.transaction(() => { for (const [k, v] of writes) _setCfg(k, v); })();
  return getScheduleConfig();
}

/** Create a full ZIP backup on disk; shared by POST / and the scheduler. */
export function createBackup({ now = Date.now() } = {}) {
  // Named in the schedule's zone with its offset (TraceApps/notetrace#44).
  // Never overwrite: two backups in the same second get a number.
  const timestamp = backupFileStamp(getScheduleConfig().timeZone, now);
  let filename = `cooktrace-backup-${timestamp}.zip`;
  for (let n = 2; fs.existsSync(path.join(BACKUPS_DIR, filename)); n++) filename = `cooktrace-backup-${timestamp}-${n}.zip`;
  const destPath  = path.join(BACKUPS_DIR, filename);
  const zip = new AdmZip();
  zip.addFile('database.json', Buffer.from(JSON.stringify(dumpDatabase(), null, 2), 'utf8'));
  if (fs.existsSync(UPLOADS_DIR)) {
    const SKIP_DIRS = new Set([BACKUPS_DIR, path.join(UPLOADS_DIR, '.import-cache')]);
    const addDir = (dir, zipPath) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const zp   = zipPath ? `${zipPath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(full)) continue;
          if (entry.name.startsWith('.')) continue;
          addDir(full, zp);
        } else {
          zip.addFile(`images/${zp}`, fs.readFileSync(full));
        }
      }
    };
    addDir(UPLOADS_DIR, '');
  }
  zip.writeZip(destPath);
  const stat = fs.statSync(destPath);
  return { filename, size: stat.size, createdAt: new Date(now).toISOString() };
}

/** Delete archives beyond the retention limit, keeping the N newest. */
export function pruneOldBackups(retention) {
  const keep = Math.max(1, Math.min(99, parseInt(retention, 10) || DEFAULT_RETENTION));
  // Newest first by when each was made, read from the name (local time with
  // its offset since TraceApps/notetrace#44, UTC before), so a copied folder
  // that lost its file dates still keeps the right ones; the file's date only
  // for other names.
  const all = newestFirst(fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith('cooktrace-backup-') && f.endsWith('.zip'))
    .map(name => ({ name, mtime: (() => { try { return fs.statSync(path.join(BACKUPS_DIR, name)).mtimeMs; } catch { return 0; } })() })))
    .map(x => x.name);
  const toDelete = all.slice(keep);
  for (const f of toDelete) {
    try { fs.unlinkSync(path.join(BACKUPS_DIR, f)); }
    catch (e) { logger.warn?.(`[backup] prune failed for ${f}: ${e.message}`); }
  }
  return toDelete;
}

/** Run a scheduled backup: create, prune, mark success/failure state. */
export async function runScheduledBackup() {
  const cfg = getScheduleConfig();
  try {
    const result = createBackup();
    pruneOldBackups(cfg.retention);
    _setCfg('backup_last_auto_run', new Date().toISOString());
    _setCfg('backup_last_auto_error', '');
    logger.info?.(`[backup] scheduled backup ok: ${result.filename} (${(result.size / 1024 / 1024).toFixed(1)} MB), pruned to ${cfg.retention}`);
    return result;
  } catch (e) {
    _setCfg('backup_last_auto_error', e.message || String(e));
    logger.warn?.(`[backup] scheduled backup failed: ${e.message}`);
    try {
      const adminRow = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
      if (adminRow) {
        const { pushNotify } = await import('../lib/push-notify.js');
        await pushNotify(adminRow.id, 'notifBackupFailed',
          '🛟 CookTrace backup failed',
          `Scheduled backup error: ${e.message || 'unknown'}`,
          7);
      }
    } catch {}
    throw e;
  }
}

// Multer: stream to disk so large ZIPs don't OOM the container. 512 MB
// cap is generous for DB + photos; tunable via BACKUP_UPLOAD_MAX_MB.
const _backupMaxMb = parseInt(process.env.BACKUP_UPLOAD_MAX_MB || '512', 10);
const upload = multer({
  storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, os.tmpdir()) }),
  limits: { fileSize: _backupMaxMb * 1024 * 1024 },
});

// ── Tables we dump / restore ──────────────────────────────────────────
// Server-only ephemera (oauth_state, password_reset_tokens,
// notification_log) is intentionally skipped — their lifetime is
// shorter than a backup and restoring stale rows would either
// re-fire notifications or hand out consumed tokens.
function dumpDatabase() {
  return {
    users:           db.prepare('SELECT * FROM users').all(),
    user_settings:   db.prepare('SELECT * FROM user_settings').all(),
    app_config:      db.prepare('SELECT * FROM app_config').all(),
    ai_chat_history: db.prepare('SELECT * FROM ai_chat_history').all(),
    recipes:         db.prepare('SELECT * FROM recipes').all(),
    pantry_items:    db.prepare('SELECT * FROM pantry_items').all(),
    cook_diary:      db.prepare('SELECT * FROM cook_diary').all(),
    shopping_list:   db.prepare('SELECT * FROM shopping_list').all(),
    // User-curated taxonomies + organization. Without these the
    // restore would lose every category color, cookbook, share grant,
    // kitchen, custom unit, and comment thread.
    recipe_categories:     _selectIfExists('recipe_categories'),
    recipe_comments:       _selectIfExists('recipe_comments'),
    pantry_categories:     _selectIfExists('pantry_categories'),
    custom_units:          _selectIfExists('custom_units'),
    disabled_units:        _selectIfExists('disabled_units'),
    cookbooks:             _selectIfExists('cookbooks'),
    recipe_cookbook_links: _selectIfExists('recipe_cookbook_links'),
    recipe_versions:       _selectIfExists('recipe_versions'),
    recipe_revisions:      _selectIfExists('recipe_revisions'),
    recipe_shares:         _selectIfExists('recipe_shares'),
    cookbook_shares:       _selectIfExists('cookbook_shares'),
    kitchens:              _selectIfExists('kitchens'),
    kitchen_members:       _selectIfExists('kitchen_members'),
    oidc_providers:        _selectIfExists('oidc_providers'),
    user_oidc_links:       _selectIfExists('user_oidc_links'),
    // Admin-created invitations that have not been consumed yet.
    // Expired rows are cleaned up by the scheduler on the next tick
    // (see server/lib/scheduler.js), so including them is safe.
    // TODO(review): should invite_tokens be included in backups? Rows
    // may be expired or already-used by the time the restore runs.
    invite_tokens:         _selectIfExists('invite_tokens'),
    // Integrations set up by hand: API tokens (hashed) and webhooks.
    api_tokens:            _selectIfExists('api_tokens'),
    webhooks:              _selectIfExists('webhooks'),
    // Two-step sign-in (nutritrace#222): secrets stay locked with this
    // server's two-step key, which is never in the archive; recovery codes
    // are hashes.
    user_two_step:   db.prepare('SELECT * FROM user_two_step').all(),
    user_two_step_recovery: db.prepare('SELECT * FROM user_two_step_recovery').all(),
  };
}

function _selectIfExists(table) {
  try {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
    if (!row) return [];
    return db.prepare(`SELECT * FROM ${table}`).all();
  } catch { return []; }
}

function restoreFromZip(zip) {
  const data = JSON.parse(zip.readAsText('database.json'));

  // Signed-out sessions stay signed out (lib/session-version.js).
  keepSessionVersions(() => db.transaction(() => {
    // Defer FK checks until COMMIT so self-referential FKs on
    // pantry_items (generic_parent_id, nutrition_source_variant_id)
    // don't trip when a child row inserts before its parent within the
    // same transaction. Standard SQLite pattern for tree restores.
    db.pragma('defer_foreign_keys = ON');
    // What devices may hold of the tables that say a row is gone only with
    // its deleted_at, read before the wipe (keepGone, below).
    const before = rowsBefore(data);
    // Wipe in dependency order, children before parents.
    db.prepare('DELETE FROM cook_diary').run();
    db.prepare('DELETE FROM shopping_list').run();
    db.prepare('DELETE FROM recipes').run();
    db.prepare('DELETE FROM pantry_items').run();
    db.prepare('DELETE FROM ai_chat_history').run();
    // Categories and units are deleted here, while their accounts are
    // there, so each gets its sync_deletions record (db.js) and devices drop
    // one the backup doesn't hold; one it holds is put back under the same
    // id, which the pull doesn't send as gone. The accounts' delete below
    // would take them without a record, and takes the records too (they
    // belong to an account): kept here and put back after (keepGone).
    for (const t of ['recipe_categories', 'pantry_categories', 'custom_units']) {
      try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* not in this build */ }
    }
    before.sync_deletions = _selectIfExists('sync_deletions');
    db.prepare('DELETE FROM user_settings').run();
    db.prepare('DELETE FROM app_config').run();
    if (_selectIfExists('user_oidc_links').length === 0) {} // no-op probe
    try { db.prepare('DELETE FROM user_oidc_links').run(); } catch {}
    try { db.prepare('DELETE FROM oidc_providers').run(); } catch {}
    db.prepare('DELETE FROM users').run();

    const insUser = db.prepare(`
      INSERT OR IGNORE INTO users (id, username, password_hash, full_name, nickname, email, birthday, gender, avatar_url, role, created_at)
      VALUES (@id, @username, @password_hash, @full_name, @nickname, @email, @birthday, @gender, @avatar_url, @role, @created_at)
    `);
    for (const u of data.users || []) insUser.run(_withDefaults(u, {
      full_name: null, nickname: null, email: null, birthday: null, gender: null, avatar_url: null, role: 'user',
    }));

    const insSettings = db.prepare(`
      INSERT OR IGNORE INTO user_settings (user_id, key, value, updated_at, deleted_at)
      VALUES (@user_id, @key, @value, @updated_at, @deleted_at)
    `);
    for (const s of data.user_settings || []) insSettings.run(_withDefaults(s, { updated_at: null, deleted_at: null }));

    const insConfig = db.prepare(`
      INSERT OR REPLACE INTO app_config (key, value) VALUES (@key, @value)
    `);
    for (const c of data.app_config || []) insConfig.run(c);

    // ai_chat_history uses the schema-driven helper below so the
    // migrated updated_at column (added in rc.2 as part of the sync
    // pull fix) is written back verbatim instead of being replaced
    // with a restore-time NOW() by the AFTER INSERT trigger.
    // Recipes / pantry_items / cook_diary / shopping_list use the
    // same helper. Every column PRAGMA reports is included in the
    // INSERT, so a future ALTER TABLE never silently drops a column
    // at restore time (rc.3 audit found recipes was missing
    // rest_minutes, total_minutes, category_id, share_token, and
    // video_url from a hardcoded column list — switching to
    // PRAGMA-driven closes that whole class of bug).
    //
    // _bulkRestoreSchemaDriven is a local helper hoisted above so it
    // can be shared with the side-table _restoreTable path below.
    // (Duplicates DELETE FROM already done by the wipe pass above;
    // DELETE-from-empty is a no-op so idempotent.)
    function _bulkRestoreSchemaDriven(table, rows) {
      if (!Array.isArray(rows) || rows.length === 0) return;
      const cols = _columnsOf(table);
      if (cols.length === 0) return;
      const colList = cols.join(', ');
      const ph = cols.map(c => '@' + c).join(', ');
      const ins = db.prepare(`INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${ph})`);
      const defaults = _defaultsOf(table);
      for (const r of rows) ins.run(_withDefaults(r, defaults));
    }
    _bulkRestoreSchemaDriven('ai_chat_history', data.ai_chat_history);
    _bulkRestoreSchemaDriven('recipes',       data.recipes);
    _bulkRestoreSchemaDriven('pantry_items',  data.pantry_items);
    _bulkRestoreSchemaDriven('cook_diary',    data.cook_diary);
    _bulkRestoreSchemaDriven('shopping_list', data.shopping_list);

    // ── Categories, taxonomies, cookbooks, sharing, kitchens ──────────
    // All the user-curated organization that lives in side-tables.
    // Schema-driven INSERTs (column list pulled from PRAGMA) so a
    // backup made on a slightly different schema version still
    // restores cleanly — extra columns get nulled, missing columns
    // skipped.
    // Emptied first even when the backup holds none of it: a kitchen or an
    // invite made since (their owner's delete leaves them) doesn't stay.
    function _restoreTable(table, rows) {
      const cols = _columnsOf(table);
      if (cols.length === 0) return; // table not present in this build
      try { db.prepare(`DELETE FROM ${table}`).run(); } catch {}
      if (!Array.isArray(rows) || rows.length === 0) return;
      const colList = cols.join(', ');
      const ph = cols.map(c => '@' + c).join(', ');
      const ins = db.prepare(`INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${ph})`);
      const defaults = _defaultsOf(table);
      for (const r of rows) ins.run(_withDefaults(r, defaults));
    }
    _restoreTable('recipe_categories',     data.recipe_categories);
    _restoreTable('pantry_categories',     data.pantry_categories);
    _restoreTable('custom_units',          data.custom_units);
    _restoreTable('disabled_units',        data.disabled_units);
    _restoreTable('cookbooks',             data.cookbooks);
    _restoreTable('recipe_cookbook_links', data.recipe_cookbook_links);
    // kitchens + kitchen_members must land BEFORE recipe_shares and
    // cookbook_shares. Kitchens survives the DELETE-FROM-users wipe
    // pass (owner_user_id is ON DELETE SET NULL, not CASCADE), so
    // _restoreTable('kitchens') actually deletes rows and its
    // ON DELETE SET NULL cascade nulls out via_kitchen_id on any
    // recipe_shares / cookbook_shares already inserted before it.
    // Restoring kitchens first keeps via_kitchen_id intact.
    _restoreTable('kitchens',              data.kitchens);
    _restoreTable('kitchen_members',       data.kitchen_members);
    _restoreTable('recipe_shares',         data.recipe_shares);
    _restoreTable('cookbook_shares',       data.cookbook_shares);
    _restoreTable('recipe_comments',       data.recipe_comments);
    _restoreTable('recipe_versions',       data.recipe_versions);
    _restoreTable('recipe_revisions',      data.recipe_revisions);
    // See TODO(review) in dumpDatabase — pending invitations only.
    _restoreTable('invite_tokens',         data.invite_tokens);
    // What other apps and scripts use to reach this server, set up by hand:
    // API tokens (hashed) and webhooks (the secret locked with this server's
    // key: on a server with another key a delivery fails until the webhook
    // is made again, and Settings says so). The accounts' delete above took
    // the old ones; only those of an account the backup holds come back.
    {
      const users = new Set(db.prepare('SELECT id FROM users').all().map(r => r.id));
      const mine = rows => (Array.isArray(rows) ? rows : []).filter(r => users.has(r?.user_id));
      _restoreTable('api_tokens',          mine(data.api_tokens));
      _restoreTable('webhooks',            mine(data.webhooks));
    }

    // Two-step sign-in (nutritrace#222): secrets as stored (locked with this
    // server's two-step key, so on another server they can't be opened and
    // the person signs in with a recovery code or has it reset) and the
    // hashes of recovery codes. A backup from before it has none: two-step
    // sign-in is off for everyone after restoring it. The users above
    // cascaded the old rows away; rows for an account the archive lacks are
    // skipped.
    db.prepare('DELETE FROM user_two_step').run();
    db.prepare('DELETE FROM user_two_step_recovery').run();
    const restoredUsers = new Set(db.prepare('SELECT id FROM users').all().map(r => r.id));
    const insTwoStep = db.prepare(`
      INSERT OR IGNORE INTO user_two_step (user_id, secret_enc, enabled, last_step, created_at, enabled_at)
      VALUES (@user_id, @secret_enc, @enabled, @last_step, COALESCE(@created_at, datetime('now')), @enabled_at)
    `);
    for (const t of (data.user_two_step || []).filter(x => restoredUsers.has(x.user_id))) insTwoStep.run({
      enabled: 0, last_step: 0, created_at: null, enabled_at: null, ...t,
    });
    const insRecovery = db.prepare(`
      INSERT OR IGNORE INTO user_two_step_recovery (id, user_id, code_hash, used_at, created_at)
      VALUES (@id, @user_id, @code_hash, @used_at, COALESCE(@created_at, datetime('now')))
    `);
    for (const r of (data.user_two_step_recovery || []).filter(x => restoredUsers.has(x.user_id))) insRecovery.run({
      id: null, used_at: null, created_at: null, ...r,
    });

    // OIDC — restore only when target tables exist.
    try {
      const insProvider = db.prepare(`
        INSERT OR IGNORE INTO oidc_providers (id, issuer_url, client_id, client_secret, redirect_uris, scope,
          token_endpoint_auth_method, response_types,
          id_token_signed_response_alg, userinfo_signed_response_alg, request_timeout_ms,
          auto_register, auto_link_verified_email, auto_register_new_users,
          admin_group_claim, admin_group_value,
          display_name, logo_url, is_active, created_at, updated_at)
        VALUES (@id, @issuer_url, @client_id, @client_secret, @redirect_uris, @scope,
          @token_endpoint_auth_method, @response_types,
          @id_token_signed_response_alg, @userinfo_signed_response_alg, @request_timeout_ms,
          @auto_register, @auto_link_verified_email, @auto_register_new_users,
          @admin_group_claim, @admin_group_value,
          @display_name, @logo_url, @is_active, @created_at, @updated_at)
      `);
      for (const p of data.oidc_providers || []) insProvider.run(_withDefaults(p, {
        scope: 'openid email profile', token_endpoint_auth_method: 'client_secret_basic',
        response_types: 'code', id_token_signed_response_alg: 'RS256',
        userinfo_signed_response_alg: null, request_timeout_ms: 8000,
        auto_register: 0, auto_link_verified_email: 1, auto_register_new_users: 0,
        admin_group_claim: null, admin_group_value: null,
        display_name: null, logo_url: null, is_active: 1,
        redirect_uris: '[]', created_at: null, updated_at: null,
      }));

      const insLink = db.prepare(`
        INSERT OR IGNORE INTO user_oidc_links (id, user_id, oidc_provider_id, oidc_sub, email_verified, last_login_at, created_at)
        VALUES (@id, @user_id, @oidc_provider_id, @oidc_sub, @email_verified, @last_login_at, @created_at)
      `);
      for (const l of data.user_oidc_links || []) insLink.run(_withDefaults(l, {
        email_verified: 0, last_login_at: null, created_at: null,
      }));
    } catch {} // tables don't exist — skip silently

    // Rows a device may hold that the backup doesn't: kept as deleted, so
    // devices drop them.
    keepGone(before);
  })(), data.users);
  // A backup from before the recipe history (or without it): each recipe
  // starts its history with what it holds now. One from before amounts
  // were compared exactly: its versions get their exact keys.
  backfillRevisions();
  rekeyRevisions();

  // Restore images — guard against zip-slip and zip-bomb attacks
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const uploadsResolved = path.resolve(UPLOADS_DIR);
  const MAX_ENTRIES = 10_000;
  const MAX_BYTES   = 5 * 1024 * 1024 * 1024;
  let extracted = 0;
  let totalBytes = 0;
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.startsWith('images/') || entry.isDirectory) continue;
    if (++extracted > MAX_ENTRIES) throw new Error(`Backup contains too many image entries (>${MAX_ENTRIES})`);
    const rel = entry.entryName.slice('images/'.length);
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
      throw new Error(`Refusing unsafe path in backup: ${entry.entryName}`);
    }
    // Defensive: skip dot-prefixed paths so a legacy backup (made
    // before the addDir filter landed) can't repopulate
    // .import-cache or other transient dirs on restore.
    if (rel.split('/').some(seg => seg.startsWith('.'))) continue;
    const dest = path.resolve(UPLOADS_DIR, rel);
    if (!dest.startsWith(uploadsResolved + path.sep)) {
      throw new Error(`Refusing path traversal in backup: ${entry.entryName}`);
    }
    const bytes = entry.getData();
    totalBytes += bytes.length;
    if (totalBytes > MAX_BYTES) throw new Error(`Backup uncompressed size exceeds ${MAX_BYTES} bytes (zip-bomb defense)`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
  }
  logTwoStepAfterRestore();
}

// Tables whose rows a device pulls whole and that say a row is gone only by
// its deleted_at (routes/sync.js TABLES, softDelete), parents first, with
// who has to be the same before and after the restore for a row to be
// theirs (an account: its id, username and when it was made).
const KEEP_GONE = ['cookbooks', 'recipes', 'pantry_items', 'cook_diary', 'shopping_list', 'recipe_comments', 'recipe_revisions'];
// The rows of `t` the backup doesn't hold (by `key`), read one at a time so
// the rest never sits in memory beside the backup.
function _notIn(data, t, key = 'id') {
  const backed = new Set((Array.isArray(data?.[t]) ? data[t] : []).map(r => r?.[key]));
  const out = [];
  try { for (const r of db.prepare(`SELECT * FROM ${t}`).iterate()) if (!backed.has(r[key])) out.push(r); } catch { /* not in this build */ }
  return out;
}

function rowsBefore(data) {
  const out = Object.fromEntries(KEEP_GONE.map(t => [t, _notIn(data, t)]));
  out.users = new Map(db.prepare('SELECT id, username, created_at FROM users').all().map(u => [u.id, `${u.username}\n${u.created_at}`]));
  return out;
}

/**
 * A row a device may hold that the restore took away is put back deleted,
 * as the app deletes one (deleted_at and updated_at now, which db.js stamps
 * like any delete), so every device that pulls it drops its copy (a recipe
 * made after the backup, a shopping item added since), and an older edit
 * queued on a phone doesn't bring it back. Only for the same people: an
 * account that is someone else in the backup, or isn't in it, gets nothing
 * of the other's. A link to a row that isn't there is left empty (or the
 * row stays out, when it needs one), so the restore's foreign keys hold. A
 * recipe's share link goes, so it no longer opens it.
 */
function keepGone(before) {
  const usersNow = new Map(db.prepare('SELECT id, username, created_at FROM users').all().map(u => [u.id, `${u.username}\n${u.created_at}`]));
  // A row with no account is the one user's of a server without accounts:
  // the same only when there were none before and are none now (restored
  // onto a server with accounts, it would be handed to one of them).
  const solo = before.users.size === 0 && usersNow.size === 0;
  const same = id => (id == null ? solo : usersNow.has(id) && usersNow.get(id) === before.users.get(id));
  for (const t of KEEP_GONE) {
    const info = db.prepare(`PRAGMA table_info(${t})`).all();
    if (!info.length || !before[t]?.length) continue;
    const cols = info.map(c => c.name);
    const notNull = new Set(info.filter(c => c.notnull).map(c => c.name));
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all()
      .map(f => ({ from: f.from, there: db.prepare(`SELECT 1 FROM ${f.table} WHERE ${f.to || 'id'} = ?`) }));
    const has = db.prepare(`SELECT 1 FROM ${t} WHERE id = ?`);
    const ins = db.prepare(`INSERT OR IGNORE INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`);
    const del = db.prepare(`UPDATE ${t} SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`);
    for (const r of before[t]) {
      if (has.get(r.id) || !same(r.user_id)) continue;
      const row = { ...Object.fromEntries(cols.map(c => [c, null])), ...r };
      let ok = true;
      for (const f of fks) {
        if (row[f.from] == null || f.there.get(row[f.from])) continue;
        if (notNull.has(f.from)) { ok = false; break; }
        row[f.from] = null;
      }
      if (!ok) continue;
      if (t === 'recipes') row.share_token = null;
      let put = ins.run(row).changes;
      // A cookbook whose name a restored one has now: kept under another
      // slug (the slug is unique per account), so devices still drop it.
      if (!put && t === 'cookbooks' && row.slug != null && !has.get(r.id)) put = ins.run({ ...row, slug: `${row.slug}-gone-${r.id}` }).changes;
      if (put && r.deleted_at == null) del.run(r.id);
    }
  }
  // Deletions devices are still to hear of (before the restore, and the
  // restore's own), for the same people.
  const insGone = db.prepare(`INSERT OR IGNORE INTO sync_deletions (id, user_id, table_name, row_id, synced_at) VALUES (@id, @user_id, @table_name, @row_id, @synced_at)`);
  for (const g of before.sync_deletions || []) if (same(g.user_id)) insGone.run(g);
}

// A column a backup's row doesn't have (one added since it was made) gets
// the column's own default, as an upgrade gives the rows it already has:
// NULL into a NOT NULL column would make INSERT OR IGNORE drop the whole row.
function _defaultsOf(table) {
  const out = {};
  for (const c of db.prepare(`PRAGMA table_info(${table})`).all()) {
    out[c.name] = null;
    if (c.dflt_value != null) {
      try { out[c.name] = db.prepare(`SELECT ${c.dflt_value} AS v`).get().v; } catch { /* left empty */ }
    }
  }
  return out;
}

function _columnsOf(table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  } catch { return []; }
}

function _withDefaults(obj, defaults) {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(obj)) out[k] = v;
  return out;
}

// ── POST / — create a new backup (manual button) ──────────────────────
router.post('/', requireAdmin, (req, res) => {
  try {
    const result = createBackup();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /schedule — read auto-backup config + status ──────────────────
router.get('/schedule', requireAdmin, (req, res) => {
  try { res.json(getScheduleConfig()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /schedule — write auto-backup config ──────────────────────────
router.put('/schedule', requireAdmin, (req, res) => {
  try { res.json(setScheduleConfig(req.body || {})); }
  catch (err) {
    const status = err.code === 'ENV_LOCKED' ? 409 : 400;
    res.status(status).json({ error: err.message });
  }
});

// ── GET / — list backups ───────────────────────────────────────────────
router.get('/', requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.endsWith('.zip'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, f));
        return { filename: f, size: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:name/download', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.name);
  if (!filename.toLowerCase().endsWith('.zip')) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.download(filePath, filename);
});

router.delete('/:name', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.name);
  if (!filename.toLowerCase().endsWith('.zip')) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

router.post('/:name/restore', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.name);
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  try {
    restoreFromZip(new AdmZip(filePath));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload-restore', requireAdmin, upload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    restoreFromZip(new AdmZip(req.file.path));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch {}
  }
});

export default router;
