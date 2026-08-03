<script>
  /**
   * Manage — single-destination hub for every taxonomy in CookTrace.
   *
   * Left rail picks a section, right pane renders that section's
   * editor. Sections without a dedicated editor yet (Custom Units,
   * Cookbooks) show a "coming soon" stub so users know they're on
   * the roadmap.
   *
   * Route param `section` lets deep-links land directly on a section
   * (e.g. /manage/tags from a "Manage tags" link in RecipeEditor).
   */
  import { _ } from 'svelte-i18n';
  import { push } from 'svelte-spa-router';
  import { pageBanners, bannerStyle } from '../stores/settings.js';
  import { NtApi } from '../lib/api.js';
  import ManageRecipeCategories from '../components/manage/ManageRecipeCategories.svelte';
  import ManagePantryCategories from '../components/manage/ManagePantryCategories.svelte';
  import ManageTaxonomyList     from '../components/manage/ManageTaxonomyList.svelte';
  import ManageUnits            from '../components/manage/ManageUnits.svelte';
  import ManageCookbooks        from '../components/manage/ManageCookbooks.svelte';

  export let params = {};

  // Section catalog. Order matches the rail.
  const SECTIONS = [
    { id: 'recipe-categories', label: 'Recipe Categories', icon: 'label',
      desc: 'One-of badges that appear above each recipe title.' },
    { id: 'tags',              label: 'Tags',              icon: 'sell',
      desc: 'Free-form descriptors. Many per recipe.' },
    { id: 'kitchen-gear',      label: 'Kitchen Gear',      icon: 'blender',
      desc: 'Tools used in recipes — pots, pans, spatulas, parchment, anything you reach for.' },
    { id: 'pantry-categories', label: 'Pantry Categories', icon: 'kitchen',
      desc: 'Sections for grouping the pantry list.' },
    { id: 'units',             label: 'Units',             icon: 'straighten',
      desc: 'Cooking units. Disable built-ins or add custom ones.' },
    { id: 'cookbooks',         label: 'Cookbooks',         icon: 'auto_stories',
      desc: 'User-curated collections of recipes.' },
  ];

  // Default to the first section if no param. URL stays in sync as the
  // user clicks rail entries.
  // activeId is LOCAL state, not derived from params. We init from
  // params.section once on mount and then own it. Switching sections
  // updates the URL via history.replaceState so deep-links + back/
  // forward still work, but svelte-spa-router never sees the change
  // (which would force the {#key $location} block in App.svelte to
  // unmount + remount the whole page, replaying the banner anim and
  // resetting the rail pill measurements). End result: page stays
  // mounted, only the right pane swaps and the pill slides.
  let activeId = (params.section && SECTIONS.some(s => s.id === params.section))
    ? params.section
    : 'recipe-categories';
  $: activeSection = SECTIONS.find(s => s.id === activeId);

  function pickSection(id) {
    if (id === activeId) return;
    activeId = id;
    if (typeof window !== 'undefined') {
      const next = `#/manage/${id}`;
      if (window.location.hash !== next) {
        window.history.replaceState(null, '', next);
      }
    }
  }

  // Sliding rail pill — JS-measured so it works for both the vertical
  // desktop rail and the horizontal mobile chip row. Positions an
  // absolute ::pill behind the active rail item via x/y/w/h CSS vars.
  let railEl = null;
  let railRefs = {};
  let railX = 0, railY = 0, railW = 0, railH = 0;
  let railReady = false;
  function _measureRail() {
    if (!railEl) return;
    const btn = railRefs[activeId];
    if (!btn) return;
    const c = railEl.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    railX = b.left - c.left + railEl.scrollLeft;
    railY = b.top  - c.top  + railEl.scrollTop;
    railW = b.width;
    railH = b.height;
    railReady = true;
  }
  $: if (activeId) {
    if (typeof window !== 'undefined') requestAnimationFrame(_measureRail);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => requestAnimationFrame(_measureRail));
  }
</script>

<div class="page-shell manage-page">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('manage_ct.title')}</h1>
  </header>

  <div class="manage-body">
    <nav class="rail" aria-label="Manage sections" bind:this={railEl}
      style="--rail-x:{railX}px; --rail-y:{railY}px; --rail-w:{railW}px; --rail-h:{railH}px">
      {#if railReady}<span class="rail-pill" aria-hidden="true"></span>{/if}
      {#each SECTIONS as s (s.id)}
        <button
          class="rail-item"
          class:active={activeId === s.id}
          bind:this={railRefs[s.id]}
          on:click={() => pickSection(s.id)}
          aria-pressed={activeId === s.id}
        >
          <span class="material-symbols-rounded">{s.icon}</span>
          <span class="rail-text">
            <span class="rail-label">{s.label}</span>
            <span class="rail-desc">{s.desc}</span>
          </span>
        </button>
      {/each}
    </nav>

    <!-- Pane swap is direct (no {#key}) so the page-header banner
         stays mounted and the rail pill is the only visible motion
         when the user picks a section. Each panel does its own
         loading internally. -->
    <main class="pane">
      {#if activeId === 'recipe-categories'}
        <ManageRecipeCategories />
      {:else if activeId === 'pantry-categories'}
        <ManagePantryCategories />
      {:else if activeId === 'tags'}
        <ManageTaxonomyList
          title="Tags"
          description="Free-form descriptors users add to recipes (vegan, italian, weeknight). Renaming or deleting cascades through every recipe that uses it."
          loadFn={() => NtApi.getRecipeTags()}
          renameFn={(o, n) => NtApi.renameRecipeTag(o, n)}
          deleteFn={(name) => NtApi.deleteRecipeTag(name)}
        />
      {:else if activeId === 'kitchen-gear'}
        <ManageTaxonomyList
          title="Kitchen Gear"
          description="Tools users list on recipes — pans, spatulas, mixers, parchment paper, sheet trays, anything they reach for. Renaming or deleting cascades through every recipe."
          loadFn={() => NtApi.getRecipeTools()}
          renameFn={(o, n) => NtApi.renameRecipeTool(o, n)}
          deleteFn={(name) => NtApi.deleteRecipeTool(name)}
        />
      {:else if activeId === 'units'}
        <ManageUnits />
      {:else if activeId === 'cookbooks'}
        <ManageCookbooks />
      {/if}
    </main>
  </div>
</div>

<style>
  .manage-page { padding-bottom: 24px; }

  /* Two-column body. Stacks on mobile so the rail becomes a horizontal
     chip-row at the top. */
  .manage-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 16px var(--page-px) 24px;
    max-width: 1280px;
    margin: 0 auto;
    box-sizing: border-box;
    width: 100%;
  }
  @media (min-width: 880px) {
    .manage-body {
      display: grid;
      grid-template-columns: 280px 1fr;
      gap: 24px;
      align-items: flex-start;
    }
  }

  /* Mobile rail — horizontal scroll of label-only chips. Desktop rail
     is a vertical list with icon + label + description. */
  .rail {
    position: relative;
    display: flex;
    gap: 8px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding-bottom: 4px;
  }
  /* Sliding pill that animates between rail items. Sized + positioned
     by JS-measured CSS vars (--rail-x/y/w/h). Spring transition for
     a smooth feel; overlaps the active item visually. */
  .rail-pill {
    position: absolute;
    left: 0;
    top: 0;
    width: var(--rail-w, 0px);
    height: var(--rail-h, 0px);
    transform: translate(var(--rail-x, 0px), var(--rail-y, 0px));
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
    border-radius: var(--radius-md);
    transition: transform var(--dur-base) var(--ease-spring),
                width var(--dur-base) var(--ease-spring),
                height var(--dur-base) var(--ease-spring);
    pointer-events: none;
    z-index: 0;
  }
  .rail::-webkit-scrollbar { display: none; }
  .rail-item {
    position: relative;
    z-index: 1;
    flex-shrink: 0;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    transition: color var(--dur-fast), background var(--dur-fast), border-color var(--dur-fast);
  }
  .rail-item .material-symbols-rounded { font-size: 18px; flex-shrink: 0; }
  .rail-item .rail-desc { display: none; }
  .rail-item:hover { background: var(--surface-2); color: var(--text-1); }
  /* Active state — the actual highlight is the floating .rail-pill
     behind. We just match the text/border color so the item reads
     correctly while the pill slides. */
  .rail-item.active {
    background: transparent;
    border-color: transparent;
    color: var(--accent);
  }

  @media (min-width: 880px) {
    .rail {
      flex-direction: column;
      gap: 4px;
      overflow: visible;
      padding: 0;
      position: sticky;
      top: 16px;
    }
    .rail-item {
      width: 100%;
      box-sizing: border-box;
      align-items: flex-start;
      padding: 12px 14px;
      text-align: left;
    }
    .rail-item .rail-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .rail-item .rail-label { font-size: 14px; }
    .rail-item .rail-desc {
      display: block;
      font-size: 11px;
      font-weight: 500;
      color: var(--text-3);
      line-height: 1.3;
    }
    .rail-item.active .rail-desc { color: var(--accent); opacity: 0.8; }
    .rail-item .material-symbols-rounded { margin-top: 1px; }

    /* Left-edge fill on the active item — same accent stripe pattern
       the Sidebar's active-indicator and the Recipes category cards
       use, so the selection reads instantly on the desktop rail.
       Mobile rail keeps the plain pill since "left border" doesn't
       apply to a horizontal chip row. */
    .rail-pill {
      border-left-width: 3px;
      border-top-left-radius: 0;
      border-bottom-left-radius: 0;
    }
  }

  /* Right pane gets a card surface. */
  .pane {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    min-height: 320px;
  }

  .coming-soon {
    text-align: center;
    padding: 60px 16px;
    color: var(--text-3);
  }
  .coming-soon .material-symbols-rounded {
    font-size: 56px;
    color: var(--accent);
    opacity: 0.6;
    margin-bottom: 8px;
  }
  .coming-soon h2 {
    margin: 8px 0 6px;
    color: var(--text-1);
    font-size: 20px;
  }
  .coming-soon p {
    max-width: 480px;
    margin: 0 auto;
    font-size: 14px;
    line-height: 1.5;
  }
</style>
