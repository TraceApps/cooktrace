/**
 * notifications.js — Local notification dispatcher for CookTrace.
 *
 * Phase A only wired up:
 *   - Web/native permission prompt (stub for future reminder features)
 *   - Native "App updates" notification channel + tap listener used by
 *     the in-app self-updater (SettingsUpdates + UpdateBanner).
 * Real reminder scheduling (cook-day reminders, thaw alerts, shopping
 * pings) lands when those features ship.
 */
import { isNative } from './platform.js';
import { LocalNotifications } from '@capacitor/local-notifications';

const _dlog = import.meta.env.DEV
  ? console.log
  : (...a) => { try { if (localStorage.getItem('ct:verboseLogging') === '1') console.log(...a); } catch {} };

function _getLN() { return isNative ? LocalNotifications : null; }

// Fixed ID for the "update available" notification so re-posts replace
// the previous one instead of stacking. Any bumped version overwrites.
export const UPDATE_NOTIFICATION_ID = 9999;

let _updateChannelCreated = false;
let _updateTapListener = null;

// Silent "App updates" channel — low importance so it lands in the shade
// without sound or heads-up, matching how F-Droid / Play post update
// notices. Separate channel means users can mute updates independently
// from other CookTrace notifications in Android's per-channel settings.
async function _ensureUpdateChannel() {
  if (_updateChannelCreated || !isNative) return;
  const LN = _getLN();
  if (!LN) return;
  try {
    await LN.createChannel({
      id: 'cooktrace-updates',
      name: 'App updates',
      description: 'Notifies you when a new app version is available.',
      importance: 2, // LOW: no sound, no vibration, no heads-up
      visibility: 1, // PUBLIC
    });
    _updateChannelCreated = true;
  } catch (e) {
    console.warn('[notifications] update channel creation failed:', e.message);
  }
}

// ── Permission ────────────────────────────────────────────────────────────

export async function requestPermission() {
  if (isNative) {
    const LN = _getLN();
    if (!LN) return false;
    try {
      const r = await LN.requestPermissions();
      return r?.display === 'granted';
    } catch { return false; }
  }
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch { return false; }
}

export async function notify(_title, _body, _opts = {}) {
  // No-op for Phase A.
  return;
}

// ── App-update notification ───────────────────────────────────────────────

/** True when the OS-level notification permission is currently granted. */
export async function isUpdateNotificationPermissionGranted() {
  if (!isNative) return false;
  const LN = _getLN();
  if (!LN) return false;
  try {
    const perm = await LN.checkPermissions();
    return perm.display === 'granted';
  } catch { return false; }
}

/**
 * Post a silent "update available" notification. Uses the low-importance
 * `cooktrace-updates` channel so it lands in the shade without sound or
 * heads-up popup. Tapping the notification is handled by
 * `registerUpdateTapListener` — decoupled so the tap handler can navigate
 * the app without this module needing to know about routing.
 *
 * Returns true if the notification was posted, false otherwise (native
 * missing, permission denied, etc.). Silent-on-failure — the in-app
 * banner is the fallback.
 */
export async function showUpdateNotification(latest) {
  if (!isNative || !latest?.version) return false;
  const LN = _getLN();
  if (!LN) return false;
  const perm = await LN.checkPermissions();
  if (perm.display !== 'granted') return false;
  await _ensureUpdateChannel();
  try {
    await LN.schedule({
      notifications: [{
        id: UPDATE_NOTIFICATION_ID,
        channelId: 'cooktrace-updates',
        title: 'CookTrace update available',
        body: `${latest.version} is ready. Tap to install.`,
        extra: { version: latest.version, notesUrl: latest.notesUrl || '' },
      }],
    });
    _dlog(`[notifications] update notification posted for ${latest.version}`);
    return true;
  } catch (e) {
    console.warn('[notifications] update notification failed:', e?.message || e);
    return false;
  }
}

/** Clear a previously-posted update notification (e.g. after user installs). */
export async function cancelUpdateNotification() {
  if (!isNative) return;
  const LN = _getLN();
  if (!LN) return;
  try {
    await LN.cancel({ notifications: [{ id: UPDATE_NOTIFICATION_ID }] });
  } catch { /* silent */ }
}

/**
 * Register a one-time listener for taps on the update notification.
 * `handler` receives { version, notesUrl } and is expected to route into
 * the install flow. Safe to call multiple times — subsequent calls no-op
 * so App.svelte can defensively register on every mount.
 */
export async function registerUpdateTapListener(handler) {
  if (!isNative || _updateTapListener) return;
  const LN = _getLN();
  if (!LN) return;
  try {
    _updateTapListener = await LN.addListener('localNotificationActionPerformed', ev => {
      if (ev?.notification?.id !== UPDATE_NOTIFICATION_ID) return;
      const extra = ev.notification.extra || {};
      try { handler({ version: extra.version || '', notesUrl: extra.notesUrl || '' }); }
      catch (e) { console.warn('[notifications] update tap handler threw:', e); }
    });
    _dlog('[notifications] update tap listener registered');
  } catch (e) {
    console.warn('[notifications] failed to register update tap listener:', e?.message || e);
  }
}
