<script>
  import { _ } from 'svelte-i18n';
  import { setNativeMode, setServerUrl, setAuthToken, resolveAssetUrl, iconUrl } from '../lib/platform.js';
  import { checkServer, discoverSignIn, passwordSignIn, openSso, explainSignInError, serverProblemText } from '../lib/server-signin.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { DB } from '../lib/db.js';

  // State machine:
  //   'choose'      → pick local vs server
  //   'server-url'  → enter URL, click Next → validate + discover auth methods
  //   'server-auth' → show password form + OIDC buttons per what the server supports
  //   'connecting'  → in-flight (transient during network calls)
  //
  // The two-step split (server-url → server-auth) is what unlocks OIDC-only
  // servers (NT #110, mirrored here): the old single form demanded
  // username+password to submit, so users of Authentik-backed / OIDC-only
  // CookTrace servers couldn't get past this screen on a fresh install. Now
  // the URL is validated first, then we ask the server /api/auth/status
  // which auth methods to render.
  let step = 'choose';
  let serverUrl = '';
  let validatedUrl = '';        // set after successful step-1 validation
  let providers = [];            // OIDC providers array from /api/auth/status
  let passwordLoginEnabled = true;
  let optionsError = '';         // why the sign-in options couldn't be read (shown with Retry)
  let username = '';
  let password = '';
  let showPw = false;
  let connecting = false;

  async function chooseLocal() {
    setNativeMode('local');
    setServerUrl(null);
    // Data made from here on is the phone's own (lib/local-account.js).
    try {
      const { setLocalOwner } = await import('../lib/local-account.js');
      await setLocalOwner();
    } catch {}
    // Reload — SQLite will initialize naturally when CtApiNative is first called
    window.location.reload();
  }

  function chooseServer() {
    step = 'server-url';
  }

  // Step 1 → step 2: check it's the server (a sign-in proxy's web page in
  // the way is said plainly, TraceApps/notetrace#36), then ask which sign-in
  // options it has. Uses CapacitorHttp to bypass WebView CORS.
  async function validateAndNext() {
    if (!serverUrl.trim()) { showError($_('native_setup_ct.toast.enter_url')); return; }
    const url = serverUrl.trim().replace(/\/$/, '');
    connecting = true;
    try {
      await checkServer(url);
      validatedUrl = url;
      await loadOptions();
      step = 'server-auth';
    } catch (e) {
      validatedUrl = '';
      showError(explainSignInError(e, url));
    } finally {
      connecting = false;
    }
  }

  // Which ways the server offers to sign in (/api/auth/status). When they
  // can't be read, the sign-in step says so with Retry, and keeps the
  // password form: the server may well take one.
  async function loadOptions() {
    try {
      ({ providers, passwordLoginEnabled } = await discoverSignIn(validatedUrl));
      optionsError = '';
    } catch (e) {
      providers = [];
      passwordLoginEnabled = true;
      console.warn('[setup] sign-in options:', e?.status || e?.message);
      optionsError = serverProblemText(e, { native: true, otherwise: 'options' });
    }
  }

  async function retryOptions() {
    connecting = true;
    try { await loadOptions(); } finally { connecting = false; }
  }

  // Step 2 (password branch): traditional username+password sign-in. Unchanged
  // in behaviour from the pre-fix single-form flow — only reached when the
  // server actually has password login enabled.
  async function loginWithPassword() {
    if (!username.trim() || !password.trim()) { showError($_('native_setup_ct.toast.enter_credentials')); return; }
    connecting = true;
    try {
      const loginData = await passwordSignIn(validatedUrl, username.trim(), password);

      setServerUrl(validatedUrl);
      setAuthToken(loginData.token);
      setNativeMode('server');
      DB.setSetting('setupComplete', true);
      showSuccess($_('native_setup_ct.toast.connected_to_server'));
      window.location.reload();
    } catch (e) {
      showError(explainSignInError(e, validatedUrl));
    } finally {
      connecting = false;
    }
  }

  // Step 2 (OIDC branch): opens the Authentik/Keycloak/etc. sign-in flow in
  // the Capacitor browser. Server URL + native mode + setupComplete are
  // persisted BEFORE opening the browser because the deep-link callback
  // (App.svelte appUrlOpen handler) sets only the auth token — it relies on
  // the app already knowing which server to talk to. If the user cancels
  // mid-OIDC (backs out of the browser), the app is in a "URL known, no
  // token" state and next launch lands on Login.svelte which correctly
  // renders the OIDC button now that getServerUrl() is populated.
  async function loginWithOidc(providerId) {
    // One browser at a time: a second tap would replace the first one's
    // secret (lib/oidc-app-handoff.js) and that sign-in would fail.
    if (connecting) return;
    connecting = true;
    setServerUrl(validatedUrl);
    setNativeMode('server');
    DB.setSetting('setupComplete', true);
    try {
      await openSso(validatedUrl, providerId);
      // Deep-link callback (cooktrace://oidc-callback?token=…) handled by
      // App.svelte's appUrlOpen listener — it sets the token, calls
      // loadAuthState, redirects to '#/', and the main app renders.
    } catch (e) {
      showError($_('native_setup_ct.toast.cant_open_signin'));
    } finally {
      connecting = false;
    }
  }

  function backToChoose() {
    step = 'choose';
    serverUrl = '';
    validatedUrl = '';
    providers = [];
    passwordLoginEnabled = true;
    optionsError = '';
    username = '';
    password = '';
  }

  function backToServerUrl() {
    step = 'server-url';
    validatedUrl = '';
    providers = [];
    passwordLoginEnabled = true;
    optionsError = '';
    username = '';
    password = '';
  }
</script>

<div class="setup-wrap">
  <div class="setup-inner">
    <!-- Logo / branding -->
    <div class="setup-brand">
      <img src={iconUrl('/icons/icon-192.png')} alt="CookTrace" class="setup-logo" />
      <h1 class="setup-title">{$_('native_setup_ct.app_name')}</h1>
      <p class="setup-subtitle">{$_('native_setup_ct.tagline')}</p>
    </div>

    {#if step === 'choose'}
      <div class="setup-cards">
        <button class="setup-card" on:click={chooseLocal}>
          <span class="material-symbols-rounded setup-card-icon">smartphone</span>
          <div class="setup-card-title">{$_('native_setup_ct.use_locally')}</div>
          <p class="setup-card-desc">{$_('native_setup_ui.local_desc')}</p>
        </button>

        <button class="setup-card" on:click={chooseServer}>
          <span class="material-symbols-rounded setup-card-icon">cloud_sync</span>
          <div class="setup-card-title">{$_('native_setup_ct.connect_to_server')}</div>
          <p class="setup-card-desc">{$_('native_setup_ui.server_desc')}</p>
        </button>
      </div>

    {:else if step === 'server-url'}
      <div class="setup-form">
        <div class="form-group">
          <label class="form-label">{$_('native_setup_ct.server_url')}</label>
          <input
            class="input"
            type="url"
            placeholder="https://cooktrace.example.com"
            bind:value={serverUrl}
            autocapitalize="off"
            autocorrect="off"
          />
          <p class="form-hint">{$_('native_setup_ui.server_url_hint')}</p>
        </div>

        <div class="setup-form-actions">
          <button class="btn btn-ghost" on:click={backToChoose} disabled={connecting}>
            {$_('common.back')}
          </button>
          <button class="btn btn-primary" on:click={validateAndNext} disabled={connecting}>
            {connecting ? $_('updates.checking') : $_('wizard_ct.next')}
          </button>
        </div>
      </div>

    {:else if step === 'server-auth'}
      <div class="setup-form">
        <p class="server-line">
          <span class="material-symbols-rounded server-icon">cloud_done</span>
          <span class="server-url">{validatedUrl}</span>
        </p>

        {#if optionsError}
          <div class="options-failed" role="alert">
            <span class="material-symbols-rounded">error</span>
            <div class="options-failed-text">{optionsError}</div>
            <button class="btn btn-secondary options-retry" on:click={retryOptions} disabled={connecting}>{$_('server_signin.retry')}</button>
          </div>
        {/if}

        <!-- OIDC providers first — for OIDC-only servers this is the only
             option; for mixed servers it's the recommended flow anyway. -->
        {#if providers.length}
          <div class="oidc-list">
            {#each providers as p (p.id)}
              <button class="btn btn-primary oidc-btn" on:click={() => loginWithOidc(p.id)} disabled={connecting}>
                <!-- Provider logo when the admin configured a logo_url on this
                     OIDC provider (populated from PROVIDER_PRESETS in
                     SettingsAuth.svelte for known IdPs — Authentik, Keycloak,
                     Authelia, Google, Pocket ID, Auth0). Falls back to the
                     generic material 'login' icon when no logo is set (Custom
                     providers) or the image fails to load. Same pattern
                     Login.svelte uses for consistency. -->
                {#if p.logo_url}
                  <img src={resolveAssetUrl(p.logo_url)} alt="" class="oidc-logo" on:error={e => e.target.style.display='none'} />
                {:else}
                  <span class="material-symbols-rounded" style="font-size:20px">login</span>
                {/if}
                {$_('login.sso_sign_in_with', { values: { provider: p.display_name || p.name || p.id } })}
              </button>
            {/each}
          </div>
        {/if}

        <!-- Password form only when the server has it enabled. Divider only
             shown when both auth methods are available. -->
        {#if passwordLoginEnabled && providers.length}
          <div class="auth-divider"><span>{$_('login.sso_or')}</span></div>
        {/if}
        {#if passwordLoginEnabled}
          <div class="form-group">
            <label class="form-label">{$_('native_setup_ct.username')}</label>
            <input
              class="input"
              type="text"
              placeholder={$_('native_setup_ct.username_ph')}
              bind:value={username}
              autocapitalize="off"
              autocorrect="off"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{$_('native_setup_ct.password')}</label>
            <div style="position:relative">
              {#if showPw}
                <input class="input" type="text" placeholder={$_('native_setup_ct.password_ph')} bind:value={password} style="padding-right:40px" />
              {:else}
                <input class="input" type="password" placeholder={$_('native_setup_ct.password_ph')} bind:value={password} style="padding-right:40px" />
              {/if}
              <button type="button" class="pw-toggle" on:click={() => showPw = !showPw}>
                <span class="material-symbols-rounded" style="font-size:20px">{showPw ? 'visibility_off' : 'visibility'}</span>
              </button>
            </div>
          </div>
        {/if}

        <!-- Edge case: server has neither password nor OIDC configured.
             Should be rare (server is misconfigured) but rendering a helpful
             message beats a blank form. -->
        {#if !providers.length && !passwordLoginEnabled && !optionsError}
          <div class="no-auth-warning">
            <span class="material-symbols-rounded">warning</span>
            <div>{$_('native_setup_ui.no_auth_methods')}</div>
          </div>
        {/if}

        <div class="setup-form-actions">
          <button class="btn btn-ghost" on:click={backToServerUrl} disabled={connecting}>
            {$_('common.back')}
          </button>
          {#if passwordLoginEnabled}
            <button class="btn btn-primary" on:click={loginWithPassword} disabled={connecting}>
              {connecting ? $_('login.signing_in') : $_('login.sign_in')}
            </button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .setup-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    padding: 24px;
    background: var(--bg, #0A0B0F);
  }
  .setup-inner {
    width: 100%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 32px;
  }
  .setup-brand {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .setup-logo {
    width: 80px;
    height: 80px;
    border-radius: 20px;
  }
  .setup-title {
    font-size: 28px;
    font-weight: 700;
    color: var(--text-1);
    margin: 0;
  }
  .setup-subtitle {
    font-size: 14px;
    color: var(--text-3);
    margin: 0;
  }
  .setup-cards {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .setup-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 24px 20px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 16px);
    cursor: pointer;
    text-align: center;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
  }
  .setup-card:hover {
    background: var(--surface-2);
    border-color: var(--accent, #3b82f6);
  }
  .setup-card:active {
    transform: scale(0.98);
  }
  .setup-card-icon {
    font-size: 40px;
    color: var(--accent, #3b82f6);
  }
  .setup-card-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-1);
  }
  .setup-card-desc {
    font-size: 13px;
    color: var(--text-3);
    margin: 0;
    line-height: 1.5;
  }
  .setup-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .form-hint {
    font-size: 12px;
    color: var(--text-3);
    margin: 6px 0 0;
    line-height: 1.5;
  }
  .setup-form-actions {
    display: flex;
    gap: 12px;
    margin-top: 8px;
  }
  .setup-form-actions .btn {
    flex: 1;
  }
  .pw-toggle {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer; color: var(--text-3); padding: 4px;
  }
  .server-line {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 10px 12px;
    background: var(--surface-2);
    border-radius: 8px;
    font-size: 13px;
    color: var(--text-2);
  }
  .server-icon { font-size: 18px; color: var(--accent, #3b82f6); }
  .server-url {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
  }
  .oidc-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .oidc-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
  }
  .oidc-logo {
    width: 20px;
    height: 20px;
    object-fit: contain;
  }
  .auth-divider {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-3);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .auth-divider::before,
  .auth-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .options-failed {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 10px 12px;
    border-radius: var(--radius-md, 10px);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    color: var(--text-1);
    font-size: 13px; line-height: 1.4;
  }
  .options-failed .material-symbols-rounded { color: var(--danger); font-size: 20px; }
  .options-failed-text { flex: 1; min-width: 160px; }
  .no-auth-warning {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 12px 14px;
    background: color-mix(in srgb, #f59e0b 8%, transparent);
    border-left: 3px solid #f59e0b;
    border-radius: 4px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-2);
  }
  .no-auth-warning .material-symbols-rounded {
    font-size: 20px;
    color: #f59e0b;
    flex-shrink: 0;
  }
</style>
