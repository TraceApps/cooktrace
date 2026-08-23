<script>
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { fade, slide } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { pageBanners, bannerStyle } from '../stores/settings.js';
  import { NtApi } from '../lib/api.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { localDateStr } from '../lib/db.js';
  import { relativeTime, shortDate } from '../lib/relative-time.js';
  import ActionSheet from '../components/ui/ActionSheet.svelte';
  import DateInput from '../components/ui/DateInput.svelte';
  import CookHeatmap from '../components/diary/CookHeatmap.svelte';
  import { longpress } from '../lib/long-press.js';
  import { resolveAssetUrl } from '../lib/platform.js';

  let entries = [];
  let loading = true;
  let loadError = null;
  let view = 'list';                    // 'list' | 'month' | 'photos'

  // Recipe filter — when set, narrows list / month / photos views to a
  // single recipe. Picker reuses the planRecipes list (loaded lazily).
  let filterRecipeId = null;
  let filterPickerOpen = false;
  let filterSearch = '';
  $: filterRecipe = filterRecipeId
    ? (planRecipes.find(r => r.id === filterRecipeId)
       || entries.find(e => e.recipe_id === filterRecipeId)
       || null)
    : null;
  $: filterRecipeName = filterRecipe
    ? (filterRecipe.name || filterRecipe.recipe_name || 'Recipe')
    : '';
  // All view branches read from displayEntries so the recipe filter
  // applies uniformly to List / Month / Photos.
  $: displayEntries = filterRecipeId
    ? entries.filter(e => e.recipe_id === filterRecipeId)
    : entries;

  async function openFilterPicker() {
    filterPickerOpen = true;
    filterSearch = '';
    if (planRecipes.length === 0) {
      try {
        const list = await NtApi.getRecipes();
        planRecipes = list.slice().sort((a, b) =>
          (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' })
        );
      }
      catch { planRecipes = []; }
    }
  }
  function pickFilterRecipe(id) {
    filterRecipeId = id;
    filterPickerOpen = false;
  }
  function clearFilter() { filterRecipeId = null; }

  $: filteredFilterRecipes = filterSearch.trim()
    ? planRecipes.filter(r => (r.name || '').toLowerCase().includes(filterSearch.trim().toLowerCase()))
    : planRecipes;

  // Multi-photo entries store `photos` as a JSON array. Older single-
  // photo rows only have `photo_url`. Hydrate to an array consistently.
  function _entryPhotos(e) {
    if (!e) return [];
    if (Array.isArray(e.photos)) return e.photos.filter(Boolean);
    if (typeof e.photos === 'string' && e.photos) {
      try {
        const arr = JSON.parse(e.photos);
        if (Array.isArray(arr) && arr.length) return arr.filter(Boolean);
      } catch {}
    }
    return e.photo_url ? [e.photo_url] : [];
  }

  // Lightbox state — references the entry plus which photo index is
  // currently shown (entries can have multiple photos).
  let lightboxEntry = null;
  let lightboxIndex = 0;
  $: lightboxPhotos = _entryPhotos(lightboxEntry);
  $: lightboxPhoto  = lightboxPhotos[lightboxIndex] || null;
  function openLightbox(e, idx = 0) { lightboxEntry = e; lightboxIndex = idx; }
  function closeLightbox() { lightboxEntry = null; lightboxIndex = 0; }
  function lightboxPrev() {
    if (!lightboxPhotos.length) return;
    lightboxIndex = (lightboxIndex - 1 + lightboxPhotos.length) % lightboxPhotos.length;
  }
  function lightboxNext() {
    if (!lightboxPhotos.length) return;
    lightboxIndex = (lightboxIndex + 1) % lightboxPhotos.length;
  }

  // Stats card — derived server-side from cook_diary so the counts /
  // streak math stays correct regardless of which date window the
  // list view has loaded. Null while initially fetching.
  let stats = null;
  async function loadStats() {
    try { stats = await NtApi.getCookDiaryStats(); }
    catch { stats = null; }
  }

  // Heatmap — daily cook counts for the last 52 weeks. Independent of
  // the list/month entries fetch so we don't have to round-trip when
  // the user switches views.
  let heatmap = [];
  async function loadHeatmap() {
    try { heatmap = await NtApi.getCookDiaryHeatmap(364); }
    catch { heatmap = []; }
  }
  function onHeatmapCellClick(ev) {
    const iso = ev.detail?.date;
    if (!iso) return;
    // Jump the Month view to the clicked date's month so the user can
    // see what they cooked. Switching view re-fetches via the existing
    // $: reactive load() statement.
    const d = new Date(iso + 'T00:00:00');
    monthAnchor = new Date(d.getFullYear(), d.getMonth(), 1);
    view = 'month';
  }

  // Sliding-pill geometry — measured from the active button so the
  // pill matches its real width regardless of label length.
  let segContainer = null;
  let segBtns = [];
  let segX = 0;
  let segW = 0;
  function _measureSegPill() {
    if (!segContainer) return;
    const idx = view === 'list' ? 0 : view === 'month' ? 1 : 2;
    const btn = segBtns[idx];
    if (!btn) return;
    const cRect = segContainer.getBoundingClientRect();
    const bRect = btn.getBoundingClientRect();
    segX = bRect.left - cRect.left;
    segW = bRect.width;
  }
  $: if (view) {
    if (typeof window !== 'undefined') requestAnimationFrame(_measureSegPill);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => requestAnimationFrame(_measureSegPill));
  }

  // Month view anchor — the first of the visible month.
  let monthAnchor = (() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  })();

  // List view: load everything from the beginning of time forward
  // through one month out. Earlier versions windowed to 60 days back
  // to keep the initial load fast, but that silently hides imported
  // history from sources like Mealie that go back years. Modern
  // SQLite + the json-blob-per-recipe shape comfortably handles
  // many-thousand-row diary loads, so no real cost to dropping the
  // back-cap.
  $: rangeFrom = '1970-01-01';
  $: rangeTo = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return _isoDate(d);
  })();

  function _isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  async function load() {
    loading = true;
    loadError = null;
    try {
      // Pull a wide window so both list + month view share data.
      const monthFrom = _isoDate(new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() - 1, 1));
      const monthTo   = _isoDate(new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + 2, 0));
      const from = view === 'month' ? monthFrom : rangeFrom;
      const to   = view === 'month' ? monthTo   : rangeTo;
      entries = await NtApi.getCookDiary({ from, to });
    } catch (e) {
      loadError = e.message || 'Could not load diary';
      showError(loadError);
    } finally {
      loading = false;
    }
  }
  onMount(() => { load(); loadStats(); loadHeatmap(); });
  $: if (monthAnchor || view) { /* trigger reload on view change */ load(); }

  // Group list-view entries by date (descending — future first, then past).
  $: groupedByDate = (() => {
    const map = new Map();
    for (const e of displayEntries) {
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date).push(e);
    }
    const today = _isoDate(new Date());
    return [...map.entries()]
      .sort((a, b) => {
        // Planned (future) at top, today next, past below.
        const aPlanned = a[0] >= today, bPlanned = b[0] >= today;
        if (aPlanned !== bPlanned) return aPlanned ? -1 : 1;
        return a[0] < b[0] ? 1 : -1; // recent first within each block
      });
  })();

  $: todayIso = _isoDate(new Date());

  // Photos view — flatten every photo into its own tile so multi-photo
  // entries don't lose their extras. Newest first; ties broken by
  // created_at so the original capture order shows up correctly.
  $: photoTiles = (() => {
    const tiles = [];
    for (const e of displayEntries) {
      const photos = _entryPhotos(e);
      for (let i = 0; i < photos.length; i++) {
        tiles.push({ entry: e, url: photos[i], index: i, count: photos.length });
      }
    }
    tiles.sort((a, b) => {
      if (a.entry.date !== b.entry.date) return a.entry.date < b.entry.date ? 1 : -1;
      const ca = (b.entry.created_at || '').localeCompare(a.entry.created_at || '');
      return ca !== 0 ? ca : a.index - b.index;
    });
    return tiles;
  })();

  // Month grid cells (6 weeks × 7 days)
  $: monthCells = (() => {
    const first = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), 1);
    const startOffset = first.getDay(); // 0 = Sun
    const start = new Date(first);
    start.setDate(start.getDate() - startOffset);
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = _isoDate(d);
      cells.push({
        date: iso,
        day: d.getDate(),
        inMonth: d.getMonth() === monthAnchor.getMonth(),
        isToday: iso === todayIso,
        items: displayEntries.filter(e => e.date === iso),
      });
    }
    return cells;
  })();

  function prevMonth() { monthAnchor = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() - 1, 1); }
  function nextMonth() { monthAnchor = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + 1, 1); }

  // Add planned dialog state
  let planOpen = false;
  let planDate = todayIso;
  let planRecipeId = null;
  let planMealType = null;  // 'breakfast' | 'lunch' | 'dinner' | 'snack' | null
  let planRecipes = [];     // user's recipes for the picker
  let planSearch = '';
  let planBusy = false;
  const PLAN_MEAL_TYPES = [
    { id: 'breakfast', label: 'Breakfast', icon: 'free_breakfast' },
    { id: 'lunch',     label: 'Lunch',     icon: 'lunch_dining'   },
    { id: 'dinner',    label: 'Dinner',    icon: 'restaurant'     },
    { id: 'snack',     label: 'Snack',     icon: 'cookie'         },
  ];
  function _mealLabel(id) {
    const m = PLAN_MEAL_TYPES.find(x => x.id === id);
    return m ? m.label : '';
  }
  function _mealIcon(id) {
    const m = PLAN_MEAL_TYPES.find(x => x.id === id);
    return m ? m.icon : 'restaurant';
  }

  async function openPlan() {
    planOpen = true;
    planDate = todayIso;
    planRecipeId = null;
    planMealType = null;
    planSearch = '';
    if (planRecipes.length === 0) {
      try {
        const list = await NtApi.getRecipes();
        planRecipes = list.slice().sort((a, b) =>
          (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' })
        );
      }
      catch { planRecipes = []; }
    }
  }
  $: filteredPlanRecipes = planSearch.trim()
    ? planRecipes.filter(r => r.name.toLowerCase().includes(planSearch.trim().toLowerCase()))
    : planRecipes;

  async function savePlan() {
    if (!planRecipeId) { showError($_('cookdiary_page.toast.pick_recipe')); return; }
    planBusy = true;
    try {
      await NtApi.createDiaryEntry({
        recipe_id: planRecipeId,
        date: planDate,
        kind: 'planned',
        meal_type: planMealType || null,
      });
      showSuccess($_('cookdiary_page.toast.planned'));
      planOpen = false;
      await load();
      loadStats();
      loadHeatmap();
    } catch (e) {
      showError(e.message || 'Could not plan');
    } finally {
      planBusy = false;
    }
  }

  async function markPlannedAsCooked(entry) {
    try {
      await NtApi.updateDiaryEntry(entry.id, { kind: 'cooked' });
      showSuccess($_('cookdiary_page.toast.marked_cooked'));
      await load();
      loadStats();
      loadHeatmap();
    } catch (e) {
      showError(e.message || 'Could not update');
    }
  }

  // ── Long-press / right-click action sheet ─────────────────────────
  let actionSheetOpen = false;
  let actionSheetEntry = null;
  function onEntryLongPress(e) {
    actionSheetEntry = e;
    actionSheetOpen = true;
  }
  $: entryActions = actionSheetEntry ? [
    ...(actionSheetEntry.recipe_id ? [{ label: 'Open Recipe', icon: 'open_in_new', value: 'open' }] : []),
    ...(actionSheetEntry.kind === 'planned'
      ? [{ label: 'Mark as Cooked', icon: 'restaurant', value: 'cooked' }]
      : []),
    { label: 'Delete', icon: 'delete', value: 'delete', danger: true },
  ] : [];
  async function onEntryAction(ev) {
    const v = ev.detail?.value;
    const e = actionSheetEntry;
    actionSheetEntry = null;
    if (!e) return;
    if (v === 'open' && e.recipe_id) push(`/recipes/${e.recipe_id}`);
    else if (v === 'cooked') await markPlannedAsCooked(e);
    else if (v === 'delete') await removeEntry(e);
  }

  async function removeEntry(entry) {
    const ok = await confirmDialog({
      title: entry.kind === 'planned' ? 'Cancel planned cook?' : 'Delete cook entry?',
      message: `${entry.recipe_name || 'Recipe'} on ${shortDate(entry.date)}`,
      confirmText: 'Remove',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.deleteDiaryEntry(entry.id);
      showSuccess($_('cookdiary_page.toast.removed'));
      await load();
      loadStats();
      loadHeatmap();
    } catch (e) {
      showError(e.message || 'Delete failed');
    }
  }
</script>

<div class="page-shell">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('routes.diary.title')}</h1>
    <button class="btn-icon header-action" on:click={openPlan} aria-label="Plan a Cook" title="Plan a Cook">
      <span class="material-symbols-rounded">event_available</span>
    </button>
  </header>

  <div class="page-content">
    <!-- Dashboard — heatmap + stats card. Stacks on mobile (heatmap
         first, then 4-tile strip). Goes side-by-side on wide screens
         so the two summaries share one row instead of forming a tall
         column above the actual diary. -->
    {#if stats && stats.total_cooks > 0}
    <div class="diary-dashboard" transition:fade={{ duration: 160 }}>
      <CookHeatmap data={heatmap} on:select={onHeatmapCellClick} />
      <div class="stats-card">
        <div class="stat-tile">
          <span class="stat-value">{stats.cooks_this_week}</span>
          <span class="stat-label">{$_('cookdiary_page.this_week')}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-value">
            {stats.current_streak}
            {#if stats.current_streak > 0}<span class="stat-flame material-symbols-rounded">local_fire_department</span>{/if}
          </span>
          <span class="stat-label">{$_('cookdiary_page.current_streak')}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-value">{stats.longest_streak}</span>
          <span class="stat-label">{$_('cookdiary_page.longest_streak')}</span>
        </div>
        {#if stats.top_recipe}
          <button class="stat-tile stat-link"
            on:click={() => push(`/recipes/${stats.top_recipe.id}`)}
            title="Open recipe">
            <span class="stat-value stat-top-name">{stats.top_recipe.name}</span>
            <span class="stat-label">Most Cooked This Month · {stats.top_recipe.count}×</span>
          </button>
        {:else}
          <div class="stat-tile">
            <span class="stat-value">{stats.cooks_this_month}</span>
            <span class="stat-label">{$_('cookdiary_page.this_month')}</span>
          </div>
        {/if}
      </div>
    </div>
    {/if}

    <!-- Sticky toolbar wraps the view switcher + month nav + filter row
         so they follow the user down long day-groups on wide screens.
         Matches the Shopping / Manage / Settings sticky-toolbar pattern. -->
    <div class="diary-toolbar">
    <!-- View switcher -->
    <div class="view-switch">
      <div class="view-chips" role="radiogroup" aria-label="View"
        bind:this={segContainer}
        style="--seg-x:{segX}px; --seg-w:{segW}px">
        <span class="seg-pill" aria-hidden="true"></span>
        <button class="seg" class:active={view === 'list'}   on:click={() => view = 'list'}   aria-pressed={view === 'list'}   bind:this={segBtns[0]}>{$_('cookdiary_page.view_list')}</button>
        <button class="seg" class:active={view === 'month'}  on:click={() => view = 'month'}  aria-pressed={view === 'month'}  bind:this={segBtns[1]}>{$_('cookdiary_page.view_month')}</button>
        <button class="seg" class:active={view === 'photos'} on:click={() => view = 'photos'} aria-pressed={view === 'photos'} bind:this={segBtns[2]}>{$_('cookdiary_page.view_photos')}</button>
      </div>
      {#if view === 'month'}
        <div class="month-nav">
          <button class="btn-icon" on:click={prevMonth} aria-label="Previous month"><span class="material-symbols-rounded">chevron_left</span></button>
          <span class="month-label">{monthAnchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
          <button class="btn-icon" on:click={nextMonth} aria-label="Next month"><span class="material-symbols-rounded">chevron_right</span></button>
        </div>
      {/if}
    </div>

    <!-- Recipe filter chip — applies across List / Month / Photos. -->
    <div class="filter-row">
      {#if filterRecipeId}
        <span class="filter-chip active" transition:fade={{ duration: 120 }}>
          <span class="material-symbols-rounded">filter_alt</span>
          <span class="filter-chip-name">{filterRecipeName || 'Recipe'}</span>
          <button class="filter-clear" on:click={clearFilter} aria-label="Clear recipe filter">
            <span class="material-symbols-rounded">close</span>
          </button>
        </span>
      {:else}
        <button class="filter-chip" on:click={openFilterPicker}>
          <span class="material-symbols-rounded">filter_alt</span>
          Filter by Recipe
        </button>
      {/if}
    </div>
    </div>

    {#if loading}
      <div class="state"><span class="material-symbols-rounded spin">progress_activity</span></div>
    {:else if loadError}
      <div class="state error">
        <span class="material-symbols-rounded">error</span>
        <p>{loadError}</p>
        <button class="btn btn-secondary" on:click={load}>{$_('cookdiary_page.retry')}</button>
      </div>
    {:else if entries.length === 0}
      <div class="state empty" in:fade={{ duration: 120 }}>
        <span class="material-symbols-rounded empty-icon">event_note</span>
        <h2>{$_('routes.diary.empty_title')}</h2>
        <p>{$_('routes.diary.empty_desc')}</p>
        <button class="btn btn-primary" on:click={openPlan}>{$_('routes.diary.plan_cook')}</button>
      </div>
    {:else if filterRecipeId && displayEntries.length === 0}
      <div class="state empty" in:fade={{ duration: 120 }}>
        <span class="material-symbols-rounded empty-icon">filter_alt_off</span>
        <h2>{$_('routes.diary.no_matches_title')}</h2>
        <p>{$_('routes.diary.no_matches_desc', { values: { name: filterRecipeName || $_('routes.diary.this_recipe') } })}</p>
        <button class="btn btn-secondary" on:click={clearFilter}>{$_('routes.diary.clear_filter')}</button>
      </div>
    {:else if view === 'list'}
      <!-- Day-groups grid: single column on mobile, masonry auto-fill
           at wide widths so a week of cooking fits on one screen
           instead of scrolling past today, yesterday, day-before...
           Same pattern Shopping uses for its aisle groups. -->
      <div class="day-grid">
      {#each groupedByDate as [date, items]}
        {@const planned = date >= todayIso}
        <div class="day-group" class:planned in:fade={{ duration: 120 }}>
          <div class="day-header">
            <span class="day-date">{shortDate(date)}</span>
            <span class="day-rel">{relativeTime(date)}</span>
            {#if planned}<span class="day-tag">{$_('cookdiary_page.planned_tag')}</span>{/if}
          </div>
          <ul class="day-list">
            {#each items as e (e.id)}
              <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
              <li class="entry"
                class:planned={e.kind === 'planned'}
                on:click={() => e.recipe_id && push(`/recipes/${e.recipe_id}`)}
                use:longpress
                on:longpress={() => onEntryLongPress(e)}
                on:contextmenu|preventDefault={() => onEntryLongPress(e)}
                role="button" tabindex="0"
                on:keydown={(ev) => { if (ev.key === 'Enter' && e.recipe_id) push(`/recipes/${e.recipe_id}`); }}>
                <div class="entry-recipe">
                  {#if e.recipe_img_url}
                    <img src={resolveAssetUrl(e.recipe_img_url)} alt="" loading="lazy" />
                  {:else}
                    <span class="material-symbols-rounded">restaurant</span>
                  {/if}
                </div>
                <div class="entry-body">
                  <div class="entry-name-row">
                    <span class="entry-name">{e.recipe_name || 'Recipe'}</span>
                    {#if e.meal_type}
                      <span class="entry-meal" title={_mealLabel(e.meal_type)}>
                        <span class="material-symbols-rounded">{_mealIcon(e.meal_type)}</span>
                        {_mealLabel(e.meal_type)}
                      </span>
                    {/if}
                  </div>
                  {#if Number.isFinite(e.rating) && e.rating > 0}
                    <div class="entry-stars" aria-label={`${e.rating} of 5 stars`}>
                      {#each [1,2,3,4,5] as n}
                        <span class="material-symbols-rounded" class:on={e.rating >= n}>
                          {e.rating >= n ? 'star' : 'star_outline'}
                        </span>
                      {/each}
                    </div>
                  {/if}
                  {#if e.cooked_by_full_name || e.cooked_by_username}
                    <div class="entry-by">by {e.cooked_by_full_name || e.cooked_by_username}</div>
                  {/if}
                  {#if e.notes}<div class="entry-notes">{e.notes}</div>{/if}
                </div>
                {#if e.kind === 'planned'}
                  <span class="entry-badge">{$_('cookdiary_page.planned_tag')}</span>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/each}
      </div>
    {:else if view === 'month'}
      <!-- Month grid -->
      <div class="month-grid">
        {#each ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] as wd}
          <div class="weekday">{wd}</div>
        {/each}
        {#each monthCells as cell}
          <div class="cell" class:dim={!cell.inMonth} class:today={cell.isToday}>
            <div class="cell-day">{cell.day}</div>
            {#each cell.items as it (it.id)}
              <button class="cell-pill" class:planned={it.kind === 'planned'}
                on:click={() => push(`/recipes/${it.recipe_id}`)}
                title={it.meal_type ? `${_mealLabel(it.meal_type)} · ${it.recipe_name}` : it.recipe_name}>
                {#if it.meal_type}
                  <span class="material-symbols-rounded cell-pill-meal">{_mealIcon(it.meal_type)}</span>
                {/if}
                <span class="cell-pill-name">{it.recipe_name || 'Recipe'}</span>
              </button>
            {/each}
          </div>
        {/each}
      </div>
    {:else}
      <!-- Photos grid — every cook with a photo, newest first. Tap to
           open in a lightbox. Hover reveals recipe name + date overlay. -->
      {#if photoTiles.length === 0}
        <div class="state empty" in:fade={{ duration: 120 }}>
          <span class="material-symbols-rounded empty-icon">photo_library</span>
          <h2>{$_('cookdiary_page.no_photos')}</h2>
          <p>Add a photo when you log a cook and it'll show up here.</p>
        </div>
      {:else}
        <div class="photo-grid">
          {#each photoTiles as t (`${t.entry.id}:${t.index}`)}
            <button class="photo-tile" on:click={() => openLightbox(t.entry, t.index)} title={`${t.entry.recipe_name || 'Recipe'} · ${shortDate(t.entry.date)}`}>
              <img
                src={resolveAssetUrl(t.url)}
                alt={t.entry.recipe_name || 'Cook photo'}
                loading="lazy"
                on:error={(e) => e.currentTarget?.closest('.photo-tile')?.classList.add('photo-missing')}
              />
              <div class="photo-overlay">
                <span class="photo-name">{t.entry.recipe_name || 'Recipe'}</span>
                <span class="photo-date">{shortDate(t.entry.date)}</span>
              </div>
              {#if t.count > 1}
                <span class="photo-count">
                  <span class="material-symbols-rounded">collections</span>
                  {t.index + 1}/{t.count}
                </span>
              {/if}
              {#if Number.isFinite(t.entry.rating) && t.entry.rating > 0}
                <span class="photo-rating">
                  <span class="material-symbols-rounded">star</span>
                  {t.entry.rating}
                </span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>

<!-- Long-press / right-click action sheet for diary entries. Mirrors
     NutriTrace's diary item context menu — Open / Mark cooked / Delete. -->
<ActionSheet
  bind:open={actionSheetOpen}
  title={actionSheetEntry?.recipe_name || 'Diary entry'}
  actions={entryActions}
  on:select={onEntryAction}
/>

<!-- Plan-a-cook dialog -->
{#if planOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click|self={() => planOpen = false} transition:fade={{ duration: 160 }}>
    <div class="modal" on:click|stopPropagation>
      <header class="modal-header">
        <h2>{$_('cookdiary_page.plan_a_cook')}</h2>
        <button class="btn-icon" on:click={() => planOpen = false} aria-label="Close"><span class="material-symbols-rounded">close</span></button>
      </header>
      <div class="modal-body">
        <label class="field">
          <span class="field-label">{$_('cookdiary_page.date')}</span>
          <DateInput bind:value={planDate} />
        </label>
        <div class="field">
          <span class="field-label">{$_('cookdiary_page.meal')} <span class="field-hint">{$_('cookdiary_page.optional')}</span></span>
          <div class="plan-meal-chips" role="radiogroup" aria-label="Meal type">
            {#each PLAN_MEAL_TYPES as m}
              <button type="button"
                class="plan-meal-chip" class:active={planMealType === m.id}
                aria-pressed={planMealType === m.id}
                on:click={() => planMealType = (planMealType === m.id ? null : m.id)}>
                <span class="material-symbols-rounded">{m.icon}</span>
                {m.label}
              </button>
            {/each}
          </div>
        </div>
        <label class="field">
          <span class="field-label">{$_('cookdiary_page.recipe')}</span>
          <input class="input" type="search" placeholder="Search…" bind:value={planSearch} />
        </label>
        <div class="recipe-picker">
          {#each filteredPlanRecipes as r (r.id)}
            <button class="recipe-row" class:active={planRecipeId === r.id} on:click={() => planRecipeId = r.id}>
              {#if r.imgUrl}
                <img src={r.imgUrl} alt="" loading="lazy" />
              {:else}
                <span class="material-symbols-rounded">restaurant</span>
              {/if}
              <span class="recipe-name">{r.name}</span>
              {#if planRecipeId === r.id}<span class="material-symbols-rounded check">check</span>{/if}
            </button>
          {:else}
            <p class="empty-line">No recipes match.</p>
          {/each}
        </div>
      </div>
      <footer class="modal-footer">
        <button class="btn btn-secondary" on:click={() => planOpen = false}>{$_('cookdiary_page.cancel')}</button>
        <button class="btn btn-primary" on:click={savePlan} disabled={planBusy}>
          {planBusy ? 'Saving…' : 'Plan it'}
        </button>
      </footer>
    </div>
  </div>
{/if}

<!-- Filter picker — pick a single recipe to scope all 3 views. -->
{#if filterPickerOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click|self={() => filterPickerOpen = false} transition:fade={{ duration: 160 }}>
    <div class="modal" on:click|stopPropagation>
      <header class="modal-header">
        <h2>{$_('cookdiary_page.filter_by_recipe')}</h2>
        <button class="btn-icon" on:click={() => filterPickerOpen = false} aria-label="Close"><span class="material-symbols-rounded">close</span></button>
      </header>
      <div class="modal-body">
        <label class="field">
          <span class="field-label">{$_('cookdiary_page.recipe')}</span>
          <input class="input" type="search" placeholder="Search…" bind:value={filterSearch} />
        </label>
        <div class="recipe-picker">
          {#each filteredFilterRecipes as r (r.id)}
            <button class="recipe-row" class:active={filterRecipeId === r.id} on:click={() => pickFilterRecipe(r.id)}>
              {#if r.imgUrl}
                <img src={r.imgUrl} alt="" loading="lazy" />
              {:else}
                <span class="material-symbols-rounded">restaurant</span>
              {/if}
              <span class="recipe-name">{r.name}</span>
              {#if filterRecipeId === r.id}<span class="material-symbols-rounded check">check</span>{/if}
            </button>
          {:else}
            <p class="empty-line">No recipes match.</p>
          {/each}
        </div>
      </div>
      <footer class="modal-footer">
        {#if filterRecipeId}
          <button class="btn btn-secondary" on:click={() => { clearFilter(); filterPickerOpen = false; }}>{$_('cookdiary_page.clear')}</button>
        {/if}
        <button class="btn btn-secondary" on:click={() => filterPickerOpen = false}>{$_('cookdiary_page.done')}</button>
      </footer>
    </div>
  </div>
{/if}

<!-- Photo lightbox — full-bleed photo + metadata, tappable backdrop to
     dismiss. Supports paging through multi-photo cooks via the side
     chevrons. Mirrors NutriTrace's diary photo viewer. -->
{#if lightboxEntry && lightboxPhoto}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="lightbox-backdrop" on:click|self={closeLightbox} transition:fade={{ duration: 160 }}>
    <div class="lightbox" on:click|stopPropagation>
      <button class="lightbox-close btn-icon" on:click={closeLightbox} aria-label="Close">
        <span class="material-symbols-rounded">close</span>
      </button>
      <div class="lightbox-img-wrap">
        <img
          class="lightbox-img"
          src={resolveAssetUrl(lightboxPhoto)}
          alt={lightboxEntry.recipe_name || 'Cook photo'}
          on:error={(e) => e.currentTarget?.closest('.lightbox-img-wrap')?.classList.add('photo-missing')}
        />
        {#if lightboxPhotos.length > 1}
          <button class="lightbox-nav prev" on:click={lightboxPrev} aria-label="Previous photo">
            <span class="material-symbols-rounded">chevron_left</span>
          </button>
          <button class="lightbox-nav next" on:click={lightboxNext} aria-label="Next photo">
            <span class="material-symbols-rounded">chevron_right</span>
          </button>
          <span class="lightbox-index">{lightboxIndex + 1} / {lightboxPhotos.length}</span>
        {/if}
      </div>
      <div class="lightbox-meta">
        <div class="lightbox-title-row">
          <span class="lightbox-title">{lightboxEntry.recipe_name || 'Recipe'}</span>
          {#if lightboxEntry.meal_type}
            <span class="entry-meal">
              <span class="material-symbols-rounded">{_mealIcon(lightboxEntry.meal_type)}</span>
              {_mealLabel(lightboxEntry.meal_type)}
            </span>
          {/if}
        </div>
        <div class="lightbox-sub">
          <span>{shortDate(lightboxEntry.date)}</span>
          <span class="dot">·</span>
          <span>{relativeTime(lightboxEntry.date)}</span>
        </div>
        {#if Number.isFinite(lightboxEntry.rating) && lightboxEntry.rating > 0}
          <div class="entry-stars" aria-label={`${lightboxEntry.rating} of 5 stars`}>
            {#each [1,2,3,4,5] as n}
              <span class="material-symbols-rounded" class:on={lightboxEntry.rating >= n}>
                {lightboxEntry.rating >= n ? 'star' : 'star_outline'}
              </span>
            {/each}
          </div>
        {/if}
        {#if lightboxEntry.notes}<p class="lightbox-notes">{lightboxEntry.notes}</p>{/if}
        {#if lightboxEntry.recipe_id}
          <button class="btn btn-secondary lightbox-open" on:click={() => { const id = lightboxEntry.recipe_id; closeLightbox(); push(`/recipes/${id}`); }}>
            <span class="material-symbols-rounded">open_in_new</span>
            Open Recipe
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .header-action {
    position: fixed;
    top: calc(var(--safe-top) + 10px);
    right: 12px;
    width: 40px; height: 40px;
    border-radius: var(--radius-md);
    background: rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(10px) saturate(160%);
    -webkit-backdrop-filter: blur(10px) saturate(160%);
    border: 1px solid rgba(255, 255, 255, 0.18);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    color: var(--accent);
    z-index: 41;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }
  .header-action:hover { background: rgba(0, 0, 0, 0.5); }

  /* ── Dashboard layout ────────────────────────────────────────
     Mobile: heatmap stacks on top of stats. Desktop (≥1280px):
     two columns side-by-side so the dashboard collapses into one
     horizontal strip and the actual diary content shows up sooner. */
  .diary-dashboard {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 0 0 14px;
  }
  @media (min-width: 1280px) {
    .diary-dashboard {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: 14px;
      align-items: stretch;
    }
    .diary-dashboard :global(.heatmap-card) { margin: 0; }
  }

  /* ── Stats card ──────────────────────────────────────────────
     4-tile grid: This Week · Current Streak · Longest Streak ·
     Most Cooked This Month (or This Month count if no top
     recipe yet). Wraps to 2×2 on narrow screens, then to a 1×4
     compact column when sharing the row with the heatmap. */
  .stats-card {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin: 0;
  }
  .stat-tile {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 10px 12px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    min-width: 0;
  }
  @media (min-width: 1280px) {
    .stats-card {
      grid-template-columns: 1fr 1fr;
      grid-template-rows: 1fr 1fr;
      gap: 8px;
    }
  }
  .stat-tile.stat-link {
    cursor: pointer;
    text-align: left;
    transition: border-color var(--dur-fast), background var(--dur-fast);
  }
  .stat-tile.stat-link:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--surface-1)); }
  .stat-value {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 19px;
    font-weight: 800;
    color: var(--text-1);
    line-height: 1.1;
  }
  .stat-top-name {
    font-size: 14px;
    font-weight: 700;
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
    line-height: 1.3;
  }
  .stat-flame {
    font-size: 18px;
    color: var(--accent);
  }
  .stat-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
    line-height: 1.3;
  }
  @media (max-width: 720px) {
    .stats-card { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }

  /* Sticky diary toolbar: wraps view-switch + filter-row so both
     follow the user down long lists on wide screens. Sits below the
     page-header. Small negative top margin cancels the natural gap
     between page-content top and header bottom so the sticky attaches
     flush. */
  .diary-toolbar {
    position: sticky;
    top: calc(var(--page-top, var(--safe-top)) + 56px + var(--hamburger-row, 0px));
    z-index: 15;
    background: var(--bg);
    padding-top: 6px;
    margin: -6px 0 4px;
  }

  .view-switch {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
    flex-wrap: wrap;
    gap: 10px;
  }
  /* Sliding-pill segmented control. Same visual language as the bottom
     nav and the Recipes page's view-toggle — pill slides between
     buttons with a spring on selection. */
  .view-chips {
    position: relative;
    display: flex;
    gap: 0;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 3px;
  }
  .seg-pill {
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 0;
    width: var(--seg-w, 0px);
    transform: translateX(var(--seg-x, 0px));
    background: var(--accent-dim);
    border-radius: var(--radius-sm);
    transition: transform var(--dur-base) var(--ease-spring),
                width var(--dur-base) var(--ease-spring);
    pointer-events: none;
  }
  .seg {
    position: relative;
    z-index: 1;
    background: transparent;
    color: var(--text-2);
    border: none;
    border-radius: var(--radius-sm);
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    flex: 1;
    text-align: center;
    transition: color var(--dur-fast);
  }
  .seg.active { color: var(--accent); }

  .month-nav { display: flex; align-items: center; gap: 8px; }
  .month-label { font-size: 14px; font-weight: 600; color: var(--text-1); min-width: 130px; text-align: center; }
  .btn-icon {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3); width: 34px; height: 34px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm);
  }
  .btn-icon:hover { color: var(--text-1); background: var(--surface-2); }
  .btn-icon.danger:hover { color: var(--error, #f87171); }
  .btn-icon.small { width: 30px; height: 30px; }
  .btn-icon.small .material-symbols-rounded { font-size: 18px; }

  .state { text-align: center; padding: 60px 16px; color: var(--text-3); display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .state.empty .empty-icon { font-size: 64px; color: var(--accent); opacity: 0.6; }
  .state h2 { color: var(--text-1); margin: 12px 0 0; font-size: 20px; }
  .state.error { color: var(--error, #f87171); }
  .spin { font-size: 32px; animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* List view — day-groups stack single-column on mobile, tile in an
     auto-fill grid at >=1200px so a week of cooking fits on one
     screen. Each day-card becomes a self-contained bordered surface
     at wide widths so the visual break between days stays clear. */
  .day-grid { display: block; }
  @media (min-width: 1200px) {
    .day-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 20px;
      align-items: start;
    }
    .day-grid .day-group {
      margin: 0;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 12px 14px;
    }
    .day-grid .day-header { padding: 0; margin-bottom: 8px; }
  }

  .day-group { margin-bottom: 16px; }
  .day-group.planned .day-header { color: var(--accent); }
  .day-header {
    display: flex; align-items: baseline; gap: 8px;
    margin-bottom: 6px;
    padding: 0 4px;
  }
  .day-date { font-weight: 700; font-size: 14px; color: var(--text-1); }
  .day-group.planned .day-date { color: var(--accent); }
  .day-rel { font-size: 12px; color: var(--text-3); }
  .day-tag {
    margin-left: auto;
    font-size: 10px;
    background: var(--accent-dim);
    color: var(--accent);
    padding: 2px 8px;
    border-radius: var(--radius-full, 99px);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
  }
  .day-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
  .entry {
    display: flex; align-items: center; gap: 10px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 8px 10px;
    cursor: pointer;
    transition: border-color var(--dur-fast), background var(--dur-fast);
    -webkit-tap-highlight-color: transparent;
  }
  .entry:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
  .entry:active { background: var(--surface-2); }
  .entry-recipe {
    width: 44px; height: 44px;
    background: var(--surface-2); border-radius: var(--radius-sm);
    display: flex; align-items: center; justify-content: center;
    overflow: hidden; flex-shrink: 0;
    padding: 0;
  }
  .entry-recipe img { width: 100%; height: 100%; object-fit: cover; }
  .entry-recipe .material-symbols-rounded { color: var(--text-3); }
  .entry-body { flex: 1; min-width: 0; }
  .entry-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .entry-name { font-weight: 600; font-size: 14px; color: var(--text-1); }
  /* Inline meal-type pill on the entry row. Accent-tinted so it
     reads as metadata, not a primary action. */
  .entry-meal {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    padding: 1px 7px;
    border-radius: var(--radius-full, 99px);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .entry-meal .material-symbols-rounded { font-size: 13px; }
  /* Per-cook rating stars under the name. Filled stars use accent;
     empty stars are dim placeholders so 4-star ratings still read as
     "4 out of 5". */
  .entry-stars { display: inline-flex; gap: 1px; margin-top: 2px; }
  .entry-stars .material-symbols-rounded {
    font-size: 14px;
    color: var(--text-3);
  }
  .entry-stars .material-symbols-rounded.on { color: var(--accent); }
  .entry-by    { font-size: 11px; color: var(--text-3); margin-top: 2px; font-style: italic; }
  .entry-notes { font-size: 12px; color: var(--text-3); margin-top: 2px; }
  .entry-actions { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
  .entry-badge {
    flex-shrink: 0;
    font-size: 10px; font-weight: 700; letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--accent);
    background: var(--accent-dim);
    padding: 2px 8px;
    border-radius: var(--radius-full, 99px);
  }
  .entry.planned .entry-name { color: var(--text-2); }
  .btn.tiny { padding: 5px 10px; font-size: 11px; display: inline-flex; align-items: center; gap: 4px; }
  .btn.tiny .material-symbols-rounded { font-size: 14px; }

  /* Month view */
  .month-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
    background: var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    border: 1px solid var(--border);
  }
  .weekday {
    background: var(--surface-2);
    text-align: center;
    padding: 6px 0;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .cell {
    background: var(--surface-1);
    min-height: 88px;
    padding: 4px 5px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  /* Roomier month cells on wide screens so 3-5 cook pills fit per
     day without the name truncating. clamp() keeps growth sane. */
  @media (min-width: 1280px) {
    .cell { min-height: clamp(88px, 14vh, 180px); padding: 6px 7px; gap: 3px; }
  }
  .cell.dim { background: var(--bg); opacity: 0.6; }
  .cell.today { box-shadow: inset 0 0 0 2px var(--accent); }
  .cell-day { font-size: 11px; font-weight: 700; color: var(--text-3); }
  .cell.today .cell-day { color: var(--accent); }
  .cell-pill {
    display: flex;
    align-items: center;
    gap: 3px;
    background: var(--accent-dim);
    color: var(--accent);
    border: none;
    border-radius: var(--radius-sm);
    padding: 2px 5px;
    font-size: 10px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
  }
  .cell-pill .cell-pill-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .cell-pill .cell-pill-meal {
    font-size: 12px;
    flex-shrink: 0;
    opacity: 0.85;
  }
  .cell-pill.planned {
    background: transparent;
    color: var(--accent);
    border: 1px dashed color-mix(in srgb, var(--accent) 50%, transparent);
  }
  .cell-pill:hover { filter: brightness(1.1); }

  /* Plan dialog meal-type chip row — same look as the CookLogDialog
     so the planner + log experience match. */
  .plan-meal-chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .plan-meal-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full, 99px);
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .plan-meal-chip:hover { color: var(--text-1); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .plan-meal-chip.active {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent);
  }
  .plan-meal-chip .material-symbols-rounded { font-size: 14px; }
  .field-hint { font-weight: 400; color: var(--text-3); font-size: 12px; }

  /* Plan modal */
  .modal-backdrop {
    position: fixed; inset: 0;
    background: var(--overlay, rgba(0, 0, 0, 0.55));
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    z-index: 130; display: flex; align-items: center; justify-content: center;
    padding: 16px;
  }
  .modal {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); width: 100%; max-width: 460px;
    max-height: calc(100vh - 32px); display: flex; flex-direction: column;
    box-shadow: 0 16px 48px rgba(0,0,0,0.4);
  }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px; border-bottom: 1px solid var(--border);
  }
  .modal-header h2 { margin: 0; font-size: 17px; font-weight: 700; color: var(--text-1); }
  .modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; flex: 1; overflow-y: auto; }
  .modal-footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; border-top: 1px solid var(--border); }

  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px; color: var(--text-1);
    font-size: 14px; box-sizing: border-box; width: 100%;
  }

  .recipe-picker { display: flex; flex-direction: column; gap: 4px; max-height: 280px; overflow-y: auto; padding: 4px 0; }
  .recipe-row {
    display: flex; align-items: center; gap: 10px;
    background: transparent; border: 1px solid transparent;
    border-radius: var(--radius-sm); padding: 6px 10px;
    cursor: pointer; text-align: left;
  }
  .recipe-row:hover { background: var(--surface-2); }
  .recipe-row.active { background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
  .recipe-row img { width: 36px; height: 36px; border-radius: var(--radius-sm); object-fit: cover; }
  .recipe-row .material-symbols-rounded:first-of-type { color: var(--text-3); width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; }
  .recipe-name { flex: 1; font-size: 13px; color: var(--text-1); }
  .recipe-row.active .recipe-name { color: var(--accent); font-weight: 600; }
  .recipe-row .check { color: var(--accent); }
  .empty-line { color: var(--text-3); font-size: 13px; text-align: center; padding: 16px; margin: 0; font-style: italic; }

  /* Recipe filter chip — narrows List / Month / Photos to one recipe. */
  .filter-row { margin-bottom: 14px; display: flex; gap: 8px; flex-wrap: wrap; }
  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-full, 99px);
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
    max-width: 100%;
  }
  .filter-chip:hover { color: var(--text-1); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .filter-chip .material-symbols-rounded { font-size: 16px; }
  .filter-chip.active {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent);
    padding-right: 4px;
  }
  .filter-chip-name {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .filter-clear {
    background: transparent;
    border: none;
    color: var(--accent);
    width: 22px; height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-full, 99px);
    cursor: pointer;
  }
  .filter-clear:hover { background: color-mix(in srgb, var(--accent) 20%, transparent); }
  .filter-clear .material-symbols-rounded { font-size: 16px; }

  /* Photo grid — auto-fill responsive tiles, square aspect, hover overlay. */
  .photo-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 8px;
  }
  /* Bigger tiles on wide viewports — 140px tiles read as thumbnail
     bricks on a 1920px monitor; 180px feels like an actual photo. */
  @media (min-width: 1200px) {
    .photo-grid {
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 12px;
    }
  }
  .photo-tile {
    position: relative;
    aspect-ratio: 1 / 1;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    padding: 0;
    cursor: pointer;
    transition: transform var(--dur-fast), border-color var(--dur-fast);
  }
  .photo-tile:hover {
    border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
    transform: translateY(-2px);
  }
  .photo-tile img {
    width: 100%; height: 100%;
    object-fit: cover;
    display: block;
  }
  /* Broken-image placeholder — set by <img on:error> on tiles whose
     underlying file couldn't be loaded (stale phone-local URL from
     another install, missing server upload). Preserves the tile size
     so the grid layout stays intact and shows a subtle icon instead
     of the browser's broken-image glyph. */
  .photo-tile.photo-missing img { display: none; }
  .photo-tile.photo-missing::before {
    content: 'broken_image';
    font-family: 'Material Symbols Rounded';
    font-size: 40px;
    color: var(--text-muted);
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-2);
    opacity: 0.55;
  }
  .photo-overlay {
    position: absolute;
    inset: auto 0 0 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 14px 10px 8px;
    background: linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.0) 100%);
    color: #fff;
    text-align: left;
    pointer-events: none;
  }
  .photo-name {
    font-size: 13px;
    font-weight: 700;
    line-height: 1.2;
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .photo-date {
    font-size: 11px;
    opacity: 0.85;
    font-weight: 500;
  }
  .photo-rating {
    position: absolute;
    top: 6px;
    right: 6px;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    background: rgba(0,0,0,0.55);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: var(--radius-full, 99px);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .photo-rating .material-symbols-rounded { font-size: 12px; color: #fcd34d; }
  /* "2/3" badge for multi-photo cooks. Sits opposite the rating pill. */
  .photo-count {
    position: absolute;
    top: 6px;
    left: 6px;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    background: rgba(0,0,0,0.55);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: var(--radius-full, 99px);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .photo-count .material-symbols-rounded { font-size: 12px; }

  /* Lightbox — full-screen photo with metadata below. */
  .lightbox-backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.85);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    z-index: 140;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .lightbox {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 640px;
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    box-shadow: 0 24px 64px rgba(0,0,0,0.55);
  }
  .lightbox-close {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 1;
    background: rgba(0,0,0,0.55);
    color: #fff;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .lightbox-close:hover { background: rgba(0,0,0,0.75); color: #fff; }
  .lightbox-img-wrap { position: relative; background: #000; }
  .lightbox-img-wrap.photo-missing .lightbox-img { display: none; }
  .lightbox-img-wrap.photo-missing::before {
    content: 'broken_image';
    font-family: 'Material Symbols Rounded';
    font-size: 72px;
    color: rgba(255,255,255,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
  }
  .lightbox-img {
    width: 100%;
    max-height: 60vh;
    object-fit: contain;
    background: #000;
    display: block;
  }
  .lightbox-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    background: rgba(0,0,0,0.55);
    color: #fff;
    border: none;
    width: 40px; height: 40px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    transition: background var(--dur-fast);
  }
  .lightbox-nav:hover { background: rgba(0,0,0,0.78); }
  .lightbox-nav.prev { left: 8px; }
  .lightbox-nav.next { right: 8px; }
  .lightbox-nav .material-symbols-rounded { font-size: 24px; }
  .lightbox-index {
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0,0,0,0.55);
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    padding: 3px 10px;
    border-radius: var(--radius-full, 99px);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .lightbox-meta {
    padding: 14px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
  }
  .lightbox-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .lightbox-title { font-size: 17px; font-weight: 700; color: var(--text-1); }
  .lightbox-sub { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-3); }
  .lightbox-sub .dot { opacity: 0.5; }
  .lightbox-notes { margin: 4px 0 0; color: var(--text-2); font-size: 14px; white-space: pre-wrap; }
  .lightbox-open {
    align-self: flex-start;
    margin-top: 6px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .lightbox-open .material-symbols-rounded { font-size: 16px; }
</style>
