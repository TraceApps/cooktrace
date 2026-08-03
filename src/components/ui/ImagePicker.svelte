<script>
  /**
   * ImagePicker — three-source hero image input (Camera / Upload / URL).
   *
   * On native (Capacitor): camera button opens the native camera via
   * @capacitor/camera; upload button uses the standard file input.
   * On web: camera button opens an in-page popup with a getUserMedia
   * video stream + capture button. Upload is plain file input. URL is a
   * paste-and-fetch field.
   *
   * Dispatches `change` with the new image URL once accepted (uploaded or
   * pasted-as-is). The parent owns the actual `value` so it can also be
   * replaced/cleared from outside.
   */
  import { _ } from 'svelte-i18n';
  import { fade, scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { createEventDispatcher } from 'svelte';
  import { portal } from '../../lib/portal.js';
  import { NtApi } from '../../lib/api.js';
  import { isNative, resolveAssetUrl } from '../../lib/platform.js';
  import { showError } from '../../stores/toast.js';

  /** Current image URL (two-way bind from parent). Empty = no image. */
  export let value = '';
  /** Aspect ratio of the preview area. */
  export let aspect = '16 / 9';
  /** When true, the picker stretches to fill its container (useful in
      editor pages where it should match the input width below). When
      false (default), it's capped at 420px and centered, which suits
      dialogs and modals that already constrain the surrounding column. */
  export let expand = false;
  /** Bindable: true while a file is uploading. Parents that have a Save
      button should disable it while this is true so a user can't submit
      a stale empty value mid-upload. */
  export let uploading = false;
  /** Placeholder text shown in the empty-state preview. Defaults to the
      hero-image phrasing used by the recipe editor. Override anywhere
      else (e.g. "Add a photo" inside the diary log dialog). */
  export let placeholder = 'Add a Hero Image';

  const dispatch = createEventDispatcher();

  let fileInput;

  // Camera popup state (web only)
  let showCamera = false;
  let cameraVideo;
  let cameraStream = null;
  let captureBusy = false;

  // URL input state
  let showUrl = false;
  let urlInput = '';

  function clear() {
    value = '';
    dispatch('change', '');
  }

  // ── Upload ───────────────────────────────────────────────────────────
  async function onPickFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    await _uploadFile(file);
    e.target.value = '';
  }
  async function _uploadFile(file) {
    uploading = true;
    try {
      const url = await NtApi.uploadImage(file);
      value = resolveAssetUrl(url);
      dispatch('change', value);
    } catch (err) {
      showError(err.message || 'Upload failed');
    } finally {
      uploading = false;
    }
  }

  // ── Camera ───────────────────────────────────────────────────────────
  async function openCamera() {
    if (isNative) {
      // Capacitor native camera — opens the OS camera UI directly.
      try {
        const { takePhoto } = await import('../../lib/camera.js');
        const file = await takePhoto();
        if (file) await _uploadFile(file);
      } catch (e) { showError(e.message || 'Camera failed'); }
      return;
    }
    // Web: in-page camera popup with getUserMedia
    showCamera = true;
    await new Promise(r => setTimeout(r, 60)); // let the video element mount
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
      });
      if (cameraVideo) {
        cameraVideo.srcObject = cameraStream;
        cameraVideo.play();
      }
    } catch (err) {
      showCamera = false;
      showError($_('image_picker_ct.toast.camera_denied'));
    }
  }
  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
    showCamera = false;
  }
  async function capture() {
    if (!cameraVideo || captureBusy) return;
    captureBusy = true;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = cameraVideo.videoWidth;
      canvas.height = cameraVideo.videoHeight;
      canvas.getContext('2d').drawImage(cameraVideo, 0, 0);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
      stopCamera();
      if (!blob) return;
      const file = new File([blob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' });
      await _uploadFile(file);
    } finally {
      captureBusy = false;
    }
  }

  // ── URL ──────────────────────────────────────────────────────────────
  function applyUrl() {
    const u = (urlInput || '').trim();
    if (!u) return;
    value = u;
    showUrl = false;
    urlInput = '';
    dispatch('change', value);
  }
</script>

<div class="image-picker" class:expand>
  <div class="preview-wrap" style:aspect-ratio={aspect}>
    {#if value}
      <img class="preview-img" src={value} alt="" />
      <button class="preview-clear" on:click={clear} aria-label="Remove image" title="Remove image">
        <span class="material-symbols-rounded">close</span>
      </button>
    {:else}
      <div class="preview-placeholder">
        <span class="material-symbols-rounded ph-icon">photo_camera</span>
        {#if uploading}
          <span class="ph-text">Uploading…</span>
        {:else if placeholder}
          <span class="ph-text">{placeholder}</span>
        {/if}
      </div>
    {/if}
  </div>

  <div class="picker-actions">
    <button class="btn btn-secondary action-btn" on:click={openCamera} disabled={uploading}>
      <span class="material-symbols-rounded">photo_camera</span>
      Camera
    </button>
    <button class="btn btn-secondary action-btn" on:click={() => fileInput.click()} disabled={uploading}>
      <span class="material-symbols-rounded">photo_library</span>
      Upload
    </button>
    <button class="btn btn-secondary action-btn" on:click={() => { showUrl = !showUrl; urlInput = ''; }} disabled={uploading}>
      <span class="material-symbols-rounded">link</span>
      URL
    </button>
  </div>

  {#if showUrl}
    <div class="url-row" transition:fade={{ duration: 120 }}>
      <input
        class="input"
        type="url"
        placeholder="https://example.com/recipe.jpg"
        bind:value={urlInput}
        on:keydown={(e) => e.key === 'Enter' && applyUrl()}
        autofocus
      />
      <button class="btn btn-primary" on:click={applyUrl}>Use</button>
    </div>
  {/if}

  <input bind:this={fileInput} type="file" accept="image/*" on:change={onPickFile} class="file-input" />
</div>

{#if showCamera}
  <div use:portal class="cam-overlay"
    in:fade={{ duration: 160 }} out:fade={{ duration: 120 }}
    role="dialog" aria-modal="true">
    <div class="cam-popup"
      in:scale={{ start: 0.94, duration: 220, easing: cubicOut }}
      out:scale={{ start: 0.94, duration: 160 }}>
      <div class="cam-header">
        <span class="cam-title">{$_('image_picker_ct.title')}</span>
        <button class="btn-icon" on:click={stopCamera} aria-label="Close camera">
          <span class="material-symbols-rounded">close</span>
        </button>
      </div>
      <!-- svelte-ignore a11y-media-has-caption -->
      <video bind:this={cameraVideo} autoplay playsinline muted class="cam-video"></video>
      <div class="cam-footer">
        <button class="btn btn-primary cam-capture" on:click={capture} disabled={captureBusy}>
          <span class="material-symbols-rounded">camera_alt</span>
          {captureBusy ? 'Saving…' : 'Capture'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .image-picker { display: flex; flex-direction: column; gap: 10px; }

  /* Preview area is intentionally capped + centered so that adding an
     image doesn't blow up the editor — matches NT's photo-card pattern.
     Same size whether placeholder or actual image. With `expand` the
     cap is dropped so the picker fills its container (used in editor
     pages where it should match the surrounding input column). */
  .preview-wrap {
    position: relative;
    /* 360px centered preview matches NT FoodEditor's photo card. With
       `expand` the preview stretches to fill the parent (used in
       RecipeEditor where the picture row should match the input width). */
    width: min(360px, 100%);
    margin: 0 auto;
    background: var(--surface-2);
    border: 2px dashed var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .preview-wrap:has(.preview-img) {
    border-style: solid;
    border-color: transparent;
  }
  .image-picker.expand .preview-wrap { width: 100%; }
  .image-picker.expand .picker-actions { width: 100%; }
  .preview-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .preview-placeholder {
    width: 100%; height: 100%;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 6px;
    color: var(--text-3);
    font-size: 14px;
  }
  /* Icon-only placeholder — NT FoodEditor shows just a faded camera glyph
     when there's no photo. We optionally append placeholder text below
     when the consumer passes a non-empty `placeholder` prop. */
  .ph-icon {
    font-size: 48px;
    color: var(--text-3);
    opacity: 0.25;
  }
  .preview-clear {
    position: absolute;
    top: 8px; right: 8px;
    background: rgba(0,0,0,0.55);
    color: #fff;
    border: none;
    border-radius: 50%;
    width: 32px; height: 32px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(4px);
  }
  .preview-clear:hover { background: var(--error, #ef4444); }
  .preview-clear .material-symbols-rounded { font-size: 18px; }

  /* Button row mirrors NT's photo-btn-row: 3 equal-width ghost buttons,
     transparent background, accent-colored icon + label, no border. */
  .picker-actions {
    display: flex;
    gap: 6px;
    width: min(420px, 100%);
    margin: 0 auto;
  }
  .action-btn {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-size: 13px;
    padding: 10px 12px;
    background: transparent;
    border: none;
    color: var(--accent);
    font-weight: 600;
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: background var(--dur-fast);
  }
  .action-btn:hover:not(:disabled) {
    background: var(--accent-dim);
  }
  .action-btn:disabled { opacity: 0.5; cursor: wait; }
  .action-btn .material-symbols-rounded { font-size: 18px; }

  .url-row {
    display: flex;
    gap: 6px;
  }
  .url-row .input { flex: 1; }
  .input {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 9px 12px;
    color: var(--text-1);
    font-size: 14px;
    box-sizing: border-box;
    width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }

  .file-input { display: none; }

  /* ── Camera popup ──────────────────────────────────────────────────── */
  .cam-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.85);
    z-index: 200;
    display: flex; align-items: center; justify-content: center;
    padding: 16px;
  }
  .cam-popup {
    background: var(--surface-1);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 540px;
    overflow: hidden;
    border: 1px solid var(--border);
    box-shadow: 0 16px 48px rgba(0,0,0,0.5);
  }
  .cam-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }
  .cam-title { font-size: 15px; font-weight: 600; color: var(--text-1); }
  .btn-icon {
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--text-3);
    padding: 4px;
    border-radius: var(--radius-sm);
  }
  .btn-icon:hover { color: var(--error, #f87171); background: color-mix(in srgb, var(--error, #ef4444) 12%, transparent); }
  .btn-icon .material-symbols-rounded { font-size: 22px; }

  .cam-video {
    width: 100%;
    display: block;
    background: #000;
    max-height: 60vh;
  }
  .cam-footer {
    padding: 12px 14px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: center;
  }
  .cam-capture {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 10px 24px;
    font-size: 14px;
  }
  .cam-capture .material-symbols-rounded { font-size: 20px; }
</style>
