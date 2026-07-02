/**
 * scheduler.js — Server-side scheduled tasks for CookTrace.
 *
 * Single setInterval that ticks every 15 min. Each tick:
 *   1. Cook-day reminder: for every user with notifCookDayReminder
 *      enabled, fire one push per recipe planned for today (kind+ref
 *      deduped via notification_log so we don't double-send across
 *      ticks of the same day).
 *   2. Shopping nudge: if a user has unchecked shopping items that
 *      have been sitting for 3+ days, ping them once per day.
 *   3. Thaw alerts: stub. Detecting "thaw 24h ahead" reliably needs
 *      either user-tagged thaw flags on planned cooks or NLP over
 *      ingredients; left as a follow-up so we don't false-alarm.
 *
 * Skipped silently when no users exist (single-user fresh install).
 * Cron-style is fine because we only need to-the-day accuracy; the
 * dedup log keeps us safe across server restarts.
 */
import db from '../db.js';
import { logger } from '../logger.js';
import { notifyCookDay, notifyShoppingNudge, notifyExpiryDigest } from './push-notify.js';
import { sendWeeklySummaryEmail } from '../email.js';

const TICK_MS = 15 * 60 * 1000; // 15 minutes
let _interval = null;

export function startScheduler() {
  // Run once at boot so a freshly-restarted server doesn't wait 15 min
  // to deliver today's reminders.
  setTimeout(() => runTick().catch(e => logger.warn(`[scheduler] tick error: ${e.message}`)), 5_000);
  _interval = setInterval(() => {
    runTick().catch(e => logger.warn(`[scheduler] tick error: ${e.message}`));
  }, TICK_MS);
  logger.info(`[scheduler] running every ${TICK_MS / 60000} min`);
}

export function stopScheduler() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

async function runTick() {
  const today = _todayUtc();
  const users = db.prepare(`SELECT id FROM users`).all();

  for (const u of users) {
    try { await _checkCookDay(u.id, today); }
    catch (e) { logger.debug?.(`[scheduler] cookDay user=${u.id} ${e.message}`); }
    try { await _checkShoppingNudge(u.id, today); }
    catch (e) { logger.debug?.(`[scheduler] shopping user=${u.id} ${e.message}`); }
    try { await _checkExpiryDigest(u.id, today); }
    catch (e) { logger.debug?.(`[scheduler] expiry user=${u.id} ${e.message}`); }
    try { await _checkWeeklySummary(u.id, today); }
    catch (e) { logger.debug?.(`[scheduler] weekly user=${u.id} ${e.message}`); }
  }

  // Housekeeping — remove invite tokens that are past their expiry or
  // already used. GET /api/auth/invites already filters them out of the
  // admin list, but rows sit in the table indefinitely otherwise. Runs
  // every tick regardless of user count so the table stays clean even
  // when the setup is still single-user.
  try {
    const r = db.prepare(
      `DELETE FROM invite_tokens WHERE expires_at <= datetime('now') OR used = 1`
    ).run();
    if (r.changes > 0) logger.debug?.(`[scheduler] purged ${r.changes} expired/used invite tokens`);
  } catch (e) {
    logger.debug?.(`[scheduler] invite cleanup error: ${e.message}`);
  }

  // Scheduled full backup (admin-global). Off by default; mirrors NT's
  // scheduled-backup feature for TraceApps parity. See
  // routes/full-backup.js for the schedule config + once-per-interval
  // gating.
  try { await _checkBackupSchedule(); }
  catch (e) { logger.debug?.(`[scheduler] backup check error: ${e.message}`); }
}

const _BACKUP_INTERVAL_MS = {
  daily:   22 * 60 * 60 * 1000,
  weekly:  6.5 * 24 * 60 * 60 * 1000,
  monthly: 28 * 24 * 60 * 60 * 1000,
};

async function _checkBackupSchedule() {
  const { getScheduleConfig, runScheduledBackup } = await import('../routes/full-backup.js');
  const cfg = getScheduleConfig();
  if (cfg.schedule === 'off') return;
  const intervalMs = _BACKUP_INTERVAL_MS[cfg.schedule];
  if (!intervalMs) return;
  const [hh, mm] = cfg.time.split(':').map(n => parseInt(n, 10));
  const now = new Date();
  const scheduledMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0).getTime();
  if (now.getTime() < scheduledMs) return;
  if (cfg.lastAutoRun) {
    const lastMs = new Date(cfg.lastAutoRun).getTime();
    if (Number.isFinite(lastMs) && now.getTime() - lastMs < intervalMs) return;
  }
  logger.info?.(`[backup] auto-backup due (schedule=${cfg.schedule}, time=${cfg.time}, retention=${cfg.retention}, last=${cfg.lastAutoRun || 'never'})`);
  try { await runScheduledBackup(); } catch {}
}

function _todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function _userSetting(userId, key) {
  const r = db.prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = ?`).get(userId, key);
  if (!r) return null;
  try { return JSON.parse(r.value); } catch { return r.value; }
}

function _alreadyFired(userId, kind, refId, today) {
  const r = db.prepare(
    `SELECT 1 FROM notification_log
      WHERE user_id = ? AND kind = ? AND ref_id IS ? AND fired_date = ? LIMIT 1`
  ).get(userId, kind, refId == null ? null : refId, today);
  return !!r;
}

function _markFired(userId, kind, refId, today) {
  try {
    db.prepare(
      `INSERT INTO notification_log (user_id, kind, ref_id, fired_date)
       VALUES (?, ?, ?, ?)`
    ).run(userId, kind, refId == null ? null : refId, today);
  } catch (e) {
    // UNIQUE conflict means another process beat us to it. Safe.
  }
}

async function _checkCookDay(userId, today) {
  // Honor user toggle. Default is OFF so we never spam unconfigured users.
  const enabled = _userSetting(userId, 'notifCookDayReminder');
  if (!enabled) return;

  // Find planned cooks for today that haven't been converted to "cooked".
  const rows = db.prepare(
    `SELECT cd.id, cd.recipe_id, r.name AS recipe_name
       FROM cook_diary cd
       LEFT JOIN recipes r ON r.id = cd.recipe_id
      WHERE cd.user_id = ? AND cd.date = ? AND cd.kind = 'planned' AND cd.deleted_at IS NULL`
  ).all(userId, today);

  for (const row of rows) {
    if (_alreadyFired(userId, 'cook_day', row.id, today)) continue;
    const name = row.recipe_name || 'Recipe';
    try {
      await notifyCookDay(userId, name, today);
      _markFired(userId, 'cook_day', row.id, today);
    } catch (e) {
      logger.debug?.(`[scheduler] cookDay push failed user=${userId} entry=${row.id} ${e.message}`);
    }
  }
}

// Weekly summary: fire once per Sunday between 8am and 9am local server
// time. Dedupe via notification_log so a server restart on Sunday morning
// doesn't double-send. Honors notifWeeklySummary setting.
async function _checkWeeklySummary(userId, today) {
  const enabled = _userSetting(userId, 'notifWeeklySummary');
  if (!enabled) return;
  const now = new Date();
  if (now.getDay() !== 0) return;          // Sunday only
  if (now.getHours() < 8 || now.getHours() >= 9) return; // 8-9am window
  if (_alreadyFired(userId, 'weekly_summary', null, today)) return;
  try {
    // The email helper builds the recipient + subject; we just hand it
    // the user id and a best-guess origin (the server doesn't know its
    // public URL — use the configured app_config or fall back to a
    // generic placeholder. The email body falls back to that too.)
    const origin = _appOrigin();
    await sendWeeklySummaryEmail(userId, origin);
    _markFired(userId, 'weekly_summary', null, today);
  } catch (e) {
    logger.debug?.(`[scheduler] weeklySummary user=${userId} ${e.message}`);
  }
}

function _appOrigin() {
  // Best-effort: use APP_ORIGIN env var if set; otherwise null and the
  // email helper substitutes a sensible default in its CTA buttons.
  return process.env.APP_ORIGIN || process.env.PUBLIC_URL || null;
}

// Pantry expiration digest. Fires once per day at the user's picked
// notifExpiryTime (default 09:00, server-local). Skips silently when
// the user has nothing expiring within the window they picked. Past-
// expiry items always ride along regardless of window (they've already
// gone, shouldn't fall off the radar). The tick runs every 15 min, so
// we accept any time in the 15-min window starting at the picked hour
// so a picked '09:00' fires on the first tick between 9:00 and 9:15.
async function _checkExpiryDigest(userId, today) {
  const enabled = _userSetting(userId, 'notifExpiryEnabled');
  if (!enabled) return;
  const rawTime = _userSetting(userId, 'notifExpiryTime');
  const [rawHH, rawMM] = typeof rawTime === 'string' && /^\d{1,2}:\d{2}$/.test(rawTime)
    ? rawTime.split(':').map(n => parseInt(n, 10))
    : [9, 0];
  const targetHH = Math.max(0, Math.min(23, rawHH));
  const targetMM = Math.max(0, Math.min(59, rawMM));
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const targetMinutes = targetHH * 60 + targetMM;
  // Accept any tick within the 15-min window starting at target so the
  // once-every-15-min scheduler doesn't miss the user's picked time.
  if (nowMinutes < targetMinutes || nowMinutes >= targetMinutes + 15) return;
  if (_alreadyFired(userId, 'expiry_digest', null, today)) return;
  const daysBeforeRaw = _userSetting(userId, 'notifExpiryDaysBefore');
  const daysBefore = Number.isFinite(+daysBeforeRaw) && +daysBeforeRaw > 0 ? +daysBeforeRaw : 3;
  const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() + daysBefore);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const rows = db.prepare(
    `SELECT id, name, brand, expires_on
       FROM pantry_items
      WHERE user_id = ? AND deleted_at IS NULL
        AND expires_on IS NOT NULL AND expires_on <= ?
      ORDER BY expires_on ASC`
  ).all(userId, cutoffDate);
  if (!rows.length) return;
  try {
    await notifyExpiryDigest(userId, rows);
    _markFired(userId, 'expiry_digest', null, today);
  } catch (e) {
    logger.debug?.(`[scheduler] expiry push failed user=${userId} ${e.message}`);
  }
}

async function _checkShoppingNudge(userId, today) {
  const enabled = _userSetting(userId, 'notifShoppingNudge');
  if (!enabled) return;
  // Once per day at most.
  if (_alreadyFired(userId, 'shopping_nudge', null, today)) return;

  // Count unchecked items at least 3 days old. Server timestamp on
  // shopping_list rows is in `created_at`. We look at how stale the
  // OLDEST unchecked item is — if any has been sitting 3+ days, ping.
  const stale = db.prepare(
    `SELECT COUNT(*) AS n FROM shopping_list
      WHERE user_id = ? AND checked = 0 AND deleted_at IS NULL
        AND julianday('now') - julianday(created_at) > 3`
  ).get(userId);
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM shopping_list
      WHERE user_id = ? AND checked = 0 AND deleted_at IS NULL`
  ).get(userId);
  if (!stale.n || !total.n) return;

  try {
    await notifyShoppingNudge(userId, total.n);
    _markFired(userId, 'shopping_nudge', null, today);
  } catch (e) {
    logger.debug?.(`[scheduler] shopping push failed user=${userId} ${e.message}`);
  }
}
