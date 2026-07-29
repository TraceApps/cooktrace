<script>
  /**
   * ManageUnits — unified Units catalog editor.
   *
   * Built-in units (defined in src/lib/units.js) can be hidden per-user
   * via a toggle. Custom units add to the catalog. Both surface in the
   * UnitPicker once the user reloads.
   *
   * Renders one section per category (Volume US, Volume Metric, Weight
   * US, Weight Metric, Count, plus a separate Custom section). Built-in
   * rows show a "Built-in" badge and can only be toggled. Custom rows
   * support rename + delete.
   */
  import { _ } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { UNIT_GROUPS } from '../../lib/units.js';
  import { NtApi } from '../../lib/api.js';
  import { refreshUnitsOverlay } from '../../stores/unitsOverlay.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import Spinner from '../ui/Spinner.svelte';

  let disabled = new Set();
  let custom = [];
  // Per-abbr usage map — { tbsp: 12, cup: 24, ... } keyed lowercase.
  // Covers BOTH built-in and custom units, so the badges read the same
  // either side of the divide.
  let usage = {};
  function _uses(abbr) {
    if (!abbr) return 0;
    return usage[String(abbr).toLowerCase()] || 0;
  }
  let loading = true;
  // Add-custom form state.
  let newAbbr = '';
  let newFull = '';
  let newCategory = 'Custom';
  let creating = false;
  // Inline rename state.
  let editingId = null;
  let editAbbr = '';
  let editFull = '';
  let editCategory = '';

  // Flat list of every built-in abbreviation. Used by the create form
  // to reject collisions client-side before the server sees them.
  const BUILTIN_ABBRS = new Set();
  for (const g of UNIT_GROUPS) for (const u of g.units) BUILTIN_ABBRS.add(u.abbr);
  const CATEGORY_OPTIONS = [...UNIT_GROUPS.map(g => g.label), 'Custom'];

  async function load() {
    loading = true;
    try {
      const res = await NtApi.getUnits();
      disabled = new Set(res.disabled || []);
      custom = res.custom || [];
      usage = res.usage || {};
    } catch (e) {
      showError(e.message || 'Could not load units');
      disabled = new Set();
      custom = [];
      usage = {};
    } finally {
      loading = false;
    }
  }
  onMount(load);

  async function toggleBuiltin(abbr) {
    const next = !disabled.has(abbr);
    try {
      await NtApi.toggleBuiltinUnit(abbr, next);
      const updated = new Set(disabled);
      if (next) updated.add(abbr); else updated.delete(abbr);
      disabled = updated;
      refreshUnitsOverlay();
    } catch (e) {
      showError(e.message || 'Could not save');
    }
  }

  async function createCustom() {
    const abbr = newAbbr.trim();
    const full = (newFull.trim() || abbr);
    if (!abbr) return;
    if (BUILTIN_ABBRS.has(abbr)) {
      showError(`"${abbr}" is already a built-in unit. Pick a different abbreviation.`);
      return;
    }
    if (custom.some(c => c.abbr.toLowerCase() === abbr.toLowerCase())) {
      showError(`Custom unit "${abbr}" already exists.`);
      return;
    }
    creating = true;
    try {
      const c = await NtApi.createCustomUnit({ abbr, full_name: full, category: newCategory });
      custom = [...custom, c];
      newAbbr = '';
      newFull = '';
      refreshUnitsOverlay();
      showSuccess($_('manage_units.toast.unit_added'));
    } catch (e) {
      showError(e.message || 'Could not create');
    } finally {
      creating = false;
    }
  }

  function startEdit(u) {
    editingId = u.id;
    editAbbr = u.abbr;
    editFull = u.full_name;
    editCategory = u.category || 'Custom';
  }
  function cancelEdit() { editingId = null; editAbbr = ''; editFull = ''; editCategory = ''; }
  async function saveEdit(u) {
    const abbr = editAbbr.trim();
    const full = editFull.trim() || abbr;
    if (!abbr) return;
    try {
      const updated = await NtApi.updateCustomUnit(u.id, {
        abbr, full_name: full, category: editCategory,
      });
      custom = custom.map(x => x.id === u.id ? updated : x);
      cancelEdit();
      refreshUnitsOverlay();
      showSuccess($_('manage_units.toast.saved'));
    } catch (e) {
      showError(e.message || 'Could not save');
    }
  }

  async function removeCustom(u) {
    const ok = await confirmDialog({
      title: `Delete "${u.abbr}"?`,
      message: 'Recipes already using this unit keep the abbreviation as free text.',
      confirmText: 'Delete',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.deleteCustomUnit(u.id);
      custom = custom.filter(x => x.id !== u.id);
      refreshUnitsOverlay();
    } catch (e) {
      showError(e.message || 'Could not delete');
    }
  }

  async function resetAll() {
    if (disabled.size === 0) return;
    const ok = await confirmDialog({
      title: 'Re-enable all built-in units?',
      message: 'Restores every hidden built-in. Your custom units stay.',
      confirmText: 'Re-enable',
    });
    if (!ok) return;
    for (const abbr of disabled) {
      try { await NtApi.toggleBuiltinUnit(abbr, false); } catch {}
    }
    disabled = new Set();
    refreshUnitsOverlay();
    showSuccess($_('manage_units.toast.builtins_restored'));
  }
</script>

<div class="mgr">
  <header class="mgr-head">
    <h2>{$_('manage_units.title')}</h2>
    <p class="mgr-desc">
      All cooking units available in recipe + pantry editors. Toggle a built-in
      to hide it from your pickers, or add custom units. Hiding is non-destructive,
      recipes already using the unit keep working as free text.
    </p>
  </header>

  {#if loading}
    <Spinner block label="Loading…" />
  {:else}
    <div class="meta-row">
      <span class="meta">{BUILTIN_ABBRS.size} built-ins · {disabled.size} hidden</span>
      <span class="meta">{custom.length} custom</span>
      {#if disabled.size > 0}
        <button class="btn btn-secondary tiny reset-btn" on:click={resetAll}>{$_('manage_units.restore_all')}</button>
      {/if}
    </div>

    {#each UNIT_GROUPS as group (group.label)}
      <section class="grp">
        <h3 class="grp-title">{group.label}</h3>
        <ul class="row-list">
          {#each group.units as u (u.abbr)}
            {@const isOff = disabled.has(u.abbr)}
            {@const uses = _uses(u.abbr)}
            <li class="row" class:off={isOff}>
              <span class="badge">Built-in</span>
              <span class="abbr">{u.abbr}</span>
              <span class="full">{u.full}</span>
              <span class="usage-pill" class:zero={uses === 0}
                title={uses === 0 ? 'Not used in any recipe' : `Used in ${uses} ingredient${uses === 1 ? '' : 's'}`}>
                {uses} {uses === 1 ? 'use' : 'uses'}
              </span>
              <label class="switch" title={isOff ? 'Hidden from pickers' : 'Visible in pickers'}>
                <input type="checkbox" checked={!isOff} on:change={() => toggleBuiltin(u.abbr)} />
                <span class="track"><span class="thumb"></span></span>
              </label>
            </li>
          {/each}
        </ul>
      </section>
    {/each}

    <section class="grp">
      <h3 class="grp-title">{$_('manage_units.custom_group')}</h3>
      {#if custom.length === 0}
        <p class="empty">No custom units yet.</p>
      {:else}
        <ul class="row-list">
          {#each custom as u (u.id)}
            <li class="row">
              {#if editingId === u.id}
                <div class="edit-form">
                  <input class="input edit-input abbr-input" bind:value={editAbbr} placeholder="abbr" />
                  <input class="input edit-input full-input" bind:value={editFull} placeholder="full name" />
                  <select class="input edit-input cat-input" bind:value={editCategory}>
                    {#each CATEGORY_OPTIONS as cat}<option>{cat}</option>{/each}
                  </select>
                  <div class="row-actions">
                    <button class="btn btn-secondary tiny" on:click={cancelEdit}>{$_('manage_units.cancel')}</button>
                    <button class="btn btn-primary tiny" on:click={() => saveEdit(u)} disabled={!editAbbr.trim()}>{$_('manage_units.save')}</button>
                  </div>
                </div>
              {:else}
                {@const uses = _uses(u.abbr)}
                <span class="badge custom-badge">{$_('manage_units.custom_badge')}</span>
                <span class="abbr">{u.abbr}</span>
                <span class="full">{u.full_name}</span>
                {#if u.category}<span class="cat-tag">{u.category}</span>{/if}
                <span class="usage-pill" class:zero={uses === 0}
                  title={uses === 0 ? 'Not used in any recipe' : `Used in ${uses} ingredient${uses === 1 ? '' : 's'}`}>
                  {uses} {uses === 1 ? 'use' : 'uses'}
                </span>
                <div class="row-actions">
                  <button class="btn-icon small" on:click={() => startEdit(u)} aria-label="Edit" title="Edit">
                    <span class="material-symbols-rounded">edit</span>
                  </button>
                  <button class="btn-icon small danger" on:click={() => removeCustom(u)} aria-label="Delete" title="Delete">
                    <span class="material-symbols-rounded">delete</span>
                  </button>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <div class="add-row">
        <input class="input abbr-input" placeholder="abbr (e.g. head)" bind:value={newAbbr}
          on:keydown={(e) => { if (e.key === 'Enter') createCustom(); }} />
        <input class="input full-input" placeholder="full name (optional)" bind:value={newFull} />
        <select class="input cat-input" bind:value={newCategory}>
          {#each CATEGORY_OPTIONS as cat}<option>{cat}</option>{/each}
        </select>
        <button class="btn btn-primary" on:click={createCustom} disabled={creating || !newAbbr.trim()}>
          {creating ? 'Adding…' : 'Add'}
        </button>
      </div>
    </section>
  {/if}
</div>

<style>
  .mgr { display: flex; flex-direction: column; gap: 16px; }
  .mgr-head h2 { margin: 0 0 4px; font-size: 20px; font-weight: 700; color: var(--text-1); }
  .mgr-desc { margin: 0; color: var(--text-3); font-size: 13px; }
  .empty { color: var(--text-3); font-size: 13px; margin: 0; }

  .meta-row {
    display: flex; gap: 16px; align-items: center;
    padding: 8px 12px;
    background: var(--surface-2);
    border-radius: var(--radius-md);
    font-size: 12px;
    color: var(--text-3);
  }
  .meta { font-weight: 600; }
  .reset-btn { margin-left: auto; }

  .grp { display: flex; flex-direction: column; gap: 8px; }
  .grp-title {
    margin: 8px 0 4px; font-size: 13px;
    font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-3);
  }

  .row-list { list-style: none; margin: 0; padding: 0; }
  .row {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 0; border-top: 1px solid var(--border);
  }
  .row:first-child { border-top: none; }
  .row.off .abbr, .row.off .full { color: var(--text-3); text-decoration: line-through; }

  .badge {
    flex-shrink: 0;
    background: var(--surface-2);
    color: var(--text-3);
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .custom-badge {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
  }
  .abbr {
    font-weight: 700;
    color: var(--text-1);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    min-width: 60px;
  }
  .full { flex: 1; color: var(--text-2); font-size: 14px; }
  .cat-tag {
    color: var(--text-3); font-size: 11px;
    background: var(--surface-2);
    padding: 2px 6px;
    border-radius: 4px;
  }
  /* Usage pill — accent-tinted when in use, dim border-only when zero
     so stale units stand out from active ones. */
  .usage-pill {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 2px 7px;
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
  .row.off .usage-pill { opacity: 0.6; }

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

  /* Toggle switch — visible inline at the right of every built-in row. */
  .switch {
    flex-shrink: 0;
    position: relative;
    display: inline-block;
    width: 36px; height: 20px;
    cursor: pointer;
  }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch .track {
    position: absolute; inset: 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    transition: background var(--dur-fast);
  }
  .switch .thumb {
    position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px;
    background: var(--text-3);
    border-radius: 50%;
    transition: left var(--dur-fast), background var(--dur-fast);
  }
  .switch input:checked + .track { background: color-mix(in srgb, var(--accent) 35%, transparent); }
  .switch input:checked + .track .thumb { left: 18px; background: var(--accent); }

  .add-row, .edit-form {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  .add-row { padding-top: 12px; margin-top: 8px; border-top: 1px solid var(--border); }
  .abbr-input { width: 120px; min-width: 100px; }
  .full-input { flex: 1; min-width: 160px; }
  .cat-input  { width: 200px; min-width: 140px; }
  .edit-form { flex: 1; }
</style>
