<script>
  /**
   * SettingsImport — bulk recipe import from another app's backup zip.
   *
   * Two-step flow: scan the zip server-side to get a manifest of every
   * recognisable recipe, render as a checklist, then commit the chosen
   * subset. Same file is re-uploaded on commit so the server doesn't
   * have to cache it between calls.
   *
   * Supports Mealie backups (data/recipes/<slug>/recipe.json + image),
   * Tandoor exports (per-recipe JSON), Paprika .paprikarecipes
   * archives, plain CookTrace JSON exports, and any zip containing
   * schema.org/Recipe JSON files.
   */
  import { _ } from 'svelte-i18n';
  import { slide } from 'svelte/transition';
  import { onMount } from 'svelte';
  import { NtApi } from '../../lib/api.js';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import { showSuccess, showError } from '../../stores/toast.js';

  // Clean up localStorage from the now-removed live Mealie API tool so
  // a stale token doesn't sit on the device. Safe no-op if absent.
  onMount(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem('ct:mealie:url');
    localStorage.removeItem('ct:mealie:token');
  });

  let fileInput;
  let pickedFile = null;        // raw File object — kept for the commit re-upload
  let manifest = null;          // { count, recipes: [...] } from /scan
  let scanning = false;
  let committing = false;
  let summary = null;           // { imported, failed: [{name, error}] }

  // Phase + progress for the XHR-driven upload. `phase`:
  //   'idle'      — nothing in flight
  //   'uploading' — bytes are leaving the device, percent is meaningful
  //   'scanning'  — upload finished, server is parsing the zip
  //   'importing' — upload finished, server is writing recipes to DB
  let phase = 'idle';
  let uploadPercent = 0;
  let uploadLoaded = 0;
  let uploadTotal = 0;
  function _fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // Picker controls
  let selected = new Set();     // indices the user wants
  let importImages = true;
  let addToPantry  = false;
  let applyTags    = true;
  let importCategories = true;
  // Dedup behavior — 'skip' (default) leaves an existing recipe in
  // place and just lands new content (e.g. cook history events) on
  // it; 'replace' overwrites; 'force' allows duplicates. Server +
  // local NtApi both honour this option.
  let dedup = 'skip';
  // Whether to bring Mealie timeline events along as Diary entries.
  // Only meaningful for Mealie backups — the option is hidden when
  // the scan didn't find any events.
  let importTimeline = true;
  $: hasTimelineInZip = !!(manifest?.recipes || []).some(r => (r.timelineEventCount || 0) > 0);
  $: totalTimelineEvents = (manifest?.recipes || []).reduce((sum, r) => sum + (r.timelineEventCount || 0), 0);

  function reset() {
    pickedFile = null;
    manifest = null;
    summary = null;
    selected = new Set();
    if (fileInput) fileInput.value = '';
  }

  // Hold a screen wake-lock during long uploads so phones don't kill
  // the in-flight fetch when the user puts the device down or the
  // screen auto-locks. WakeLock API is best-effort: not all browsers
  // / not all platforms support it; failure is silent because the
  // upload itself still works as long as the user keeps the screen on.
  let _wakeLock = null;
  async function _acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        _wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch { /* ignore */ }
  }
  function _releaseWakeLock() {
    try { _wakeLock?.release?.(); } catch {}
    _wakeLock = null;
  }
  // Re-acquire on visibility return so a brief screen-off doesn't end
  // the lock for the rest of the upload.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', async () => {
      if ((scanning || committing) && document.visibilityState === 'visible' && !_wakeLock) {
        await _acquireWakeLock();
      }
    });
  }

  async function onFile(e) {
    const file = e.target?.files?.[0];
    if (!file) return;
    pickedFile = file;
    manifest = null;
    summary = null;
    selected = new Set();
    scanning = true;
    phase = 'uploading';
    uploadPercent = 0;
    uploadLoaded = 0;
    uploadTotal = file.size || 0;
    await _acquireWakeLock();
    try {
      const res = await NtApi.scanRecipeZip(file, {
        onProgress: (p) => {
          uploadLoaded = p.loaded || 0;
          uploadTotal  = p.total  || file.size || 0;
          uploadPercent = p.percent ?? 0;
          if (p.uploaded) phase = 'scanning';
        },
      });
      manifest = res;
      // Default: every recipe ticked.
      selected = new Set((res.recipes || []).map(r => r.idx));
    } catch (err) {
      showError(err.message || 'Could not read this zip');
      pickedFile = null;
    } finally {
      scanning = false;
      phase = 'idle';
      _releaseWakeLock();
    }
  }

  function toggle(idx) {
    if (selected.has(idx)) selected.delete(idx);
    else selected.add(idx);
    selected = new Set(selected); // trigger reactivity
  }
  function selectAll() { selected = new Set(manifest.recipes.map(r => r.idx)); }
  function selectNone() { selected = new Set(); }

  async function commit() {
    if (!pickedFile || selected.size === 0) return;
    committing = true;
    // If scan stashed an uploadId server-side, commit becomes a tiny
    // JSON request — skip the misleading "uploading" phase entirely
    // and go straight to importing. Falls back to re-upload only if
    // the cache expired, which the api.js layer handles transparently.
    const cachedId = manifest?.uploadId || null;
    phase = cachedId ? 'importing' : 'uploading';
    uploadPercent = 0;
    uploadLoaded = 0;
    uploadTotal = pickedFile.size || 0;
    await _acquireWakeLock();
    try {
      const res = await NtApi.commitRecipeZip(pickedFile, {
        selected: [...selected],
        importImages,
        addToPantry,
        applyTags,
        importCategories,
        importTimeline,
        dedup,
        uploadId: cachedId,
        onProgress: (p) => {
          uploadLoaded = p.loaded || 0;
          uploadTotal  = p.total  || pickedFile.size || 0;
          uploadPercent = p.percent ?? 0;
          if (p.uploaded) phase = 'importing';
        },
      });
      summary = {
        imported: res.count || 0,
        failed: Array.isArray(res.failed) ? res.failed : [],
      };
      if (summary.imported > 0) {
        showSuccess(`Imported ${summary.imported} ${summary.imported === 1 ? 'recipe' : 'recipes'}`);
      }
      if (summary.failed.length > 0) {
        showError(`${summary.failed.length} ${summary.failed.length === 1 ? 'recipe' : 'recipes'} could not be imported`);
      }
    } catch (err) {
      showError(err.message || 'Import failed');
    } finally {
      committing = false;
      phase = 'idle';
      _releaseWakeLock();
    }
  }

  // Pretty source label for the row.
  function sourceLabel(s) {
    return ({
      mealie: 'Mealie',
      tandoor: 'Tandoor',
      paprika: 'Paprika',
      cooktrace: 'CookTrace',
      'schema.org': 'schema.org',
    })[s] || 'Recipe';
  }
</script>

<div class="card settings-card">
  {#if !manifest && !summary}
    <!-- Initial: explainer + upload trigger -->
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_import_ct.import_section')}</span>
        <span class="setting-desc">
          {@html $_('settings_import_ct.import_desc_html')}
        </span>
      </div>
      <button class="btn btn-primary" disabled={scanning} on:click={() => fileInput?.click()}>
        {#if scanning}
          <span class="material-symbols-rounded spin">progress_activity</span>
          {phase === 'uploading' ? `Uploading ${uploadPercent}%` : 'Scanning…'}
        {:else}
          <span class="material-symbols-rounded">upload_file</span>
          Choose File
        {/if}
      </button>
    </div>

    <!-- Live progress strip while a scan is in flight. Sits below the
         button row so the explainer text doesn't get pushed around. -->
    {#if scanning}
      <div class="progress-row">
        <div class="progress-label">
          {#if phase === 'uploading'}
            Uploading <strong>{uploadPercent}%</strong>
            <span class="muted">· {_fmtBytes(uploadLoaded)} / {_fmtBytes(uploadTotal)}</span>
          {:else}
            <span class="material-symbols-rounded spin">progress_activity</span>
            Scanning archive on the server
            <span class="muted">· this can take a moment for big backups</span>
          {/if}
        </div>
        <div class="progress-track">
          <div class="progress-fill"
            class:indeterminate={phase !== 'uploading'}
            style={phase === 'uploading' ? `width:${uploadPercent}%` : ''}>
          </div>
        </div>
      </div>
    {/if}
    <input
      bind:this={fileInput}
      type="file"
      accept=".zip,.paprikarecipes"
      style="display:none"
      on:change={onFile}
    />
  {/if}

  {#if manifest && !summary}
    <!-- Picker -->
    <div class="picker" transition:slide={{ duration: 180 }}>
      <div class="picker-head">
        <div>
          <div class="picker-title">
            Found {manifest.count} {manifest.count === 1 ? 'recipe' : 'recipes'}
          </div>
          <div class="picker-sub">
            <strong>{selected.size}</strong> selected · {pickedFile?.name}
          </div>
        </div>
        <div class="picker-bulk">
          <button class="btn-link" on:click={selectAll}>{$_('settings_import_ct.select_all')}</button>
          <span class="dot">·</span>
          <button class="btn-link" on:click={selectNone}>{$_('settings_import_ct.select_none')}</button>
        </div>
      </div>

      <ul class="manifest">
        {#each manifest.recipes as r (r.idx)}
          <li class="row" class:checked={selected.has(r.idx)}>
            <label class="row-label">
              <input
                type="checkbox"
                checked={selected.has(r.idx)}
                on:change={() => toggle(r.idx)}
              />
              {#if r.thumb_data_url}
                <img src={r.thumb_data_url} alt="" class="thumb" />
              {:else if r.img_url}
                <img src={resolveAssetUrl(r.img_url)} alt="" class="thumb" />
              {:else if r.has_image_asset}
                <span class="thumb thumb-stub" title="Image included in archive">
                  <span class="material-symbols-rounded">image</span>
                </span>
              {:else}
                <span class="thumb thumb-stub">
                  <span class="material-symbols-rounded">restaurant</span>
                </span>
              {/if}
              <span class="row-text">
                <span class="row-name">{r.name}</span>
                <span class="row-meta">
                  <span class="badge">{sourceLabel(r.source)}</span>
                  {#if r.ingredient_count > 0}
                    <span class="muted">{r.ingredient_count} ing</span>
                  {/if}
                  {#if r.step_count > 0}
                    <span class="muted">· {r.step_count} steps</span>
                  {/if}
                  {#if r.has_image_asset}
                    <span class="muted">· img</span>
                  {/if}
                </span>
              </span>
            </label>
          </li>
        {/each}
      </ul>

      <div class="opts">
        <label class="opt">
          <input type="checkbox" bind:checked={importImages} />
          <span>{$_('settings_import_ct.transfer_images')}</span>
        </label>
        <label class="opt">
          <input type="checkbox" bind:checked={addToPantry} />
          <span>Link ingredients to your Pantry (matches existing, creates new)</span>
        </label>
        <label class="opt">
          <input type="checkbox" bind:checked={applyTags} />
          <span>{$_('settings_import_ct.keep_tags')}</span>
        </label>
        <label class="opt">
          <input type="checkbox" bind:checked={importCategories} />
          <span>Import the source's categories (auto-creates new ones in your catalog)</span>
        </label>
        {#if hasTimelineInZip}
          <label class="opt">
            <input type="checkbox" bind:checked={importTimeline} />
            <span>Bring Mealie cook history into the Diary ({totalTimelineEvents} event{totalTimelineEvents === 1 ? '' : 's'} found)</span>
          </label>
        {/if}
        <div class="opt opt-row">
          <span class="opt-label">If a recipe already exists:</span>
          <select class="select sel-sm" bind:value={dedup}>
            <option value="skip">Skip it (default)</option>
            <option value="replace">{$_('settings_import_ct.opt_replace')}</option>
            <option value="force">{$_('settings_import_ct.opt_force')}</option>
          </select>
        </div>
        {#if dedup === 'skip' && hasTimelineInZip}
          <p class="opt-hint">
            Cook history still lands on existing recipes when they're skipped — only the recipe row itself is left alone.
          </p>
        {/if}
      </div>

      {#if committing}
        <div class="progress-row">
          <div class="progress-label">
            {#if phase === 'uploading'}
              Uploading <strong>{uploadPercent}%</strong>
              <span class="muted">· {_fmtBytes(uploadLoaded)} / {_fmtBytes(uploadTotal)}</span>
            {:else}
              <span class="material-symbols-rounded spin">progress_activity</span>
              Writing recipes
              <span class="muted">· this is the slow part for image-heavy archives</span>
            {/if}
          </div>
          <div class="progress-track">
            <div class="progress-fill"
              class:indeterminate={phase !== 'uploading'}
              style={phase === 'uploading' ? `width:${uploadPercent}%` : ''}>
            </div>
          </div>
        </div>
      {/if}

      <div class="actions">
        <button class="btn btn-secondary" on:click={reset} disabled={committing}>{$_('settings_import_ct.cancel')}</button>
        <button
          class="btn btn-primary"
          on:click={commit}
          disabled={committing || selected.size === 0}
        >
          {#if committing}
            <span class="material-symbols-rounded spin">progress_activity</span>
            {phase === 'uploading' ? `Uploading ${uploadPercent}%` : 'Importing…'}
          {:else}
            Import {selected.size} {selected.size === 1 ? 'Recipe' : 'Recipes'}
          {/if}
        </button>
      </div>
    </div>
  {/if}

  {#if summary}
    <!-- Post-import summary -->
    <div class="summary" transition:slide={{ duration: 180 }}>
      <div class="summary-head">
        <span class="material-symbols-rounded summary-icon">check_circle</span>
        <div>
          <div class="summary-title">
            Imported {summary.imported} {summary.imported === 1 ? 'recipe' : 'recipes'}
          </div>
          {#if summary.failed.length > 0}
            <div class="summary-sub error">
              {summary.failed.length} skipped because of errors
            </div>
          {:else}
            <div class="summary-sub">All set. Find them on the Recipes tab.</div>
          {/if}
        </div>
      </div>

      {#if summary.failed.length > 0}
        <ul class="failed">
          {#each summary.failed as f}
            <li><strong>{f.name}</strong> — <span class="muted">{f.error}</span></li>
          {/each}
        </ul>
      {/if}

      <div class="actions">
        <button class="btn btn-primary" on:click={reset}>{$_('settings_import_ct.import_another')}</button>
      </div>
    </div>
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
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
  }
  .setting-row > div:first-child { flex: 1; min-width: 0; }
  .setting-label {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-1);
    display: block;
  }
  .setting-desc {
    font-size: 12px;
    color: var(--text-3);
    margin-top: 4px;
    line-height: 1.4;
    display: block;
  }
  .setting-desc code {
    background: var(--surface-2);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 11px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .btn .material-symbols-rounded { font-size: 18px; }
  .spin { animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Picker ──────────────────────────────────────────────────────── */
  .picker { padding: 14px 16px 16px; }
  .picker-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 12px;
    margin-bottom: 12px;
  }
  .picker-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-1);
  }
  .picker-sub {
    font-size: 12px;
    color: var(--text-3);
    margin-top: 2px;
  }
  .picker-bulk { font-size: 12px; }
  .picker-bulk .dot { color: var(--text-3); margin: 0 4px; }
  .btn-link {
    background: none;
    border: none;
    color: var(--accent);
    font-weight: 600;
    font-size: 12px;
    cursor: pointer;
    padding: 0;
  }
  .btn-link:hover { text-decoration: underline; }

  .manifest {
    list-style: none;
    margin: 0 0 16px;
    padding: 0;
    max-height: 420px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .row { border-bottom: 1px solid var(--border); }
  .row:last-child { border-bottom: none; }
  .row.checked { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .row-label {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    cursor: pointer;
  }
  .row-label input[type="checkbox"] { flex-shrink: 0; cursor: pointer; }

  .thumb {
    width: 44px;
    height: 44px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    object-fit: cover;
    flex-shrink: 0;
  }
  .thumb-stub {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-3);
  }
  .thumb-stub .material-symbols-rounded { font-size: 22px; }

  .row-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1;
  }
  .row-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-3);
    flex-wrap: wrap;
  }
  .badge {
    background: var(--accent-dim);
    color: var(--accent);
    padding: 1px 8px;
    border-radius: 99px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .muted { color: var(--text-3); }

  .opts {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 13px;
    color: var(--text-2);
  }
  .opt input { cursor: pointer; }
  .opt-row { justify-content: space-between; padding-top: 4px; }
  .opt-label { font-weight: 600; color: var(--text-1); }
  .opt-row .select { max-width: 240px; }
  .opt-hint {
    margin: 0 0 0 24px;
    font-size: 12px;
    color: var(--text-3);
    font-style: italic;
  }

  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  /* ── Post-commit summary ────────────────────────────────────────── */
  .summary { padding: 14px 16px 16px; }
  .summary-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 12px;
  }
  .summary-icon {
    font-size: 32px;
    color: var(--success, #22c55e);
    flex-shrink: 0;
  }
  .summary-title {
    font-size: 16px;
    font-weight: 700;
    color: var(--text-1);
  }
  .summary-sub {
    font-size: 13px;
    color: var(--text-3);
    margin-top: 2px;
  }
  .summary-sub.error { color: var(--error, #f87171); }

  .failed {
    list-style: none;
    margin: 0 0 16px;
    padding: 8px 12px;
    border: 1px solid var(--error, #f87171);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--error, #f87171) 6%, transparent);
    font-size: 12px;
    max-height: 180px;
    overflow-y: auto;
  }
  .failed li { padding: 3px 0; line-height: 1.4; }

  /* Upload + scan progress strip. The track is a thin pill; the fill
     animates width during upload, runs an indeterminate sweep when
     waiting on the server. */
  .progress-row {
    padding: 0 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .progress-label {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-2);
  }
  .progress-label strong { color: var(--text-1); font-weight: 700; }
  .progress-label .muted { color: var(--text-3); font-weight: 500; }
  .progress-label .material-symbols-rounded { font-size: 14px; }
  .progress-track {
    height: 6px;
    border-radius: 99px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 99px;
    transition: width var(--dur-fast, 120ms) ease-out;
  }
  .progress-fill.indeterminate {
    width: 35%;
    animation: indetSlide 1.4s ease-in-out infinite;
  }
  @keyframes indetSlide {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(300%); }
  }

</style>
