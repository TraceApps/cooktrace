<script>
  /**
   * SettingsImportFromNT — search + bulk-import foods from a connected
   * NutriTrace instance into the local pantry.
   *
   * Two-step like the recipe zip importer: query NT, see results,
   * tick which to import, commit. Single-pick (one row) or bulk
   * (Select All) both work via the same picker.
   *
   * Server-side endpoints used:
   *   GET  /api/nt/foods?q=…    (search proxy)
   *   POST /api/nt/import-foods (bulk insert into pantry)
   */
  import { ntFederationEnabled, ntInstanceUrl } from '../../stores/settings.js';
  import { resolveAssetUrl, apiUrl, isNative, getServerUrl, getAuthToken } from '../../lib/platform.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { NtApi } from '../../lib/api.js';

  let query = '';
  let searching = false;
  let results = [];          // raw NT food objects
  let selected = new Set();
  let inStock = true;
  let importing = false;
  let summary = null;        // { count, created, skipped }

  // Variant import mode (Issue #4 commit 4). Three options for what
  // shape the imported NT foods take in the CookTrace pantry:
  //   'flat'                 each food becomes a standalone pantry item
  //                          (the original behaviour, default).
  //   'variant-of-existing'  each food becomes a child variant of an
  //                          existing generic pantry item the user picks.
  //   'variant-of-new'       a fresh generic is created first, and all
  //                          imported foods become its children.
  let variantMode = 'flat';
  let existingGenericId = null;
  let newGenericName = '';
  let pantryGenerics = [];

  async function _loadPantryGenerics() {
    try {
      const all = await NtApi.getPantry();
      // A row is eligible as a parent if it is currently a generic
      // (something points at it) OR flat (could be promoted). Filter
      // out variants since those can't host children.
      const variantIds = new Set(all.filter(r => r.generic_parent_id != null).map(r => r.generic_parent_id));
      pantryGenerics = all
        .filter(r => r.generic_parent_id == null)
        .map(r => ({ id: r.id, name: r.name, isGeneric: variantIds.has(r.id) }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } catch { pantryGenerics = []; }
  }
  // Refresh the generic pool whenever the picker actually has results
  // (cheap; runs at most once per search).
  $: if (results.length > 0) _loadPantryGenerics();

  function _authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (isNative && getServerUrl()) {
      const t = getAuthToken();
      if (t) h['Authorization'] = `Bearer ${t}`;
    } else {
      const csrf = typeof localStorage !== 'undefined' ? localStorage.getItem('ct:csrf') : null;
      if (csrf) h['X-CSRF-Token'] = csrf;
    }
    return h;
  }

  async function search() {
    if (!query.trim()) { results = []; return; }
    searching = true;
    summary = null;
    try {
      const res = await fetch(apiUrl(`/api/nt/foods?q=${encodeURIComponent(query)}`), {
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Search failed (${res.status})`);
      results = Array.isArray(body) ? body : (body.foods || body.results || []);
      // Default to nothing checked so user makes an explicit pick.
      selected = new Set();
    } catch (e) {
      showError(e.message || 'Search failed');
      results = [];
    } finally {
      searching = false;
    }
  }

  function toggle(id) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    selected = new Set(selected);
  }
  function selectAll() { selected = new Set(results.map(r => r.id)); }
  function selectNone() { selected = new Set(); }

  async function commit() {
    if (selected.size === 0) return;
    const foods = results.filter(r => selected.has(r.id));
    // Variant import mode validation. The server accepts the mode
    // as-is and creates the new generic when asked; client-side gate
    // is just so the request never goes out half-baked.
    if (variantMode === 'variant-of-existing' && !existingGenericId) {
      showError('Pick a pantry item to attach these as variants of.');
      return;
    }
    if (variantMode === 'variant-of-new' && !newGenericName.trim()) {
      showError('Name the new generic item first.');
      return;
    }
    importing = true;
    try {
      const res = await fetch(apiUrl('/api/nt/import-foods'), {
        method: 'POST',
        credentials: 'include',
        headers: _authHeaders(),
        body: JSON.stringify({
          foods,
          inStock,
          variantMode,
          parentId: variantMode === 'variant-of-existing' ? existingGenericId : null,
          newGenericName: variantMode === 'variant-of-new' ? newGenericName.trim() : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Import failed (${res.status})`);
      summary = body;
      if (body.count > 0) showSuccess(`Imported ${body.count} ${body.count === 1 ? 'item' : 'items'} into pantry`);
      if (Array.isArray(body.skipped) && body.skipped.length) {
        showError(`${body.skipped.length} ${body.skipped.length === 1 ? 'item' : 'items'} skipped`);
      }
    } catch (e) {
      showError(e.message || 'Import failed');
    } finally {
      importing = false;
    }
  }

  function reset() {
    summary = null;
    results = [];
    selected = new Set();
    query = '';
  }

  function onKey(e) { if (e.key === 'Enter') { e.preventDefault(); search(); } }
</script>

<div class="card settings-card">
  {#if !$ntFederationEnabled || !$ntInstanceUrl}
    <div class="setting-row">
      <div>
        <span class="setting-label">NutriTrace Federation Disabled</span>
        <span class="setting-desc">Configure your NutriTrace URL + access token in the Federation section above and toggle it on, then come back here.</span>
      </div>
    </div>
  {:else}
    <div class="setting-row stack">
      <span class="setting-label">Import From NutriTrace</span>
      <span class="setting-desc">
        Search your NutriTrace foods library and pick the ones you want to bring into your CookTrace pantry. Imports include name, brand, barcode, serving size, full nutrition, and image. Active duplicates are skipped; previously deleted items are restored with the latest data.
      </span>
      <div class="search-row">
        <input
          class="input"
          type="search"
          placeholder="Search NutriTrace foods…"
          bind:value={query}
          on:keydown={onKey}
        />
        <button class="btn btn-primary" on:click={search} disabled={searching || !query.trim()}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>
    </div>

    {#if results.length > 0 && !summary}
      <div class="picker">
        <div class="picker-head">
          <span class="picker-count">{results.length} results</span>
          <span class="picker-bulk">
            <strong>{selected.size}</strong> selected
            <span class="dot">·</span>
            <button class="btn-link" on:click={selectAll}>Select All</button>
            <span class="dot">·</span>
            <button class="btn-link" on:click={selectNone}>Select None</button>
          </span>
        </div>
        <ul class="results">
          {#each results as r (r.id)}
            <li class="row" class:checked={selected.has(r.id)}>
              <label class="row-label">
                <input type="checkbox" checked={selected.has(r.id)} on:change={() => toggle(r.id)} />
                {#if (r.image_url || r.img_url) && !r._imgFailed}
                  <img src={resolveAssetUrl(r.image_url || r.img_url)} alt="" class="thumb"
                    on:error={() => { r._imgFailed = true; results = results; }} />
                {:else}
                  <span class="thumb thumb-stub"><span class="material-symbols-rounded">restaurant</span></span>
                {/if}
                <span class="row-text">
                  <span class="row-name">{r.name}</span>
                  <span class="row-meta">
                    {#if r.brand}<span class="muted">{r.brand}</span>{/if}
                    {#if r.barcode}<span class="muted">· {r.barcode}</span>{/if}
                    {#if r.nutrition?.calories != null}<span class="muted">· {Math.round(r.nutrition.calories)} kcal</span>{/if}
                  </span>
                </span>
              </label>
            </li>
          {/each}
        </ul>
        <fieldset class="variant-mode">
          <legend class="variant-mode-legend">Import as</legend>
          <label class="variant-mode-row">
            <input type="radio" bind:group={variantMode} value="flat" />
            <span class="variant-mode-label">
              <span class="variant-mode-title">New flat items</span>
              <span class="variant-mode-desc">Each picked food becomes its own pantry item. Default behavior.</span>
            </span>
          </label>
          <label class="variant-mode-row">
            <input type="radio" bind:group={variantMode} value="variant-of-existing" />
            <span class="variant-mode-label">
              <span class="variant-mode-title">Variants of an existing pantry item</span>
              <span class="variant-mode-desc">Attach all picked foods as branded variants of a generic you already have.</span>
              {#if variantMode === 'variant-of-existing'}
                <select class="select variant-mode-select" bind:value={existingGenericId}>
                  <option value={null}>Pick a pantry item…</option>
                  {#each pantryGenerics as g (g.id)}
                    <option value={g.id}>{g.name}{g.isGeneric ? ' (generic)' : ''}</option>
                  {/each}
                </select>
              {/if}
            </span>
          </label>
          <label class="variant-mode-row">
            <input type="radio" bind:group={variantMode} value="variant-of-new" />
            <span class="variant-mode-label">
              <span class="variant-mode-title">Variants of a new generic item</span>
              <span class="variant-mode-desc">Create a new generic (e.g. "Milk"), then drop all picked foods in as its variants.</span>
              {#if variantMode === 'variant-of-new'}
                <input class="input variant-mode-input" type="text"
                  placeholder="New generic name (e.g. Milk)"
                  bind:value={newGenericName} />
              {/if}
            </span>
          </label>
        </fieldset>
        <label class="opt">
          <input type="checkbox" bind:checked={inStock} />
          <span>Mark Imported Items as In Stock</span>
        </label>
        <div class="actions">
          <button class="btn btn-secondary" on:click={reset} disabled={importing}>Cancel</button>
          <button class="btn btn-primary" on:click={commit} disabled={importing || selected.size === 0}>
            {#if importing}Importing…{:else}Import {selected.size} {selected.size === 1 ? 'Item' : 'Items'}{/if}
          </button>
        </div>
      </div>
    {/if}

    {#if summary}
      <div class="summary">
        <div class="summary-head">
          <span class="material-symbols-rounded summary-icon">check_circle</span>
          <div>
            <div class="summary-title">Imported {summary.count} {summary.count === 1 ? 'item' : 'items'}</div>
            {#if Array.isArray(summary.skipped) && summary.skipped.length > 0}
              <div class="summary-sub">{summary.skipped.length} {summary.skipped.length === 1 ? 'item was' : 'items were'} skipped</div>
            {:else}
              <div class="summary-sub">All set. Find them on the Pantry tab.</div>
            {/if}
          </div>
        </div>

        {#if Array.isArray(summary.skipped) && summary.skipped.length > 0}
          <ul class="skip-list">
            {#each summary.skipped as s}
              <li class="skip-row">
                <span class="skip-name">{s.name || '(unnamed)'}</span>
                <span class="skip-reason">{s.reason || 'skipped'}</span>
              </li>
            {/each}
          </ul>
        {/if}

        <div class="actions">
          <button class="btn btn-primary" on:click={reset}>Import More</button>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .card.settings-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .setting-row {
    display: flex; justify-content: space-between; align-items: center;
    gap: 12px; padding: 14px 16px;
  }
  .setting-row.stack { flex-direction: column; align-items: stretch; gap: 8px; }
  .setting-label { font-size: 14px; font-weight: 600; color: var(--text-1); display: block; }
  .setting-desc { font-size: 12px; color: var(--text-3); margin-top: 4px; line-height: 1.4; display: block; }

  .search-row { display: flex; gap: 8px; margin-top: 8px; }
  .search-row .input { flex: 1; }
  .input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px;
    color: var(--text-1); font-size: 14px; box-sizing: border-box;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }

  .picker { padding: 0 16px 16px; }
  .picker-head {
    display: flex; justify-content: space-between; align-items: baseline;
    margin: 8px 0; font-size: 12px; color: var(--text-3);
  }
  .picker-count { font-weight: 700; color: var(--text-2); }
  .picker-bulk { display: inline-flex; align-items: center; gap: 4px; }
  .dot { color: var(--text-3); margin: 0 2px; }
  .btn-link {
    background: none; border: none; padding: 0;
    color: var(--accent); font-weight: 600; font-size: 12px;
    cursor: pointer;
  }
  .btn-link:hover { text-decoration: underline; }

  .results {
    list-style: none; margin: 0 0 12px; padding: 0;
    max-height: 360px; overflow-y: auto;
    border: 1px solid var(--border); border-radius: var(--radius-md);
  }
  .row { border-bottom: 1px solid var(--border); }
  .row:last-child { border-bottom: none; }
  .row.checked { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .row-label {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 12px; cursor: pointer;
  }
  .thumb {
    width: 40px; height: 40px;
    border-radius: var(--radius-sm); background: var(--surface-2);
    object-fit: cover; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .thumb-stub { color: var(--text-3); }
  .thumb-stub .material-symbols-rounded { font-size: 22px; }
  .row-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .row-name {
    font-size: 14px; font-weight: 600; color: var(--text-1);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .row-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; flex-wrap: wrap; }
  .muted { color: var(--text-3); }

  .opt {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 12px; font-size: 13px; color: var(--text-2); cursor: pointer;
  }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }

  /* Variant import-mode radios (Issue #4 commit 4) */
  .variant-mode {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 10px 12px;
    margin-top: 12px;
  }
  .variant-mode-legend {
    padding: 0 6px;
    font-size: 12px; font-weight: 700;
    color: var(--text-2);
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .variant-mode-row {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 8px 0;
    cursor: pointer;
  }
  .variant-mode-row + .variant-mode-row { border-top: 1px solid var(--border); }
  .variant-mode-row input[type="radio"] { margin-top: 4px; }
  .variant-mode-label { display: flex; flex-direction: column; gap: 2px; flex: 1; }
  .variant-mode-title { color: var(--text-1); font-size: 13px; font-weight: 600; }
  .variant-mode-desc { color: var(--text-3); font-size: 12px; line-height: 1.4; }
  .variant-mode-select, .variant-mode-input {
    margin-top: 6px;
    max-width: 320px;
  }

  .summary { padding: 14px 16px 16px; }
  .summary-head { display: flex; gap: 12px; margin-bottom: 12px; align-items: flex-start; }
  .summary-icon { font-size: 32px; color: var(--success, #22c55e); }
  .summary-title { font-size: 16px; font-weight: 700; color: var(--text-1); }
  .summary-sub { font-size: 13px; color: var(--text-3); margin-top: 2px; }

  /* Per-item reasons for any skipped imports — rendered inline with
     the summary so the user can see exactly which items didn't land
     and why (most commonly "already in pantry"). Capped via overflow
     so a long bulk-import doesn't push the summary off-screen. */
  .skip-list {
    list-style: none;
    padding: 0;
    margin: 0 0 12px;
    max-height: 220px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .skip-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .skip-row:last-child { border-bottom: none; }
  .skip-name { color: var(--text-1); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .skip-reason { color: var(--text-3); font-size: 12px; flex-shrink: 0; }

  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    white-space: nowrap; padding: 9px 14px;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    font-size: 13px; cursor: pointer;
  }
  .btn-primary { background: var(--accent); color: var(--accent-text, #0A0B0F); border-color: var(--accent); }
  .btn-primary:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn-secondary { background: var(--surface-2); color: var(--text-1); }
  .btn-secondary:hover { border-color: var(--accent); }
</style>
