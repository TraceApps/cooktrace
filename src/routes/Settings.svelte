<script>
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { AVAILABLE_LOCALES } from '../i18n/index.js';
  import SettingsAuth   from '../components/settings/SettingsAuth.svelte';
  import SettingsBackup from '../components/settings/SettingsBackup.svelte';
  import SettingsServerConnection from '../components/settings/SettingsServerConnection.svelte';
  import SettingsImport from '../components/settings/SettingsImport.svelte';
  import SettingsTrace  from '../components/settings/SettingsTrace.svelte';
  import SettingsNotifications from '../components/settings/SettingsNotifications.svelte';
  import SettingsNutrition from '../components/settings/SettingsNutrition.svelte';
  import SettingsEmail from '../components/settings/SettingsEmail.svelte';
  import SettingsFederation from '../components/settings/SettingsFederation.svelte';
  import SettingsImportFromNT from '../components/settings/SettingsImportFromNT.svelte';
  import SettingsKitchens from '../components/settings/SettingsKitchens.svelte';
  import SettingsUserManagement from '../components/settings/SettingsUserManagement.svelte';
  import Sheet from '../components/ui/Sheet.svelte';
  import Toggle from '../components/settings/Toggle.svelte';
  import { APP_VERSION } from '../lib/version.js';
  import {
    isVerboseLogging, setVerboseLogging,
    getLogBufferText, clearLogBuffer,
    getLogFileUri, getLastCrashFileUri,
    hasCrashReport, clearCrashReport,
  } from '../lib/log-capture.js';
  import { showError } from '../stores/toast.js';
  import { DB } from '../lib/db.js';
  import { applyAppearance, applyAccentColor, scheduleSave } from '../stores/settings.js';
  import {
    appearance, accentColor, navStyle, sidebarPersistent, disableAnimations,
    pageBanners, bannerStyle, bannerAnimation, measurementSystem, defaultServings, energyUnit,
    dateFormat, timeFormat, language, startPage,
    offEnabled, offSearchLanguage, offSearchCountry, offUploadCountry,
    offUsername, offPassword, barcodeBeep, barcodeFlashlight,
    usdaEnabled, usdaApiKey,
    urlImportEngine, urlImportFallback, autoCreatePantryFromRecipes,
    shoppingGroupBy, shoppingCheckedBehavior,
    aiEnabled, aiKeyVerified,
  } from '../stores/settings.js';
  $: enhancedAvailable = !isNative || !!getServerUrl(); // recipe-scrapers needs the server
  $: smartAvailable    = $aiEnabled && $aiKeyVerified;

  const OFF_LANGUAGE_OPTS = [
    ['en','English'],['fr','French'],['de','German'],['es','Spanish'],['it','Italian'],
    ['pt','Portuguese'],['nl','Dutch'],['pl','Polish'],['ru','Russian'],['ja','Japanese'],
    ['zh','Chinese'],['ar','Arabic'],['ko','Korean'],
  ];
  const OFF_COUNTRY_OPTS = ['World','United States','United Kingdom','Australia','Canada',
    'France','Germany','Spain','Italy','Mexico','Brazil','Japan','China','India'];
  let offShowPass = false;
  import { isNative, getServerUrl, resolveAssetUrl } from '../lib/platform.js';
  import { currentUser, userMgmtActive } from '../stores/auth.js';

  function set(key, value) { DB.setSetting(key, value); scheduleSave(key, value); }

  // ── Diagnostics: in-app log capture ────────────────────────────────────
  // Mirrors NutriTrace's Diagnostics section. Verbose mode flips a flag in
  // localStorage that the logger reads; the buffer + crash files come from
  // log-capture.js, which is imported first in main.js so console.* and
  // window error events are intercepted before any other module runs.
  let _logsSheet = false;
  let _logsText = '';
  let _logsCopied = false;
  let _verboseLogging = isVerboseLogging();
  let _hasCrashReport = false;

  function _openLogsSheet() {
    _logsText = getLogBufferText() || '(no log lines captured yet)';
    _logsCopied = false;
    _hasCrashReport = hasCrashReport();
    _logsSheet = true;
  }
  async function _copyLogs() {
    try {
      await navigator.clipboard.writeText(_logsText);
      _logsCopied = true;
      setTimeout(() => _logsCopied = false, 2000);
    } catch {
      showError('Copy failed — select the text manually');
    }
  }
  async function _shareLogs() {
    try {
      if (isNative) {
        const { Share } = await import('@capacitor/share');
        await Share.share({
          title: 'CookTrace diagnostic logs',
          text: _logsText,
          dialogTitle: 'Share CookTrace logs',
        });
      } else if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: 'CookTrace diagnostic logs', text: _logsText });
      } else {
        await _copyLogs();
      }
    } catch {
      // User cancelled — silent.
    }
  }
  // Share a file from Directory.Data via the Android share intent. Direct
  // file:// URIs into private app data fail silently on Android target SDK
  // 24+: the receiving app gets the intent but can't read the URI, so it
  // falls back to the share intent's text field and saves THAT as the file
  // contents (the title-only file bug). Fix: copy the source file into
  // Directory.Cache first; Capacitor's auto-generated FileProvider XML
  // whitelists the cache directory and translates the file URI into a
  // content:// URI the receiving app can actually read. Ported from
  // NutriTrace #60 fix (commit a69c661).
  async function _shareFileViaCache({ srcPath, cacheBasename, title, text, dialogTitle }) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const src = await Filesystem.readFile({ path: srcPath, directory: Directory.Data, encoding: Encoding.UTF8 });
    const cachePath = `${cacheBasename}-${Date.now()}.txt`;
    await Filesystem.writeFile({ path: cachePath, data: src.data, directory: Directory.Cache, encoding: Encoding.UTF8 });
    const { uri } = await Filesystem.getUri({ path: cachePath, directory: Directory.Cache });
    const { Share } = await import('@capacitor/share');
    await Share.share({ title, text, url: uri, dialogTitle });
  }
  async function _shareLogFile() {
    try {
      const f = await getLogFileUri();
      if (!f) { showError('No log file yet — turn on Diagnostic Mode and reproduce the issue first'); return; }
      await _shareFileViaCache({
        srcPath: f.path,
        cacheBasename: 'cooktrace-log',
        title: 'CookTrace diagnostic logs',
        text: 'CookTrace log file',
        dialogTitle: 'Share CookTrace log file',
      });
    } catch { /* user cancelled */ }
  }
  async function _shareCrashReport() {
    try {
      const f = await getLastCrashFileUri();
      if (!f) { _hasCrashReport = false; return; }
      await _shareFileViaCache({
        srcPath: f.path,
        cacheBasename: 'cooktrace-crash',
        title: 'CookTrace crash report',
        text: 'CookTrace crash report',
        dialogTitle: 'Share CookTrace crash report',
      });
    } catch { /* user cancelled */ }
  }
  function _clearCrashReport() {
    clearCrashReport();
    _hasCrashReport = false;
  }
  function _clearLogs() {
    clearLogBuffer();
    _logsText = '(cleared)';
  }
  function _toggleVerbose(on) {
    _verboseLogging = on;
    setVerboseLogging(on);
  }

  let appConfig = null;

  // Track viewport width reactively so the persistent-sidebar toggle
  // hides on phones (and reappears if the user rotates a tablet to
  // landscape, etc.). Threshold matches App.svelte's
  // _persistentAllowed (768px = standard tablet).
  let _viewportW = typeof window !== 'undefined' ? window.innerWidth : 1024;
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => { _viewportW = window.innerWidth; });
  }
  $: _persistentAllowed = _viewportW >= 768;
  let envLocks = { ai: false, smtp: false };

  onMount(async () => {
    try {
      const res = await fetch('/api/app-config', { credentials: 'include' });
      if (res.ok) {
        appConfig = await res.json();
        envLocks = appConfig?.envLocks || envLocks;
      }
    } catch {}
  });

  // True when running as a standalone phone app (no remote server connected).
  $: isNativeLocal = isNative && !getServerUrl();

  // ── Collapsible section state ──────────────────────────────────────────
  let openSections = {
    appearance:    false,
    regional:      false,
    cooking:       false,
    nutrition:     false,
    ai:            false,
    federation:    false,
    foodsources:   false,
    notifications: false,
    email:         false,
    backup:        false,
    import:        false,
    kitchens:      false,
    users:         false,
    auth:          false,
    serverconn:    false,
    diagnostics:   false,
    about:         false,
  };
  function toggleSection(key) {
    openSections = { ...openSections, [key]: !openSections[key] };
  }

  // ── Settings search ────────────────────────────────────────────────────
  let settingsSearch = '';
  $: settingsQuery = settingsSearch.toLowerCase().trim();

  const SECTION_KEYWORDS = {
    profile:       ['profile','my profile','account','name','avatar','log out','logout','sign out','password','change password'],
    appearance:    ['appearance','theme','dark','light','accent','color','navigation','sidebar','persistent','start page','animations','reduce motion','banner','page banner'],
    regional:      ['regional','language','translation','locale','date','time','12h','24h','units','energy','kcal','kj','calories','kilojoules','imperial','metric','measurement system'],
    cooking:       ['cooking','servings','default servings','yield','recipe','recipes','url import','url import engine','scraper','recipe scrapers','recipe-scrapers','enhanced','smart','json-ld','schema.org','parser','auto add ingredients','auto-create pantry','pantry catalog','shopping','shopping list','aisle','aisles','group by','grouping','checked','hide checked','sort','reorder'],
    nutrition:     ['nutrition','nutrients','nutriments','vitamins','minerals','visible nutriments','fda'],
    federation:    ['federation','nutritrace','nt','linked','share','token','instance','foods','pull foods','import foods','sync foods'],
    foodsources:   ['food sources','open food facts','off','usda','fooddata central','api key','barcode','scanner','beep','flashlight','search','language','country','contribute'],
    ai:            ['ai','trace','assistant','provider','model','api key','chat','claude','openai','gemini','base url','artificial intelligence','smart log','smartlog','quick log','voice','dictate','hold to record','mic'],
    notifications: ['notifications','reminders','cook day','thaw','alerts','push','apprise','gotify','ntfy','expiration','expiry','expires','expiring','pantry expiry','digest','weekly summary','shopping nudge'],
    email:         ['email','smtp','mail','password reset','invite','from address','tls','outgoing'],
    backup:        ['backup','export','import','restore','json','full backup','reset','danger zone'],
    import:        ['import','mealie','tandoor','paprika','recipe import','migration','migrate','transfer','bulk','zip','from another app'],
    kitchens:      ['kitchens','kitchen','household','household members','share','sharing','family','roommates','crew','group','members'],
    users:         ['users','user management','accounts','login','admin','register','invite'],
    auth:          ['authentication','auth','sso','single sign-on','single sign on','oidc','openid','authentik','keycloak','authelia','password login'],
    serverconn:    ['server','connection','sync','connect','disconnect','local mode','offline','standalone','android','native','url','login'],
    diagnostics:   ['diagnostics','logs','verbose','console','export','bug','report','troubleshoot','crash'],
    about:         ['about','version','cooktrace','license','source','github','donate','support'],
  };

  function sectionVisible(query, key) {
    if (!query) return true;
    return (SECTION_KEYWORDS[key] || []).some(kw => kw.includes(query));
  }
  function sectionOpen(sections, query, key) {
    return sections[key] || (!!query && sectionVisible(query, key));
  }

  // ── Theme / accent options (mirror NT exactly) ─────────────────────────
  const APPEARANCE_OPTS = [
    { value: 'system', label: 'System Default' },
    { value: 'dark',   label: 'Dark'           },
    { value: 'light',  label: 'Light'          },
  ];
  const NAV_STYLE_OPTS = [
    { value: 'bottom',  label: 'Bottom Tab Bar' },
    { value: 'sidebar', label: 'Side Panel'     },
    { value: 'both',    label: 'Both'           },
  ];
  const START_PAGE_OPTS = [
    { value: '/',         label: 'Recipes'  },
    { value: '/pantry',   label: 'Pantry'   },
    { value: '/diary',    label: 'Diary'    },
    { value: '/shopping', label: 'Shopping' },
    { value: '/settings', label: 'Settings' },
  ];
  // Same 12 colors NT ships, paired light/dark variants.
  const ACCENT_COLORS = [
    { value: 'mint',   label: 'Mint',   dark: '#4FFFB0', light: '#00C47A' },
    { value: 'blue',   label: 'Blue',   dark: '#4FC3F7', light: '#0277BD' },
    { value: 'red',    label: 'Red',    dark: '#FF7070', light: '#D93025' },
    { value: 'purple', label: 'Purple', dark: '#CE93D8', light: '#8E24AA' },
    { value: 'orange', label: 'Orange', dark: '#FFB547', light: '#E65100' },
    { value: 'teal',   label: 'Teal',   dark: '#4DD0E1', light: '#00838F' },
    { value: 'pink',   label: 'Pink',   dark: '#F48FB1', light: '#C2185B' },
    { value: 'yellow', label: 'Yellow', dark: '#FFF176', light: '#F9A825' },
    { value: 'indigo', label: 'Indigo', dark: '#9FA8DA', light: '#3949AB' },
    { value: 'lime',   label: 'Lime',   dark: '#C5E1A5', light: '#558B2F' },
    { value: 'rose',   label: 'Rose',   dark: '#FF80AB', light: '#E91E63' },
    { value: 'cyan',   label: 'Cyan',   dark: '#80DEEA', light: '#0097A7' },
  ];

  // Determine dark vs light to pick the right swatch shade.
  $: isDark = $appearance === 'dark' || ($appearance === 'system' && (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches));

  // ── Custom color picker (HSL + RGB + Hex) — mirrors NT ─────────────────
  let customColorHex = /^#[0-9a-fA-F]{6}$/.test($accentColor) ? $accentColor : '#4FFFB0';
  let customHexInput = customColorHex;
  let showColorSheet = false;
  let cpHue = 160, cpSat = 100, cpLgt = 50;
  let cpR = 79, cpG = 255, cpB = 176;

  function _hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }
  function _hexToHsl(hex) {
    const r = parseInt(hex.slice(1,3),16)/255;
    const g = parseInt(hex.slice(3,5),16)/255;
    const b = parseInt(hex.slice(5,7),16)/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    let h = 0, s = 0, l = (max+min)/2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d/(2-max-min) : d/(max+min);
      switch(max) {
        case r: h = ((g-b)/d + (g<b?6:0))/6; break;
        case g: h = ((b-r)/d + 2)/6; break;
        case b: h = ((r-g)/d + 4)/6; break;
      }
    }
    return [Math.round(h*360), Math.round(s*100), Math.round(l*100)];
  }
  function _syncRgbFromHex(hex) {
    cpR = parseInt(hex.slice(1,3),16);
    cpG = parseInt(hex.slice(3,5),16);
    cpB = parseInt(hex.slice(5,7),16);
  }
  function openColorSheet() {
    const cur = /^#[0-9a-fA-F]{6}$/.test($accentColor) ? $accentColor : '#4FFFB0';
    customColorHex = cur;
    customHexInput = cur;
    [cpHue, cpSat, cpLgt] = _hexToHsl(cur);
    _syncRgbFromHex(cur);
    showColorSheet = true;
  }
  function cpUpdateFromSliders() {
    customColorHex = _hslToHex(cpHue, cpSat, cpLgt);
    customHexInput = customColorHex;
    _syncRgbFromHex(customColorHex);
    applyAccentColor(customColorHex);
  }
  function cpUpdateFromHex() {
    if (/^#[0-9a-fA-F]{6}$/.test(customHexInput)) {
      customColorHex = customHexInput;
      [cpHue, cpSat, cpLgt] = _hexToHsl(customHexInput);
      _syncRgbFromHex(customHexInput);
      applyAccentColor(customHexInput);
    }
  }
  function cpUpdateFromRgb() {
    const r = Math.min(255, Math.max(0, cpR || 0));
    const g = Math.min(255, Math.max(0, cpG || 0));
    const b = Math.min(255, Math.max(0, cpB || 0));
    cpR = r; cpG = g; cpB = b;
    const hex = '#' + r.toString(16).padStart(2,'0') + g.toString(16).padStart(2,'0') + b.toString(16).padStart(2,'0');
    customColorHex = hex;
    customHexInput = hex;
    [cpHue, cpSat, cpLgt] = _hexToHsl(hex);
    applyAccentColor(hex);
  }
  function applyCustomColor() {
    if (/^#[0-9a-fA-F]{6}$/.test(customHexInput)) applyAccentColor(customHexInput);
    showColorSheet = false;
  }

  // Show admin group when there's a real server with users to manage.
  // - native-local standalone: hidden (no server)
  // - single-user mode: shown to the synthetic local admin so they can flip
  //   on user management
  // - multi-user mode: shown only to admins
  $: showAdminGroup = !isNativeLocal && (!$userMgmtActive || $currentUser?.role === 'admin');
</script>

<div class="page-shell">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('routes.settings.title')}</h1>
  </header>

  <div class="settings-search-bar">
    <span class="material-symbols-rounded settings-search-icon">search</span>
    <input class="settings-search-input" type="search" placeholder="Search settings…"
      bind:value={settingsSearch} />
    {#if settingsSearch}
      <button class="settings-search-clear btn-icon" on:click={() => settingsSearch = ''} title="Clear search">
        <span class="material-symbols-rounded" style="font-size:18px">close</span>
      </button>
    {/if}
  </div>

  <div class="page-content settings-content">

    <!-- ── Profile hero — identity card at the top of Settings ─────────── -->
    {#if sectionVisible(settingsQuery, 'profile')}
    {@const _u = $currentUser || {}}
    {@const _full = (_u.full_name || '').trim()}
    {@const _displayName = (_full && _full !== 'Local User' ? _full : '') || (_u.username || '').trim() || 'My Profile'}
    {@const _hasName = _displayName !== 'My Profile'}
    {@const _initial = (_displayName[0] || '?').toUpperCase()}
    <button class="profile-hero" on:click={() => push('/profile')}>
      <div class="profile-hero-avatar">
        {#if _u.avatar_url}
          <img src={resolveAssetUrl(_u.avatar_url)} alt="" />
        {:else if _hasName}
          <span class="profile-hero-initial">{_initial}</span>
        {:else}
          <span class="material-symbols-rounded">person</span>
        {/if}
      </div>
      <div class="profile-hero-info">
        <span class="profile-hero-name">{_displayName}</span>
        {#if _hasName && _u.role === 'admin' && $userMgmtActive}
          <span class="profile-hero-role">Admin</span>
        {:else if !_hasName}
          <span class="profile-hero-sub">Tap to set up your profile</span>
        {/if}
      </div>
      <span class="material-symbols-rounded profile-hero-chev">chevron_right</span>
    </button>
    {/if}

    <p class="settings-group-label">Display</p>

    <!-- ── Appearance ──────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'appearance')} on:click={() => toggleSection('appearance')}>
      <span class="material-symbols-rounded si">contrast</span>
      <span>{$_('settings.appearance.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.appearance}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'appearance') && sectionVisible(settingsQuery, 'appearance')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row">
            <span class="setting-label">Theme</span>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" value={$appearance} on:change={e => applyAppearance(e.target.value)}>
                {#each APPEARANCE_OPTS as o}<option value={o.value}>{o.label}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:10px">
            <span class="setting-label">Accent Color</span>
            <div class="accent-swatches">
              {#each ACCENT_COLORS as c}
                <button
                  class="accent-swatch"
                  class:active={$accentColor === c.value}
                  style="background:{isDark ? c.dark : c.light}"
                  title={c.label}
                  on:click={() => applyAccentColor(c.value)}
                >
                  {#if $accentColor === c.value}
                    <span class="material-symbols-rounded" style="font-size:16px;color:rgba(255,255,255,0.95);text-shadow:0 1px 3px rgba(0,0,0,0.4)">check</span>
                  {/if}
                </button>
              {/each}
              <button class="accent-swatch accent-swatch-custom" class:active={/^#[0-9a-fA-F]{6}$/.test($accentColor)}
                title="Custom color" style={/^#[0-9a-fA-F]{6}$/.test($accentColor) ? "background:"+$accentColor : ""}
                on:click={openColorSheet}>
                <span class="material-symbols-rounded" style="font-size:16px;color:rgba(255,255,255,0.9);text-shadow:0 0 3px rgba(0,0,0,0.5)">colorize</span>
              </button>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Navigation Style</span>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" value={$navStyle} on:change={e => navStyle.set(e.target.value)}>
                {#each NAV_STYLE_OPTS as o}<option value={o.value}>{o.label}</option>{/each}
              </select>
            </div>
          </div>
          {#if ($navStyle === 'sidebar' || $navStyle === 'both') && _persistentAllowed}
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">Persistent Sidebar</span>
                <div class="setting-desc">Sidebar stays open and shifts page content instead of overlaying it.</div>
              </div>
              <input type="checkbox" class="toggle-cb" checked={$sidebarPersistent} on:change={e => sidebarPersistent.set(e.target.checked)} />
            </div>
          {/if}
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Start Page</span>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" value={$startPage} on:change={e => startPage.set(e.target.value)}>
                {#each START_PAGE_OPTS as o}<option value={o.value}>{o.label}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Reduce Motion</span>
            <input type="checkbox" class="toggle-cb" checked={$disableAnimations} on:change={e => disableAnimations.set(e.target.checked)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Page Banners</span>
              <div class="setting-desc">Header style at the top of every page. Animated is a compact accent-gradient bar with a chosen motion style; Gradient is the same bar, static; Off is a plain glass header.</div>
            </div>
            <div class="select-wrap" style="width:130px">
              <select class="select sel-sm" value={$bannerStyle} on:change={e => bannerStyle.set(e.currentTarget.value)}>
                <option value="animated">Animated</option>
                <option value="gradient">Gradient</option>
                <option value="off">Off</option>
              </select>
            </div>
          </div>
          {#if $bannerStyle === 'animated'}
            <div class="setting-row">
              <div>
                <span class="setting-label">Animation Style</span>
                <div class="setting-desc">Shimmer is a soft white sweep, Drift is a slow hue rotation, Pulse is a gentle breathing, Aurora is a soft accent-tinted cloud-of-light. All honour Reduce Motion.</div>
              </div>
              <div class="select-wrap" style="width:130px">
                <select class="select sel-sm" value={$bannerAnimation} on:change={e => bannerAnimation.set(e.currentTarget.value)}>
                  <option value="shimmer">Shimmer</option>
                  <option value="drift">Drift</option>
                  <option value="pulse">Pulse</option>
                  <option value="aurora">Aurora</option>
                </select>
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- ── Regional & Units ─────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'regional')} on:click={() => toggleSection('regional')}>
      <span class="material-symbols-rounded si">language</span>
      <span>{$_('settings.regional.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.regional}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'regional') && sectionVisible(settingsQuery, 'regional')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row">
            <div>
              <span class="setting-label">Language</span>
              <div class="setting-desc">UI language. A translation may lag one or two releases behind English; missing strings fall back to English.</div>
            </div>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" value={$language} on:change={e => language.set(e.target.value)}>
                {#each AVAILABLE_LOCALES as loc}
                  <option value={loc.code}>{loc.label}</option>
                {/each}
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Date Format</span>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" value={$dateFormat} on:change={e => dateFormat.set(e.target.value)}>
                <option value="ISO">YYYY-MM-DD</option>
                <option value="US">MM/DD/YYYY</option>
                <option value="EU">DD/MM/YYYY</option>
                <option value="natural">D MMM YYYY</option>
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <span class="setting-label">Time Format</span>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" value={$timeFormat} on:change={e => timeFormat.set(e.target.value)}>
                <option value="12h">12-hour (AM/PM)</option>
                <option value="24h">24-hour</option>
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Measurement System</span>
              <div class="setting-desc">Imperial uses cups, oz, lb, °F. Metric uses ml, g, kg, °C.</div>
            </div>
            <div class="select-wrap" style="width:130px">
              <select class="select sel-sm" value={$measurementSystem} on:change={e => measurementSystem.set(e.target.value)}>
                <option value="imperial">Imperial</option>
                <option value="metric">Metric</option>
              </select>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Energy</span>
              <div class="setting-desc">Most countries (US / UK / EU / Canada) use kilocalories; Australia and New Zealand use kilojoules. Independent from your measurement-system choice.</div>
            </div>
            <div class="select-wrap" style="width:160px">
              <select class="select sel-sm" value={$energyUnit} on:change={e => energyUnit.set(e.target.value)}>
                <option value="kcal">Calories (kcal)</option>
                <option value="kJ">Kilojoules (kJ)</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- ── Cooking ─────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'cooking')} on:click={() => toggleSection('cooking')}>
      <span class="material-symbols-rounded si">soup_kitchen</span>
      <span>{$_('settings.cooking.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.cooking}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'cooking') && sectionVisible(settingsQuery, 'cooking')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row">
            <div>
              <span class="setting-label">Default Servings</span>
              <div class="setting-desc">Used when a new recipe doesn't specify how many it makes.</div>
            </div>
            <input type="number" min="1" max="20" class="input num" value={$defaultServings}
              on:change={(e) => defaultServings.set(parseInt(e.target.value, 10) || 2)} />
          </div>

          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Auto-Add Ingredients to Pantry</span>
              <div class="setting-desc">When saving a recipe, automatically create Pantry rows for ingredient names that aren't linked yet. Off by default; turn on if you want your Pantry catalog to grow as you add or edit recipes. Manual links via the Pantry Link picker always work regardless.</div>
            </div>
            <input type="checkbox" class="toggle-cb" checked={$autoCreatePantryFromRecipes}
              on:change={e => autoCreatePantryFromRecipes.set(e.target.checked)} />
          </div>

          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">URL Import Engine</span>
              <div class="setting-desc">
                <strong>Standard</strong> reads the page's schema.org/Recipe data. Free and fast; works on most major recipe sites.
                <strong>Enhanced</strong> runs recipe-scrapers, which has site-specific extractors for ~300 popular sites and falls back to schema.org on everything else.
                <strong>Smart</strong> hands the page to your Trace AI. Slower and uses your AI quota, but recovers recipes from sites that block scrapers or hide their content in non-standard markup.
              </div>
            </div>
            <div class="select-wrap" style="width:170px">
              <select class="select sel-sm" value={$urlImportEngine || 'standard'}
                on:change={e => urlImportEngine.set(e.target.value)}>
                <option value="standard">Standard</option>
                <option value="enhanced" disabled={!enhancedAvailable}>
                  Enhanced{!enhancedAvailable ? ' (server required)' : ''}
                </option>
                <option value="smart" disabled={!smartAvailable}>
                  Smart{!smartAvailable ? ' (Trace AI required)' : ''}
                </option>
              </select>
            </div>
          </div>

          {#if ($urlImportEngine || 'standard') === 'smart'}
            <div class="setting-note">
              <span class="material-symbols-rounded">info</span>
              <span>Smart sends every URL import to your AI, which uses your provider's quota on every paste. Standard or Enhanced are free and handle most sites; consider setting Smart only as a fallback.</span>
            </div>
          {/if}

          {#if ($urlImportEngine || 'standard') === 'enhanced'}
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">Enhanced Fallback</span>
                <div class="setting-desc">When the server is unreachable or recipe-scrapers isn't installed, fall back to this.</div>
              </div>
              <div class="select-wrap" style="width:170px">
                <select class="select sel-sm" value={$urlImportFallback || 'standard'}
                  on:change={e => urlImportFallback.set(e.target.value)}>
                  <option value="standard">Standard</option>
                  <option value="smart" disabled={!smartAvailable}>
                    Smart{!smartAvailable ? ' (Trace AI required)' : ''}
                  </option>
                </select>
              </div>
            </div>
          {/if}

          <div class="setting-divider"></div>
          <div class="setting-subhead">Shopping List</div>

          <div class="setting-row">
            <div>
              <span class="setting-label">Default Grouping</span>
              <div class="setting-desc">How the shopping list is grouped when it opens. By Aisle uses the per-item aisle (auto-populated from the linked pantry item's category); By Recipe keeps items with the recipe that added them; Flat is one uninterrupted list.</div>
            </div>
            <div class="select-wrap" style="width:170px">
              <select class="select sel-sm" value={$shoppingGroupBy || 'aisle'}
                on:change={e => shoppingGroupBy.set(e.target.value)}>
                <option value="aisle">By Aisle</option>
                <option value="recipe">By Recipe</option>
                <option value="flat">Flat</option>
              </select>
            </div>
          </div>

          <div class="setting-divider"></div>
          <div class="setting-row">
            <div>
              <span class="setting-label">Checked Items</span>
              <div class="setting-desc">What happens to items after you check them off. Sink to bottom keeps them visible so you can uncheck by mistake; Hide removes them from view with a one-tap "Show Checked" toggle if you need them back.</div>
            </div>
            <div class="select-wrap" style="width:170px">
              <select class="select sel-sm" value={$shoppingCheckedBehavior || 'bottom'}
                on:change={e => shoppingCheckedBehavior.set(e.target.value)}>
                <option value="bottom">Sink to Bottom</option>
                <option value="hide">Hide</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <p class="settings-group-label">Data &amp; Tracking</p>

    <!-- ── Nutrition ───────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'nutrition')} on:click={() => toggleSection('nutrition')}>
      <span class="material-symbols-rounded si">nutrition</span>
      <span>{$_('settings.nutrition.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.nutrition}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'nutrition') && sectionVisible(settingsQuery, 'nutrition')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <SettingsNutrition />
      </div>
    {/if}

    <p class="settings-group-label">Integrations</p>

    <!-- ── AI Assistant ────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'ai')} on:click={() => toggleSection('ai')}>
      <span class="material-symbols-rounded si">smart_toy</span>
      <span>{$_('settings.ai.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.ai}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'ai') && sectionVisible(settingsQuery, 'ai')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <SettingsTrace {envLocks} />
      </div>
    {/if}

    <!-- ── NutriTrace federation ───────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'federation')} on:click={() => toggleSection('federation')}>
      <span class="material-symbols-rounded si">hub</span>
      <span>{$_('settings.federation.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.federation}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'federation') && sectionVisible(settingsQuery, 'federation')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <SettingsFederation />
        <SettingsImportFromNT />
      </div>
    {/if}

    <!-- ── Food sources (Open Food Facts + barcode scanner) ───────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'foodsources')} on:click={() => toggleSection('foodsources')}>
      <span class="material-symbols-rounded si">qr_code_scanner</span>
      <span>{$_('settings.connected_services.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.foodsources}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'foodsources') && sectionVisible(settingsQuery, 'foodsources')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <p class="sub-label">Open Food Facts</p>
        <div class="card settings-card">
          <div class="setting-row">
            <div>
              <span class="setting-label">Enable Open Food Facts</span>
              <div class="setting-desc">
                Look up barcodes against the global crowd-sourced food database. No account needed for lookups; one is only required to upload edits via Share to OFF.
              </div>
            </div>
            <input type="checkbox" class="toggle-cb" checked={$offEnabled} on:change={e => offEnabled.set(e.target.checked)} />
          </div>
          {#if $offEnabled}
            <div class="setting-divider"></div>
            <div class="setting-row">
              <span class="setting-label">Search Language</span>
              <div class="select-wrap" style="width:120px">
                <select class="select sel-sm" value={$offSearchLanguage} on:change={e => offSearchLanguage.set(e.target.value)}>
                  {#each OFF_LANGUAGE_OPTS as [v,l]}<option value={v}>{l}</option>{/each}
                </select>
              </div>
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <span class="setting-label">Search Country</span>
              <div class="select-wrap" style="width:150px">
                <select class="select sel-sm" value={$offSearchCountry} on:change={e => offSearchCountry.set(e.target.value)}>
                  {#each OFF_COUNTRY_OPTS as c}<option value={c}>{c}</option>{/each}
                </select>
              </div>
            </div>
            <div class="setting-divider"></div>
            <div class="setting-row">
              <span class="setting-label">Upload Country</span>
              <div class="select-wrap" style="width:150px">
                <select class="select sel-sm" value={$offUploadCountry} on:change={e => offUploadCountry.set(e.target.value)}>
                  <option value="Auto">Auto</option>
                  {#each OFF_COUNTRY_OPTS.filter(c => c !== 'World') as c}<option value={c}>{c}</option>{/each}
                </select>
              </div>
            </div>
            <div class="setting-divider"></div>
            <div class="form-block">
              <label class="form-label">Account Username</label>
              <p class="hint">Optional — only needed to upload edits.
                <a href="https://world.openfoodfacts.org/cgi/user.pl" target="_blank" rel="noopener" class="link">Create an OFF account →</a>
              </p>
              <input class="input" type="text" placeholder="OFF username" value={$offUsername}
                on:change={e => offUsername.set(e.target.value)} />
              <label class="form-label">Account Password</label>
              <div style="display:flex;gap:8px;align-items:center">
                {#if offShowPass}
                  <input class="input" type="text" style="flex:1" placeholder="OFF password"
                    value={$offPassword} on:change={e => offPassword.set(e.target.value)} />
                {:else}
                  <input class="input" type="password" style="flex:1" placeholder="OFF password"
                    value={$offPassword} on:change={e => offPassword.set(e.target.value)} />
                {/if}
                <button class="btn-icon" on:click={() => offShowPass = !offShowPass}
                  title={offShowPass ? 'Hide' : 'Show'} aria-label="Toggle password visibility">
                  <span class="material-symbols-rounded">{offShowPass ? 'visibility_off' : 'visibility'}</span>
                </button>
              </div>
            </div>
          {/if}
        </div>

        <p class="sub-label">USDA FoodData Central</p>
        <div class="card settings-card">
          <div class="setting-row">
            <div>
              <span class="setting-label">Enable USDA FoodData</span>
              <div class="setting-desc">
                Search the USDA nutrition database when adding pantry items.
                <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener" class="link">Get a free API key →</a>
              </div>
            </div>
            <input type="checkbox" class="toggle-cb" checked={$usdaEnabled} on:change={e => usdaEnabled.set(e.target.checked)} />
          </div>
          {#if $usdaEnabled}
            <div class="setting-divider"></div>
            <div class="form-block">
              <label class="form-label">API Key</label>
              <input class="input" type="text" placeholder="Paste your USDA API key here"
                value={$usdaApiKey} on:change={e => usdaApiKey.set(e.target.value)} />
            </div>
          {/if}
        </div>

        <p class="sub-label">Barcode Scanner</p>
        <div class="card settings-card">
          <div class="setting-row">
            <div>
              <span class="setting-label">Beep on Scan</span>
              <div class="setting-desc">Short audio confirmation when a barcode is recognized.</div>
            </div>
            <input type="checkbox" class="toggle-cb" checked={$barcodeBeep} on:change={e => barcodeBeep.set(e.target.checked)} />
          </div>
          {#if !isNative}
            <div class="setting-divider"></div>
            <div class="setting-row">
              <div>
                <span class="setting-label">Auto-Enable Flashlight</span>
                <div class="setting-desc">Turn on the rear-camera flashlight automatically when the scanner opens (web only — native uses the OS camera UI's own controls).</div>
              </div>
              <input type="checkbox" class="toggle-cb" checked={$barcodeFlashlight} on:change={e => barcodeFlashlight.set(e.target.checked)} />
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <p class="settings-group-label">App</p>

    <!-- ── Server Connection (native only — manages connection to a
         CookTrace server). PWA users have no "server connection"
         concept; their Log Out lives in My Profile. -->
    {#if isNative}
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'serverconn')} on:click={() => toggleSection('serverconn')}>
      <span class="material-symbols-rounded si">cloud_sync</span>
      <span>{$_('settings.server_connection.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.serverconn}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'serverconn') && sectionVisible(settingsQuery, 'serverconn')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <SettingsServerConnection />
      </div>
    {/if}
    {/if}

    <!-- ── Notifications ───────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'notifications')} on:click={() => toggleSection('notifications')}>
      <span class="material-symbols-rounded si">notifications</span>
      <span>{$_('settings.notifications.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.notifications}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'notifications') && sectionVisible(settingsQuery, 'notifications')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <SettingsNotifications />
      </div>
    {/if}

    <!-- ── Email (SMTP — admin only in multi-user; single-user installs
         show it unconditionally). Mirrors NutriTrace's Email section. ── -->
    {#if !$userMgmtActive || $currentUser?.role === 'admin'}
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'email')} on:click={() => toggleSection('email')}>
      <span class="material-symbols-rounded si">mail</span>
      <span>{$_('settings.email.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.email}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'email') && sectionVisible(settingsQuery, 'email')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <SettingsEmail {envLocks} />
      </div>
    {/if}
    {/if}

    <!-- ── Backup & Restore ────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'backup')} on:click={() => toggleSection('backup')}>
      <span class="material-symbols-rounded si">backup</span>
      <span>{$_('settings.backup.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.backup}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'backup') && sectionVisible(settingsQuery, 'backup')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <SettingsBackup />
      </div>
    {/if}

    <!-- ── Import from Another App (Mealie / Tandoor / Paprika bulk) ──── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'import')} on:click={() => toggleSection('import')}>
      <span class="material-symbols-rounded si">download</span>
      <span>{$_('settings.import.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.import}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'import') && sectionVisible(settingsQuery, 'import')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <SettingsImport />
      </div>
    {/if}

    <!-- ── Kitchens (multi-user soft groups for sharing) ──────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'kitchens')} on:click={() => toggleSection('kitchens')}>
      <span class="material-symbols-rounded si">cooking</span>
      <span>{$_('settings.kitchens.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.kitchens}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'kitchens') && sectionVisible(settingsQuery, 'kitchens')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <SettingsKitchens />
      </div>
    {/if}

    <!-- ── Diagnostics ─────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'diagnostics')} on:click={() => toggleSection('diagnostics')}>
      <span class="material-symbols-rounded si">troubleshoot</span>
      <span>{$_('settings.diagnostics.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.diagnostics}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'diagnostics') && sectionVisible(settingsQuery, 'diagnostics')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="setting-row">
            <div>
              <span class="setting-label">Diagnostic Mode</span>
              <div class="setting-desc">Enables detailed app-internal logs (sync, settings, notifications){isNative ? ' and writes them to a daily log file on disk so they survive crashes and reloads.' : ' and verbose console output.'} Off by default; turn on while reproducing a bug, then export below.</div>
            </div>
            <Toggle checked={_verboseLogging} on:change={e => _toggleVerbose(e.detail)} />
          </div>
          <div class="setting-divider"></div>
          <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px">
            <span class="setting-label">View Diagnostic Logs</span>
            <p class="setting-desc" style="line-height:1.5">
              Recent log lines from the app's console. Useful for bug reports; copy or share into a <a href="https://github.com/traceapps/cooktrace/issues" target="_blank" rel="noopener" class="about-link">GitHub issue</a>.{isNative ? ' On Android with Diagnostic Mode on, you can also share the persisted log file or any captured crash report.' : ''} Nothing is sent anywhere automatically.
            </p>
            <button class="btn btn-secondary" style="height:40px;font-size:13px" on:click={_openLogsSheet}>
              <span class="material-symbols-rounded" style="font-size:16px">terminal</span>
              View logs{hasCrashReport() ? ' · crash report available' : ''}
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- ── Admin group (server-side users / auth — only meaningful when
         there's a real server with user management to administer). -->
    {#if showAdminGroup}
    <p class="settings-group-label">Admin</p>

    <!-- ── Users ─────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'users')} on:click={() => toggleSection('users')}>
      <span class="material-symbols-rounded si">group</span>
      <span>{$_('settings.users.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.users}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'users') && sectionVisible(settingsQuery, 'users')}
      <SettingsUserManagement />
    {/if}

    <!-- ── Authentication (OIDC SSO + password-login toggle) ──────────── -->
    {#if $userMgmtActive && $currentUser?.role === 'admin'}
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'auth')} on:click={() => toggleSection('auth')}>
      <span class="material-symbols-rounded si">vpn_key</span>
      <span>{$_('settings.authentication.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.auth}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'auth') && sectionVisible(settingsQuery, 'auth')}
      <SettingsAuth />
    {/if}
    {/if}
    {/if}

    <!-- ── About ──────────────────────────────────────────────────────── -->
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'about')} on:click={() => toggleSection('about')}>
      <span class="material-symbols-rounded si">info</span>
      <span>{$_('settings.about.section')}</span>
      <span class="material-symbols-rounded chevron" class:rotated={openSections.about}>expand_more</span>
    </button>
    {#if sectionOpen(openSections, settingsQuery, 'about') && sectionVisible(settingsQuery, 'about')}
      <div class="section-body" transition:slide={{ duration: 180 }}>
        <div class="card settings-card">
          <div class="about-hero">
            <img src={resolveAssetUrl('/icons/logo.png')} alt="CookTrace" class="about-icon" />
            <div>
              <div class="about-name">CookTrace</div>
              <div class="about-version text-3 text-sm">
                {APP_VERSION}
                <span class="platform-tag">{isNative ? 'Android' : 'PWA'}</span>
              </div>
            </div>
          </div>
          <div class="setting-divider"></div>
          <div class="about-desc">
            Trace Every Recipe — From Pantry to Plate. CookTrace keeps your
            recipes, pantry, cook diary, and shopping list together in one place,
            with optional federation to NutriTrace for nutrition tracking. Your data
            lives on your server, not in the cloud.
          </div>
          <div class="setting-divider"></div>
          <div class="about-row">
            <span class="material-symbols-rounded about-feat-icon">database</span>
            <span>Self-hosted — your data, your server</span>
          </div>
          <div class="setting-divider"></div>
          <div class="about-row">
            <span class="material-symbols-rounded about-feat-icon">phone_android</span>
            <span>Native Android app with offline support, plus a PWA for any browser</span>
          </div>
          <div class="setting-divider"></div>
          <div class="about-row">
            <span class="material-symbols-rounded about-feat-icon">lock</span>
            <span>No tracking, no ads, no third-party analytics</span>
          </div>
          <div class="setting-divider"></div>
          <div class="about-row">
            <span class="material-symbols-rounded about-feat-icon">hub</span>
            <span>Optional federation with <a href="https://github.com/traceapps/nutritrace" target="_blank" rel="noopener" class="about-link">NutriTrace</a> for nutrition tracking</span>
          </div>
          <div class="setting-divider"></div>
          <div class="about-row">
            <span class="material-symbols-rounded about-feat-icon">code</span>
            <span>Part of the <a href="https://github.com/traceapps" target="_blank" rel="noopener" class="about-link">TraceApps</a> family (with NutriTrace and LiftTrace)</span>
          </div>
          <div class="setting-divider"></div>
          <div class="about-row" style="flex-direction:column;align-items:flex-start;gap:8px">
            <div style="display:flex;align-items:center;gap:8px">
              <span class="material-symbols-rounded about-feat-icon">volunteer_activism</span>
              <span>Support Development</span>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;padding-left:30px">
              <a href="https://ko-fi.com/traceapps" target="_blank" rel="noopener" class="btn btn-secondary" style="height:30px;font-size:12px;padding:0 12px">
                <span class="material-symbols-rounded" style="font-size:14px">coffee</span> Ko-fi
              </a>
            </div>
            <div class="setting-desc" style="padding-left:30px;font-size:11px">CookTrace is free to self-host. Donations are appreciated but never required.</div>
          </div>
          <div class="setting-divider"></div>
          <div class="about-desc" style="font-size:11px;color:var(--text-3);line-height:1.5">
            CookTrace is not medical or dietary software. Recipe nutrition values are
            estimates based on user-entered data and may contain inaccuracies. Always
            consult a healthcare professional for medical or dietary advice. Use at
            your own discretion.
          </div>
        </div>
      </div>
    {/if}

    <div style="height:24px"></div>
  </div>
</div>

<!-- Diagnostic logs viewer -->
<Sheet bind:open={_logsSheet} title="Diagnostic Logs">
  <div style="padding:0 4px 8px">
    <p class="setting-desc" style="line-height:1.5;margin-bottom:10px">
      Recent log lines (capped at 500 normally, 1000 in verbose mode). Header shows app version + platform so the recipient knows what they're looking at.
    </p>
    <textarea readonly style="width:100%;height:280px;font-family:monospace;font-size:11px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm,6px);background:var(--surface-2);color:var(--text-1);resize:vertical;white-space:pre">{_logsText}</textarea>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="btn btn-primary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_copyLogs}>
        {#if _logsCopied}
          <span class="material-symbols-rounded" style="font-size:16px">check</span> Copied
        {:else}
          <span class="material-symbols-rounded" style="font-size:16px">content_copy</span> Copy
        {/if}
      </button>
      <button class="btn btn-secondary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_shareLogs}>
        <span class="material-symbols-rounded" style="font-size:16px">share</span> Share Text
      </button>
      <button class="btn btn-secondary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_clearLogs}>
        <span class="material-symbols-rounded" style="font-size:16px">delete</span> Clear
      </button>
    </div>
    {#if isNative && _verboseLogging}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-secondary" style="flex:1;height:40px;font-size:13px" on:click={_shareLogFile}>
          <span class="material-symbols-rounded" style="font-size:16px">description</span> Share Log File
        </button>
      </div>
      <p class="setting-desc" style="margin-top:6px;font-size:11px">
        Today's persisted log on disk (rotates daily, last 7 days kept). Better for long sessions or after a crash; the in-memory buffer above resets every reload.
      </p>
    {/if}
    {#if isNative && _hasCrashReport}
      <div style="margin-top:14px;padding:10px;background:color-mix(in srgb,var(--danger) 8%, transparent);border-left:3px solid var(--danger);border-radius:var(--radius-sm,6px)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger)">warning</span>
          <strong style="color:var(--danger);font-size:14px">Crash report available</strong>
        </div>
        <p class="setting-desc" style="margin:0 0 8px;font-size:12px">
          The app captured an uncaught error. Share the report to help track it down, then dismiss it.
        </p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" style="flex:1;height:36px;font-size:12px" on:click={_shareCrashReport}>
            <span class="material-symbols-rounded" style="font-size:14px">share</span> Share Crash Report
          </button>
          <button class="btn btn-secondary" style="flex:1;height:36px;font-size:12px" on:click={_clearCrashReport}>
            Dismiss
          </button>
        </div>
      </div>
    {/if}
  </div>
</Sheet>

<!-- Custom color picker sheet — exact NT pattern (Hue / Saturation / Lightness sliders + RGB inputs + Hex). -->
<Sheet bind:open={showColorSheet} title="Custom Color">
  <div class="cp-body">
    <!-- Live preview -->
    <div class="cp-preview" style="background:{customColorHex}">
      <span class="cp-preview-hex">{customHexInput}</span>
    </div>

    <div class="cp-slider-group">
      <label class="form-label">Hue</label>
      <div class="cp-slider-wrap">
        <input type="range" class="cp-slider cp-hue" min="0" max="360"
          bind:value={cpHue} on:input={cpUpdateFromSliders} />
      </div>
    </div>

    <div class="cp-slider-group">
      <label class="form-label">Saturation</label>
      <div class="cp-slider-wrap">
        <input type="range" class="cp-slider cp-sat" min="0" max="100"
          bind:value={cpSat} on:input={cpUpdateFromSliders}
          style="--cp-sat-lo:hsl({cpHue},0%,{cpLgt}%);--cp-sat-hi:hsl({cpHue},100%,{cpLgt}%)" />
      </div>
    </div>

    <div class="cp-slider-group">
      <label class="form-label">Lightness</label>
      <div class="cp-slider-wrap">
        <input type="range" class="cp-slider cp-lgt" min="0" max="100"
          bind:value={cpLgt} on:input={cpUpdateFromSliders}
          style="--cp-lgt-lo:hsl({cpHue},{cpSat}%,0%);--cp-lgt-mid:hsl({cpHue},{cpSat}%,50%);--cp-lgt-hi:hsl({cpHue},{cpSat}%,100%)" />
      </div>
    </div>

    <div class="cp-slider-group">
      <label class="form-label">RGB</label>
      <div class="cp-rgb-row">
        <div class="cp-rgb-field">
          <input class="input cp-rgb-input" type="number" min="0" max="255" bind:value={cpR} on:input={cpUpdateFromRgb} />
          <span class="cp-rgb-label">R</span>
        </div>
        <div class="cp-rgb-field">
          <input class="input cp-rgb-input" type="number" min="0" max="255" bind:value={cpG} on:input={cpUpdateFromRgb} />
          <span class="cp-rgb-label">G</span>
        </div>
        <div class="cp-rgb-field">
          <input class="input cp-rgb-input" type="number" min="0" max="255" bind:value={cpB} on:input={cpUpdateFromRgb} />
          <span class="cp-rgb-label">B</span>
        </div>
      </div>
    </div>

    <div class="cp-slider-group">
      <label class="form-label">Hex Code</label>
      <div class="cp-hex-row">
        <span class="cp-hex-dot" style="background:{/^#[0-9a-fA-F]{6}$/.test(customHexInput) ? customHexInput : '#ccc'}"></span>
        <input class="input" type="text" placeholder="#rrggbb" maxlength="7"
          style="font-family:monospace;letter-spacing:0.05em;flex:1"
          bind:value={customHexInput}
          on:input={cpUpdateFromHex}
          on:keydown={e => e.key === 'Enter' && applyCustomColor()} />
      </div>
    </div>

    <button class="btn btn-primary cp-apply" on:click={applyCustomColor}>Apply Color</button>
  </div>
</Sheet>

<style>
  .settings-content { display: flex; flex-direction: column; gap: 0; }
  .hidden { display: none !important; }

  /* ── Settings search bar (sticky under header, mirrors NT) ───────────── */
  .settings-search-bar {
    position: sticky;
    /* page-top + 10 (top inset) + var(--hamburger-row) + 40 (h1) + 12 (pad-bot)
       = 62 + hamburger-row. Persistent-sidebar mode sets --hamburger-row to 0
       so the search bar pins flush against the (shorter) header. */
    top: calc(var(--page-top, var(--safe-top)) + 62px + var(--hamburger-row, 0px));
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px var(--page-px, 16px) 12px;
    background: var(--glass-surface, var(--surface-1));
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 1px solid var(--border);
  }
  /* Stale rule for the retired .has-banner layout — kept here as an
     empty placeholder so the comment block above doesn't reference a
     deleted selector. All three banner modes now use the compact
     header height, so the search bar's `top` calc above already
     covers every case. */
  .settings-search-icon { font-size: 20px; color: var(--text-3); flex-shrink: 0; }
  .settings-search-input {
    flex: 1;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full, 999px);
    padding: 7px 14px;
    font-size: 15px;
    color: var(--text-1);
    outline: none;
  }
  .settings-search-input:focus { border-color: var(--accent); }
  .settings-search-clear { color: var(--text-3); }

  /* ── Profile hero — identity card at the top of Settings ─────────────── */
  .profile-hero {
    display: flex; align-items: center; gap: 14px;
    margin: 4px var(--page-px) 14px;
    padding: 14px 16px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 14px);
    color: var(--text-1);
    cursor: pointer;
    font-family: inherit; text-align: left;
    transition: background var(--dur-fast), transform var(--dur-fast);
    width: calc(100% - var(--page-px) * 2);
  }
  .profile-hero:hover  { background: var(--surface-3, var(--surface-2)); }
  .profile-hero:active { transform: scale(0.99); }
  .profile-hero-avatar {
    width: 48px; height: 48px; border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2, var(--accent)));
    color: #fff;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; overflow: hidden;
  }
  .profile-hero-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .profile-hero-avatar :global(.material-symbols-rounded) { font-size: 26px; }
  .profile-hero-initial { font-size: 20px; font-weight: 700; line-height: 1; }
  .profile-hero-info { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .profile-hero-name {
    font-size: 17px; font-weight: 700; color: var(--text-1);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .profile-hero-role {
    align-self: flex-start;
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--accent); background: var(--accent-dim);
    padding: 2px 8px; border-radius: var(--radius-full, 999px);
  }
  .profile-hero-sub { font-size: 13px; color: var(--text-3); }
  .profile-hero-chev { color: var(--text-3); flex-shrink: 0; }

  /* ── Group label ─────────────────────────────────────────────────────── */
  .settings-group-label {
    padding: 20px var(--page-px) 4px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
    margin: 0;
  }

  /* ── Section toggles & body (mirrors NT) ─────────────────────────────── */
  .section-toggle {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 14px var(--page-px);
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-1);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    transition: background var(--dur-fast);
  }
  .section-toggle:hover  { background: var(--surface-2); }
  .section-toggle:active { background: var(--surface-3, var(--surface-2)); }
  .si {
    font-size: 18px;
    color: var(--accent);
    flex-shrink: 0;
    width: 30px; height: 30px;
    background: var(--accent-dim);
    border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
  }
  .chevron { font-size: 20px; color: var(--text-3); margin-left: auto; transition: transform var(--dur-base) var(--ease-out); }
  .chevron.rotated { transform: rotate(180deg); }
  .section-body { padding: 12px var(--page-px); display: flex; flex-direction: column; gap: 10px; }
  .sub-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
    padding: 4px 2px 2px; margin: 0;
  }
  .form-block { padding: 12px 16px 14px; display: flex; flex-direction: column; gap: 8px; }
  .form-block .form-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
    margin-top: 4px;
  }
  .form-block .hint { font-size: 12px; color: var(--text-3); margin: 0 0 4px; line-height: 1.4; }
  .form-block .link { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  .form-block .input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px;
    color: var(--text-1); font-size: 14px;
    width: 100%; box-sizing: border-box;
  }
  .form-block .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }

  /* ── Card + setting rows ─────────────────────────────────────────────── */
  .card.settings-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .setting-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
  }
  .setting-row > div:first-child { flex: 1; min-width: 0; }
  .setting-label { font-size: 14px; color: var(--text-1); display: block; }
  .setting-desc { font-size: 12px; color: var(--text-3); margin-top: 4px; line-height: 1.4; display: block; }
  .setting-note {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin: 10px 0 0;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: var(--radius-sm);
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-2);
  }
  .setting-note :global(.material-symbols-rounded) {
    font-size: 18px;
    color: var(--accent);
    flex-shrink: 0;
    margin-top: 1px;
  }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }
  .setting-subhead {
    padding: 12px 16px 4px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
  }

  /* ── Select dropdown ─────────────────────────────────────────────────── */
  .select-wrap {
    position: relative;
    display: inline-block;
  }
  .select-wrap::after {
    content: '';
    position: absolute;
    right: 10px; top: 50%;
    transform: translateY(-25%) rotate(45deg);
    width: 7px; height: 7px;
    border-right: 2px solid var(--text-3);
    border-bottom: 2px solid var(--text-3);
    pointer-events: none;
  }
  .select {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 7px 28px 7px 10px;
    color: var(--text-1);
    font-size: 13px;
    width: 100%;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
  }
  .select:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .sel-sm { height: 36px; font-size: 13px; }

  /* ── Toggle checkbox ─────────────────────────────────────────────────── */
  .toggle-cb {
    width: 40px; height: 24px;
    appearance: none;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 99px;
    position: relative;
    cursor: pointer;
    transition: background var(--dur-fast);
  }
  .toggle-cb::after {
    content: '';
    position: absolute;
    top: 1px; left: 1px;
    width: 20px; height: 20px;
    background: var(--text-3);
    border-radius: 50%;
    transition: transform var(--dur-base) var(--ease-spring), background var(--dur-fast);
  }
  .toggle-cb:checked { background: var(--accent-dim); border-color: var(--accent); }
  .toggle-cb:checked::after { background: var(--accent); transform: translateX(16px); }

  /* ── Number input ────────────────────────────────────────────────────── */
  .input.num {
    width: 80px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    color: var(--text-1);
    text-align: right;
    font-size: 13px;
  }

  /* ── Accent swatches (mirror NT) ──────────────────────────────────────── */
  .accent-swatches { display: flex; gap: 10px; flex-wrap: wrap; padding: 0 16px 14px; }
  .accent-swatch {
    width: 38px; height: 38px;
    border-radius: 50%;
    border: 3px solid transparent;
    cursor: pointer;
    transition: transform 0.15s, border-color 0.15s;
    outline: none;
    display: flex; align-items: center; justify-content: center;
  }
  .accent-swatch.active { border-color: var(--text-1); transform: scale(1.15); }
  .accent-swatch:hover { transform: scale(1.08); }
  .accent-swatch-custom {
    background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red);
    position: relative; overflow: hidden;
  }

  /* ── About hero ──────────────────────────────────────────────────────── */
  .about-hero {
    display: flex; align-items: center; gap: 14px;
    padding: 16px;
  }
  .about-icon {
    width: 56px; height: 56px; border-radius: 12px;
    flex-shrink: 0; object-fit: contain;
  }
  .about-name { font-size: 18px; font-weight: 700; color: var(--text-1); }
  .about-version { font-size: 12px; color: var(--text-3); margin-top: 2px; display: flex; align-items: center; gap: 6px; }
  .platform-tag {
    font-size: 10px; font-weight: 700; letter-spacing: 0.05em;
    padding: 2px 6px; border-radius: var(--radius-sm);
    background: var(--accent-dim); color: var(--accent);
  }
  .about-desc {
    font-size: 13px; color: var(--text-2); line-height: 1.6;
    padding: 14px 16px;
  }
  .about-row {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 16px;
    font-size: 13px; color: var(--text-2);
  }
  .about-feat-icon {
    font-size: 18px; color: var(--accent);
    width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .about-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  /* ── Custom color picker sheet (mirror NT) ──────────────────────────── */
  .cp-body { display: flex; flex-direction: column; gap: 18px; padding-top: 4px; }
  .cp-preview {
    height: 70px; border-radius: var(--radius-lg);
    display: flex; align-items: flex-end; justify-content: flex-end;
    padding: 8px 12px;
    border: 1px solid rgba(255,255,255,0.12);
  }
  .cp-preview-hex {
    font-size: 11px; font-family: monospace; letter-spacing: 0.06em;
    color: rgba(255,255,255,0.75); text-shadow: 0 1px 3px rgba(0,0,0,0.5);
    font-weight: 600;
  }
  .cp-slider-group { display: flex; flex-direction: column; gap: 8px; }
  .form-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .cp-slider-wrap { padding: 4px 0; }
  .cp-slider {
    -webkit-appearance: none; appearance: none;
    width: 100%; height: 16px; border-radius: 8px; outline: none; cursor: pointer;
    border: 1px solid rgba(128,128,128,0.2);
  }
  .cp-hue {
    background: linear-gradient(to right,
      hsl(0,100%,50%), hsl(30,100%,50%), hsl(60,100%,50%), hsl(90,100%,50%),
      hsl(120,100%,50%), hsl(150,100%,50%), hsl(180,100%,50%), hsl(210,100%,50%),
      hsl(240,100%,50%), hsl(270,100%,50%), hsl(300,100%,50%), hsl(330,100%,50%), hsl(360,100%,50%));
  }
  .cp-sat { background: linear-gradient(to right, var(--cp-sat-lo), var(--cp-sat-hi)); }
  .cp-lgt { background: linear-gradient(to right, var(--cp-lgt-lo), var(--cp-lgt-mid), var(--cp-lgt-hi)); }
  .cp-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 24px; height: 24px; border-radius: 50%;
    background: var(--surface-1); border: 2px solid var(--text-1);
    box-shadow: 0 2px 6px rgba(0,0,0,0.35); cursor: pointer;
  }
  .cp-slider::-moz-range-thumb {
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--surface-1); border: 2px solid var(--text-1);
    box-shadow: 0 2px 6px rgba(0,0,0,0.35); cursor: pointer;
  }
  .cp-rgb-row { display: flex; gap: 10px; }
  .cp-rgb-field { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 1; }
  .cp-rgb-input {
    text-align: center;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 6px;
    color: var(--text-1);
    font-size: 14px;
    width: 100%;
    box-sizing: border-box;
    font-family: monospace;
  }
  .cp-rgb-label { font-size: 11px; color: var(--text-3); font-weight: 700; }
  .cp-hex-row { display: flex; align-items: center; gap: 10px; }
  .cp-hex-dot {
    width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
    border: 1px solid var(--border);
  }
  .input {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 9px 12px;
    color: var(--text-1);
    font-size: 14px;
    box-sizing: border-box;
  }
  .cp-apply { height: 44px; margin-top: 4px; width: 100%; }
</style>
