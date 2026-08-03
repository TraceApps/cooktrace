<script>
  /**
   * CookbookImportDialog — Issue #2 Phase 3.
   *
   * Single PDF containing many recipes. Server extracts the text; client
   * sends it to Trace AI with a multi-recipe extraction prompt. The AI
   * calls create_recipe once per recipe it identifies in the document;
   * each call goes through the existing tool handler registered in
   * Trace.svelte, which saves the recipe straight to the user's library
   * via NtApi.createRecipe.
   *
   * AI-only by design. Heuristic boundary detection on cookbook layouts
   * is too brittle to ship as a primary path. Requires a configured AI
   * provider; env-locked installs are unsupported because the server
   * proxy doesn't relay tool calls.
   *
   * Image-only PDFs (scanned cookbooks) return empty text from the
   * extractor; the dialog surfaces a clear hint pointing the user at
   * single-page Photo Import for now. Native AI-vision PDF support is
   * a follow-up.
   */
  import { _ } from 'svelte-i18n';
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
  const dispatch = createEventDispatcher();

  let phase = 'pick';
  // States:
  //   pick      file picker visible
  //   preparing server extracting text
  //   ready     extracted, awaiting user confirm
  //   extracting AI is identifying recipes
  //   done      summary list
  //   error     something failed
  let pdfFile = null;
  let preview = null;       // { text, pages }
  let createdRecipes = [];
  let progressLine = '';
  let errorMessage = '';
  let _fileInput;

  $: if (open) _reset();

  function _reset() {
    phase = 'pick';
    pdfFile = null;
    preview = null;
    createdRecipes = [];
    progressLine = '';
    errorMessage = '';
  }

  function close() {
    open = false;
    dispatch('close');
  }

  function _pickFile() { _fileInput?.click(); }
  function _onFile(e) {
    const f = e.target?.files?.[0];
    if (!f) return;
    const isPdf = (f.type || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(f.name || '');
    if (!isPdf) {
      showError($_('cookbook_import_dialog.toast.pick_pdf'));
      return;
    }
    pdfFile = f;
    if (e.target) e.target.value = '';
  }
  function _clearPick() { pdfFile = null; preview = null; }

  async function prepare() {
    if (!pdfFile) return;
    phase = 'preparing';
    progressLine = 'Extracting text from the PDF…';
    errorMessage = '';

    const form = new FormData();
    form.append('file', pdfFile, pdfFile.name);
    try {
      const res = await fetch('/api/recipes/extract-and-parse', {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        phase = 'error';
        errorMessage = data?.error || `Extraction failed (HTTP ${res.status})`;
        return;
      }
      if (data.empty) {
        // Scanned cookbook PDF. Offer the AI Vision fallback if the
        // configured provider supports PDF document blocks.
        const provider = $aiProvider;
        const aiPdfCapable = $aiEnabled && !envLocked && (provider === 'claude' || provider === 'gemini');
        if (aiPdfCapable) {
          preview = { text: null, pages: data.pages, scanned: true };
          phase = 'ready';
          return;
        }
        phase = 'error';
        errorMessage = data.hint
          || 'This PDF has no text layer (scanned). The Claude or Gemini provider is required to read scanned PDFs directly.';
        return;
      }
      preview = { text: data.text, pages: data.pages, scanned: false };
      phase = 'ready';
    } catch (e) {
      phase = 'error';
      errorMessage = e.message || 'Extraction failed.';
    }
  }

  async function _fileToBase64(file) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        resolve(dataUrl.split(',')[1] || '');
      };
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
  }

  function _buildCookbookMessage(provider, sys, text) {
    if (text) {
      // Text path: same as before.
      return {
        role: 'user',
        content: `Cookbook text follows. Identify and emit one create_recipe call per recipe.

----- BEGIN COOKBOOK TEXT -----
${text}
----- END COOKBOOK TEXT -----`,
      };
    }
    // Scanned path: caller handles base64 + provider-specific shape.
    return null;
  }

  async function extractRecipes() {
    if (!preview) return;
    phase = 'extracting';
    createdRecipes = [];
    progressLine = preview.scanned
      ? 'Trace is reading the cookbook PDF…'
      : 'Trace is reading the cookbook…';

    const provider = $aiProvider;
    const apiKey   = $aiApiKey;
    const model    = $aiModel || AI_DEFAULT_MODELS[provider] || '';
    const baseUrl  = $aiBaseUrl;
    const cookbookTools = TOOLS.filter(t => t.name === 'create_recipe');

    const sys = `You are CookTrace's cookbook import assistant. The user has attached a PDF cookbook that contains multiple recipes. Identify each distinct recipe in the document and emit ONE create_recipe tool call per recipe found.

Rules:
- Call create_recipe ONCE per recipe. If you find 8 recipes, make 8 separate create_recipe calls.
- Pull a clean recipe name for each (drop magazine flourishes, page numbers, chapter labels).
- Ingredients: split into qty / unit / name / note. Qty stays as a string ("1", "1/2", "1 1/2").
- Steps: numbered. Use a short title only when the source has one.
- If a section of the document is clearly NOT a recipe (chapter intro, foreword, index, glossary), skip it. Do not emit a create_recipe call for it.
- Don't fabricate. If a field isn't visible for a given recipe, omit it.
- Don't combine multiple recipes into one. Each create_recipe call is one recipe.`;

    let userMsg;
    if (preview.scanned) {
      // Scanned cookbook: send PDF as a document block (Claude) or
      // inlineData (Gemini). We gated on these two providers in prepare().
      const MAX_BYTES = 20 * 1024 * 1024;
      if (pdfFile.size > MAX_BYTES) {
        phase = 'error';
        errorMessage = `PDF is too large for inline AI vision (${(pdfFile.size / 1024 / 1024).toFixed(1)} MB, cap 20 MB).`;
        return;
      }
      let base64;
      try { base64 = await _fileToBase64(pdfFile); }
      catch (e) { phase = 'error'; errorMessage = e.message; return; }
      if (provider === 'claude') {
        userMsg = { role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: 'Identify every recipe in this cookbook and emit one create_recipe call per recipe.' },
        ]};
      } else if (provider === 'gemini') {
        userMsg = {
          role: 'user',
          content: 'Identify every recipe in this cookbook and emit one create_recipe call per recipe.',
          _image: { mimeType: 'application/pdf', base64 },
        };
      } else {
        phase = 'error';
        errorMessage = 'Scanned cookbook import needs the Claude or Gemini provider.';
        return;
      }
    } else {
      userMsg = _buildCookbookMessage(provider, sys, preview.text);
    }

    try {
      await callAI({
        provider, apiKey, model, baseUrl,
        messages: [userMsg],
        systemPrompt: sys,
        tools: cookbookTools,
        onToolCall: (name) => {
          if (name === 'create_recipe') {
            progressLine = `Saving recipe ${createdRecipes.length + 1}…`;
          }
        },
        onToolResult: (name, result) => {
          if (name === 'create_recipe' && result && result.ok && result.recipe) {
            createdRecipes = [...createdRecipes, result.recipe];
            progressLine = `Found ${createdRecipes.length} recipe${createdRecipes.length === 1 ? '' : 's'}…`;
          }
        },
      });
      phase = 'done';
      progressLine = '';
      if (createdRecipes.length === 0) {
        errorMessage = 'Trace did not identify any recipes in this document. Try Bulk Import with the PDF split into smaller files, or verify the document actually contains recipes.';
        phase = 'error';
      } else {
        showSuccess(`Imported ${createdRecipes.length} recipe${createdRecipes.length === 1 ? '' : 's'} from the cookbook`);
      }
    } catch (e) {
      // If we collected SOME recipes before the error, surface the partial success.
      if (createdRecipes.length > 0) {
        phase = 'done';
        progressLine = '';
        errorMessage = `Trace stopped after ${createdRecipes.length} recipe${createdRecipes.length === 1 ? '' : 's'}: ${e.message || 'AI error'}`;
      } else {
        phase = 'error';
        errorMessage = e.message || 'Cookbook extraction failed.';
      }
    }
  }

  function openRecipe(r) {
    if (!r) return;
    close();
    push(`/recipes/${r.id}`);
  }

  $: aiAvailable = $aiEnabled && !envLocked;
</script>

{#if open}
  <div class="backdrop" use:portal on:click={close}
    in:fade={{ duration: 140 }} out:fade={{ duration: 100 }}>
    <div class="modal" on:click|stopPropagation>
      <header class="head">
        <h3>{$_('cookbook_import_dialog.title')}</h3>
        <button class="btn-icon" on:click={close} aria-label="Close" title="Close">
          <span class="material-symbols-rounded">close</span>
        </button>
      </header>

      {#if !aiAvailable}
        <div class="state info">
          <span class="material-symbols-rounded">{envLocked ? 'lock' : 'smart_toy'}</span>
          {#if envLocked}
            <p>Cookbook import isn't available when the AI provider is configured via environment variables — the server proxy doesn't relay tool calls. Ask the admin to switch to the user-key flow.</p>
          {:else}
            <p>Cookbook import needs Trace AI. Enable it in <a href="#/settings" on:click|preventDefault={() => { close(); push('/settings'); }}>Settings → Trace Assistant</a> first, or use Bulk Import for already-split recipe files.</p>
          {/if}
        </div>
        <footer class="actions">
          <button class="btn btn-secondary" on:click={close}>{$_('cookbook_import_dialog.close')}</button>
        </footer>

      {:else if phase === 'pick'}
        <p class="hint">
          Drop a PDF cookbook here. Trace AI will read the whole document and
          identify each recipe in it, saving one entry per recipe to your
          library. This is the right path for digital cookbooks (multi-recipe
          PDFs). For a single-recipe file or a folder of files use
          Import from File or Bulk Import instead.
        </p>
        {#if pdfFile}
          <div class="text-file-card">
            <span class="material-symbols-rounded file-icon">menu_book</span>
            <div class="file-meta">
              <div class="file-name">{pdfFile.name}</div>
              <div class="file-size">{Math.round(pdfFile.size / 1024)} KB</div>
            </div>
            <button class="btn-icon" on:click={_clearPick} aria-label="Pick a different file">
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
        {:else}
          <button class="picker" on:click={_pickFile}>
            <span class="material-symbols-rounded">menu_book</span>
            <span>{$_('cookbook_import_dialog.pick_cookbook_pdf')}</span>
            <span class="picker-sub">Multi-recipe PDF document</span>
          </button>
        {/if}
        <input type="file" accept="application/pdf,.pdf"
          bind:this={_fileInput} on:change={_onFile} hidden />
        <footer class="actions">
          <button class="btn btn-secondary" on:click={close}>{$_('cookbook_import_dialog.cancel')}</button>
          <button class="btn btn-primary" on:click={prepare} disabled={!pdfFile}>
            <span class="material-symbols-rounded">arrow_forward</span>
            Next
          </button>
        </footer>

      {:else if phase === 'preparing' || phase === 'extracting'}
        <div class="state busy">
          <span class="material-symbols-rounded spin">progress_activity</span>
          <p class="progress">{progressLine || 'Working…'}</p>
          {#if phase === 'extracting' && createdRecipes.length > 0}
            <p class="muted">{createdRecipes.length} recipe{createdRecipes.length === 1 ? '' : 's'} saved so far. Don't close the dialog.</p>
          {/if}
        </div>

      {:else if phase === 'ready'}
        {#if preview.scanned}
          <p class="hint">
            This is a scanned cookbook (no text layer). Trace AI will read
            the page images directly using your configured {$aiProvider === 'claude' ? 'Claude' : 'Gemini'}
            provider{#if preview.pages}, across {preview.pages} page{preview.pages === 1 ? '' : 's'}{/if}.
            Scanned PDFs use significantly more AI tokens than text PDFs and
            may take several minutes for large books.
          </p>
        {:else}
          <p class="hint">
            Extracted {(preview.text.length / 1024).toFixed(1)} KB of text
            {#if preview.pages} from {preview.pages} page{preview.pages === 1 ? '' : 's'}{/if}.
            Trace will read this and try to identify every recipe. Long
            documents may take a minute or two and use a corresponding
            chunk of your AI provider's budget.
          </p>
        {/if}
        <footer class="actions">
          <button class="btn btn-secondary" on:click={close}>{$_('cookbook_import_dialog.cancel')}</button>
          <button class="btn btn-primary" on:click={extractRecipes}>
            <span class="material-symbols-rounded">auto_awesome</span>
            Extract Recipes
          </button>
        </footer>

      {:else if phase === 'done'}
        <div class="state done">
          <span class="material-symbols-rounded done-icon">check_circle</span>
          <h4>Imported {createdRecipes.length} recipe{createdRecipes.length === 1 ? '' : 's'}</h4>
          {#if errorMessage}
            <p class="muted">{errorMessage}</p>
          {/if}
        </div>
        <div class="rows scroll">
          {#each createdRecipes as r}
            <button class="row-saved" on:click={() => openRecipe(r)}>
              <span class="material-symbols-rounded">restaurant_menu</span>
              <span class="row-saved-name">{r.name}</span>
              <span class="material-symbols-rounded chev">chevron_right</span>
            </button>
          {/each}
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
          <button class="btn btn-secondary" on:click={close}>{$_('cookbook_import_dialog.cancel')}</button>
          <button class="btn btn-primary" on:click={() => { phase = 'pick'; errorMessage = ''; }}>{$_('cookbook_import_dialog.try_again')}</button>
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
    width: 100%; max-width: 520px;
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

  .picker {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 6px;
    margin: 16px;
    padding: 36px 20px;
    border: 2px dashed var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
    color: var(--text-1);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: border-color var(--dur-fast), background var(--dur-fast);
  }
  .picker:hover {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
  }
  .picker .material-symbols-rounded { font-size: 36px; color: var(--accent); }
  .picker-sub { color: var(--text-3); font-size: 12px; font-weight: 500; }

  .text-file-card {
    display: flex; align-items: center; gap: 12px;
    margin: 16px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2);
  }
  .text-file-card .file-icon { font-size: 28px; color: var(--accent); }
  .file-meta { flex: 1; min-width: 0; }
  .file-name {
    font-weight: 600; color: var(--text-1); font-size: 14px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .file-size { color: var(--text-3); font-size: 12px; }

  .state {
    margin: 20px 16px;
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
  .state.info p { color: var(--text-2); }
  .state.info a { color: var(--accent); }
  .muted { color: var(--text-3); font-size: 12px; }
  .progress { margin: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .rows.scroll {
    overflow-y: auto;
    flex: 1 1 auto;
    padding: 4px 0;
    max-height: 280px;
  }
  .row-saved {
    display: flex; align-items: center; gap: 12px;
    width: 100%;
    padding: 10px 16px;
    background: transparent;
    border: none; border-bottom: 1px solid var(--border);
    color: var(--text-1);
    font-size: 14px; font-weight: 500;
    text-align: left;
    cursor: pointer;
  }
  .row-saved:hover { background: var(--surface-2); }
  .row-saved .material-symbols-rounded { font-size: 18px; color: var(--accent); flex-shrink: 0; }
  .row-saved .chev { color: var(--text-3); margin-left: auto; }
  .row-saved-name {
    flex: 1; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  .actions {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .actions .btn { display: inline-flex; align-items: center; gap: 6px; }
  .actions .btn .material-symbols-rounded { font-size: 16px; }
</style>
