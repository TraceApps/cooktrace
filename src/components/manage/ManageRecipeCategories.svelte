<script>
  /**
   * ManageRecipeCategories — relocated from Settings → Recipe Categories.
   * Same UX: list rows with rename/recolor inline, plus a create row
   * at the bottom. Now lives in the Manage hub.
   */
  import { _ } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { NtApi } from '../../lib/api.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import Spinner from '../ui/Spinner.svelte';

  const SWATCHES = [
    '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
    '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#a855f7',
    '#ec4899', '#d97706',
  ];

  let categories = [];
  let loading = true;
  let editingId = null;
  let editName = '';
  let editColor = null;

  let newName = '';
  let newColor = SWATCHES[0];
  let creating = false;

  let filter = '';
  $: filtered = filter.trim()
    ? categories.filter(c => c.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : categories;
  $: filteredEmpty = categories.length > 0 && filtered.length === 0;

  async function load() {
    loading = true;
    try { categories = await NtApi.getRecipeCategories(); }
    catch (e) { showError(e.message || 'Could not load categories'); categories = []; }
    finally { loading = false; }
  }
  onMount(load);

  function startEdit(c) { editingId = c.id; editName = c.name; editColor = c.color || null; }
  function cancelEdit()  { editingId = null; editName = ''; editColor = null; }

  async function saveEdit(c) {
    const name = editName.trim();
    if (!name) return;
    try {
      const updated = await NtApi.updateRecipeCategory(c.id, { name, color: editColor });
      categories = categories.map(x => x.id === c.id ? updated : x);
      cancelEdit();
      showSuccess($_('manage_recipe_cats.toast.saved'));
    } catch (e) { showError(e.message || 'Could not save'); }
  }

  async function remove(c) {
    const ok = await confirmDialog({
      title: `Delete "${c.name}"?`,
      message: 'Recipes in this category keep their data — they just lose the category label.',
      confirmText: 'Delete',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.deleteRecipeCategory(c.id);
      categories = categories.filter(x => x.id !== c.id);
    } catch (e) { showError(e.message || 'Could not delete'); }
  }

  // ── Drag-and-drop reorder ───────────────────────────────────────
  // Matches the Cookbooks pattern — drop on a row to insert before it,
  // persist the new order via a bulk PUT. Drag is suppressed while
  // inline-edit is active so users don't blow up their own work.
  let draggingId = null;
  let dragOverId = null;
  function _onDragStart(c, e) {
    if (editingId !== null) return;
    draggingId = c.id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(c.id));
    }
  }
  function _onDragOver(c, e) {
    if (draggingId == null || draggingId === c.id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOverId = c.id;
  }
  function _onDragLeave(c) {
    if (dragOverId === c.id) dragOverId = null;
  }
  async function _onDrop(target, e) {
    e.preventDefault();
    const sourceId = draggingId;
    draggingId = null;
    dragOverId = null;
    if (sourceId == null || sourceId === target.id) return;
    const sourceIdx = categories.findIndex(x => x.id === sourceId);
    const targetIdx = categories.findIndex(x => x.id === target.id);
    if (sourceIdx < 0 || targetIdx < 0) return;
    const next = [...categories];
    const [moved] = next.splice(sourceIdx, 1);
    const insertAt = sourceIdx < targetIdx ? targetIdx - 1 : targetIdx;
    next.splice(insertAt, 0, moved);
    categories = next;
    try { await NtApi.reorderRecipeCategories(next.map(c => c.id)); }
    catch (err) { showError(err.message || 'Could not save order'); }
  }
  function _onDragEnd() { draggingId = null; dragOverId = null; }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    creating = true;
    try {
      const c = await NtApi.createRecipeCategory({ name, color: newColor });
      categories = [...categories, c];
      newName = '';
      newColor = SWATCHES[0];
      showSuccess($_('manage_recipe_cats.toast.category_added'));
    } catch (e) { showError(e.message || 'Could not add'); }
    finally { creating = false; }
  }
</script>

<div class="mgr">
  <header class="mgr-head">
    <h2>{$_('manage_recipe_cats.title')}</h2>
    <p class="mgr-desc">One category per recipe. Used for the badge above each recipe title and for filtering on the Recipes page.</p>
  </header>

  {#if loading}
    <Spinner block label="Loading…" />
  {:else if categories.length === 0}
    <p class="empty">No categories yet. Add one below.</p>
  {:else}
    <input class="input filter" type="search" placeholder="Filter…" bind:value={filter} />
    {#if filteredEmpty}
      <p class="empty">No items match "{filter}".</p>
    {:else}
    <ul class="row-list">
      {#each filtered as c (c.id)}
        <li class="row"
          class:dragging={draggingId === c.id}
          class:drag-over={dragOverId === c.id}
          draggable={editingId === null}
          on:dragstart={(e) => _onDragStart(c, e)}
          on:dragover={(e) => _onDragOver(c, e)}
          on:dragleave={() => _onDragLeave(c)}
          on:drop={(e) => _onDrop(c, e)}
          on:dragend={_onDragEnd}>
          {#if editingId === null}
            <span class="grip" title="Drag to reorder" aria-hidden="true">
              <span class="material-symbols-rounded">drag_indicator</span>
            </span>
          {/if}
          {#if editingId === c.id}
            <div class="edit-form">
              <input class="input" bind:value={editName} placeholder={$_('manage_recipe_cats.name_ph')} />
              <div class="swatches">
                {#each SWATCHES as sw}
                  <button class="swatch" class:active={editColor === sw}
                    style={`background:${sw}`}
                    on:click={() => editColor = sw}
                    aria-label={`Color ${sw}`} type="button"></button>
                {/each}
                <button class="swatch none" class:active={!editColor}
                  on:click={() => editColor = null}
                  aria-label="No color" type="button"></button>
              </div>
              <div class="row-actions">
                <button class="btn btn-secondary tiny" on:click={cancelEdit}>{$_('manage_recipe_cats.cancel')}</button>
                <button class="btn btn-primary tiny" on:click={() => saveEdit(c)} disabled={!editName.trim()}>{$_('manage_recipe_cats.save')}</button>
              </div>
            </div>
          {:else}
            <span class="dot" style={c.color ? `background:${c.color}` : ''}></span>
            <span class="row-name">{c.name}</span>
            {#if Number.isFinite(c.recipe_count)}
              {#if c.recipe_count > 0}
                <button type="button" class="usage-pill linked"
                  title={`View the ${c.recipe_count} recipe${c.recipe_count === 1 ? '' : 's'} in this category`}
                  on:click={() => push(`/recipes?category=${c.slug}`)}>
                  {c.recipe_count} {c.recipe_count === 1 ? 'recipe' : 'recipes'}
                </button>
              {:else}
                <span class="usage-pill zero" title="No recipes use this category">
                  {c.recipe_count} recipes
                </span>
              {/if}
            {/if}
            <span class="row-meta">/{c.slug}</span>
            <div class="row-actions">
              <button class="btn-icon small" on:click={() => startEdit(c)} aria-label="Edit" title="Edit">
                <span class="material-symbols-rounded">edit</span>
              </button>
              <button class="btn-icon small danger" on:click={() => remove(c)} aria-label="Delete" title="Delete">
                <span class="material-symbols-rounded">delete</span>
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    {/if}
  {/if}

  <div class="add-row">
    <input class="input" placeholder="New category name…" bind:value={newName}
      on:keydown={(e) => { if (e.key === 'Enter') create(); }} />
    <div class="swatches">
      {#each SWATCHES as sw}
        <button class="swatch" class:active={newColor === sw}
          style={`background:${sw}`}
          on:click={() => newColor = sw}
          aria-label={`Color ${sw}`} type="button"></button>
      {/each}
    </div>
    <button class="btn btn-primary" on:click={create} disabled={creating || !newName.trim()}>
      {creating ? 'Adding…' : 'Add'}
    </button>
  </div>
</div>

<style>
  .mgr { display: flex; flex-direction: column; gap: 16px; }
  .mgr-head h2 { margin: 0 0 4px; font-size: 20px; font-weight: 700; color: var(--text-1); }
  .mgr-desc { margin: 0; color: var(--text-3); font-size: 13px; }
  .empty { color: var(--text-3); font-size: 13px; }

  .filter { width: 100%; box-sizing: border-box; }

  .row-list { list-style: none; margin: 0; padding: 0; }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }
  .row:first-child { border-top: none; }

  /* Wide screens — collapse the single-column stack into a responsive
     card grid so we don't waste the horizontal real estate. Each row
     turns into a compact self-contained card. */
  @media (min-width: 1200px) {
    .row-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 4px 24px;
    }
    .row, .row:first-child {
      border-top: none;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 12px 14px;
      background: var(--surface-1);
    }
  }
  .row[draggable=true] { cursor: grab; }
  .row.dragging { opacity: 0.4; }
  .row.drag-over { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .grip {
    flex-shrink: 0;
    color: var(--text-3);
    display: inline-flex;
    align-items: center;
  }
  .grip .material-symbols-rounded { font-size: 18px; }
  .row:hover .grip { color: var(--text-2); }
  .dot {
    flex-shrink: 0;
    width: 12px; height: 12px;
    border-radius: 50%;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .row-name { flex: 1; color: var(--text-1); font-weight: 600; font-size: 14px; }
  /* Usage pill — accent-tinted when in use, dim border-only when zero
     so stale categories stand out from active ones. */
  .usage-pill {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 2px 8px;
    border-radius: var(--radius-full, 99px);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    text-transform: uppercase;
  }
  .usage-pill.zero {
    background: transparent;
    color: var(--text-3);
    border: 1px solid var(--border);
  }
  /* Linked usage pill — clickable button variant that jumps to the
     Recipes page pre-filtered by this category. Keep pill styling; add
     hover cue but no underline. */
  button.usage-pill {
    font-family: inherit;
    border: none;
  }
  .usage-pill.linked {
    cursor: pointer;
    text-decoration: none;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .usage-pill.linked:hover {
    background: var(--accent-dim);
    color: var(--accent);
  }
  .row-meta {
    color: var(--text-3); font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .row-actions { display: flex; gap: 4px; }

  .btn-icon {
    background: transparent; border: 1px solid transparent;
    border-radius: var(--radius-sm);
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; color: var(--text-3);
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .btn-icon:hover { background: var(--surface-2); color: var(--text-1); }
  .btn-icon.danger:hover {
    background: color-mix(in srgb, var(--error, #ef4444) 18%, transparent);
    color: var(--error, #ef4444);
  }
  .btn-icon .material-symbols-rounded { font-size: 18px; }

  .edit-form {
    flex: 1; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  }
  .edit-form .input { flex: 1; min-width: 160px; }

  .swatches { display: flex; gap: 4px; flex-wrap: wrap; }
  .swatch {
    width: 22px; height: 22px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer; padding: 0;
    transition: transform var(--dur-fast), border-color var(--dur-fast);
  }
  .swatch:hover { transform: scale(1.1); }
  .swatch.active { border-color: var(--text-1); transform: scale(1.1); }
  .swatch.none {
    background: var(--surface-2);
    border: 1px dashed var(--border);
    position: relative;
  }
  .swatch.none::after {
    content: '';
    position: absolute; inset: 4px;
    border-top: 1.5px solid var(--text-3);
    transform: rotate(45deg);
  }

  .add-row {
    display: flex; align-items: center; gap: 12px;
    padding-top: 16px; margin-top: 8px;
    border-top: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .add-row .input { flex: 1; min-width: 200px; }
</style>
