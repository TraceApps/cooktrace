<script>
  /**
   * ImportFromFileDialog — unified file import (router).
   *
   * One menu entry. The picker accepts:
   *   - A single image (snap a photo of a cookbook page)
   *   - A single text-based file (PDF / RTF / TXT / MD)
   *   - Many files at once
   *   - A whole folder (via webkitdirectory)
   *   - A ZIP of any of the above
   *
   * The dialog counts what the user picked and routes:
   *   1 file (image or text)     -> FileImportDialog (heuristic + AI fallback / AI vision)
   *   2+ files / folder / ZIP    -> BulkFileImportDialog (picker grid, per-row Try AI)
   *
   * The Use Camera button always takes a single photo and routes to the
   * single-file path.
   */
  import { _ } from 'svelte-i18n';
  import { createEventDispatcher } from 'svelte';
  import { fade } from 'svelte/transition';
  import { showError } from '../../stores/toast.js';
  import { portal } from '../../lib/portal.js';
  import FileImportDialog from './FileImportDialog.svelte';
  import BulkFileImportDialog from './BulkFileImportDialog.svelte';

  export let open = false;
  export let envLocked = false;
  const dispatch = createEventDispatcher();

  let dragOver = false;
  let _fileInput;
  let _folderInput;
  let _cameraInput;

  // Routing state.
  let routeSingle = false;
  let routeBulk = false;
  let pickedSingle = null;
  let pickedBulk = null;

  $: if (open) _reset();

  function _reset() {
    dragOver = false;
    routeSingle = false;
    routeBulk = false;
    pickedSingle = null;
    pickedBulk = null;
  }

  function close() {
    open = false;
    dispatch('close');
  }
  function _onChildClose() { close(); }

  function _pickFiles()  { _fileInput?.click(); }
  function _pickFolder() { _folderInput?.click(); }
  function _openCamera() { _cameraInput?.click(); }

  function _onDragOver(e)  { e.preventDefault(); dragOver = true; }
  function _onDragLeave()  { dragOver = false; }
  function _onDrop(e) {
    e.preventDefault();
    dragOver = false;
    const list = Array.from(e.dataTransfer?.files || []);
    if (list.length) _routeByCount(list);
  }
  function _onFiles(e) {
    const list = Array.from(e.target?.files || []);
    if (list.length) _routeByCount(list);
    if (e.target) e.target.value = '';
  }

  function _routeByCount(files) {
    if (!files || files.length === 0) return;
    if (files.length === 1) {
      const f = files[0];
      const isImage = /^image\//.test(f.type || '');
      const isText  = /\.(pdf|rtf|txt|md|markdown)$/i.test(f.name || '');
      const isZip   = /\.zip$/i.test(f.name || '') || /^application\/(x-)?zip/.test(f.type || '');
      if (isZip) {
        // ZIP always goes through bulk path (server expands it).
        pickedBulk = files;
        routeBulk = true;
        return;
      }
      if (!isImage && !isText) {
        showError($_('import_from_file.toast.unsupported'));
        return;
      }
      pickedSingle = f;
      routeSingle = true;
    } else {
      pickedBulk = files;
      routeBulk = true;
    }
  }
</script>

{#if open && !routeSingle && !routeBulk}
  <div class="backdrop" use:portal on:click={close}
    in:fade={{ duration: 140 }} out:fade={{ duration: 100 }}>
    <div class="modal" on:click|stopPropagation>
      <header class="head">
        <h3>{$_('import_from_file.title')}</h3>
        <button class="btn-icon" on:click={close} aria-label="Close" title="Close">
          <span class="material-symbols-rounded">close</span>
        </button>
      </header>

      <p class="hint">
        Drop a single recipe file for a quick import, or a folder, multiple
        files, or a ZIP to pick which ones to save. Image (photo of a recipe
        page), PDF, RTF, TXT, and MD are all supported.
      </p>

      <div class="dropzone {dragOver ? 'over' : ''}"
        on:dragover={_onDragOver}
        on:dragleave={_onDragLeave}
        on:drop={_onDrop}
        on:click={_pickFiles}>
        <span class="material-symbols-rounded">cloud_upload</span>
        <p class="dz-title">{$_('import_from_file.dz_title')}</p>
        <p class="dz-sub">Image, PDF, RTF, TXT, MD, or a ZIP of any of these</p>
      </div>

      <div class="picker-aux">
        <button class="btn btn-secondary" on:click={_pickFolder}>
          <span class="material-symbols-rounded">folder_open</span>
          Pick a Folder
        </button>
        <button class="btn btn-secondary" on:click={_openCamera}>
          <span class="material-symbols-rounded">photo_camera</span>
          Use Camera
        </button>
      </div>

      <input type="file" multiple
        accept="image/*,.pdf,.rtf,.txt,.md,.markdown,.zip,application/pdf,application/rtf,text/rtf,text/plain,text/markdown,application/zip,application/x-zip-compressed"
        bind:this={_fileInput} on:change={_onFiles} hidden />
      <input type="file" webkitdirectory directory
        bind:this={_folderInput} on:change={_onFiles} hidden />
      <input type="file" accept="image/*" capture="environment"
        bind:this={_cameraInput} on:change={_onFiles} hidden />

      <footer class="actions">
        <button class="btn btn-secondary" on:click={close}>{$_('import_from_file.cancel')}</button>
      </footer>
    </div>
  </div>
{/if}

<!-- Child dialogs auto-open with pre-picked file(s). Their own close
     events bubble up here and tear down everything. -->
{#if routeSingle}
  <FileImportDialog open={true} {envLocked} initialFile={pickedSingle} on:close={_onChildClose} />
{/if}
{#if routeBulk}
  <BulkFileImportDialog open={true} {envLocked} initialFiles={pickedBulk} on:close={_onChildClose} />
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
    display: flex; justify-content: center; flex-wrap: wrap; gap: 8px;
    padding: 0 16px 12px;
    flex-shrink: 0;
  }
  .picker-aux .btn { display: inline-flex; align-items: center; gap: 6px; }
  .picker-aux .btn .material-symbols-rounded { font-size: 16px; }

  .actions {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .actions .btn { display: inline-flex; align-items: center; gap: 6px; }
  .actions .btn .material-symbols-rounded { font-size: 16px; }
</style>
