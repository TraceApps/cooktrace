<script>
  import { _ } from 'svelte-i18n';
  import { scale, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { createEventDispatcher } from 'svelte';
  import { portal } from '../../lib/portal.js';
  import { NtApi } from '../../lib/api.js';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import { showError } from '../../stores/toast.js';
  import { isNative } from '../../lib/platform.js';
  import DateInput from '../ui/DateInput.svelte';

  /** Dialog open/closed. Two-way bind. */
  export let open = false;
  /** Recipe name shown in the header. */
  export let recipeName = '';
  /** Existing cook entry being edited (null when logging a new cook). */
  export let editing = null;

  const dispatch = createEventDispatcher();

  // Form state
  let date = _todayIso();
  let notes = '';
  let photos = [];
  let mealType = null;   // 'breakfast' | 'lunch' | 'dinner' | 'snack' | null
  let rating = 0;        // 0..5; 0 = unrated (column stores NULL)
  let busy = false;
  let photoUploading = false;
  let urlEntryOpen = false;
  let urlEntry = '';
  let fileInput;

  // Reset / hydrate when the dialog opens.
  $: if (open) {
    if (editing) {
      date  = editing.date || _todayIso();
      notes = editing.notes || '';
      mealType = editing.meal_type || null;
      rating   = Number.isFinite(editing.rating) ? editing.rating : 0;
      const arr = Array.isArray(editing.photos) ? editing.photos.slice() : [];
      if (arr.length === 0 && editing.photo_url) arr.push(editing.photo_url);
      photos = arr;
    } else {
      date   = _todayIso();
      notes  = '';
      mealType = _autoMealType();
      rating   = 0;
      photos = [];
    }
    urlEntryOpen = false;
    urlEntry = '';
  }

  // Pre-fill meal type based on the time of day — convenient default
  // for the common "I just ate this" log. User can change it.
  function _autoMealType() {
    const h = new Date().getHours();
    if (h < 11) return 'breakfast';
    if (h < 15) return 'lunch';
    if (h < 21) return 'dinner';
    return 'snack';
  }

  const MEAL_TYPES = [
    { id: 'breakfast', label: 'Breakfast', icon: 'free_breakfast' },
    { id: 'lunch',     label: 'Lunch',     icon: 'lunch_dining'   },
    { id: 'dinner',    label: 'Dinner',    icon: 'restaurant'     },
    { id: 'snack',     label: 'Snack',     icon: 'cookie'         },
  ];

  function removePhoto(i) {
    photos = photos.filter((_, idx) => idx !== i);
  }

  // ── Direct upload path — bypasses ImagePicker so there's no bind:value
  // race with the photos array. Each Add-photo source (Camera / Upload /
  // URL) ends in `_pushPhoto(url)` which appends to the array.
  function _pushPhoto(url) {
    if (!url) return;
    photos = [...photos, url];
  }

  async function _uploadFile(file) {
    if (!file) return;
    photoUploading = true;
    try {
      const url = await NtApi.uploadImage(file);
      _pushPhoto(url);
    } catch (e) {
      showError(e.message || 'Upload failed');
    } finally {
      photoUploading = false;
    }
  }

  // Multi-file pick — desktop browsers and most mobile gallery pickers
  // honor the `multiple` attribute. Each file uploads in sequence so we
  // surface errors per-file instead of all-or-nothing.
  async function onFilePick(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) {
      // eslint-disable-next-line no-await-in-loop
      await _uploadFile(f);
    }
  }

  // Lightbox — click any thumb to view it full-size with navigation.
  let lightboxIndex = -1;
  function openLightbox(i) { lightboxIndex = i; }
  function closeLightbox() { lightboxIndex = -1; }
  function lightboxPrev() { if (lightboxIndex > 0) lightboxIndex -= 1; }
  function lightboxNext() { if (lightboxIndex < photos.length - 1) lightboxIndex += 1; }
  function onLightboxKey(e) {
    if (lightboxIndex < 0) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') lightboxPrev();
    else if (e.key === 'ArrowRight') lightboxNext();
  }

  async function openCamera() {
    if (isNative) {
      try {
        const { takePhoto } = await import('../../lib/camera.js');
        const file = await takePhoto();
        if (file) await _uploadFile(file);
      } catch (e) {
        showError(e.message || 'Camera failed');
      }
      return;
    }
    // Web fallback: most browsers honor capture=user/environment on
    // the file input to open the OS camera. Reuse the file input.
    if (fileInput) {
      fileInput.setAttribute('capture', 'environment');
      fileInput.click();
      // Strip capture so a subsequent Upload click stays a regular file picker.
      setTimeout(() => fileInput.removeAttribute('capture'), 250);
    }
  }

  function openUrlEntry() {
    urlEntryOpen = true;
    urlEntry = '';
  }
  function applyUrlEntry() {
    const u = (urlEntry || '').trim();
    if (!u) return;
    _pushPhoto(u);
    urlEntry = '';
    urlEntryOpen = false;
  }

  function _todayIso() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  // Image upload handled inside <ImagePicker /> — this dialog just owns the URL.

  async function save() {
    busy = true;
    try {
      const payload = {
        date,
        notes: notes.trim() || null,
        photos,                       // new shape — array of URLs
        photo_url: photos[0] || null, // legacy fallback for older clients
        meal_type: mealType || null,
        // 0 stars in the UI means unrated — send null so the column
        // stores NULL instead of forcing a 0 score.
        rating: rating > 0 ? rating : null,
      };
      dispatch('save', payload);
      open = false;
    } finally {
      busy = false;
    }
  }

  function cancel() {
    if (busy) return;
    open = false;
    dispatch('cancel');
  }
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="cl-backdrop" on:click={cancel}
    in:fade={{ duration: 180 }} out:fade={{ duration: 140 }}>
    <div
      class="cl-box"
      in:scale={{ start: 0.92, duration: 220, easing: cubicOut }}
      out:scale={{ start: 0.92, duration: 160 }}
      on:click|stopPropagation
      role="dialog"
      aria-modal="true"
    >
      <header class="cl-header">
        <h2 class="cl-title">
          {editing ? 'Edit Diary Entry' : 'Add to Diary'}
          {#if recipeName}<span class="cl-subtitle">{recipeName}</span>{/if}
        </h2>
        <button class="icon-btn" on:click={cancel} aria-label="Close">
          <span class="material-symbols-rounded">close</span>
        </button>
      </header>

      <div class="cl-body">
        <div class="cl-field">
          <span class="cl-label">{$_('cook_log_dialog.date')}</span>
          <DateInput bind:value={date} max={_todayIso()} />
        </div>

        <div class="cl-field">
          <span class="cl-label">{$_('cook_log_dialog.meal')} <span class="cl-hint">{$_('cook_log_dialog.optional')}</span></span>
          <div class="meal-chips" role="radiogroup" aria-label="Meal type">
            {#each MEAL_TYPES as m}
              <button type="button"
                class="meal-chip" class:active={mealType === m.id}
                aria-pressed={mealType === m.id}
                on:click={() => mealType = (mealType === m.id ? null : m.id)}>
                <span class="material-symbols-rounded">{m.icon}</span>
                {m.label}
              </button>
            {/each}
          </div>
        </div>

        <div class="cl-field">
          <span class="cl-label">How was it? <span class="cl-hint">(this cook only)</span></span>
          <div class="rating-row" role="radiogroup" aria-label="Rating">
            {#each [1, 2, 3, 4, 5] as n}
              <button type="button"
                class="rating-star" class:on={rating >= n}
                aria-label={`${n} star${n === 1 ? '' : 's'}`}
                on:click={() => rating = (rating === n ? 0 : n)}>
                <span class="material-symbols-rounded">{rating >= n ? 'star' : 'star_outline'}</span>
              </button>
            {/each}
            {#if rating > 0}
              <button type="button" class="rating-clear" on:click={() => rating = 0}
                title="Clear rating" aria-label="Clear rating">
                <span class="material-symbols-rounded">close</span>
              </button>
            {/if}
          </div>
        </div>

        <label class="cl-field">
          <span class="cl-label">{$_('cook_log_dialog.notes')} <span class="cl-hint">{$_('cook_log_dialog.notes_hint')}</span></span>
          <textarea
            class="input"
            rows="3"
            bind:value={notes}
            placeholder="Doubled the garlic. Used buttermilk instead of milk. Took 5 min less than expected."
          ></textarea>
        </label>

        <div class="cl-field">
          <span class="cl-label">
            Photos <span class="cl-hint">(optional — add as many as you want)</span>
          </span>

          <!-- Same 3-button row as the standard ImagePicker (Camera /
               Upload / URL), so the photo section looks consistent
               with the recipe editor + pantry editor. -->
          <div class="picker-actions">
            <button type="button" class="action-btn" on:click={openCamera} disabled={photoUploading}>
              <span class="material-symbols-rounded">photo_camera</span> Camera
            </button>
            <button type="button" class="action-btn" on:click={() => fileInput?.click()} disabled={photoUploading}>
              <span class="material-symbols-rounded">photo_library</span>
              {photoUploading ? 'Uploading…' : 'Upload'}
            </button>
            <button type="button" class="action-btn" on:click={openUrlEntry} disabled={photoUploading}>
              <span class="material-symbols-rounded">link</span> URL
            </button>
          </div>
          {#if urlEntryOpen}
            <div class="url-entry-row">
              <input class="input" type="url" placeholder="https://example.com/dish.jpg"
                bind:value={urlEntry}
                on:keydown={e => e.key === 'Enter' && applyUrlEntry()}
                autofocus />
              <button type="button" class="btn btn-primary" on:click={applyUrlEntry}>Add</button>
              <button type="button" class="btn btn-secondary" on:click={() => { urlEntryOpen = false; urlEntry = ''; }}>{$_('cook_log_dialog.cancel')}</button>
            </div>
          {/if}

          {#if photos.length > 0}
            <div class="photo-strip">
              {#each photos as p, i (p + i)}
                <button type="button" class="photo-thumb" on:click={() => openLightbox(i)} aria-label="View photo {i + 1}">
                  <img src={resolveAssetUrl(p)} alt="" />
                  <span class="photo-remove"
                    on:click|stopPropagation={() => removePhoto(i)}
                    role="button" tabindex="0"
                    on:keydown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); removePhoto(i); } }}
                    aria-label="Remove photo" title="Remove">
                    <span class="material-symbols-rounded">close</span>
                  </span>
                </button>
              {/each}
            </div>
          {/if}

          <!-- multiple = pick many at once on PC + most mobile galleries -->
          <input bind:this={fileInput} type="file" accept="image/*" multiple on:change={onFilePick} style="display:none" />
        </div>
      </div>

      <footer class="cl-footer">
        <button class="btn btn-secondary" on:click={cancel} disabled={busy}>{$_('cook_log_dialog.cancel')}</button>
        <button class="btn btn-primary" on:click={save} disabled={busy || photoUploading}>
          <span class="material-symbols-rounded">restaurant</span>
          {photoUploading ? 'Uploading photo…' : busy ? 'Saving…' : (editing ? 'Save changes' : 'Add to Diary')}
        </button>
      </footer>
    </div>
  </div>
{/if}

<!-- Lightbox — full-screen photo viewer. Mounted via portal so it
     escapes the dialog's overflow container. -->
<svelte:window on:keydown={onLightboxKey} />
{#if lightboxIndex >= 0 && photos[lightboxIndex]}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div use:portal class="lb-backdrop" on:click={closeLightbox}
    in:fade={{ duration: 160 }} out:fade={{ duration: 120 }}>
    <button class="lb-close" on:click|stopPropagation={closeLightbox} aria-label="Close" title="Close (Esc)">
      <span class="material-symbols-rounded">close</span>
    </button>
    {#if photos.length > 1}
      <button class="lb-nav lb-prev" on:click|stopPropagation={lightboxPrev}
        disabled={lightboxIndex === 0} aria-label="Previous photo">
        <span class="material-symbols-rounded">chevron_left</span>
      </button>
      <button class="lb-nav lb-next" on:click|stopPropagation={lightboxNext}
        disabled={lightboxIndex === photos.length - 1} aria-label="Next photo">
        <span class="material-symbols-rounded">chevron_right</span>
      </button>
      <div class="lb-counter">{lightboxIndex + 1} / {photos.length}</div>
    {/if}
    <img class="lb-img" src={resolveAssetUrl(photos[lightboxIndex])} alt="" on:click|stopPropagation />
  </div>
{/if}

<style>
  .cl-backdrop {
    position: fixed; inset: 0;
    background: var(--overlay, rgba(0, 0, 0, 0.55));
    backdrop-filter: var(--backdrop-blur, blur(8px));
    -webkit-backdrop-filter: blur(8px);
    z-index: 130;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .cl-box {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 480px;
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
  }
  .cl-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    padding: 16px 16px 12px;
    border-bottom: 1px solid var(--border);
  }
  .cl-title {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    color: var(--text-1);
    line-height: 1.2;
    flex: 1;
  }
  .cl-subtitle {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-3);
    margin-top: 4px;
  }
  .icon-btn {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    padding: 4px;
    border-radius: var(--radius-sm);
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .icon-btn:hover { color: var(--error, #f87171); background: color-mix(in srgb, var(--error, #ef4444) 12%, transparent); }
  .icon-btn .material-symbols-rounded { font-size: 22px; }

  .cl-body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .cl-field { display: flex; flex-direction: column; gap: 6px; }
  .cl-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .cl-hint { font-weight: 400; color: var(--text-3); font-size: 12px; }

  /* Meal-type chip row — 4 small toggles (breakfast/lunch/dinner/
     snack). Active chip flips to the accent fill. */
  .meal-chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .meal-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full, 99px);
    color: var(--text-2);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .meal-chip:hover { color: var(--text-1); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .meal-chip.active {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent);
  }
  .meal-chip .material-symbols-rounded { font-size: 14px; }

  /* Per-cook rating — 5 tappable stars + a small clear button when
     a rating is set. Distinct from the recipe's overall rating
     ("how did THIS cook turn out?"). */
  .rating-row {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .rating-star {
    background: transparent;
    border: 0;
    cursor: pointer;
    padding: 2px;
    color: var(--text-3);
    transition: color var(--dur-fast), transform var(--dur-fast);
  }
  .rating-star:hover { transform: scale(1.1); }
  .rating-star.on { color: var(--accent); }
  .rating-star .material-symbols-rounded { font-size: 24px; }
  .rating-clear {
    background: transparent;
    border: 0;
    color: var(--text-3);
    cursor: pointer;
    padding: 4px;
    margin-left: 6px;
  }
  .rating-clear:hover { color: var(--text-1); }
  .rating-clear .material-symbols-rounded { font-size: 14px; }
  .input {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 9px 12px;
    color: var(--text-1);
    font-size: 14px;
    font-family: inherit;
    box-sizing: border-box;
    width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  textarea.input { resize: vertical; min-height: 60px; }

  .cl-photo {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 10;
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--surface-2);
  }
  .cl-photo img { width: 100%; height: 100%; object-fit: cover; }

  /* Camera / Upload / URL action row — same look as ImagePicker so
     the photo section feels consistent with the recipe + pantry
     editors. Three equal-width transparent buttons, accent-colored. */
  .picker-actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
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
  .action-btn:hover:not(:disabled) { background: var(--accent-dim); }
  .action-btn:disabled { opacity: 0.5; cursor: wait; }
  .action-btn .material-symbols-rounded { font-size: 18px; }

  .url-entry-row {
    display: flex; gap: 6px;
    margin-top: 6px;
  }
  .url-entry-row .input { flex: 1; }
  .url-entry-row .btn {
    height: 38px; padding: 0 14px; font-size: 13px;
    display: inline-flex; align-items: center; justify-content: center;
  }

  /* Photo thumbnails — bigger, clickable to open the lightbox. */
  .photo-strip {
    display: flex; gap: 8px; flex-wrap: wrap;
    margin-top: 10px;
  }
  .photo-thumb {
    position: relative;
    width: 120px; height: 120px;
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--surface-2);
    border: 1px solid var(--border);
    flex-shrink: 0;
    padding: 0;
    cursor: zoom-in;
    transition: border-color var(--dur-fast), transform var(--dur-fast);
  }
  .photo-thumb:hover { border-color: var(--accent); transform: scale(1.02); }
  .photo-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .photo-remove {
    position: absolute;
    top: 4px; right: 4px;
    width: 22px; height: 22px;
    background: rgba(0,0,0,0.6);
    border: none;
    border-radius: 50%;
    color: #fff;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    z-index: 2;
  }
  .photo-remove:hover { background: var(--error, #ef4444); }
  .photo-remove .material-symbols-rounded { font-size: 14px; }

  /* ── Lightbox ─────────────────────────────────────────────────────── */
  .lb-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.92);
    z-index: 200;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
    cursor: zoom-out;
  }
  .lb-img {
    max-width: 100%; max-height: 100%;
    object-fit: contain;
    box-shadow: 0 16px 64px rgba(0,0,0,0.6);
    cursor: default;
  }
  .lb-close {
    position: absolute; top: 16px; right: 16px;
    width: 40px; height: 40px;
    background: rgba(255,255,255,0.12); color: #fff;
    border: none; border-radius: 50%;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(6px);
    z-index: 1;
  }
  .lb-close:hover { background: rgba(255,255,255,0.22); }
  .lb-nav {
    position: absolute; top: 50%; transform: translateY(-50%);
    width: 44px; height: 44px;
    background: rgba(255,255,255,0.12); color: #fff;
    border: none; border-radius: 50%;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(6px);
    z-index: 1;
  }
  .lb-nav:hover:not(:disabled) { background: rgba(255,255,255,0.22); }
  .lb-nav:disabled { opacity: 0.3; cursor: not-allowed; }
  .lb-prev { left: 16px; }
  .lb-next { right: 16px; }
  .lb-nav .material-symbols-rounded { font-size: 28px; }
  .lb-close .material-symbols-rounded { font-size: 22px; }
  .lb-counter {
    position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
    color: rgba(255,255,255,0.85);
    font-size: 13px; font-weight: 600;
    background: rgba(0,0,0,0.5); padding: 4px 12px; border-radius: var(--radius-full, 99px);
  }
  .cl-photo-actions {
    position: absolute;
    bottom: 8px; right: 8px;
    display: flex;
    gap: 6px;
  }
  .cl-photo-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    aspect-ratio: 16 / 10;
    background: var(--surface-2);
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--text-3);
    cursor: pointer;
    font-size: 14px;
    transition: color var(--dur-fast), border-color var(--dur-fast);
  }
  .cl-photo-btn:hover { color: var(--accent); border-color: var(--accent); }
  .cl-photo-btn .material-symbols-rounded { font-size: 28px; }
  .file-input { display: none; }

  .cl-footer {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    padding: 12px 16px 16px;
    border-top: 1px solid var(--border);
  }
  .cl-footer .btn-primary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .cl-footer .btn-primary .material-symbols-rounded { font-size: 18px; }
  .btn.tiny { padding: 6px 10px; font-size: 12px; }
</style>
