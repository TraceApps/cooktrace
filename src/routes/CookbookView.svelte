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

  // Reorder via ↑/↓ buttons. Smart cookbooks are computed and don't
  // honor manual order, so the buttons are hidden in that mode.
  async function reorderRecipe(r, direction) {
    if (!cookbook || cookbook.is_smart) return;
    const list = cookbook.recipes || [];
    const idx = list.findIndex(x => x.id === r.id);
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (idx < 0 || target < 0 || target >= list.length) return;
    const next = [...list];
    [next[idx], next[target]] = [next[target], next[idx]];
    cookbook = { ...cookbook, recipes: next };
    try { await NtApi.reorderCookbookRecipes(cookbook.id, next.map(x => x.id)); }
    catch (e) { showError(e.message || 'Could not save order'); }
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
        <div class="cb-cover">
          {#if cookbook.cover_image_url}
            <img src={resolveAssetUrl(cookbook.cover_image_url)} alt="" />
          {:else}
            <span class="material-symbols-rounded">auto_stories</span>
          {/if}
        </div>
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
        <div class="grid">
          {#each cookbook.recipes as r, i (r.id)}
            {#if r.locked}
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
                <div class="reorder-row">
                  <button class="reorder-btn" on:click={() => reorderRecipe(r, 'up')}
                    aria-label="Move up" title="Move up"
                    disabled={i === 0}>
                    <span class="material-symbols-rounded">keyboard_arrow_left</span>
                  </button>
                  <button class="reorder-btn" on:click={() => reorderRecipe(r, 'down')}
                    aria-label="Move down" title="Move down"
                    disabled={i === cookbook.recipes.length - 1}>
                    <span class="material-symbols-rounded">keyboard_arrow_right</span>
                  </button>
                </div>
              {/if}
            </div>
            {/if}
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>

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
    max-width: 1180px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
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

  /* ←/→ reorder buttons (bottom-right of card on hover) */
  .reorder-row {
    position: absolute;
    bottom: 6px;
    right: 6px;
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity var(--dur-fast);
  }
  .recipe-card:hover .reorder-row { opacity: 1; }
  .reorder-btn {
    background: rgba(0, 0, 0, 0.55);
    color: white;
    border: none;
    border-radius: 50%;
    width: 26px; height: 26px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
  }
  .reorder-btn:hover:not(:disabled) { background: rgba(0, 0, 0, 0.75); }
  .reorder-btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .reorder-btn .material-symbols-rounded { font-size: 14px; }

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
