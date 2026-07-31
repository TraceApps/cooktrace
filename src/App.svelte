<script>
  import { onMount }   from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { portal } from './lib/portal.js';
  import Router, { location } from 'svelte-spa-router';

  import BottomNav from './components/layout/BottomNav.svelte';
  import Sidebar   from './components/layout/Sidebar.svelte';
  import UpdateBanner from './components/UpdateBanner.svelte';
  import TopTimerPill from './components/recipe/TopTimerPill.svelte';
  import { cookModeActive } from './stores/cookMode.js';
  import Toast     from './components/ui/Toast.svelte';
  import ConfirmDialogMount from './components/ui/ConfirmDialogMount.svelte';
  import { DB }    from './lib/db.js';
  import { navStyle, applyAccentColor, accentColor, applyAppearance, appearance, disableAnimations, sidebarPersistent, language, pageBanners, bannerStyle, bannerAnimation } from './stores/settings.js';
  import { locale } from 'svelte-i18n';
  import { currentUser, userMgmtActive, setupRequired, loadAuthState, handleOidcCallback } from './stores/auth.js';
  import { needsNativeSetup, isNative, getNativeMode, getServerUrl, apiUrl } from './lib/platform.js';
  import { writable } from 'svelte/store';

  // Sync state — mirrored from the real sync store (dynamically imported)
  const syncState = writable({ syncing: false, phase: '', progress: '', lastSync: null, error: null, online: true });
  $: _syncModeActive = isNative && getNativeMode() === 'server';

  // Drive svelte-i18n's active locale from the user's saved language setting.
  $: if ($language) locale.set($language);
  import NativeSetup from './routes/NativeSetup.svelte';

  let showNativeSetup = needsNativeSetup();

  // Eagerly imported (start page + the two tabs users land on most).
  import Recipes      from './routes/Recipes.svelte';
  import RecipeView   from './routes/RecipeView.svelte';
  import Pantry       from './routes/Pantry.svelte';
  import CookDiary    from './routes/CookDiary.svelte';
  import Shopping     from './routes/Shopping.svelte';
  import Login          from './routes/Login.svelte';
  import Trace      from './components/ai/Trace.svelte';

  // Lazy-loaded routes. svelte-spa-router accepts a `wrap()` async
  // component, so we defer the heavier pages (editors, Manage, Settings,
  // Wizard, public viewer) until the user navigates to them. Cuts the
  // start-page bundle by roughly 30%.
  import { wrap } from 'svelte-spa-router/wrap';
  const RecipeEditor   = wrap({ asyncComponent: () => import('./routes/RecipeEditor.svelte') });
  const PantryEditor   = wrap({ asyncComponent: () => import('./routes/PantryEditor.svelte') });
  const PantryView     = wrap({ asyncComponent: () => import('./routes/PantryView.svelte') });
  const Manage         = wrap({ asyncComponent: () => import('./routes/Manage.svelte') });
  const CookbookView   = wrap({ asyncComponent: () => import('./routes/CookbookView.svelte') });
  const PublicRecipe   = wrap({ asyncComponent: () => import('./routes/PublicRecipe.svelte') });
  const Settings       = wrap({ asyncComponent: () => import('./routes/Settings.svelte') });
  const Wizard         = wrap({ asyncComponent: () => import('./routes/Wizard.svelte') });
  const Profile        = wrap({ asyncComponent: () => import('./routes/Profile.svelte') });
  const ForgotPassword = wrap({ asyncComponent: () => import('./routes/ForgotPassword.svelte') });
  const ResetPassword  = wrap({ asyncComponent: () => import('./routes/ResetPassword.svelte') });
  const AcceptInvite   = wrap({ asyncComponent: () => import('./routes/AcceptInvite.svelte') });

  const routes = {
    '/':                   Recipes,
    '/recipes':            Recipes,
    '/recipes/edit':       RecipeEditor,
    '/recipes/edit/:id':   RecipeEditor,
    '/recipes/:id':        RecipeView,
    '/pantry':             Pantry,
    '/pantry/edit':        PantryEditor,
    '/pantry/edit/:id':    PantryEditor,
    '/pantry/:id':         PantryView,
    '/diary':              CookDiary,
    '/shopping':           Shopping,
    '/manage':             Manage,
    '/manage/:section':    Manage,
    '/cookbooks/:id':      CookbookView,
    '/r/:token':           PublicRecipe,
    '/settings':           Settings,
    '/settings/:section':  Settings,
    '/wizard':             Wizard,
    '/profile':            Profile,
    '/forgot-password':    ForgotPassword,
    '/reset-password':     ResetPassword,
    '/accept-invite':      AcceptInvite,
    '*':                   Recipes,
  };

  // Hide bottom nav + sidebar on full-screen detail/editor pages.
  // `/recipes/` (with trailing slash) catches /recipes/:id and /recipes/edit*
  // while keeping nav visible on the bare `/recipes` list.
  const NAV_HIDDEN = ['/wizard', '/profile', '/recipes/', '/pantry/edit', '/pantry/', '/cookbooks/', '/r/'];
  $: showNav       = !NAV_HIDDEN.some(p => $location.startsWith(p));

  let _viewportW = typeof window !== 'undefined' ? window.innerWidth : 1024;
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => { _viewportW = window.innerWidth; });
  }
  $: _persistentAllowed = _viewportW >= 768;

  $: _hasSidebar   = showNav && ($navStyle === 'sidebar' || $navStyle === 'both');
  $: sidebarPinned = _hasSidebar && _persistentAllowed && $sidebarPersistent;
  $: showHamburger = _hasSidebar && !sidebarPinned;

  // --page-top: just the device safe area (hamburger floats over banner)
  // --hamburger-offset: aligns h1 left edge with hamburger button left edge
  //   (used by the banner-on layout where the title sits BELOW the button)
  // --hamburger-row: extra header top-padding so title sits below hamburger
  //   (banner-on only — compact / no-banner layout drops this)
  // --hamburger-clearance: button RIGHT edge + small gap, used by the
  //   compact (banner-off) layout where the title sits BESIDE the button
  //   and needs padding-left to clear the button itself.
  // --sidebar-w: shifts content right when sidebar is persistent
  $: if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--page-top', 'var(--safe-top)');
    document.documentElement.style.setProperty(
      '--hamburger-offset',
      showHamburger ? '12px' : '0px'
    );
    // --hamburger-row only adds a vertical row of padding when the
    // banner-on layout is active (title sits BELOW the floating
    // hamburger). In banner-off / compact mode the title sits NEXT to
    // the button so no extra row is needed.
    // All three banner modes share the compact-header geometry
    // (illustrated SVG banners were retired). --hamburger-row stays 0.
    document.documentElement.style.setProperty('--hamburger-row', '0px');
    // 12px (left margin) + 40px (button width) + 12px (gap before title)
    document.documentElement.style.setProperty(
      '--hamburger-clearance',
      showHamburger ? '64px' : '0px'
    );
    document.documentElement.style.setProperty(
      '--sidebar-w',
      sidebarPinned ? '280px' : '0px'
    );
  }

  let sidebarOpen = false;

  let _prevPinned = false;
  function _syncSidebarToPin(pinned) {
    if (pinned) {
      sidebarOpen = true;
    } else if (_prevPinned) {
      sidebarOpen = false;
    }
    _prevPinned = pinned;
  }
  $: _syncSidebarToPin(sidebarPinned);

  $: if (!_hasSidebar) sidebarOpen = false;

  $: applyAccentColor($accentColor);
  $: applyAppearance($appearance);

  $: if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('no-animations', !!$disableAnimations);
    // Apply exactly one `banner-animation-<style>` class on documentElement
    // so the CSS animation rules in base.css can target a single decorative
    // style without conflicting selectors. Only active when bannerStyle is
    // 'animated'; gradient + off get no animation class regardless.
    for (const cls of ['banner-animation-shimmer','banner-animation-drift','banner-animation-pulse','banner-animation-aurora']) {
      document.documentElement.classList.remove(cls);
    }
    if ($bannerStyle === 'animated') {
      document.documentElement.classList.add(`banner-animation-${$bannerAnimation || 'shimmer'}`);
    }
  }

  onMount(async () => {
    // Local-mode scheduled backup tick — JS-side scheduler that fires
    // exportLocalZip() when due. No-ops in PWA / server modes. See
    // src/lib/local-backup-scheduler.js for design notes.
    if (isNative && getNativeMode() === 'local') {
      import('./lib/local-backup-scheduler.js').then(({ startLocalBackupScheduler }) => {
        startLocalBackupScheduler();
      }).catch(e => console.warn('[local-backup] scheduler start failed:', e?.message));
    }

    if (isNative) {
      // Update-notification tap listener: registered at boot so a
      // shade-notification tap that cold-starts the app still routes
      // to Settings for the install action.
      import('./lib/notifications.js').then(({ registerUpdateTapListener }) => {
        registerUpdateTapListener(() => {
          import('svelte-spa-router').then(({ push }) => push('/settings'));
        });
      }).catch(() => { /* ignore */ });

      // Clean stale APKs from Directory.Data/updates/ on boot.
      import('./lib/updates.js').then(({ cleanUpdateCache }) => {
        cleanUpdateCache();
      }).catch(() => { /* ignore */ });

      import('@capacitor/app').then(({ App }) => {
        let lastBack = 0;
        App.addListener('backButton', ({ canGoBack }) => {
          if (canGoBack) {
            window.history.back();
          } else {
            const now = Date.now();
            if (now - lastBack < 2000) {
              App.exitApp();
            } else {
              lastBack = now;
              import('./stores/toast.js').then(({ showSuccess }) => {
                showSuccess('Tap again to exit');
              });
            }
          }
        });
        // Deep link callbacks: cooktrace://oidc-callback?token=…
        App.addListener('appUrlOpen', async ({ url }) => {
          console.log('[app] deep link received:', url);
          try {
            const u = new URL(url);
            const params = u.searchParams;
            const host = (u.hostname || u.host || '').toLowerCase();
            if (host === 'oidc-callback') {
              const errMsg = params.get('error');
              const linked = params.get('linked');
              const token = params.get('token');
              const idTokenHint = params.get('id_token_hint');
              const providerId  = params.get('provider_id');
              if (errMsg) {
                import('./stores/toast.js').then(({ showError }) => showError(decodeURIComponent(errMsg)));
              } else if (linked) {
                import('./stores/toast.js').then(({ showSuccess }) => showSuccess('Linked'));
                await loadAuthState();
              } else if (token) {
                const { setAuthToken } = await import('./lib/platform.js');
                setAuthToken(token);
                // Stash the OIDC session hint so logout() can ask the IdP
                // to end the session via RP-initiated logout. PWA stores
                // this in an httpOnly cookie at the same point; native
                // can't reach that jar so we keep the equivalent here.
                if (idTokenHint && providerId) {
                  try {
                    localStorage.setItem('ct:oidc_logout_hint', JSON.stringify({
                      providerId,
                      idTokenHint,
                    }));
                  } catch {}
                }
                import('./stores/toast.js').then(({ showSuccess }) => showSuccess('Signed in'));
                await loadAuthState();
                // Re-evaluate the NativeSetup gate. Without this the user
                // completes OIDC from NativeSetup, gets a valid token, and
                // stays visually stuck on the setup screen — because the
                // showNativeSetup flag was captured at App.svelte mount and
                // never re-checked. needsNativeSetup() reads the current
                // nativeMode + serverUrl which NativeSetup persists before
                // opening the OIDC browser, so this correctly flips to
                // false and reveals the router. Cross-app fix mirrored
                // from NutriTrace #110.
                showNativeSetup = needsNativeSetup();
                window.location.hash = '#/';
              }
            }
          } catch (e) {
            console.warn('[app] deep link parse error:', e);
          }
        });
      });
    }

    await loadAuthState();
    await handleOidcCallback();

    // Env-lock state for AI / SMTP / OIDC. Fetched globally so the Trace
    // FAB knows about env-set AI_ENABLED without waiting for Settings to
    // load. Mirrors NutriTrace #36.
    if (!isNative || getServerUrl()) {
      fetch(apiUrl('/api/app-config/env-locks'), { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(async d => {
          if (!d) return;
          const { envLocks } = await import('./stores/settings.js');
          envLocks.set(d);
        })
        .catch(() => {});
    }

    // Wizard gate. The web "no user + no user management" case is fully
    // covered by $setupRequired (the server distinguishes a fresh install
    // from intentional single-user mode via the single_user_mode flag in
    // app_config; see server/routes/auth.js GET /status). Native local
    // mode shows the wizard for goals/units/profile setup on first launch.
    // Same fix as NutriTrace #34.
    const _isNativeServer = isNative && getNativeMode() === 'server';
    const _isNativeLocal = isNative && getNativeMode() === 'local';
    if (!isNative && $setupRequired) {
      window.location.hash = '#/wizard';
    } else if (_isNativeLocal && !DB.getSetting('setupComplete', false)) {
      window.location.hash = '#/wizard';
    }

    // Sync engine — native server-connected mode only.
    if (isNative && getNativeMode() === 'server') {
      import('./lib/sync.js').then((mod) => {
        mod.syncState.subscribe(v => syncState.set(v));
        mod.startNetworkMonitor();
        mod.fullSync();
        setInterval(() => mod.fullSync(true), 30000);
        import('@capacitor/app').then(({ App }) => {
          App.addListener('resume', () => mod.fullSync());
        });
      });
    }

    // Auto-detect timezone
    const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detectedTz && !DB.getSetting('timezone', '')) {
      DB.setSetting('timezone', detectedTz);
      import('./stores/settings.js').then(({ scheduleSave }) => scheduleSave('timezone', detectedTz));
    }

    // PWA settings refresh
    if (!isNative && $userMgmtActive && $currentUser) {
      const _refreshSettings = () => import('./stores/settings.js').then(({ loadServerSettings }) => loadServerSettings());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') _refreshSettings();
      });
      setInterval(_refreshSettings, 30000);
    }
  });

  const AUTH_BYPASS = ['/forgot-password', '/reset-password', '/accept-invite'];
  $: needsLogin = $userMgmtActive && !$currentUser && !AUTH_BYPASS.includes($location);

  let _wasNeedsLogin = needsLogin;
  $: {
    if (_wasNeedsLogin && !needsLogin && $currentUser) {
      _wasNeedsLogin = false;
      import('./stores/settings.js').then(({ loadServerSettings }) => loadServerSettings()).catch(() => {});
    } else if (needsLogin) {
      _wasNeedsLogin = true;
    }
  }
</script>

{#if showNativeSetup}
  <NativeSetup />
  <Toast />

{:else if needsLogin}
  <Login />
{:else}

<Sidebar bind:open={sidebarOpen} persistent={sidebarPinned} on:close={() => { if (!sidebarPinned) sidebarOpen = false; }} />

<!-- Cook timer pill — global. Floats fixed in the viewport so it
     follows the user across every page, draggable to any position,
     and renders nothing when no timers are running. -->
<TopTimerPill />

<!-- In-app update banner (native only). Renders only if the OS-level
     notification permission is denied — grants suppress the banner and
     route through a shade notification instead. -->
{#if !needsLogin}<UpdateBanner />{/if}

{#if showHamburger && $currentUser}
  <header class="app-topbar">
    <button
      class="hamburger"
      on:click={() => sidebarOpen = !sidebarOpen}
      aria-label="Open menu"
    >
      <span class="material-symbols-rounded">menu</span>
      {#if _syncModeActive && !$syncState.online}
        <span class="conn-badge conn-offline">
          <span class="material-symbols-rounded" style="font-size:10px">cloud_off</span>
        </span>
      {/if}
    </button>
    <div class="topbar-spacer"></div>
  </header>
{/if}

{#if _syncModeActive && !needsLogin && $syncState.error}
  <div class="sync-bar sync-bar-error"
    use:portal transition:slide={{ duration: 200 }}>
    <span class="material-symbols-rounded sync-bar-icon">error</span>
    <span class="sync-bar-msg">Sync error: {$syncState.error}</span>
  </div>
{/if}

{#key $location}
  <!-- Uniform soft route transition: a subtle 8px rise + fade-in over
       200ms when entering a new route, paired with a quick fade-out on
       the old one. Gives every list → detail → editor hop a touch of
       polish without per-route choreography. Respects the user's
       reduce-motion / disable-animations preference. -->
  <div
    class="page-transition"
    class:has-topbar={showNav}
    in:fly={{ y: 8, duration: $disableAnimations ? 0 : 200, easing: cubicOut }}
    out:fade={{ duration: $disableAnimations ? 0 : 120 }}
  >
    <Router {routes} />
  </div>
{/key}

{#if showNav && ($navStyle === 'bottom' || $navStyle === 'both')}
  <BottomNav />
{/if}

<Toast />
<Trace />

{/if}

{#if needsLogin}<Toast />{/if}
<ConfirmDialogMount />

<style>
  :global(body) { overflow-x: hidden; }

  :global(.no-animations *) {
    transition-duration: 0ms !important;
    animation-duration: 0ms !important;
  }

  .app-topbar {
    position: fixed;
    top: var(--safe-top);
    left: 0; right: 0;
    height: 0;
    z-index: 40;
    pointer-events: none;
  }

  .hamburger {
    position: fixed;
    top: calc(var(--safe-top) + 10px);
    left: 12px;
    width: 40px; height: 40px;
    border-radius: var(--radius-md);
    background: rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(10px) saturate(160%);
    -webkit-backdrop-filter: blur(10px) saturate(160%);
    border: 1px solid rgba(255, 255, 255, 0.18);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    z-index: 41;
    pointer-events: all;
    color: #ffffff;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    transition: background var(--dur-fast), transform var(--dur-fast) var(--ease-spring);
  }
  .hamburger:hover  { background: rgba(0, 0, 0, 0.5); }
  .hamburger:active { transform: scale(0.92); }

  .topbar-spacer { flex: 1; }

  :global(.page-transition) {
    position: fixed;
    top: 0;
    left: var(--sidebar-w, 0px);
    right: 0;
    bottom: 0;
    overflow-y: auto;
    transition: left 0.25s ease;
  }
  :global(.bottom-nav) {
    left: var(--sidebar-w, 0px) !important;
    transition: left 0.25s ease !important;
  }

  .conn-badge {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px solid var(--surface-1);
    transition: background 0.3s;
  }
  .conn-offline {
    background: var(--error, #ef4444);
    color: #fff;
  }

  .sync-bar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 16px;
    font-size: 12px;
    font-weight: 500;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--bg));
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 15%, transparent);
    transition: background 0.3s, color 0.3s;
  }
  .sync-bar-error {
    color: var(--error, #f87171);
    background: color-mix(in srgb, var(--error, #f87171) 8%, transparent);
    border-color: color-mix(in srgb, var(--error, #f87171) 15%, transparent);
  }
  .sync-bar-icon { font-size: 16px; }
  /* Allow the error string to wrap so a long failure (HTTP body, stack
     frame) doesn't get clipped on narrow phones. */
  .sync-bar-msg { flex: 1; min-width: 0; white-space: normal; word-break: break-word; }
</style>
