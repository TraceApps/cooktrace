<script>
  /**
   * CookbookView — single cookbook detail page.
   *
   * Layout: hero strip (cover + name + description + recipe count + edit
   * controls), then a recipe grid identical in shape to the Recipes
   * tab. "Add Recipes" opens a multi-select dialog over the user's
   * full library, with a search box and a checkbox per recipe. Each
   * tile has a remove-from-cookbook X.
   */
  import { _ } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import { formatDuration } from '../lib/duration.js';
  import { NtApi } from '../lib/api.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { resolveAssetUrl } from '../lib/platform.js';
  import { portal } from '../lib/portal.js';
  import Spinner from '../components/ui/Spinner.svelte';
  import ImagePicker from '../components/ui/ImagePicker.svelte';
  import { dragHandleZone, dragHandle } from 'svelte-dnd-action';

  export let params = {};
  $: id = parseInt(params.id, 10);

  let cookbook = null;
  let loading = true;
  let loadError = null;

  // Add-recipes modal state.
  let addOpen = false;
  let addQuery = '';
  let allRecipes = [];
  let allRecipesLoading = false;
  let addSelected = new Set();

  // Move/Copy modal — prompts the user to pick another cookbook to
  // move or copy a single recipe into.
  let moveOpen = false;
  let moveDialogRecipe = null;
  let moveAction = 'copy';     // 'move' | 'copy'
  let moveTargetId = '';
  let allCookbooks = [];

  async function load() {
    loading = true;
    loadError = null;
    try { cookbook = await NtApi.getCookbook(id); }
    catch (e) { loadError = e.message || 'Could not load cookbook'; showError(loadError); }
    finally { loading = false; }
  }
  $: if (Number.isFinite(id)) load();

  async function openAddDialog() {
    addOpen = true;
    addQuery = '';
    addSelected = new Set();
    if (allRecipes.length === 0) {
      allRecipesLoading = true;
      try { allRecipes = await NtApi.getRecipes(); }
      catch (e) { showError(e.message || 'Could not load recipes'); allRecipes = []; }
      finally { allRecipesLoading = false; }
    }
  }
  function closeAddDialog() { addOpen = false; }

  $: existingIds = new Set((cookbook?.recipes || []).map(r => r.id));
  $: addCandidates = allRecipes
    .filter(r => !existingIds.has(r.id))
    .filter(r => {
      const q = addQuery.trim().toLowerCase();
      if (!q) return true;
      return (r.name || '').toLowerCase().includes(q)
        || (r.description || '').toLowerCase().includes(q);
    });

  function toggleAddSelected(rid) {
    const next = new Set(addSelected);
    if (next.has(rid)) next.delete(rid); else next.add(rid);
    addSelected = next;
  }

  async function confirmAddRecipes() {
    if (addSelected.size === 0) { closeAddDialog(); return; }
    try {
      const res = await NtApi.addRecipesToCookbook(id, [...addSelected]);
      showSuccess(`Added ${res.added} recipe${res.added === 1 ? '' : 's'}`);
      closeAddDialog();
      await load();
    } catch (e) {
      showError(e.message || 'Could not add');
    }
  }

  // Search + sort for the cookbook's own recipe grid. View-only — the
  // underlying cookbook.recipes array (the manually-curated order the
  // ↑/↓ reorder buttons operate on) is never touched by these. A
  // cookbook with 30+ recipes has no way to find one otherwise.
  let cbQuery = '';
  let cbSort = 'manual'; // 'manual' | 'alpha' | 'fav'
  // Note: intentionally NOT gated on !cookbook.is_smart — smart
  // cookbooks can still be searched, and need the "no matches" empty
  // state below to fire correctly. Reorder buttons are independently
  // protected by their own !cookbook.is_smart check where they render.
  $: cbFilterActive = !!(cbQuery.trim() || cbSort !== 'manual');
  $: displayRecipes = (() => {
    if (!cookbook) return [];
    let list = cookbook.recipes || [];
    const q = cbQuery.trim().toLowerCase();
    if (q) list = list.filter(r => (r.name || '').toLowerCase().includes(q));
    if (cbSort === 'alpha') {
      list = [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (cbSort === 'fav') {
      list = [...list].sort((a, b) => (b.favorite === true) - (a.favorite === true) || (a.name || '').localeCompare(b.name || ''));
    }
    return list;
  })();
  // Reorder buttons only make sense against the true manual order —
  // when a search or non-manual sort is active, the visible list's
  // position no longer matches cookbook.recipes indices, so ↑/↓ would
  // silently reorder against the wrong neighbors. Hide them (remove /
  // move stay available — those are id-based, always safe).
  $: cbReorderable = !cbFilterActive;

  // Drag-and-drop reorder via svelte-dnd-action (same library Shopping
  // uses for its aisle groups). Only active when cbReorderable — the
  // grid is showing cookbook.recipes' true order (no search, sort =
  // Manual). Grip handle sits on each card; the whole card stays the
  // click target to open the recipe, so a handle keeps drag-start from
  // fighting that.
  //
  // Bound directly to cookbook.recipes (not displayRecipes) because
  // dndzone needs a real array it can mutate live during a drag,
  // not the read-only sort/filter derivation. displayRecipes is a
  // reactive `$:` off cookbook.recipes, so it picks up every consider
  // update automatically and the grid's {#each displayRecipes} stays
  // in sync with the live drag.
  const FLIP_MS = 180;
  function handleDndConsider(e) {
    cookbook = { ...cookbook, recipes: e.detail.items };
  }
  async function handleDndFinalize(e) {
    // svelte-dnd-action strips shadow items before finalize, but
    // guard anyway in case a future version changes that (matches
    // the defensive filter Shopping.svelte uses).
    const next = e.detail.items.filter(r => !r?.isDndShadowItem);
    cookbook = { ...cookbook, recipes: next };
    try { await NtApi.reorderCookbookRecipes(cookbook.id, next.map(x => x.id)); }
    catch (e2) { showError(e2.message || 'Could not save order'); }
  }

  async function openMoveDialog(r) {
    moveDialogRecipe = r;
    moveOpen = true;
    moveAction = 'copy';
    moveTargetId = '';
    if (allCookbooks.length === 0) {
      try { allCookbooks = await NtApi.getCookbooks(); }
      catch { allCookbooks = []; }
    }
  }
  function closeMoveDialog() { moveOpen = false; moveDialogRecipe = null; }
  async function confirmMove() {
    if (!moveDialogRecipe || !moveTargetId) return;
    const targetId = parseInt(moveTargetId, 10);
    if (!Number.isFinite(targetId) || targetId === id) return;
    try {
      await NtApi.addRecipesToCookbook(targetId, [moveDialogRecipe.id]);
      if (moveAction === 'move') {
        await NtApi.removeRecipeFromCookbook(id, moveDialogRecipe.id);
        cookbook = { ...cookbook, recipes: cookbook.recipes.filter(x => x.id !== moveDialogRecipe.id) };
      }
      const targetName = allCookbooks.find(c => c.id === targetId)?.name || 'cookbook';
      showSuccess(moveAction === 'move' ? `Moved to "${targetName}"` : `Copied to "${targetName}"`);
      closeMoveDialog();
    } catch (e) {
      showError(e.message || 'Could not save');
    }
  }
  $: moveTargets = (allCookbooks || []).filter(c => c.id !== id && !c.is_smart);

  async function removeRecipe(r) {
    const ok = await confirmDialog({
      title: `Remove "${r.name}" from cookbook?`,
      message: 'The recipe stays in your library.',
      confirmText: 'Remove',
    });
    if (!ok) return;
    try {
      await NtApi.removeRecipeFromCookbook(id, r.id);
      cookbook = { ...cookbook, recipes: cookbook.recipes.filter(x => x.id !== r.id) };
    } catch (e) {
      showError(e.message || 'Could not remove');
    }
  }

  async function deleteCookbook() {
    if (!cookbook) return;
    const ok = await confirmDialog({
      title: `Delete "${cookbook.name}"?`,
      message: `Removes the cookbook (${cookbook.recipes.length} recipe${cookbook.recipes.length === 1 ? '' : 's'} stay in your library).`,
      confirmText: 'Delete',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.deleteCookbook(id);
      showSuccess($_('cookbook_view_ct.toast.cookbook_deleted'));
      push('/recipes?view=cookbooks');
    } catch (e) {
      showError(e.message || 'Could not delete');
    }
  }

  // Cookbook cover image picker. Server already supports
  // cover_image_url on create/update (server/routes/cookbooks.js) —
  // there was just no client UI to set it. Reuses the shared
  // ImagePicker + the same header-X modal shell the Step Photo
  // picker in RecipeEditor uses.
  let coverSheetOpen = false;
  let coverDraft = '';
  function openCoverSheet() {
    if (!cookbook || cookbook.is_smart || cookbook.shared_with_me) return;
    coverDraft = cookbook.cover_image_url || '';
    coverSheetOpen = true;
  }
  function closeCoverSheet() { coverSheetOpen = false; }
  async function saveCover() {
    try {
      const updated = await NtApi.updateCookbook(cookbook.id, { cover_image_url: coverDraft || null });
      cookbook = { ...cookbook, cover_image_url: updated.cover_image_url };
      coverSheetOpen = false;
      showSuccess('Cover updated');
    } catch (e) {
      showError(e.message || 'Could not update cover');
    }
  }

  function totalMinutes(r) {
    if (r?.total_minutes != null) return r.total_minutes;
    return (r?.prep_minutes || 0) + (r?.cook_minutes || 0) + (r?.rest_minutes || 0);
  }
</script>

<div class="page-shell editor-page">
  <header class="editor-header">
    <button class="btn-icon" on:click={() => push('/recipes?view=cookbooks')} aria-label="Back" title="Back">
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    <h2 class="editor-title">{cookbook?.name || 'Cookbook'}</h2>
    {#if cookbook}
      {#if cookbook.shared_with_me}
        <span class="shared-chip" title={cookbook.shared_by ? `Shared by ${cookbook.shared_by}${cookbook.via_kitchen_name ? ' via ' + cookbook.via_kitchen_name : ''}` : 'Shared with you — read only'}>
          <span class="material-symbols-rounded">lock</span>
          <span class="shared-chip-label">{$_('cookbook_view_ct.shared_chip')}</span>
        </span>
      {:else}
        {#if !cookbook.is_smart}
          <button class="btn-icon" on:click={openAddDialog} aria-label="Add recipes" title="Add recipes">
            <span class="material-symbols-rounded">add</span>
          </button>
        {/if}
        <button class="btn-icon danger" on:click={deleteCookbook} aria-label="Delete" title="Delete cookbook">
          <span class="material-symbols-rounded">delete</span>
        </button>
      {/if}
    {/if}
  </header>

  <div class="editor-content">
    {#if loading}
      <div class="state" in:fade={{ duration: 120 }}>
        <span class="material-symbols-rounded spin">progress_activity</span>
      </div>
    {:else if loadError}
      <div class="state error">
        <span class="material-symbols-rounded">error</span>
        <p>{loadError}</p>
        <button class="btn btn-secondary" on:click={load}>{$_('cookbook_view_ct.retry')}</button>
      </div>
    {:else if cookbook}
      <header class="cb-hero">
        {#if !cookbook.is_smart && !cookbook.shared_with_me}
          <button class="cb-cover cb-cover-editable" on:click={openCoverSheet}
            aria-label="Set cookbook cover" title="Set cookbook cover">
            {#if cookbook.cover_image_url}
              <img src={resolveAssetUrl(cookbook.cover_image_url)} alt="" />
            {:else}
              <span class="material-symbols-rounded">auto_stories</span>
            {/if}
            <span class="cb-cover-edit-overlay">
              <span class="material-symbols-rounded">photo_camera</span>
            </span>
          </button>
        {:else}
          <div class="cb-cover">
            {#if cookbook.cover_image_url}
              <img src={resolveAssetUrl(cookbook.cover_image_url)} alt="" />
            {:else}
              <span class="material-symbols-rounded">auto_stories</span>
            {/if}
          </div>
        {/if}
        <div class="cb-meta">
          <div class="cb-name-row">
            <h1 class="cb-name">{cookbook.name}</h1>
            {#if cookbook.is_smart}<span class="smart-badge" title="Auto-populated from a saved filter">{$_('cookbook_view_ct.smart_badge')}</span>{/if}
          </div>
          {#if cookbook.description}
            <p class="cb-desc">{cookbook.description}</p>
          {/if}
          <span class="cb-count">
            {cookbook.recipes.length} {cookbook.recipes.length === 1 ? 'recipe' : 'recipes'}
            {#if cookbook.is_smart && cookbook.smart_filter}
              {@const f = cookbook.smart_filter}
              {@const bits = []}
              {#if f.favorites_only}<span class="filter-tag">{$_('cookbook_view_ct.favorites_filter')}</span>{/if}
              {#if Array.isArray(f.tags) && f.tags.length > 0}
                {#each f.tags as t}<span class="filter-tag">#{t}</span>{/each}
              {/if}
            {/if}
          </span>
        </div>
      </header>

      {#if cookbook.recipes.length === 0}
        <div class="state empty">
          <span class="material-symbols-rounded empty-icon">{cookbook.is_smart ? 'filter_alt' : 'menu_book'}</span>
          <h2>{cookbook.is_smart ? 'No Recipes Match the Filter' : 'No Recipes Yet'}</h2>
          <p>
            {#if cookbook.is_smart}
              Edit the filter in Manage &rarr; Cookbooks, or add tags / categories to your existing recipes.
            {:else}
              Add recipes from your library to start building this cookbook.
            {/if}
          </p>
          {#if !cookbook.is_smart}
            <button class="btn btn-primary" on:click={openAddDialog}>{$_('cookbook_view_ct.add_recipes')}</button>
          {/if}
        </div>
      {:else}
        {#if cookbook.recipes.length > 1}
          <!-- Search + sort for the cookbook's own recipe list. View-
               only: never touches the manually-curated order the ↑/↓
               buttons operate on. Reorder buttons hide themselves
               below whenever this view differs from the true order
               (see cbReorderable). -->
          <div class="cb-search-row">
            <div class="cb-search">
              <span class="material-symbols-rounded">search</span>
              <input type="search" placeholder="Search this cookbook…" bind:value={cbQuery} />
              {#if cbQuery}
                <button class="cb-search-clear" on:click={() => cbQuery = ''} aria-label="Clear search">
                  <span class="material-symbols-rounded">close</span>
                </button>
              {/if}
            </div>
            {#if !cookbook.is_smart}
              <select class="cb-sort" bind:value={cbSort} title="Sort">
                <option value="manual">Manual Order</option>
                <option value="alpha">A → Z</option>
                <option value="fav">Favorites First</option>
              </select>
            {/if}
          </div>
        {/if}

        {#if cbFilterActive && displayRecipes.length === 0}
          <div class="state empty">
            <span class="material-symbols-rounded empty-icon">search_off</span>
            <h2>No recipes match "{cbQuery}"</h2>
            <button class="btn btn-secondary" on:click={() => { cbQuery = ''; cbSort = 'manual'; }}>Clear search</button>
          </div>
        {:else}
        <div class="grid"
          use:dragHandleZone={{ items: displayRecipes, flipDurationMs: FLIP_MS, dropTargetStyle: {}, type: 'cookbook-recipes', dragDisabled: !cbReorderable }}
          on:consider={handleDndConsider}
          on:finalize={handleDndFinalize}>
          {#each displayRecipes as r (r.id)}
            {#if r?.isDndShadowItem}
              <div class="card recipe-card dnd-shadow" aria-hidden="true"></div>
            {:else if r.locked}
              <!-- Locked placeholder — the reader doesn't have their
                   own access to this recipe. Show the name so they
                   know what's here + a hint about how to unlock it,
                   but don't navigate anywhere. -->
              <div class="card recipe-card locked-card"
                title="This recipe isn't shared with you individually. Ask the cookbook owner to share the recipe or add it to a Kitchen you're both in.">
                <div class="card-image">
                  <span class="material-symbols-rounded card-image-fallback">lock</span>
                </div>
                <div class="card-body">
                  <h3 class="card-name">{r.name}</h3>
                  <p class="card-desc locked-hint">Not shared with you — ask the cookbook owner to share it.</p>
                </div>
              </div>
            {:else}
            <div class="card recipe-card">
              <button class="card-clickable" on:click={() => push(`/recipes/${r.id}`)}>
                <div class="card-image">
                  {#if r.imgUrl}
                    <img src={r.imgUrl} alt="" loading="lazy" />
                  {:else}
                    <span class="material-symbols-rounded card-image-fallback">restaurant</span>
                  {/if}
                  {#if r.favorite}
                    <span class="card-fav material-symbols-rounded" title="Favorite">favorite</span>
                  {/if}
                </div>
                <div class="card-body">
                  <h3 class="card-name">{r.name}</h3>
                  {#if r.description}<p class="card-desc">{r.description}</p>{/if}
                  <div class="card-meta">
                    {#if totalMinutes(r) > 0}
                      <span class="meta-pill"><span class="material-symbols-rounded">schedule</span>{formatDuration(totalMinutes(r))}</span>
                    {/if}
                    {#if r.servings}
                      <span class="meta-pill"><span class="material-symbols-rounded">restaurant</span>{r.servings}</span>
                    {/if}
                  </div>
                </div>
              </button>
              {#if !cookbook.is_smart && !cookbook.shared_with_me}
                <button class="remove-btn" on:click={() => removeRecipe(r)}
                  aria-label={`Remove ${r.name}`} title="Remove from cookbook">
                  <span class="material-symbols-rounded">close</span>
                </button>
                <button class="move-btn" on:click={() => openMoveDialog(r)}
                  aria-label={`Move or copy ${r.name}`} title="Move / copy to another cookbook">
                  <span class="material-symbols-rounded">drive_file_move</span>
                </button>
                {#if cbReorderable}
                  <!-- Only shown when the visible list IS the true
                       manual order (no search, sort = Manual). See
                       cbReorderable above — a search or non-manual
                       sort makes the drag zone's items diverge from
                       the recipe's real position. -->
                  <span class="cb-drag-handle" use:dragHandle
                    aria-label="Drag to reorder" title="Drag to reorder">
                    <span class="material-symbols-rounded">drag_indicator</span>
                  </span>
                {/if}
              {/if}
            </div>
            {/if}
          {/each}
        </div>
        {/if}
      {/if}
    {/if}
  </div>
</div>

{#if coverSheetOpen}
  <div use:portal class="modal-backdrop" on:click={closeCoverSheet}>
    <div class="modal" on:click|stopPropagation style="max-width:420px">
      <header class="modal-head">
        <h3>Cookbook Cover</h3>
        <button class="btn-icon" on:click={closeCoverSheet} aria-label="Close" title="Close">
          <span class="material-symbols-rounded">close</span>
        </button>
      </header>
      <div class="modal-body">
        <ImagePicker bind:value={coverDraft} aspect="1 / 1" placeholder="Add a Cover Image" />
      </div>
      <footer class="modal-actions">
        <button class="btn btn-primary" on:click={saveCover}>{$_('recipe_editor_ct.done')}</button>
      </footer>
    </div>
  </div>
{/if}

{#if moveOpen && moveDialogRecipe}
  <div use:portal class="modal-backdrop" on:click={closeMoveDialog}>
    <div class="modal" on:click|stopPropagation style="max-width:420px">
      <header class="modal-head">
        <h3>{$_('cookbook_view_ct.move_or_copy')}</h3>
        <button class="btn-icon" on:click={closeMoveDialog} aria-label="Close" title="Close">
          <span class="material-symbols-rounded">close</span>
        </button>
      </header>
      <div style="padding: 12px 16px 0; color: var(--text-3); font-size: 13px;">
        "{moveDialogRecipe.name}" → another cookbook
      </div>
      <div style="padding: 12px 16px;">
        <div class="seg-radio">
          <label class:on={moveAction === 'copy'}>
            <input type="radio" bind:group={moveAction} value="copy" />
            <span>{@html $_('cookbook_view_ct.copy_label_html')}</span>
          </label>
          <label class:on={moveAction === 'move'}>
            <input type="radio" bind:group={moveAction} value="move" />
            <span>{@html $_('cookbook_view_ct.move_label_html')}</span>
          </label>
        </div>
        <select class="input" style="width: 100%; margin-top: 12px;" bind:value={moveTargetId}>
          <option value="">— Pick a cookbook —</option>
          {#each moveTargets as c (c.id)}
            <option value={String(c.id)}>{c.name}</option>
          {/each}
        </select>
        {#if moveTargets.length === 0}
          <p style="color: var(--text-3); font-size: 12px; margin-top: 8px;">
            No other regular cookbooks to move into. Smart cookbooks are auto-populated.
          </p>
        {/if}
      </div>
      <footer class="modal-actions">
        <button class="btn btn-secondary" on:click={closeMoveDialog}>{$_('cookbook_view_ct.cancel')}</button>
        <button class="btn btn-primary" on:click={confirmMove}
          disabled={!moveTargetId}>
          {moveAction === 'move' ? 'Move' : 'Copy'}
        </button>
      </footer>
    </div>
  </div>
{/if}

{#if addOpen}
  <div use:portal class="modal-backdrop" on:click={closeAddDialog}>
    <div class="modal" on:click|stopPropagation>
      <header class="modal-head">
        <h3>{$_('cookbook_view_ct.add_recipes')}</h3>
        <button class="btn-icon" on:click={closeAddDialog} aria-label="Close" title="Close">
          <span class="material-symbols-rounded">close</span>
        </button>
      </header>
      <div class="modal-search">
        <input class="input" type="search" placeholder="Search your library…" bind:value={addQuery} autofocus />
      </div>
      <div class="modal-list">
        {#if allRecipesLoading}
          <Spinner block label="Loading…" />
        {:else if addCandidates.length === 0}
          <p class="empty">{allRecipes.length === 0 ? 'No recipes in your library yet.' : 'No more recipes to add.'}</p>
        {:else}
          {#each addCandidates as r (r.id)}
            <label class="add-row" class:on={addSelected.has(r.id)}>
              <input type="checkbox" checked={addSelected.has(r.id)}
                on:change={() => toggleAddSelected(r.id)} />
              <div class="add-thumb">
                {#if r.imgUrl}
                  <img src={r.imgUrl} alt="" loading="lazy" />
                {:else}
                  <span class="material-symbols-rounded">restaurant</span>
                {/if}
              </div>
              <span class="add-name">{r.name}</span>
            </label>
          {/each}
        {/if}
      </div>
      <footer class="modal-actions">
        <button class="btn btn-secondary" on:click={closeAddDialog}>{$_('cookbook_view_ct.cancel')}</button>
        <button class="btn btn-primary" on:click={confirmAddRecipes}
          disabled={addSelected.size === 0}>
          Add {addSelected.size > 0 ? addSelected.size : ''}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .editor-page {
    padding-top: 0;
    position: fixed; inset: 0;
    overflow-y: auto; z-index: 30;
    background: var(--bg, var(--surface-1));
  }
  .editor-header {
    display: flex; align-items: center; gap: 8px;
    padding: calc(var(--safe-top) + 12px) 16px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    position: sticky; top: 0; z-index: 10;
  }
  .editor-title {
    font-size: 17px; font-weight: 600; flex: 1; color: var(--text-1);
    margin: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .btn-icon {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3); width: 40px; height: 40px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm);
  }
  .btn-icon:hover { background: var(--surface-2); color: var(--text-1); }
  .btn-icon.danger:hover { color: var(--error, #f87171); }
  .btn-icon .material-symbols-rounded { font-size: 22px; }

  .editor-content {
    padding: 16px var(--page-px) 32px;
    /* Was a flat 1180px cap at every viewport width — the same class
       of bug Manage.svelte had before its wide-screen pass. The
       .grid below is repeat(auto-fill, minmax(220px, 1fr)), so it
       already flows more columns automatically once the wrapper has
       room; it just never got the room. */
    max-width: 1180px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }
  @media (min-width: 1280px) {
    .editor-content { max-width: 1440px; }
  }
  @media (min-width: 1600px) {
    .editor-content { max-width: 1760px; }
  }

  .state {
    text-align: center; padding: 60px 16px;
    display: flex; flex-direction: column; gap: 10px;
    align-items: center; color: var(--text-3);
  }
  .state.empty .empty-icon { font-size: 64px; color: var(--accent); opacity: 0.6; }
  .state.empty h2 { color: var(--text-1); margin: 12px 0 0; font-size: 20px; }
  .spin { font-size: 32px; animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Hero strip: cover + meta block */
  .cb-hero {
    display: flex; gap: 20px;
    align-items: center;
    padding: 8px 0 24px;
  }
  .cb-cover {
    flex-shrink: 0;
    width: 120px; height: 120px;
    border-radius: var(--radius-lg);
    background: var(--surface-2);
    border: 1px solid var(--border);
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }
  .cb-cover img { width: 100%; height: 100%; object-fit: cover; }
  .cb-cover .material-symbols-rounded { font-size: 56px; color: var(--accent); opacity: 0.6; }
  .cb-cover-editable {
    position: relative;
    padding: 0; border: 1px solid var(--border); cursor: pointer;
    font-family: inherit;
  }
  .cb-cover-edit-overlay {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.45);
    opacity: 0;
    transition: opacity var(--dur-fast);
  }
  .cb-cover-editable:hover .cb-cover-edit-overlay,
  .cb-cover-editable:focus-visible .cb-cover-edit-overlay { opacity: 1; }
  .cb-cover-edit-overlay .material-symbols-rounded {
    font-size: 28px; color: white; opacity: 1;
  }
  .cb-meta { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .cb-name-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .cb-name { margin: 0; font-size: 28px; font-weight: 700; color: var(--text-1); line-height: 1.2; }
  .smart-badge {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 3px 9px;
    border-radius: 999px;
  }
  .cb-desc { margin: 0; color: var(--text-2); font-size: 15px; line-height: 1.5; }
  .cb-count {
    color: var(--text-3); font-size: 13px; font-weight: 600;
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  }
  .filter-tag {
    background: var(--surface-2);
    color: var(--text-3);
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }

  /* Search + sort for the cookbook's own recipe grid. */
  .cb-search-row {
    display: flex;
    gap: 10px;
    align-items: center;
    margin: 4px 0 16px;
    flex-wrap: wrap;
  }
  .cb-search {
    flex: 1;
    min-width: 200px;
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 9px 12px;
  }
  .cb-search .material-symbols-rounded { font-size: 18px; color: var(--text-3); flex-shrink: 0; }
  .cb-search input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text-1);
    font-size: 14px;
    min-width: 0;
  }
  .cb-search-clear {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3);
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 50%;
    flex-shrink: 0;
  }
  .cb-search-clear:hover { color: var(--text-1); background: var(--surface-2); }
  .cb-sort {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 9px 12px;
    color: var(--text-1);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
  }
  .cb-sort:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }

  /* Recipe grid (mirrors Recipes page) */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 16px;
  }
  .card.recipe-card {
    position: relative;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    /* Smooth drag-reorder: svelte-dnd-action's FLIP technique animates
       every card's position via CSS transform on every consider event.
       Without these hints the browser re-layouts/repaints each image-
       heavy card from scratch every frame, which is what read as
       "choppy" (especially on Android WebView, weaker GPU compositing
       than desktop Chrome). will-change promotes each card to its own
       compositor layer up front so the transform is pure GPU work;
       contain: paint isolates each card's repaint cost so animating
       one doesn't force the browser to reconsider its neighbors. */
    will-change: transform;
    contain: paint;
  }
  /* The actively-dragged card, id-targeted by svelte-dnd-action
     (DRAGGED_ELEMENT_ID). Disable pointer-events on its contents so
     hover/focus recalculation on the card underneath the cursor
     doesn't compete with the drag gesture for a frame budget, and
     give it a lifted look so the motion reads as physical rather
     than the card just teleporting between grid cells. */
  :global(#dnd-action-dragged-el) {
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35);
    cursor: grabbing;
  }
  :global(#dnd-action-dragged-el *) {
    pointer-events: none;
  }
  .card-clickable {
    background: none; border: none; padding: 0; width: 100%;
    text-align: left; cursor: pointer; color: inherit;
    display: flex; flex-direction: column;
  }
  .card-image {
    aspect-ratio: 4 / 3;
    background: var(--surface-2);
    overflow: hidden;
    position: relative;
  }
  .card-image img { width: 100%; height: 100%; object-fit: cover; }
  .card-image-fallback {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 48px; color: var(--text-3); opacity: 0.4;
  }
  .card-fav {
    position: absolute; top: 8px; right: 8px;
    color: var(--accent);
    text-shadow: 0 1px 2px rgba(0,0,0,0.4);
  }
  .card-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 6px; }
  .card-name { margin: 0; font-size: 15px; font-weight: 600; color: var(--text-1); line-height: 1.3; }
  .card-desc {
    margin: 0; font-size: 12px; color: var(--text-3); line-height: 1.4;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .card-meta { display: flex; gap: 6px; flex-wrap: wrap; }
  .meta-pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px;
    background: var(--surface-2);
    color: var(--text-3);
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }
  .meta-pill .material-symbols-rounded { font-size: 14px; }

  .remove-btn {
    position: absolute; top: 8px; left: 8px;
    background: rgba(0, 0, 0, 0.55);
    color: white;
    border: none;
    border-radius: 50%;
    width: 28px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    opacity: 0; transition: opacity var(--dur-fast);
  }
  .recipe-card:hover .remove-btn { opacity: 1; }
  .remove-btn:hover { background: rgba(220, 38, 38, 0.85); }
  .remove-btn .material-symbols-rounded { font-size: 16px; }

  /* Move-to-cookbook button — same hover-reveal as remove, on the
     opposite top corner. */
  .move-btn {
    position: absolute;
    top: 8px; right: 8px;
    background: rgba(0, 0, 0, 0.55);
    color: white;
    border: none;
    border-radius: 50%;
    width: 28px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    opacity: 0; transition: opacity var(--dur-fast);
  }
  .recipe-card:hover .move-btn { opacity: 1; }
  .move-btn:hover { background: rgba(0, 0, 0, 0.78); }
  .move-btn .material-symbols-rounded { font-size: 16px; }

  /* Segmented radio for the move/copy choice */
  .seg-radio {
    display: flex; gap: 4px;
    background: var(--surface-2);
    padding: 4px;
    border-radius: var(--radius-md);
  }
  .seg-radio label {
    flex: 1;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 13px; font-weight: 600;
    color: var(--text-3);
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .seg-radio label.on {
    background: var(--surface-1);
    color: var(--accent);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .seg-radio input { display: none; }
  .seg-radio small { color: var(--text-3); font-weight: 500; }

  /* Drag handle (bottom-right of card on hover). Grip icon only —
     the drag itself is driven by svelte-dnd-action's dragHandleZone
     on the .grid container; this element is just the pickup target
     so the rest of the card stays clickable to open the recipe. */
  .cb-drag-handle {
    position: absolute;
    bottom: 6px;
    right: 6px;
    background: rgba(0, 0, 0, 0.55);
    color: white;
    border-radius: 50%;
    width: 26px; height: 26px;
    display: flex; align-items: center; justify-content: center;
    cursor: grab;
    opacity: 0;
    transition: opacity var(--dur-fast), background var(--dur-fast);
  }
  .recipe-card:hover .cb-drag-handle,
  .cb-drag-handle:focus-visible { opacity: 1; }
  .cb-drag-handle:hover { background: rgba(0, 0, 0, 0.75); }
  .cb-drag-handle:active { cursor: grabbing; }
  .cb-drag-handle .material-symbols-rounded { font-size: 16px; }

  /* Placeholder card svelte-dnd-action renders in the gap left by
     the item currently being dragged. Same footprint as a real
     card so the grid doesn't jump; dashed border reads as a slot. */
  .dnd-shadow {
    background: var(--surface-2);
    border: 1.5px dashed var(--border);
    aspect-ratio: 3 / 4;
  }

  /* Modal */
  .modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex; align-items: center; justify-content: center;
    z-index: 1200;
    padding: 16px;
  }
  .modal {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    width: 100%; max-width: 540px;
    max-height: 80vh;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
    display: flex; flex-direction: column;
  }
  .modal-head {
    padding: 16px 16px 12px;
    display: flex; align-items: center;
    border-bottom: 1px solid var(--border);
  }
  .modal-head h3 { margin: 0; flex: 1; font-size: 17px; font-weight: 700; color: var(--text-1); }
  .modal-search { padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .modal-search .input { width: 100%; box-sizing: border-box; }
  .modal-list {
    flex: 1; overflow-y: auto;
    padding: 4px 8px;
  }
  .empty { color: var(--text-3); font-size: 13px; text-align: center; padding: 24px; }
  .add-row {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 12px;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: background var(--dur-fast);
  }
  .add-row:hover, .add-row.on { background: var(--surface-2); }
  .add-row input { accent-color: var(--accent); }
  .add-thumb {
    flex-shrink: 0;
    width: 40px; height: 40px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    overflow: hidden;
    display: flex; align-items: center; justify-content: center;
  }
  .add-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .add-thumb .material-symbols-rounded { font-size: 18px; color: var(--text-3); opacity: 0.6; }
  .add-name { flex: 1; color: var(--text-1); font-size: 14px; font-weight: 500; }
  .modal-actions {
    padding: 12px 16px;
    display: flex; justify-content: flex-end; gap: 8px;
    border-top: 1px solid var(--border);
  }
  /* "Shared" chip in the editor header — signals read-only cookbook.
     Same shape as RecipeView's shared chip for cross-page consistency. */
  .shared-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    height: 28px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
  .shared-chip .material-symbols-rounded { font-size: 14px; }
  @media (max-width: 480px) {
    .shared-chip-label { display: none; }
    .shared-chip { padding: 4px 8px; }
  }
  /* Locked recipe card placeholder — recipe is in the cookbook but
     the reader hasn't been granted their own access, so the row is a
     hint, not a link. Dim and non-interactive to avoid promising
     something the tap won't deliver. */
  .locked-card {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .locked-card .card-image-fallback {
    color: var(--text-3);
    font-size: 44px;
  }
  .locked-hint {
    font-style: italic;
    color: var(--text-3) !important;
    font-size: 11px !important;
  }
</style>
