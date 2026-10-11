<script>
  import { failed } from '../../lib/messages.js';
  // SettingsNotifications — device + push-service reminders.
  //
  // Two delivery channels (NT parity):
  //   - Device notifications: Web Notification API on PWA, Capacitor
  //     LocalNotifications on Android. Master toggle wires later when
  //     the cook-day scheduler ships.
  //   - Push service: Apprise / Gotify / ntfy. Server-side. Secrets stay
  //     on the server.
  //
  // Per-reminder switches gate which CookTrace events fire on push:
  //   - Cook day reminder (planned cook today)
  //   - Thaw alert (recipe planned for tomorrow needs ingredients out)
  //   - Shopping list nudge (unchecked items lingering)
  import { _ } from 'svelte-i18n';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { isNative, getServerUrl, getAuthToken, apiUrl } from '../../lib/platform.js';
  import TimePicker from '../ui/TimePicker.svelte';
  import {
    notifLocalEnabled, notifPushService,
    appriseUrl, appriseTag,
    gotifyUrl, gotifyToken,
    ntfyUrl, ntfyTopic, ntfyToken,
    notifExpiryEnabled, notifExpiryDaysBefore, notifExpiryTime,
  } from '../../stores/settings.js';
  import { DB } from '../../lib/db.js';
  import { scheduleSave } from '../../stores/settings.js';

  function setS(key, value) { DB.setSetting(key, value); scheduleSave(key, value); }

  // Per-reminder toggles — stored straight on DB.setSetting (no
  // auto-bound store needed; small set, default off, plain keys).
  function getBool(key, def = false) {
    const v = DB.getSetting(key, def);
    return v === true || v === 'true';
  }
  let notifCookDayReminder = getBool('notifCookDayReminder', false);
  let notifThawAlert       = getBool('notifThawAlert', false);
  let notifShoppingNudge   = getBool('notifShoppingNudge', false);
  let notifRecipeComments  = getBool('notifRecipeComments', true);
  let notifWeeklySummary   = getBool('notifWeeklySummary', false);

  function toggleReminder(key, value) {
    setS(key, value);
  }

  // Test push
  let testing = false;
  let testStatus = ''; // 'ok' | 'fail' | ''
  async function sendTestPush() {
    testing = true;
    testStatus = '';
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (isNative && getServerUrl()) {
        const t = getAuthToken();
        if (t) headers['Authorization'] = `Bearer ${t}`;
      } else {
        const csrf = localStorage.getItem('ct:csrf');
        if (csrf) headers['X-CSRF-Token'] = csrf;
      }
      const res = await fetch(apiUrl('/api/notify/test'), {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      showSuccess($_('settings_notifications.toast.test_sent'));
      testStatus = 'ok';
    } catch (e) {
      showError(failed('fail.push_test', e));
      testStatus = 'fail';
    } finally {
      testing = false;
      setTimeout(() => { testStatus = ''; }, 5000);
    }
  }

  // Device notifications: ask permission on Web (Capacitor handles
  // separately on the native side via the Settings UI).
  async function requestDevicePermission() {
    if (typeof Notification === 'undefined') {
      showError($_('settings_notifications.toast.not_supported'));
      return;
    }
    try {
      const result = await Notification.requestPermission();
      if (result === 'granted') showSuccess($_('settings_notifications.toast.permission_granted'));
      else if (result === 'denied') showError($_('settings_notifications.toast.permission_denied'));
    } catch (e) {
      showError(failed('fail.permission', e));
    }
  }
</script>

<div class="notif-body">
  <p class="sub-label">{$_('settings_notifications.device_notifications')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications.enable_on_device')}</span>
        <span class="setting-desc">{$_('settings_notifications_ui.device_desc')}</span>
      </div>
      <input type="checkbox" class="toggle-cb" checked={$notifLocalEnabled}
        on:change={e => notifLocalEnabled.set(e.target.checked)} />
    </div>
    {#if !isNative}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_notifications.browser_permission')}</span>
          <span class="setting-desc">{$_('settings_notifications_ui.permission_desc')}</span>
        </div>
        <button class="btn btn-secondary" on:click={requestDevicePermission}>
          {$_('settings_notifications_ui.request_permission')}
        </button>
      </div>
    {/if}
  </div>

  <p class="sub-label">{$_('settings_notifications.push_service')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications.service')}</span>
        <span class="setting-desc">{$_('settings_notifications_ui.service_desc')}</span>
      </div>
      <div class="select-wrap">
        <select class="select sel-sm" value={$notifPushService}
          on:change={e => notifPushService.set(e.target.value)}>
          <option value="none">{$_('settings_notifications.svc_none')}</option>
          <option value="apprise">{$_('settings_notifications.svc_apprise')}</option>
          <option value="gotify">{$_('settings_notifications.svc_gotify')}</option>
          <option value="ntfy">ntfy</option>
        </select>
      </div>
    </div>

    {#if $notifPushService === 'apprise'}
      <div class="setting-divider"></div>
      <div class="form-block">
        <label class="form-label">{$_('settings_notifications.apprise_url')}</label>
        <input class="input" type="url" placeholder="https://apprise.example.com"
          value={$appriseUrl} on:change={e => appriseUrl.set(e.target.value)} />
        <label class="form-label">{$_('settings_notifications_ui.tag_optional')}</label>
        <input class="input" type="text" placeholder={$_('settings_notifications_ui.tag_ph')}
          value={$appriseTag} on:change={e => appriseTag.set(e.target.value)} />
      </div>
    {:else if $notifPushService === 'gotify'}
      <div class="setting-divider"></div>
      <div class="form-block">
        <label class="form-label">{$_('settings_notifications.gotify_url')}</label>
        <input class="input" type="url" placeholder="https://gotify.example.com"
          value={$gotifyUrl} on:change={e => gotifyUrl.set(e.target.value)} />
        <label class="form-label">{$_('settings_notifications.app_token')}</label>
        <input class="input" type="text"
          value={$gotifyToken} on:change={e => gotifyToken.set(e.target.value)} />
      </div>
    {:else if $notifPushService === 'ntfy'}
      <div class="setting-divider"></div>
      <div class="form-block">
        <label class="form-label">{$_('settings_notifications_ui.ntfy_server')}</label>
        <input class="input" type="url" placeholder="https://ntfy.sh"
          value={$ntfyUrl} on:change={e => ntfyUrl.set(e.target.value)} />
        <label class="form-label">{$_('settings_notifications.topic')}</label>
        <input class="input" type="text" placeholder="cooktrace-myhome"
          value={$ntfyTopic} on:change={e => ntfyTopic.set(e.target.value)} />
        <label class="form-label">{$_('settings_notifications_ui.bearer_optional')}</label>
        <input class="input" type="text"
          value={$ntfyToken} on:change={e => ntfyToken.set(e.target.value)} />
      </div>
    {/if}

    {#if $notifPushService !== 'none'}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_notifications.send_test')}</span>
          <span class="setting-desc">{$_('settings_notifications_ui.send_test_desc')}</span>
        </div>
        <button class="btn btn-primary" on:click={sendTestPush} disabled={testing}>
          {#if testStatus === 'ok'}
            <span class="material-symbols-rounded">check</span> {$_('settings_notifications_ui.sent')}
          {:else if testStatus === 'fail'}
            <span class="material-symbols-rounded">error</span> {$_('settings_notifications_ui.failed')}
          {:else}
            {testing ? $_('forgot_password.sending') : $_('settings_notifications.send_test')}
          {/if}
        </button>
      </div>
    {/if}
  </div>

  <p class="sub-label">{$_('settings_notifications.reminders')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications_ui.cook_day')}</span>
        <span class="setting-desc">{$_('settings_notifications_ui.cook_day_desc')}</span>
      </div>
      <input type="checkbox" class="toggle-cb" checked={notifCookDayReminder}
        on:change={e => { notifCookDayReminder = e.target.checked; toggleReminder('notifCookDayReminder', e.target.checked); }} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications.thaw_alert')}</span>
        <span class="setting-desc">{$_('settings_notifications_ui.thaw_desc')}</span>
      </div>
      <input type="checkbox" class="toggle-cb" checked={notifThawAlert}
        on:change={e => { notifThawAlert = e.target.checked; toggleReminder('notifThawAlert', e.target.checked); }} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications.shopping_nudge')}</span>
        <span class="setting-desc">{$_('settings_notifications_ui.shopping_nudge_desc')}</span>
      </div>
      <input type="checkbox" class="toggle-cb" checked={notifShoppingNudge}
        on:change={e => { notifShoppingNudge = e.target.checked; toggleReminder('notifShoppingNudge', e.target.checked); }} />
    </div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications.comment_replies')}</span>
        <span class="setting-desc">{$_('settings_notifications_ui.comment_replies_desc')}</span>
      </div>
      <input type="checkbox" class="toggle-cb" checked={notifRecipeComments}
        on:change={e => { notifRecipeComments = e.target.checked; toggleReminder('notifRecipeComments', e.target.checked); }} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications.expiration_digest')}</span>
        <span class="setting-desc">{$_('settings_notifications_ui.expiry_desc')}</span>
      </div>
      <input type="checkbox" class="toggle-cb" checked={$notifExpiryEnabled}
        on:change={e => notifExpiryEnabled.set(e.target.checked)} />
    </div>
    {#if $notifExpiryEnabled}
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_notifications.warn_days_ahead')}</span>
          <span class="setting-desc">{$_('settings_notifications_ui.warn_days_desc')}</span>
        </div>
        <div class="select-wrap">
          <select class="select sel-sm" value={$notifExpiryDaysBefore}
            on:change={e => notifExpiryDaysBefore.set(parseInt(e.target.value, 10))}>
            <option value={1}>{$_('settings_notifications_ui.days', { values: { count: 1 } })}</option>
            <option value={3}>{$_('settings_notifications_ui.days', { values: { count: 3 } })}</option>
            <option value={5}>{$_('settings_notifications_ui.days', { values: { count: 5 } })}</option>
            <option value={7}>{$_('settings_notifications_ui.weeks', { values: { count: 1 } })}</option>
            <option value={14}>{$_('settings_notifications_ui.weeks', { values: { count: 2 } })}</option>
          </select>
        </div>
      </div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_notifications.delivery_time')}</span>
          <span class="setting-desc">{$_('settings_notifications_ui.delivery_time_desc')}</span>
        </div>
        <TimePicker value={$notifExpiryTime} on:change={e => notifExpiryTime.set(e.detail)} />
      </div>
    {/if}
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_notifications.weekly_summary_email')}</span>
        <span class="setting-desc">{$_('settings_notifications_ui.weekly_desc')}</span>
      </div>
      <input type="checkbox" class="toggle-cb" checked={notifWeeklySummary}
        on:change={e => { notifWeeklySummary = e.target.checked; toggleReminder('notifWeeklySummary', e.target.checked); }} />
    </div>
  </div>

  <p class="sub-label">{$_('settings_notifications.note')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-desc">{$_('settings_notifications_ui.note_body')}</span>
      </div>
    </div>
  </div>
</div>

<style>
  .notif-body { display: flex; flex-direction: column; gap: 10px; }
  .sub-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
    padding: 4px 2px 2px;
    margin: 0;
  }
  .card.settings-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .setting-row {
    display: flex; justify-content: space-between; align-items: center;
    gap: 12px; padding: 14px 16px;
  }
  .setting-row > div:first-child { flex: 1; min-width: 0; }
  .setting-label { font-size: 14px; color: var(--text-1); display: block; font-weight: 500; }
  .setting-desc { font-size: 12px; color: var(--text-3); margin-top: 4px; line-height: 1.4; display: block; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }
  .form-block { padding: 12px 16px; display: flex; flex-direction: column; gap: 6px; }
  .form-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
    margin-top: 6px;
  }
  .input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px;
    color: var(--text-1); font-size: 14px;
    box-sizing: border-box; width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .select-wrap { position: relative; }
  .select {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 7px 10px;
    color: var(--text-1); font-size: 13px;
    appearance: none; -webkit-appearance: none; cursor: pointer;
  }
  .select.sel-sm { height: 36px; }
  .toggle-cb {
    width: 40px; height: 24px;
    appearance: none;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 99px;
    position: relative; cursor: pointer;
    transition: background var(--dur-fast);
  }
  .toggle-cb::after {
    content: '';
    position: absolute; top: 1px; left: 1px;
    width: 20px; height: 20px;
    background: var(--text-3); border-radius: 50%;
    transition: transform var(--dur-base) var(--ease-spring), background var(--dur-fast);
  }
  .toggle-cb:checked { background: var(--accent-dim); border-color: var(--accent); }
  .toggle-cb:checked::after { background: var(--accent); transform: translateX(16px); }
</style>
