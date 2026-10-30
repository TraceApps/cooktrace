<script>
  import { failed } from '../lib/messages.js';
  import { onMount } from 'svelte';
  import { currentUser, userMgmtActive, loadAuthState, signInProblem, authUnreachable, sessionEnded } from '../stores/auth.js';
  import { cookieBlockedByHttp, droppedCookieReason } from '../lib/cookie-check.js';
  import CookieWarning from '../components/ui/CookieWarning.svelte';
  import { loadServerSettings } from '../stores/settings.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { push } from 'svelte-spa-router';
  import { slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { apiUrl, isNative, getServerUrl, setAuthToken, resolveAssetUrl, iconUrl } from '../lib/platform.js';
  import { isShortcutHash } from '../lib/app-shortcut.js';

  import { get } from 'svelte/store';
  import { responseJson, discoverSignIn, openSso, serverProblemText, webPageError } from '../lib/server-signin.js';
  import { twoStepChallenge } from '../lib/two-step.js';
  import TwoStepChallenge from '../components/two-step/TwoStepChallenge.svelte';

  let username = '';
  let password = '';
  let loading  = false;

  // Biometric sign-in button is offered only when the device has biometric
  // hardware AND the user has previously signed in with biometric enabled
  // (so a saved token is stashed). Probed in onMount.
  let _biometricReady = false;
  async function biometricLogin() {
    // An app icon shortcut waiting under this screen opens once signed in.
    const shortcutWaiting = isShortcutHash(window.location.hash);
    try {
      const bio = await import('../lib/biometric.js');
      const ok = await bio.authenticate($_('login_ui.biometric_reason'));
      if (!ok) return;
      const saved = await bio.readSavedToken();
      if (!saved) { showError($_('login_ct.toast.no_saved')); return; }
      setAuthToken(saved);
      await loadAuthState();
      // If /me rejected the saved token (expired, JWT_SECRET rotated, backup
      // restored, server URL changed), loadAuthState cleared currentUser.
      // Without an explicit check the user lands on '/' briefly then bounces
      // right back to Login — looks like biometric "did nothing." Same fix
      // as NT (commit 9d33afb) + LT (commit cb0853b).
      if (!get(currentUser)) {
        showError($_('login_ct.toast.saved_expired'));
        await bio.clearSavedToken();
        return;
      }
      await loadServerSettings();
      if (!shortcutWaiting) push('/');
    } catch (e) {
      console.warn('[login] biometric flow failed:', e);
      showError($_('login_ct.toast.biometric_failed'));
    }
  }

  let showRecovery  = false;
  let recovering    = false;
  let recoveryDone  = false;
  let recoveryToken = '';
  // Locked Out? can also reset two-step sign-in for one account (nutritrace#222).
  let recoveryUsername = '';
  let resettingTwoStep = false;

  // Two-step sign-in (nutritrace#222): after a right password, the server may
  // ask for a code ('verify') or for setup ('setup'). Null while it doesn't.
  let challenge = null;
  let challengeShortcut = false;

  // OIDC providers + password-login flag are returned by /api/auth/status.
  // Native (Capacitor server-mode) routes the auth flow through
  // @capacitor/browser; the IdP redirects back via a cooktrace://oidc-callback
  // deep link which App.svelte handles. Native local mode skips OIDC entirely
  // since there's no server to talk to.
  let oidcProviders = [];
  let passwordLoginEnabled = true;
  let authStatus = null;
  let optionsError = '';  // the sign-in options couldn't be read: said, with Retry (TraceApps/notetrace#36)
  onMount(async () => {
    if (isNative && !getServerUrl()) return; // standalone — skip
    // Probe biometric concurrently with the auth-status fetch.
    if (isNative) {
      try {
        const bio = await import('../lib/biometric.js');
        const [available, saved] = await Promise.all([bio.isAvailable(), bio.readSavedToken()]);
        _biometricReady = available && !!saved;
      } catch {}
    }
    await loadSignInOptions();
  });

  // The server couldn't say who is signed in when the app opened (stores/
  // auth.js): Retry asks again, and a session that's still good opens the
  // app; otherwise the sign-in options load as usual. Coming back online
  // asks again by itself (an event, nothing repeating).
  let retrying = false;
  async function retryServer() {
    if (retrying) return;
    retrying = true;
    try {
      await loadAuthState();
      if (!get(authUnreachable)) await loadSignInOptions();
    } finally {
      retrying = false;
    }
  }
  onMount(() => {
    const backOnline = () => { if (get(authUnreachable)) retryServer(); };
    window.addEventListener('online', backOnline);
    return () => window.removeEventListener('online', backOnline);
  });

  async function loadSignInOptions() {
    try {
      // The app asks natively (no CORS, so a sign-in proxy's page is said as
      // such, not "Failed to fetch"); the web page asks its own origin.
      let data;
      if (isNative) data = (await discoverSignIn(getServerUrl())).status;
      else {
        // Redirects not followed: the server never sends one, a sign-in proxy does (lib/auth-load.js).
        const r = await fetch(apiUrl('/api/auth/status'), { credentials: 'include', redirect: 'manual' })
          .catch((err) => { throw Object.assign(err, { network: true }); });
        if (r.type === 'opaqueredirect') throw webPageError();
        data = await responseJson(r);
        if (!r.ok) throw Object.assign(new Error(`status ${r.status}`), { status: r.status, serverError: true });
      }
      authStatus = data;
      // Plain HTTP with an HTTPS-only cookie: say so before anyone signs
      // in (lib/cookie-check.js).
      if (cookieBlockedByHttp(data, { native: isNative })) signInProblem.set('http');
      if (data?.oidc) {
        oidcProviders = Array.isArray(data.oidc.providers) ? data.oidc.providers : [];
        passwordLoginEnabled = data.oidc.enable_email_password_login !== false;
      }
      optionsError = '';
    } catch (e) {
      console.warn('[login] sign-in options:', e?.status || e?.message);
      // The same one line the startup check says (lib/server-signin.js), never a second.
      optionsError = serverProblemText(e, { native: isNative, otherwise: 'options' });
    }
  }

  let _ssoOpening = false;
  async function startOidc(providerId) {
    const ret = encodeURIComponent(window.location.hash || '#/');
    if (isNative) {
      // Capacitor: open in @capacitor/browser. The mobile=1 flag tells
      // the server to redirect via the cooktrace://oidc-callback deep
      // link instead of setting an HttpOnly cookie + SPA hash redirect.
      // One browser at a time: a second tap would replace the first one's
      // secret (lib/oidc-app-handoff.js).
      if (_ssoOpening) return;
      _ssoOpening = true;
      try { await openSso(getServerUrl(), providerId); } finally { _ssoOpening = false; }
      return;
    }
    window.location.href = apiUrl(`/api/auth/oidc/login/${providerId}?return=${ret}`);
  }

  async function login() {
    // An app icon shortcut waiting under this screen opens once signed in:
    // read now, as Recipes may take it (and change the address) first.
    const shortcutWaiting = isShortcutHash(window.location.hash);
    if (!username.trim() || !password) return;
    loading = true;
    try {
      const res = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await responseJson(res);
      const ch = twoStepChallenge(data);
      if (ch) { challenge = ch; challengeShortcut = shortcutWaiting; return; }
      if (!res.ok) { showError(failed('login.errors.failed', data.error)); return; }
      await signedIn(data, shortcutWaiting);
    } catch(e) {
      // A sign-in proxy's web page in place of the server: said as such.
      showError(e?.webPage ? e.message : $_('common.errors.cant_reach_server'));
    } finally {
      loading = false;
    }
  }

  // The second step finished: signed in as with a password alone.
  async function twoStepDone(e) {
    const data = e.detail || {};
    loading = true;
    try {
      await signedIn(data, challengeShortcut);
      if (data.recovery_codes_left != null) {
        showSuccess($_('two_step.signin.recovery_used', { values: { count: data.recovery_codes_left } }));
      }
    } catch {
      showError($_('common.errors.cant_reach_server'));
    } finally {
      loading = false;
    }
  }
  function twoStepRestart(e) {
    challenge = null;
    password = '';
    if (e.detail?.message) showError(e.detail.message);
  }

  // Signed in: the session (cookie on the web, token in the app), then the app.
  async function signedIn(data, shortcutWaiting) {
    // Store auth token for native server mode
    if (isNative && data.token) setAuthToken(data.token);
    // If biometric is enabled, stash the JWT so the next launch can unlock
    // with biometric instead of password. Mirrors the NT + LT save-on-login
    // pattern.
    if (isNative && data.token) {
      try {
        const { biometricLoginEnabled } = await import('../stores/settings.js');
        const { saveTokenForBiometric } = await import('../lib/biometric.js');
        if (get(biometricLoginEnabled)) await saveTokenForBiometric(data.token);
      } catch {}
    }
    // Cache user for offline fallback
    localStorage.setItem('wl:userId', String(data.user.id));
    localStorage.setItem('ct:cachedUser', JSON.stringify(data.user));
    localStorage.setItem('ct:cachedUserMgmt', '1');
    // Web: don't set the user here. loadAuthState() below reads it back
    // from the server, so the app only appears once the session cookie has
    // actually stuck; setting it early flashed the app for a moment before
    // a dropped cookie sent the user back. Native signs in with a token.
    if (isNative) currentUser.set(data.user);
    // Refresh CSRF token from /api/auth/me before any state-changing request
    // can fire (otherwise reactive settings saves would use a stale csrf from
    // a previous session and 403). loadAuthState() handles the fetch and
    // populates localStorage ct:csrf as a side effect.
    await loadAuthState();
    // The password was right but the session didn't stick: the browser
    // dropped the cookie. Say why here instead of looping back to sign-in.
    // get(), not $currentUser: this page can be torn down meanwhile.
    challenge = null;
    if (!isNative && !get(currentUser)) {
      signInProblem.set(droppedCookieReason(authStatus, { native: isNative }));
      return;
    }
    signInProblem.set(null);
    await loadServerSettings();
    if (!shortcutWaiting) push('/');
  }

  // Locked Out?, the owner's way back in for one account: RECOVERY_TOKEN
  // turns two-step sign-in off for that account and changes nothing else.
  async function resetTwoStep() {
    if (!recoveryToken.trim() || !recoveryUsername.trim()) return;
    resettingTwoStep = true;
    try {
      const res = await fetch(apiUrl('/api/auth/two-step/recover'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: recoveryToken.trim(), username: recoveryUsername.trim() }),
      });
      const data = await responseJson(res);
      if (!res.ok) { showError(data.error || $_('two_step.locked_out.failed')); return; }
      showSuccess($_('two_step.locked_out.done', { values: { name: recoveryUsername.trim() } }));
      recoveryToken = '';
      showRecovery = false;
      username = recoveryUsername.trim();
      recoveryUsername = '';
    } catch (e) {
      showError(e?.webPage ? e.message : $_('common.errors.cant_reach_server'));
    } finally {
      resettingTwoStep = false;
    }
  }

  async function recover() {
    if (!confirm($_('login.recovery.confirm_delete'))) return;
    recovering = true;
    try {
      const res = await fetch(apiUrl('/api/auth/recover'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: recoveryToken.trim() }),
      });
      const data = await responseJson(res);
      if (!res.ok) { showError(failed('login.recovery.failed', data.error)); return; }
      localStorage.removeItem('wl:userId');
      await loadAuthState();
      recoveryDone = true;
      showSuccess($_('login.recovery.success'));
    } catch(e) {
      showError(e?.webPage ? e.message : $_('common.errors.cant_reach_server'));
    } finally {
      recovering = false;
    }
  }

  function onKey(e) { if (e.key === 'Enter') login(); }
</script>

<div class="login-page">
  <div class="login-card card">
    <div class="login-logo">
      <img src={iconUrl('/icons/logo.png')} alt="CookTrace" class="logo-img" />
      <h1 class="login-title">{$_('login_ct.app_name')}</h1>
      <p class="text-3 text-sm">{$_('login.subtitle')}</p>
    </div>

    {#if $signInProblem}
      <CookieWarning reason={$signInProblem} />
    {/if}

    {#if $sessionEnded && !challenge}
      <!-- This device was signed out (a password change, Sign Out Everywhere: server/lib/session-version.js). -->
      <div class="session-ended" role="status">
        <span class="material-symbols-rounded">logout</span>
        <div>{$_('login.session_ended')}</div>
      </div>
    {/if}

    {#if challenge}
      <TwoStepChallenge {challenge} account={username.trim()} on:done={twoStepDone} on:restart={twoStepRestart} />
    {:else if !recoveryDone}
      {#if $authUnreachable}
        <div class="options-error" role="alert" data-auth-unreachable>
          <span>{$authUnreachable}</span>
          <button class="btn btn-secondary options-retry" type="button" on:click={retryServer} disabled={retrying}>{$_('server_signin.retry')}</button>
        </div>
      {:else if optionsError}
        <div class="options-error" role="alert">
          <span>{optionsError}</span>
          <button class="btn btn-secondary options-retry" type="button" on:click={loadSignInOptions}>{$_('server_signin.retry')}</button>
        </div>
      {/if}
      {#if oidcProviders.length}
        <div class="sso-row">
          {#each oidcProviders as p (p.id)}
            <button class="btn btn-secondary sso-btn" on:click={() => startOidc(p.id)} type="button">
              {#if p.logo_url}
                <img src={resolveAssetUrl(p.logo_url)} alt="" class="sso-logo" />
              {:else}
                <span class="material-symbols-rounded sso-icon">login</span>
              {/if}
              <span>{$_('login.sso_sign_in_with', { values: { provider: p.display_name || 'SSO' } })}</span>
            </button>
          {/each}
        </div>
        {#if passwordLoginEnabled}
          <div class="sso-divider"><span>{$_('login.sso_or')}</span></div>
        {/if}
      {/if}

      {#if passwordLoginEnabled}
        <div class="form-group">
          <label class="form-label">{$_('login.username')}</label>
          <input class="input" type="text" autocomplete="username"
            bind:value={username} on:keydown={onKey}
            placeholder={$_('login.username_placeholder')} autofocus />
        </div>

        <div class="form-group">
          <label class="form-label">{$_('login.password')}</label>
          <input class="input" type="password" autocomplete="current-password"
            bind:value={password} on:keydown={onKey}
            placeholder={$_('login.password_placeholder')} />
        </div>

        <button class="btn btn-primary w-full" class:loading on:click={login} disabled={loading || !username || !password}>
          {loading ? $_('login.signing_in') : $_('login.sign_in')}
        </button>

        {#if _biometricReady}
          <button class="btn btn-ghost w-full" style="display:flex;align-items:center;justify-content:center;gap:8px"
            on:click={biometricLogin} disabled={loading}>
            <span class="material-symbols-rounded">fingerprint</span>
            <span>{$_('login_ct.biometric_signin')}</span>
          </button>
        {/if}

        <div style="text-align:center">
          <button class="recovery-toggle" on:click={() => push('/forgot-password')}>{$_('login.forgot_password')}</button>
        </div>
      {:else if !oidcProviders.length}
        <p class="text-3 text-sm" style="text-align:center">{$_('login.no_signin_methods')}</p>
      {/if}

      <!-- Locked out recovery -->
      <button class="recovery-toggle" on:click={() => showRecovery = !showRecovery}>
        {showRecovery ? $_('common.hide') : $_('login.locked_out')}
      </button>

      {#if showRecovery}
        <div class="recovery-box" transition:slide={{ duration: 180 }}>
          <p style="margin:0">{@html $_('login.recovery.token_prompt')}</p>
          <input class="input" type="password" bind:value={recoveryToken} placeholder={$_('login.recovery.token_placeholder')} />

          <!-- The gentler way first: two-step sign-in off for one account. -->
          <div class="recovery-part">
            <strong class="recovery-heading">{$_('two_step.locked_out.title')}</strong>
            <p style="margin:0">{$_('two_step.locked_out.explain')}</p>
            <input class="input" type="text" autocomplete="off" autocapitalize="off" bind:value={recoveryUsername} placeholder={$_('two_step.locked_out.username_placeholder')} />
            <button class="btn btn-secondary" style="width:100%" on:click={resetTwoStep} disabled={resettingTwoStep || !recoveryToken.trim() || !recoveryUsername.trim()}>
              {resettingTwoStep ? $_('two_step.locked_out.resetting') : $_('two_step.locked_out.action')}
            </button>
          </div>

          <div class="recovery-part">
            <strong class="recovery-heading recovery-heading-danger">
              <span class="material-symbols-rounded" style="font-size:18px;color:var(--warning,#f59e0b)">warning</span>
              {$_('two_step.locked_out.disable_title')}
            </strong>
            <p style="margin:0">{@html $_('login.recovery.explainer_delete')}</p>
          </div>
          <button class="btn btn-secondary" style="width:100%;border-color:var(--danger);color:var(--danger)"
            on:click={recover} disabled={recovering || !recoveryToken.trim()}>
            {recovering ? $_('login.recovery.disabling') : $_('login.recovery.action')}
          </button>
        </div>
      {/if}
    {:else}
      <div style="text-align:center;padding:8px 0">
        <span class="material-symbols-rounded" style="font-size:48px;color:var(--accent)">check_circle</span>
        <p style="margin-top:8px;color:var(--text-2)">{@html $_('login.recovery.done')}</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .login-page {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg);
  }
  .login-card {
    width: 100%;
    max-width: 360px;
    padding: 32px 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .login-logo {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
    text-align: center;
  }
  .logo-img {
    width: 72px;
    height: 72px;
    border-radius: 16px;
    object-fit: cover;
  }
  .login-title {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 0;
  }
  .recovery-toggle {
    background: none;
    border: none;
    color: var(--text-3);
    font-size: 13px;
    cursor: pointer;
    text-align: center;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .recovery-toggle:hover { color: var(--text-2); }
  .recovery-box {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    background: var(--surface-2);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    font-size: 13px;
    color: var(--text-2);
    line-height: 1.5;
  }
  .recovery-part { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid var(--border); }
  .recovery-heading { display: flex; align-items: center; gap: 6px; color: var(--text-1); font-size: 13px; }
  .sso-row { display: flex; flex-direction: column; gap: 8px; }
  .options-error {
    display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
    padding: 10px 12px; border-radius: 8px; font-size: 13px; color: var(--text-2);
    background: color-mix(in srgb, var(--danger) 8%, transparent);
  }
  .options-retry { height: 32px; padding: 0 14px; font-size: 13px; }
  .sso-btn { display: flex; align-items: center; gap: 10px; justify-content: center; width: 100%; }
  .sso-logo { width: 18px; height: 18px; object-fit: contain; }
  .sso-icon { font-size: 18px; }
  .sso-divider {
    display: flex; align-items: center; gap: 12px;
    color: var(--text-3); font-size: 12px;
    margin: 4px 0;
  }
  .sso-divider::before, .sso-divider::after {
    content: ''; flex: 1; height: 1px; background: var(--border);
  }
  .session-ended {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 12px 14px; background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-left: 3px solid var(--accent); border-radius: 4px;
    font-size: 13px; line-height: 1.5; color: var(--text-2);
  }
  .session-ended .material-symbols-rounded { font-size: 20px; color: var(--accent); flex-shrink: 0; }
</style>
