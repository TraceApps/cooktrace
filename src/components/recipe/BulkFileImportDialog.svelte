<script>
  /**
   * BulkFileImportDialog — Issue #2 Phase 2.
   *
   * Drop zone + per-file picker for importing many recipes in one go.
   * Accepts multi-file drop / select, folder picker (webkitdirectory),
   * and a single ZIP that gets expanded server-side. Each PDF / RTF /
   * TXT / MD entry runs through the Phase 1 extract + heuristic pipeline;
   * results land in the picker grid with a confidence pill so the user
   * can pick which N of M to actually save.
   *
   * Per-row "Try with AI" available for low-confidence rows when an AI
   * provider is configured.
   *
   * Original file bytes never touch disk on the server. Only the parsed
   * JSON preview lives in .import-cache/bulk-<uuid>/ between scan and
   * commit, and that directory is deleted on commit, on explicit cancel,
   * and on the TTL sweep if abandoned.
   */
  import { createEventDispatcher } from 'svelte';
  import { fade } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import {
    aiEnabled, aiProvider, aiApiKey, aiModel, aiBaseUrl,
  } from '../../stores/settings.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { portal } from '../../lib/portal.js';
  import { callAI, TOOLS, AI_DEFAULT_MODELS } from '../../lib/aiChat.js';

  export let open = false;
  export let envLocked = false;
  // When opened by the unified ImportFromFileDialog router with files
  // already picked, the dialog skips its pick phase and uploads them
  // straight away.
  export let initialFiles = null;
  const dispatch = createEventDispatcher();

  let phase = 'pick';
  // States:
  //   pick     drop zone visible
  //   uploading network upload + server scan
  //   scanned  picker grid visible
  //   saving   bulk-commit in flight
  //   ai-busy  AI fallback running for one row
  //   done     summary card
  //   error    something failed
  let dragOver = false;
  let scanResult = null;
  let confidenceThreshold = 0.7;
  let selected = new Set();
  let aiBusyId = null;
  let progressLabel = '';
  let errorMessage = '';
  let savedRecipes = [];
  let saveFailures = [];
  let _fileInput;
  let _folderInput;

  $: if (open) _onOpen();

  function _onOpen() {
    _reset();
    if (initialFiles && initialFiles.length > 0) {
      Promise.resolve().then(() => _upload(initialFiles));
    }
  }

  function _reset() {
    phase = 'pick';
    dragOver = false;
    scanResult = null;
    selected = new Set();
    aiBusyId = null;
    progressLabel = '';
    errorMessage = '';
    savedRecipes = [];
    saveFailures = [];
  }

  async function close() {
    // Best-effort cleanup if the user closes mid-flow.
    if (scanResult?.cacheUuid && phase !== 'done') {
      try {
        await fetch('/api/recipes/bulk-cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cacheUuid: scanResult.cacheUuid }),
          credentials: 'include',
        });
      } catch {}
    }
    open = false;
    dispatch('close');
  }

  function _pickFiles()  { _fileInput?.click(); }
  function _pickFolder() { _folderInput?.click(); }

  function _onDragOver(e) {
    e.preventDefault();
    dragOver = true;
  }
  function _onDragLeave() { dragOver = false; }
  function _onDrop(e) {
    e.preventDefault();
    dragOver = false;
    const list = Array.from(e.dataTransfer?.files || []);
    if (list.length) _upload(list);
  }
  function _onFiles(e) {
    const list = Array.from(e.target?.files || []);
    if (list.length) _upload(list);
    if (e.target) e.target.value = '';
  }

  async function _upload(fileList) {
    if (!fileList || !fileList.length) return;
    phase = 'uploading';
    progressLabel = `Uploading ${fileList.length} file${fileList.length === 1 ? '' : 's'}…`;
    errorMessage = '';

    const form = new FormData();
    for (const f of fileList) {
      form.append('files', f, f.webkitRelativePath || f.name);
    }
    try {
      const res = await fetch('/api/recipes/bulk-scan', {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        phase = 'error';
        errorMessage = data?.error || `Scan failed (HTTP ${res.status})`;
        return;
      }
      scanResult = data;
      confidenceThreshold = data.highConfidenceThreshold || 0.7;
      // Default selection: everything that parsed cleanly. Errors + empty
      // rows start deselected so the user has to opt them in.
      selected = new Set(
        (data.items || [])
          .filter(it => !it.error && !it.empty && it.confidence >= confidenceThreshold)
          .map(it => it.id),
      );
      phase = 'scanned';
    } catch (e) {
      phase = 'error';
      errorMessage = e.message || 'Upload failed.';
    }
  }

  function _toggle(id) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }
  function _selectAll() {
    selected = new Set(
      (scanResult?.items || [])
        .filter(it => !it.error && !it.empty)
        .map(it => it.id),
    );
  }
  function _selectClean() {
    selected = new Set(
      (scanResult?.items || [])
        .filter(it => !it.error && !it.empty && it.confidence >= confidenceThreshold)
        .map(it => it.id),
    );
  }
  function _selectNone() { selected = new Set(); }

  async function _tryWithAi(item) {
    if (!scanResult?.cacheUuid) return;
    aiBusyId = item.id;
    progressLabel = `Trace is re-reading "${_displayName(item)}"…`;

    let textPayload;
    try {
      const res = await fetch(`/api/recipes/bulk-text/${scanResult.cacheUuid}/${item.id}`, {
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      textPayload = data;
    } catch (e) {
      aiBusyId = null;
      showError(e.message || 'Could not load text for AI fallback.');
      return;
    }

    const provider = $aiProvider;
    const apiKey   = $aiApiKey;
    const model    = $aiModel || AI_DEFAULT_MODELS[provider] || '';
    const baseUrl  = $aiBaseUrl;
    const photoTools = TOOLS.filter(t => t.name === 'create_recipe');

    const sys = `You are CookTrace's recipe-import assistant. The user has attached a recipe extracted from a file. Extract the recipe and call the create_recipe tool with the result.

Rules:
- ALWAYS call create_recipe. Don't summarize or describe in plain text.
- Pull a clean recipe name.
- Ingredients: split into qty / unit / name / note. Qty stays as a string ("1", "1/2", "1 1/2").
- Steps: numbered. Use a short title only when the source has one.
- Don't fabricate. If a field isn't visible, omit it.`;
    const userMsg = {
      role: 'user',
      content: `Please import the recipe below.

----- BEGIN RECIPE TEXT -----
${textPayload.text}
----- END RECIPE TEXT -----`,
    };

    let aiSaved = null;
    try {
      await callAI({
        provider, apiKey, model, baseUrl,
        messages: [userMsg],
        systemPrompt: sys,
        tools: photoTools,
        onToolResult: (name, result) => {
          if (name === 'create_recipe' && result && result.ok && result.recipe) {
            aiSaved = result.recipe;
          }
        },
      });
    } catch (e) {
      aiBusyId = null;
      showError(e.message || 'AI re-parse failed.');
      return;
    }

    aiBusyId = null;
    if (aiSaved) {
      // Mark this item as already-saved-via-AI so the bulk-commit step
      // skips it. Remove it from selection too.
      const idx = scanResult.items.findIndex(i => i.id === item.id);
      if (idx >= 0) {
        scanResult.items[idx] = {
          ...scanResult.items[idx],
          aiSavedId: aiSaved.id,
          aiSavedName: aiSaved.name,
        };
        scanResult = { ...scanResult };
      }
      const next = new Set(selected);
      next.delete(item.id);
      selected = next;
      showSuccess(`Saved "${aiSaved.name}" via Trace AI`);
    } else {
      showError('AI did not save a recipe for this row.');
    }
  }

  async function commit() {
    if (!scanResult?.cacheUuid) return;
    if (selected.size === 0) {
      showError('Pick at least one recipe to save.');
      return;
    }
    phase = 'saving';
    progressLabel = `Saving ${selected.size} recipe${selected.size === 1 ? '' : 's'}…`;
    try {
      const res = await fetch('/api/recipes/bulk-commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cacheUuid: scanResult.cacheUuid,
          selectedIds: Array.from(selected),
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
    } catch (e) {
      phase = 'error';
      errorMessage = e.message || 'Save failed.';
    }
  }

  function _displayName(item) {
    return item.name || item.filename || 'Untitled';
  }
  function _confidenceLabel(c) {
    if (c >= confidenceThreshold) return 'Clean';
    if (c >= 0.4) return 'Partial';
    return 'Best effort';
  }
  function _confidenceClass(c) {
    if (c >= confidenceThreshold) return 'high';
    if (c >= 0.4) return 'mid';
    return 'low';
  }

  $: items = scanResult?.items || [];
  $: cleanCount  = items.filter(i => !i.error && !i.empty && i.confidence >= confidenceThreshold).length;
  $: errorCount  = items.filter(i =>  i.error || i.empty).length;
</script>

{#if open}
  <div class="backdrop" use:portal on:click={close}
    in:fade={{ duration: 140 }} out:fade={{ duration: 100 }}>
    <div class="modal" on:click|stopPropagation>
      <header class="head">
        <h3>Bulk Import</h3>
        <button class="btn-icon" on:click={close} aria-label="Close" title="Close">
          <span class="material-symbols-rounded">close</span>
        </button>
      </header>

      {#if phase === 'pick'}
        <p class="hint">
          Drop a folder, a stack of recipe files (PDF / RTF / TXT / MD),
          or a ZIP of them. Each entry runs through the built-in parser;
          weak parses get a "Try with AI" button if Trace is enabled.
          Original files are not retained: only the parsed previews live
          in a temporary cache that's cleared on commit or cancel.
        </p>
        <div class="dropzone {dragOver ? 'over' : ''}"
          on:dragover={_onDragOver}
          on:dragleave={_onDragLeave}
          on:drop={_onDrop}
          on:click={_pickFiles}>
          <span class="material-symbols-rounded">cloud_upload</span>
          <p class="dz-title">Drop files here or click to pick</p>
          <p class="dz-sub">PDF, RTF, TXT, MD, or a ZIP of any of these</p>
        </div>
        <div class="picker-aux">
          <button class="btn btn-secondary" on:click={_pickFolder}>
            <span class="material-symbols-rounded">folder_open</span>
            Pick a Folder
          </button>
        </div>
        <input type="file" multiple
          accept=".pdf,.rtf,.txt,.md,.markdown,.zip,application/pdf,application/rtf,text/rtf,text/plain,text/markdown,application/zip,application/x-zip-compressed"
          bind:this={_fileInput} on:change={_onFiles} hidden />
        <input type="file" webkitdirectory directory
          bind:this={_folderInput} on:change={_onFiles} hidden />
        <footer class="actions">
          <button class="btn btn-secondary" on:click={close}>Cancel</button>
        </footer>

      {:else if phase === 'uploading' || phase === 'saving'}
        <div class="state busy">
          <span class="material-symbols-rounded spin">progress_activity</span>
          <p class="progress">{progressLabel || 'Working…'}</p>
        </div>

      {:else if phase === 'scanned'}
        <div class="scan-summary">
          <div class="summary-row">
            <span class="summary-stat clean">{cleanCount} clean</span>
            <span class="summary-stat partial">{items.length - cleanCount - errorCount} partial</span>
            {#if errorCount}<span class="summary-stat error">{errorCount} skipped</span>{/if}
            <span class="summary-meta">{selected.size} selected</span>
          </div>
          <div class="summary-actions">
            <button class="link-btn" on:click={_selectAll}>Select all</button>
            <button class="link-btn" on:click={_selectClean}>Select clean only</button>
            <button class="link-btn" on:click={_selectNone}>Clear</button>
          </div>
        </div>
        <div class="rows">
          {#each items as item (item.id)}
            <div class="row {item.error || item.empty ? 'row-disabled' : ''}">
              <input type="checkbox"
                disabled={!!(item.error || item.empty || item.aiSavedId)}
                checked={selected.has(item.id)}
                on:change={() => _toggle(item.id)} />
              <div class="row-main">
                <div class="row-name">{_displayName(item)}</div>
                <div class="row-meta">
                  {#if item.aiSavedId}
                    <span class="confidence-pill high">Saved via AI</span>
                  {:else if item.error}
                    <span class="confidence-pill low">Skipped</span>
                    <span class="row-msg">{item.error}</span>
                  {:else if item.empty}
                    <span class="confidence-pill low">No text</span>
                    <span class="row-msg">{item.hint}</span>
                  {:else}
                    <span class="confidence-pill {_confidenceClass(item.confidence)}">{_confidenceLabel(item.confidence)} ({Math.round(item.confidence * 100)}%)</span>
                    <span class="row-msg">
                      {item.ingredientCount}&nbsp;ing &middot; {item.stepCount}&nbsp;steps
                    </span>
                  {/if}
                </div>
                {#if item.filename && item.filename !== _displayName(item)}
                  <div class="row-filename" title={item.filename}>{item.source ? `${item.source} → ` : ''}{item.filename}</div>
                {/if}
              </div>
              {#if !item.error && !item.empty && !item.aiSavedId && $aiEnabled && !envLocked && item.confidence < confidenceThreshold}
                <button class="row-ai" on:click={() => _tryWithAi(item)} disabled={aiBusyId !== null}>
                  {#if aiBusyId === item.id}
                    <span class="material-symbols-rounded spin">progress_activity</span>
                  {:else}
                    <span class="material-symbols-rounded">smart_toy</span>
                    Try AI
                  {/if}
                </button>
              {/if}
            </div>
          {/each}
        </div>
        <footer class="actions">
          <button class="btn btn-secondary" on:click={close}>Cancel</button>
          <button class="btn btn-primary" on:click={commit} disabled={selected.size === 0}>
            <span class="material-symbols-rounded">save</span>
            Save {selected.size || ''} Recipe{selected.size === 1 ? '' : 's'}
          </button>
        </footer>

      {:else if phase === 'done'}
        <div class="state done">
          <span class="material-symbols-rounded done-icon">check_circle</span>
          <h4>Imported {savedRecipes.length} recipe{savedRecipes.length === 1 ? '' : 's'}</h4>
          {#if saveFailures.length}
            <p class="muted">{saveFailures.length} entr{saveFailures.length === 1 ? 'y' : 'ies'} could not be saved. Re-upload the affected files if you need them.</p>
          {:else}
            <p>Saved to your library. Cache cleared.</p>
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
          <button class="btn btn-secondary" on:click={close}>Cancel</button>
          <button class="btn btn-primary" on:click={() => { phase = 'pick'; errorMessage = ''; }}>Try Again</button>
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
    width: 100%; max-width: 640px;
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

  .hint {
    margin: 14px 16px 0;
    color: var(--text-3); font-size: 13px; line-height: 1.5;
    flex-shrink: 0;
  }

  .dropzone {
    margin: 16px;
    padding: 36px 20px;
    border: 2px dashed var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
    color: var(--text-1);
    text-align: center;
    cursor: pointer;
    transition: border-color var(--dur-fast), background var(--dur-fast);
    flex-shrink: 0;
  }
  .dropzone:hover, .dropzone.over {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
  }
  .dropzone .material-symbols-rounded { font-size: 38px; color: var(--accent); }
  .dz-title { margin: 8px 0 4px; font-size: 15px; font-weight: 600; }
  .dz-sub   { margin: 0; color: var(--text-3); font-size: 12px; }

  .picker-aux {
    display: flex; justify-content: center; gap: 8px;
    padding: 0 16px 12px;
    flex-shrink: 0;
  }
  .picker-aux .btn { display: inline-flex; align-items: center; gap: 6px; }
  .picker-aux .btn .material-symbols-rounded { font-size: 16px; }

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
  .summary-stat.clean   { background: color-mix(in srgb, var(--success, #4ade80) 18%, transparent); color: var(--success, #4ade80); }
  .summary-stat.partial { background: color-mix(in srgb, var(--warning, #f59e0b) 18%, transparent); color: var(--warning, #f59e0b); }
  .summary-stat.error   { background: color-mix(in srgb, var(--error,   #f87171) 14%, transparent); color: var(--error,   #f87171); }
  .summary-meta { color: var(--text-3); font-size: 12px; margin-left: auto; }
  .summary-actions {
    display: flex; flex-wrap: wrap; gap: 12px;
    font-size: 12px;
  }
  .link-btn {
    background: transparent; border: none;
    color: var(--accent);
    font-size: 12px; font-weight: 600;
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
    display: flex; flex-wrap: wrap; gap: 8px;
    align-items: center;
    margin: 4px 0 2px;
    font-size: 12px;
  }
  .row-msg { color: var(--text-3); }
  .row-filename {
    color: var(--text-3); font-size: 11px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .row-ai {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-1);
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    font-size: 12px; font-weight: 600;
    cursor: pointer;
    transition: border-color var(--dur-fast), background var(--dur-fast);
  }
  .row-ai:hover { border-color: var(--accent); }
  .row-ai:disabled { opacity: 0.5; cursor: not-allowed; }
  .row-ai .material-symbols-rounded { font-size: 14px; }
  .row-ai .spin { animation: spin 1.2s linear infinite; }

  .confidence-pill {
    display: inline-flex; align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px; font-weight: 600;
    white-space: nowrap;
  }
  .confidence-pill.high { background: color-mix(in srgb, var(--success, #4ade80) 18%, transparent); color: var(--success, #4ade80); }
  .confidence-pill.mid  { background: color-mix(in srgb, var(--warning, #f59e0b) 18%, transparent); color: var(--warning, #f59e0b); }
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
