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
  // Sort order + "unused only" toggle. Persisted per-list-title so
  // Tags and Kitchen Gear remember independently.
  const _sortKey = `manage:sort:${title || 'list'}`;
  const _unusedKey = `manage:unused:${title || 'list'}`;
  let sortMode = 'name'; // 'name' | 'most' | 'least'
  let unusedOnly = false;
  if (typeof localStorage !== 'undefined') {
    const s = localStorage.getItem(_sortKey);
    if (s === 'name' || s === 'most' || s === 'least') sortMode = s;
    unusedOnly = localStorage.getItem(_unusedKey) === '1';
  }
  $: if (typeof localStorage !== 'undefined') localStorage.setItem(_sortKey, sortMode);
  $: if (typeof localStorage !== 'undefined') localStorage.setItem(_unusedKey, unusedOnly ? '1' : '0');

  $: filtered = (() => {
    let out = items;
    if (unusedOnly) out = out.filter(i => (i.count || 0) === 0);
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      out = out.filter(i => i.name.toLowerCase().includes(q));
    }
    if (sortMode === 'most')  out = [...out].sort((a, b) => (b.count || 0) - (a.count || 0) || a.name.localeCompare(b.name));
    if (sortMode === 'least') out = [...out].sort((a, b) => (a.count || 0) - (b.count || 0) || a.name.localeCompare(b.name));
    if (sortMode === 'name')  out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    return out;
  })();
  $: total = items.length;
  $: usedTotal = items.reduce((s, i) => s + (i.count || 0), 0);
  $: unusedCount = items.reduce((s, i) => s + ((i.count || 0) === 0 ? 1 : 0), 0);

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
      <span class="meta accent-meta">{usedTotal} {usedTotal === 1 ? 'use' : 'uses'} across recipes</span>
      {#if unusedCount > 0}
        <button type="button" class="unused-chip" class:active={unusedOnly}
          on:click={() => unusedOnly = !unusedOnly}
          title={unusedOnly ? 'Show all items' : 'Show only items no recipe uses'}>
          <span class="material-symbols-rounded">filter_alt</span>
          {unusedCount} unused
        </button>
      {/if}
      {#if items.length > 1}
        <div class="sort-wrap">
          <label class="sort-label" for="sort-{title}">Sort</label>
          <select id="sort-{title}" class="sort-select" bind:value={sortMode}>
            <option value="name">A-Z</option>
            <option value="most">Most used</option>
            <option value="least">Least used</option>
          </select>
        </div>
      {/if}
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
    align-items: center;
    padding: 8px 12px;
    background: var(--surface-2);
    border-radius: var(--radius-md);
    font-size: 12px;
    color: var(--text-3);
    flex-wrap: wrap;
  }
  .meta { font-weight: 600; }
  .accent-meta { color: var(--accent); }

  /* Unused-only quick-filter chip. Active state paints in accent so
     it's obvious the list is filtered down to a subset. */
  .unused-chip {
    display: inline-flex; align-items: center; gap: 4px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-3);
    padding: 3px 10px 3px 6px;
    border-radius: 999px;
    font: inherit; font-weight: 600;
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .unused-chip:hover { background: var(--surface-1); color: var(--text-1); }
  .unused-chip.active {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent);
  }
  .unused-chip .material-symbols-rounded { font-size: 14px; }

  /* Sort dropdown pushed to the right of the meta-row. */
  .sort-wrap {
    margin-left: auto;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .sort-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
  }
  .sort-select {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 3px 8px;
    color: var(--text-1);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .sort-select:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }

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
