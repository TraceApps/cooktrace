/**
 * push-notify.js — server-side push delivery via Apprise / Gotify / ntfy.
 *
 * Reads the user's push-service config from user_settings. CookTrace
 * sends a small set of cooking-domain reminders (cook day, thaw alert,
 * shopping nudge); helpers below wrap pushNotify() with sensible
 * setting keys + dedup so the same alert doesn't fire twice on the
 * same day.
 *
 * Mirrors the NutriTrace push-notify shape so future TraceApps can
 * share infrastructure.
 */

import db from '../db.js';
import { logger } from '../logger.js';

// Cleanup stale dedup keys older than 7 days (runs once at module load).
try {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT key FROM app_config WHERE key LIKE '_celeb_%' OR key LIKE '_pushed_%'`).all();
  const stale = rows.filter(r => {
    const m = r.key.match(/_(\d{4}-\d{2}-\d{2})$/);
    return m && m[1] < sevenDaysAgo;
  });
  if (stale.length > 0) {
    const del = db.prepare('DELETE FROM app_config WHERE key = ?');
    for (const r of stale) del.run(r.key);
    logger.debug?.(`[push] cleaned up ${stale.length} stale dedup keys`);
  }
} catch (e) {
  logger.debug?.(`[push] dedup cleanup failed: ${e.message}`);
}

function _getUserSetting(userId, key) {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  if (!row?.value) return '';
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function _isEnabled(userId, key) {
  const val = _getUserSetting(userId, key);
  return val === true || val === 'true';
}

// ── Push dispatch — routes to the user's configured service ─────────────
async function _pushToService(userId, title, message, priority = 5) {
  const service = _getUserSetting(userId, 'notifPushService');
  if (!service || service === 'none') return;

  try {
    switch (service) {
      case 'gotify':  return await _pushGotify(userId, title, message, priority);
      case 'ntfy':    return await _pushNtfy(userId, title, message, priority);
      case 'apprise': return await _pushApprise(userId, title, message, priority);
    }
  } catch (e) {
    logger.warn?.(`[push] ${service} failed for user ${userId}: ${e.message}`);
  }
}

async function _pushGotify(userId, title, message, priority) {
  const url = _getUserSetting(userId, 'gotifyUrl');
  const token = _getUserSetting(userId, 'gotifyToken');
  if (!url || !token) return;
  const res = await fetch(`${url.replace(/\/+$/, '')}/message?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `CookTrace — ${title}`, message, priority }),
  });
  if (!res.ok) throw new Error(`Gotify ${res.status}`);
  logger.debug?.(`[push] gotify: "${title}" → user ${userId}`);
}

async function _pushNtfy(userId, title, message, priority) {
  const url = _getUserSetting(userId, 'ntfyUrl') || 'https://ntfy.sh';
  const topic = _getUserSetting(userId, 'ntfyTopic');
  const token = _getUserSetting(userId, 'ntfyToken');
  if (!topic) return;
  const headers = { 'Title': `CookTrace — ${title}`, 'Priority': String(Math.min(5, priority)) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${url.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, {
    method: 'POST', headers, body: message,
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
  logger.debug?.(`[push] ntfy: "${title}" → user ${userId}`);
}

async function _pushApprise(userId, title, message, priority) {
  const url = _getUserSetting(userId, 'appriseUrl');
  const tag = _getUserSetting(userId, 'appriseTag');
  if (!url) return;
  const body = { title: `CookTrace — ${title}`, body: message, type: priority >= 7 ? 'warning' : 'info' };
  if (tag) body.tag = tag;
  const res = await fetch(`${url.replace(/\/+$/, '')}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Apprise ${res.status}`);
  logger.debug?.(`[push] apprise: "${title}" → user ${userId}`);
}

// ── Public API ───────────────────────────────────────────────────────────
export async function pushNotify(userId, settingKey, title, message, priority = 5) {
  if (settingKey && !_isEnabled(userId, settingKey)) return;
  return _pushToService(userId, title, message, priority);
}

// Direct dispatch — bypasses settingKey gating. Used by the test
// button in Settings → Notifications. Skips the dedup check.
export async function pushTest(userId, title, message) {
  return _pushToService(userId, title, message, 5);
}

function _firedToday(userId, key) {
  const today = new Date().toISOString().slice(0, 10);
  const dbKey = `_pushed_${userId}_${key}_${today}`;
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(dbKey);
  if (row?.value) return true;
  db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(dbKey, '1');
  return false;
}

// ── CookTrace-specific helpers ───────────────────────────────────────────
export function notifyCookDay(userId, recipeName, date) {
  if (_firedToday(userId, `cookday_${date}`)) return;
  return pushNotify(userId, 'notifCookDayReminder', '🍳 Cook day',
    `You planned to cook ${recipeName} today.`, 5);
}

export function notifyThaw(userId, recipeName) {
  if (_firedToday(userId, `thaw_${recipeName}`)) return;
  return pushNotify(userId, 'notifThawAlert', '🥩 Thaw alert',
    `Pull ${recipeName} ingredients out to thaw — you're cooking it tomorrow.`, 5);
}

export function notifyShoppingNudge(userId, count) {
  if (_firedToday(userId, 'shopping_nudge')) return;
  return pushNotify(userId, 'notifShoppingNudge', '🛒 Shopping list waiting',
    `You have ${count} unchecked item${count === 1 ? '' : 's'} on your shopping list.`, 4);
}

/**
 * Pantry expiration digest. `items` is a pre-sorted array of pantry
 * rows carrying { name, brand, expires_on } where past-expiry entries
 * come first. Kept as one roll-up per day so a stocked pantry doesn't
 * fire eight separate notifications.
 */
export function notifyExpiryDigest(userId, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  if (_firedToday(userId, 'expiry_digest')) return;
  const lines = items.slice(0, 6).map(it => {
    const label = it.brand ? `${it.name} (${it.brand})` : it.name;
    return `• ${label} — ${it.expires_on}`;
  });
  if (items.length > 6) lines.push(`…and ${items.length - 6} more`);
  const body = lines.join('\n');
  const title = items.length === 1
    ? '🕒 1 pantry item expiring'
    : `🕒 ${items.length} pantry items expiring`;
  return pushNotify(userId, 'notifExpiryEnabled', title, body, 4);
}

// Comment reply: someone other than the recipe owner posted a
// comment. NOT deduped per day — comments are real-time signals
// users actually want to hear about. Fire-and-forget at the call site.
export function notifyCommentReply(userId, recipeName, commenterName) {
  const safeName   = commenterName || 'Someone';
  const safeRecipe = recipeName    || 'your recipe';
  return pushNotify(
    userId,
    'notifRecipeComments',
    '💬 New comment',
    `${safeName} commented on ${safeRecipe}`,
    4,
  );
}
