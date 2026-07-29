<script>
  /**
   * PantryEditor — full-page editor for a pantry item.
   *
   * Modeled on NutriTrace's FoodEditor: sticky header, stack of
   * editor-cards (Photo / Basic Info / Stock / Category / Nutrition /
   * Notes), each with a small caps title. Replaces the in-page modal
   * that used to live inside Pantry.svelte.
   */
  import { _ } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { push, pop } from 'svelte-spa-router';
  import { fade } from 'svelte/transition';
  import { NtApi } from '../lib/api.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import UnitPicker from '../components/ui/UnitPicker.svelte';
  import ImagePicker from '../components/ui/ImagePicker.svelte';
  import BarcodeScanner from '../components/ui/BarcodeScanner.svelte';
  import Combobox from '../components/ui/Combobox.svelte';
  import DateInput from '../components/ui/DateInput.svelte';
  import { PANTRY_CATEGORIES, categoryLabel } from '../lib/pantry-categories.js';
  import { NUTRIMENTS, isDerived, deriveSodiumSalt } from '../lib/nutriments.js';
  import { lookupCommonDensity } from '../lib/recipe-nutrition.js';
  import { lookupBarcode, contributeToOFF } from '../lib/off.js';
  import { offEnabled, offUsername, offPassword, offUploadCountry } from '../stores/settings.js';
  import { DB } from '../lib/db.js';
  import { isNative } from '../lib/platform.js';

  export let params = {};

  $: id = params.id ? parseInt(params.id, 10) : null;
  $: isEdit = Number.isFinite(id);

  let item = _blank();
  let loading = isEdit;
  let saving = false;
  let imgUploading = false;
  let showAllNutrients = false;
  // DB-backed pantry categories. Falls back to PANTRY_CATEGORIES (the
  // hardcoded list) if the API hasn't responded yet — keeps the picker
  // useful instead of empty during the initial async load.
  let pantryCategories = [];
  let categoryName = '';
  let comboCategoryRef;
  let categoryNewOpen = false;
  let categoryNewName = '';
  let categoryNewIcon = 'kitchen';

  // Curated subset shown by default — matches NT's "core 12" pattern.
  $: visibleNutriments = showAllNutrients
    ? NUTRIMENTS
    : NUTRIMENTS.filter(n => n.default).slice(0, 12);

  function _blank() {
    return {
      name: '', brand: '', barcode: '',
      in_stock: true, quantity: '', unit: '',
      serving_size: '', serving_unit: 'g',
      g_per_cup: '',
      notes: '', img_url: '',
      category: '',
      category_id: null,
      nutrition: {},
    };
  }

  // Pull a density from the built-in table based on the item name.
  // Quick win for the most common cooking ingredients (flour, sugar,
  // oil, butter, etc.). For weirder items the user can ask Trace.
  function lookupDensity() {
    const dens = lookupCommonDensity(item.name);
    if (dens) {
      item.g_per_cup = dens;
      showSuccess(`Set ${dens} g/cup for ${item.name}`);
    } else {
      showError(`No built-in density for "${item.name}". Ask Trace: "set the density of ${item.name}".`);
    }
  }

  async function _loadPantryCategories() {
    try { pantryCategories = await NtApi.getPantryCategories(); }
    catch { pantryCategories = []; }
  }
  // Refresh categoryName whenever item.category_id or pantryCategories
  // changes — keeps the combobox display in sync after async loads.
  $: {
    if (item?.category_id != null) {
      const c = pantryCategories.find(x => x.id === item.category_id);
      categoryName = c?.name || '';
    } else if (item?.category) {
      const c = pantryCategories.find(x => x.slug === item.category);
      categoryName = c?.name || categoryLabel(item.category);
    } else {
      categoryName = '';
    }
  }
  function onPantryCategorySelect(e) {
    const opt = e.detail;
    const match = pantryCategories.find(c => c.name.toLowerCase() === (opt?.name || '').toLowerCase());
    if (match) {
      item.category_id = match.id;
      item.category = match.slug;
      item = item;
    }
  }
  function openNewPantryCategoryDialog(e) {
    categoryNewName = (e?.detail || '').trim();
    categoryNewIcon = 'kitchen';
    categoryNewOpen = true;
  }
  async function confirmNewPantryCategory() {
    const name = categoryNewName.trim();
    if (!name) return;
    try {
      const c = await NtApi.createPantryCategory({ name, icon: categoryNewIcon });
      pantryCategories = [...pantryCategories, c];
      item.category_id = c.id;
      item.category = c.slug;
      item = item;
      comboCategoryRef?.acceptCreated(c.name);
      categoryNewOpen = false;
    } catch (err) {
      showError(err.message || 'Could not create category');
    }
  }

  // ── Barcode scanner + OFF state ────────────────────────────────────────
  let editorScannerOpen = false;
  let downloading       = false;
  let downloadSuccess   = false;
  let contributing      = false;
  let offSuccess        = false;
  let offVerified       = null;  // null = unchecked, true = confirmed, false = not found yet
  // OFF presence check for the barcode, drives the Share vs View button
  // label (mirrors NutriTrace FoodEditor). null = not yet checked,
  // true = product is in OFF (button is "View on OFF"), false = not in
  // OFF (button is "Share to OFF").
  let offProductExists  = null;
  let _lastCheckedBarcode = null;
  let duplicateOf       = null;
  // Linked-scaling: when on, changing serving_size scales every nutrient
  // value proportionally (matches NT's link icon next to Unit). Default
  // unlinked so a user adjusting just the serving doesn't accidentally
  // rewrite their nutrients.
  let linked = false;
  let _lastServingSize = null;

  function onScan(e) {
    const code = e?.detail?.code || e?.detail || '';
    const trimmed = String(code).trim();
    if (!trimmed) return;
    item.barcode = trimmed;
    editorScannerOpen = false;
    // Auto-fetch from OFF after scanning, just like NT.
    if ($offEnabled) downloadFromOFF();
  }

  async function downloadFromOFF() {
    if (!item.barcode) { showError($_('pantry_editor_ct.toast.enter_barcode')); return; }
    downloading = true;
    downloadSuccess = false;
    try {
      const result = await lookupBarcode(item.barcode);
      if (!result) {
        showError($_('pantry_editor_ct.toast.not_found_off'));
        return;
      }
      // Don't blow away an existing name the user typed deliberately.
      if (!item.name) item.name = result.name || '';
      if (!item.brand) item.brand = result.brand || '';
      item.serving_size = result.serving_size ?? item.serving_size;
      item.serving_unit = result.serving_unit || item.serving_unit;
      item.nutrition = deriveSodiumSalt({ ...(item.nutrition || {}), ...(result.nutrition || {}) });
      if (result.img_url && !item.img_url) item.img_url = result.img_url;
      _lastServingSize = item.serving_size;
      downloadSuccess = true;
      setTimeout(() => downloadSuccess = false, 2000);
    } catch (e) {
      showError(e.message || 'OFF lookup failed');
    } finally {
      downloading = false;
    }
  }

  // Smart OFF action button — mirrors NutriTrace's pattern. When the
  // product is already on OFF the button opens the product page in a
  // new tab / system browser; otherwise it uploads the local row.
  async function _refreshOffPresence() {
    if (!item.barcode) { offProductExists = null; return; }
    if (_lastCheckedBarcode === item.barcode) return;
    _lastCheckedBarcode = item.barcode;
    try {
      const existing = await lookupBarcode(item.barcode);
      offProductExists = !!existing;
    } catch {
      // Network failure shouldn't lock the button — treat as "unknown,
      // assume not in OFF" so the Share path stays reachable.
      offProductExists = false;
    }
  }
  $: if (item?.barcode && item.barcode !== _lastCheckedBarcode) _refreshOffPresence();

  async function _openOffPage() {
    const url = 'https://world.openfoodfacts.org/product/' + encodeURIComponent(item.barcode);
    try {
      if (isNative) {
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url });
      } else {
        window.open(url, '_blank', 'noopener');
      }
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  }

  async function shareOrViewOnOFF() {
    if (!item.barcode) { showError($_('pantry_editor_ct.toast.add_barcode')); return; }
    if (offProductExists) { await _openOffPage(); return; }
    if (!item.name) { showError($_('pantry_editor_ct.toast.add_name')); return; }
    contributing = true;
    offSuccess = false;
    offVerified = null;
    try {
      // Final pre-flight lookup in case the local cached state is stale
      // (someone else may have contributed the product after we last checked).
      const existing = await lookupBarcode(item.barcode);
      if (existing) {
        offProductExists = true;
        contributing = false;
        await _openOffPage();
        return;
      }
      await contributeToOFF(item, {
        offUsername: $offUsername,
        offPassword: $offPassword,
        offUploadCountry: $offUploadCountry,
      });
      offSuccess = true;
      offProductExists = true; // we just contributed it, mark as present
      setTimeout(() => offSuccess = false, 3000);
      // Give OFF a few seconds to index, then verify the product is live.
      setTimeout(async () => {
        try {
          const found = await lookupBarcode(item.barcode);
          offVerified = !!found;
        } catch { offVerified = false; }
      }, 3000);
    } catch (e) {
      showError(e.message || 'Share to OFF failed');
    } finally {
      contributing = false;
    }
  }

  // Linked-scaling: scale every numeric nutriment when serving size
  // changes. Triggered by an `on:input` on the serving-size field.
  function onServingSizeInput() {
    if (!linked || _lastServingSize == null) {
      _lastServingSize = Number(item.serving_size) || null;
      return;
    }
    const next = Number(item.serving_size);
    if (!Number.isFinite(next) || next <= 0 || _lastServingSize <= 0) {
      _lastServingSize = next || _lastServingSize;
      return;
    }
    const ratio = next / _lastServingSize;
    if (!Number.isFinite(ratio) || ratio === 1) { _lastServingSize = next; return; }
    // Deep-copy `_derived` so the scaled object doesn't share state.
    const prev = item.nutrition || {};
    const scaled = { ...prev, _derived: { ...(prev._derived || {}) } };
    for (const [k, v] of Object.entries(scaled)) {
      if (k === '_derived') continue;
      if (typeof v === 'number' && Number.isFinite(v)) {
        scaled[k] = Math.round(v * ratio * 100) / 100;
      }
    }
    // Force salt to re-derive from the scaled sodium so we don't get
    // independent rounding drift between the two (scaling rounds to
    // 2 decimals; derive rounds salt to 3). When the user originally
    // entered salt as the source, do the inverse — drop sodium and
    // let derive recompute it.
    if (Number(scaled.sodium) > 0 && !scaled._derived.sodium) {
      delete scaled.salt;
      delete scaled._derived.salt;
    } else if (Number(scaled.salt) > 0 && !scaled._derived.salt) {
      delete scaled.sodium;
      delete scaled._derived.sodium;
    }
    item = { ...item, nutrition: deriveSodiumSalt(scaled) };
    _lastServingSize = next;
  }

  async function load() {
    if (!isEdit) {
      // New item — pull any prefill stashed by Pantry.svelte's
      // barcode-scan flow (`ct:pantry-prefill`).
      try {
        const raw = sessionStorage.getItem('ct:pantry-prefill');
        if (raw) {
          sessionStorage.removeItem('ct:pantry-prefill');
          const prefill = JSON.parse(raw) || {};
          item = {
            ..._blank(),
            ...prefill,
            nutrition: prefill.nutrition && typeof prefill.nutrition === 'object'
              ? { ...prefill.nutrition }
              : {},
          };
          _lastServingSize = Number(item.serving_size) || null;
        }
      } catch {}
      loading = false;
      return;
    }
    loading = true;
    try {
      const row = await NtApi.getPantryItem(id);
      item = {
        ..._blank(),
        ...row,
        brand: row.brand ?? '',
        barcode: row.barcode ?? '',
        quantity: row.quantity ?? '',
        img_url: row.img_url ?? '',
        category: row.category ?? '',
        category_id: row.category_id ?? null,
        serving_size: row.serving_size ?? '',
        serving_unit: row.serving_unit ?? 'g',
        g_per_cup: row.g_per_cup ?? '',
        nutrition: row.nutrition && typeof row.nutrition === 'object' ? { ...row.nutrition } : {},
      };
      _lastServingSize = Number(item.serving_size) || null;
    } catch (e) {
      showError(e.message || 'Could not load pantry item');
      pop();
    } finally {
      loading = false;
    }
  }
  onMount(() => { load(); _loadPantryCategories(); });

  async function save() {
    if (!item.name?.trim()) {
      showError($_('pantry_editor_ct.toast.name_required'));
      return;
    }
    saving = true;
    try {
      // Derive in_stock from quantity for backward-compat with the
      // server schema. Rule: explicit 0 = out of stock, anything else
      // (including untracked null) = in stock. Same rule the UI reads
      // off quantity, so the column always mirrors the truth.
      const qtyNum = item.quantity === '' || item.quantity == null ? null : Number(item.quantity);
      const payload = {
        name: item.name.trim(),
        brand: item.brand?.trim() || null,
        barcode: item.barcode?.toString().trim() || null,
        in_stock: qtyNum === 0 ? 0 : 1,
        quantity: qtyNum,
        unit: item.unit || null,
        notes: item.notes?.trim() || null,
        img_url: item.img_url || null,
        category: item.category || null,
        category_id: item.category_id ?? null,
        serving_size: item.serving_size === '' || item.serving_size == null ? null : Number(item.serving_size),
        serving_unit: item.serving_unit || null,
        serving_label: item.serving_label?.trim() || null,
        g_per_cup:    item.g_per_cup === '' || item.g_per_cup == null ? null : Number(item.g_per_cup),
        nutrition: item.nutrition && Object.keys(item.nutrition).length ? item.nutrition : null,
      };
      if (isEdit) {
        await NtApi.updatePantryItem(id, payload);
        showSuccess($_('pantry_editor_ct.toast.saved'));
      } else {
        await NtApi.createPantryItem(payload);
        showSuccess($_('pantry_editor_ct.toast.added_to_pantry'));
      }
      pop();
    } catch (e) {
      showError(e.message || 'Save failed');
    } finally {
      saving = false;
    }
  }

  async function deleteItem() {
    if (!isEdit) return;
    const ok = await confirmDialog({
      title: 'Remove from pantry?',
      message: `"${item.name}" will be removed. Recipes referencing it stay; this just drops it from your pantry.`,
      confirmText: 'Remove',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.deletePantryItem(id);
      showSuccess($_('pantry_editor_ct.toast.removed'));
      pop();
    } catch (e) {
      showError(e.message || 'Delete failed');
    }
  }

  function setNutrient(key, value) {
    // Deep-copy `_derived` so we don't accidentally mutate the
    // existing item.nutrition._derived through a shared reference.
    const prev = item.nutrition || {};
    const next = { ...prev, _derived: { ...(prev._derived || {}) } };
    if (value === '' || value == null) delete next[key];
    else next[key] = Number(value);
    if (key === 'sodium' || key === 'salt') {
      const other = key === 'sodium' ? 'salt' : 'sodium';
      // Last-edited-wins. The side the user just typed in is the
      // source of truth; the OTHER side becomes a fresh derivation
      // every keystroke. Drop the previous mirror value and its
      // derived-flag so deriveSodiumSalt re-fires from the new
      // input. The derived-flag also moves to the OTHER side so the
      // calculator badge follows the recomputed quantity.
      delete next._derived[key];
      delete next[other];
      delete next._derived[other];
    }
    // Live-derive so the user sees the calculator badge appear on the
    // OTHER field as soon as they type into one. Server re-runs the
    // same derivation on save so the values stay consistent.
    // Reassigning `item` (not just item.nutrition) guarantees Svelte
    // re-renders every nutrient input bound to item.nutrition.*.
    item = { ...item, nutrition: deriveSodiumSalt(next) };
  }
</script>

<div class="page-shell editor-page">
  <header class="editor-header">
    <button class="btn-icon" on:click={pop} aria-label="Back" title="Back">
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    <h2 class="editor-title">{isEdit ? 'Edit Pantry Item' : 'Add Pantry Item'}</h2>
    <button class="btn btn-primary editor-save" on:click={save} disabled={saving || imgUploading}>
      {imgUploading ? 'Uploading…' : saving ? 'Saving…' : 'Save'}
    </button>
  </header>

  <div class="page-content editor-content">
    {#if loading}
      <div class="state" in:fade={{ duration: 120 }}>
        <span class="material-symbols-rounded spin">progress_activity</span>
      </div>
    {:else}
      <!-- Photo — capped + centered (no `expand`) so the preview is a
           tasteful ~360–420px square instead of stretching to the full
           editor-card width. Mirrors NT FoodEditor's photo card. -->
      <div class="card editor-card">
        <div class="editor-card-title">{$_('pantry_editor_ct.photo')}</div>
        <ImagePicker bind:value={item.img_url} bind:uploading={imgUploading}
          aspect="1 / 1" placeholder="" />
      </div>

      <!-- Basic info — same field order + interactions as NT FoodEditor:
           Name → Brand → Serving size + Unit (with linked-scaling toggle)
           → Barcode (with inline scan icon) → Share / Refresh from OFF. -->
      <div class="card editor-card">
        <div class="editor-card-title">{$_('pantry_editor_ct.basic_info')}</div>
        <div class="form-group">
          <label class="form-label">Name *</label>
          <input class="input" type="text" placeholder="All-purpose flour" bind:value={item.name} />
        </div>
        <div class="form-group">
          <label class="form-label">{$_('pantry_editor_ct.brand')}</label>
          <input class="input" type="text" placeholder="e.g. King Arthur" bind:value={item.brand} />
        </div>
        <div class="form-row" style="align-items:flex-end">
          <div class="form-group" style="flex:1">
            <label class="form-label">{$_('pantry_editor_ct.serving_size')}</label>
            <input class="input" type="number" min="0" step="0.01" placeholder="100"
              bind:value={item.serving_size} on:input={onServingSizeInput} />
          </div>
          <div class="form-group" style="width:120px">
            <label class="form-label">{$_('pantry_editor_ct.unit')}</label>
            <UnitPicker bind:value={item.serving_unit} />
          </div>
          <button type="button" class="btn-icon link-btn" class:linked
            title={linked
              ? 'Linked: changing serving size scales every nutrient proportionally'
              : 'Unlinked: nutrient values stay put when you change serving size'}
            aria-label="Toggle proportional scaling"
            on:click={() => linked = !linked}>
            <span class="material-symbols-rounded" style="font-size:20px">{linked ? 'link' : 'link_off'}</span>
          </button>
        </div>

        <!-- Density (g per cup). Optional. Lets the recipe nutrition
             auto-calc bridge volume↔weight ("1 cup flour" → grams).
             "Look it up" pulls from a built-in table covering the most
             common cooking ingredients. Trace can also set this via
             the set_pantry_density tool. -->
        <div class="form-row" style="align-items:flex-end">
          <div class="form-group" style="flex:1">
            <label class="form-label">
              Density <span class="field-hint">(g per cup, optional)</span>
            </label>
            <input class="input" type="number" min="0" step="1" placeholder="e.g. 120 for flour"
              bind:value={item.g_per_cup} />
          </div>
          <button type="button" class="btn btn-secondary" style="height:38px"
            on:click={lookupDensity}
            disabled={!item.name?.trim()}
            title="Fill from the built-in density table">
            <span class="material-symbols-rounded" style="font-size:16px;vertical-align:middle;margin-right:3px">auto_awesome</span>
            Look it up
          </button>
        </div>
        <div class="form-group">
          <label class="form-label">{$_('pantry_editor_ct.barcode')}</label>
          <div class="barcode-input-wrap">
            <input class="input barcode-input" type="text" inputmode="numeric"
              placeholder={$_('pantry_editor_ct.optional_ph')} bind:value={item.barcode} />
            <button type="button" class="barcode-scan-inline" aria-label="Scan barcode" title="Scan barcode"
              on:click={() => editorScannerOpen = true}>
              <span class="material-symbols-rounded">barcode_scanner</span>
            </button>
          </div>
          {#if $offEnabled && item.barcode}
            <div class="form-row" style="gap:8px;margin-top:8px">
              <button class="btn btn-secondary" style="flex:1"
                on:click={shareOrViewOnOFF} disabled={contributing}
                title={offProductExists ? 'Open this product on Open Food Facts' : !item.name ? 'Name required' : 'Submit this item to OFF (requires OFF account in Settings)'}>
                <span class="material-symbols-rounded" style="font-size:15px;vertical-align:middle;margin-right:4px">
                  {offProductExists ? 'open_in_new' : 'upload'}
                </span>
                {contributing ? 'Uploading…' : offSuccess ? 'Submitted!' : offProductExists ? 'View on OFF' : 'Share to OFF'}
              </button>
              <button class="btn btn-secondary" style="flex:1" on:click={downloadFromOFF}
                disabled={downloading}
                title="Pull data from Open Food Facts">
                <span class="material-symbols-rounded" style="font-size:15px;vertical-align:middle;margin-right:4px">download</span>
                {downloading ? 'Loading…' : downloadSuccess ? 'Updated!' : 'Refresh from OFF'}
              </button>
            </div>
            {#if offSuccess}
              <div class="off-verify-row">
                {#if offVerified === null}
                  <span class="off-verify-checking">
                    <span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle">hourglass_top</span>
                    Verifying on Open Food Facts…
                  </span>
                {:else if offVerified}
                  <span class="off-verify-ok">
                    <span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle">check_circle</span>
                    Confirmed live on Open Food Facts
                  </span>
                {:else}
                  <span class="off-verify-pending">
                    <span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle">schedule</span>
                    Submitted, may take a few minutes to appear
                  </span>
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      </div>

      <!-- Inventory — pantry-specific. NT food items don't have this. -->
      <div class="card editor-card">
        <div class="editor-card-title">{$_('pantry_editor_ct.inventory')}</div>
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <label class="form-label">{$_('pantry_editor_ct.on_hand')}</label>
            <input class="input" type="number" min="0" step="0.01" placeholder="0" bind:value={item.quantity} />
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label">{$_('pantry_editor_ct.unit')}</label>
            <UnitPicker bind:value={item.unit} />
          </div>
        </div>
        <!-- In Stock is no longer a separate field. Stock state is
             derived from quantity: 0 = out of stock; null or > 0 = in
             stock. The null case covers items you keep but never count
             (salt, oil). The recipe-card "X / Y in pantry" pill reads
             the same derived rule. -->
      </div>

      <!-- Category — DB-backed catalog with type-to-filter + inline create. -->
      <div class="card editor-card">
        <div class="editor-card-title">{$_('pantry_editor_ct.category')}</div>
        <Combobox
          bind:this={comboCategoryRef}
          mode="single"
          value={categoryName}
          options={pantryCategories.map(c => ({ name: c.name, icon: c.icon, color: c.color }))}
          placeholder="Pick or create a category…"
          creatable={true}
          createLabel="Create category"
          on:select={onPantryCategorySelect}
          on:create={openNewPantryCategoryDialog}
          on:change={(e) => {
            if (!e.detail) { item.category_id = null; item.category = ''; item = item; }
          }}
        />
        <p class="field-hint" style="margin-top:6px">Manage the full list in Manage &rarr; Pantry Categories.</p>
      </div>

      <!-- Notes — kept above Nutrition so the field order matches NT
           FoodEditor (Photo / Basic info / Categories / Notes / Nutrition). -->
      <div class="card editor-card">
        <div class="editor-card-title">{$_('pantry_editor_ct.notes')}</div>
        <textarea class="input textarea" rows="3" placeholder="Where you keep it, expiration, anything else…"
          bind:value={item.notes}></textarea>
      </div>

      <!-- Nutrition — per-serving values use the Serving size + unit
           entered in Basic info above. Sodium ↔ salt auto-derives. -->
      <div class="card editor-card">
        <div class="editor-card-title">{$_('pantry_editor_ct.nutrition')}</div>
        <p class="card-hint">Values are per the Serving size set in Basic info. Filling these in unlocks recipe nutrition auto-calc, but they're useful on their own too.</p>
        {#each visibleNutriments as n (n.id)}
          {@const derived = (n.id === 'sodium' || n.id === 'salt') && isDerived(item.nutrition, n.id)}
          <div class="form-group" class:nutrient-sub={n.subOf}>
            <label class="form-label">
              {n.label} ({n.unit || '—'})
              {#if derived}
                <span class="material-symbols-rounded derived-badge"
                  title={n.id === 'sodium'
                    ? 'Auto-calculated from salt (× 400 mg/g)'
                    : 'Auto-calculated from sodium (÷ 400)'}>calculate</span>
              {/if}
            </label>
            <input class="input"
              type="number" min="0" step={n.unit === 'g' || n.unit === 'mg' ? '0.1' : 'any'}
              placeholder="0"
              value={item.nutrition?.[n.id] ?? ''}
              on:input={(e) => setNutrient(n.id, e.target.value)} />
          </div>
        {/each}
        <button class="btn btn-ghost w-full" on:click={() => showAllNutrients = !showAllNutrients}>
          {showAllNutrients ? 'Show Less' : 'Show All Nutrients'}
        </button>
      </div>

      {#if isEdit}
        <div class="card editor-card danger-card">
          <div class="editor-card-title danger">{$_('pantry_editor_ct.danger_zone')}</div>
          <button class="btn btn-secondary danger-btn" on:click={deleteItem}>
            <span class="material-symbols-rounded">delete</span>
            Remove from Pantry
          </button>
        </div>
      {/if}

      <div style="height:24px"></div>
    {/if}
  </div>
</div>

<!-- Inline barcode scanner — fired by the scan icon next to the
     Barcode field. Mirrors NT FoodEditor's scanner mount. -->
<BarcodeScanner bind:open={editorScannerOpen} on:scan={onScan} on:close={() => editorScannerOpen = false} />

{#if categoryNewOpen}
  <div class="cat-modal-backdrop" on:click={() => categoryNewOpen = false}>
    <div class="cat-modal" on:click|stopPropagation>
      <h3 class="cat-modal-title">{$_('pantry_editor_ct.cat_modal_title')}</h3>
      <label class="field">
        <span class="field-label">{$_('pantry_editor_ct.name')}</span>
        <input class="input" type="text" bind:value={categoryNewName} autofocus />
      </label>
      <label class="field">
        <span class="field-label">{$_('pantry_editor_ct.icon_name')} <span class="field-hint">{$_('pantry_editor_ct.icon_hint')}</span></span>
        <input class="input" type="text" bind:value={categoryNewIcon} placeholder="kitchen" />
      </label>
      <div class="cat-modal-actions">
        <button class="btn btn-secondary" on:click={() => categoryNewOpen = false}>{$_('pantry_editor_ct.cancel')}</button>
        <button class="btn btn-primary" on:click={confirmNewPantryCategory} disabled={!categoryNewName.trim()}>{$_('pantry_editor_ct.create')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .editor-page {
    padding-top: 0;
    position: fixed;
    inset: 0;
    overflow-y: auto;
    z-index: 30;
    background: var(--bg, var(--surface-1));
  }
  .editor-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: calc(var(--safe-top) + 12px) 16px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .editor-title { font-size: 17px; font-weight: 600; flex: 1; color: var(--text-1); margin: 0; }
  .editor-save { height: 36px; padding: 0 16px; font-size: 13px; }

  /* Match NT FoodEditor: stretch to full viewport width with the
     standard --page-px gutter — the editor cards (and the photo /
     basic-info rows inside them) span the page rather than sitting in
     a 760-wide column. */
  .editor-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px var(--page-px) 32px;
    width: 100%;
    box-sizing: border-box;
  }

  .card.editor-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  /* OFF verification status row, shown briefly after a Share submit. */
  .off-verify-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; font-size: 12px; padding: 6px 2px 0;
  }
  .off-verify-checking { color: var(--text-3); }
  .off-verify-ok { color: var(--success, #4caf50); }
  .off-verify-pending { color: var(--text-3); }
  .editor-card-title {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
    margin-bottom: 4px;
  }
  .editor-card-title.danger { color: var(--error, #f87171); }
  .danger-card { border-color: color-mix(in srgb, var(--error, #ef4444) 30%, transparent); }
  .danger-btn { color: var(--error, #f87171); justify-content: center; }
  .danger-btn .material-symbols-rounded { margin-right: 6px; }

  .card-hint { font-size: 12px; color: var(--text-3); margin: 0; line-height: 1.5; }

  .form-row { display: flex; gap: 12px; }
  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
  }
  .form-hint { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--text-3); font-size: 11px; }

  .input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px;
    color: var(--text-1); font-size: 14px; font-family: inherit;
    width: 100%; box-sizing: border-box;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .textarea { resize: vertical; min-height: 60px; }

  .check-row {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 6px 0;
    cursor: pointer;
  }
  .check-row input[type="checkbox"] {
    margin-top: 3px; width: 18px; height: 18px;
    accent-color: var(--accent);
    flex-shrink: 0;
  }
  .check-label { display: block; font-size: 14px; font-weight: 500; color: var(--text-1); }
  .check-desc { display: block; font-size: 12px; color: var(--text-3); margin-top: 2px; line-height: 1.4; }

  .cat-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 6px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full, 99px);
    color: var(--text-2);
    font-size: 13px; font-weight: 600;
    cursor: pointer;
    transition: all var(--dur-fast);
  }
  .chip:hover { border-color: var(--accent); color: var(--text-1); }
  .chip.accent {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .chip .material-symbols-rounded { font-size: 14px; }

  /* NT pattern: nutrient rows stack vertically. Sub-nutrients (e.g.
     Saturated fat under Total fat) get a small indent + lighter label. */
  .nutrient-sub { padding-left: 12px; }
  .nutrient-sub .form-label { color: var(--text-3); font-weight: 500; }

  /* Barcode field — scan button absolutely positioned inside the input
     wrapper, mirroring NT FoodEditor. */
  .barcode-input-wrap { position: relative; display: flex; align-items: center; }
  .barcode-input { flex: 1; width: 100%; padding-right: 38px; }
  .barcode-scan-inline {
    position: absolute; right: 6px;
    background: none; border: none; cursor: pointer;
    color: var(--text-3); padding: 4px;
    display: flex; align-items: center;
  }
  .barcode-scan-inline:hover { color: var(--accent); }
  .barcode-scan-inline .material-symbols-rounded { font-size: 20px; }

  /* Linked-scaling toggle next to Unit. Same shape as the global
     .btn-icon (40×40, surface-2 background, 1px border) so it sits
     visually next to the Unit input — matches NT FoodEditor exactly. */
  .link-btn { color: var(--text-3); margin-bottom: 2px; }
  .link-btn.linked { color: var(--accent); }
  /* Calculator-icon badge next to an auto-derived nutrient label
     (sodium ↔ salt). Matches the NT FoodEditor styling. */
  .derived-badge {
    font-size: 13px; color: var(--text-3);
    vertical-align: middle; margin-left: 4px;
  }

  .btn-ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-2);
  }
  .btn-ghost:hover { color: var(--text-1); border-color: var(--accent); }
  .w-full { width: 100%; }

  .state {
    display: flex; align-items: center; justify-content: center;
    padding: 80px 16px;
  }
  .spin {
    font-size: 32px; color: var(--accent);
    animation: spin 1.2s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Standard btn for the Save action — relies on global .btn / .btn-primary */
  .btn-icon {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3); width: 40px; height: 40px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm);
  }
  .btn-icon:hover { background: var(--surface-2); color: var(--text-1); }
  .btn-icon .material-symbols-rounded { font-size: 22px; }

  /* New pantry category dialog. */
  .cat-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1200;
    padding: 16px;
  }
  .cat-modal {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    width: 100%;
    max-width: 420px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .cat-modal-title {
    margin: 0;
    font-size: 17px;
    font-weight: 700;
    color: var(--text-1);
  }
  .cat-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
</style>
