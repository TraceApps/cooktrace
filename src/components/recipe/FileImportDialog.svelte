<script>
  /**
   * FileImportDialog — "Import from File" entry on the Recipes page.
   *
   * Accepts an image (photo of a recipe page), or a recipe file in
   * PDF, RTF, TXT, or MD. Image inputs go through the AI vision path
   * (same code as the previous PhotoImportDialog). Text-based inputs
   * go through the hybrid pipeline:
   *
   *   1. Server extracts plain text from the file.
   *   2. Server runs the heuristic recipe parser.
   *   3. High confidence: client posts back with save=true; recipe saved.
   *   4. Low confidence + AI enabled: client offers "Try with AI", which
   *      sends the extracted text through callAI with create_recipe.
   *   5. Low confidence + no AI: client offers "Save best effort" so the
   *      stub still lands and the user can clean it up.
   *
   * Env-locked AI installs can still use the heuristic path for text-based
   * files; only the AI fallback is unavailable in that mode (the server
   * proxy doesn't relay tool calls).
   */
  import { _ } from 'svelte-i18n';
  import { createEventDispatcher } from 'svelte';
  import { fade } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import { formatDuration } from '../../lib/duration.js';
  import {
    aiEnabled, aiProvider, aiApiKey, aiModel, aiBaseUrl,
  } from '../../stores/settings.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { portal } from '../../lib/portal.js';
  import { callAI, TOOLS, AI_DEFAULT_MODELS } from '../../lib/aiChat.js';

  export let open = false;
  export let envLocked = false;
  // When opened by the unified ImportFromFileDialog router with a file
  // already picked, the dialog skips its pick phase and runs the file
  // through _onFile straight away. Cleared by _reset() on close.
  export let initialFile = null;
  const dispatch = createEventDispatcher();

  // Dialog phase machine.
  //   pick      initial picker
  //   busy      uploading / parsing / AI working
  //   review    heuristic done, user decides save / retry-with-AI / cancel
  //   done      recipe created
  //   error     something failed
  let phase = 'pick';
  let mode  = null;          // 'image' | 'text' | null
  let preview = null;        // data URL for image preview
  let rawImage = null;       // { base64, mimeType }
  let textFile = null;       // { name, size, type }
  let progressLine = '';
  let createdRecipe = null;
  let errorMessage = '';
  let _fileInput;
  let _cameraInput;

  // Heuristic review state.
  let parseResult = null;    // server response from /extract-and-parse
  let confidence = 0;
  let confidenceThreshold = 0.7;
  // When extract-and-parse returns empty on a PDF (scanned, no text
  // layer), we hold onto the original file so the AI Vision fallback
  // can send it as a document block to Claude or Gemini.
  let scannedPdfFile = null;

  $: if (open) _onOpen();

  function _onOpen() {
    _reset();
    if (initialFile) {
      // Feed the pre-picked file through the same dispatch path as a
      // manual pick, then auto-advance to the right next phase.
      _onFile({ target: { files: [initialFile] } });
      // If it's a text-based file (PDF/RTF/TXT/MD), kick off extraction
      // immediately so the user lands on the review screen without an
      // extra Import tap. Image files stay on the pick screen so the
      // user confirms they want to send the photo to AI.
      const lowerName = (initialFile.name || '').toLowerCase();
      const isText = /\.(pdf|rtf|txt|md|markdown)$/.test(lowerName);
      if (isText) {
        // microtask so textFile gets set by _onFile first
        Promise.resolve().then(() => importTextFile());
      }
    }
  }

  function _reset() {
    phase = 'pick';
    mode = null;
    preview = null;
    rawImage = null;
    textFile = null;
    progressLine = '';
    createdRecipe = null;
    errorMessage = '';
    parseResult = null;
    confidence = 0;
    scannedPdfFile = null;
  }

  function close() {
    open = false;
    dispatch('close');
  }

  function _pickFile() { _fileInput?.click(); }
  function _openCamera() { _cameraInput?.click(); }

  function _onFile(e) {
    const f = e.target?.files?.[0];
    if (!f) return;
    const isImage = /^image\//.test(f.type || '');
    const lowerName = (f.name || '').toLowerCase();
    const isText = !isImage && /\.(pdf|rtf|txt|md|markdown)$/.test(lowerName);

    if (!isImage && !isText) {
      showError($_('file_import_dialog.toast.unsupported_file'));
      return;
    }

    if (isImage) {
      mode = 'image';
      textFile = null;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        preview = dataUrl;
        rawImage = {
          base64: String(dataUrl).split(',')[1] || '',
          mimeType: f.type || 'image/jpeg',
        };
      };
      reader.readAsDataURL(f);
    } else {
      mode = 'text';
      preview = null;
      rawImage = null;
      textFile = { file: f, name: f.name, size: f.size, type: f.type };
    }
    if (e.target) e.target.value = '';
  }

  function _clearPick() {
    preview = null;
    rawImage = null;
    textFile = null;
    mode = null;
  }

  // ── Image path (AI vision, unchanged from PhotoImportDialog) ─────────────

  function _buildImageMessage(provider, text, image) {
    if (provider === 'claude') {
      return { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } },
        { type: 'text', text },
      ]};
    } else if (provider === 'gemini') {
      return { role: 'user', content: text, _image: image };
    }
    return { role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
      { type: 'text', text },
    ]};
  }

  $: createRecipeTool = TOOLS.filter(t => t.name === 'create_recipe');

  const _systemPrompt = `You are CookTrace's recipe-import assistant. The user has attached a recipe (as an image or as text extracted from a file). Extract the recipe and call the create_recipe tool with the result.

Rules:
- ALWAYS call create_recipe. Don't summarize or describe in plain text.
- Pull a clean recipe name (drop magazine flourishes like "Aunt Edna's Famous").
- Ingredients: split into qty / unit / name / note. Qty stays as a string ("1", "1/2", "1 1/2").
- Steps: numbered. Use a short title only when the source has one.
- If the input isn't a recipe (or is illegible), call create_recipe anyway with a stub name like "Imported Recipe" and a single step explaining what you saw, so the user can clean it up.
- Don't fabricate. If a field isn't visible, omit it.`;

  async function _runAi({ userMsg, label }) {
    phase = 'busy';
    progressLine = label || 'Trace is reading the recipe…';
    createdRecipe = null;

    const provider = $aiProvider;
    const apiKey   = $aiApiKey;
    const model    = $aiModel || AI_DEFAULT_MODELS[provider] || '';
    const baseUrl  = $aiBaseUrl;
    try {
      await callAI({
        provider, apiKey, model, baseUrl,
        messages: [userMsg],
        systemPrompt: _systemPrompt,
        tools: createRecipeTool,
        onToolCall:   (name) => { progressLine = `Calling ${name.replace(/_/g, ' ')}…`; },
        onToolResult: (name, result) => {
          if (name === 'create_recipe' && result && result.ok && result.recipe) {
            createdRecipe = result.recipe;
          }
        },
      });
      if (createdRecipe) {
        phase = 'done';
        progressLine = '';
      } else {
        phase = 'error';
        errorMessage = 'Trace finished but did not save a recipe. Try a clearer source or import via chat.';
      }
    } catch (e) {
      phase = 'error';
      errorMessage = e.message || 'AI import failed.';
    }
  }

  async function importImage() {
    if (!rawImage) return;
    const userMsg = _buildImageMessage($aiProvider, 'Please import this recipe.', rawImage);
    await _runAi({ userMsg, label: 'Trace is reading the photo…' });
  }

  // ── Text path (server-side heuristic, optional AI fallback) ──────────────

  async function importTextFile() {
    if (!textFile?.file) return;
    phase = 'busy';
    progressLine = 'Extracting text…';
    errorMessage = '';
    parseResult = null;

    const form = new FormData();
    form.append('file', textFile.file, textFile.name);
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
        // Scanned / image-only PDF. Offer the AI Vision fallback if the
        // configured provider supports PDF document blocks. Otherwise
        // surface the original hint.
        const provider = $aiProvider;
        const aiPdfCapable = $aiEnabled && !envLocked && (provider === 'claude' || provider === 'gemini');
        if (data.type === 'pdf' && aiPdfCapable) {
          scannedPdfFile = textFile.file;
          phase = 'scanned-pdf';
          return;
        }
        phase = 'error';
        errorMessage = data.hint || 'No text could be extracted from this file.';
        return;
      }
      parseResult = data;
      confidence = data.confidence || 0;
      confidenceThreshold = data.highConfidenceThreshold || 0.7;
      phase = 'review';
    } catch (e) {
      phase = 'error';
      errorMessage = e.message || 'Extract failed.';
    }
  }

  // ── PDF AI Vision fallback (scanned PDFs) ────────────────────────────────

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

  function _buildPdfMessage(provider, text, base64) {
    if (provider === 'claude') {
      return { role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text },
      ]};
    }
    if (provider === 'gemini') {
      return { role: 'user', content: text, _image: { mimeType: 'application/pdf', base64 } };
    }
    // Other providers don't support PDF natively in chat-completions. We
    // gate the button on Claude/Gemini above, so this is a safety net.
    return null;
  }

  async function importScannedPdf() {
    if (!scannedPdfFile) return;
    const provider = $aiProvider;
    // 20 MB ceiling to stay safely under provider inline-document limits.
    const MAX_BYTES = 20 * 1024 * 1024;
    if (scannedPdfFile.size > MAX_BYTES) {
      phase = 'error';
      errorMessage = `PDF is too large for inline AI vision (${(scannedPdfFile.size / 1024 / 1024).toFixed(1)} MB, cap 20 MB). Try splitting the PDF or using Photo Import per page.`;
      return;
    }
    let base64;
    try { base64 = await _fileToBase64(scannedPdfFile); }
    catch (e) { phase = 'error'; errorMessage = e.message; return; }
    const userMsg = _buildPdfMessage(provider, 'Please import this recipe from the attached PDF.', base64);
    if (!userMsg) {
      phase = 'error';
      errorMessage = 'AI Vision PDF needs the Claude or Gemini provider. Switch in Settings → Trace Assistant.';
      return;
    }
    await _runAi({ userMsg, label: 'Trace is reading the PDF…' });
  }

  async function saveHeuristic() {
    if (!textFile?.file) return;
    phase = 'busy';
    progressLine = 'Saving recipe…';

    const form = new FormData();
    form.append('file', textFile.file, textFile.name);
    form.append('save', 'true');
    try {
      const res = await fetch('/api/recipes/extract-and-parse', {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        phase = 'error';
        errorMessage = data?.error || `Save failed (HTTP ${res.status})`;
        return;
      }
      createdRecipe = data.recipe;
      phase = 'done';
    } catch (e) {
      phase = 'error';
      errorMessage = e.message || 'Save failed.';
    }
  }

  async function retryWithAi() {
    if (!parseResult?.text) return;
    const provider = $aiProvider;
    const userMsg = {
      role: 'user',
      content: `Please import the recipe below.

----- BEGIN RECIPE TEXT -----
${parseResult.text}
----- END RECIPE TEXT -----`,
    };
    // Gemini takes a flat string here; Claude / OpenAI accept the same shape.
    await _runAi({ userMsg, label: 'Trace is reading the recipe…' });
  }

  // ── Confirmation actions ─────────────────────────────────────────────────

  function importIt() {
    if (mode === 'image') return importImage();
    if (mode === 'text')  return importTextFile();
  }

  function openCreated() {
    if (!createdRecipe) return;
    showSuccess(`Imported "${createdRecipe.name}"`);
    close();
    push(`/recipes/${createdRecipe.id}`);
  }

  $: confidencePct = Math.round(confidence * 100);
  $: confidenceLabel =
    confidence >= confidenceThreshold ? 'Clean parse' :
    confidence >= 0.4                  ? 'Partial parse' :
                                         'Best effort';
  $: confidenceClass =
    confidence >= confidenceThreshold ? 'high' :
    confidence >= 0.4                  ? 'mid'  :
                                         'low';
  $: parsedRecipe = parseResult?.recipe || null;
</script>

{#if open}
  <div class="backdrop" use:portal on:click={close}
    in:fade={{ duration: 140 }} out:fade={{ duration: 100 }}>
    <div class="modal" on:click|stopPropagation>
      <header class="head">
        <h3>{$_('file_import_dialog.title')}</h3>
        <button class="btn-icon" on:click={close} aria-label="Close" title="Close">
          <span class="material-symbols-rounded">close</span>
        </button>
      </header>

      {#if phase === 'pick'}
        <p class="hint">
          Pick an image of a recipe page, or a PDF, RTF, TXT, or MD file.
          Photos go straight to Trace AI. Text-based files run through a
          built-in parser first, with AI as a fallback for tricky inputs.
        </p>
        {#if preview}
          <div class="preview-wrap">
            <img class="preview" src={preview} alt="" />
            <button class="preview-clear" on:click={_clearPick} aria-label="Pick a different file">
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
        {:else if textFile}
          <div class="text-file-card">
            <span class="material-symbols-rounded file-icon">description</span>
            <div class="file-meta">
              <div class="file-name">{textFile.name}</div>
              <div class="file-size">{Math.round(textFile.size / 1024)} KB</div>
            </div>
            <button class="btn-icon" on:click={_clearPick} aria-label="Pick a different file">
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
        {:else}
          <div class="picker-row">
            <button class="picker" on:click={_pickFile}>
              <span class="material-symbols-rounded">upload_file</span>
              <span>{$_('file_import_dialog.pick_a_file')}</span>
              <span class="picker-sub">Image, PDF, RTF, TXT, or MD</span>
            </button>
            <button class="picker picker-camera" on:click={_openCamera}>
              <span class="material-symbols-rounded">photo_camera</span>
              <span>{$_('file_import_dialog.use_camera')}</span>
              <span class="picker-sub">{$_('file_import_dialog.camera_sub')}</span>
            </button>
          </div>
        {/if}
        <input type="file"
          accept="image/*,application/pdf,application/rtf,text/rtf,text/plain,text/markdown,.md,.markdown"
          bind:this={_fileInput} on:change={_onFile} hidden />
        <input type="file" accept="image/*" capture="environment"
          bind:this={_cameraInput} on:change={_onFile} hidden />
        <footer class="actions">
          <button class="btn btn-secondary" on:click={close}>{$_('file_import_dialog.cancel')}</button>
          <button class="btn btn-primary" on:click={importIt} disabled={!rawImage && !textFile}>
            <span class="material-symbols-rounded">auto_awesome</span>
            Import
          </button>
        </footer>

      {:else if phase === 'busy'}
        <div class="state busy">
          {#if preview}<img class="preview busy" src={preview} alt="" />{/if}
          <span class="material-symbols-rounded spin">progress_activity</span>
          <p class="progress">{progressLine || 'Working…'}</p>
        </div>

      {:else if phase === 'scanned-pdf'}
        <div class="state info">
          <span class="material-symbols-rounded">picture_as_pdf</span>
          <p>
            This PDF has no text layer (it's a scan or image-only PDF).
            Trace AI can read the page images directly using your
            configured {$aiProvider === 'claude' ? 'Claude' : 'Gemini'}
            provider. This uses more AI tokens than text PDFs.
          </p>
        </div>
        <footer class="actions">
          <button class="btn btn-secondary" on:click={close}>{$_('file_import_dialog.cancel')}</button>
          <button class="btn btn-primary" on:click={importScannedPdf}>
            <span class="material-symbols-rounded">auto_awesome</span>
            Read with AI Vision
          </button>
        </footer>

      {:else if phase === 'review'}
        <div class="review">
          <div class="confidence-row">
            <span class="confidence-pill {confidenceClass}">
              {confidenceLabel} ({confidencePct}%)
            </span>
            {#if parseResult?.pages}
              <span class="pages-meta">{parseResult.pages} page{parseResult.pages === 1 ? '' : 's'}</span>
            {/if}
          </div>
          <h4 class="parsed-title">{parsedRecipe?.name || 'Untitled'}</h4>
          <div class="parsed-meta">
            {#if parsedRecipe?.servings}<span>Serves {parsedRecipe.servings}</span>{/if}
            {#if parsedRecipe?.prep_minutes}<span>Prep {formatDuration(parsedRecipe.prep_minutes)}</span>{/if}
            {#if parsedRecipe?.cook_minutes}<span>Cook {formatDuration(parsedRecipe.cook_minutes)}</span>{/if}
            {#if parsedRecipe?.rest_minutes}<span>Rest {formatDuration(parsedRecipe.rest_minutes)}</span>{/if}
          </div>
          <div class="parsed-summary">
            <span>{parsedRecipe?.ingredients?.length || 0} ingredient{(parsedRecipe?.ingredients?.length || 0) === 1 ? '' : 's'}</span>
            <span>&middot;</span>
            <span>{parsedRecipe?.steps?.length || 0} step{(parsedRecipe?.steps?.length || 0) === 1 ? '' : 's'}</span>
          </div>
          {#if confidence < confidenceThreshold}
            <p class="hint review-hint">
              The built-in parser wasn't sure about the structure. You can
              save the best-effort result and clean it up in the editor, or
              {#if $aiEnabled && !envLocked}try Trace AI for a cleaner parse.{:else}enable Trace AI in Settings for a smarter fallback.{/if}
            </p>
          {/if}
        </div>
        <footer class="actions wrap">
          <button class="btn btn-secondary" on:click={close}>{$_('file_import_dialog.cancel')}</button>
          {#if confidence < confidenceThreshold && $aiEnabled && !envLocked}
            <button class="btn btn-secondary" on:click={retryWithAi}>
              <span class="material-symbols-rounded">smart_toy</span>
              Try with AI
            </button>
          {/if}
          <button class="btn btn-primary" on:click={saveHeuristic}>
            <span class="material-symbols-rounded">save</span>
            {confidence >= confidenceThreshold ? 'Save Recipe' : 'Save Anyway'}
          </button>
        </footer>

      {:else if phase === 'done'}
        <div class="state done">
          <span class="material-symbols-rounded done-icon">check_circle</span>
          <h4>Imported "{createdRecipe?.name || 'Recipe'}"</h4>
          <p>Saved to your library. Open it to review and edit.</p>
        </div>
        <footer class="actions">
          <button class="btn btn-secondary" on:click={close}>{$_('file_import_dialog.done')}</button>
          <button class="btn btn-primary" on:click={openCreated}>
            <span class="material-symbols-rounded">open_in_new</span>
            Open Recipe
          </button>
        </footer>

      {:else if phase === 'error'}
        <div class="state error">
          <span class="material-symbols-rounded">error</span>
          <p>{errorMessage}</p>
        </div>
        <footer class="actions">
          <button class="btn btn-secondary" on:click={close}>{$_('file_import_dialog.cancel')}</button>
          <button class="btn btn-primary" on:click={() => { phase = 'pick'; errorMessage = ''; }}>{$_('file_import_dialog.try_again')}</button>
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
    width: 100%; max-width: 480px;
    max-height: 88vh;
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
    display: flex; flex-direction: column;
  }
  .head {
    display: flex; align-items: center;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
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
  }
  .review-hint { margin-top: 12px; }

  .picker-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin: 16px;
  }
  .picker {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 6px;
    margin: 0;
    padding: 24px 14px;
    border: 2px dashed var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
    color: var(--text-1);
    font-size: 14px;
    font-weight: 600;
    text-align: center;
    cursor: pointer;
    transition: border-color var(--dur-fast), background var(--dur-fast);
  }
  .picker:hover {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
  }
  .picker .material-symbols-rounded { font-size: 32px; color: var(--accent); }
  .picker-sub { color: var(--text-3); font-size: 11px; font-weight: 500; line-height: 1.3; }
  @media (max-width: 380px) {
    .picker-row { grid-template-columns: 1fr; }
  }

  .preview-wrap {
    position: relative;
    margin: 16px;
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--surface-2);
  }
  .preview {
    width: 100%;
    max-height: 320px;
    object-fit: contain;
    display: block;
  }
  .preview-clear {
    position: absolute; top: 8px; right: 8px;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    border: none;
    border-radius: 50%;
    width: 28px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
  }
  .preview-clear .material-symbols-rounded { font-size: 16px; }

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

  .review {
    padding: 16px 16px 8px;
  }
  .confidence-row {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 8px;
  }
  .confidence-pill {
    display: inline-flex; align-items: center;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 12px; font-weight: 600;
  }
  .confidence-pill.high {
    background: color-mix(in srgb, var(--success, #4ade80) 18%, transparent);
    color: var(--success, #4ade80);
  }
  .confidence-pill.mid {
    background: color-mix(in srgb, var(--warning, #f59e0b) 18%, transparent);
    color: var(--warning, #f59e0b);
  }
  .confidence-pill.low {
    background: color-mix(in srgb, var(--error, #f87171) 14%, transparent);
    color: var(--error, #f87171);
  }
  .pages-meta { color: var(--text-3); font-size: 12px; }
  .parsed-title {
    margin: 4px 0 6px; color: var(--text-1); font-size: 16px; font-weight: 700;
  }
  .parsed-meta, .parsed-summary {
    display: flex; flex-wrap: wrap; gap: 10px;
    color: var(--text-3); font-size: 12px;
    margin-bottom: 4px;
  }

  .state {
    margin: 20px 16px;
    text-align: center;
    color: var(--text-3);
    font-size: 14px;
    line-height: 1.5;
    display: flex; flex-direction: column; align-items: center; gap: 10px;
  }
  .state .material-symbols-rounded { font-size: 36px; color: var(--accent); }
  .state.busy .preview {
    margin: 0 auto 6px;
    width: auto; max-width: 100%; max-height: 160px;
    border-radius: var(--radius-md);
  }
  .state.busy .spin { font-size: 32px; animation: spin 1.2s linear infinite; }
  .state.error .material-symbols-rounded { color: var(--error, #f87171); }
  .state.error p { color: var(--error, #f87171); }
  .state.done h4 { margin: 4px 0 0; color: var(--text-1); font-size: 16px; }
  .state.done p  { margin: 0; }
  .state.done .done-icon { color: var(--success, #4ade80); }
  .state.info p { color: var(--text-2); }
  .progress { margin: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .actions {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
  .actions.wrap { flex-wrap: wrap; }
  .actions .btn { display: inline-flex; align-items: center; gap: 6px; }
  .actions .btn .material-symbols-rounded { font-size: 16px; }
</style>
