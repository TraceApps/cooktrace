<script>
  /**
   * ManageTaxonomyList — generic list-with-rename-delete editor for the
   * "JSON-array on each recipe" taxonomies (Tags + Kitchen Gear).
   *
   * Both share the same shape — fetch a list of `{ name, count }`,
   * support renaming (cascades through every recipe) and deleting
   * (also cascades). Implemented once and reused for tags + tools.
   *
   * Props:
   *   title       — heading
   *   description — small grey blurb above the list
   *   loadFn      — () => Promise<[{ name, count }]>
   *   renameFn    — (oldName, newName) => Promise<{ modified }>
   *   deleteFn    — (name) => Promise<{ modified }>
   */
  import { _ } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import Spinner from '../ui/Spinner.svelte';

  export let title;
  export let description = '';
  export let loadFn;
  export let renameFn;
  export let deleteFn;

  let items = [];
  let loading = true;
  let editingName = null;
  let editText = '';
  let filter = '';

  $: filtered = filter.trim()
    ? items.filter(i => i.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : items;
  $: total = items.length;
  $: usedTotal = items.reduce((s, i) => s + (i.count || 0), 0);

  async function load() {
    loading = true;
    try { items = await loadFn(); }
    catch (e) { showError(e.message || 'Could not load'); items = []; }
    finally { loading = false; }
  }
  onMount(load);

  function startEdit(item) {
    editingName = item.name;
    editText = item.name;
  }
  function cancelEdit() { editingName = null; editText = ''; }

  async function saveEdit(item) {
    const next = editText.trim();
    if (!next || next.toLowerCase() === item.name.toLowerCase()) {
      cancelEdit();
      return;
    }
    // If `next` already exists, this is a merge — confirm.
    const existing = items.find(i => i.name.toLowerCase() === next.toLowerCase() && i.name !== item.name);
    if (existing) {
      const ok = await confirmDialog({
        title: `Merge "${item.name}" into "${existing.name}"?`,
        message: `Every recipe currently using "${item.name}" will use "${existing.name}" instead.`,
        confirmText: 'Merge',
      });
      if (!ok) return;
    }
    try {
      const res = await renameFn(item.name, next);
      cancelEdit();
      await load();
      showSuccess(`Updated ${res?.modified ?? 0} recipe${res?.modified === 1 ? '' : 's'}`);
    } catch (e) { showError(e.message || 'Could not rename'); }
  }

  async function remove(item) {
    const ok = await confirmDialog({
      title: `Delete "${item.name}"?`,
      message: `This removes the value from ${item.count} recipe${item.count === 1 ? '' : 's'}. The recipes themselves stay.`,
      confirmText: 'Delete',
      dangerous: true,
    });
    if (!ok) return;
    try {
      const res = await deleteFn(item.name);
      await load();
      showSuccess(`Removed from ${res?.modified ?? 0} recipe${res?.modified === 1 ? '' : 's'}`);
    } catch (e) { showError(e.message || 'Could not delete'); }
  }
</script>

<div class="mgr">
  <header class="mgr-head">
    <h2>{title}</h2>
    {#if description}<p class="mgr-desc">{description}</p>{/if}
  </header>

  {#if loading}
    <Spinner block label="Loading…" />
  {:else}
    <div class="meta-row">
      <span class="meta">{total} {total === 1 ? 'item' : 'items'}</span>
      <span class="meta">{usedTotal} {usedTotal === 1 ? 'use' : 'uses'} across recipes</span>
    </div>
    {#if items.length > 0}
      <input class="input filter" type="search" placeholder="Filter…" bind:value={filter} />
    {/if}
    {#if items.length === 0}
      <p class="empty">Nothing here yet — values appear once you add them to a recipe.</p>
    {:else if filtered.length === 0}
      <p class="empty">No items match "{filter}".</p>
    {:else}
      <ul class="row-list">
        {#each filtered as it (it.name)}
          <li class="row">
            {#if editingName === it.name}
              <div class="edit-form">
                <input class="input edit-name" bind:value={editText}
                  on:keydown={(e) => {
                    if (e.key === 'Enter') saveEdit(it);
                    if (e.key === 'Escape') cancelEdit();
                  }}
                  autofocus />
                <div class="row-actions">
                  <button class="btn btn-secondary tiny" on:click={cancelEdit}>{$_('manage_taxonomy.cancel')}</button>
                  <button class="btn btn-primary tiny" on:click={() => saveEdit(it)} disabled={!editText.trim()}>{$_('manage_taxonomy.save')}</button>
                </div>
              </div>
            {:else}
              <span class="row-name">{it.name}</span>
              <span class="row-count">{it.count} {it.count === 1 ? 'use' : 'uses'}</span>
              <div class="row-actions">
                <button class="btn-icon small" on:click={() => startEdit(it)} aria-label="Rename" title="Rename">
                  <span class="material-symbols-rounded">edit</span>
                </button>
                <button class="btn-icon small danger" on:click={() => remove(it)} aria-label="Delete" title="Delete">
                  <span class="material-symbols-rounded">delete</span>
                </button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .mgr { display: flex; flex-direction: column; gap: 14px; }
  .mgr-head h2 { margin: 0 0 4px; font-size: 20px; font-weight: 700; color: var(--text-1); }
  .mgr-desc { margin: 0; color: var(--text-3); font-size: 13px; }

  .meta-row {
    display: flex; gap: 16px;
    padding: 8px 12px;
    background: var(--surface-2);
    border-radius: var(--radius-md);
    font-size: 12px;
    color: var(--text-3);
  }
  .meta { font-weight: 600; }

  .filter { width: 100%; box-sizing: border-box; }
  .empty { color: var(--text-3); font-size: 13px; margin: 0; }

  .row-list { list-style: none; margin: 0; padding: 0; }
  .row {
    display: flex; align-items: center; gap: 12px;
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
  .row-name { flex: 1; color: var(--text-1); font-weight: 600; font-size: 14px; }
  .row-count {
    font-size: 12px; color: var(--text-3);
    background: var(--surface-2);
    padding: 2px 8px;
    border-radius: 999px;
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
    flex: 1; display: flex; align-items: center; gap: 8px;
  }
  .edit-name { flex: 1; }
</style>
