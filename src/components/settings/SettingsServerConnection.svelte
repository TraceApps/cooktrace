<!--
  SettingsServerConnection — native-only settings card for the
  local-vs-server toggle. Shown under Settings → Server Connection
  when `isNative` is true. On PWA the section is hidden entirely
  (the PWA always talks to its origin server).

  States:
    • Local mode  — shows "Local Only" status + a form to connect to a
      server (URL, username, password). On submit we authenticate and
      then ask the user how to reconcile local data with the server
      (upload / download / merge), mirroring NutriTrace's flow.
    • Server mode — shows the connected URL, last-sync timestamp,
      Sync Now, Push All, and Disconnect.
-->
<script>
  import { fade } from 'svelte/transition';
  import { onMount, onDestroy } from 'svelte';
  import {
    isNative, getNativeMode, getServerUrl, setNativeMode, setServerUrl,
    setAuthToken, getAuthToken, explainConnectError,
  } from '../../lib/platform.js';
  import { _ } from 'svelte-i18n';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { fullSync, pushAllFromDevice, syncState } from '../../lib/sync.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { portal } from '../../lib/portal.js';
  import { relativeTime } from '../../lib/relative-time.js';
  import { logout } from '../../stores/auth.js';

  // Local form state.
  let mode = isNative ? (getNativeMode() || 'local') : 'web';
  let connectedUrl = getServerUrl() || '';
  let serverUrl = '';
  let username = '';
  let password = '';
  let showPw = false;
  let busy = false;
  let lastSyncDisplay = '';

  // Merge dialog state — mirrors NT's flow.
  //   null            — no dialog
  //   'ask-settings'  — prompt user to pick upload / download / merge
  //   'syncing'       — running the chosen path, show progress
  //   'summary'       — show per-table success/error counts
  let mergeStep = null;
  let mergeProgress = '';
  let mergeProgressPct = 0;
  let mergeStage = '';
  let _pendingServerUrl = '';
  let localCounts = null;
  let migrationSummary = null;

  // Tick once a minute so the relative-time "5 mins ago" stays current
  // without the user reopening the panel.
  let _nowTick = 0;
  const _tick = setInterval(() => _nowTick++, 60_000);
  onDestroy(() => clearInterval(_tick));

  $: lastSyncDisplay = (_nowTick, $syncState.lastSync)
    ? relativeTime($syncState.lastSync)
    : 'Never';
  $: lastSyncTitle = $syncState.lastSync
    ? new Date($syncState.lastSync).toLocaleString()
    : '';

  // ── Connect flow ─────────────────────────────────────────────────────
  async function connect() {
    if (!serverUrl.trim()) { showError($_('settings_server_conn.toast.enter_url')); return; }
    if (!username.trim() || !password.trim()) { showError($_('settings_server_conn.toast.enter_credentials')); return; }
    const url = serverUrl.trim().replace(/\/$/, '');
    busy = true;
    try {
      const { CapacitorHttp } = await import('@capacitor/core');
      const health = await CapacitorHttp.get({ url: `${url}/api/health` });
      if (health.status < 200 || health.status >= 300) throw new Error('Server not reachable');

      const login = await CapacitorHttp.post({
        url: `${url}/api/auth/login`,
        headers: { 'Content-Type': 'application/json' },
        data: { username: username.trim(), password },
      });
      const body = typeof login.data === 'string' ? JSON.parse(login.data) : login.data;
      if (login.status < 200 || login.status >= 300) throw new Error(body?.error || 'Login failed');

      _pendingServerUrl = url;
      if (body.token) setAuthToken(body.token);

      // Count local data so the merge dialog can show what's about to
      // move. On a fresh install this is all zeros and we skip the
      // dialog entirely.
      const { countLocalData } = await import('../../lib/migrate.js');
      localCounts = await countLocalData();

      if (localCounts.total > 0) {
        mergeStep = 'ask-settings';
      } else {
        _finalizeConnect();
      }
    } catch (e) {
      showError(explainConnectError(e, url));
    } finally {
      busy = false;
    }
  }

  // Apply the user's choice from the merge dialog. Three modes:
  //   upload   — push every local row to the server. Server stays as-is.
  //   download — wipe local first, then let the post-reload sync pull
  //              the server's authoritative state.
  //   merge    — upload local, then pull on reload. May duplicate
  //              recipes/diary/pantry because those tables don't have a
  //              natural unique key on the server.
  async function _mergeAndConnect(modeChoice) {
    mergeStep = 'syncing';
    mergeProgress = '';
    mergeProgressPct = 0;
    mergeStage = '';
    migrationSummary = null;

    const url = _pendingServerUrl;
    const token = getAuthToken();

    try {
      if (modeChoice === 'download') {
        const { wipeLocalData } = await import('../../lib/migrate.js');
        mergeStage = 'local data';
        mergeProgress = 'Clearing local data…';
        mergeProgressPct = 50;
        await wipeLocalData();
        mergeProgressPct = 100;
      }
      if (modeChoice === 'upload' || modeChoice === 'merge') {
        const { uploadLocalToServer } = await import('../../lib/migrate.js');
        const stageLabels = {
          categories: 'categories',
          recipes:    'recipes',
          pantry:     'pantry items',
          diary:      'diary entries',
          shopping:   'shopping list',
          settings:   'settings',
        };
        migrationSummary = await uploadLocalToServer({
          serverUrl: url,
          authToken: token,
          onProgress: (stage, current, total) => {
            mergeStage = stageLabels[stage] || stage;
            mergeProgress = `Uploading ${mergeStage} (${Math.min(current + 1, total)} / ${total})`;
            mergeProgressPct = total > 0 ? Math.round(((current + 1) / total) * 100) : 0;
          },
        });
      }

      // Show the summary so the user can see what landed (and any
      // errors). On download / no-op, finalize directly.
      if (migrationSummary && (migrationSummary.errors.length > 0 || migrationSummary.totalSuccess > 0)) {
        mergeStep = 'summary';
      } else {
        _finalizeConnect();
      }
    } catch (e) {
      mergeStep = null;
      showError($_('settings_server_conn.toast.sync_failed', { values: { reason: e.message || $_('settings_server_conn.toast.sync_unknown') } }));
    }
  }

  function _finalizeConnect() {
    setServerUrl(_pendingServerUrl);
    setNativeMode('server');
    mode = 'server';
    mergeStep = null;
    showSuccess($_('settings_server_conn.toast.connected_reloading'));
    setTimeout(() => window.location.reload(), 600);
  }

  function cancelMerge() {
    // Cancelling here keeps the auth token (already set) but doesn't
    // flip the mode, so the user can retry without re-entering creds.
    // If they really want to bail entirely they can hit Disconnect once
    // in server mode.
    mergeStep = null;
    _pendingServerUrl = '';
    localCounts = null;
    migrationSummary = null;
    setAuthToken(null);
  }

  // ── Server-mode actions ─────────────────────────────────────────────
  async function syncNow() {
    busy = true;
    try {
      const r = await fullSync(false);
      if (r?.ok === false && r.error) showError(r.error);
      else showSuccess($_('settings_server_conn.toast.synced'));
    } finally { busy = false; }
  }

  async function pushAll() {
    const ok = await confirmDialog({
      title: 'Push all local data?',
      message: 'Marks every recipe, pantry item, diary entry, and shopping list row as pending and sends it to the server. Use this once when first connecting a server to an existing local-mode library.',
      confirmText: 'Push All',
    });
    if (!ok) return;
    busy = true;
    try {
      const r = await pushAllFromDevice();
      if (r?.ok === false && r.error) showError(r.error);
      else showSuccess($_('settings_server_conn.toast.pushed_all'));
    } finally { busy = false; }
  }

  // Sign out of the server account but KEEP the server URL + native
  // mode. After reload the user lands on the Login gate ready to sign
  // back in (matches NutriTrace's "Log Out" semantics for shared phones
  // or multi-user installs).
  async function logOut() {
    const ok = await confirmDialog({
      title: 'Log out of server?',
      message: 'Signs you out of the server account. Your phone stays connected to the same server — sign back in next time you open the app.',
      confirmText: 'Log Out',
    });
    if (!ok) return;
    busy = true;
    try {
      await logout();
      showSuccess($_('settings_server_conn.toast.logged_out_reloading'));
      setTimeout(() => window.location.reload(), 300);
    } finally { busy = false; }
  }

  // Disconnect entirely: clear server URL + auth + flip mode back to
  // local. Reloads into local-only experience.
  async function disconnect() {
    const ok = await confirmDialog({
      title: 'Disconnect and use locally?',
      message: 'Stops syncing with this server. Your phone keeps everything it has now; future changes stay on this device until you reconnect.',
      confirmText: 'Disconnect',
      dangerous: true,
    });
    if (!ok) return;
    setServerUrl(null);
    setAuthToken(null);
    setNativeMode('local');
    showSuccess($_('settings_server_conn.toast.disconnected_reloading'));
    setTimeout(() => window.location.reload(), 300);
  }
</script>

{#if isNative}
  <div class="card settings-card sv-conn">
    {#if mode === 'server' && connectedUrl}
      <!-- ── Connected state ───────────────────────────────────────── -->
      <div class="row state-row">
        <span class="material-symbols-rounded state-icon ok">cloud_done</span>
        <div class="state-body">
          <div class="state-title">{$_('settings_server_conn.state_connected')}</div>
          <div class="state-sub">{connectedUrl}</div>
        </div>
      </div>

      <div class="row sync-row" title={lastSyncTitle}>
        <div class="state-body">
          <div class="row-label">{$_('settings_server_conn.last_synced')}</div>
          <div class="row-value">{lastSyncDisplay}{$syncState.syncing ? ' · syncing…' : ''}</div>
          {#if $syncState.error}<div class="state-error">{$syncState.error}</div>{/if}
        </div>
        <button class="btn btn-secondary small" on:click={syncNow} disabled={busy || $syncState.syncing}>
          <span class="material-symbols-rounded" class:spin={$syncState.syncing}>{$syncState.syncing ? 'autorenew' : 'sync'}</span>
          {$syncState.syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      <div class="row actions">
        <button class="btn btn-secondary" on:click={pushAll} disabled={busy}>
          <span class="material-symbols-rounded">upload</span>
          Push All
        </button>
        <button class="btn btn-secondary" on:click={logOut} disabled={busy}>
          <span class="material-symbols-rounded">logout</span>
          Log Out
        </button>
        <button class="btn btn-secondary danger" on:click={disconnect} disabled={busy}>
          <span class="material-symbols-rounded">link_off</span>
          Disconnect &amp; Use Locally
        </button>
      </div>
    {:else}
      <!-- ── Local-only state ─────────────────────────────────────── -->
      <div class="row state-row">
        <span class="material-symbols-rounded state-icon">smartphone</span>
        <div class="state-body">
          <div class="state-title">{$_('settings_server_conn.state_local')}</div>
          <div class="state-sub">All data stays on this device. Connect to a CookTrace server below to sync.</div>
        </div>
      </div>

      <div class="form">
        <label class="form-group">
          <span class="form-label">{$_('settings_server_conn.server_url')}</span>
          <input class="input" type="url"
            placeholder="https://cooktrace.example.com"
            bind:value={serverUrl}
            autocapitalize="off" autocorrect="off" />
        </label>
        <label class="form-group">
          <span class="form-label">{$_('settings_server_conn.username')}</span>
          <input class="input" type="text"
            placeholder={$_('settings_server_conn.username_ph')}
            bind:value={username}
            autocapitalize="off" autocorrect="off" />
        </label>
        <label class="form-group">
          <span class="form-label">{$_('settings_server_conn.password')}</span>
          <div class="pw-wrap">
            {#if showPw}
              <input class="input" type="text" placeholder={$_('settings_server_conn.password_ph')} bind:value={password} />
            {:else}
              <input class="input" type="password" placeholder={$_('settings_server_conn.password_ph')} bind:value={password} />
            {/if}
            <button type="button" class="pw-toggle" on:click={() => showPw = !showPw} aria-label={showPw ? 'Hide password' : 'Show password'}>
              <span class="material-symbols-rounded">{showPw ? 'visibility_off' : 'visibility'}</span>
            </button>
          </div>
        </label>
        <div class="form-actions">
          <button class="btn btn-primary" on:click={connect} disabled={busy}>
            {busy ? 'Connecting…' : 'Connect to Server'}
          </button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<!-- ── Merge dialog ───────────────────────────────────────────────── -->
{#if mergeStep === 'ask-settings'}
  <div class="merge-overlay" use:portal transition:fade={{ duration: 150 }}>
    <div class="merge-dialog">
      <h3 class="merge-title">{$_('settings_server_conn.sync_options')}</h3>
      <p class="merge-sub">
        You have data on this phone. How should it be handled when connecting?
      </p>
      {#if localCounts && localCounts.total > 0}
        <div class="merge-counts">
          <div class="merge-counts-title">On this phone:</div>
          <div class="merge-counts-grid">
            {#if localCounts.recipes  > 0}<div><strong>{localCounts.recipes}</strong> {localCounts.recipes === 1 ? 'recipe' : 'recipes'}</div>{/if}
            {#if localCounts.pantry   > 0}<div><strong>{localCounts.pantry}</strong> pantry {localCounts.pantry === 1 ? 'item' : 'items'}</div>{/if}
            {#if localCounts.diary    > 0}<div><strong>{localCounts.diary}</strong> diary {localCounts.diary === 1 ? 'entry' : 'entries'}</div>{/if}
            {#if localCounts.shopping > 0}<div><strong>{localCounts.shopping}</strong> shopping {localCounts.shopping === 1 ? 'item' : 'items'}</div>{/if}
            {#if localCounts.categories > 0}<div><strong>{localCounts.categories}</strong> {localCounts.categories === 1 ? 'category' : 'categories'}</div>{/if}
            {#if localCounts.settings > 0}<div><strong>{localCounts.settings}</strong> settings</div>{/if}
          </div>
        </div>
      {/if}
      <div class="merge-options">
        <button class="merge-option" on:click={() => _mergeAndConnect('upload')}>
          <span class="material-symbols-rounded merge-icon">cloud_upload</span>
          <div>
            <div class="merge-option-title">{$_('settings_server_conn.upload_phone_to_server')}</div>
            <div class="merge-option-desc">Send this phone's data to the server. Existing server data stays.</div>
          </div>
        </button>
        <button class="merge-option" on:click={() => _mergeAndConnect('download')}>
          <span class="material-symbols-rounded merge-icon">cloud_download</span>
          <div>
            <div class="merge-option-title">{$_('settings_server_conn.download_server_to_phone')}</div>
            <div class="merge-option-desc">Replace this phone's data with everything from the server. Local data is discarded.</div>
          </div>
        </button>
        <button class="merge-option" on:click={() => _mergeAndConnect('merge')}>
          <span class="material-symbols-rounded merge-icon">sync</span>
          <div>
            <div class="merge-option-title">{$_('settings_server_conn.merge_both')}</div>
            <div class="merge-option-desc">Upload phone data AND pull server data. Nothing is lost, but duplicates are possible.</div>
          </div>
        </button>
        <button class="btn btn-secondary merge-cancel" on:click={cancelMerge}>{$_('settings_server_conn.cancel')}</button>
      </div>
    </div>
  </div>
{:else if mergeStep === 'syncing'}
  <div class="merge-overlay" use:portal transition:fade={{ duration: 150 }}>
    <div class="merge-dialog merge-syncing">
      <span class="material-symbols-rounded sync-spin">sync</span>
      <p class="syncing-title">Syncing…</p>
      <p class="syncing-sub">{mergeProgress || 'Preparing…'}</p>
      {#if mergeProgressPct > 0}
        <div class="merge-progress-bar">
          <div class="merge-progress-fill" style="width:{mergeProgressPct}%"></div>
        </div>
      {/if}
    </div>
  </div>
{:else if mergeStep === 'summary' && migrationSummary}
  <div class="merge-overlay" use:portal transition:fade={{ duration: 150 }}>
    <div class="merge-dialog">
      <h3 class="merge-title">
        {migrationSummary.errors.length === 0 ? 'Upload complete' : 'Upload finished with issues'}
      </h3>
      <p class="merge-sub">
        {migrationSummary.totalSuccess} of {migrationSummary.total} {migrationSummary.total === 1 ? 'item' : 'items'} uploaded successfully.
      </p>
      <div class="merge-counts">
        <div class="merge-counts-title">Uploaded to server:</div>
        <div class="merge-counts-grid">
          {#if migrationSummary.success.recipes  > 0}<div><strong>{migrationSummary.success.recipes}</strong> {migrationSummary.success.recipes === 1 ? 'recipe' : 'recipes'}</div>{/if}
          {#if migrationSummary.success.pantry   > 0}<div><strong>{migrationSummary.success.pantry}</strong> pantry {migrationSummary.success.pantry === 1 ? 'item' : 'items'}</div>{/if}
          {#if migrationSummary.success.diary    > 0}<div><strong>{migrationSummary.success.diary}</strong> diary {migrationSummary.success.diary === 1 ? 'entry' : 'entries'}</div>{/if}
          {#if migrationSummary.success.shopping > 0}<div><strong>{migrationSummary.success.shopping}</strong> shopping {migrationSummary.success.shopping === 1 ? 'item' : 'items'}</div>{/if}
          {#if migrationSummary.success.categories > 0}<div><strong>{migrationSummary.success.categories}</strong> {migrationSummary.success.categories === 1 ? 'category' : 'categories'}</div>{/if}
          {#if migrationSummary.success.settings > 0}<div><strong>{migrationSummary.success.settings}</strong> settings</div>{/if}
        </div>
      </div>
      {#if migrationSummary.errors.length > 0}
        <div class="merge-errors">
          <div class="merge-counts-title err">
            {migrationSummary.errors.length} {migrationSummary.errors.length === 1 ? 'error' : 'errors'}
            {#if migrationSummary.errors.length > 5}(showing first 5){/if}
          </div>
          <ul class="merge-errors-list">
            {#each migrationSummary.errors.slice(0, 5) as err}
              <li><strong>{err.stage}</strong> · {err.name}: {err.message}</li>
            {/each}
          </ul>
        </div>
      {/if}
      <button class="btn btn-primary w-full" on:click={_finalizeConnect}>{$_('settings_server_conn.continue')}</button>
    </div>
  </div>
{/if}

<style>
  .sv-conn { display: flex; flex-direction: column; gap: 14px; padding: 14px; }
  .row { display: flex; align-items: center; gap: 12px; }
  .state-row .state-icon {
    font-size: 32px; color: var(--text-3);
    background: var(--surface-2);
    width: 48px; height: 48px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .state-row .state-icon.ok { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .state-body { flex: 1; min-width: 0; }
  .state-title { font-weight: 700; font-size: 15px; color: var(--text-1); }
  .state-sub { font-size: 12px; color: var(--text-3); margin-top: 2px; word-break: break-all; }
  .state-error { font-size: 12px; color: var(--error, #ef4444); margin-top: 4px; }
  .sync-row { justify-content: space-between; gap: 12px; }
  .sync-row .row-label { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .sync-row .row-value { font-size: 12px; color: var(--text-3); margin-top: 2px; }
  .btn.small { height: 32px; font-size: 12px; padding: 0 12px; display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .btn.small .material-symbols-rounded { font-size: 16px; }
  .spin { animation: spin 1.1s linear infinite; }
  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

  .actions { flex-wrap: wrap; gap: 8px; }
  .actions .btn { display: inline-flex; align-items: center; gap: 6px; }
  .actions .btn .material-symbols-rounded { font-size: 16px; }
  .btn.danger {
    color: var(--error, #ef4444);
    border-color: color-mix(in srgb, var(--error, #ef4444) 30%, var(--border));
  }
  .btn.danger:hover {
    background: color-mix(in srgb, var(--error, #ef4444) 14%, transparent);
  }

  .form { display: flex; flex-direction: column; gap: 12px; margin-top: 4px; }
  .form-group { display: flex; flex-direction: column; gap: 4px; }
  .form-label { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }
  .pw-wrap { position: relative; }
  .pw-toggle {
    position: absolute; right: 6px; top: 50%;
    transform: translateY(-50%);
    background: none; border: none; cursor: pointer;
    color: var(--text-3); padding: 4px;
  }
  .pw-toggle .material-symbols-rounded { font-size: 18px; }
  .pw-wrap .input { padding-right: 40px; }
  .form-actions { display: flex; justify-content: flex-end; }

  /* ── Merge dialog ──────────────────────────────────────────────── */
  .merge-overlay {
    position: fixed; inset: 0;
    background: var(--overlay, rgba(0, 0, 0, 0.55));
    backdrop-filter: var(--backdrop-blur, blur(8px));
    -webkit-backdrop-filter: blur(8px);
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .merge-dialog {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    max-width: 440px;
    width: 100%;
    box-shadow: 0 24px 64px rgba(0,0,0,0.45);
    color: var(--text-1);
  }
  .merge-title { margin: 0 0 6px; font-size: 18px; color: var(--text-1); }
  .merge-sub   { margin: 0 0 14px; font-size: 13px; color: var(--text-3); line-height: 1.5; }
  .merge-counts {
    background: var(--surface-2);
    border-radius: var(--radius-md);
    padding: 10px 12px;
    margin: 0 0 14px;
  }
  .merge-counts-title { font-size: 12px; font-weight: 700; color: var(--text-2); margin-bottom: 6px; }
  .merge-counts-title.err { color: var(--error, #ef4444); }
  .merge-counts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; font-size: 13px; color: var(--text-2); }
  .merge-counts-grid strong { color: var(--accent); }
  .merge-options { display: flex; flex-direction: column; gap: 8px; }
  .merge-option {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    cursor: pointer;
    text-align: left;
    color: var(--text-1);
  }
  .merge-option:hover { background: color-mix(in srgb, var(--accent) 8%, var(--surface-2)); border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); }
  .merge-option-title { font-weight: 700; font-size: 14px; }
  .merge-option-desc  { font-size: 12px; color: var(--text-3); margin-top: 2px; line-height: 1.4; }
  .merge-icon { font-size: 22px; color: var(--accent); flex-shrink: 0; margin-top: 2px; }
  .merge-cancel { margin-top: 4px; }

  .merge-syncing { text-align: center; }
  .sync-spin { font-size: 36px; color: var(--accent); animation: spin 1.2s linear infinite; }
  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
  .syncing-title { font-size: 15px; color: var(--text-1); margin: 12px 0 4px; font-weight: 600; }
  .syncing-sub   { font-size: 13px; color: var(--text-3); margin: 0; }
  .merge-progress-bar {
    margin-top: 14px;
    width: 100%; height: 6px;
    background: var(--surface-2);
    border-radius: 999px;
    overflow: hidden;
  }
  .merge-progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 180ms ease;
  }
  .merge-errors { margin: 0 0 14px; }
  .merge-errors-list { font-size: 12px; color: var(--text-3); padding-left: 18px; margin: 6px 0 0; line-height: 1.5; }
  .w-full { width: 100%; }
</style>
