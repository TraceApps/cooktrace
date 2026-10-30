<!--
  SettingsServerConnection — native-only settings card for the
  local-vs-server toggle. Shown under Settings → Server Connection
  when `isNative` is true. On PWA the section is hidden entirely
  (the PWA always talks to its origin server).

  States:
    • Local mode  — shows "Local Only" status + a form to connect to a
      server: its URL, then the sign-in options it has (SSO buttons,
      username and password), read as soon as the address is in. Signed
      in either way, we ask the user how to reconcile local data with the
      server (upload / download / merge), mirroring NutriTrace's flow.
    • Server mode — shows the connected URL, last-sync timestamp,
      Sync Now, Push All, and Disconnect.
-->
<script>
  import { failed } from '../../lib/messages.js';
  import { closeOnBack } from '../../lib/back-stack.js';
  import { fade } from 'svelte/transition';
  import { onMount, onDestroy } from 'svelte';
  import {
    isNative, getNativeMode, getServerUrl, setNativeMode, setServerUrl,
    setAuthToken, getAuthToken,
  } from '../../lib/platform.js';
  import {
    checkServer, discoverSignIn, passwordSignIn, accountFor, explainSignInError, createSignInOptions,
    openSsoForConnect, forgetSsoConnect, ssoConnectResult, keepSsoLogoutHint,
  } from '../../lib/server-signin.js';
  import { _ } from 'svelte-i18n';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { serverAddressCheck, confirmPlainHttp } from '../../lib/plain-http.js';
  import { classifyServerAddress } from '../../lib/local-address.js';
  import { askPlainHttp } from '../../stores/plainHttp.js';
  import TwoStepChallenge from '../two-step/TwoStepChallenge.svelte';
  import { fullSync, pushAllFromDevice, syncState } from '../../lib/sync.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { portal } from '../../lib/portal.js';
  import { relativeTime } from '../../lib/relative-time.js';
  import { logout } from '../../stores/auth.js';

  // Local form state.
  let mode = isNative ? (getNativeMode() || 'local') : 'web';
  let connectedUrl = getServerUrl() || '';
  // On plain http:// (from TraceApps/nutritrace#194): shown under the server's address.
  $: plainHttp = classifyServerAddress(connectedUrl) === 'local';
  let serverUrl = '';
  let username = '';
  let password = '';
  let showPw = false;
  let busy = false;
  let lastSyncDisplay = '';

  // The server's sign-in options, read as soon as its address is in
  // (TraceApps/notetrace#36): SSO buttons, and the password fields only
  // when it takes one. Typing clears them; a half-typed host isn't an error
  // (lib/server-signin.js).
  //   optionsState: '' (no address yet) | 'checking' | 'ok' | 'failed'
  // Nothing is sent to a plain-http address before its warning
  // (TraceApps/nutritrace#194): while typing it isn't looked up.
  const _lookupAllowed = (url) => !isNative || ['https', 'confirmed'].includes(serverAddressCheck(url));
  const signInOptions = createSignInOptions({
    discover: (url) => _lookupAllowed(url) ? discoverSignIn(url) : Promise.reject(new Error('not asked yet')),
  });
  onDestroy(() => signInOptions.stop());
  let providers = [], passwordLoginEnabled = true, optionsState = '', optionsError = '', optionsFor = '';
  $: ({ state: optionsState, providers, passwordLoginEnabled, error: optionsError, url: optionsFor } = $signInOptions);
  let _pendingLogoutHint = null;   // SSO: lets Log Out end the IdP session too, kept once connected

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
  let _pendingUserId = null;      // the account signed in to, for lib/local-account.js
  let _pendingUserCreated = null;
  let _connectMode = null;        // 'upload' | 'download' | 'merge' | null (no local data)
  let localCounts = null;
  let migrationSummary = null;

  // Tick once a minute so the relative-time "5 mins ago" stays current
  // without the user reopening the panel.
  let _nowTick = 0;
  const _tick = setInterval(() => _nowTick++, 60_000);
  onDestroy(() => clearInterval(_tick));

  $: lastSyncDisplay = (_nowTick, $syncState.lastSync)
    ? relativeTime($syncState.lastSync)
    : $_('settings_server_connection_ui.never');
  $: lastSyncTitle = $syncState.lastSync
    ? new Date($syncState.lastSync).toLocaleString()
    : '';

  // ── Connect flow ─────────────────────────────────────────────────────
  const _cleanUrl = () => serverUrl.trim().replace(/\/$/, '');

  // Plain http:// (from TraceApps/nutritrace#194): refused unless the server
  // is on your own network, and then only after the warning. Nothing is sent
  // before this.
  async function _plainHttpOk(url) {
    if (!isNative) return true;
    const plain = serverAddressCheck(url);
    if (plain === 'invalid') { showError($_('plain_http.invalid_address')); return false; }
    if (plain === 'refuse') { await askPlainHttp(url, { kind: 'refuse' }); return false; }
    if (plain === 'ask') {
      if (!(await _askOnce(url))) return false;
      confirmPlainHttp(url);
    }
    return true;
  }

  // Leaving the field asks first, so a tap on Connect right after (the field
  // loses focus to it) waits for that same answer instead of a second sheet.
  let _asking = null;
  function _askOnce(url) {
    if (_asking?.url !== url) {
      const pending = { url, answer: askPlainHttp(url) };
      _asking = pending;
      pending.answer.finally(() => { if (_asking === pending) _asking = null; });
    }
    return _asking.answer;
  }

  // Leaving the address field: a local plain-http address is asked about
  // first (its warning), then its sign-in options are read.
  async function addressLeft() {
    const url = _cleanUrl();
    if (isNative && serverAddressCheck(url) === 'ask') {
      if (!(await _askOnce(url))) return;
      confirmPlainHttp(url);
    }
    if (!_lookupAllowed(url)) return; // a refused or half-typed address: Connect says why
    signInOptions.left(serverUrl);
  }

  // Two-step sign-in's second step (nutritrace#222): { kind, pendingToken, url } while open.
  let twoStepChallengeOpen = null;
  async function twoStepDone(e) {
    const { url } = twoStepChallengeOpen;
    const loginData = e.detail || {};
    twoStepChallengeOpen = null;
    busy = true;
    try {
      _pendingLogoutHint = null;
      forgetSsoConnect();
      await _signedIn(url, loginData.token, loginData.user);
    } catch (err) {
      showError(explainSignInError(err, url));
    } finally {
      busy = false;
    }
  }
  function twoStepRestart(e) {
    twoStepChallengeOpen = null;
    password = '';
    if (e.detail?.message) showError(e.detail.message);
  }

  async function connect() {
    if (!serverUrl.trim()) { showError($_('settings_server_conn.toast.enter_url')); return; }
    if (!username.trim() || !password.trim()) { showError($_('settings_server_conn.toast.enter_credentials')); return; }
    const url = _cleanUrl();
    if (!(await _plainHttpOk(url))) return;
    busy = true;
    try {
      // The server is there, set up, and is CookTrace (a sign-in proxy's
      // web page in the way is said plainly).
      await checkServer(url);
      const body = await passwordSignIn(url, username.trim(), password);
      _pendingLogoutHint = null;
      forgetSsoConnect();
      await _signedIn(url, body.token, body.user);
    } catch (e) {
      // Two-step sign-in (nutritrace#222): the code, or its setup, comes next.
      if (e?.twoStep) { twoStepChallengeOpen = { ...e.twoStep, url }; return; }
      showError(explainSignInError(e, url));
    } finally {
      busy = false;
    }
  }

  // SSO: the sign-in page opens in the browser; the app link brings the
  // token back here (App.svelte, lib/server-signin.js), and the phone's
  // data moves over as it does after a password sign-in. Busy while the
  // browser opens: a second tap would replace the first one's secret.
  async function connectWithSso(providerId) {
    if (busy) return;
    const url = _cleanUrl();
    if (!(await _plainHttpOk(url))) return;
    busy = true;
    try {
      await checkServer(url);
      await openSsoForConnect(url, providerId);
    } catch (e) {
      showError(e?.webPage || e?.needsSetup || e?.unreachable ? explainSignInError(e, url) : $_('native_setup_ct.toast.cant_open_signin'));
    } finally {
      busy = false;
    }
  }

  async function _finishSso({ url, token, idTokenHint, providerId }) {
    busy = true;
    try {
      const user = await accountFor(url, token);
      // Kept once the phone is connected (_finalizeConnect), not before.
      _pendingLogoutHint = idTokenHint && providerId ? { providerId, idTokenHint } : null;
      await _signedIn(url, token, user);
    } catch (e) {
      showError(e?.webPage ? e.message : failed('fail.sign_in', e));
    } finally {
      busy = false;
    }
  }
  onDestroy(ssoConnectResult.subscribe((r) => {
    if (!r) return;
    ssoConnectResult.set(null);
    _finishSso(r);
  }));

  // Signed in, by password or SSO: the same steps from here on.
  async function _signedIn(url, token, user) {
    _pendingServerUrl = url;
    _pendingUserId = user?.id ?? null;
    _pendingUserCreated = user?.created_at ?? null;
    _connectMode = null;
    if (token) setAuthToken(token);

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
  }

  // Apply the user's choice from the merge dialog. Three modes:
  //   upload   — push every local row to the server. Server stays as-is.
  //   download — wipe local first, then let the post-reload sync pull
  //              the server's authoritative state.
  //   merge    — upload local, then pull on reload. May duplicate
  //              recipes/diary/pantry because those tables don't have a
  //              natural unique key on the server.
  async function _mergeAndConnect(modeChoice) {
    _connectMode = modeChoice;
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
        mergeStage = $_('settings_server_connection_ui.stage_local_data');
        mergeProgress = $_('settings_server_connection_ui.clearing_local');
        mergeProgressPct = 50;
        await wipeLocalData();
        mergeProgressPct = 100;
      }
      if (modeChoice === 'upload' || modeChoice === 'merge') {
        const { uploadLocalToServer } = await import('../../lib/migrate.js');
        const stageLabels = {
          categories: $_('settings_server_connection_ui.stage_categories'),
          recipes:    $_('settings_server_connection_ui.stage_recipes'),
          pantry:     $_('settings_server_connection_ui.stage_pantry'),
          diary:      $_('settings_server_connection_ui.stage_diary'),
          shopping:   $_('settings_server_connection_ui.stage_shopping'),
          settings:   $_('settings_server_connection_ui.stage_settings'),
        };
        migrationSummary = await uploadLocalToServer({
          serverUrl: url,
          authToken: token,
          onProgress: (stage, current, total) => {
            mergeStage = stageLabels[stage] || stage;
            mergeProgress = $_('settings_server_connection_ui.uploading_stage', { values: { stage: mergeStage, current: Math.min(current + 1, total), total } });
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
      showError(failed('settings_server_conn.toast.sync_failed', e));
    }
  }

  async function _finalizeConnect() {
    // The phone's data is this account's from now on, as chosen above:
    // Download replaces it; after an upload, what went up takes the
    // server's ids and the rest goes up with the next sync. Signing in
    // after the reload then neither asks nor clears.
    if (_pendingUserId != null) {
      const clear = _connectMode === 'download';
      const uploaded = (_connectMode === 'upload' || _connectMode === 'merge') ? (migrationSummary?.uploaded || {}) : {};
      try {
        const { claimForServer } = await import('../../lib/local-account.js');
        await claimForServer(_pendingServerUrl, _pendingUserId, { clear, uploaded, created: _pendingUserCreated });
      } catch (e) {
        console.warn('[account] could not mark the data as this account\'s:', e?.message || e);
      }
    }
    // The account just signed in to, not one cached by an earlier sign-in.
    try { localStorage.removeItem('ct:cachedUser'); localStorage.removeItem('wl:userId'); } catch {}
    // Signed in by SSO: Log Out can end the IdP session too (as App.svelte
    // keeps it for a sign-in from the setup screen). By password: no hint,
    // so one from an earlier SSO never goes to this server.
    keepSsoLogoutHint(_pendingLogoutHint);
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
    _pendingLogoutHint = null;
    setAuthToken(null);
  }

  // ── Server-mode actions ─────────────────────────────────────────────
  async function syncNow() {
    busy = true;
    try {
      const r = await fullSync(false);
      if (r?.ok === false && r.error) showError(failed('settings_server_conn.toast.sync_failed', r.error));
      else showSuccess($_('settings_server_conn.toast.synced'));
    } finally { busy = false; }
  }

  async function pushAll() {
    const ok = await confirmDialog({
      title: $_('settings_server_connection_ui.push_all_title'),
      message: $_('settings_server_connection_ui.push_all_message'),
      confirmText: $_('settings_server_connection_ui.push_all'),
    });
    if (!ok) return;
    busy = true;
    try {
      const r = await pushAllFromDevice();
      if (r?.ok === false && r.error) showError(failed('fail.push_all', r.error));
      else showSuccess($_('settings_server_conn.toast.pushed_all'));
    } finally { busy = false; }
  }

  // Sign out of the server account but KEEP the server URL + native
  // mode. After reload the user lands on the Login gate ready to sign
  // back in (matches NutriTrace's "Log Out" semantics for shared phones
  // or multi-user installs).
  async function logOut() {
    const ok = await confirmDialog({
      title: $_('settings_server_connection_ui.log_out_title'),
      message: $_('settings_server_connection_ui.log_out_message'),
      confirmText: $_('common.log_out'),
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
      title: $_('settings_server_connection_ui.disconnect_title'),
      message: $_('settings_server_connection_ui.disconnect_message'),
      confirmText: $_('settings_server_connection_ui.disconnect'),
      dangerous: true,
    });
    if (!ok) return;
    // The data on the phone is the phone's own now (local mode), and goes
    // to whichever account it's connected to next.
    try {
      const { setLocalOwner } = await import('../../lib/local-account.js');
      await setLocalOwner();
    } catch {}
    // The account's settings stay with the phone too: kept per account and
    // server, they'd otherwise vanish in local mode (lib/setting-key.js),
    // and the first-run welcome would show as if the app were new.
    const { settingPrefix, copySettingScope } = await import('../../lib/setting-key.js');
    const accountScope = settingPrefix();
    setServerUrl(null);
    setAuthToken(null);
    keepSsoLogoutHint(null); // this server's SSO session isn't the next one's
    setNativeMode('local');
    try { localStorage.removeItem('ct:cachedUser'); } catch {}
    try {
      copySettingScope(accountScope, settingPrefix('1'));
      localStorage.setItem(settingPrefix('1') + 'setupComplete', 'true');
    } catch { /* storage unavailable */ }
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
          {#if plainHttp}
            <div class="not-encrypted"><span class="material-symbols-rounded" aria-hidden="true">lock_open</span>{$_('plain_http.not_encrypted')}</div>
          {/if}
        </div>
      </div>

      <div class="row sync-row" title={lastSyncTitle}>
        <div class="state-body">
          <div class="row-label">{$_('settings_server_conn.last_synced')}</div>
          <div class="row-value">{lastSyncDisplay}{$syncState.syncing ? ' · ' + $_('settings_server_connection_ui.syncing_inline') : ''}</div>
          {#if $syncState.error}<div class="state-error">{$syncState.error}</div>{/if}
        </div>
        <button class="btn btn-secondary small" on:click={syncNow} disabled={busy || $syncState.syncing}>
          <span class="material-symbols-rounded" class:spin={$syncState.syncing}>{$syncState.syncing ? 'autorenew' : 'sync'}</span>
          {$syncState.syncing ? $_('sync.syncing') : $_('settings_server_connection_ui.sync_now')}
        </button>
      </div>

      <div class="row actions">
        <button class="btn btn-secondary" on:click={pushAll} disabled={busy}>
          <span class="material-symbols-rounded">upload</span>
          {$_('settings_server_connection_ui.push_all')}
        </button>
        <button class="btn btn-secondary" on:click={logOut} disabled={busy}>
          <span class="material-symbols-rounded">logout</span>
          {$_('common.log_out')}
        </button>
        <button class="btn btn-secondary danger" on:click={disconnect} disabled={busy}>
          <span class="material-symbols-rounded">link_off</span>
          {$_('settings_server_connection_ui.disconnect_use_locally')}
        </button>
      </div>
    {:else}
      <!-- ── Local-only state ─────────────────────────────────────── -->
      <div class="row state-row">
        <span class="material-symbols-rounded state-icon">smartphone</span>
        <div class="state-body">
          <div class="state-title">{$_('settings_server_conn.state_local')}</div>
          <div class="state-sub">{$_('settings_server_connection_ui.local_sub')}</div>
        </div>
      </div>

      <div class="form">
        <label class="form-group">
          <span class="form-label">{$_('settings_server_conn.server_url')}</span>
          <input class="input" type="url"
            placeholder="https://cooktrace.example.com"
            bind:value={serverUrl}
            on:input={() => signInOptions.typed(serverUrl)}
            on:blur={addressLeft}
            autocapitalize="off" autocorrect="off" />
        </label>

        <!-- The server's sign-in options (TraceApps/notetrace#36): SSO first,
             and a failure to read them said with Retry, never a quietly
             password-only form. -->
        {#if optionsState === 'checking'}
          <div class="options-note">{$_('server_signin.checking')}</div>
        {:else if optionsState === 'failed'}
          <div class="options-failed" role="alert">
            <span class="material-symbols-rounded">error</span>
            <div class="options-failed-text">{optionsError}</div>
            <button class="btn btn-secondary small" type="button" on:click={() => signInOptions.retry()} disabled={busy}>{$_('server_signin.retry')}</button>
          </div>
        {/if}
        {#if providers.length}
          <div class="sso-list">
            {#each providers as p (p.id)}
              <button class="btn btn-primary sso-btn" type="button" on:click={() => connectWithSso(p.id)} disabled={busy}>
                {#if p.logo_url}
                  <img src={/^(https?|data):/i.test(p.logo_url) ? p.logo_url : optionsFor + p.logo_url} alt="" class="sso-logo" on:error={e => e.target.style.display='none'} />
                {:else}
                  <span class="material-symbols-rounded">login</span>
                {/if}
                {$_('login.sso_sign_in_with', { values: { provider: p.display_name || p.name || p.id } })}
              </button>
            {/each}
          </div>
          {#if passwordLoginEnabled}
            <div class="auth-divider"><span>{$_('login.sso_or')}</span></div>
          {/if}
        {/if}
        {#if optionsState === 'ok' && !providers.length && !passwordLoginEnabled}
          <div class="options-failed">
            <span class="material-symbols-rounded">warning</span>
            <div class="options-failed-text">{$_('native_setup_ui.no_auth_methods')}</div>
          </div>
        {/if}
        {#if passwordLoginEnabled}
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
            <button type="button" class="pw-toggle" on:click={() => showPw = !showPw} aria-label={showPw ? $_('settings_server_connection_ui.hide_password') : $_('settings_server_connection_ui.show_password')}>
              <span class="material-symbols-rounded">{showPw ? 'visibility_off' : 'visibility'}</span>
            </button>
          </div>
        </label>
        <div class="form-actions">
          <button class="btn btn-primary" on:click={connect} disabled={busy}>
            {busy ? $_('settings_server_connection_ui.connecting') : $_('settings_server_connection_ui.connect_to_server')}
          </button>
        </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

{#if twoStepChallengeOpen}
  <div class="merge-overlay" use:portal transition:fade={{ duration: 150 }} use:closeOnBack={() => { twoStepChallengeOpen = null; }}>
    <div class="merge-dialog">
      <TwoStepChallenge challenge={twoStepChallengeOpen} serverUrl={twoStepChallengeOpen.url} account={username.trim()}
        on:done={twoStepDone} on:restart={twoStepRestart} />
    </div>
  </div>
{/if}

<!-- ── Merge dialog ───────────────────────────────────────────────── -->
{#if mergeStep === 'ask-settings'}
  <div class="merge-overlay" use:portal use:closeOnBack={() => {}} transition:fade={{ duration: 150 }}>
    <div class="merge-dialog">
      <h3 class="merge-title">{$_('settings_server_conn.sync_options')}</h3>
      <p class="merge-sub">
        {$_('settings_server_connection_ui.merge_sub')}
      </p>
      {#if localCounts && localCounts.total > 0}
        <div class="merge-counts">
          <div class="merge-counts-title">{$_('settings_server_connection_ui.on_this_phone')}</div>
          <div class="merge-counts-grid">
            {#if localCounts.recipes  > 0}<div><strong>{localCounts.recipes}</strong> {$_('settings_server_connection_ui.count_recipes', { values: { count: localCounts.recipes } })}</div>{/if}
            {#if localCounts.pantry   > 0}<div><strong>{localCounts.pantry}</strong> {$_('settings_server_connection_ui.count_pantry', { values: { count: localCounts.pantry } })}</div>{/if}
            {#if localCounts.diary    > 0}<div><strong>{localCounts.diary}</strong> {$_('settings_server_connection_ui.count_diary', { values: { count: localCounts.diary } })}</div>{/if}
            {#if localCounts.shopping > 0}<div><strong>{localCounts.shopping}</strong> {$_('settings_server_connection_ui.count_shopping', { values: { count: localCounts.shopping } })}</div>{/if}
            {#if localCounts.categories > 0}<div><strong>{localCounts.categories}</strong> {$_('settings_server_connection_ui.count_categories', { values: { count: localCounts.categories } })}</div>{/if}
            {#if localCounts.settings > 0}<div><strong>{localCounts.settings}</strong> {$_('settings_server_connection_ui.count_settings', { values: { count: localCounts.settings } })}</div>{/if}
          </div>
        </div>
      {/if}
      <div class="merge-options">
        <button class="merge-option" on:click={() => _mergeAndConnect('upload')}>
          <span class="material-symbols-rounded merge-icon">cloud_upload</span>
          <div>
            <div class="merge-option-title">{$_('settings_server_conn.upload_phone_to_server')}</div>
            <div class="merge-option-desc">{$_('settings_server_connection_ui.upload_desc')}</div>
          </div>
        </button>
        <button class="merge-option" on:click={() => _mergeAndConnect('download')}>
          <span class="material-symbols-rounded merge-icon">cloud_download</span>
          <div>
            <div class="merge-option-title">{$_('settings_server_conn.download_server_to_phone')}</div>
            <div class="merge-option-desc">{$_('settings_server_connection_ui.download_desc')}</div>
          </div>
        </button>
        <button class="merge-option" on:click={() => _mergeAndConnect('merge')}>
          <span class="material-symbols-rounded merge-icon">sync</span>
          <div>
            <div class="merge-option-title">{$_('settings_server_conn.merge_both')}</div>
            <div class="merge-option-desc">{$_('settings_server_connection_ui.merge_desc')}</div>
          </div>
        </button>
        <button class="btn btn-secondary merge-cancel" on:click={cancelMerge}>{$_('settings_server_conn.cancel')}</button>
      </div>
    </div>
  </div>
{:else if mergeStep === 'syncing'}
  <div class="merge-overlay" use:portal use:closeOnBack={() => {}} transition:fade={{ duration: 150 }}>
    <div class="merge-dialog merge-syncing">
      <span class="material-symbols-rounded sync-spin">sync</span>
      <p class="syncing-title">{$_('sync.syncing')}</p>
      <p class="syncing-sub">{mergeProgress || $_('settings_server_connection_ui.preparing')}</p>
      {#if mergeProgressPct > 0}
        <div class="merge-progress-bar">
          <div class="merge-progress-fill" style="width:{mergeProgressPct}%"></div>
        </div>
      {/if}
    </div>
  </div>
{:else if mergeStep === 'summary' && migrationSummary}
  <div class="merge-overlay" use:portal use:closeOnBack={() => {}} transition:fade={{ duration: 150 }}>
    <div class="merge-dialog">
      <h3 class="merge-title">
        {migrationSummary.errors.length === 0 ? $_('settings_server_connection_ui.upload_complete') : $_('settings_server_connection_ui.upload_with_issues')}
      </h3>
      <p class="merge-sub">
        {$_('settings_server_connection_ui.uploaded_of_total', { values: { success: migrationSummary.totalSuccess, total: migrationSummary.total } })}
      </p>
      <div class="merge-counts">
        <div class="merge-counts-title">{$_('settings_server_connection_ui.uploaded_to_server')}</div>
        <div class="merge-counts-grid">
          {#if migrationSummary.success.recipes  > 0}<div><strong>{migrationSummary.success.recipes}</strong> {$_('settings_server_connection_ui.count_recipes', { values: { count: migrationSummary.success.recipes } })}</div>{/if}
          {#if migrationSummary.success.pantry   > 0}<div><strong>{migrationSummary.success.pantry}</strong> {$_('settings_server_connection_ui.count_pantry', { values: { count: migrationSummary.success.pantry } })}</div>{/if}
          {#if migrationSummary.success.diary    > 0}<div><strong>{migrationSummary.success.diary}</strong> {$_('settings_server_connection_ui.count_diary', { values: { count: migrationSummary.success.diary } })}</div>{/if}
          {#if migrationSummary.success.shopping > 0}<div><strong>{migrationSummary.success.shopping}</strong> {$_('settings_server_connection_ui.count_shopping', { values: { count: migrationSummary.success.shopping } })}</div>{/if}
          {#if migrationSummary.success.categories > 0}<div><strong>{migrationSummary.success.categories}</strong> {$_('settings_server_connection_ui.count_categories', { values: { count: migrationSummary.success.categories } })}</div>{/if}
          {#if migrationSummary.success.settings > 0}<div><strong>{migrationSummary.success.settings}</strong> {$_('settings_server_connection_ui.count_settings', { values: { count: migrationSummary.success.settings } })}</div>{/if}
        </div>
      </div>
      {#if migrationSummary.errors.length > 0}
        <div class="merge-errors">
          <div class="merge-counts-title err">
            {$_('settings_server_connection_ui.error_count', { values: { count: migrationSummary.errors.length } })}
            {#if migrationSummary.errors.length > 5}{$_('settings_server_connection_ui.showing_first_5')}{/if}
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
  .not-encrypted {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-top: 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--warning, #f59e0b);
  }
  .not-encrypted .material-symbols-rounded { font-size: 15px; }
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
  .state-error { font-size: 12px; color: var(--danger); margin-top: 4px; }
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
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 30%, var(--border));
  }
  .btn.danger:hover {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
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
  .form-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .options-note { font-size: 13px; color: var(--text-3); }
  .options-failed {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    color: var(--text-1);
    font-size: 13px; line-height: 1.4;
  }
  .options-failed .material-symbols-rounded { color: var(--danger); font-size: 20px; }
  .options-failed-text { flex: 1; min-width: 160px; }
  .sso-list { display: flex; flex-direction: column; gap: 8px; }
  .sso-btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; }
  .sso-btn .material-symbols-rounded { font-size: 20px; }
  .sso-logo { width: 20px; height: 20px; object-fit: contain; }
  .auth-divider { display: flex; align-items: center; gap: 10px; color: var(--text-3); font-size: 12px; }
  .auth-divider::before, .auth-divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }

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
  .merge-counts-title.err { color: var(--danger); }
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
