<script>
  /**
   * ManagePantryCategories — DB-backed pantry category catalog.
   *
   * Mirrors ManageRecipeCategories shape but with an icon picker
   * (Material Symbols name) instead of a color swatch — pantry rows
   * have always rendered an icon, not a colored pill.
   */
  import { _ } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { NtApi } from '../../lib/api.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import IconPicker from '../ui/IconPicker.svelte';
  import Spinner from '../ui/Spinner.svelte';

  let categories = [];
  let loading = true;
  let editingId = null;
  let editName = '';
  let editIcon = '';
  let editDefaultAisle = '';

  let newName = '';
  let newIcon = 'kitchen';
  let newDefaultAisle = '';
  let creating = false;

  async function load() {
    loading = true;
    try { categories = await NtApi.getPantryCategories(); }
    catch (e) { showError(e.message || 'Could not load pantry categories'); categories = []; }
    finally { loading = false; }
  }
  onMount(load);

  function startEdit(c) {
    editingId = c.id;
    editName = c.name;
    editIcon = c.icon || '';
    editDefaultAisle = c.default_aisle || '';
  }
  function cancelEdit()  { editingId = null; editName = ''; editIcon = ''; editDefaultAisle = ''; }

  async function saveEdit(c) {
    const name = editName.trim();
    if (!name) return;
    try {
      const updated = await NtApi.updatePantryCategory(c.id, {
        name,
        icon: editIcon || null,
        default_aisle: editDefaultAisle.trim() || null,
      });
      categories = categories.map(x => x.id === c.id ? updated : x);
      cancelEdit();
      showSuccess($_('manage_pantry_cats.toast.saved'));
    } catch (e) { showError(e.message || 'Could not save'); }
  }

  async function remove(c) {
    const ok = await confirmDialog({
      title: `Delete "${c.name}"?`,
      message: 'Pantry items in this category lose their category label but stay in your pantry.',
      confirmText: 'Delete',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.deletePantryCategory(c.id);
      categories = categories.filter(x => x.id !== c.id);
    } catch (e) { showError(e.message || 'Could not delete'); }
  }

  // ── Drag-and-drop reorder ───────────────────────────────────────
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
    try { await NtApi.reorderPantryCategories(next.map(c => c.id)); }
    catch (err) { showError(err.message || 'Could not save order'); }
  }
  function _onDragEnd() { draggingId = null; dragOverId = null; }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    creating = true;
    try {
      const c = await NtApi.createPantryCategory({
        name,
        icon: newIcon || null,
        default_aisle: newDefaultAisle.trim() || null,
      });
      categories = [...categories, c];
      newName = '';
      newIcon = 'kitchen';
      newDefaultAisle = '';
      showSuccess($_('manage_pantry_cats.toast.category_added'));
    } catch (e) { showError(e.message || 'Could not add'); }
    finally { creating = false; }
  }
</script>

<div class="mgr">
  <header class="mgr-head">
    <h2>{$_('manage_pantry_cats.title')}</h2>
    <p class="mgr-desc">Used to group your pantry items into sections (Spices, Produce, etc.) and to filter the Pantry list. The optional Default Aisle labels items added to the shopping list from this category — leave blank to use the category name.</p>
  </header>

  {#if loading}
    <Spinner block label="Loading…" />
  {:else if categories.length === 0}
    <p class="empty">No categories yet. Add one below.</p>
  {:else}
    <ul class="row-list">
      {#each categories as c (c.id)}
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
              <input class="input name-input" bind:value={editName} placeholder={$_('manage_pantry_cats.name_ph')} />
              <IconPicker bind:value={editIcon} placeholder={$_('manage_pantry_cats.icon_ph')} />
              <input class="input aisle-input" bind:value={editDefaultAisle} placeholder="Default Aisle (optional)" maxlength="40" />
              <div class="row-actions">
                <button class="btn btn-secondary tiny" on:click={cancelEdit}>{$_('manage_pantry_cats.cancel')}</button>
                <button class="btn btn-primary tiny" on:click={() => saveEdit(c)} disabled={!editName.trim()}>{$_('manage_pantry_cats.save')}</button>
              </div>
            </div>
          {:else}
            <span class="material-symbols-rounded row-icon">{c.icon || 'kitchen'}</span>
            <span class="row-name">{c.name}</span>
            {#if c.default_aisle}
              <span class="aisle-pill" title="Default shopping list aisle">
                <span class="material-symbols-rounded">category</span>{c.default_aisle}
              </span>
            {/if}
            {#if Number.isFinite(c.pantry_count)}
              <span class="usage-pill" class:zero={c.pantry_count === 0}
                title={c.pantry_count === 0 ? 'No pantry items use this category' : `${c.pantry_count} pantry item${c.pantry_count === 1 ? '' : 's'}`}>
                {c.pantry_count} {c.pantry_count === 1 ? 'item' : 'items'}
              </span>
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

  <div class="add-row">
    <input class="input name-input" placeholder="New category name…" bind:value={newName}
      on:keydown={(e) => { if (e.key === 'Enter') create(); }} />
    <IconPicker bind:value={newIcon} placeholder={$_('manage_pantry_cats.icon_ph')} />
    <input class="input aisle-input" bind:value={newDefaultAisle} placeholder="Default Aisle (optional)" maxlength="40" />
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

  .row-list { list-style: none; margin: 0; padding: 0; }
  .row {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 0; border-top: 1px solid var(--border);
  }
  .row:first-child { border-top: none; }
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
  .row-icon {
    flex-shrink: 0; color: var(--accent); font-size: 22px;
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
    flex: 1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  .name-input { flex: 1; min-width: 160px; }
  .aisle-input { flex: 1; min-width: 140px; max-width: 220px; font-size: 13px; }
  .aisle-pill {
    display: inline-flex; align-items: center; gap: 3px;
    font-size: 11px; font-weight: 600;
    padding: 2px 8px;
    border-radius: var(--radius-full, 99px);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
  }
  .aisle-pill .material-symbols-rounded { font-size: 12px; }

  .add-row {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding-top: 16px; margin-top: 8px;
    border-top: 1px solid var(--border);
  }
  .hint {
    color: var(--text-3); font-size: 12px; margin: 0;
  }
  .hint code {
    background: var(--surface-2);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 11px;
  }
  .hint a { color: var(--accent); }
</style>
