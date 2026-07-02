<script>
  import { onMount } from 'svelte';
  import { fade, slide } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { pageBanners, bannerStyle } from '../stores/settings.js';
  import { NtApi } from '../lib/api.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import UnitPicker from '../components/ui/UnitPicker.svelte';
  import Combobox from '../components/ui/Combobox.svelte';
  import ActionSheet from '../components/ui/ActionSheet.svelte';
  import DateInput from '../components/ui/DateInput.svelte';
  import {
    buildShoppingCardSvg, buildShoppingText,
    svgToPngBlob, shareBlob, shareText,
  } from '../lib/shopping-card.js';

  let items = [];
  let loading = true;
  // Per-section collapse state. Set of keys (recipeId | 'other').
  // Persisted to localStorage so the layout sticks across reloads.
  const COLLAPSE_KEY = 'ct:shoppingCollapsed';
  let collapsed = (() => {
    if (typeof localStorage === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      // Keep recipe ids numeric, 'other' as string.
      return new Set(Array.isArray(arr) ? arr.map(v => v === 'other' ? 'other' : Number(v)) : []);
    } catch { return new Set(); }
  })();
  function toggleCollapsed(key) {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key); else next.add(key);
    collapsed = next;
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next])); } catch {}
  }
  let loadError = null;

  // Quick-add row state
  let addName = '';
  // What the user is currently typing in the name combobox before they
  // pick a suggestion or press Enter. Lets the external "+" button add
  // without forcing the user to commit a Combobox selection first.
  let addNameTyped = '';
  let addQty = '';
  let addUnit = '';
  let addBusy = false;
  // Pantry name catalog — populates the Combobox dropdown so users see
  // items they already have as they type.
  let pantryOptions = [];

  // Add-from-recipe state
  let pickerOpen = false;
  let pickerRecipes = [];
  let pickerSearch = '';
  let pickerOnlyMissing = true;
  let pickerBusy = false;

  $: checkedCount = items.filter(i => i.checked).length;
  $: uncheckedCount = items.length - checkedCount;
  // Group by source recipe. Each group is keyed by recipe_id (or null
  // for manually-added items, rendered as "Other"). Carries the
  // recipe_name + the row list so the header can render a clickable
  // title and per-section actions like Check All.
  $: grouped = (() => {
    const map = new Map();
    for (const it of items) {
      const key = it.recipe_id != null ? it.recipe_id : 'other';
      if (!map.has(key)) {
        map.set(key, {
          recipeId: it.recipe_id ?? null,
          name: it.recipe_id != null ? (it.recipe_name || 'Recipe') : 'Other',
          rows: [],
        });
      }
      map.get(key).rows.push(it);
    }
    // Recipes alphabetical by name, "Other" pinned to the bottom.
    return [...map.values()].sort((a, b) => {
      if (a.recipeId == null) return 1;
      if (b.recipeId == null) return -1;
      return a.name.localeCompare(b.name);
    });
  })();

  async function load() {
    loading = true;
    loadError = null;
    try { items = await NtApi.getShoppingList(); }
    catch (e) { loadError = e.message || 'Could not load list'; showError(loadError); }
    finally { loading = false; }
  }
  async function loadPantry() {
    try {
      const list = await NtApi.getPantry();
      pantryOptions = (list || [])
        .map(p => ({ name: p.name }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    } catch { pantryOptions = []; }
  }
  onMount(() => { load(); loadPantry(); });

  // Effective name for the Add action: pick the committed selection if
  // any, else fall back to whatever the user is mid-typing.
  $: effectiveName = (addName || addNameTyped || '').trim();

  async function quickAdd() {
    const name = effectiveName;
    if (!name) return;
    addBusy = true;
    try {
      const created = await NtApi.addShoppingItem({
        name,
        quantity: addQty === '' ? null : Number(addQty),
        unit: addUnit || null,
      });
      items = [...items, created];
      addName = ''; addNameTyped = ''; addQty = ''; addUnit = '';
    } catch (e) {
      showError(e.message || 'Could not add');
    } finally {
      addBusy = false;
    }
  }

  async function toggleCheck(it) {
    const next = !it.checked;
    items = items.map(i => i.id === it.id ? { ...i, checked: next } : i);
    try { await NtApi.toggleShoppingChecked(it.id, next); }
    catch (e) {
      items = items.map(i => i.id === it.id ? { ...i, checked: !next } : i);
      showError(e.message || 'Could not update');
    }
  }

  // Bulk-toggle every row in a group (a recipe section, or the
  // catch-all "Other"). Optimistic — flip the local state first,
  // then fire one PATCH per row that needs to change. Each request
  // is independent so a partial server failure just leaves those
  // rows in their previous state; we reload to reconcile.
  async function toggleGroupChecked(group, next) {
    const targets = group.rows.filter(r => r.checked !== next);
    if (targets.length === 0) return;
    const ids = new Set(targets.map(r => r.id));
    items = items.map(i => ids.has(i.id) ? { ...i, checked: next } : i);
    try {
      await Promise.all(targets.map(r => NtApi.toggleShoppingChecked(r.id, next)));
    } catch (e) {
      showError(e.message || 'Could not update all items');
      await load();
    }
  }

  async function remove(it) {
    items = items.filter(i => i.id !== it.id);
    try { await NtApi.deleteShoppingItem(it.id); }
    catch (e) {
      await load(); // revert
      showError(e.message || 'Delete failed');
    }
  }

  async function clearGroup(g) {
    // Two paths: rows tied to a recipe go through the bulk endpoint so
    // a single round-trip clears them all and the server handles
    // sync_status / soft-delete consistently. The "Other" group has no
    // recipe_id, so fall back to per-row deletes.
    const n = g.rows.length;
    if (n === 0) return;
    const isRecipe = g.recipeId != null;
    const ok = await confirmDialog({
      title: `Remove ${n} ${n === 1 ? 'item' : 'items'} from ${g.name}?`,
      message: 'They\'ll be removed from your shopping list.',
      confirmText: 'Remove',
      dangerous: true,
    });
    if (!ok) return;
    const removedIds = new Set(g.rows.map(r => r.id));
    items = items.filter(i => !removedIds.has(i.id));
    try {
      if (isRecipe) {
        await NtApi.clearShoppingByRecipe(g.recipeId);
      } else {
        for (const r of g.rows) await NtApi.deleteShoppingItem(r.id);
      }
      showSuccess(`Removed ${n} ${n === 1 ? 'item' : 'items'}`);
    } catch (e) {
      showError(e.message || 'Remove failed');
      await load(); // revert
    }
  }

  async function clearChecked() {
    if (checkedCount === 0) return;
    const ok = await confirmDialog({
      title: `Clear ${checkedCount} checked ${checkedCount === 1 ? 'item' : 'items'}?`,
      message: 'They\'ll be removed from the list.',
      confirmText: 'Clear',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.clearCheckedShopping();
      items = items.filter(i => !i.checked);
      showSuccess('Cleared');
    } catch (e) {
      showError(e.message || 'Clear failed');
    }
  }

  async function openPicker() {
    pickerOpen = true;
    if (pickerRecipes.length === 0) {
      try { pickerRecipes = await NtApi.getRecipes(); }
      catch { pickerRecipes = []; }
    }
  }

  // ── Share list ───────────────────────────────────────────────
  // Two paths: PNG snapshot (universal — email, iMessage, WhatsApp,
  // etc.) or plain text (clipboard / SMS / Notes). Both work fully
  // client-side so they're safe in offline-only Android mode.
  let shareSheetOpen = false;
  const SHARE_ACTIONS = [
    { label: 'Share as Image',     icon: 'image',    value: 'image' },
    { label: 'Share as Text',      icon: 'text_snippet', value: 'text'  },
  ];
  function openShareSheet() {
    if (items.length === 0) {
      showError('Add some items first');
      return;
    }
    shareSheetOpen = true;
  }
  async function onShareSelect(ev) {
    const v = ev.detail?.value;
    if (v === 'image') await shareAsImage();
    else if (v === 'text') await shareAsText();
  }
  async function shareAsImage() {
    showSuccess('Preparing share…');
    try {
      const { svg, width, height } = buildShoppingCardSvg(items);
      const blob = await svgToPngBlob(svg, width, height);
      const fname = `shopping-list-${new Date().toISOString().slice(0,10)}.png`;
      const res = await shareBlob(blob, fname, 'Shopping List');
      if (res.downloaded) showSuccess('Saved image');
      else if (res.canceled) { /* user dismissed share sheet — silent */ }
    } catch (e) {
      showError(e.message || 'Could not share');
    }
  }
  async function shareAsText() {
    try {
      const text = buildShoppingText(items);
      const res = await shareText(text, 'Shopping List');
      if (res.copied) showSuccess('Copied to clipboard');
    } catch (e) {
      showError(e.message || 'Could not share');
    }
  }

  // ── Add from Meal Plan ────────────────────────────────────────
  // Bulk-imports the ingredients of every planned cook in a date
  // range. Same dedupe / only-missing logic as the per-recipe
  // picker, just multiplied across the week.
  let planImportOpen = false;
  let planFrom = '';
  let planTo = '';
  let planOnlyMissing = true;
  let planBusy = false;
  function _isoOffset(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function openPlanImport() {
    planFrom = _isoOffset(0);
    planTo   = _isoOffset(7);
    planOnlyMissing = true;
    planImportOpen = true;
  }
  async function runPlanImport() {
    planBusy = true;
    try {
      const result = await NtApi.shopFromPlan({
        from: planFrom,
        to: planTo,
        only_missing: planOnlyMissing,
      });
      if (result.added === 0) {
        if (result.planned_cooks === 0) {
          showSuccess('Nothing planned in that range');
        } else {
          showSuccess('Everything\'s already in your pantry');
        }
      } else {
        showSuccess(`Added ${result.added} ${result.added === 1 ? 'item' : 'items'} from ${result.planned_cooks} planned ${result.planned_cooks === 1 ? 'cook' : 'cooks'}`);
      }
      planImportOpen = false;
      await load();
    } catch (e) {
      showError(e.message || 'Could not import');
    } finally {
      planBusy = false;
    }
  }
  $: filteredPickerRecipes = pickerSearch.trim()
    ? pickerRecipes.filter(r => r.name.toLowerCase().includes(pickerSearch.trim().toLowerCase()))
    : pickerRecipes;

  async function addFromRecipe(r) {
    pickerBusy = true;
    try {
      const result = await NtApi.shopFromRecipe(r.id, { only_missing: pickerOnlyMissing });
      showSuccess(`Added ${result.added} ${result.added === 1 ? 'item' : 'items'} from "${r.name}"`);
      pickerOpen = false;
      await load();
    } catch (e) {
      showError(e.message || 'Could not add');
    } finally {
      pickerBusy = false;
    }
  }
</script>

<div class="page-shell">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('routes.shopping.title')}</h1>
    <button class="btn-icon header-action header-action-3" on:click={openShareSheet} aria-label="Share List" title="Share List">
      <span class="material-symbols-rounded">share</span>
    </button>
    <button class="btn-icon header-action header-action-2" on:click={openPlanImport} aria-label="Add from Meal Plan" title="Add from Meal Plan">
      <span class="material-symbols-rounded">event_available</span>
    </button>
    <button class="btn-icon header-action" on:click={openPicker} aria-label="Add from Recipe" title="Add from Recipe">
      <span class="material-symbols-rounded">menu_book</span>
    </button>
  </header>

  <div class="page-content">
    <!-- Quick-add row. The name field is a Combobox seeded with the
         user's pantry, so type-ahead surfaces things they already have
         (and the caret toggles the full list). Inline-create lets them
         add brand-new names without leaving the row. -->
    <div class="quick-add">
      <div class="qa-name">
        <Combobox
          mode="single"
          bind:value={addName}
          bind:typed={addNameTyped}
          options={pantryOptions}
          placeholder={$_('routes.shopping.add_placeholder')}
          creatable={true}
          createLabel="Add"
          on:create={() => quickAdd()}
        />
      </div>
      <input
        class="input qa-qty"
        type="number"
        min="0"
        step="0.01"
        bind:value={addQty}
        placeholder="qty"
      />
      <div class="qa-unit"><UnitPicker bind:value={addUnit} placeholder="unit" /></div>
      <button class="btn btn-primary qa-add" on:click={quickAdd} disabled={addBusy || !effectiveName}>
        <span class="material-symbols-rounded">add</span>
      </button>
    </div>

    {#if items.length > 0}
      <div class="status-row">
        <span class="status-text">
          <strong>{uncheckedCount}</strong> remaining
          {#if checkedCount > 0}· {checkedCount} checked{/if}
        </span>
        {#if checkedCount > 0}
          <button class="btn btn-secondary tiny" on:click={clearChecked}>
            <span class="material-symbols-rounded">delete_sweep</span>
            Clear checked
          </button>
        {/if}
      </div>
    {/if}

    {#if loading}
      <div class="state"><span class="material-symbols-rounded spin">progress_activity</span></div>
    {:else if loadError}
      <div class="state error">
        <span class="material-symbols-rounded">error</span>
        <p>{loadError}</p>
        <button class="btn btn-secondary" on:click={load}>Retry</button>
      </div>
    {:else if items.length === 0}
      <div class="state empty" in:fade={{ duration: 120 }}>
        <span class="material-symbols-rounded empty-icon">shopping_cart</span>
        <h2>{$_('routes.shopping.empty_title')}</h2>
        <p>{$_('routes.shopping.empty_desc')}</p>
        <button class="btn btn-primary" on:click={openPicker}>
          <span class="material-symbols-rounded">menu_book</span>
          {$_('routes.shopping.add_from_recipe')}
        </button>
      </div>
    {:else}
      {#each grouped as g (g.recipeId ?? 'other')}
        {@const key = g.recipeId ?? 'other'}
        {@const isCollapsed = collapsed.has(key)}
        {@const allChecked = g.rows.every(r => r.checked)}
        {@const checkedCt = g.rows.filter(r => r.checked).length}
        <section class="recipe-group" class:collapsed={isCollapsed}>
          <header class="recipe-group-head">
            <button class="recipe-group-toggle" type="button"
              on:click={() => toggleCollapsed(key)}
              aria-expanded={!isCollapsed}
              title={isCollapsed ? 'Expand section' : 'Collapse section'}>
              <span class="material-symbols-rounded chev" class:rotated={!isCollapsed}>chevron_right</span>
              <span class="recipe-group-title-stack">
                {#if g.recipeId != null}
                  <span class="material-symbols-rounded book-icon">menu_book</span>
                {/if}
                <span class="recipe-group-title-text">{g.name}</span>
                <span class="recipe-group-count" class:done={checkedCt === g.rows.length}>
                  {String(checkedCt).padStart(2, '0')}/{String(g.rows.length).padStart(2, '0')}
                </span>
              </span>
            </button>
            {#if g.recipeId != null}
              <button class="group-link" type="button"
                on:click|stopPropagation={() => push(`/recipes/${g.recipeId}`)}
                title="Open recipe" aria-label="Open recipe">
                <span class="material-symbols-rounded">open_in_new</span>
              </button>
            {/if}
            <button class="group-action" type="button"
              on:click|stopPropagation={() => toggleGroupChecked(g, !allChecked)}
              title={allChecked ? 'Uncheck all in this group' : 'Check all in this group'}>
              <span class="material-symbols-rounded">{allChecked ? 'check_box' : 'select_all'}</span>
              {allChecked ? 'Uncheck All' : 'Check All'}
            </button>
            <button class="group-action danger" type="button"
              on:click|stopPropagation={() => clearGroup(g)}
              title="Remove all items in this group"
              aria-label="Remove all items in this group">
              <span class="material-symbols-rounded">delete</span>
            </button>
          </header>
          {#if !isCollapsed}
            <ul class="recipe-group-list" transition:slide={{ duration: 160 }}>
              {#each g.rows as it (it.id)}
                <li class="row" class:done={it.checked}>
                  <button class="check" on:click={() => toggleCheck(it)} aria-label={it.checked ? 'Uncheck' : 'Check'}>
                    <span class="material-symbols-rounded">{it.checked ? 'check_box' : 'check_box_outline_blank'}</span>
                  </button>
                  <div class="row-body">
                    <span class="row-name">{it.name}</span>
                    {#if it.quantity != null || it.unit}
                      <span class="row-qty">{it.quantity ?? ''}{it.quantity != null && it.unit ? ' ' : ''}{it.unit ?? ''}</span>
                    {/if}
                  </div>
                  <button class="btn-icon small danger" on:click={() => remove(it)} aria-label="Remove"><span class="material-symbols-rounded">close</span></button>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</div>

<!-- Share action sheet — image (PNG snapshot) or plain text. -->
<ActionSheet
  bind:open={shareSheetOpen}
  title="Share Shopping List"
  actions={SHARE_ACTIONS}
  on:select={onShareSelect}
/>

<!-- Add-from-recipe picker -->
{#if pickerOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click|self={() => pickerOpen = false} transition:fade={{ duration: 160 }}>
    <div class="modal" on:click|stopPropagation>
      <header class="modal-header">
        <h2>Add from Recipe</h2>
        <button class="btn-icon" on:click={() => pickerOpen = false} aria-label="Close"><span class="material-symbols-rounded">close</span></button>
      </header>
      <div class="modal-body">
        <input class="input" type="search" placeholder="Search recipes…" bind:value={pickerSearch} />
        <label class="check-row">
          <input type="checkbox" bind:checked={pickerOnlyMissing} />
          <span>Only add items I don't have in pantry</span>
        </label>
        <div class="recipe-picker">
          {#each filteredPickerRecipes as r (r.id)}
            <button class="recipe-row" on:click={() => addFromRecipe(r)} disabled={pickerBusy}>
              {#if r.imgUrl}
                <img src={r.imgUrl} alt="" loading="lazy" />
              {:else}
                <span class="material-symbols-rounded">restaurant</span>
              {/if}
              <div class="recipe-meta">
                <span class="recipe-name">{r.name}</span>
                {#if r.pantry_match}
                  <span class="recipe-match">{r.pantry_match.have}/{r.pantry_match.need} in pantry</span>
                {/if}
              </div>
              <span class="material-symbols-rounded chev">add</span>
            </button>
          {:else}
            <p class="empty-line">No recipes match.</p>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Add-from-meal-plan import — bulk sweep of every planned cook in
     a date range. Dedupes same-name/same-unit ingredients so one item
     covers multiple recipes. -->
{#if planImportOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click|self={() => planImportOpen = false} transition:fade={{ duration: 160 }}>
    <div class="modal modal-plan" on:click|stopPropagation>
      <header class="modal-header">
        <h2>Add from Meal Plan</h2>
        <button class="btn-icon" on:click={() => planImportOpen = false} aria-label="Close"><span class="material-symbols-rounded">close</span></button>
      </header>
      <div class="modal-body">
        <p class="plan-help">Pull ingredients from every planned cook in this window and dedupe them into one list.</p>
        <div class="plan-dates">
          <label class="field">
            <span class="field-label">From</span>
            <DateInput bind:value={planFrom} max={planTo} />
          </label>
          <label class="field">
            <span class="field-label">To</span>
            <DateInput bind:value={planTo} min={planFrom} />
          </label>
        </div>
        <label class="check-row">
          <input type="checkbox" bind:checked={planOnlyMissing} />
          <span>Only add items I don't have in pantry</span>
        </label>
      </div>
      <footer class="modal-footer">
        <button class="btn btn-secondary" on:click={() => planImportOpen = false} disabled={planBusy}>Cancel</button>
        <button class="btn btn-primary" on:click={runPlanImport} disabled={planBusy || !planFrom || !planTo}>
          {planBusy ? 'Adding…' : 'Add to List'}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .header-action {
    position: fixed; top: calc(var(--safe-top) + 10px); right: 12px;
    width: 40px; height: 40px; border-radius: var(--radius-md);
    background: rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(10px) saturate(160%);
    -webkit-backdrop-filter: blur(10px) saturate(160%);
    border: 1px solid rgba(255, 255, 255, 0.18);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; color: var(--accent); z-index: 41;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }
  .header-action:hover { background: rgba(0, 0, 0, 0.5); }
  /* Secondary header button — sits to the left of the primary "Add
     from Recipe" action. Same visual treatment so the two read as a
     pair. */
  .header-action.header-action-2 { right: 60px; }
  .header-action.header-action-3 { right: 108px; }

  .quick-add {
    display: grid;
    grid-template-columns: 1fr 70px 110px 40px;
    gap: 6px;
    margin-bottom: 12px;
    align-items: center;
  }
  .qa-add {
    width: 40px; height: 40px;
    padding: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-md);
  }
  .qa-add .material-symbols-rounded { font-size: 22px; }
  .input {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px; color: var(--text-1);
    font-size: 14px; box-sizing: border-box; width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  @media (max-width: 540px) {
    .quick-add { grid-template-columns: 1fr 60px 90px 38px; }
  }

  .status-row {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px; gap: 12px;
  }
  .status-text { font-size: 13px; color: var(--text-2); }
  .status-text strong { color: var(--text-1); }
  .btn.tiny { padding: 6px 10px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
  .btn.tiny .material-symbols-rounded { font-size: 16px; }

  .state { text-align: center; padding: 60px 16px; color: var(--text-3); display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .state.empty .empty-icon { font-size: 64px; color: var(--accent); opacity: 0.6; }
  .state h2 { color: var(--text-1); margin: 12px 0 0; font-size: 20px; }
  .state.error { color: var(--error, #f87171); }
  .state .btn-primary { display: inline-flex; align-items: center; gap: 6px; }
  .spin { font-size: 32px; animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Recipe-grouped sections — each header shows the source recipe
     name (clickable) and a per-section Check All / Uncheck All
     button. Manual rows fall under an "Other" group pinned to the
     bottom. */
  .recipe-group { margin-bottom: 16px; }
  .recipe-group-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0 6px;
    padding: 0 4px;
  }
  /* Whole title strip is the collapse toggle. flex:1 so it eats any
     leftover space; the chevron + book icon + name + count line up
     in a single row. */
  .recipe-group-toggle {
    flex: 1;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 0;
    cursor: pointer;
    padding: 4px 2px;
    text-align: left;
    border-radius: var(--radius-sm);
    color: var(--text-1);
  }
  .recipe-group-toggle:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .recipe-group-toggle .chev {
    font-size: 18px;
    color: var(--text-3);
    flex-shrink: 0;
    transition: transform var(--dur-fast);
  }
  .recipe-group-toggle .chev.rotated { transform: rotate(90deg); }
  .recipe-group-title-stack {
    flex: 1;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .recipe-group-title-stack .book-icon {
    font-size: 16px;
    color: var(--accent);
    flex-shrink: 0;
  }
  .recipe-group-title-text {
    font-size: 13px;
    font-weight: 700;
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Fraction counter on the right of the title — checked/total in
     monospace so the digits don't dance as items get crossed off.
     Greys out when fully checked. */
  .recipe-group-count {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-3);
    background: var(--surface-2);
    padding: 1px 7px;
    border-radius: var(--radius-full, 99px);
    flex-shrink: 0;
    margin-left: auto;
  }
  .recipe-group-count.done {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .group-link {
    background: transparent;
    border: 0;
    color: var(--text-3);
    cursor: pointer;
    width: 28px; height: 28px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm);
  }
  .group-link:hover { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .group-link .material-symbols-rounded { font-size: 16px; }
  .group-action {
    background: transparent;
    border: 0;
    color: var(--text-3);
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
  }
  .group-action:hover { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .group-action .material-symbols-rounded { font-size: 16px; }
  .group-action.danger { color: var(--text-3); }
  .group-action.danger:hover { color: var(--error, #ef4444); background: color-mix(in srgb, var(--error, #ef4444) 14%, transparent); }
  .recipe-group-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
  .row {
    display: flex; align-items: center; gap: 10px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 8px 10px;
    transition: opacity var(--dur-fast);
  }
  .row.done { opacity: 0.5; }
  .row.done .row-name { text-decoration: line-through; }
  .check {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3); padding: 0; line-height: 0; flex-shrink: 0;
  }
  .check .material-symbols-rounded { font-size: 24px; }
  .row.done .check { color: var(--accent); }
  .row-body {
    flex: 1; min-width: 0;
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  }
  .row-name { font-weight: 500; color: var(--text-1); }
  .row-qty { font-size: 12px; font-weight: 600; color: var(--accent); flex-shrink: 0; }
  .btn-icon {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3); width: 30px; height: 30px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm);
  }
  .btn-icon:hover { color: var(--text-1); background: var(--surface-2); }
  .btn-icon.danger:hover { color: var(--error, #f87171); }
  .btn-icon.small .material-symbols-rounded { font-size: 18px; }

  /* Modal — same shape as Diary's plan modal */
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
  .check-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); }
  .check-row input { width: 16px; height: 16px; accent-color: var(--accent); }
  /* Plan-import modal — date range + only-missing toggle. */
  .modal-plan { max-width: 420px; }
  .plan-help { margin: 0; color: var(--text-3); font-size: 13px; line-height: 1.45; }
  .plan-dates { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  @media (max-width: 420px) {
    .plan-dates { grid-template-columns: 1fr; }
  }
  .recipe-picker { display: flex; flex-direction: column; gap: 4px; }
  .recipe-row {
    display: flex; align-items: center; gap: 10px;
    background: transparent; border: 1px solid transparent;
    border-radius: var(--radius-sm); padding: 6px 10px;
    cursor: pointer; text-align: left; width: 100%;
  }
  .recipe-row:hover:not(:disabled) { background: var(--surface-2); }
  .recipe-row img { width: 36px; height: 36px; border-radius: var(--radius-sm); object-fit: cover; }
  .recipe-row .material-symbols-rounded:first-of-type { color: var(--text-3); width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; }
  .recipe-meta { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .recipe-name { font-size: 13px; color: var(--text-1); font-weight: 600; }
  .recipe-match { font-size: 11px; color: var(--text-3); }
  .chev { color: var(--accent); }
  .empty-line { color: var(--text-3); font-size: 13px; text-align: center; padding: 16px; margin: 0; font-style: italic; }
</style>
