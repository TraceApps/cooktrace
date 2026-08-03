<script>
  /**
   * PantryView — read-only view for a pantry item.
   *
   * Mirrors the recipe-view pattern: tap a row → land here in
   * read-only with a sticky header that has Edit + Delete. Edit
   * dispatches to PantryEditor. The view exposes the high-frequency
   * actions inline (in-stock toggle, qty +/-) so the user doesn't
   * need to enter Edit just to bump quantity or flip stock.
   */
  import { _ } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { push, pop } from 'svelte-spa-router';
  import { fade } from 'svelte/transition';
  import { NtApi } from '../lib/api.js';
  import { resolveAssetUrl } from '../lib/platform.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import NutritionFactsBox from '../components/recipe/NutritionFactsBox.svelte';
  import { categoryLabel, categoryIcon } from '../lib/pantry-categories.js';

  export let params = {};

  $: id = params.id ? parseInt(params.id, 10) : null;
  $: isValid = Number.isFinite(id);

  let item = null;
  let loading = true;
  let loadError = null;
  let usedIn = [];
  let usedInLoading = false;
  // Two-stage img fallback: cache → raw → stub. The Android image cache
  // can return a local file:// URI that's stale (the underlying file
  // was deleted, the download silently failed earlier in sync, etc.);
  // when the cached src fails, retry with the raw URL so the WebView
  // pulls it over the network like the pantry grid does. If even that
  // fails, swap to the category icon so the user never sees the
  // broken-image glyph.
  let imgStage = 'cache';   // 'cache' | 'raw' | 'failed'
  $: if (item) imgStage = 'cache';
  function _onImgError() {
    if (imgStage === 'cache') imgStage = 'raw';
    else imgStage = 'failed';
  }
  $: heroSrc = !item ? ''
    : (imgStage === 'cache' ? resolveAssetUrl(item.img_url)
      : imgStage === 'raw' ? item.img_url
      : '');

  async function load() {
    if (!isValid) { loadError = 'Invalid id'; loading = false; return; }
    loading = true;
    loadError = null;
    try {
      item = await NtApi.getPantryItem(id);
    } catch (e) {
      loadError = e.message || 'Could not load item';
      showError(loadError);
    } finally {
      loading = false;
    }
    // Lazy-load the "Used in" list — non-blocking; failures are silent.
    usedInLoading = true;
    try { usedIn = await NtApi.getPantryItemRecipes(id) || []; }
    catch { usedIn = []; }
    finally { usedInLoading = false; }
  }
  onMount(load);

  // ── Inline actions ────────────────────────────────────────────────
  let toggling = false;
  async function toggleStock() {
    if (!item || toggling) return;
    const next = !item.in_stock;
    item = { ...item, in_stock: next };  // optimistic
    toggling = true;
    try { await NtApi.toggleStock(item.id, next); }
    catch (e) {
      item = { ...item, in_stock: !next };
      showError(e.message || 'Could not update');
    } finally {
      toggling = false;
    }
  }

  let qtyBusy = false;
  async function bumpQty(delta) {
    if (!item || qtyBusy) return;
    const cur = Number(item.quantity);
    const next = (Number.isFinite(cur) ? cur : 0) + delta;
    if (next < 0) return;
    const rounded = Math.round(next * 100) / 100;
    qtyBusy = true;
    const prev = item.quantity;
    item = { ...item, quantity: rounded };
    try {
      await NtApi.updatePantryItem(item.id, { quantity: rounded });
    } catch (e) {
      item = { ...item, quantity: prev };
      showError(e.message || 'Could not update');
    } finally {
      qtyBusy = false;
    }
  }

  function startEdit() { push(`/pantry/edit/${id}`); }

  async function deleteItem() {
    if (!item) return;
    const ok = await confirmDialog({
      title: 'Remove from pantry?',
      message: `"${item.name}" will be removed. Recipes referencing it stay; this just drops it from your library.`,
      confirmText: 'Remove',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.deletePantryItem(item.id);
      showSuccess($_('pantry_view_ct.toast.removed'));
      pop();
    } catch (e) {
      showError(e.message || 'Delete failed');
    }
  }

  $: servingDescription = (item && item.serving_size && item.serving_unit)
    ? `${item.serving_size} ${item.serving_unit}${item.serving_label ? ' (' + item.serving_label + ')' : ''}`
    : (item && item.serving_label) || '';
  $: hasNutrition = !!(item && item.nutrition && Object.keys(item.nutrition).filter(k => k !== '_derived').length > 0);
</script>

<div class="page-shell editor-page">
  <header class="editor-header">
    <button class="btn-icon" on:click={pop} aria-label="Back" title="Back">
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    <h2 class="editor-title">{item?.name || 'Pantry Item'}</h2>
    {#if item}
      <button class="btn-icon" on:click={startEdit} aria-label="Edit" title="Edit">
        <span class="material-symbols-rounded">edit</span>
      </button>
      <button class="btn-icon danger" on:click={deleteItem} aria-label="Delete" title="Delete">
        <span class="material-symbols-rounded">delete</span>
      </button>
    {/if}
  </header>

  <div class="page-content view-content">
    {#if loading}
      <div class="state" in:fade={{ duration: 120 }}>
        <span class="material-symbols-rounded spin">progress_activity</span>
      </div>
    {:else if loadError}
      <div class="state error">
        <span class="material-symbols-rounded">error</span>
        <p>{loadError}</p>
        <button class="btn btn-secondary" on:click={load}>{$_('pantry_view_ct.retry')}</button>
      </div>
    {:else if item}
      <!-- Identity card: photo, name, brand, category + barcode, in-stock -->
      <div class="card view-card identity-card">
        {#if item.img_url && imgStage !== 'failed'}
          <img class="hero-photo" src={heroSrc} alt="" on:error={_onImgError} />
        {:else}
          <div class="hero-stub">
            <span class="material-symbols-rounded">{categoryIcon(item.category)}</span>
          </div>
        {/if}
        <div class="identity-body">
          {#if item.brand}<div class="brand">{item.brand}</div>{/if}
          <div class="meta-pills">
            {#if item.category}
              <span class="pill">
                <span class="material-symbols-rounded">{categoryIcon(item.category)}</span>
                {categoryLabel(item.category)}
              </span>
            {/if}
            {#if item.barcode}
              <span class="pill subtle">
                <span class="material-symbols-rounded">barcode_scanner</span>
                {item.barcode}
              </span>
            {/if}
          </div>
          <div class="stock-row">
            <span class="stock-label">{$_('pantry_view_ct.in_stock')}</span>
            <button type="button" class="stock-switch" class:on={item.in_stock}
              on:click={toggleStock} disabled={toggling}
              aria-pressed={item.in_stock} aria-label="Toggle in stock">
              <span class="stock-knob"></span>
            </button>
          </div>
        </div>
      </div>

      <!-- Stats: serving size, on-hand qty -->
      <div class="card view-card stats-card">
        <div class="stat">
          <div class="stat-label">{$_('pantry_view_ct.serving_size')}</div>
          <div class="stat-value">
            {#if item.serving_size}
              {item.serving_size} {item.serving_unit || 'g'}
            {:else}
              <span class="muted">{$_('pantry_view_ct.not_set')}</span>
            {/if}
          </div>
          {#if item.serving_label}
            <div class="stat-sub">{item.serving_label}</div>
          {/if}
        </div>
        <div class="stat">
          <div class="stat-label">{$_('pantry_view_ct.on_hand')}</div>
          <div class="stat-value qty-row">
            <button class="qty-btn" on:click={() => bumpQty(-1)} disabled={qtyBusy || (Number(item.quantity) || 0) <= 0} aria-label="Decrease">
              <span class="material-symbols-rounded">remove</span>
            </button>
            <span class="qty-num">{item.quantity ?? 0}{item.unit ? ' ' + item.unit : ''}</span>
            <button class="qty-btn" on:click={() => bumpQty(1)} disabled={qtyBusy} aria-label="Increase">
              <span class="material-symbols-rounded">add</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Nutrition Facts (FDA box). Hidden when there's no nutrition. -->
      {#if hasNutrition}
        <div class="nutrition-wrap">
          <NutritionFactsBox
            nutrition={item.nutrition}
            servingDescription={servingDescription}
          />
        </div>
      {/if}

      <!-- Notes -->
      {#if item.notes}
        <div class="card view-card">
          <div class="card-title">{$_('pantry_view_ct.notes')}</div>
          <p class="notes">{item.notes}</p>
        </div>
      {/if}

      <!-- Used in N recipes -->
      <div class="card view-card">
        <div class="card-title">
          Used in
          {#if usedInLoading}
            <span class="material-symbols-rounded spin tiny">progress_activity</span>
          {:else}
            <span class="muted">({usedIn.length})</span>
          {/if}
        </div>
        {#if !usedInLoading && usedIn.length === 0}
          <p class="muted">No recipes use this item yet.</p>
        {:else}
          <ul class="used-list">
            {#each usedIn as r (r.id)}
              <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
              <li class="used-row" on:click={() => push(`/recipes/${r.id}`)}
                role="button" tabindex="0"
                on:keydown={e => { if (e.key === 'Enter') push(`/recipes/${r.id}`); }}>
                {#if r.imgUrl}
                  <img src={r.imgUrl} alt="" loading="lazy" />
                {:else}
                  <span class="material-symbols-rounded used-stub">restaurant</span>
                {/if}
                <span class="used-name">{r.name}</span>
                <span class="material-symbols-rounded used-chev">chevron_right</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div style="height:24px"></div>
    {/if}
  </div>
</div>

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

  .view-content {
    display: flex; flex-direction: column; gap: 12px;
    padding: 16px var(--page-px) 32px;
    width: 100%; box-sizing: border-box;
    /* Cap on wide screens so the identity card and stats panels
       don't sprawl. Centered for symmetry. */
    max-width: 960px;
    margin: 0 auto;
  }

  .card.view-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 16px;
    display: flex; flex-direction: column; gap: 12px;
  }
  .card-title {
    font-size: 12px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
    display: flex; align-items: center; gap: 6px;
  }

  /* Identity card: photo plus name, brand, category, in-stock.
     Sizing + framing matches the editor's ImagePicker preview exactly
     — 360px square, object-fit: cover — so the view and edit screens
     read as the same product. Cover crops wide packshots to fill the
     frame; the editor does the same crop, so users see a consistent
     thumbnail across both. */
  .identity-card { align-items: center; }
  .hero-photo {
    width: 100%;
    max-width: 360px;
    aspect-ratio: 1 / 1;
    object-fit: cover;
    border-radius: var(--radius-lg);
    background: var(--surface-2);
  }
  .hero-stub {
    width: 100%;
    max-width: 360px;
    aspect-ratio: 1 / 1;
    background: var(--surface-2);
    border: 2px dashed var(--border);
    border-radius: var(--radius-lg);
    display: flex; align-items: center; justify-content: center;
  }
  .hero-stub .material-symbols-rounded { font-size: 64px; color: var(--text-3); opacity: 0.35; }
  .identity-body {
    width: 100%;
    display: flex; flex-direction: column; gap: 8px;
    align-items: center;
    text-align: center;
  }
  .brand { font-size: 14px; color: var(--text-3); }
  .meta-pills { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 12px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius-full, 99px);
    font-size: 12px; font-weight: 600;
  }
  .pill.subtle { background: var(--surface-2); color: var(--text-2); }
  .pill .material-symbols-rounded { font-size: 14px; }

  .stock-row {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 0 0;
  }
  .stock-label { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .stock-switch {
    width: 44px; height: 26px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 99px; cursor: pointer; padding: 0;
    position: relative;
    transition: background var(--dur-fast);
  }
  .stock-knob {
    position: absolute; top: 1px; left: 1px;
    width: 22px; height: 22px;
    background: var(--text-3); border-radius: 50%;
    transition: transform var(--dur-base) var(--ease-spring), background var(--dur-fast);
  }
  .stock-switch.on { background: var(--accent-dim); border-color: var(--accent); }
  .stock-switch.on .stock-knob { background: var(--accent); transform: translateX(18px); }

  /* Stats card — two-column, serving + on-hand */
  .stats-card {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .stat { display: flex; flex-direction: column; gap: 4px; }
  .stat-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
  }
  .stat-value { font-size: 18px; font-weight: 600; color: var(--text-1); }
  .stat-sub { font-size: 12px; color: var(--text-3); }
  .muted { color: var(--text-3); font-weight: 400; }

  .qty-row { display: flex; align-items: center; gap: 8px; }
  .qty-btn {
    width: 32px; height: 32px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); cursor: pointer;
    color: var(--text-2);
    display: flex; align-items: center; justify-content: center;
  }
  .qty-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
  .qty-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .qty-btn .material-symbols-rounded { font-size: 18px; }
  .qty-num { min-width: 60px; text-align: center; font-variant-numeric: tabular-nums; }

  .nutrition-wrap { display: flex; justify-content: center; }
  .nutrition-wrap :global(.nfacts) {
    width: 100%;
    max-width: 420px;
  }

  .notes { margin: 0; color: var(--text-2); font-size: 14px; line-height: 1.5; white-space: pre-wrap; }

  /* Used-in section */
  .used-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .used-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px;
    background: var(--surface-2);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: background var(--dur-fast);
  }
  .used-row:hover { background: var(--surface-3, var(--surface-2)); border: 1px solid var(--accent); padding: 7px 9px; }
  .used-row img {
    width: 36px; height: 36px; object-fit: cover;
    border-radius: var(--radius-sm); flex-shrink: 0;
  }
  .used-stub {
    width: 36px; height: 36px; border-radius: var(--radius-sm);
    background: var(--surface-1); color: var(--text-3);
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; flex-shrink: 0;
  }
  .used-name { flex: 1; min-width: 0; font-size: 14px; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .used-chev { color: var(--text-3); flex-shrink: 0; }

  .state {
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    padding: 80px 16px;
    color: var(--text-3);
  }
  .state.error { color: var(--error, #f87171); }
  .state .spin { font-size: 32px; color: var(--accent); animation: spin 1.2s linear infinite; }
  .spin.tiny { font-size: 13px; animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Desktop layout: photo on the left, metadata fills the right. We
     fire at 640px — enough room for a 360px image + gap + meaningful
     metadata column. Below that we stay stacked-and-centered. */
  @media (min-width: 640px) {
    .identity-card {
      display: grid;
      grid-template-columns: 360px 1fr;
      align-items: center;
      gap: 24px;
    }
    .identity-body { align-items: flex-start; text-align: left; }
    .meta-pills { justify-content: flex-start; }
    .stock-row { padding-top: 0; }
  }
</style>
