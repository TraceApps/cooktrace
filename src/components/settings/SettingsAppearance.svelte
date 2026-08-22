<script>
  // Appearance section — extracted from the Settings.svelte monolith.
  // Renders theme, accent, navigation style, persistent sidebar (gated
  // by viewport width), start page, reduce motion, page banners + the
  // optional banner-animation dropdown, and the new Force Mobile Layout
  // toggle. The custom-color Sheet lives at the shell level (Settings
  // .svelte) so the "Custom" accent swatch nudges the shared
  // color-picker store to open it.
  import { _ } from 'svelte-i18n';
  import { applyAppearance, applyAccentColor } from '../../stores/settings.js';
  import {
    appearance, accentColor, navStyle, sidebarPersistent, disableAnimations,
    bannerStyle, bannerAnimation, startPage, forceMobileLayout,
  } from '../../stores/settings.js';
  import { openColorPicker } from '../../stores/color-picker.js';

  // Theme / accent options — mirror NT exactly.
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

  // Track viewport width reactively so the persistent-sidebar toggle
  // hides on phones (and reappears if the user rotates a tablet to
  // landscape, etc.). Threshold matches App.svelte's _persistentAllowed
  // (768px = standard tablet).
  let _viewportW = typeof window !== 'undefined' ? window.innerWidth : 1024;
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => { _viewportW = window.innerWidth; });
  }
  $: _persistentAllowed = _viewportW >= 768;
</script>

<div class="section-body">
  <div class="card settings-card">
    <div class="setting-row">
      <span class="setting-label">{$_('settings_page.appearance.theme')}</span>
      <div class="select-wrap" style="width:160px">
        <select class="select sel-sm" value={$appearance} on:change={e => applyAppearance(e.target.value)}>
          {#each APPEARANCE_OPTS as o}<option value={o.value}>{o.label}</option>{/each}
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row" style="align-items:flex-start;flex-direction:column;gap:10px">
      <span class="setting-label">{$_('settings_page.appearance.accent_color')}</span>
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
          on:click={openColorPicker}>
          <span class="material-symbols-rounded" style="font-size:16px;color:rgba(255,255,255,0.9);text-shadow:0 0 3px rgba(0,0,0,0.5)">colorize</span>
        </button>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings_page.appearance.navigation_style')}</span>
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
          <span class="setting-label">{$_('settings_page.appearance.persistent_sidebar')}</span>
          <div class="setting-desc">Sidebar stays open and shifts page content instead of overlaying it.</div>
        </div>
        <input type="checkbox" class="toggle-cb" checked={$sidebarPersistent} on:change={e => sidebarPersistent.set(e.target.checked)} />
      </div>
    {/if}
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">Force Mobile Layout</span>
        <div class="setting-desc">Keep the mobile single-column layout even on wide screens.</div>
      </div>
      <input type="checkbox" class="toggle-cb" checked={$forceMobileLayout} on:change={e => forceMobileLayout.set(e.target.checked)} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings_page.appearance.start_page')}</span>
      <div class="select-wrap" style="width:160px">
        <select class="select sel-sm" value={$startPage} on:change={e => startPage.set(e.target.value)}>
          {#each START_PAGE_OPTS as o}<option value={o.value}>{o.label}</option>{/each}
        </select>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings_page.appearance.reduce_motion')}</span>
      <input type="checkbox" class="toggle-cb" checked={$disableAnimations} on:change={e => disableAnimations.set(e.target.checked)} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.appearance.page_banners')}</span>
        <div class="setting-desc">Header style at the top of every page. Animated is a compact accent-gradient bar with a chosen motion style; Gradient is the same bar, static; Off is a plain glass header.</div>
      </div>
      <div class="select-wrap" style="width:130px">
        <select class="select sel-sm" value={$bannerStyle} on:change={e => bannerStyle.set(e.currentTarget.value)}>
          <option value="animated">{$_('settings_page.appearance.banner_animated')}</option>
          <option value="gradient">{$_('settings_page.appearance.banner_gradient')}</option>
          <option value="off">Off</option>
        </select>
      </div>
    </div>
    {#if $bannerStyle === 'animated'}
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_page.appearance.animation_style')}</span>
          <div class="setting-desc">Shimmer is a soft white sweep, Drift is a slow hue rotation, Pulse is a gentle breathing, Aurora is a soft accent-tinted cloud-of-light. All honour Reduce Motion.</div>
        </div>
        <div class="select-wrap" style="width:130px">
          <select class="select sel-sm" value={$bannerAnimation} on:change={e => bannerAnimation.set(e.currentTarget.value)}>
            <option value="shimmer">{$_('settings_page.appearance.anim_shimmer')}</option>
            <option value="drift">{$_('settings_page.appearance.anim_drift')}</option>
            <option value="pulse">{$_('settings_page.appearance.anim_pulse')}</option>
            <option value="aurora">{$_('settings_page.appearance.anim_aurora')}</option>
          </select>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* Accent-swatch styles live with the section that owns them so the
     rules travel with the extract. Mirrors NT. */
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

  /* Local copies of the select + toggle-cb primitives so this section
     stays visually correct when rendered under the shell's :global
     styles (which cover .settings-card + .setting-row + .setting-label
     etc.) but need the widget affordances too. Scoped so they don't
     override sibling sections. */
  .select-wrap { position: relative; display: inline-block; }
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
</style>
