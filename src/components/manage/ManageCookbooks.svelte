<script>
  /**
   * ManageCookbooks — list / create / rename / delete cookbooks.
   *
   * Heavy editing of cookbook contents (adding/removing recipes,
   * reordering) lives on the per-cookbook page (/cookbooks/:id). This
   * editor is just the catalog manager: name, description, cover URL,
   * delete.
   */
  import { _ } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { NtApi } from '../../lib/api.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import Combobox from '../ui/Combobox.svelte';
  import Spinner from '../ui/Spinner.svelte';

  let cookbooks = [];
  let categories = [];
  let tagOptions = [];
  let loading = true;

  let newName = '';
  let newDesc = '';
  // Smart-cookbook fields. When `newSmart` flips on, the smart-filter
  // editor shows up under the form and the cookbook saves with
  // is_smart=true + the picked filter JSON.
  let newSmart = false;
  let newSmartCategory = '';
  let newSmartTags = [];
  let newSmartFavoritesOnly = false;
  let creating = false;

  let editingId = null;
  let editName = '';
  let editDesc = '';
  let editCover = '';
  let _coverInputs = {};   // id → file-input ref for inline cover upload
  let coverUploading = false;

  let filter = '';
  $: filtered = filter.trim()
    ? cookbooks.filter(cb => cb.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : cookbooks;
  $: filteredEmpty = cookbooks.length > 0 && filtered.length === 0;

  async function load() {
    loading = true;
    try {
      const [cbs, cats, tags] = await Promise.all([
        NtApi.getCookbooks(),
        NtApi.getRecipeCategories().catch(() => []),
        NtApi.getRecipeTags().catch(() => []),
      ]);
      cookbooks = cbs;
      categories = cats || [];
      tagOptions = tags || [];
    } catch (e) {
      showError(e.message || 'Could not load cookbooks');
      cookbooks = [];
    } finally { loading = false; }
  }
  onMount(load);

  async function create() {
    const name = newName.trim();
    if (!name) return;
    creating = true;
    try {
      const payload = {
        name,
        description: newDesc.trim() || null,
        is_smart: newSmart,
      };
      if (newSmart) {
        const filter = {};
        if (newSmartCategory) filter.category_id = parseInt(newSmartCategory, 10);
        if (newSmartTags.length > 0) filter.tags = newSmartTags;
        if (newSmartFavoritesOnly) filter.favorites_only = true;
        payload.smart_filter = filter;
      }
      const cb = await NtApi.createCookbook(payload);
      cookbooks = [...cookbooks, { ...cb, recipe_count: 0 }];
      newName = '';
      newDesc = '';
      newSmart = false;
      newSmartCategory = '';
      newSmartTags = [];
      newSmartFavoritesOnly = false;
      showSuccess($_('manage_cookbooks.toast.cookbook_created'));
    } catch (e) {
      showError(e.message || 'Could not create');
    } finally {
      creating = false;
    }
  }

  function startEdit(cb) {
    editingId = cb.id;
    editName = cb.name;
    editDesc = cb.description || '';
    editCover = cb.cover_image_url || '';
  }
  function cancelEdit()  { editingId = null; editName = ''; editDesc = ''; editCover = ''; }
  async function saveEdit(cb) {
    const name = editName.trim();
    if (!name) return;
    try {
      const updated = await NtApi.updateCookbook(cb.id, {
        name,
        description: editDesc.trim() || null,
        cover_image_url: editCover || null,
      });
      cookbooks = cookbooks.map(x => x.id === cb.id ? { ...x, ...updated } : x);
      cancelEdit();
      showSuccess($_('manage_cookbooks.toast.saved'));
    } catch (e) { showError(e.message || 'Could not save'); }
  }

  async function uploadCover(cb, file) {
    if (!file) return;
    coverUploading = true;
    try {
      const res = await NtApi.uploadImage(file);
      const url = res?.url || res?.path || '';
      if (!url) throw new Error('Upload failed');
      // Update either the in-edit form (so user sees it before save)
      // or the row directly (when not in edit mode).
      if (editingId === cb.id) {
        editCover = url;
      } else {
        const updated = await NtApi.updateCookbook(cb.id, { cover_image_url: url });
        cookbooks = cookbooks.map(x => x.id === cb.id ? { ...x, ...updated } : x);
        showSuccess($_('manage_cookbooks.toast.cover_updated'));
      }
    } catch (e) {
      showError(e.message || 'Could not upload');
    } finally {
      coverUploading = false;
    }
  }
  function onCoverPicked(cb, e) {
    const f = e.target?.files?.[0];
    if (f) uploadCover(cb, f);
    if (e.target) e.target.value = '';
  }

  // Reorder via ↑/↓ — works on touch and avoids the heavier HTML5 DnD
  // setup. Sends the new order as a single bulk PUT. Drag-and-drop
  // (below) does the same write.
  async function moveCookbook(cb, direction) {
    const idx = cookbooks.findIndex(x => x.id === cb.id);
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (idx < 0 || target < 0 || target >= cookbooks.length) return;
    const next = [...cookbooks];
    [next[idx], next[target]] = [next[target], next[idx]];
    cookbooks = next;
    try { await NtApi.reorderCookbooks(next.map(c => c.id)); }
    catch (e) { showError(e.message || 'Could not save order'); }
  }

  // ── Drag-and-drop reorder ───────────────────────────────────────────
  // Native HTML5 DnD. Drag the row's grip handle, drop on another row
  // to insert before it. After the visual reorder we fire the same
  // bulk PUT as the arrow buttons.
  let draggingId = null;
  let dragOverId = null;
  function _onDragStart(cb, e) {
    if (editingId !== null) return; // suppress drag while inline-edit is open
    draggingId = cb.id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(cb.id));
    }
  }
  function _onDragOver(cb, e) {
    if (draggingId == null || draggingId === cb.id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOverId = cb.id;
  }
  function _onDragLeave(cb) {
    if (dragOverId === cb.id) dragOverId = null;
  }
  async function _onDrop(targetCb, e) {
    e.preventDefault();
    const sourceId = draggingId;
    draggingId = null;
    dragOverId = null;
    if (sourceId == null || sourceId === targetCb.id) return;
    const sourceIdx = cookbooks.findIndex(x => x.id === sourceId);
    const targetIdx = cookbooks.findIndex(x => x.id === targetCb.id);
    if (sourceIdx < 0 || targetIdx < 0) return;
    const next = [...cookbooks];
    const [moved] = next.splice(sourceIdx, 1);
    // If we removed an item before the target, the target index shifts back by one.
    const insertAt = sourceIdx < targetIdx ? targetIdx - 1 : targetIdx;
    next.splice(insertAt, 0, moved);
    cookbooks = next;
    try { await NtApi.reorderCookbooks(next.map(c => c.id)); }
    catch (e) { showError(e.message || 'Could not save order'); }
  }
  function _onDragEnd() {
    draggingId = null;
    dragOverId = null;
  }

  async function remove(cb) {
    const ok = await confirmDialog({
      title: `Delete "${cb.name}"?`,
      message: `Removes the cookbook (${cb.recipe_count} recipe${cb.recipe_count === 1 ? '' : 's'} stay in your library).`,
      confirmText: 'Delete',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.deleteCookbook(cb.id);
      cookbooks = cookbooks.filter(x => x.id !== cb.id);
    } catch (e) { showError(e.message || 'Could not delete'); }
  }

  function open(cb) { push(`/cookbooks/${cb.id}`); }
</script>

<div class="mgr">
  <header class="mgr-head">
    <h2>{$_('manage_cookbooks.title')}</h2>
    <p class="mgr-desc">User-curated collections of recipes. A recipe can live in multiple cookbooks. Click a cookbook to edit its contents.</p>
  </header>

  {#if loading}
    <Spinner block label="Loading…" />
  {:else}
    {#if cookbooks.length === 0}
      <p class="empty">No cookbooks yet. Create one below.</p>
    {:else}
      <input class="input filter" type="search" placeholder="Filter…" bind:value={filter} />
      {#if filteredEmpty}
        <p class="empty">No items match "{filter}".</p>
      {:else}
      <ul class="row-list">
        {#each filtered as cb (cb.id)}
          <li class="row"
            class:dragging={draggingId === cb.id}
            class:drag-over={dragOverId === cb.id && draggingId !== cb.id}
            draggable={editingId === null}
            on:dragstart={(e) => _onDragStart(cb, e)}
            on:dragover={(e) => _onDragOver(cb, e)}
            on:dragleave={() => _onDragLeave(cb)}
            on:drop={(e) => _onDrop(cb, e)}
            on:dragend={_onDragEnd}>
            {#if editingId === cb.id}
              <button class="cover edit-cover" on:click={() => _coverInputs[cb.id]?.click()}
                title="Upload cover image">
                {#if editCover}
                  <img src={resolveAssetUrl(editCover)} alt="" />
                {:else}
                  <span class="material-symbols-rounded">add_photo_alternate</span>
                {/if}
                <input type="file" accept="image/*" hidden
                  bind:this={_coverInputs[cb.id]}
                  on:change={(e) => onCoverPicked(cb, e)} />
              </button>
              <div class="edit-form">
                <input class="input edit-name" bind:value={editName} placeholder={$_('manage_cookbooks.name_ph')} />
                <input class="input edit-desc" bind:value={editDesc} placeholder="Description (optional)" />
                <div class="row-actions">
                  {#if editCover}
                    <button class="btn-icon small" on:click={() => editCover = ''} aria-label="Remove cover" title="Remove cover">
                      <span class="material-symbols-rounded">image_not_supported</span>
                    </button>
                  {/if}
                  <button class="btn btn-secondary tiny" on:click={cancelEdit}>{$_('manage_cookbooks.cancel')}</button>
                  <button class="btn btn-primary tiny" on:click={() => saveEdit(cb)} disabled={!editName.trim() || coverUploading}>
                    {coverUploading ? 'Uploading…' : 'Save'}
                  </button>
                </div>
              </div>
            {:else}
              <button class="cover" on:click={() => open(cb)} aria-label={`Open ${cb.name}`} title={`Open ${cb.name}`}>
                {#if cb.cover_image_url}
                  <img src={resolveAssetUrl(cb.cover_image_url)} alt="" />
                {:else}
                  <span class="material-symbols-rounded">auto_stories</span>
                {/if}
              </button>
              <div class="meta">
                <div class="title-row">
                  <button class="title-btn" on:click={() => open(cb)}>{cb.name}</button>
                  {#if cb.is_smart}<span class="smart-badge" title="Smart cookbook — auto-populated from a filter">{$_('manage_cookbooks.smart_badge')}</span>{/if}
                </div>
                {#if cb.description}<p class="desc">{cb.description}</p>{/if}
                <span class="count">{cb.recipe_count} {cb.recipe_count === 1 ? 'recipe' : 'recipes'}</span>
              </div>
              <div class="row-actions">
                <div class="reorder">
                  <button class="btn-icon small" on:click={() => moveCookbook(cb, 'up')}
                    aria-label="Move up" title="Move up"
                    disabled={cookbooks[0]?.id === cb.id}>
                    <span class="material-symbols-rounded">keyboard_arrow_up</span>
                  </button>
                  <button class="btn-icon small" on:click={() => moveCookbook(cb, 'down')}
                    aria-label="Move down" title="Move down"
                    disabled={cookbooks[cookbooks.length - 1]?.id === cb.id}>
                    <span class="material-symbols-rounded">keyboard_arrow_down</span>
                  </button>
                </div>
                <button class="btn-icon small" on:click={() => startEdit(cb)} aria-label="Edit" title="Edit">
                  <span class="material-symbols-rounded">edit</span>
                </button>
                <button class="btn-icon small danger" on:click={() => remove(cb)} aria-label="Delete" title="Delete">
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
      <input class="input add-name" placeholder="New cookbook name…" bind:value={newName}
        on:keydown={(e) => { if (e.key === 'Enter') create(); }} />
      <input class="input add-desc" placeholder="Description (optional)" bind:value={newDesc} />
      <label class="smart-toggle" title="Auto-populate from a filter instead of hand-picking recipes">
        <input type="checkbox" bind:checked={newSmart} />
        <span>{$_('manage_cookbooks.smart')}</span>
      </label>
      <button class="btn btn-primary" on:click={create} disabled={creating || !newName.trim()}>
        {creating ? 'Adding…' : 'Add'}
      </button>
    </div>

    {#if newSmart}
      <div class="smart-filter">
        <p class="smart-help">Filter is re-evaluated every time someone opens the cookbook, so it stays in sync with your library.</p>
        <div class="filter-row">
          <span class="filter-label">{$_('manage_cookbooks.category')}</span>
          <select class="input" bind:value={newSmartCategory}>
            <option value="">— Any —</option>
            {#each categories as c (c.id)}
              <option value={String(c.id)}>{c.name}</option>
            {/each}
          </select>
        </div>
        <div class="filter-row">
          <span class="filter-label">Tags (all required)</span>
          <Combobox
            mode="chips"
            bind:value={newSmartTags}
            options={tagOptions}
            placeholder="vegan, weeknight…"
            creatable={true}
            createLabel="Add tag"
          />
        </div>
        <label class="filter-row check-row">
          <input type="checkbox" bind:checked={newSmartFavoritesOnly} />
          <span>{$_('manage_cookbooks.favorites_only')}</span>
        </label>
      </div>
    {/if}
  {/if}
</div>

<style>
  .mgr { display: flex; flex-direction: column; gap: 14px; }
  .mgr-head h2 { margin: 0 0 4px; font-size: 20px; font-weight: 700; color: var(--text-1); }
  .mgr-desc { margin: 0; color: var(--text-3); font-size: 13px; }
  .empty { color: var(--text-3); font-size: 13px; margin: 0; }

  .filter { width: 100%; box-sizing: border-box; }

  .row-list { list-style: none; margin: 0; padding: 0; }
  .row {
    display: flex; align-items: center; gap: 14px;
    padding: 14px 0;
    border-top: 1px solid var(--border);
  }
  .row:first-child { border-top: none; }

  /* Wide screens — collapse the single-column stack into a responsive
     card grid so cookbooks (cover + title + desc + count) tile side by
     side. Larger minmax than the other managers because each row is
     already a rich card with a 56px cover thumbnail. */
  @media (min-width: 1200px) {
    .row-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
      gap: 8px 24px;
    }
    .row, .row:first-child {
      border-top: none;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 12px 14px;
      background: var(--surface-1);
    }
  }

  .cover {
    flex-shrink: 0;
    width: 56px; height: 56px;
    border-radius: var(--radius-md);
    background: var(--surface-2);
    border: 1px solid var(--border);
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
    cursor: pointer;
    padding: 0;
  }
  .cover img { width: 100%; height: 100%; object-fit: cover; }
  .cover .material-symbols-rounded { font-size: 28px; color: var(--accent); opacity: 0.7; }
  .cover.edit-cover {
    border-style: dashed;
    transition: border-color var(--dur-fast), background var(--dur-fast);
  }
  .cover.edit-cover:hover {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
  }

  .reorder { display: flex; flex-direction: column; gap: 0; }
  .reorder .btn-icon { width: 24px; height: 22px; }
  .reorder .material-symbols-rounded { font-size: 16px; }
  .btn-icon:disabled { opacity: 0.3; cursor: not-allowed; }

  /* Drag-and-drop visual states. The whole row is draggable; we
     style the dragging source as faded and the drop target with an
     accent top border so the user sees where the row will land. */
  .row { transition: background var(--dur-fast); }
  .row[draggable=true] { cursor: grab; }
  .row.dragging { opacity: 0.4; }
  .row.drag-over { background: color-mix(in srgb, var(--accent) 8%, var(--surface-2)); }
  .row.drag-over::before {
    content: '';
    position: absolute;
    left: 0; right: 0;
    top: -2px; height: 2px;
    background: var(--accent);
    border-radius: 1px;
  }
  .row { position: relative; }

  .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .title-btn {
    background: none; border: none; padding: 0; text-align: left;
    color: var(--text-1); font-weight: 700; font-size: 15px;
    cursor: pointer;
  }
  .title-btn:hover { color: var(--accent); }
  .desc {
    margin: 0; color: var(--text-3); font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .count { font-size: 11px; color: var(--text-3); }

  .row-actions { display: flex; gap: 4px; flex-shrink: 0; }
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
    flex: 1; display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
  }
  .edit-name, .add-name { flex: 1; min-width: 160px; }
  .edit-desc, .add-desc { flex: 2; min-width: 200px; }

  .add-row {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding-top: 14px; margin-top: 8px;
    border-top: 1px solid var(--border);
  }

  .title-row {
    display: flex; align-items: center; gap: 8px;
  }
  .smart-badge {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 999px;
  }

  .smart-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2);
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
  }
  .smart-toggle input { accent-color: var(--accent); }

  .smart-filter {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px;
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .smart-help { margin: 0 0 4px; color: var(--text-3); font-size: 12px; }
  .filter-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .filter-label {
    font-size: 12px; font-weight: 600;
    color: var(--text-3); min-width: 110px;
  }
  .filter-row .input { flex: 1; min-width: 200px; }
  .check-row { font-size: 13px; color: var(--text-2); cursor: pointer; }
  .check-row input { accent-color: var(--accent); }
</style>
