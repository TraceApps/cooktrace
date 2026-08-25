<script>
  // Thin router shell (mirrors NutriTrace / LiftTrace). Section bodies
  // live in components/settings/*.svelte and are dispatched to via
  // <svelte:component> when the URL is /settings/<slug>. The /settings
  // index just renders the section-toggle rows + group labels + profile
  // hero + search bar.
  //
  // History note: this file used to own every section's state, template,
  // and CSS inline. The extracted per-section files are the source of
  // truth now; this shell only holds cross-section chrome (header,
  // sticky search, drill-in nav, deep-link scroll, custom color-picker
  // Sheet) and the shared CSS descendants need via :global.

  import { onMount, tick, afterUpdate, onDestroy } from 'svelte';
  import { push, querystring } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { slide, fade } from 'svelte/transition';

  import { currentUser, userMgmtActive } from '../stores/auth.js';
  import { isNative, getServerUrl, resolveAssetUrl } from '../lib/platform.js';
  import {
    bannerStyle, disableAnimations, accentColor, appearance,
  } from '../stores/settings.js';
  import { applyAccentColor } from '../stores/settings.js';
  import { colorPickerOpen } from '../stores/color-picker.js';

  // Per-section pages — one component per slug, dispatched by
  // SECTION_COMPONENTS below.
  import SettingsAppearance      from '../components/settings/SettingsAppearance.svelte';
  import SettingsRegional        from '../components/settings/SettingsRegional.svelte';
  import SettingsCooking         from '../components/settings/SettingsCooking.svelte';
  import SettingsNutrition       from '../components/settings/SettingsNutrition.svelte';
  import SettingsTrace           from '../components/settings/SettingsTrace.svelte';
  import SettingsFederation      from '../components/settings/SettingsFederation.svelte';
  import SettingsImportFromNT    from '../components/settings/SettingsImportFromNT.svelte';
  import SettingsFoodSources     from '../components/settings/SettingsFoodSources.svelte';
  import SettingsServerConnection from '../components/settings/SettingsServerConnection.svelte';
  import SettingsNotifications   from '../components/settings/SettingsNotifications.svelte';
  import SettingsBackup          from '../components/settings/SettingsBackup.svelte';
  import SettingsImport          from '../components/settings/SettingsImport.svelte';
  import SettingsKitchens        from '../components/settings/SettingsKitchens.svelte';
  import SettingsUpdates         from '../components/settings/SettingsUpdates.svelte';
  import SettingsDiagnostics     from '../components/settings/SettingsDiagnostics.svelte';
  import SettingsUserManagement  from '../components/settings/SettingsUserManagement.svelte';
  import SettingsAuth            from '../components/settings/SettingsAuth.svelte';
  import SettingsEmail           from '../components/settings/SettingsEmail.svelte';
  import SettingsAbout           from '../components/settings/SettingsAbout.svelte';
  import Profile                 from './Profile.svelte';
  import Sheet                   from '../components/ui/Sheet.svelte';

  // ── Route param → current section ──────────────────────────────────────
  // svelte-spa-router route `/settings/:section` → params.section.
  // `/settings` (no param) → currentSection = null → index view.
  export let params = {};
  $: currentSection = params?.section || null;

  // ── Drill-in navigation ────────────────────────────────────────────────
  // Tapping a section row on the index routes to /settings/<slug>. If the
  // user has an active search query, forward it as ?q=<query> so the
  // sub-page can auto-scroll to the matching setting on land.
  function toggleSection(key) {
    if (currentSection === key) push('/settings');
    else {
      const q = settingsQuery ? `?q=${encodeURIComponent(settingsQuery)}` : '';
      push(`/settings/${key}${q}`);
    }
  }
  // Reverse the peel-in animation on tap: swap the back button + title
  // into their -out classes so the reversed CSS keyframe plays, then
  // navigate after the animation completes. Guards against double-tap
  // starting a second exit while the first is still playing.
  let _leaving = false;
  async function backToIndex() {
    if (_leaving) return;
    _leaving = true;
    await new Promise(r => setTimeout(r, 240));
    push('/settings');
  }

  // ── Settings search ────────────────────────────────────────────────────
  let settingsSearch = '';
  $: settingsQuery = settingsSearch.toLowerCase().trim();

  // On mobile / narrow, typing into the search bar while on a
  // sub-page auto-navigates back to the index with the query so
  // filtering shows the matching sections. On desktop the search
  // filters the always-visible left rail in place — no navigation
  // needed. Threshold matches the two-pane shell (1024px).
  function _onSearchInput() {
    if (!currentSection) return;
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(min-width: 1024px)').matches) return;
    if (!settingsQuery) return;
    push(`/settings?q=${encodeURIComponent(settingsQuery)}`);
  }

  // Desktop welcome-hero: profile is expandable inline instead of
  // routing away. Chevron rotates + body slides in/out. Default
  // expanded so the welcome pane is immediately useful.
  let _profileHeroExpanded = true;
  function _toggleProfileHero() {
    _profileHeroExpanded = !_profileHeroExpanded;
  }
  // When the user navigates to /settings/profile from the rail
  // (from any other section), auto-expand so the profile editor is
  // visible on land.
  $: if (currentSection === 'profile') _profileHeroExpanded = true;

  // Rail active-pill: the moving highlight that slides between rail
  // items on section change. Absolutely positioned inside the rail;
  // we measure the active button's offsetTop/offsetHeight and drive
  // CSS transform + height. First measurement is applied without a
  // transition (via _pillReady flag) so it doesn't jump from 0 on
  // initial mount.
  let _railEl;
  let _pillY = 0;
  let _pillH = 0;
  let _pillVisible = false;
  let _pillReady = false;
  let _pillRO;
  function _measurePill() {
    if (!_railEl) return;
    const btn = _railEl.querySelector('.section-toggle.active');
    if (!btn) { _pillVisible = false; return; }
    const y = btn.offsetTop;
    const h = btn.offsetHeight;
    if (_pillVisible && y === _pillY && h === _pillH) return;
    _pillY = y;
    _pillH = h;
    _pillVisible = true;
    if (!_pillReady) requestAnimationFrame(() => { _pillReady = true; });
  }
  // Defer one paint frame so any conditional subtrees (the admin
  // {#if $userMgmtActive && $currentUser?.role === 'admin'} blocks
  // that hold the Users/Authentication/Email rail buttons) have
  // committed before we querySelector for .active. Without the rAF,
  // clicking a section inside one of those blocks races past the
  // measurement, comes up empty, and hides the pill until an
  // unrelated re-render lands.
  afterUpdate(() => requestAnimationFrame(_measurePill));
  onMount(() => {
    if (typeof ResizeObserver === 'undefined' || !_railEl) return;
    _pillRO = new ResizeObserver(_measurePill);
    _pillRO.observe(_railEl);
  });
  onDestroy(() => { _pillRO?.disconnect(); });

  // Section metadata — slug → title i18n key + icon. Used by the
  // sub-page header to show the section name.
  const SECTION_META = {
    appearance:    { titleKey: 'settings.appearance.section',        icon: 'contrast' },
    regional:      { titleKey: 'settings.regional.section',          icon: 'public' },
    cooking:       { titleKey: 'settings.cooking.section',           icon: 'restaurant' },
    nutrition:     { titleKey: 'settings.nutrition.section',         icon: 'science' },
    ai:            { titleKey: 'settings.ai.section',                icon: 'bolt' },
    federation:    { titleKey: 'settings.federation.section',        icon: 'link' },
    foodsources:   { titleKey: 'settings.connected_services.section',icon: 'restaurant_menu' },
    notifications: { titleKey: 'settings.notifications.section',     icon: 'notifications' },
    email:         { titleKey: 'settings.email.section',             icon: 'mail' },
    backup:        { titleKey: 'settings.backup.section',            icon: 'archive' },
    import:        { titleKey: 'settings.import.section',            icon: 'import_export' },
    kitchens:      { titleKey: 'settings.kitchens.section',          icon: 'group' },
    users:         { titleKey: 'settings.users.section',             icon: 'group' },
    auth:          { titleKey: 'settings.authentication.section',    icon: 'shield_person' },
    serverconn:    { titleKey: 'settings.server.section',            icon: 'cloud' },
    updates:       { titleKey: 'settings.updates.section',           icon: 'system_update' },
    diagnostics:   { titleKey: 'settings.diagnostics.section',       icon: 'troubleshoot' },
    about:         { titleKey: 'settings.about.section',             icon: 'info' },
    profile:       { titleKey: 'profile.title',                      icon: 'person' },
  };

  // Slug → per-section component. Drives the <svelte:component>
  // dispatch in the sub-page view. `ai` + `email` receive envLocks via
  // a per-slug wrapper below (see markup) instead of prop-drilling to
  // every child.
  const SECTION_COMPONENTS = {
    appearance:    SettingsAppearance,
    regional:      SettingsRegional,
    cooking:       SettingsCooking,
    nutrition:     SettingsNutrition,
    ai:            SettingsTrace,
    // federation is a two-component render (federation + import-from-NT)
    // — handled as a special case in the markup below.
    federation:    SettingsFederation,
    foodsources:   SettingsFoodSources,
    notifications: SettingsNotifications,
    email:         SettingsEmail,
    backup:        SettingsBackup,
    import:        SettingsImport,
    kitchens:      SettingsKitchens,
    users:         SettingsUserManagement,
    auth:          SettingsAuth,
    serverconn:    SettingsServerConnection,
    updates:       SettingsUpdates,
    diagnostics:   SettingsDiagnostics,
    about:         SettingsAbout,
    profile:       Profile,
  };

  // Keyword index for the settings search bar. Adding new keywords here
  // (rather than in the extracted sections) keeps the search results
  // reachable even when the section body isn't mounted — the search
  // runs on the index, before drill-in.
  const SECTION_KEYWORDS = {
    profile:       ['profile','my profile','account','name','avatar','log out','logout','sign out','password','change password'],
    appearance:    ['appearance','theme','dark','light','accent','color','navigation','sidebar','persistent','start page','animations','reduce motion','banner','page banner','force mobile','mobile layout','mobile view','phone layout','narrow layout'],
    regional:      ['regional','language','translation','locale','date','time','12h','24h','units','energy','kcal','kj','calories','kilojoules','imperial','metric','measurement system'],
    cooking:       ['cooking','servings','default servings','yield','recipe','recipes','url import','url import engine','scraper','recipe scrapers','recipe-scrapers','enhanced','smart','json-ld','schema.org','parser','auto add ingredients','auto-create pantry','pantry catalog','shopping','shopping list','aisle','aisles','group by','grouping','checked','hide checked','sort','reorder','shared recipes','main list','kitchen recipes','mixed view'],
    nutrition:     ['nutrition','nutrients','nutriments','vitamins','minerals','visible nutriments','fda'],
    federation:    ['federation','nutritrace','nt','linked','share','token','instance','foods','pull foods','import foods','sync foods'],
    foodsources:   ['food sources','open food facts','off','usda','fooddata central','api key','barcode','scanner','beep','flashlight','search','language','country','contribute','default source','default search','my pantry','pantry search'],
    ai:            ['ai','trace','assistant','provider','model','custom model','model id','api key','chat','claude','openai','gemini','sonnet','opus','haiku','gpt','gemini 3','base url','artificial intelligence','smart log','smartlog','quick log','voice','dictate','hold to record','mic'],
    notifications: ['notifications','reminders','cook day','thaw','alerts','push','apprise','gotify','ntfy','expiration','expiry','expires','expiring','pantry expiry','digest','weekly summary','shopping nudge'],
    email:         ['email','smtp','mail','password reset','invite','from address','tls','outgoing','send test','test email','recipient','test recipient','connection status','change password','change smtp'],
    backup:        ['backup','export','import','restore','json','full backup','reset','danger zone'],
    import:        ['import','mealie','tandoor','paprika','recipe import','migration','migrate','transfer','bulk','zip','from another app'],
    kitchens:      ['kitchens','kitchen','household','household members','share','sharing','family','roommates','crew','group','members','auto-share','auto share','auto sharing','share recipes','share cookbook','cookbook sharing','via kitchen'],
    users:         ['users','user management','accounts','login','admin','register','invite'],
    auth:          ['authentication','auth','sso','single sign-on','single sign on','oidc','openid','authentik','keycloak','authelia','password login'],
    serverconn:    ['server','connection','sync','connect','disconnect','local mode','offline','standalone','android','native','url','login'],
    updates:       ['updates','update','upgrade','version','new version','changelog','release','releases','apk','install','download','check for updates','auto-check','channel','stable','dev','dev-latest','beta','github','server update','docker','compose','docker-compose','check frequency','check interval','how often','hourly','daily','manual','manual only','cadence','banner','notification'],
    diagnostics:   ['diagnostics','logs','verbose','console','export','bug','report','troubleshoot','crash'],
    about:         ['about','version','cooktrace','license','source','github','donate','support'],
  };

  // Visibility predicate for section-toggle rows. Only filters when
  // there's an active search query; presence of currentSection no
  // longer collapses the list (desktop rail needs every section
  // visible so users can jump between them). Never hides the section
  // the user is currently on so a mid-typing search that doesn't
  // match doesn't make the rail feel like it lost the user's place.
  $: sectionVisible = (query, key) => {
    if (!query) return true;
    if (key === currentSection) return true;
    return (SECTION_KEYWORDS[key] || []).some(kw => kw.includes(query));
  };
  // Rail "no matches" placeholder — set to true when the query is
  // non-empty AND every section keyword-map entry fails to match.
  $: _railNoMatches = !!settingsQuery &&
    !Object.keys(SECTION_KEYWORDS).some(k => sectionVisible(settingsQuery, k));

  // Admin group + Server Connection index row visibility. `isNativeLocal`
  // is native standalone (no server bound). Not reactive on
  // getServerUrl() — that value doesn't flip without a full reload.
  $: isNativeLocal = isNative && !getServerUrl();
  // Show admin group when there's a real server with users to manage.
  $: showAdminGroup = !isNativeLocal && (!$userMgmtActive || $currentUser?.role === 'admin');

  // ── Deep-link search scroll ────────────────────────────────────────────
  // When the user searches on the main page then drills into a section,
  // the query travels along as ?q=<term>. On sub-page mount we scan the
  // rendered section body for the first row whose label OR description
  // text contains that term, scroll it into view, and briefly highlight
  // it. Turns "type 'aisle' → tap Cooking" into a single-tap jump to
  // the Default Grouping row.
  $: _urlQuery = $querystring ? new URLSearchParams($querystring).get('q') : null;

  // Fire the scroll exactly once per (section, query) landing.
  let _lastDeepLinkKey = null;
  $: {
    const key = `${currentSection || ''}|${_urlQuery || ''}`;
    if (currentSection && _urlQuery && key !== _lastDeepLinkKey) {
      _lastDeepLinkKey = key;
      _scheduleDeepLinkScroll(_urlQuery);
    }
  }

  async function _scheduleDeepLinkScroll(q) {
    await tick();
    await new Promise(r => setTimeout(r, 60));
    const q_norm = q.toLowerCase().trim();
    if (!q_norm) return;
    const scope = document.querySelector('.subpage-view');
    if (!scope) return;
    const candidates = scope.querySelectorAll(
      '.setting-label, .setting-desc, .sub-label, .setting-row'
    );
    let hit = null;
    for (const el of candidates) {
      if ((el.textContent || '').toLowerCase().includes(q_norm)) { hit = el; break; }
    }
    if (!hit) return;
    const row = hit.closest('.setting-row') || hit;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('deep-link-highlight');
    setTimeout(() => row.classList.remove('deep-link-highlight'), 2200);
  }

  // ── Env-lock one-shot fetch ────────────────────────────────────────────
  // Kept as a local so we can pass it to the AI + Email children (the
  // only ones that read it). Not lifted to a shared store to avoid an
  // otherwise-unnecessary settings-store expansion — the store refactor
  // isn't required for the two-pane port.
  let envLocks = { ai: false, smtp: false };

  onMount(async () => {
    try {
      const res = await fetch('/api/app-config', { credentials: 'include' });
      if (res.ok) {
        const appConfig = await res.json();
        envLocks = appConfig?.envLocks || envLocks;
      }
    } catch {}
  });

  // ── Custom color picker (HSL + RGB + Hex) — Sheet lives at shell
  // level so any child can trigger it (SettingsAppearance's Custom
  // swatch does, via `openColorPicker()` in the color-picker store).
  let customColorHex = /^#[0-9a-fA-F]{6}$/.test($accentColor) ? $accentColor : '#4FFFB0';
  let customHexInput = customColorHex;
  let cpHue = 160, cpSat = 100, cpLgt = 50;
  let cpR = 79, cpG = 255, cpB = 176;

  // When the shared store flips to `true`, seed the sliders from the
  // currently-applied accent so the picker opens on the user's actual
  // color instead of the last one they left the sheet at.
  $: if ($colorPickerOpen) _seedFromCurrentAccent();

  function _seedFromCurrentAccent() {
    const cur = /^#[0-9a-fA-F]{6}$/.test($accentColor) ? $accentColor : '#4FFFB0';
    customColorHex = cur;
    customHexInput = cur;
    [cpHue, cpSat, cpLgt] = _hexToHsl(cur);
    _syncRgbFromHex(cur);
  }

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
    colorPickerOpen.set(false);
  }

  // TODO: Onboarding shortcut cards for the desktop welcome hero — NT
  // renders a state-gated "Get Set Up" grid (Server / Goals / Wellness
  // / Appearance). CookTrace doesn't have equivalent state gates ready
  // yet; add when the surface exists.
</script>

<!-- Settings section-list snippet. Defined at the top level so it's
     usable from BOTH render sites: (a) the mobile index (below the
     profile hero, as a single stacked column), and (b) the desktop
     left rail (two-pane shell at ≥1024px). Same markup + same
     handlers; visual density is context-styled via the parent class
     (.settings-nav-rail vs .settings-mobile-index). -->
{#snippet sectionButtons()}
  <!-- Profile always sits at the top — it's the account-level entry
       and gets a matching hero card in the welcome pane. -->
  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'profile')} class:active={currentSection === 'profile'} aria-current={currentSection === 'profile' ? 'page' : undefined} on:click={() => toggleSection('profile')}>
    <span class="material-symbols-rounded si">person</span>
    <span>{$_('profile.title')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>

  <p class="settings-group-label">{$_('settings_page.group.display')}</p>
  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'appearance')} class:active={currentSection === 'appearance'} aria-current={currentSection === 'appearance' ? 'page' : undefined} on:click={() => toggleSection('appearance')}>
    <span class="material-symbols-rounded si">contrast</span>
    <span>{$_('settings.appearance.section')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>
  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'regional')} class:active={currentSection === 'regional'} aria-current={currentSection === 'regional' ? 'page' : undefined} on:click={() => toggleSection('regional')}>
    <span class="material-symbols-rounded si">language</span>
    <span>{$_('settings.regional.section')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>
  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'cooking')} class:active={currentSection === 'cooking'} aria-current={currentSection === 'cooking' ? 'page' : undefined} on:click={() => toggleSection('cooking')}>
    <span class="material-symbols-rounded si">soup_kitchen</span>
    <span>{$_('settings.cooking.section')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>

  <p class="settings-group-label">Data &amp; Tracking</p>
  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'nutrition')} class:active={currentSection === 'nutrition'} aria-current={currentSection === 'nutrition' ? 'page' : undefined} on:click={() => toggleSection('nutrition')}>
    <span class="material-symbols-rounded si">nutrition</span>
    <span>{$_('settings.nutrition.section')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>

  <p class="settings-group-label">{$_('settings_page.group.integrations')}</p>
  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'ai')} class:active={currentSection === 'ai'} aria-current={currentSection === 'ai' ? 'page' : undefined} on:click={() => toggleSection('ai')}>
    <span class="material-symbols-rounded si">smart_toy</span>
    <span>{$_('settings.ai.section')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>
  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'federation')} class:active={currentSection === 'federation'} aria-current={currentSection === 'federation' ? 'page' : undefined} on:click={() => toggleSection('federation')}>
    <span class="material-symbols-rounded si">hub</span>
    <span>{$_('settings.federation.section')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>
  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'foodsources')} class:active={currentSection === 'foodsources'} aria-current={currentSection === 'foodsources' ? 'page' : undefined} on:click={() => toggleSection('foodsources')}>
    <span class="material-symbols-rounded si">qr_code_scanner</span>
    <span>{$_('settings.connected_services.section')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>

  <p class="settings-group-label">App</p>
  {#if isNative}
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'serverconn')} class:active={currentSection === 'serverconn'} aria-current={currentSection === 'serverconn' ? 'page' : undefined} on:click={() => toggleSection('serverconn')}>
      <span class="material-symbols-rounded si">cloud_sync</span>
      <span>{$_('settings.server_connection.section')}</span>
      <span class="material-symbols-rounded chevron">expand_more</span>
    </button>
  {/if}
  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'notifications')} class:active={currentSection === 'notifications'} aria-current={currentSection === 'notifications' ? 'page' : undefined} on:click={() => toggleSection('notifications')}>
    <span class="material-symbols-rounded si">notifications</span>
    <span>{$_('settings.notifications.section')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>
  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'backup')} class:active={currentSection === 'backup'} aria-current={currentSection === 'backup' ? 'page' : undefined} on:click={() => toggleSection('backup')}>
    <span class="material-symbols-rounded si">backup</span>
    <span>{$_('settings.backup.section')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>
  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'import')} class:active={currentSection === 'import'} aria-current={currentSection === 'import' ? 'page' : undefined} on:click={() => toggleSection('import')}>
    <span class="material-symbols-rounded si">download</span>
    <span>{$_('settings.import.section')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>
  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'kitchens')} class:active={currentSection === 'kitchens'} aria-current={currentSection === 'kitchens' ? 'page' : undefined} on:click={() => toggleSection('kitchens')}>
    <span class="material-symbols-rounded si">cooking</span>
    <span>{$_('settings.kitchens.section')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>
  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'updates')} class:active={currentSection === 'updates'} aria-current={currentSection === 'updates' ? 'page' : undefined} on:click={() => toggleSection('updates')}>
    <span class="material-symbols-rounded si">system_update</span>
    <span>{$_('settings.updates.section')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>
  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'diagnostics')} class:active={currentSection === 'diagnostics'} aria-current={currentSection === 'diagnostics' ? 'page' : undefined} on:click={() => toggleSection('diagnostics')}>
    <span class="material-symbols-rounded si">troubleshoot</span>
    <span>{$_('settings.diagnostics.section')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>

  {#if showAdminGroup}
    <p class="settings-group-label">{$_('settings_page.group.admin')}</p>
    <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'users')} class:active={currentSection === 'users'} aria-current={currentSection === 'users' ? 'page' : undefined} on:click={() => toggleSection('users')}>
      <span class="material-symbols-rounded si">group</span>
      <span>{$_('settings.users.section')}</span>
      <span class="material-symbols-rounded chevron">expand_more</span>
    </button>
    {#if $userMgmtActive && $currentUser?.role === 'admin'}
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'auth')} class:active={currentSection === 'auth'} aria-current={currentSection === 'auth' ? 'page' : undefined} on:click={() => toggleSection('auth')}>
        <span class="material-symbols-rounded si">vpn_key</span>
        <span>{$_('settings.authentication.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
    {/if}
    {#if !$userMgmtActive || $currentUser?.role === 'admin'}
      <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'email')} class:active={currentSection === 'email'} aria-current={currentSection === 'email' ? 'page' : undefined} on:click={() => toggleSection('email')}>
        <span class="material-symbols-rounded si">mail</span>
        <span>{$_('settings.email.section')}</span>
        <span class="material-symbols-rounded chevron">expand_more</span>
      </button>
    {/if}
  {/if}

  <button class="section-toggle" class:hidden={!sectionVisible(settingsQuery, 'about')} class:active={currentSection === 'about'} aria-current={currentSection === 'about' ? 'page' : undefined} on:click={() => toggleSection('about')}>
    <span class="material-symbols-rounded si">info</span>
    <span>{$_('settings.about.section')}</span>
    <span class="material-symbols-rounded chevron">expand_more</span>
  </button>
{/snippet}

<div class="page-shell">
  <!-- Header + search bar share one sticky container so the search
       row stays flush with the header in BOTH compact and banner-on
       modes. Pinning them together as one unit removes the whole
       class of header-height vs sub-bar-top mismatch bugs. -->
  <div class="settings-sticky-top">
    <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
      {#if currentSection}
        <button class="settings-back"
                class:back-peel-in={!_leaving}
                class:back-peel-out={_leaving}
                on:click={backToIndex}
                aria-label={$_('common.back')}>
          <span class="material-symbols-rounded">arrow_back</span>
        </button>
        <h1 class:title-slide-in={!_leaving}
            class:title-slide-out={_leaving}>
          {SECTION_META[currentSection]?.titleKey ? $_(SECTION_META[currentSection].titleKey) : currentSection}
        </h1>
      {:else}
        <h1>{$_('routes.settings.title')}</h1>
      {/if}
    </header>

    <!-- Search bar renders on every settings view (index AND sub-pages).
         On sub-pages, typing filters the left rail (desktop) or drops
         back to the index with the query active (mobile). -->
    <div class="settings-search-bar">
      <span class="material-symbols-rounded settings-search-icon">search</span>
      <input class="settings-search-input" type="search" placeholder="Search settings…"
        bind:value={settingsSearch}
        on:input={_onSearchInput} />
      {#if settingsSearch}
        <button class="settings-search-clear btn-icon" on:click={() => settingsSearch = ''} title="Clear search">
          <span class="material-symbols-rounded" style="font-size:18px">close</span>
        </button>
      {/if}
    </div>
  </div>

  <div class="page-content settings-content" class:subpage-view={!!currentSection}>

    <div class="settings-two-pane">

      <!-- Left rail (desktop only, ≥1024px). Always shows the full
           section list so users can jump between sections without
           going back to the index. Hidden on mobile via CSS. -->
      <aside class="settings-nav-rail" bind:this={_railEl}>
        <!-- Sliding highlight pill (desktop rail). Mirrors LiftTrace. -->
        <div class="rail-active-pill"
             class:visible={_pillVisible}
             class:ready={_pillReady && !$disableAnimations}
             style="transform: translateY({_pillY}px); height: {_pillH}px;"
             aria-hidden="true"></div>
        {@render sectionButtons()}
        {#if _railNoMatches}
          <div class="settings-nav-empty">
            <span class="material-symbols-rounded">search_off</span>
            <p>No sections match "{settingsSearch}"</p>
            <button type="button" class="settings-nav-clear"
              on:click={() => settingsSearch = ''}>
              Clear search
            </button>
          </div>
        {/if}
      </aside>

      <!-- Right pane -->
      <div class="settings-pane">
        {#if currentSection && currentSection !== 'profile'}
          {#key currentSection}
            <div class="settings-pane-fade"
              in:fade={{ duration: $disableAnimations ? 0 : 140 }}>
              {#if currentSection === 'ai'}
                <SettingsTrace {envLocks} />
              {:else if currentSection === 'email'}
                <SettingsEmail {envLocks} />
              {:else if currentSection === 'federation'}
                <!-- Federation drills-in show BOTH the federation
                     connection card and the Import-from-NT card. -->
                <div class="section-body">
                  <SettingsFederation />
                  <SettingsImportFromNT />
                </div>
              {:else}
                <svelte:component this={SECTION_COMPONENTS[currentSection]} />
              {/if}
            </div>
          {/key}
        {:else}
          <!-- Mobile index: profile hero + full section list. When
               currentSection === 'profile', mobile drills straight
               into the Profile editor (no hero + list — that would
               be a wasted extra tap on phone). -->
          <div class="settings-mobile-index">
            {#if currentSection === 'profile'}
              <Profile />
            {:else}
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
                      <span class="profile-hero-role">{$_('settings_page.profile_hero.admin_badge')}</span>
                    {:else if !_hasName}
                      <span class="profile-hero-sub">{$_('settings_page.profile_hero.tap_to_setup')}</span>
                    {/if}
                  </div>
                  <span class="material-symbols-rounded profile-hero-chev">chevron_right</span>
                </button>
              {/if}

              {@render sectionButtons()}
              <div style="height:24px"></div>
            {/if}
          </div>

          <!-- Desktop hero: profile card + optional inline editor. The
               rail already shows the section list on desktop, so we
               don't repeat it here — just a warm entry point. -->
          <div class="settings-desktop-hero">
            {#if sectionVisible(settingsQuery, 'profile')}
              {@const _u = $currentUser || {}}
              {@const _full = (_u.full_name || '').trim()}
              {@const _displayName = (_full && _full !== 'Local User' ? _full : '') || (_u.username || '').trim() || 'My Profile'}
              {@const _hasName = _displayName !== 'My Profile'}
              {@const _initial = (_displayName[0] || '?').toUpperCase()}
              <button class="profile-hero profile-hero-expander" on:click={_toggleProfileHero}
                aria-expanded={_profileHeroExpanded}>
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
                    <span class="profile-hero-role">{$_('settings_page.profile_hero.admin_badge')}</span>
                  {:else if !_hasName}
                    <span class="profile-hero-sub">{$_('settings_page.profile_hero.tap_to_setup')}</span>
                  {/if}
                </div>
                <span class="material-symbols-rounded profile-hero-chev profile-hero-chev-toggle"
                  class:profile-hero-chev-open={_profileHeroExpanded}>expand_more</span>
              </button>
            {/if}

            {#if _profileHeroExpanded}
              <div class="profile-hero-body"
                transition:slide={{ duration: $disableAnimations ? 0 : 220 }}>
                <Profile />
              </div>
            {/if}
          </div>
        {/if}
      </div>

    </div>

  </div>
</div>

<!-- Custom color picker sheet — exact NT pattern (Hue / Saturation /
     Lightness sliders + RGB inputs + Hex). Kept at the shell level so
     SettingsAppearance's Custom swatch (which calls openColorPicker()
     from the shared store) can trigger it without needing the sliders
     re-mounted per section. -->
<Sheet bind:open={$colorPickerOpen} title="Custom Color">
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
      <label class="form-label">{$_('settings_page.custom_color.saturation')}</label>
      <div class="cp-slider-wrap">
        <input type="range" class="cp-slider cp-sat" min="0" max="100"
          bind:value={cpSat} on:input={cpUpdateFromSliders}
          style="--cp-sat-lo:hsl({cpHue},0%,{cpLgt}%);--cp-sat-hi:hsl({cpHue},100%,{cpLgt}%)" />
      </div>
    </div>

    <div class="cp-slider-group">
      <label class="form-label">{$_('settings_page.custom_color.lightness')}</label>
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
      <label class="form-label">{$_('settings_page.custom_color.hex_code')}</label>
      <div class="cp-hex-row">
        <span class="cp-hex-dot" style="background:{/^#[0-9a-fA-F]{6}$/.test(customHexInput) ? customHexInput : '#ccc'}"></span>
        <input class="input" type="text" placeholder="#rrggbb" maxlength="7"
          style="font-family:monospace;letter-spacing:0.05em;flex:1"
          bind:value={customHexInput}
          on:input={cpUpdateFromHex}
          on:keydown={e => e.key === 'Enter' && applyCustomColor()} />
      </div>
    </div>

    <button class="btn btn-primary cp-apply" on:click={applyCustomColor}>{$_('settings_page.custom_color.apply')}</button>
  </div>
</Sheet>

<style>
  .settings-content { display: flex; flex-direction: column; gap: 0; }
  /* Settings-only override: reduce horizontal page padding on phone
     widths so cards get ~10-12px more breathing room per side. Desktop
     / tablet widths (>= 768px) keep the default padding. */
  @media (max-width: 767px) {
    .settings-content { padding-left: 8px; padding-right: 8px; }
  }
  .hidden { display: none !important; }

  /* Sub-page view: hide the mobile index chrome (section-toggle rows,
     group labels, profile hero) so only the current section's body
     renders under the back-arrow header. Scoped to the mobile index
     only — on desktop the rail legitimately renders these rows even
     when a sub-section is active, so a blanket :global hide would
     nuke the rail. */
  .subpage-view .settings-mobile-index :global(.section-toggle) { display: none; }
  .subpage-view .settings-mobile-index :global(.settings-group-label) { display: none; }
  .subpage-view .settings-mobile-index :global(.profile-hero) { display: none; }
  .subpage-view :global(.section-body) { animation: none !important; }

  /* Back arrow — icon-only button, sits before the section title. */
  .settings-back {
    display: inline-flex; align-items: center; justify-content: center;
    width: 40px; height: 40px;
    margin-right: 8px;
    border: none; background: transparent; cursor: pointer;
    color: var(--text-1);
    border-radius: 50%;
    transition: background-color 120ms ease;
  }
  .settings-back:hover  { background: var(--surface-2); }
  .settings-back:active { background: var(--surface-3); }
  .settings-back .material-symbols-rounded { font-size: 24px; }

  /* Back button peel-in — the button appears to unfold from the left
     edge of the section title. Delayed 80ms so the title appears
     first, then the arrow reveals. */
  .back-peel-in {
    overflow: hidden;
    transform-origin: left center;
    animation: back-peel 320ms cubic-bezier(0.34, 1.4, 0.64, 1) 80ms both;
  }
  @keyframes back-peel {
    from { width: 0;    margin-right: 0;  opacity: 0; transform: scale(0.4); }
    to   { width: 40px; margin-right: 8px; opacity: 1; transform: scale(1);   }
  }
  .back-peel-out {
    overflow: hidden;
    transform-origin: left center;
    animation: back-peel-reverse 240ms cubic-bezier(0.4, 0, 0.6, 1) both;
  }
  @keyframes back-peel-reverse {
    from { width: 40px; margin-right: 8px; opacity: 1; transform: scale(1);   }
    to   { width: 0;    margin-right: 0;  opacity: 0; transform: scale(0.4); }
  }
  .title-slide-in {
    animation: title-slide 320ms cubic-bezier(0.34, 1.4, 0.64, 1) 80ms both;
  }
  @keyframes title-slide {
    from { opacity: 0; transform: translateX(-16px); }
    to   { opacity: 1; transform: translateX(0);      }
  }
  .title-slide-out {
    animation: title-slide-back 240ms cubic-bezier(0.4, 0, 0.6, 1) both;
  }
  @keyframes title-slide-back {
    from { opacity: 1; transform: translateX(0);      }
    to   { opacity: 0; transform: translateX(-16px); }
  }

  /* Deep-link highlight — brief pulse on the target row after a
     search-driven drill-in scroll. Box-shadow keeps layout stable. */
  :global(.setting-row.deep-link-highlight) {
    animation: deep-link-pulse 2s cubic-bezier(.2, .8, .2, 1) both;
    border-radius: 8px;
  }
  @keyframes deep-link-pulse {
    0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%,  transparent); background-color: transparent; }
    12%  { box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 45%, transparent); background-color: color-mix(in srgb, var(--accent) 14%, transparent); }
    100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%,  transparent); background-color: transparent; }
  }

  /* Sticky header + search bar — one wrapper so the two elements
     stay flush regardless of banner mode. Nested .page-header
     becomes static so it doesn't double-stick. */
  .settings-sticky-top {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--bg);
  }
  .settings-sticky-top :global(.page-header) {
    position: static;
  }
  .settings-search-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px var(--page-px, 16px) 12px;
    background: var(--glass-surface, var(--surface-1));
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 1px solid var(--border);
  }
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

  /* Profile hero — identity card at the top of Settings. */
  .profile-hero {
    display: flex; align-items: center; gap: 14px;
    width: 100%;
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

  /* Section-toggle button — shared by mobile index + desktop rail. */
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
  .settings-group-label {
    padding: 20px var(--page-px) 4px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-3);
    margin: 0;
  }
  /* Drill-in indicator: chevron always points right. */
  .chevron { font-size: 20px; color: var(--text-3); margin-left: auto; transform: rotate(-90deg); }

  /* Shared section-body wrapper — every extracted section renders
     into a `.section-body` (see NT). :global so descendants inherit. */
  :global(.section-body) { padding: 12px var(--page-px); display: flex; flex-direction: column; gap: 10px; }

  /* Shared card + row primitives — every extracted section renders
     into a `.card.settings-card` containing `.setting-row`s. Style
     lives here so descendants inherit via :global. */
  :global(.settings-card) {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  :global(.setting-row) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 13px 16px;
    min-height: 50px;
  }
  :global(.setting-row > *) { flex-shrink: 0; }
  :global(.setting-row > div), :global(.setting-row > span.setting-label) {
    flex: 1 1 0; min-width: 0;
  }
  :global(.setting-row > .select-wrap),
  :global(.setting-row > .seg-group),
  :global(.setting-row > .env-lock-pill),
  :global(.setting-row > .sr-control) {
    flex: 0 0 auto;
  }
  /* Column-direction rows reset — children should take natural height. */
  :global(.setting-row[style*="flex-direction:column"] > div),
  :global(.setting-row[style*="flex-direction: column"] > div),
  :global(.setting-row[style*="flex-direction:column"] > span.setting-label),
  :global(.setting-row[style*="flex-direction: column"] > span.setting-label) {
    flex: 0 0 auto;
    min-width: auto;
  }
  :global(.setting-label), :global(.setting-desc) { word-break: break-word; overflow-wrap: anywhere; }
  :global(.setting-label) { font-size: 14px; color: var(--text-1); display: block; }
  :global(.setting-desc)  { font-size: 12px; color: var(--text-3); margin-top: 4px; line-height: 1.4; display: block; }
  :global(.setting-divider) { height: 1px; background: var(--border); margin: 0 16px; }

  :global(.sub-label) {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
    padding: 4px 2px 2px;
  }

  /* Grouped-card heading + subtitle (used by Phase B sub-pages in NT,
     kept as :global for future CT sub-page migrations). */
  :global(.settings-group-heading) {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-3);
    margin: 20px 4px 4px;
  }
  :global(.settings-group-heading:first-child) { margin-top: 4px; }
  :global(.settings-group-sub) {
    font-size: 12px;
    color: var(--text-3);
    line-height: 1.4;
    margin: 0 4px 10px;
    max-width: 640px;
  }
  :global(.sel-sm) { height: 36px; font-size: 13px; width: 100%; max-width: 100%; }

  /* Chips + env-lock banner + seg-control + spin — parity with NT for
     shared descendant styling. */
  :global(.env-lock-banner) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: var(--radius-md);
    font-size: 12px;
    color: var(--text-2);
    margin-bottom: 4px;
  }
  :global(.env-lock-banner .material-symbols-rounded) { font-size: 16px; color: var(--accent); flex-shrink: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  :global(.spin) { animation: spin 1s linear infinite; display: inline-block; }

  /* Two-pane base (mobile default). */
  .settings-two-pane { display: block; }
  .settings-nav-rail,
  .settings-desktop-hero { display: none; }
  .settings-mobile-index { display: block; }

  @media (min-width: 1024px) {
    :global(html:not(.force-mobile-layout)) .settings-two-pane {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      gap: 24px;
      align-items: start;
    }

    :global(html:not(.force-mobile-layout)) .settings-nav-rail {
      display: flex;
      flex-direction: column;
      gap: 2px;
      position: sticky;
      isolation: isolate;
      top: calc(var(--page-top, var(--safe-top)) + 130px + var(--hamburger-row, 0px));
      max-height: calc(100vh
        - var(--page-top, var(--safe-top))
        - 150px
        - var(--hamburger-row, 0px)
        - var(--nav-h, 0px)
        - var(--safe-bottom, 0px));
      overflow-y: auto;
      padding: 10px 8px;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail :global(.section-toggle) {
      background: transparent;
      border: none;
      min-height: 36px;
      padding: 8px 10px;
      border-radius: var(--radius-md);
      font-size: 13px;
      gap: 10px;
      position: relative;
      z-index: 1;
      transition: color 160ms ease;
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail :global(.section-toggle:hover) {
      background: var(--surface-2);
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail :global(.section-toggle.active) {
      background: transparent;
      color: var(--accent);
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail .rail-active-pill {
      position: absolute;
      left: 8px;
      right: 8px;
      top: 0;
      border-radius: var(--radius-md);
      background: var(--accent-dim);
      pointer-events: none;
      opacity: 0;
      z-index: 0;
      will-change: transform, height;
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail .rail-active-pill.visible {
      opacity: 1;
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail .rail-active-pill.ready {
      transition:
        transform 320ms cubic-bezier(0.32, 0.72, 0, 1),
        height 260ms cubic-bezier(0.32, 0.72, 0, 1),
        opacity 180ms ease;
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail :global(.section-toggle:focus-visible) {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
      background: var(--surface-2);
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail :global(.section-toggle .si) {
      width: 24px;
      height: 24px;
      font-size: 18px;
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail :global(.section-toggle .chevron) { display: none; }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail :global(.settings-group-label) {
      margin: 12px 4px 4px;
      font-size: 10px;
      letter-spacing: 0.1em;
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail :global(.settings-group-label:first-child) {
      margin-top: 2px;
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail .settings-nav-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 24px 12px;
      text-align: center;
      color: var(--text-3);
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail .settings-nav-empty :global(.material-symbols-rounded) {
      font-size: 28px;
      opacity: 0.7;
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail .settings-nav-empty p {
      margin: 0;
      font-size: 12px;
      line-height: 1.4;
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail .settings-nav-clear {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-2);
      padding: 4px 10px;
      border-radius: var(--radius-full);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    :global(html:not(.force-mobile-layout)) .settings-nav-rail .settings-nav-clear:hover {
      background: var(--surface-2);
      color: var(--text-1);
    }

    /* Desktop-only vs mobile-only content in the pane. */
    :global(html:not(.force-mobile-layout)) .settings-mobile-index { display: none; }
    :global(html:not(.force-mobile-layout)) .settings-desktop-hero { display: block; }
  }

  /* Desktop welcome hero: profile card is expandable inline. */
  .profile-hero-expander { cursor: pointer; }
  .profile-hero-chev-toggle { transition: transform 160ms ease; }
  .profile-hero-chev-open { transform: rotate(180deg); }
  .profile-hero-body { margin-top: 12px; }

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
