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
import db from '../db.js';
import { logger } from '../logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UPLOADS_DIR = process.env.UPLOADS_PATH || path.resolve(__dirname, '..', '..', 'uploads');
const BACKUPS_DIR = process.env.BACKUPS_PATH || path.join(UPLOADS_DIR, 'backups');

fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// ── Schedule config (admin-global, stored in app_config) ──────────────────
// Mirrors NutriTrace's scheduled-backup feature 1:1 for TraceApps parity.
// See server/routes/full-backup.js in nutritrace-dev for the canonical
// design notes; same env-lock contract (BACKUP_SCHEDULE / BACKUP_TIME /
// BACKUP_RETENTION) so ops operators can bake the policy into Compose.
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
  return {
    schedule, time, retention,
    lastAutoRun:   _cfg('backup_last_auto_run')   || null,
    lastAutoError: _cfg('backup_last_auto_error') || null,
    envLocked:     isBackupEnvLocked(),
  };
}

export function setScheduleConfig({ schedule, time, retention }) {
  if (isBackupEnvLocked()) {
    const err = new Error('Backup schedule is locked by environment variable');
    err.code = 'ENV_LOCKED';
    throw err;
  }
  if (schedule != null) {
    if (!SCHEDULES.has(schedule)) throw new Error('schedule must be one of: off, daily, weekly, monthly');
    _setCfg('backup_schedule', schedule);
  }
  if (time != null) {
    if (!/^\d{1,2}:\d{2}$/.test(time)) throw new Error('time must be HH:MM');
    const [h, m] = time.split(':').map(n => parseInt(n, 10));
    if (h < 0 || h > 23 || m < 0 || m > 59) throw new Error('time out of range');
    _setCfg('backup_time', `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  if (retention != null) {
    const r = parseInt(retention, 10);
    if (!Number.isFinite(r) || r < 1 || r > 99) throw new Error('retention must be 1-99');
    _setCfg('backup_retention', String(r));
  }
  return getScheduleConfig();
}

/** Create a full ZIP backup on disk; shared by POST / and the scheduler. */
export function createBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename  = `cooktrace-backup-${timestamp}.zip`;
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
  return { filename, size: stat.size, createdAt: new Date().toISOString() };
}

/** Delete archives beyond the retention limit, keeping the N newest. */
export function pruneOldBackups(retention) {
  const keep = Math.max(1, Math.min(99, parseInt(retention, 10) || DEFAULT_RETENTION));
  const all = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith('cooktrace-backup-') && f.endsWith('.zip'))
    .sort()
    .reverse();
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
// Server-only ephemera (oauth_state, password_reset_tokens) is
// intentionally skipped — their lifetime is shorter than a backup.
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
    recipe_shares:         _selectIfExists('recipe_shares'),
    cookbook_shares:       _selectIfExists('cookbook_shares'),
    kitchens:              _selectIfExists('kitchens'),
    kitchen_members:       _selectIfExists('kitchen_members'),
    oidc_providers:        _selectIfExists('oidc_providers'),
    user_oidc_links:       _selectIfExists('user_oidc_links'),
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

  db.transaction(() => {
    // Defer FK checks until COMMIT so self-referential FKs on
    // pantry_items (generic_parent_id, nutrition_source_variant_id)
    // don't trip when a child row inserts before its parent within the
    // same transaction. Standard SQLite pattern for tree restores.
    db.pragma('defer_foreign_keys = ON');
    // Wipe in dependency order, children before parents.
    db.prepare('DELETE FROM cook_diary').run();
    db.prepare('DELETE FROM shopping_list').run();
    db.prepare('DELETE FROM recipes').run();
    db.prepare('DELETE FROM pantry_items').run();
    db.prepare('DELETE FROM ai_chat_history').run();
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

    const insChat = db.prepare(`
      INSERT OR IGNORE INTO ai_chat_history (id, user_id, role, content, created_at)
      VALUES (@id, @user_id, @role, @content, @created_at)
    `);
    for (const m of data.ai_chat_history || []) insChat.run(m);

    // Recipes / pantry_items / cook_diary / shopping_list use the
    // schema-driven insert helper below. Every column PRAGMA reports
    // is included in the INSERT, so a future ALTER TABLE never
    // silently drops a column at restore time (rc.3 audit found
    // recipes was missing rest_minutes, total_minutes, category_id,
    // share_token, and video_url from a hardcoded column list —
    // switching to PRAGMA-driven closes that whole class of bug).
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
      const defaults = Object.fromEntries(cols.map(c => [c, null]));
      for (const r of rows) ins.run(_withDefaults(r, defaults));
    }
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
    function _restoreTable(table, rows) {
      if (!Array.isArray(rows) || rows.length === 0) return;
      const cols = _columnsOf(table);
      if (cols.length === 0) return; // table not present in this build
      try { db.prepare(`DELETE FROM ${table}`).run(); } catch {}
      const colList = cols.join(', ');
      const ph = cols.map(c => '@' + c).join(', ');
      const ins = db.prepare(`INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${ph})`);
      const defaults = Object.fromEntries(cols.map(c => [c, null]));
      for (const r of rows) ins.run(_withDefaults(r, defaults));
    }
    _restoreTable('recipe_categories',     data.recipe_categories);
    _restoreTable('pantry_categories',     data.pantry_categories);
    _restoreTable('custom_units',          data.custom_units);
    _restoreTable('disabled_units',        data.disabled_units);
    _restoreTable('cookbooks',             data.cookbooks);
    _restoreTable('recipe_cookbook_links', data.recipe_cookbook_links);
    _restoreTable('recipe_shares',         data.recipe_shares);
    _restoreTable('cookbook_shares',       data.cookbook_shares);
    _restoreTable('kitchens',              data.kitchens);
    _restoreTable('kitchen_members',       data.kitchen_members);
    _restoreTable('recipe_comments',       data.recipe_comments);

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
  })();

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
