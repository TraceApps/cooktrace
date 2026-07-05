<script>
  import { onMount } from 'svelte';
  import { fade, slide } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { dragHandleZone, dragHandle } from 'svelte-dnd-action';
  import {
    pageBanners, bannerStyle,
    shoppingGroupBy, shoppingCheckedBehavior,
  } from '../stores/settings.js';
  import { NtApi } from '../lib/api.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import UnitPicker from '../components/ui/UnitPicker.svelte';
  import Combobox from '../components/ui/Combobox.svelte';
  import ActionSheet from '../components/ui/ActionSheet.svelte';
  import DateInput from '../components/ui/DateInput.svelte';
  import { longpress } from '../lib/long-press.js';
  import {
    buildShoppingCardSvg, buildShoppingText,
    svgToPngBlob, shareBlob, shareText,
  } from '../lib/shopping-card.js';

  const UNCATEGORIZED = '__uncat__';

  let items = [];
  let loading = true;
  let loadError = null;
  // Per-section collapse state. Set of stringified keys.
  const COLLAPSE_KEY = 'ct:shoppingCollapsed';
  let collapsed = (() => {
    if (typeof localStorage === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch { return new Set(); }
  })();
  function toggleCollapsed(key) {
    const k = String(key);
    const next = new Set(collapsed);
    if (next.has(k)) next.delete(k); else next.add(k);
    collapsed = next;
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next])); } catch {}
  }

  // Show/hide checked when the user picks 'hide' as the checked
  // behavior — local session toggle so the user can peek without
  // flipping the setting.
  let showCheckedOverride = false;

  // Quick-add row state. Simplified to name + optional qty + Add.
  // Unit no longer sits in the primary flow (moved to the per-row
  // Edit modal), but qty stays as an option because "2 lb chicken"
  // is the one thing users often want to commit at add-time.
  let addName = '';
  let addNameTyped = '';
  let addQty = '';
  let addBusy = false;
  let pantryOptions = [];

  // Aisle picker + long-press action state
  let aisleSheetOpen = false;
  let aisleTarget = null;
  let categories = []; // Raw pantry_categories rows — kept so we can offer the category-name defaults.

  // Add-from-recipe state
  let pickerOpen = false;
  let pickerRecipes = [];
  let pickerSearch = '';
  let pickerOnlyMissing = true;
  let pickerBusy = false;

  $: checkedCount = items.filter(i => i.checked).length;
  $: uncheckedCount = items.length - checkedCount;
  $: hideChecked = $shoppingCheckedBehavior === 'hide' && !showCheckedOverride;

  // Visible items — filter out checked when hiding.
  $: visibleItems = hideChecked ? items.filter(i => !i.checked) : items;

  // Group builder — three modes, one shape. Each group carries { key,
  // title, meta, rows, sortable, aisle } so the render loop treats them
  // uniformly. sortable=true enables the drag handle; aisle carries the
  // aisle label (null in recipe/flat mode) so cross-group drops know
  // what to reassign to.
  $: grouped = (() => {
    const mode = $shoppingGroupBy;
    if (mode === 'flat') {
      const sorted = [...visibleItems].sort(_defaultCmp);
      return [{ key: 'all', title: null, rows: sorted, sortable: true, aisle: null, recipeId: null }];
    }
    if (mode === 'recipe') {
      const map = new Map();
      for (const it of visibleItems) {
        const key = it.recipe_id != null ? String(it.recipe_id) : 'other';
        if (!map.has(key)) {
          map.set(key, {
            key, recipeId: it.recipe_id ?? null, aisle: null,
            title: it.recipe_id != null ? (it.recipe_name || 'Recipe') : $_('routes.shopping.other'),
            rows: [], sortable: true,
          });
        }
        map.get(key).rows.push(it);
      }
      for (const g of map.values()) g.rows.sort(_defaultCmp);
      return [...map.values()].sort((a, b) => {
        if (a.recipeId == null) return 1;
        if (b.recipeId == null) return -1;
        return a.title.localeCompare(b.title);
      });
    }
    // Default: by aisle.
    const map = new Map();
    for (const it of visibleItems) {
      const raw = (it.aisle || '').trim();
      const key = raw || UNCATEGORIZED;
      if (!map.has(key)) {
        map.set(key, {
          key, aisle: raw || null, recipeId: null,
          title: raw || $_('routes.shopping.uncategorized'),
          rows: [], sortable: true,
        });
      }
      map.get(key).rows.push(it);
    }
    for (const g of map.values()) g.rows.sort(_defaultCmp);
    return [...map.values()].sort((a, b) => {
      // Uncategorized last, everything else alpha.
      if (a.key === UNCATEGORIZED) return 1;
      if (b.key === UNCATEGORIZED) return -1;
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    });
  })();

  function _defaultCmp(a, b) {
    if (!!a.checked !== !!b.checked) return a.checked ? 1 : -1;
    const aHasSort = a.sort_order != null;
    const bHasSort = b.sort_order != null;
    if (aHasSort && bHasSort) return a.sort_order - b.sort_order;
    if (aHasSort) return -1;
    if (bHasSort) return 1;
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  }

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
  async function loadCategories() {
    try { categories = await NtApi.getPantryCategories() || []; }
    catch { categories = []; }
  }
  onMount(() => { load(); loadPantry(); loadCategories(); });

  // Known-aisle list = defaults from categories (default_aisle if set,
  // else the category name) + whatever aisles are currently in the
  // shopping list. Deduped case-insensitively, sorted alphabetically.
  $: aisleKnown = (() => {
    const set = new Map();
    const push = (raw) => {
      const s = (raw || '').trim();
      if (!s) return;
      const k = s.toLowerCase();
      if (!set.has(k)) set.set(k, s);
    };
    for (const c of categories) push(c.default_aisle || c.name);
    for (const it of items) push(it.aisle);
    return [...set.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  })();

  $: effectiveName = (addName || addNameTyped || '').trim();

  async function quickAdd() {
    const name = effectiveName;
    if (!name) return;
    addBusy = true;
    try {
      const created = await NtApi.addShoppingItem({
        name,
        quantity: addQty === '' ? null : Number(addQty),
      });
      items = [...items, created];
      addName = ''; addNameTyped = ''; addQty = '';
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
      await load();
      showError(e.message || 'Delete failed');
    }
  }

  async function clearGroup(g) {
    const n = g.rows.length;
    if (n === 0) return;
    const ok = await confirmDialog({
      title: `Remove ${n} ${n === 1 ? 'item' : 'items'}${g.title ? ` from ${g.title}` : ''}?`,
      message: 'They\'ll be removed from your shopping list.',
      confirmText: 'Remove',
      dangerous: true,
    });
    if (!ok) return;
    const removedIds = new Set(g.rows.map(r => r.id));
    items = items.filter(i => !removedIds.has(i.id));
    try {
      if (g.recipeId != null) {
        await NtApi.clearShoppingByRecipe(g.recipeId);
      } else {
        for (const r of g.rows) await NtApi.deleteShoppingItem(r.id);
      }
      showSuccess(`Removed ${n} ${n === 1 ? 'item' : 'items'}`);
    } catch (e) {
      showError(e.message || 'Remove failed');
      await load();
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

  // ── Long-press action sheet on a row ───────────────────────────
  // Fires "Change Aisle" or "Delete". The row is stashed in
  // aisleTarget so the aisle-picker modal knows which item to
  // update.
  let rowActionOpen = false;
  let rowActionItem = null;
  $: ROW_ACTIONS = [
    { label: 'Edit',                             icon: 'edit',     value: 'edit' },
    { label: $_('routes.shopping.change_aisle'), icon: 'category', value: 'aisle' },
    { label: $_('routes.shopping.delete'),       icon: 'delete',   value: 'delete', dangerous: true },
  ];
  function onRowLongPress(it) {
    rowActionItem = it;
    rowActionOpen = true;
  }
  async function onRowActionSelect(ev) {
    const it = rowActionItem;
    rowActionItem = null;
    if (!it) return;
    const v = ev.detail?.value;
    if (v === 'edit') openEdit(it);
    else if (v === 'aisle') openAislePicker(it);
    else if (v === 'delete') await remove(it);
  }

  // ── Per-row Edit (name + qty + unit) ───────────────────────────
  // Full editor for a shopping-list row. Qty and unit no longer sit
  // in the primary add flow (see the "Add" pill above); users tweak
  // them here after the item lands, matching the pattern in every
  // mainstream shopping-list app.
  let editSheetOpen = false;
  let editTarget = null;
  let editName = '';
  let editQty  = '';
  let editUnit = '';
  function openEdit(it) {
    editTarget = it;
    editName   = it.name || '';
    editQty    = it.quantity != null ? String(it.quantity) : '';
    editUnit   = it.unit || '';
    editSheetOpen = true;
  }
  async function commitEdit() {
    if (!editTarget) { editSheetOpen = false; return; }
    const it = editTarget;
    const payload = {
      name:     editName.trim() || it.name,
      quantity: editQty === '' ? null : Number(editQty),
      unit:     editUnit.trim() || null,
    };
    editSheetOpen = false;
    editTarget = null;
    // Optimistic — mirror update into `items` so the row reflects the
    // change before the network round-trip lands.
    items = items.map(i => i.id === it.id ? { ...i, ...payload } : i);
    try { await NtApi.updateShoppingItem(it.id, payload); }
    catch (e) {
      showError(e.message || 'Could not save');
      await load();
    }
  }

  // ── Aisle picker ───────────────────────────────────────────────
  let aisleInput = '';
  function openAislePicker(it) {
    aisleTarget = it;
    aisleInput = it.aisle || '';
    aisleSheetOpen = true;
  }
  async function setAisleFor(it, next) {
    const nextTrim = (next || '').trim() || null;
    items = items.map(i => i.id === it.id ? { ...i, aisle: nextTrim } : i);
    try { await NtApi.updateShoppingItem(it.id, { aisle: nextTrim }); }
    catch (e) {
      showError(e.message || 'Could not update');
      await load();
    }
  }
  async function commitAislePick(pick) {
    if (!aisleTarget) { aisleSheetOpen = false; return; }
    const it = aisleTarget;
    aisleSheetOpen = false;
    aisleTarget = null;
    await setAisleFor(it, pick);
  }

  // ── DnD reorder ────────────────────────────────────────────────
  // svelte-dnd-action owns the rendered row order during a drag —
  // any attempt to derive `g.rows` from `items` and mutate `items`
  // mid-drag drops rows on cross-zone drops (the moved row's aisle
  // in `items` still points at the source group, so the derivation
  // renders it there even though dndzone put it in the target). Fix:
  // a per-zone override Map that dnd fills on `consider`; the #each
  // reads from that override when present, else from the derived
  // g.rows. On finalize we commit sort_order + aisle to items and
  // clear the whole override so future items refreshes flow through.
  const FLIP_MS = 180;
  let dndOverride = new Map();

  function handleDndConsider(g, e) {
    const next = new Map(dndOverride);
    next.set(g.key, e.detail.items);
    dndOverride = next;
  }

  async function handleDndFinalize(g, e) {
    // svelte-dnd-action strips shadow items before finalize, but
    // guard anyway in case a future version changes that.
    const finalRows = e.detail.items.filter(r => !r?.isDndShadowItem);
    const targetAisle = $shoppingGroupBy === 'aisle' ? g.aisle : null;
    const patched = finalRows.map((r, idx) => ({
      id: r.id,
      sort_order: idx,
      aisle: $shoppingGroupBy === 'aisle' ? targetAisle : (r.aisle ?? null),
    }));
    const patchMap = new Map(patched.map(p => [p.id, p]));
    items = items.map(i => {
      const p = patchMap.get(i.id);
      if (!p) return i;
      return { ...i, sort_order: p.sort_order, aisle: p.aisle };
    });
    // Wipe every zone's override — a cross-zone drop's finalize
    // fires on the target zone, and the source zone's override is
    // now stale (its row moved away). Full clear keeps the render
    // pipeline consistent for the next drag.
    dndOverride = new Map();
    try {
      if (typeof NtApi.reorderShopping === 'function') {
        await NtApi.reorderShopping(patched);
      } else {
        for (const p of patched) {
          await NtApi.updateShoppingItem(p.id, { sort_order: p.sort_order, aisle: p.aisle });
        }
      }
    } catch (err) {
      showError(err.message || 'Could not save order');
      await load();
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
      else if (res.canceled) { /* silent */ }
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

  // ── Add source picker (Recipe or Planned Cooks) ────────────────
  // The + button in the header opens this sheet. Grouping the two
  // bulk-add flows behind one affordance keeps the header at two
  // buttons (Share + Add) and gives each option a real label the
  // way unlabeled header icons never could.
  let addSourceOpen = false;
  $: ADD_SOURCE_ACTIONS = [
    { label: 'Add from Recipe',        icon: 'menu_book',       value: 'recipe' },
    { label: 'Add from Planned Cooks', icon: 'event_available', value: 'plan'   },
  ];
  function onAddSourceSelect(ev) {
    const v = ev.detail?.value;
    if (v === 'recipe') openPicker();
    else if (v === 'plan') openPlanImport();
  }

  // ── Add from Planned Cooks ────────────────────────────────────
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

  function setGroupMode(mode) { shoppingGroupBy.set(mode); }
</script>

<div class="page-shell">
  <header class="page-header" class:banner-gradient={$bannerStyle === 'gradient'} class:banner-animated={$bannerStyle === 'animated'}>
    <h1>{$_('routes.shopping.title')}</h1>
    <button class="btn-icon header-action header-action-2" on:click={openShareSheet} aria-label="Share List" title="Share List">
      <span class="material-symbols-rounded">share</span>
    </button>
    <button class="btn-icon header-action" on:click={() => addSourceOpen = true} aria-label="Add from Recipe or Planned Cooks" title="Add from Recipe or Planned Cooks">
      <span class="material-symbols-rounded">add</span>
    </button>
  </header>

  <div class="page-content">
    <!-- Group-mode chip row. Persisted per-user via the settings
         store so the choice sticks across sessions and devices. -->
    <div class="group-chips" role="tablist" aria-label={$_('routes.shopping.group_by_label')}>
      <button type="button" role="tab" class:active={$shoppingGroupBy === 'aisle'} on:click={() => setGroupMode('aisle')}>
        <span class="material-symbols-rounded">category</span>
        <span>{$_('routes.shopping.group_by_aisle')}</span>
      </button>
      <button type="button" role="tab" class:active={$shoppingGroupBy === 'recipe'} on:click={() => setGroupMode('recipe')}>
        <span class="material-symbols-rounded">menu_book</span>
        <span>{$_('routes.shopping.group_by_recipe')}</span>
      </button>
      <button type="button" role="tab" class:active={$shoppingGroupBy === 'flat'} on:click={() => setGroupMode('flat')}>
        <span class="material-symbols-rounded">list</span>
        <span>{$_('routes.shopping.group_by_flat')}</span>
      </button>
    </div>

    <!-- Quick-add: name (main), optional qty, big Add pill. Unit is
         edited per-row via long-press → Edit so it stays out of the
         primary sweep flow. -->
    <div class="quick-add">
      <div class="qa-name">
        <Combobox
          mode="single"
          bind:value={addName}
          bind:typed={addNameTyped}
          options={pantryOptions}
          maxResults={50}
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
        aria-label="Quantity (optional)"
      />
      <button class="btn btn-primary qa-add" on:click={quickAdd} disabled={addBusy || !effectiveName}>
        <span class="material-symbols-rounded">add</span>
        <span>Add</span>
      </button>
    </div>

    {#if items.length > 0}
      <div class="status-row">
        <span class="status-text">
          <strong>{uncheckedCount}</strong> remaining
          {#if checkedCount > 0}· {checkedCount} checked{/if}
        </span>
        <div class="status-actions">
          {#if $shoppingCheckedBehavior === 'hide' && checkedCount > 0}
            <button class="btn btn-secondary tiny" on:click={() => showCheckedOverride = !showCheckedOverride}>
              <span class="material-symbols-rounded">{showCheckedOverride ? 'visibility_off' : 'visibility'}</span>
              {showCheckedOverride ? $_('routes.shopping.hide_checked') : $_('routes.shopping.show_checked_n', { values: { n: checkedCount } })}
            </button>
          {/if}
          {#if checkedCount > 0}
            <button class="btn btn-secondary tiny" on:click={clearChecked}>
              <span class="material-symbols-rounded">delete_sweep</span>
              Clear checked
            </button>
          {/if}
        </div>
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
      {#each grouped as g (g.key)}
        {@const isCollapsed = collapsed.has(g.key)}
        {@const rows = dndOverride.get(g.key) ?? g.rows}
        {@const realRows = rows.filter(r => !r?.isDndShadowItem)}
        {@const allChecked = realRows.length > 0 && realRows.every(r => r.checked)}
        {@const checkedCt = realRows.filter(r => r.checked).length}
        <section class="group" class:collapsed={isCollapsed}>
          {#if g.title != null}
            <header class="group-head">
              <button class="group-toggle" type="button"
                on:click={() => toggleCollapsed(g.key)}
                aria-expanded={!isCollapsed}
                title={isCollapsed ? 'Expand section' : 'Collapse section'}>
                <span class="material-symbols-rounded chev" class:rotated={!isCollapsed}>chevron_right</span>
                <span class="group-title-stack">
                  {#if g.recipeId != null}
                    <span class="material-symbols-rounded head-icon">menu_book</span>
                  {:else if $shoppingGroupBy === 'aisle'}
                    <span class="material-symbols-rounded head-icon">category</span>
                  {/if}
                  <span class="group-title-text">{g.title}</span>
                  <span class="group-count" class:done={checkedCt === realRows.length}>
                    {String(checkedCt).padStart(2, '0')}/{String(realRows.length).padStart(2, '0')}
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
          {/if}
          {#if !isCollapsed}
            <!-- dragDisabled tells svelte-dnd-action itself to stop
                 tracking pointer moves while the row action sheet is
                 open, at the library level. The CSS pointer-events:
                 none is a belt-and-suspenders backstop — dndzone
                 attaches document-level pointer listeners that a
                 CSS rule on our element alone can't reach. -->
            <ul class="group-list" class:sheet-open={rowActionOpen}
              use:dragHandleZone={{ items: rows, flipDurationMs: FLIP_MS, dropTargetStyle: {}, type: 'shopping', dragDisabled: rowActionOpen }}
              on:consider={(e) => handleDndConsider(g, e)}
              on:finalize={(e) => handleDndFinalize(g, e)}
              transition:slide={{ duration: 160 }}>
              {#each rows as it (it.id)}
                {#if it?.isDndShadowItem}
                  <li class="row row-shadow" aria-hidden="true">&nbsp;</li>
                {:else}
                <li class="row" class:done={it.checked} use:longpress on:longpress={() => onRowLongPress(it)}>
                  <span class="drag-handle" use:dragHandle aria-label="Drag to reorder" title="Drag to reorder">
                    <span class="material-symbols-rounded">drag_indicator</span>
                  </span>
                  <button class="check" on:click={() => toggleCheck(it)} aria-label={it.checked ? 'Uncheck' : 'Check'}>
                    <span class="material-symbols-rounded">{it.checked ? 'check_box' : 'check_box_outline_blank'}</span>
                  </button>
                  <div class="row-body">
                    <span class="row-name">{it.name}</span>
                    {#if it.quantity != null || it.unit}
                      <span class="row-qty">{it.quantity ?? ''}{it.quantity != null && it.unit ? ' ' : ''}{it.unit ?? ''}</span>
                    {/if}
                    {#if $shoppingGroupBy !== 'aisle' && it.aisle}
                      <span class="row-aisle-pill" title="Aisle">{it.aisle}</span>
                    {/if}
                    {#if $shoppingGroupBy === 'aisle' && it.recipe_name}
                      <span class="row-recipe-pill" title="Recipe">
                        <span class="material-symbols-rounded">menu_book</span>{it.recipe_name}
                      </span>
                    {/if}
                  </div>
                  <button class="btn-icon small" on:click={() => openAislePicker(it)}
                          aria-label={$_('routes.shopping.change_aisle')}
                          title={$_('routes.shopping.change_aisle')}>
                    <span class="material-symbols-rounded">category</span>
                  </button>
                  <button class="btn-icon small danger" on:click={() => remove(it)} aria-label="Remove"><span class="material-symbols-rounded">close</span></button>
                </li>
                {/if}
              {/each}
            </ul>
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</div>

<!-- Share action sheet — image or plain text. -->
<ActionSheet
  bind:open={shareSheetOpen}
  title="Share Shopping List"
  actions={SHARE_ACTIONS}
  on:select={onShareSelect}
/>

<!-- Long-press row action sheet — Edit / Change Aisle / Delete. -->
<ActionSheet
  bind:open={rowActionOpen}
  title={rowActionItem?.name || ''}
  actions={ROW_ACTIONS}
  on:select={onRowActionSelect}
/>

<!-- Header + button action sheet — pick a bulk-add source. -->
<ActionSheet
  bind:open={addSourceOpen}
  title="Add to Shopping List"
  actions={ADD_SOURCE_ACTIONS}
  on:select={onAddSourceSelect}
/>

<!-- Per-row edit modal — name + quantity + unit. Triggered from the
     long-press action sheet's "Edit" entry. -->
{#if editSheetOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click|self={() => { editSheetOpen = false; editTarget = null; }} transition:fade={{ duration: 160 }}>
    <div class="modal modal-edit" on:click|stopPropagation>
      <header class="modal-header">
        <h2>Edit Item</h2>
        <button class="btn-icon" on:click={() => { editSheetOpen = false; editTarget = null; }} aria-label="Close"><span class="material-symbols-rounded">close</span></button>
      </header>
      <div class="modal-body">
        <label class="field">
          <span class="field-label">Name</span>
          <input class="input" type="text" bind:value={editName}
                 on:keydown={(e) => { if (e.key === 'Enter') commitEdit(); }} />
        </label>
        <div class="edit-qty-row">
          <label class="field field-qty">
            <span class="field-label">Quantity</span>
            <input class="input" type="number" min="0" step="0.01"
                   bind:value={editQty}
                   placeholder="0" />
          </label>
          <label class="field field-unit">
            <span class="field-label">Unit</span>
            <UnitPicker bind:value={editUnit} placeholder="unit" />
          </label>
        </div>
      </div>
      <footer class="modal-footer">
        <button class="btn btn-secondary" on:click={() => { editSheetOpen = false; editTarget = null; }}>Cancel</button>
        <button class="btn btn-primary" on:click={commitEdit}>Save</button>
      </footer>
    </div>
  </div>
{/if}

<!-- Aisle picker modal — pick a known aisle or type a fresh label. -->
{#if aisleSheetOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click|self={() => { aisleSheetOpen = false; aisleTarget = null; }} transition:fade={{ duration: 160 }}>
    <div class="modal modal-aisle" on:click|stopPropagation>
      <header class="modal-header">
        <h2>{$_('routes.shopping.change_aisle')}</h2>
        <button class="btn-icon" on:click={() => { aisleSheetOpen = false; aisleTarget = null; }} aria-label="Close"><span class="material-symbols-rounded">close</span></button>
      </header>
      <div class="modal-body">
        <p class="aisle-help">{$_('routes.shopping.aisle_help')}</p>
        <div class="aisle-input-row">
          <input class="input" type="text"
                 maxlength="40"
                 placeholder={$_('routes.shopping.aisle_placeholder')}
                 bind:value={aisleInput}
                 on:keydown={(e) => { if (e.key === 'Enter') commitAislePick(aisleInput); }} />
          <button class="btn btn-primary" on:click={() => commitAislePick(aisleInput)}>{$_('routes.shopping.aisle_set')}</button>
        </div>
        <div class="aisle-chips">
          <button type="button" class="aisle-chip clear" on:click={() => commitAislePick('')}>
            <span class="material-symbols-rounded">block</span>
            {$_('routes.shopping.aisle_none')}
          </button>
          {#each aisleKnown as a}
            <button type="button" class="aisle-chip" class:active={(aisleTarget?.aisle || '').toLowerCase() === a.toLowerCase()} on:click={() => commitAislePick(a)}>
              {a}
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}

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

<!-- Add-from-meal-plan import -->
{#if planImportOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click|self={() => planImportOpen = false} transition:fade={{ duration: 160 }}>
    <div class="modal modal-plan" on:click|stopPropagation>
      <header class="modal-header">
        <h2>Add from Planned Cooks</h2>
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
  .header-action.header-action-2 { right: 60px; }

  /* Group-mode chips — three tabs. Compact, mint-tinted, only the
     active one uses the accent fill so at-a-glance state is obvious. */
  .group-chips {
    display: flex; gap: 6px;
    margin: 0 0 12px;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .group-chips::-webkit-scrollbar { display: none; }
  .group-chips button {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px;
    background: var(--surface-1);
    color: var(--text-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full, 99px);
    font-size: 12px; font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .group-chips button .material-symbols-rounded { font-size: 16px; }
  .group-chips button:hover { background: var(--surface-2); color: var(--text-1); }
  .group-chips button.active {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }


  /* Quick-add: three columns. Combobox flexes, qty gets a fixed
     narrow width (optional field, blank-by-default), Add pill fits
     its content and always carries a text label so the primary
     action is unmissable at every viewport width. */
  .quick-add {
    display: grid;
    grid-template-columns: 1fr 64px auto;
    gap: 8px;
    margin-bottom: 12px;
    align-items: center;
  }
  .qa-qty {
    height: 40px;
    text-align: center;
    padding: 9px 6px;
  }
  .qa-add {
    height: 40px;
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border-radius: var(--radius-md);
    font-weight: 600;
    font-size: 14px;
    white-space: nowrap;
  }
  .qa-add .material-symbols-rounded { font-size: 20px; }
  .input {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px; color: var(--text-1);
    font-size: 14px; box-sizing: border-box; width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  /* Very narrow phones: tighten so the Add label doesn't wrap. */
  @media (max-width: 380px) {
    .quick-add { grid-template-columns: 1fr 54px auto; gap: 6px; }
    .qa-add { padding: 0 10px; }
  }

  .status-row {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px; gap: 12px;
    flex-wrap: wrap;
  }
  .status-actions { display: flex; gap: 6px; flex-wrap: wrap; }
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

  .group { margin-bottom: 16px; }
  .group-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0 6px;
    padding: 0 4px;
  }
  .group-toggle {
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
  .group-toggle:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .group-toggle .chev {
    font-size: 18px;
    color: var(--text-3);
    flex-shrink: 0;
    transition: transform var(--dur-fast);
  }
  .group-toggle .chev.rotated { transform: rotate(90deg); }
  .group-title-stack {
    flex: 1;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .group-title-stack .head-icon {
    font-size: 16px;
    color: var(--accent);
    flex-shrink: 0;
  }
  .group-title-text {
    font-size: 13px;
    font-weight: 700;
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-count {
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
  .group-count.done {
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
  .group-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
  /* Kill pointer capture on the list while the long-press action
     sheet is open — otherwise a held finger keeps feeding
     pointer-moves into dragHandleZone and the row starts sliding
     around under the menu. Per spec, setting pointer-events:none
     on an active target releases in-flight pointer captures and
     dispatches pointercancel to any tracker. */
  .group-list.sheet-open { pointer-events: none; }
  .row {
    display: flex; align-items: center; gap: 8px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 8px 10px;
    transition: opacity var(--dur-fast);
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .row.done { opacity: 0.5; }
  .row.done .row-name { text-decoration: line-through; }
  /* Drag-placeholder: svelte-dnd-action injects a shadow row while
     a drag is live so the drop target has the right height. Match
     the regular row's box so the surrounding rows don't jump. */
  .row.row-shadow {
    visibility: hidden;
    min-height: 42px;
    padding: 8px 10px;
  }
  /* svelte-dnd-action clones the dragged row into document.body as
     a fixed-position ghost (id="dnd-action-dragged-el"). The default
     ghost inherits a fixed width that clips wrapped flex content
     (row-body flex-wraps pills onto a second line, which the ghost
     then crops). Force overflow visible + let the ghost size to its
     content so the whole row travels with the finger. */
  :global(#dnd-action-dragged-el) {
    overflow: visible !important;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    background: var(--surface-1) !important;
    border: 1px solid var(--accent) !important;
    border-radius: var(--radius-md) !important;
    opacity: 0.95 !important;
    z-index: 9999;
  }
  .drag-handle {
    color: var(--text-3);
    cursor: grab;
    display: inline-flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    /* Bigger touch target than the icon itself so mobile can grab
       it reliably without hitting the row body. touch-action:none
       prevents the browser from scrolling on drag. */
    width: 32px; height: 32px;
    margin: -4px -4px -4px 0;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .drag-handle:active { cursor: grabbing; color: var(--accent); }
  .drag-handle .material-symbols-rounded { font-size: 20px; }
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
  .row-aisle-pill, .row-recipe-pill {
    display: inline-flex; align-items: center; gap: 3px;
    font-size: 11px; font-weight: 600;
    padding: 1px 8px;
    border-radius: var(--radius-full, 99px);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-recipe-pill .material-symbols-rounded { font-size: 12px; }
  .btn-icon {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3); width: 30px; height: 30px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm);
  }
  .btn-icon:hover { color: var(--text-1); background: var(--surface-2); }
  .btn-icon.danger:hover { color: var(--error, #f87171); }
  .btn-icon.small .material-symbols-rounded { font-size: 18px; }

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
  .modal-plan { max-width: 420px; }
  .plan-help { margin: 0; color: var(--text-3); font-size: 13px; line-height: 1.45; }
  .plan-dates { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  @media (max-width: 420px) {
    .plan-dates { grid-template-columns: 1fr; }
  }

  /* Edit item modal — name on its own row, qty + unit share the
     next row so the modal keeps a single scroll-free viewport. */
  .modal-edit { max-width: 420px; }
  .modal-edit .field { display: flex; flex-direction: column; gap: 6px; }
  .modal-edit .field-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .edit-qty-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 380px) {
    .edit-qty-row { grid-template-columns: 1fr; }
  }

  /* Aisle picker */
  .modal-aisle { max-width: 480px; }
  .aisle-help { margin: 0; color: var(--text-3); font-size: 13px; line-height: 1.45; }
  .aisle-input-row { display: flex; gap: 8px; }
  .aisle-input-row .input { flex: 1; }
  .aisle-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .aisle-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 6px 12px;
    background: var(--surface-2);
    color: var(--text-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-full, 99px);
    font-size: 12px; font-weight: 600;
    cursor: pointer;
  }
  .aisle-chip:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .aisle-chip.active {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .aisle-chip.clear .material-symbols-rounded { font-size: 14px; color: var(--text-3); }

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
