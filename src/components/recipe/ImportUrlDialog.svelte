<script>
  /**
   * ImportUrlDialog — unified URL import for one or many URLs.
   *
   * Paste one URL for a fast single import. Paste many URLs (one per
   * line, comma-separated, or whitespace-separated) and the dialog
   * switches to a picker grid after scraping so the user can review
   * before saving anything to their library.
   *
   * Routing:
   *   1 URL  → existing single-URL /scrape endpoint, saves directly,
   *            success toast + navigate to the new recipe.
   *   2+ URLs → /batch-scrape with concurrency 3, picker grid, then
   *            /bulk-commit on the selected rows.
   *
   * Both paths share the same options (Link to Pantry, Apply Tags,
   * Import Categories).
   */
  import { _ } from 'svelte-i18n';
  import { createEventDispatcher } from 'svelte';
  import { fade } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import { NtApi, mutatingAuthHeaders } from '../../lib/api.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { portal } from '../../lib/portal.js';

  export let open = false;
  const dispatch = createEventDispatcher();

  let phase = 'input';
  // States:
  //   input    textarea + options
  //   busy     single-URL fast scrape OR batch scan in flight
  //   scanned  batch picker grid visible
  //   saving   bulk-commit in flight
  //   done     summary card (batch path only; single-URL navigates away)
  //   error
  let urlText = '';
  let addToPantry = false;
  let applyTags = false;
  let importCategories = true;
  let scanResult = null;
  let selected = new Set();
  let progressLine = '';
  let errorMessage = '';
  let savedRecipes = [];
  let saveFailures = [];

  $: if (open) _reset();

  function _reset() {
    phase = 'input';
    urlText = '';
    scanResult = null;
    selected = new Set();
    progressLine = '';
    errorMessage = '';
    savedRecipes = [];
    saveFailures = [];
  }

  async function close() {
    if (scanResult?.cacheUuid && phase !== 'done') {
      try {
        await fetch('/api/recipes/bulk-cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...mutatingAuthHeaders() },
          body: JSON.stringify({ cacheUuid: scanResult.cacheUuid }),
          credentials: 'include',
        });
      } catch {}
    }
    open = false;
    dispatch('close');
  }

  // Parse the textarea into a clean URL list. Accepts one-per-line,
  // comma-separated, or whitespace-separated. De-duplicates while
  // preserving order.
  $: parsedUrls = (() => {
    const seen = new Set();
    return urlText
      .split(/[\s,]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .filter(u => (seen.has(u) ? false : (seen.add(u), true)));
  })();
  $: urlCount = parsedUrls.length;

  async function submit() {
    if (urlCount === 0) return;
    if (urlCount === 1) await _importSingle(parsedUrls[0]);
    else                 await _importBatch(parsedUrls);
  }

  // ── Single-URL path ──────────────────────────────────────────────────────

  async function _importSingle(url) {
    phase = 'busy';
    progressLine = 'Fetching recipe…';
    try {
      const created = await NtApi.scrapeRecipe(url, {
        addToPantry,
        applyTags,
        importCategories,
      });
      const stepCount = (created.steps || []).reduce((n, s) => n + (s?.text ? 1 : 0), 0);
      if (stepCount === 0) {
        showError("Imported, but the source page didn't include cooking steps. Open the recipe to add them manually.");
      } else {
        showSuccess($_('import_url_dialog.toast.recipe_imported'));
      }
      open = false;
      dispatch('close');
      push(`/recipes/${created.id}`);
    } catch (e) {
      phase = 'error';
      errorMessage = e.message || 'Could not import recipe';
    }
  }

  // ── Batch path ───────────────────────────────────────────────────────────

  async function _importBatch(urls) {
    if (urls.length > 100) {
      showError($_('import_url_dialog.toast.url_batch_limit'));
      return;
    }
    phase = 'busy';
    progressLine = `Scraping ${urls.length} URLs…`;
    try {
      const res = await fetch('/api/recipes/batch-scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...mutatingAuthHeaders() },
        body: JSON.stringify({ urls }),
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        phase = 'error';
        errorMessage = data?.error || `Scrape failed (HTTP ${res.status})`;
        return;
      }
      scanResult = data;
      // Default selection: every URL that returned a recipe.
      selected = new Set((data.items || []).filter(it => !it.error).map(it => it.id));
      phase = 'scanned';
    } catch (e) {
      phase = 'error';
      errorMessage = e.message || 'Scrape failed.';
    }
  }

  function _toggle(id) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    selected = next;
  }
  function _selectAll()  { selected = new Set((scanResult?.items || []).filter(i => !i.error).map(i => i.id)); }
  function _selectNone() { selected = new Set(); }

  async function commit() {
    if (!scanResult?.cacheUuid) return;
    if (selected.size === 0) { showError($_('import_url_dialog.toast.pick_one_url')); return; }
    phase = 'saving';
    progressLine = `Saving ${selected.size} recipes…`;
    try {
      const res = await fetch('/api/recipes/bulk-commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...mutatingAuthHeaders() },
        body: JSON.stringify({
          cacheUuid: scanResult.cacheUuid,
          selectedIds: Array.from(selected),
          addToPantry, applyTags, importCategories,
        }),
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        phase = 'error';
        errorMessage = data?.error || `Save failed (HTTP ${res.status})`;
        return;
      }
      savedRecipes = data.recipes || [];
      saveFailures = data.failed || [];
      phase = 'done';
      if (savedRecipes.length > 0) {
        showSuccess(`Imported ${savedRecipes.length} recipes`);
      }
    } catch (e) {
      phase = 'error';
      errorMessage = e.message || 'Save failed.';
    }
  }

  $: items = scanResult?.items || [];
  $: cleanCount = items.filter(i => !i.error).length;
  $: errorCount = items.filter(i =>  i.error).length;
</script>

{#if open}
  <div class="backdrop" use:portal on:click={close}
    in:fade={{ duration: 140 }} out:fade={{ duration: 100 }}>
    <div class="modal" on:click|stopPropagation>
      <header class="head">
        <h3>{$_('import_url_dialog.title')}</h3>
        <button class="btn-icon" on:click={close} aria-label="Close" title="Close">
          <span class="material-symbols-rounded">close</span>
        </button>
      </header>

      {#if phase === 'input'}
        <p class="hint">
          Paste one URL for a quick single import, or many URLs (one per line)
          to scrape them all and pick which to save. Up to 100 URLs per batch.
        </p>
        <textarea
          class="url-area"
          placeholder={"https://example.com/recipe-1\nhttps://example.com/recipe-2\n…"}
          bind:value={urlText}
          rows="6"></textarea>
        <p class="counter">{urlCount === 0 ? 'No URLs detected' : urlCount === 1 ? '1 URL detected (will save directly)' : `${urlCount} URLs detected (will show a picker)`}</p>
        <div class="opts">
          <label class="opt-row">
            <input type="checkbox" bind:checked={addToPantry} />
            <span>
              <span class="opt-label">{$_('import_url_dialog.link_to_pantry')}</span>
              <span class="opt-desc">Matches imported names to your existing Pantry items and creates new rows for any that don't exist. Off = ingredients save as plain text only.</span>
            </span>
          </label>
          <label class="opt-row">
            <input type="checkbox" bind:checked={applyTags} />
            <span>
              <span class="opt-label">{$_('import_url_dialog.apply_tags')}</span>
              <span class="opt-desc">Off by default. Tags from food blogs are usually noisy.</span>
            </span>
          </label>
          <label class="opt-row">
            <input type="checkbox" bind:checked={importCategories} />
            <span>
              <span class="opt-label">{$_('import_url_dialog.import_source_category')}</span>
              <span class="opt-desc">Carries the recipe's category from the source page; auto-creates one if it doesn't already exist in your catalog.</span>
            </span>
          </label>
        </div>
        <footer class="actions">
          <button class="btn btn-secondary" on:click={close}>{$_('import_url_dialog.cancel')}</button>
          <button class="btn btn-primary" on:click={submit} disabled={urlCount === 0}>
            <span class="material-symbols-rounded">{urlCount > 1 ? 'travel_explore' : 'download'}</span>
            {urlCount > 1 ? `Scrape ${urlCount} URLs` : 'Import'}
          </button>
        </footer>

      {:else if phase === 'busy' || phase === 'saving'}
        <div class="state busy">
          <span class="material-symbols-rounded spin">progress_activity</span>
          <p class="progress">{progressLine || 'Working…'}</p>
        </div>

      {:else if phase === 'scanned'}
        <div class="scan-summary">
          <div class="summary-row">
            <span class="summary-stat clean">{cleanCount} scraped</span>
            {#if errorCount}<span class="summary-stat error">{errorCount} failed</span>{/if}
            <span class="summary-meta">{selected.size} selected</span>
          </div>
          <div class="summary-actions">
            <button class="link-btn" on:click={_selectAll}>{$_('import_url_dialog.select_all')}</button>
            <button class="link-btn" on:click={_selectNone}>{$_('import_url_dialog.clear')}</button>
          </div>
        </div>
        <div class="rows">
          {#each items as item (item.id)}
            <div class="row {item.error ? 'row-disabled' : ''}">
              <input type="checkbox"
                disabled={!!item.error}
                checked={selected.has(item.id)}
                on:change={() => _toggle(item.id)} />
              <div class="row-main">
                <div class="row-name">{item.name || item.url}</div>
                <div class="row-meta">
                  {#if item.error}
                    <span class="confidence-pill low">{$_('import_url_dialog.failed')}</span>
                    <span class="row-msg">{item.error}</span>
                  {:else}
                    <span class="confidence-pill high">Scraped ({item.tier || 'standard'})</span>
                    <span class="row-msg">{item.ingredientCount}&nbsp;ing &middot; {item.stepCount}&nbsp;steps</span>
                  {/if}
                </div>
                <div class="row-url" title={item.url}>{item.url}</div>
              </div>
            </div>
          {/each}
        </div>
        <footer class="actions">
          <button class="btn btn-secondary" on:click={close}>{$_('import_url_dialog.cancel')}</button>
          <button class="btn btn-primary" on:click={commit} disabled={selected.size === 0}>
            <span class="material-symbols-rounded">save</span>
            Save {selected.size || ''} Recipes
          </button>
        </footer>

      {:else if phase === 'done'}
        <div class="state done">
          <span class="material-symbols-rounded done-icon">check_circle</span>
          <h4>Imported {savedRecipes.length} recipes</h4>
          {#if saveFailures.length}
            <p class="muted">{saveFailures.length} could not be saved.</p>
          {:else}
            <p>Saved to your library.</p>
          {/if}
        </div>
        <footer class="actions">
          <button class="btn btn-primary" on:click={() => { open = false; dispatch('close'); push('/recipes'); }}>
            <span class="material-symbols-rounded">open_in_new</span>
            Open Recipes
          </button>
        </footer>

      {:else if phase === 'error'}
        <div class="state error">
          <span class="material-symbols-rounded">error</span>
          <p>{errorMessage}</p>
        </div>
        <footer class="actions">
          <button class="btn btn-secondary" on:click={close}>{$_('import_url_dialog.cancel')}</button>
          <button class="btn btn-primary" on:click={() => { phase = 'input'; errorMessage = ''; }}>{$_('import_url_dialog.try_again')}</button>
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex; align-items: center; justify-content: center;
    z-index: 1200;
    padding: 16px;
  }
  .modal {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    width: 100%; max-width: 600px;
    max-height: 88vh;
    overflow: hidden;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
    display: flex; flex-direction: column;
  }
  .head {
    display: flex; align-items: center;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .head h3 { flex: 1; margin: 0; font-size: 17px; font-weight: 700; color: var(--text-1); }
  .btn-icon {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3); padding: 4px;
    border-radius: var(--radius-sm);
  }
  .btn-icon:hover { color: var(--text-1); background: var(--surface-2); }
  .btn-icon .material-symbols-rounded { font-size: 22px; }

  .hint, .counter {
    margin: 14px 16px 0;
    color: var(--text-3); font-size: 13px; line-height: 1.5;
    flex-shrink: 0;
  }
  .counter { margin-top: 6px; }

  .url-area {
    margin: 12px 16px 0;
    padding: 10px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-1);
    font-size: 13px;
    font-family: var(--font-mono, monospace);
    min-height: 110px; resize: vertical;
    outline: none;
  }
  .url-area:focus { border-color: var(--accent); }

  .opts {
    padding: 8px 16px;
    overflow-y: auto;
    flex: 1 1 auto;
  }
  .opt-row {
    display: flex; gap: 10px;
    padding: 8px 0;
    cursor: pointer;
  }
  .opt-row + .opt-row { border-top: 1px solid var(--border); }
  .opt-row input[type="checkbox"] { margin-top: 3px; }
  .opt-label { display: block; color: var(--text-1); font-size: 13px; font-weight: 600; }
  .opt-desc  { display: block; color: var(--text-3); font-size: 12px; line-height: 1.4; margin-top: 2px; }

  .scan-summary {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .summary-row {
    display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
    margin-bottom: 6px;
  }
  .summary-stat {
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 12px; font-weight: 600;
  }
  .summary-stat.clean { background: color-mix(in srgb, var(--success, #4ade80) 18%, transparent); color: var(--success, #4ade80); }
  .summary-stat.error { background: color-mix(in srgb, var(--error,   #f87171) 14%, transparent); color: var(--error,   #f87171); }
  .summary-meta { color: var(--text-3); font-size: 12px; margin-left: auto; }
  .summary-actions {
    display: flex; flex-wrap: wrap; gap: 12px;
    font-size: 12px;
  }
  .link-btn {
    background: transparent; border: none;
    color: var(--accent); font-size: 12px; font-weight: 600;
    cursor: pointer; padding: 0;
  }
  .link-btn:hover { text-decoration: underline; }

  .rows {
    overflow-y: auto;
    flex: 1 1 auto;
    padding: 4px 0;
  }
  .row {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
  }
  .row-disabled { opacity: 0.6; }
  .row input[type="checkbox"] { margin-top: 4px; }
  .row-main { flex: 1; min-width: 0; }
  .row-name {
    font-weight: 600; color: var(--text-1); font-size: 14px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .row-meta {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    margin: 4px 0 2px; font-size: 12px;
  }
  .row-msg { color: var(--text-3); }
  .row-url {
    color: var(--text-3); font-size: 11px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  .confidence-pill {
    display: inline-flex; align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px; font-weight: 600;
    white-space: nowrap;
  }
  .confidence-pill.high { background: color-mix(in srgb, var(--success, #4ade80) 18%, transparent); color: var(--success, #4ade80); }
  .confidence-pill.low  { background: color-mix(in srgb, var(--error,   #f87171) 14%, transparent); color: var(--error,   #f87171); }

  .state {
    margin: 24px 16px;
    text-align: center;
    color: var(--text-3);
    font-size: 14px;
    line-height: 1.5;
    display: flex; flex-direction: column; align-items: center; gap: 10px;
  }
  .state .material-symbols-rounded { font-size: 36px; color: var(--accent); }
  .state.busy .spin { font-size: 32px; animation: spin 1.2s linear infinite; }
  .state.error .material-symbols-rounded { color: var(--error, #f87171); }
  .state.error p { color: var(--error, #f87171); }
  .state.done h4 { margin: 4px 0 0; color: var(--text-1); font-size: 16px; }
  .state.done p  { margin: 0; }
  .state.done .done-icon { color: var(--success, #4ade80); }
  .muted { color: var(--text-3); }
  .progress { margin: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .actions {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .actions .btn { display: inline-flex; align-items: center; gap: 6px; }
  .actions .btn .material-symbols-rounded { font-size: 16px; }
</style>
