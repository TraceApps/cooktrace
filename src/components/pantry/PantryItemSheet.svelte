<script>
  import { failed } from '../../lib/messages.js';
  /**
   * PantryItemSheet — slide-up bottom sheet for a single pantry item.
   *
   * The single editing surface for pantry items in v1.0. Three modes:
   *   - View      (itemId set, editing=false): two-column grid (photo +
   *               identity left, stats + nutrition right). Stock pill
   *               derives from quantity. Qty +/- quick actions. Edit
   *               + Delete in footer.
   *   - Edit      (itemId set, editing=true): SAME two-column grid;
   *               every read-mode field flips to its editable input
   *               in place, no surface change. Linked-scaling toggle
   *               next to the Edit All Nutrients link, Smart OFF
   *               buttons + Verify row under Barcode, and the
   *               "Edit All Nutrients" sub-sheet for the full catalog.
   *   - Create    (itemId === null): same as Edit mode but builds a
   *               blank item with optional `prefill` (used by the
   *               barcode-scan flow for an unrecognized code).
   *
   * In Stock comes from `isItemInStock` (src/lib/pantry-variants.js), the
   * same read the pantry card and its check button use, so the three
   * always agree. It trusts the `in_stock` column when present and falls
   * back to `quantity` only for a row that has none. A blank quantity is
   * NOT zero: reading it as zero is what left the card's check stuck on
   * (issue #55).
   *
   * Caller usage:
   *   <PantryItemSheet bind:open itemId={...}
   *     startInEdit={false} prefill={null}
   *     on:changed={e => ...} on:deleted={e => ...} on:created={e => ...} />
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { _, locale } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import DateInput from '../ui/DateInput.svelte';
  import ImagePicker from '../ui/ImagePicker.svelte';
  import UnitPicker from '../ui/UnitPicker.svelte';
  import BarcodeScanner from '../ui/BarcodeScanner.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import { NtApi } from '../../lib/api.js';
  import { resolveAssetUrl, isNative } from '../../lib/platform.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import NutritionFactsBox from '../recipe/NutritionFactsBox.svelte';
  import { categoryLabel, categoryIcon } from '../../lib/pantry-categories.js';
  import { NUTRIMENTS, DEFAULT_VISIBLE_NUTRIMENT_IDS, isDerived, deriveSodiumSalt } from '../../lib/nutriments.js';
  import { lookupBarcode, contributeToOFF, offShareMessage } from '../../lib/off.js';
  import OffAccountInline from './OffAccountInline.svelte';
  import { displayVariantName as _sharedDisplayVariantName, isItemInStock, stockAfterToggle, stockAfterStep } from '../../lib/pantry-variants.js';
  import { isOfflineError } from '../../lib/offline-edits.js';
  import { foldText } from '../../lib/search-text.js';
  import { lookupForRefresh as usdaLookupForRefresh, usdaFdcId } from '../../lib/usda.js';
  import { offlineState } from '../../lib/offline-api.js';
  import { visibleNutriments, offEnabled, usdaEnabled, usdaApiKey, offUsername, offPassword, offUploadCountry, aiEffectivelyEnabled, envLocks } from '../../stores/settings.js';
  import { scanNutritionLabel } from '../../lib/scan-nutrition.js';
  import PantryAllergens from './PantryAllergens.svelte';
  import { household } from '../../stores/settings.js';
  import { cleanHousehold } from '../../lib/allergens.js';

  export let open = false;
  export let itemId = null;
  export let startInEdit = false;
  export let prefill = null;
  // 'used-in': open on the Used In list (the card's pill, or back from one
  // of those recipes).
  export let focus = null;

  const dispatch = createEventDispatcher();

  let item = null;
  let draft = null;
  let loading = false;
  let loadError = null;
  let editing = false;
  let saving = false;
  let imgUploading = false;

  // Edit-only state
  let linked = false;
  let _lastServingSize = null;
  let allNutrientsOpen = false;
  let editorScannerOpen = false;

  // AI label scan — mirrors NutriTrace's FoodEditor scan-label flow.
  // Native uses @capacitor/camera; web falls back to the hidden file
  // input below. Sits next to the barcode scanner as a complementary
  // action: barcode → OFF lookup (name-brand products), label → AI
  // vision (store-brand jars, homemade batches, imports with stale
  // OFF data). Gated on $aiEffectivelyEnabled so the button hides
  // when AI isn't configured.
  let scanningLabel = false;
  let scanLabelFileInput;

  async function scanLabel() {
    if (scanningLabel || !draft) return;
    scanningLabel = true;
    try {
      const parsed = await scanNutritionLabel({
        fileInput: scanLabelFileInput,
        aiProxy: !!$envLocks.ai,
      });
      if (parsed == null) return; // user canceled
      if (typeof parsed !== 'object') {
        showError($_('pantry_sheet_extra.toast.cant_read_label'));
        return;
      }
      // Overwrite (not smart-fill) — the label is the source of truth
      // in this moment. Matches NT's semantics; distinct from an OFF
      // refresh which smart-fills because OFF data can be stale.
      if (typeof parsed.name === 'string' && parsed.name.trim()) draft.name = parsed.name.trim();
      if (typeof parsed.brand === 'string' && parsed.brand.trim()) draft.brand = parsed.brand.trim();
      // NT calls it portion + unit; CookTrace pantry calls it
      // serving_size + serving_unit. Same concept, mapped here.
      if (parsed.portion != null && !isNaN(parseFloat(parsed.portion))) {
        draft.serving_size = parseFloat(parsed.portion);
        _lastServingSize = draft.serving_size;
      }
      if (typeof parsed.unit === 'string' && parsed.unit.trim()) draft.serving_unit = parsed.unit.trim();
      // Nutriment values overwrite whatever's in the draft. Any key we
      // don't recognize is silently dropped (matches NT).
      if (!draft.nutrition || typeof draft.nutrition !== 'object') draft.nutrition = {};
      for (const n of NUTRIMENTS) {
        const v = parsed[n.id];
        if (v != null && !isNaN(parseFloat(v))) draft.nutrition[n.id] = parseFloat(v);
      }
      draft = { ...draft };
      showSuccess($_('pantry_sheet_extra.toast.nutrition_extracted'));
    } catch (e) {
      showError(failed('pantry_sheet_extra.toast.scan_failed', e));
    } finally {
      scanningLabel = false;
    }
  }
  let pantryCategories = [];
  let categoryName = '';
  let comboCategoryRef;
  let categoryNewOpen = false;
  let categoryNewName = '';
  let categoryNewIcon = 'kitchen';

  // Variant state (Issue #4). variantContext is loaded after the main
  // item loads; carries the parent's name (when this item is a variant),
  // the children list (when this item is a generic), and the candidate
  // pool for the "Make this a variant of..." picker.
  let variantContext = { parentName: null, children: [], candidates: [] };
  let variantPickerOpen = false;
  let variantPickerMode = null;   // 'set-parent' | 'add-existing-child'
  let variantPickerQuery = '';
  // Brand-first variant creation: most variants differ by brand or store
  // (GreenWise vs Publix), so the inline form asks for that. A small
  // "Use a different name" expander reveals the name field for the
  // rare type-variation case ("Whole Milk" generic with a "2% Milk"
  // variant). The variant inherits the parent's name when no name override.
  let newVariantBrand = '';
  let newVariantName = '';
  let newVariantNameOverride = false;
  let addingVariantRow = false;
  // Variant-aware delete dialog state. When the user hits delete on a
  // generic that has variants, we open this dialog instead of the
  // standard yes/no confirm so they can choose whether the variants
  // get promoted to standalone items or removed too.
  let deleteWithVariantsOpen = false;
  let deleteCascade = false;

  // OFF state
  let downloading = false;
  let downloadSuccess = false;
  let refreshSource = 'off';  // which Refresh button the state above belongs to
  let nutritionRev = 0;       // bumped when a refresh replaces the nutrition
  let contributing = false;
  let offSuccess = false;
  // No Open Food Facts login: ask for it here, without leaving (TraceApps/nutritrace#284).
  let offNeedsAccount = false;
  let offPhotoFailed = false;
  let offVerified = null;
  let offProductExists = null;
  let _lastCheckedBarcode = null;

  function _blank() {
    return {
      name: '', brand: '', barcode: '',
      in_stock: 1, quantity: '', unit: '',
      serving_size: '', serving_unit: 'g',
      notes: '', img_url: '',
      category: '', category_id: null,
      nutrition: {},
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────
  $: if (open && itemId == null) _enterCreateMode();
  $: if (open && itemId != null) _enterViewOrEditMode(itemId, startInEdit);
  $: if (!open) _reset();

  async function _enterViewOrEditMode(id, asEdit) {
    if (item && item.id === id) {
      if (asEdit && !editing) _startEdit();
      return;
    }
    loading = true; loadError = null; item = null;
    _openedAt = Date.now();
    try {
      const row = await NtApi.getPantryItem(id);
      item = row;
      if (asEdit) _startEdit();
    } catch (e) { loadError = e.message || $_('fail.load_item'); }
    finally { loading = false; }
    // Used In first: on the phone each read waits its turn on the database.
    _loadUsedIn(id);
    _loadPantryCategories();
    _loadVariantContext();
  }

  // ── Used In (#60): the recipes that use this item ──────────────────
  // `direct` link to the item itself and match the card's count; `through`
  // reach it through its generic or variants (lib/pantry-usage.js).
  const USED_IN_SHOWN = 6;
  let usedIn = { direct: [], through: [] };
  let usedInState = 'idle';  // 'loading' | 'ready' | 'offline' | 'error'
  let usedInAll = false;
  let usedInEl;
  let usedInFlash = false;
  async function _loadUsedIn(id) {
    usedInState = 'loading';
    usedInAll = false;
    try {
      const got = await NtApi.getPantryItemRecipes(id, { family: true });
      if (item?.id !== id) return;
      usedIn = { direct: got?.direct || [], through: got?.through || [] };
      usedInState = 'ready';
    } catch (e) {
      if (item?.id !== id) return;
      usedIn = { direct: [], through: [] };
      usedInState = isOfflineError(e) ? 'offline' : 'error';
    }
    if (focus === 'used-in') _showUsedIn();
  }
  // When the sheet opened: on the phone the list is there at once, and a
  // scroll while the sheet is still flying in (Sheet.svelte, 280ms) lands
  // short, so it waits for the sheet to settle.
  let _openedAt = 0;
  async function _showUsedIn() {
    await tick();
    const settle = 320 - (Date.now() - _openedAt);
    if (settle > 0) await new Promise(r => setTimeout(r, settle));
    if (!usedInEl) return;
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    usedInEl.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
    usedInFlash = true;
    setTimeout(() => { usedInFlash = false; }, 1400);
  }
  // A variant's name as this sheet's Variants list shows it ("GreenWise").
  function _viaName(via, ctx) {
    const kid = ctx.children.find(v => v.id === via.id);
    return kid ? _displayVariantName(kid, item, { nested: true }) : via.name;
  }
  function _openRecipe(r) { dispatch('openrecipe', { id: r.id }); }
  $: usedInShown = usedInAll ? usedIn.direct : usedIn.direct.slice(0, USED_IN_SHOWN);

  // ── Stock from the sheet (#60) ─────────────────────────────────────
  // The same writes as the card's check button (lib/pantry-variants.js).
  // Taps on - and + gather for a moment and save once.
  let _savedStock = null;   // { quantity, in_stock } last known saved
  let _stockTimer = null;
  function _applyStock(next, { wait = 0 } = {}) {
    if (!item || !next) return;
    if (_savedStock == null) _savedStock = { quantity: item.quantity, in_stock: item.in_stock };
    item = { ...item, ...next };
    dispatch('changed', item);
    clearTimeout(_stockTimer);
    _stockTimer = setTimeout(_saveStock, wait);
  }
  async function _saveStock() {
    _stockTimer = null;
    if (!item || _savedStock == null) return;
    const id = item.id;
    const before = _savedStock;
    const next = { quantity: item.quantity, in_stock: item.in_stock };
    _savedStock = null;
    try {
      await NtApi.updatePantryItem(id, next);
    } catch (e) {
      if (item?.id === id) {
        item = { ...item, ...before };
        dispatch('changed', item);
      }
      showError(failed('fail.update_stock', e));
    }
  }
  function toggleStock() { _applyStock(stockAfterToggle(item)); }
  function stepStock(delta) { _applyStock(stockAfterStep(item, delta), { wait: 500 }); }
  $: canStepDown = !!item && stockAfterStep(item, -1) != null;

  function _enterCreateMode() {
    item = { ..._blank(), ...(prefill || {}),
      nutrition: prefill?.nutrition && typeof prefill.nutrition === 'object'
        ? { ...prefill.nutrition } : {},
    };
    draft = { ...item };
    _lastServingSize = Number(draft.serving_size) || null;
    editing = true;
    loading = false;
    loadError = null;
    _loadPantryCategories();
  }

  function _startEdit() {
    if (!item) return;
    draft = {
      ..._blank(), ...item,
      brand: item.brand ?? '',
      barcode: item.barcode ?? '',
      quantity: item.quantity ?? '',
      img_url: item.img_url ?? '',
      category: item.category ?? '',
      category_id: item.category_id ?? null,
      serving_size: item.serving_size ?? '',
      serving_unit: item.serving_unit ?? 'g',
      nutrition: item.nutrition && typeof item.nutrition === 'object' ? { ...item.nutrition } : {},
      expires_on: item.expires_on ?? '',
    };
    _lastServingSize = Number(draft.serving_size) || null;
    editing = true;
  }

  function _reset() {
    if (_stockTimer) { clearTimeout(_stockTimer); _saveStock(); }
    usedIn = { direct: [], through: [] };
    usedInState = 'idle';
    usedInAll = false;
    item = null;
    draft = null;
    loadError = null;
    editing = false;
    saving = false;
    linked = false;
    _lastServingSize = null;
    allNutrientsOpen = false;
    downloading = false;
    downloadSuccess = false;
    contributing = false;
    offSuccess = false;
    offVerified = null;
    offProductExists = null;
    _lastCheckedBarcode = null;
  }

  // ── Visible nutriments — for the inline edit grid ──────────────────
  $: visibleIds = $visibleNutriments && $visibleNutriments.length
    ? $visibleNutriments
    : DEFAULT_VISIBLE_NUTRIMENT_IDS;
  $: visibleInlineNutriments = visibleIds
    .map(id => NUTRIMENTS.find(n => n.id === id))
    .filter(Boolean);

  // ── Categories ─────────────────────────────────────────────────────
  async function _loadPantryCategories() {
    if (pantryCategories.length) return;
    try { pantryCategories = await NtApi.getPantryCategories(); }
    catch { pantryCategories = []; }
  }

  // Variant-related lookups. Fetches the full pantry list once, derives:
  //   - parentName: the name of this item's generic parent, if any
  //   - children:   rows whose generic_parent_id === item.id (this item is a generic)
  //   - candidates: rows that could become this item's parent OR receive
  //                 this item as an existing-child variant (any flat item
  //                 or generic, excluding self and own descendants).
  async function _loadVariantContext() {
    if (!item?.id) { variantContext = { parentName: null, children: [], candidates: [] }; return; }
    let all = [];
    try { all = await NtApi.getPantry(); }
    catch { variantContext = { parentName: null, children: [], candidates: [] }; return; }

    const byId = new Map(all.map(r => [r.id, r]));
    const parentName = item.generic_parent_id != null
      ? (byId.get(item.generic_parent_id)?.name || null)
      : null;
    const children = all
      .filter(r => r.generic_parent_id === item.id && r.id !== item.id)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    // Set of pantry_items ids that have children (i.e. are themselves
    // generics). Used to gate Add Variant suggestions: attaching a
    // generic as a variant would orphan its own children, and the
    // server's PUT route rejects it with "Can't move a generic with
    // its own variants under another generic". Surfacing that as a
    // toast feels worse than just not offering the option.
    const isGenericId = new Set(
      all.filter(r => r.generic_parent_id != null).map(r => r.generic_parent_id)
    );
    const candidates = all
      .filter(r =>
        r.id !== item.id
        && r.generic_parent_id == null   // not already a variant
        && r.id !== item.generic_parent_id  // not already this item's parent
      )
      .map(r => ({ ...r, _isGeneric: isGenericId.has(r.id) }));
    variantContext = { parentName, children, candidates };
  }

  $: isVariant  = !!item && item.generic_parent_id != null;
  $: isGeneric  = !!item && !isVariant && variantContext.children.length > 0;
  $: isFlat     = !!item && !isVariant && !isGeneric;

  async function _setGenericParent(parentId) {
    if (!item?.id) return;
    try {
      const updated = await NtApi.updatePantryItem(item.id, { generic_parent_id: parentId });
      item = updated;
      variantPickerOpen = false;
      variantPickerQuery = '';
      await _loadVariantContext();
      showSuccess(parentId ? $_('done.variant_added') : $_('done.variant_detached'));
      dispatch('changed', { item: updated });
      // Variant relationship moved; the parent (if any) and any sibling
      // rows in the host list won't be patched by the targeted `changed`
      // event. Ask the host to refetch so the pantry list reflects the
      // new hierarchy.
      dispatch('refresh');
    } catch (e) {
      showError(failed('fail.update_variant_link', e));
    }
  }

  async function _detachVariant() {
    const parent = variantContext.parentName || $_('pantry_item_sheet_ui.parent_fallback');
    const ok = await confirmDialog({
      title: $_('pantry_item_sheet_ui.detach_title', { values: { parent } }),
      message: $_('pantry_item_sheet_ui.detach_message', { values: { parent } }),
      confirmText: $_('pantry_item_sheet_ui.detach'),
    });
    if (!ok) return;
    await _setGenericParent(null);
  }

  async function _addNewVariant() {
    const brand = (newVariantBrand || '').trim();
    const overrideName = newVariantNameOverride ? (newVariantName || '').trim() : '';
    if (!brand && !overrideName) {
      showError($_('pantry_sheet_extra.toast.brand_or_name_required'));
      return;
    }
    if (!item?.id) return;
    try {
      // Inherit the parent's name unless the user explicitly typed a
      // different one. Brand goes in the brand column either way so
      // search and display compose consistently across surfaces.
      //
      // Expiry carry-over: when promoting a flat item to a generic by
      // adding its first variant, the parent's existing expires_on
      // represents a real product that's now the variant. Hand the date
      // forward so the user's prior data flows to the right physical
      // thing instead of getting orphaned on the now-invisible parent
      // field. Subsequent variants start blank.
      const promoting = isFlat && variantContext.children.length === 0;
      const seed = {
        name: overrideName || item.name,
        brand: brand || null,
        in_stock: 1,
        category_id: item.category_id ?? null,
        generic_parent_id: item.id,
        expires_on: promoting ? (item.expires_on || null) : null,
      };
      const created = await NtApi.createPantryItem(seed);
      newVariantBrand = '';
      newVariantName = '';
      newVariantNameOverride = false;
      addingVariantRow = false;
      await _loadVariantContext();
      showSuccess($_('pantry_sheet_extra.toast.added_variant', { values: { name: _displayVariantName(created, item, { nested: false }) } }));
      dispatch('changed', { item });
      // A new row landed and (when promoting a flat item) the parent may
      // have been auto-converted to a generic. Local patch can't infer
      // either, so ask the host to refetch.
      dispatch('refresh');
    } catch (e) {
      // Surface the underlying error so logcat / DevTools show what failed
      // when the toast isn't specific enough for triage.
      console.error('[pantry] _addNewVariant failed:', e);
      showError(failed('fail.add_variant', e));
    }
  }

  // Alias so existing template references stay readable. Helper lives
  // in src/lib/pantry-variants.js so the pantry list, AI tool output,
  // and federation responses all compose names the same way.
  const _displayVariantName = _sharedDisplayVariantName;

  // Expiry display helpers (Issue #9). Threshold is hardcoded at 14
  // days for the warning chip; past-expiry items always show the
  // stronger red treatment. Settings-tunable threshold can land later
  // if there's demand.
  const _EXPIRY_WARN_DAYS = 14;
  function _expiryStatus(dateStr) {
    if (!dateStr) return 'none';
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return 'none';
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const diff = (d - now) / (1000 * 60 * 60 * 24);
    if (diff < 0) return 'past';
    if (diff <= _EXPIRY_WARN_DAYS) return 'warn';
    return 'ok';
  }
  // Reactive so dates follow a language switch.
  $: _formatExpiry = (dateStr) => {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr + 'T00:00:00');
      if (Number.isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString($locale || undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return dateStr; }
  };

  // Earliest expiring variant on a generic. Returns the worst-case
  // status (past > warn > ok) plus the corresponding child row so the
  // editor can render "Earliest variant: <name> on <date>". null when
  // no variant has an expiry date set.
  function _earliestVariantExpiry() {
    const kids = variantContext?.children || [];
    let pastWorst = null;
    let warnWorst = null;
    for (const k of kids) {
      if (!k.expires_on) continue;
      const s = _expiryStatus(k.expires_on);
      if (s === 'past') {
        if (!pastWorst || k.expires_on < pastWorst.kid.expires_on) pastWorst = { kid: k, status: 'past' };
      } else if (s === 'warn') {
        if (!warnWorst || k.expires_on < warnWorst.kid.expires_on) warnWorst = { kid: k, status: 'warn' };
      }
    }
    if (pastWorst) return pastWorst;
    if (warnWorst) return warnWorst;
    // No warn/past, but still useful to surface the soonest future date
    // so a user planning meals sees what's next up.
    let nextDated = null;
    for (const k of kids) {
      if (!k.expires_on) continue;
      if (!nextDated || k.expires_on < nextDated.kid.expires_on) nextDated = { kid: k, status: 'ok' };
    }
    return nextDated;
  }

  async function _addExistingAsVariant(childId) {
    if (!item?.id || !childId) return;
    try {
      const updatedChild = await NtApi.updatePantryItem(childId, { generic_parent_id: item.id });
      variantPickerOpen = false;
      variantPickerQuery = '';
      addingVariantRow = false;
      newVariantBrand = '';
      newVariantName = '';
      newVariantNameOverride = false;
      await _loadVariantContext();
      showSuccess($_('pantry_sheet_extra.toast.linked_as_variant'));
      dispatch('changed', { item });
      // Patch the CHILD's row in the host list synchronously so the
      // parent's chevron appears immediately instead of after the
      // refetch round-trip. Without this dispatch, the in-memory items
      // array keeps the child with generic_parent_id == null until the
      // safety-net refresh below completes.
      if (updatedChild?.id) dispatch('changed', { item: updatedChild });
      dispatch('refresh');
    } catch (e) {
      showError(failed('fail.link_variant', e));
    }
  }

  // Parent nutrition source (Issue #4). The parent's effective
  // nutrition for recipe calculations comes from either its own
  // manual values (null) or one of its child variants. Changing the
  // source is a one-click action; the editor's nutrition fields stay
  // editable when Manual is selected, become a read-only preview when
  // pulling from a variant.
  async function _setNutritionSource(variantId) {
    if (!item?.id) return;
    try {
      const updated = await NtApi.updatePantryItem(item.id, {
        nutrition_source_variant_id: variantId,
      });
      item = updated;
      showSuccess(variantId ? $_('done.nutrition_from_variant') : $_('done.nutrition_manual'));
      dispatch('changed', { item: updated });
    } catch (e) {
      showError(failed('fail.nutrition_source', e));
    }
  }

  function _openPicker(mode) {
    variantPickerMode = mode;
    variantPickerQuery = '';
    variantPickerOpen = true;
  }

  $: variantPickerResults = (() => {
    const q = foldText(variantPickerQuery).trim();
    const pool = variantPickerMode === 'set-parent'
      ? variantContext.candidates  // anywhere flat-or-generic
      : variantContext.candidates.filter(r => r.id !== item?.id);
    if (!q) return pool.slice(0, 50);
    return pool.filter(r => foldText(r.name).includes(q)).slice(0, 50);
  })();

  // Suggestion list under the inline Add Variant input (Issue #4 UX
  // polish). As the user types a brand into the form, we surface
  // existing flat-or-generic pantry rows whose name or brand matches.
  // Tapping a suggestion attaches that existing item as a variant of
  // the current row, in one step. If nothing matches, the user can
  // still hit Add to create a brand-new variant from the typed text.
  // Candidates are reused from variantContext (already excludes self,
  // existing children, and rows that are already variants of someone
  // else, so the suggestion list can't show a row that wouldn't
  // accept the attachment).
  $: addVariantSuggestions = (() => {
    if (!addingVariantRow) return [];
    const q = foldText(newVariantBrand).trim();
    if (!q) return [];
    // Filter out generics from the Add Variant suggestion list so we
    // don't offer a target the server will reject.
    const pool = (variantContext.candidates || []).filter(r => !r._isGeneric);
    const scored = pool
      .map(r => {
        const name = foldText(r.name);
        const brand = foldText(r.brand);
        const hay = name + ' ' + brand;
        if (!hay.includes(q)) return null;
        // Prefer rows whose brand or name STARTS with the query, then
        // fall back to "contains" matches. Same idea as a contact-list
        // autocomplete; keeps the most obvious hit at the top.
        const startsWith = name.startsWith(q) || brand.startsWith(q);
        return { row: r, startsWith };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.startsWith !== b.startsWith) return a.startsWith ? -1 : 1;
        return (a.row.name || '').localeCompare(b.row.name || '');
      })
      .map(s => s.row);
    return scored.slice(0, 6);
  })();
  $: {
    const src = editing ? draft : item;
    if (src?.category_id != null) {
      const c = pantryCategories.find(x => x.id === src.category_id);
      categoryName = c?.name || '';
    } else if (src?.category) {
      const c = pantryCategories.find(x => x.slug === src.category);
      categoryName = c?.name || categoryLabel(src.category);
    } else {
      categoryName = '';
    }
  }
  // Icon that pairs with categoryName. Looks up the live pantry-category
  // row by id (or slug fallback) so the icon matches whatever the user
  // saved on the server — not the hardcoded PANTRY_CATEGORIES list,
  // which would render the wrong icon for custom categories.
  $: _categoryIconResolved = (() => {
    const src = item;
    if (src?.category_id != null) {
      return pantryCategories.find(x => x.id === src.category_id)?.icon
        || categoryIcon(src.category);
    }
    if (src?.category) {
      return pantryCategories.find(x => x.slug === src.category)?.icon
        || categoryIcon(src.category);
    }
    return categoryIcon(null);
  })();
  function onPantryCategorySelect(e) {
    const opt = e.detail;
    const match = pantryCategories.find(c => c.name.toLowerCase() === (opt?.name || '').toLowerCase());
    if (match) {
      draft.category_id = match.id;
      draft.category = match.slug;
      draft = { ...draft };
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
      draft.category_id = c.id;
      draft.category = c.slug;
      draft = { ...draft };
      comboCategoryRef?.acceptCreated(c.name);
      categoryNewOpen = false;
    } catch (err) { showError(failed('fail.create_category', err)); }
  }

  // ── Barcode + OFF ──────────────────────────────────────────────────
  function onScan(e) {
    const code = e?.detail?.code || e?.detail || '';
    const trimmed = String(code).trim();
    if (!trimmed) return;
    draft.barcode = trimmed;
    draft = { ...draft };
    editorScannerOpen = false;
    if ($offEnabled) downloadFromOFF();
  }

  async function downloadFromOFF() {
    if (!draft.barcode) { showError($_('pantry_sheet_extra.toast.enter_barcode')); return; }
    refreshSource = 'off'; downloading = true; downloadSuccess = false;
    try {
      const result = await lookupBarcode(draft.barcode);
      if (!result) { showError($_('pantry_sheet_extra.toast.not_found_off')); return; }
      _applyRefresh(result);
    } catch (e) { showError(failed('fail.off_lookup', e)); }
    finally { downloading = false; }
  }

  // Refresh from USDA (TraceApps/nutritrace#290): Refresh from OFF with the
  // item looked up on USDA instead, by its fdcId_ barcode or its GTIN. Items
  // added from USDA before #290 were scaled by 100 / serving size, and this
  // is how one gets USDA's real values back without re-adding it.
  $: usdaId = usdaFdcId(draft?.barcode);
  $: showUsdaRefresh = !!draft?.barcode && !!(usdaId || ($usdaEnabled && $usdaApiKey));
  async function downloadFromUSDA() {
    if (!draft.barcode) return;
    if (!$usdaEnabled || !$usdaApiKey) { showError($_('pantry_sheet_extra.toast.usda_needs_key')); return; }
    if ($offlineState.online === false) { showError($_('pantry_sheet_extra.toast.usda_offline')); return; }
    refreshSource = 'usda'; downloading = true; downloadSuccess = false;
    try {
      const result = await usdaLookupForRefresh(draft.barcode, $usdaApiKey);
      if (!result) { showError($_('pantry_sheet_extra.toast.not_found_usda')); return; }
      _applyRefresh(result);
    } catch (e) { showError(failed('fail.usda_lookup', e)); }
    finally { downloading = false; }
  }

  // What both refreshes do with the result: nutrition and serving from the
  // source, name, brand and photo only when empty.
  function _applyRefresh(result) {
    if (!draft.name) draft.name = result.name || '';
    if (!draft.brand) draft.brand = result.brand || '';
    draft.serving_size = result.serving_size ?? draft.serving_size;
    draft.serving_unit = result.serving_unit || draft.serving_unit;
    draft.nutrition = deriveSodiumSalt({ ...(draft.nutrition || {}), ...(result.nutrition || {}) });
    if (result.img_url && !draft.img_url) draft.img_url = result.img_url;
    // The label's allergens, unless they were set by hand here.
    if (result.allergens != null && draft.allergens_source !== 'user') {
      draft.allergens = result.allergens;
      draft.traces = result.traces || [];
      draft.allergens_source = 'label';
    }
    _lastServingSize = draft.serving_size;
    draft = { ...draft };
    nutritionRev++;
    downloadSuccess = true;
    setTimeout(() => downloadSuccess = false, 2000);
  }

  async function _refreshOffPresence() {
    if (!draft?.barcode) { offProductExists = null; return; }
    if (_lastCheckedBarcode === draft.barcode) return;
    _lastCheckedBarcode = draft.barcode;
    try {
      const existing = await lookupBarcode(draft.barcode);
      offProductExists = !!existing;
    } catch { offProductExists = false; }
  }
  $: if (editing && draft?.barcode && draft.barcode !== _lastCheckedBarcode) _refreshOffPresence();

  async function _openOffPage() {
    const url = 'https://world.openfoodfacts.org/product/' + encodeURIComponent(draft.barcode);
    try {
      if (isNative) {
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url });
      } else {
        window.open(url, '_blank', 'noopener');
      }
    } catch { window.open(url, '_blank', 'noopener'); }
  }

  async function shareOrViewOnOFF() {
    if (!draft.barcode) { showError($_('pantry_sheet_extra.toast.add_barcode')); return; }
    if (offProductExists) { await _openOffPage(); return; }
    if (!draft.name) { showError($_('pantry_sheet_extra.toast.add_name')); return; }
    offNeedsAccount = false; offPhotoFailed = false;
    if (!String($offUsername || '').trim() || !$offPassword) { offNeedsAccount = true; return; }
    contributing = true; offSuccess = false; offVerified = null;
    try {
      const existing = await lookupBarcode(draft.barcode);
      if (existing) {
        offProductExists = true;
        contributing = false;
        await _openOffPage();
        return;
      }
      const sent = await contributeToOFF(draft, {
        offUsername: $offUsername, offPassword: $offPassword,
        offUploadCountry: $offUploadCountry,
      });
      offPhotoFailed = sent?.photo === 'failed';
      offSuccess = true;
      offProductExists = true;
      setTimeout(() => offSuccess = false, 3000);
      setTimeout(async () => {
        try {
          const found = await lookupBarcode(draft.barcode);
          offVerified = !!found;
        } catch { offVerified = false; }
      }, 3000);
    } catch (e) {
      // A wrong login is fixed in place too, so nothing typed is lost.
      if (e?.kind === 'no_account' || e?.kind === 'login') offNeedsAccount = true;
      if (e?.kind !== 'no_account') showError(offShareMessage(e, $_) || failed('fail.off_share', e));
    }
    finally { contributing = false; }
  }

// ── Linked nutrient scaling ────────────────────────────────────────
  function onServingSizeInput() {
    if (!linked || _lastServingSize == null) {
      _lastServingSize = Number(draft.serving_size) || null;
      return;
    }
    const next = Number(draft.serving_size);
    if (!Number.isFinite(next) || next <= 0 || _lastServingSize <= 0) {
      _lastServingSize = next || _lastServingSize;
      return;
    }
    const ratio = next / _lastServingSize;
    if (!Number.isFinite(ratio) || ratio === 1) { _lastServingSize = next; return; }
    const prev = draft.nutrition || {};
    const scaled = { ...prev, _derived: { ...(prev._derived || {}) } };
    for (const [k, v] of Object.entries(scaled)) {
      if (k === '_derived') continue;
      if (typeof v === 'number' && Number.isFinite(v)) {
        scaled[k] = Math.round(v * ratio * 100) / 100;
      }
    }
    if (Number(scaled.sodium) > 0 && !scaled._derived.sodium) {
      delete scaled.salt; delete scaled._derived.salt;
    } else if (Number(scaled.salt) > 0 && !scaled._derived.salt) {
      delete scaled.sodium; delete scaled._derived.sodium;
    }
    draft = { ...draft, nutrition: deriveSodiumSalt(scaled) };
    _lastServingSize = next;
  }

  // ── Nutrient helpers ───────────────────────────────────────────────
  function _setNutrient(key, raw) {
    const value = (raw === '' || raw == null) ? undefined : Number(raw);
    const prev = draft.nutrition || {};
    const next = { ...prev, _derived: { ...(prev._derived || {}) } };
    if (value == null || !Number.isFinite(value)) delete next[key];
    else next[key] = value;
    if (key === 'sodium' || key === 'salt') {
      const other = key === 'sodium' ? 'salt' : 'sodium';
      delete next._derived[key];
      delete next[other];
      delete next._derived[other];
    }
    draft = { ...draft, nutrition: deriveSodiumSalt(next) };
  }
  function _getNutrient(id) {
    const v = draft?.nutrition?.[id];
    return Number.isFinite(v) ? v : '';
  }

  $: householdMembers = cleanHousehold($household);

  // Allergens changed from the item's view: saved at once.
  async function saveAllergens(e) {
    if (!item || itemId == null) return;
    try {
      await NtApi.updatePantryItem(itemId, { ...e.detail, _base: item });
      item = { ...item, ...e.detail };
      dispatch('changed', { ...item });
      showSuccess($_('allergen_info.saved'));
    } catch (err) { showError(failed('fail.save_allergens', err)); }
  }

  // ── Save / Cancel / Delete ─────────────────────────────────────────
  async function saveEdit() {
    if (!draft.name?.trim()) { showError($_('pantry_sheet_extra.toast.name_required')); return; }
    saving = true;
    try {
      const qtyNum = draft.quantity === '' || draft.quantity == null ? null : Number(draft.quantity);
      const payload = {
        name: draft.name.trim(),
        brand: draft.brand?.trim() || null,
        barcode: draft.barcode?.toString().trim() || null,
        in_stock: qtyNum === 0 ? 0 : 1,
        quantity: qtyNum,
        notes: draft.notes?.trim() || null,
        img_url: draft.img_url || null,
        category: draft.category || null,
        category_id: draft.category_id ?? null,
        serving_size: draft.serving_size === '' || draft.serving_size == null ? null : Number(draft.serving_size),
        serving_unit: draft.serving_unit || null,
        nutrition: draft.nutrition && Object.keys(draft.nutrition).length ? draft.nutrition : null,
        expires_on: draft.expires_on || null,
        // Allergens (lib/allergens.js): null means nobody knows them yet.
        allergens: draft.allergens ?? null,
        traces: draft.traces ?? null,
        allergens_source: draft.allergens_source ?? null,
      };
      if (itemId == null) {
        const row = await NtApi.createPantryItem(payload);
        showSuccess($_('pantry_sheet_extra.toast.added_to_pantry'));
        const finalRow = row && row.id ? row : { ...payload, id: row?.id };
        dispatch('created', finalRow);
        open = false;
      } else {
        // With the item as opened: only what the form changed goes in.
        await NtApi.updatePantryItem(itemId, { ...payload, _base: item });
        showSuccess($_('pantry_sheet_extra.toast.saved'));
        item = { ...item, ...payload, id: itemId };
        dispatch('changed', { ...item });
        editing = false;
        draft = null;
      }
    } catch (e) { showError(failed('fail.save_item', e)); }
    finally { saving = false; }
  }

  function cancelEdit() {
    if (itemId == null) { open = false; return; }
    editing = false;
    draft = null;
  }

  async function deleteItem() {
    if (!item || itemId == null) return;
    // Generic with variants: open the variant-aware delete dialog so
    // the user explicitly picks what happens to the children. Default
    // the radio to "promote to standalone" so an Enter / one-tap
    // confirm doesn't silently nuke pantry data.
    if (isGeneric && variantContext.children.length > 0) {
      deleteCascade = false;
      deleteWithVariantsOpen = true;
      return;
    }
    const ok = await confirmDialog({
      title: $_('pantry_item_sheet_ui.remove_title'),
      message: $_('pantry_item_sheet_ui.remove_message', { values: { name: item.name } }),
      confirmText: $_('pantry_item_sheet_ui.remove'), dangerous: true,
    });
    if (!ok) return;
    await _performDelete(false);
  }

  async function _performDelete(cascade) {
    if (!item || itemId == null) return;
    try {
      await NtApi.deletePantryItem(itemId, { cascade });
      showSuccess(cascade ? $_('done.removed_with_variants') : $_('done.item_removed'));
      const id = itemId;
      open = false;
      dispatch('deleted', { id });
      // Variants either got soft-deleted (cascade) or had their
      // generic_parent_id cleared (promote). Either way the host's
      // in-memory items array can't infer the change from a single
      // 'deleted' event for the parent — refetch to keep the list
      // consistent with the new state.
      if (isGeneric && variantContext.children.length > 0) dispatch('refresh');
    } catch (e) { showError(failed('fail.remove_item', e)); }
  }

  async function _confirmVariantDelete() {
    const cascade = deleteCascade;
    deleteWithVariantsOpen = false;
    await _performDelete(cascade);
  }

  // Inline quick qty +/- removed in v1.0 — quantity is changed in the
  // sheet's edit mode. The qty-row CSS rules were stripped alongside.

  // ── Derived display ────────────────────────────────────────────────
  // Same read as the pantry card (isItemInStock). !(Number(qty) === 0)
  // showed a blank quantity as Out of Stock, since Number(null) === 0.
  $: isInStock = item ? isItemInStock(item) : true;
  $: servingDescription = (item && item.serving_size && item.serving_unit)
    ? `${item.serving_size} ${item.serving_unit}`
    : '';
  $: hasNutrition = !!(item && item.nutrition && Object.keys(item.nutrition).filter(k => k !== '_derived').length > 0);

  $: sheetTitle = !item
    ? $_('pantry_item_sheet_ui.title_fallback')
    : (itemId == null ? $_('pantry_editor.title_add') : (editing ? $_('pantry_editor.title_edit') : (item.name || $_('pantry_item_sheet_ui.title_fallback'))));
</script>

<Sheet bind:open title={sheetTitle} height="auto">
  <!-- Header action icons sit next to the Sheet's close (X) button —
       mirrors the recipe-view header chrome so detail surfaces feel
       uniform. View mode: Edit (pencil) + Delete (trash). Edit mode:
       Cancel (revert) + Save (checkmark). Order matches RecipeView. -->
  <svelte:fragment slot="headerActions">
    {#if item && !loading && !loadError}
      {#if editing}
        <button class="btn-icon danger" on:click={cancelEdit} disabled={saving}
          aria-label={$_('common.cancel')} title={$_('common.cancel')}>
          <span class="material-symbols-rounded">undo</span>
        </button>
        <button class="btn-icon success" on:click={saveEdit} disabled={saving || imgUploading}
          aria-label={saving ? $_('common.saving') : $_('common.save')} title={saving ? $_('common.saving') : $_('common.save')}>
          <span class="material-symbols-rounded">{saving ? 'progress_activity' : 'check'}</span>
        </button>
      {:else}
        <button class="btn-icon" on:click={_startEdit} aria-label={$_('common.edit')} title={$_('common.edit')}>
          <span class="material-symbols-rounded">edit</span>
        </button>
        <button class="btn-icon danger" on:click={deleteItem} aria-label={$_('common.delete')} title={$_('common.delete')}>
          <span class="material-symbols-rounded">delete</span>
        </button>
      {/if}
    {/if}
  </svelte:fragment>

  {#if loading}
    <div class="state" in:fade={{ duration: 120 }}>
      <span class="material-symbols-rounded spin">progress_activity</span>
    </div>
  {:else if loadError}
    <div class="state error">
      <span class="material-symbols-rounded">error</span>
      <p>{loadError}</p>
      {#if itemId != null}
        <button class="btn btn-secondary" on:click={() => _enterViewOrEditMode(itemId, false)}>{$_('pantry_sheet_extra.retry')}</button>
      {/if}
    </div>
  {:else if item}
    <div class="sheet-content">
      <!-- Two-column layout on desktop: identity (large photo + brand
           + meta pills) on the left, stats + nutrition on the right.
           Mobile collapses to a single column. SAME structure in view
           AND edit mode — fields just flip to inputs in place. -->
      <div class="grid">
        <!-- LEFT — identity column -->
        <div class="col-identity">
          {#if editing}
            <ImagePicker bind:value={draft.img_url} bind:uploading={imgUploading}
              aspect="1 / 1" expand placeholder={$_('pantry_sheet_extra.add_a_photo')} />
          {:else}
            {#if item.img_url}
              <!-- Wrapper clips the image to rounded corners via
                   overflow:hidden, mirroring ImagePicker.preview-wrap.
                   Without the wrapper the image's own white background
                   leaks past the inner border-radius and the photo
                   looks square. -->
              <div class="hero-wrap">
                <img class="hero-photo" src={resolveAssetUrl(item.img_url)} alt="" />
              </div>
            {:else}
              <div class="hero-wrap">
                <div class="hero-stub">
                  <span class="material-symbols-rounded">{categoryIcon(item.category)}</span>
                </div>
              </div>
            {/if}
          {/if}
          <div class="identity-info">
            {#if editing}
              <label class="field">
                <span class="field-label">{$_('pantry_sheet.name')}</span>
                <input class="input" type="text" dir="auto" bind:value={draft.name} placeholder={$_('pantry_sheet_extra.name_ph')} />
              </label>
              <label class="field">
                <span class="field-label">{$_('pantry_sheet.brand')}</span>
                <input class="input" type="text" dir="auto" bind:value={draft.brand} placeholder={$_('pantry_sheet_extra.brand_ph')} />
              </label>
              <label class="field">
                <span class="field-label">
                  {$_('editor.category')}
                  {#if categoryName}
                    <button type="button" class="field-clear"
                      on:click|preventDefault={() => { draft.category_id = null; draft.category = ''; draft = { ...draft }; }}>
                      {$_('common.clear')}
                    </button>
                  {/if}
                </span>
                <Combobox
                  bind:this={comboCategoryRef}
                  mode="single"
                  value={categoryName}
                  options={pantryCategories.map(c => ({ name: c.name, icon: c.icon, color: c.color }))}
                  placeholder={$_('pantry_item_sheet_ui.category_placeholder')}
                  creatable={true}
                  createLabel={$_('pantry_item_sheet_ui.create_category')}
                  on:select={onPantryCategorySelect}
                  on:create={openNewPantryCategoryDialog}
                  on:change={(e) => {
                    if (!e.detail) { draft.category_id = null; draft.category = ''; draft = { ...draft }; }
                  }}
                />
              </label>
              <label class="field">
                <span class="field-label">{$_('pantry_sheet.barcode')}</span>
                <div class="barcode-wrap">
                  <input class="input barcode-input" type="text" inputmode="numeric"
                    bind:value={draft.barcode} placeholder={$_('pantry_editor_ct.optional_ph')} />
                  <button type="button" class="barcode-scan-inline" aria-label={$_('pantry.scan_barcode')} title={$_('pantry.scan_barcode')}
                    on:click={() => editorScannerOpen = true}>
                    <span class="material-symbols-rounded">barcode_scanner</span>
                  </button>
                </div>
              </label>
              {#if ($offEnabled || showUsdaRefresh) && draft.barcode}
                <div class="off-actions">
                  {#if $offEnabled}
                  <button type="button" class="btn btn-secondary off-btn"
                    on:click={shareOrViewOnOFF} disabled={contributing}
                    title={offProductExists ? $_('pantry_item_sheet_ui.off_open_title') : !draft.name ? $_('pantry_item_sheet_ui.off_name_required') : $_('pantry_item_sheet_ui.off_submit_title')}>
                    <span class="material-symbols-rounded off-btn-ico">
                      {offProductExists ? 'open_in_new' : 'upload'}
                    </span>
                    {contributing ? $_('pantry_editor.actions.uploading') : offSuccess ? $_('pantry_item_sheet_ui.off_submitted') : offProductExists ? $_('pantry_item_sheet_ui.off_view') : $_('pantry_editor.actions.share_to_off')}
                  </button>
                  {#if !usdaId}
                  <button type="button" class="btn btn-secondary off-btn"
                    on:click={downloadFromOFF} disabled={downloading}
                    title={$_('pantry_item_sheet_ui.off_pull_title')}>
                    <span class="material-symbols-rounded off-btn-ico">download</span>
                    {downloading && refreshSource === 'off' ? $_('common.loading') : downloadSuccess && refreshSource === 'off' ? $_('pantry_item_sheet_ui.off_updated') : $_('pantry_editor.actions.refresh_off')}
                  </button>
                  {/if}
                  {/if}
                  {#if showUsdaRefresh}
                  <button type="button" class="btn btn-secondary off-btn"
                    on:click={downloadFromUSDA} disabled={downloading}
                    title={$_('pantry_item_sheet_ui.usda_pull_title')}>
                    <span class="material-symbols-rounded off-btn-ico">download</span>
                    {downloading && refreshSource === 'usda' ? $_('common.loading') : downloadSuccess && refreshSource === 'usda' ? $_('pantry_item_sheet_ui.off_updated') : $_('pantry_editor.actions.refresh_usda')}
                  </button>
                  {/if}
                </div>
                {#if offNeedsAccount}
                  <OffAccountInline on:saved={() => { offNeedsAccount = false; shareOrViewOnOFF(); }} />
                {/if}
                {#if offPhotoFailed}
                  <div class="off-verify-row" role="status">
                    <span class="off-verify-pending">{$_('off_share.photo_failed')}</span>
                  </div>
                {/if}
                {#if offSuccess}
                  <div class="off-verify-row">
                    {#if offVerified === null}
                      <span class="off-verify-checking">
                        <span class="material-symbols-rounded off-verify-ico">hourglass_top</span>
                        {$_('pantry_item_sheet_ui.off_verifying')}
                      </span>
                    {:else if offVerified}
                      <span class="off-verify-ok">
                        <span class="material-symbols-rounded off-verify-ico">check_circle</span>
                        {$_('pantry_item_sheet_ui.off_confirmed')}
                      </span>
                    {:else}
                      <span class="off-verify-pending">
                        <span class="material-symbols-rounded off-verify-ico">schedule</span>
                        {$_('pantry_item_sheet_ui.off_pending')}
                      </span>
                    {/if}
                  </div>
                {/if}
              {/if}
            {:else}
              {#if item.brand}<div class="brand" dir="auto">{item.brand}</div>{/if}
              <div class="meta-pills">
                {#if categoryName}
                  <span class="pill">
                    <span class="material-symbols-rounded">{_categoryIconResolved}</span>
                    {categoryName}
                  </span>
                {/if}
                {#if item.barcode}
                  <span class="pill subtle">
                    <span class="material-symbols-rounded">barcode_scanner</span>
                    {item.barcode}
                  </span>
                {/if}
                {#if isGeneric}
                  <span class="pill" class:in={isInStock} class:out={!isInStock}>
                    <span class="material-symbols-rounded">{isInStock ? 'check_circle' : 'remove_shopping_cart'}</span>
                    {isInStock ? $_('pantry.filters.in_stock') : $_('pantry_item_sheet_ui.out_of_stock_label')}
                  </span>
                {:else}
                  <!-- Flips stock right here, the same write as the card's
                       check button. A generic's stock is its variants'. -->
                  <button type="button" class="pill stock-switch" class:in={isInStock} class:out={!isInStock}
                    role="switch" aria-checked={isInStock} aria-label={$_('pantry.filters.in_stock')} on:click={toggleStock}>
                    <span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span>
                    <span aria-hidden="true">{isInStock ? $_('pantry.filters.in_stock') : $_('pantry_item_sheet_ui.out_of_stock_label')}</span>
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        </div>

        <!-- RIGHT — data column (stats + nutrition) -->
        <div class="col-data">
          <!-- Stats stack as full-width horizontal strips. Inputs inside
               each strip flow left-to-right and wrap to a second line
               naturally when the row runs out of width — they don't all
               have to fit on a single line. -->
          <!-- Single combined strip: On Hand on the left (qty +/- in
               view; plain number input in edit) + Serving Size on the
               right (size + unit picker). Quantity is just a number;
               the qty-unit field was removed in v1.0 (most users left
               it blank and nothing downstream consumed it). -->
          <!-- On Hand + Serving Size as two separate bordered stat cards
               sitting side-by-side in a flex row. Each keeps its own
               surface so the visual rhythm matches a paired-card layout
               rather than a single combined strip. -->
          <div class="stats">
            <div class="stat">
              <div class="stat-label">{$_('pantry_sheet.on_hand')}</div>
              {#if editing}
                <input class="input num" type="number" min="0" step="0.01"
                  bind:value={draft.quantity} placeholder="0" />
              {:else if !isGeneric}
                <!-- View mode: - and + right here, saved after a short
                     pause so a run of taps is one write. Reaching 0 marks
                     it out of stock. An untracked amount shows a dash, not
                     "Not set", so the card reads cleanly. -->
                <div class="stepper">
                  <button type="button" class="step-btn" on:click={() => stepStock(-1)} disabled={!canStepDown}
                    aria-label={$_('pantry_item_sheet_ui.on_hand_less')}>
                    <span class="material-symbols-rounded">remove</span>
                  </button>
                  <span class="stat-value step-value" aria-live="polite">
                    {#if item.quantity == null || item.quantity === ''}
                      <span class="muted">—</span>
                    {:else}
                      {item.quantity}
                    {/if}
                  </span>
                  <button type="button" class="step-btn" on:click={() => stepStock(1)}
                    aria-label={$_('pantry_item_sheet_ui.on_hand_more')}>
                    <span class="material-symbols-rounded">add</span>
                  </button>
                </div>
              {:else}
                <div class="stat-value">
                  {#if item.quantity == null}
                    <span class="muted">—</span>
                  {:else}
                    {item.quantity}
                  {/if}
                </div>
              {/if}
            </div>
            <div class="stat">
              <div class="stat-label">{$_('pantry_sheet_extra.serving_size')}</div>
              {#if editing}
                <div class="stat-edit">
                  <input class="input num" type="number" min="0" step="any"
                    bind:value={draft.serving_size} on:input={onServingSizeInput} placeholder="100" />
                  <UnitPicker bind:value={draft.serving_unit} placeholder="g" />
                  <!-- Proportional-scaling toggle lives at the end of
                       the serving-size row, matching NT's FoodEditor
                       layout so users switching between the two apps
                       find the affordance in the same place. -->
                  <button type="button" class="btn-icon link-btn" class:linked
                    title={linked ? $_('pantry_item_sheet_ui.linked') : $_('pantry_item_sheet_ui.unlinked')}
                    aria-label={$_('pantry_item_sheet_ui.toggle_scaling')}
                    on:click={() => linked = !linked}>
                    <span class="material-symbols-rounded">{linked ? 'link' : 'link_off'}</span>
                  </button>
                </div>
              {:else}
                <div class="stat-value">
                  {#if item.serving_size}
                    {item.serving_size} {item.serving_unit || 'g'}
                  {:else}
                    <span class="muted">{$_('pantry_sheet_extra.not_set')}</span>
                  {/if}
                </div>
              {/if}
            </div>
          </div>

          {#if hasNutrition && !editing}
            <div class="nutrition-wrap">
              <NutritionFactsBox nutrition={item.nutrition} servingDescription={servingDescription} />
            </div>
          {/if}
          {#if editing}
            <div class="nutrient-edit">
              <div class="nutrient-edit-head">
                <span class="field-label">{$_('pantry_sheet_extra.nutrition')} <span class="muted">{$_('pantry_sheet_extra.per_serving')}</span></span>
                <div class="nutrient-edit-actions">
                  {#if $aiEffectivelyEnabled}
                    <!-- Pill matches NT FoodEditor: photo_camera icon +
                         "Scan Label" text, progress_activity + "Scanning…"
                         while the vision call is in flight. Same styling
                         and copy so users switching between the two apps
                         see the identical control. -->
                    <button class="scan-label-btn" on:click={scanLabel} disabled={scanningLabel}
                      title={$_('pantry_item_sheet_ui.scan_label_title')}
                      aria-label={$_('pantry_item_sheet_ui.scan_label_aria')}>
                      <span class="material-symbols-rounded scan-icon" class:spin={scanningLabel}>
                        {scanningLabel ? 'progress_activity' : 'document_scanner'}
                      </span>
                      <span>{scanningLabel ? $_('pantry_item_sheet_ui.scanning') : $_('pantry_item_sheet_ui.scan_label')}</span>
                    </button>
                  {/if}
                </div>
              </div>
              <!-- Hidden file input used by scanNutritionLabel on the
                   web fallback path. Native uses @capacitor/camera and
                   ignores this element. -->
              <input type="file" accept="image/*" capture="environment"
                bind:this={scanLabelFileInput} style="display:none" />
              <div class="nutrient-grid">
                <!-- A refresh replaces the numbers: the inputs read them only when drawn. -->
                {#key nutritionRev}
                {#each visibleInlineNutriments as n}
                  {@const derived = (n.id === 'sodium' || n.id === 'salt') && isDerived(draft.nutrition, n.id)}
                  <label class="nutrient-row">
                    <span class="nutrient-name">
                      {n.label}
                      {#if derived}
                        <span class="material-symbols-rounded derived-badge"
                          title={n.id === 'sodium' ? $_('pantry_item_sheet_ui.derived_sodium') : $_('pantry_item_sheet_ui.derived_salt')}>calculate</span>
                      {/if}
                    </span>
                    <span class="nutrient-input">
                      <input class="input" type="number" min="0" step="any"
                        value={_getNutrient(n.id)}
                        on:input={(e) => _setNutrient(n.id, e.target.value)}
                        placeholder="0" />
                      <span class="nutrient-unit">{n.unit}</span>
                    </span>
                  </label>
                {/each}
                {/key}
              </div>
              <!-- Full-width ghost button under the nutrient grid,
                   matching NT FoodEditor's "Show all nutrients" spot.
                   CookTrace opens a sheet with the full nutrient list
                   for editing, so the label stays "Edit All Nutrients"
                   rather than NT's inline "Show all / Show less". -->
              <button class="btn btn-ghost all-nutrients-btn"
                on:click={() => allNutrientsOpen = true}>
                {$_('pantry_item_sheet_ui.edit_all_nutrients')}
              </button>
            </div>
          {/if}
        </div>
      </div>

      {#if editing}
        {#if !isGeneric}
          <label class="field full">
            <span class="field-label">{$_('pantry_sheet.expires_on')} <span class="field-hint-inline">{$_('pantry_sheet.expires_on_hint')}</span></span>
            <DateInput bind:value={draft.expires_on} />
          </label>
        {:else}
          <div class="field full expires-hint-row">
            <span class="material-symbols-rounded">event</span>
            <span>{$_('pantry_item_sheet_ui.expiry_per_variant')}</span>
          </div>
        {/if}
        <label class="field full">
          <span class="field-label">{$_('recipe.notes')}</span>
          <textarea class="input" dir="auto" rows="3" bind:value={draft.notes}
            placeholder={$_('pantry_item_sheet_ui.notes_placeholder')}></textarea>
        </label>
      {:else}
        {#if isGeneric}
          {@const earliest = _earliestVariantExpiry()}
          {#if earliest}
            <div class="expires-row" class:warn={earliest.status === 'warn'} class:past={earliest.status === 'past'}>
              <span class="material-symbols-rounded">{earliest.status === 'past' ? 'event_busy' : 'event'}</span>
              <span class="expires-label">
                {$_(earliest.status === 'past' ? 'pantry_item_sheet_ui.earliest_variant_past' : 'pantry_item_sheet_ui.earliest_variant', { values: { name: _displayVariantName(earliest.kid, item, { nested: false }), date: _formatExpiry(earliest.kid.expires_on) } })}
              </span>
            </div>
          {/if}
        {:else if item.expires_on}
          {@const expiryStatus = _expiryStatus(item.expires_on)}
          <div class="expires-row" class:warn={expiryStatus === 'warn'} class:past={expiryStatus === 'past'}>
            <span class="material-symbols-rounded">{expiryStatus === 'past' ? 'event_busy' : 'event'}</span>
            <span class="expires-label">{$_(expiryStatus === 'past' ? 'pantry_item_sheet_ui.expires_on_past' : 'pantry_item_sheet_ui.expires_on', { values: { date: _formatExpiry(item.expires_on) } })}</span>
          </div>
        {/if}
        {#if item.notes}
          <div class="notes">
            <div class="notes-label">{$_('recipe.notes')}</div>
            <p class="notes-body" dir="auto">{item.notes}</p>
          </div>
        {/if}
      {/if}

      <!-- Allergens: from the label, or set here. Recipes that use the
           item pick them up (lib/allergens.js). -->
      {#if editing && draft}
        <div class="field full">
          <PantryAllergens allergens={draft.allergens ?? null} traces={draft.traces ?? null} source={draft.allergens_source ?? null}
            members={householdMembers} on:change={e => { draft = { ...draft, ...e.detail }; }} />
        </div>
      {:else if item && !loading}
        <div class="field full">
          <PantryAllergens allergens={item.allergens ?? null} traces={item.traces ?? null} source={item.allergens_source ?? null}
            members={householdMembers} on:change={saveAllergens} />
        </div>
      {/if}

      <!-- Used In (#60): the recipes that use this item, each one opens.
           Read view only; the card's pill opens the sheet here. -->
      {#if item?.id != null && !loading && !editing}
        <section class="used-in" class:flash={usedInFlash} bind:this={usedInEl} aria-labelledby="used-in-title">
          <div class="used-in-head">
            <span class="material-symbols-rounded">restaurant</span>
            <h3 id="used-in-title" class="used-in-title">{$_('pantry_item_sheet_ui.used_in')}</h3>
            {#if usedInState === 'ready' && usedIn.direct.length}
              <span class="used-in-count">{usedIn.direct.length}</span>
            {/if}
          </div>

          {#if usedInState === 'loading' || usedInState === 'idle'}
            <div class="used-in-list" aria-hidden="true">
              {#each [0, 1] as _row}<div class="used-in-skel"></div>{/each}
            </div>
          {:else if usedInState === 'offline'}
            <p class="used-in-note">{$_('pantry_item_sheet_ui.used_in_offline')}</p>
          {:else if usedInState === 'error'}
            <p class="used-in-note">
              {$_('pantry_item_sheet_ui.used_in_failed')}
              <button type="button" class="used-in-retry" on:click={() => _loadUsedIn(item.id)}>{$_('pantry_item_sheet_ui.used_in_retry')}</button>
            </p>
          {:else}
            {#if usedIn.direct.length}
              <ul class="used-in-list">
                {#each usedInShown as r (r.id)}
                  <li>
                    <button type="button" class="used-in-row" on:click={() => _openRecipe(r)}
                      aria-label={$_('pantry_item_sheet_ui.open_recipe', { values: { name: r.name } })}>
                      {#if r.imgUrl}
                        <img class="used-in-thumb" src={r.imgUrl} alt="" loading="lazy" />
                      {:else}
                        <span class="used-in-thumb stub"><span class="material-symbols-rounded">restaurant_menu</span></span>
                      {/if}
                      <span class="used-in-name" dir="auto">{r.name}</span>
                      <span class="material-symbols-rounded used-in-chevron">chevron_right</span>
                    </button>
                  </li>
                {/each}
              </ul>
              {#if usedIn.direct.length > USED_IN_SHOWN}
                <button type="button" class="used-in-more" on:click={() => usedInAll = !usedInAll} aria-expanded={usedInAll}>
                  {usedInAll ? $_('pantry_item_sheet_ui.used_in_fewer') : $_('pantry_item_sheet_ui.used_in_all', { values: { n: usedIn.direct.length } })}
                </button>
              {/if}
            {:else if !usedIn.through.length}
              <p class="used-in-note">{$_('pantry_item_sheet_ui.used_in_none')}</p>
            {/if}

            {#if usedIn.through.length}
              <div class="used-in-sub">
                {isVariant
                  ? $_('pantry_item_sheet_ui.used_in_through_generic', { values: { name: variantContext.parentName || usedIn.through[0].via.name } })
                  : $_('pantry_item_sheet_ui.used_in_through_variants')}
              </div>
              <ul class="used-in-list">
                {#each usedIn.through as r (r.id)}
                  <li>
                    <button type="button" class="used-in-row" on:click={() => _openRecipe(r)}
                      aria-label={$_('pantry_item_sheet_ui.open_recipe', { values: { name: r.name } })}>
                      {#if r.imgUrl}
                        <img class="used-in-thumb" src={r.imgUrl} alt="" loading="lazy" />
                      {:else}
                        <span class="used-in-thumb stub"><span class="material-symbols-rounded">restaurant_menu</span></span>
                      {/if}
                      <span class="used-in-name" dir="auto">
                        {r.name}
                        {#if !isVariant}<span class="used-in-via">{$_('pantry_item_sheet_ui.used_in_via', { values: { name: _viaName(r.via, variantContext) } })}</span>{/if}
                      </span>
                      <span class="material-symbols-rounded used-in-chevron">chevron_right</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        </section>
      {/if}

      <!-- Variants section (Issue #4). Visible only on a saved item
           (not during Create) so the new item's id exists for links. -->
      {#if item?.id != null && !loading}
        <div class="variants">
          <div class="variants-head">
            <span class="material-symbols-rounded">category</span>
            <span class="variants-title">{$_('pantry_sheet.variants')}</span>
          </div>

          {#if isVariant}
            <p class="variants-note">
              {$_('pantry_item_sheet_ui.variant_of_prefix')} <strong>{variantContext.parentName || $_('pantry_item_sheet_ui.generic_fallback')}</strong>{$_('pantry_item_sheet_ui.variant_of_suffix')}
            </p>
            <div class="variants-actions">
              <button class="btn btn-secondary" on:click={_detachVariant}>
                <span class="material-symbols-rounded">link_off</span>
                {$_('pantry_item_sheet_ui.detach_from', { values: { parent: variantContext.parentName || $_('pantry_item_sheet_ui.parent_label') } })}
              </button>
            </div>

          {:else if isGeneric}
            <p class="variants-note">
              {$_('pantry_item_sheet_ui.generic_note', { values: { n: variantContext.children.length } })}
            </p>
            <ul class="variant-list">
              {#each variantContext.children as v (v.id)}
                {@const vExpStatus = _expiryStatus(v.expires_on)}
                <li class="variant-row">
                  <span class="material-symbols-rounded variant-row-icon">label</span>
                  <span class="variant-row-name" dir="auto">{_displayVariantName(v, item, { nested: true })}</span>
                  {#if !v.in_stock}
                    <span class="variant-row-chip variant-row-chip-out" title={$_('pantry_item_sheet_ui.out_of_stock')}>{$_('pantry.filters.out')}</span>
                  {/if}
                  {#if v.expires_on}
                    <span class="variant-row-chip"
                      class:variant-row-chip-warn={vExpStatus === 'warn'}
                      class:variant-row-chip-past={vExpStatus === 'past'}
                      title={$_('pantry_item_sheet_ui.expires_on', { values: { date: _formatExpiry(v.expires_on) } })}>
                      <span class="material-symbols-rounded variant-row-chip-icon">{vExpStatus === 'past' ? 'event_busy' : 'schedule'}</span>
                      {_formatExpiry(v.expires_on)}
                    </span>
                  {/if}
                </li>
              {/each}
            </ul>

            {#if !addingVariantRow}
              <div class="nutrition-source">
                <div class="nutrition-source-head">{$_('pantry_sheet_extra.recipe_nutrition_source')}</div>
                <p class="nutrition-source-hint">
                  {$_('pantry_item_sheet_ui.nutrition_source_hint')}
                </p>
                <label class="nutrition-source-row">
                  <input type="radio" name="nutrition-source"
                    checked={item.nutrition_source_variant_id == null}
                    on:change={() => _setNutritionSource(null)} />
                  <span class="nutrition-source-label">
                    <span class="nutrition-source-title">{$_('pantry_item_sheet_ui.nutrition_source_manual')}</span>
                  </span>
                </label>
                {#each variantContext.children as v (v.id)}
                  <label class="nutrition-source-row">
                    <input type="radio" name="nutrition-source"
                      checked={item.nutrition_source_variant_id === v.id}
                      on:change={() => _setNutritionSource(v.id)} />
                    <span class="nutrition-source-label">
                      <span class="nutrition-source-title">{$_('pantry_item_sheet_ui.nutrition_source_from', { values: { name: _displayVariantName(v, item, { nested: false }) } })}</span>
                    </span>
                  </label>
                {/each}
              </div>
            {/if}
            {#if addingVariantRow}
              <div class="variant-add-card">
                <div class="variant-add-head">{$_('pantry_sheet_extra.add_a_variant')}</div>
                <p class="variant-add-hint">
                  {$_('pantry_item_sheet_ui.add_variant_hint')}
                </p>
                <div class="variant-add">
                  <input class="input" type="text" dir="auto" placeholder={$_('pantry_item_sheet_ui.brand_or_store_placeholder')}
                    bind:value={newVariantBrand}
                    on:keydown={e => { if (e.key === 'Enter') _addNewVariant(); }} />
                  {#if addVariantSuggestions.length}
                    <ul class="variant-suggest">
                      {#each addVariantSuggestions as s (s.id)}
                        <li>
                          <button class="variant-suggest-row" on:click={() => _addExistingAsVariant(s.id)}>
                            <span class="material-symbols-rounded">link</span>
                            <span class="variant-suggest-name" dir="auto">{s.name}{s.brand ? ' (' + s.brand + ')' : ''}</span>
                            <span class="variant-suggest-meta">{$_('pantry_sheet_extra.attach_as_variant')}</span>
                          </button>
                        </li>
                      {/each}
                    </ul>
                  {:else if newVariantBrand.trim()}
                    <p class="variant-add-empty">{$_('pantry_item_sheet_ui.no_match_new_variant')}</p>
                  {/if}
                  {#if newVariantNameOverride}
                    <input class="input variant-add-name" dir="auto" type="text"
                      placeholder={$_('pantry_item_sheet_ui.override_name_placeholder')}
                      bind:value={newVariantName}
                      on:keydown={e => { if (e.key === 'Enter') _addNewVariant(); }} />
                  {/if}
                  <div class="variant-add-actions">
                    {#if !newVariantNameOverride}
                      <button class="btn-link variant-name-toggle" on:click={() => { newVariantNameOverride = true; }}>
                        {$_('pantry_item_sheet_ui.use_different_name')}
                      </button>
                    {/if}
                    <span class="variant-add-spacer"></span>
                    <button class="btn btn-secondary" on:click={() => { addingVariantRow = false; newVariantBrand = ''; newVariantName = ''; newVariantNameOverride = false; }}>{$_('pantry_sheet_extra.cancel')}</button>
                    <button class="btn btn-primary" on:click={_addNewVariant} disabled={!newVariantBrand.trim() && !(newVariantNameOverride && newVariantName.trim())}>{#if newVariantBrand.trim()}{$_('pantry_item_sheet_ui.create_named', { values: { name: newVariantBrand.trim() } })}{:else if newVariantNameOverride && newVariantName.trim()}{$_('pantry_item_sheet_ui.create_named', { values: { name: newVariantName.trim() } })}{:else}{$_('pantry_item_sheet_ui.create_variant')}{/if}</button>
                  </div>
                </div>
              </div>
            {:else}
              <div class="variants-actions">
                <button class="btn btn-primary" on:click={() => { addingVariantRow = true; newVariantBrand = ''; newVariantName = ''; newVariantNameOverride = false; }}>
                  <span class="material-symbols-rounded">add</span>
                  {$_('pantry_item_sheet_ui.add_variant')}
                </button>
              </div>
            {/if}

          {:else}
            <p class="variants-note">
              {$_('pantry_item_sheet_ui.flat_note')}
            </p>
            {#if addingVariantRow}
              <div class="variant-add-card">
                <div class="variant-add-head">{$_('pantry_sheet_extra.add_a_variant')}</div>
                <p class="variant-add-hint">
                  {$_('pantry_item_sheet_ui.add_variant_hint')}
                </p>
                <div class="variant-add">
                  <input class="input" type="text" dir="auto" placeholder={$_('pantry_item_sheet_ui.brand_or_store_placeholder')}
                    bind:value={newVariantBrand}
                    on:keydown={e => { if (e.key === 'Enter') _addNewVariant(); }} />
                  {#if addVariantSuggestions.length}
                    <ul class="variant-suggest">
                      {#each addVariantSuggestions as s (s.id)}
                        <li>
                          <button class="variant-suggest-row" on:click={() => _addExistingAsVariant(s.id)}>
                            <span class="material-symbols-rounded">link</span>
                            <span class="variant-suggest-name" dir="auto">{s.name}{s.brand ? ' (' + s.brand + ')' : ''}</span>
                            <span class="variant-suggest-meta">{$_('pantry_sheet_extra.attach_as_variant')}</span>
                          </button>
                        </li>
                      {/each}
                    </ul>
                  {:else if newVariantBrand.trim()}
                    <p class="variant-add-empty">{$_('pantry_item_sheet_ui.no_match_new_variant')}</p>
                  {/if}
                  {#if newVariantNameOverride}
                    <input class="input variant-add-name" dir="auto" type="text"
                      placeholder={$_('pantry_item_sheet_ui.override_name_placeholder')}
                      bind:value={newVariantName}
                      on:keydown={e => { if (e.key === 'Enter') _addNewVariant(); }} />
                  {/if}
                  <div class="variant-add-actions">
                    {#if !newVariantNameOverride}
                      <button class="btn-link variant-name-toggle" on:click={() => { newVariantNameOverride = true; }}>
                        {$_('pantry_item_sheet_ui.use_different_name')}
                      </button>
                    {/if}
                    <span class="variant-add-spacer"></span>
                    <button class="btn btn-secondary" on:click={() => { addingVariantRow = false; newVariantBrand = ''; newVariantName = ''; newVariantNameOverride = false; }}>{$_('pantry_sheet_extra.cancel')}</button>
                    <button class="btn btn-primary" on:click={_addNewVariant} disabled={!newVariantBrand.trim() && !(newVariantNameOverride && newVariantName.trim())}>{#if newVariantBrand.trim()}{$_('pantry_item_sheet_ui.create_named', { values: { name: newVariantBrand.trim() } })}{:else if newVariantNameOverride && newVariantName.trim()}{$_('pantry_item_sheet_ui.create_named', { values: { name: newVariantName.trim() } })}{:else}{$_('pantry_item_sheet_ui.create_variant')}{/if}</button>
                  </div>
                </div>
              </div>
              {#if item.expires_on}
                <p class="variants-note variants-hint">
                  {$_('pantry_item_sheet_ui.promote_expiry_hint', { values: { date: _formatExpiry(item.expires_on) } })}
                </p>
              {/if}
            {:else}
              <div class="variants-actions">
                <button class="btn btn-primary" on:click={() => { addingVariantRow = true; newVariantBrand = ''; newVariantName = ''; newVariantNameOverride = false; }}>
                  <span class="material-symbols-rounded">add</span>
                  {$_('pantry_item_sheet_ui.add_variant')}
                </button>
                <button class="btn btn-secondary" on:click={() => _openPicker('set-parent')}>
                  <span class="material-symbols-rounded">subdirectory_arrow_right</span>
                  {$_('pantry_item_sheet_ui.make_variant_of')}
                </button>
              </div>
            {/if}
          {/if}
        </div>
      {/if}

      <!-- Footer actions moved to the sheet header (icon buttons next
           to the X close, mirroring RecipeView) for uniform detail-
           surface chrome. -->
    </div>
  {/if}
</Sheet>

<!-- Full-nutrient sub-sheet (stacked on top of the main sheet). -->
{#if editing && draft}
  <Sheet bind:open={allNutrientsOpen} title={$_('pantry_item_sheet_ui.all_nutrients')} height="full">
    <p class="all-nutrients-hint">
      {$_('pantry_item_sheet_ui.all_nutrients_hint')}
    </p>
    <div class="all-nutrients-grid">
      {#each NUTRIMENTS as n}
        <label class="nutrient-row">
          <span class="nutrient-name">
            {n.label}
            {#if n.subOf}<span class="nutrient-sub">({n.category})</span>{/if}
          </span>
          <span class="nutrient-input">
            <input class="input" type="number" min="0" step="any"
              value={_getNutrient(n.id)}
              on:input={(e) => _setNutrient(n.id, e.target.value)}
              placeholder="0" />
            <span class="nutrient-unit">{n.unit}</span>
          </span>
        </label>
      {/each}
    </div>
    <div class="all-nutrients-footer">
      <button class="btn btn-primary" on:click={() => allNutrientsOpen = false}>{$_('pantry_sheet_extra.done')}</button>
    </div>
  </Sheet>
{/if}

<!-- New-category dialog (stacked over the sheet). -->
<Sheet bind:open={categoryNewOpen} title={$_('pantry_item_sheet_ui.new_category_title')} height="auto">
  <div class="newcat-body">
    <label class="field-label">{$_('pantry_sheet_extra.name')}</label>
    <input class="input" type="text" dir="auto" bind:value={categoryNewName} placeholder={$_('pantry_sheet_extra.cat_new_name_ph')} />
    <label class="field-label" style="margin-top:10px">{$_('pantry_item_sheet_ui.icon_label')}</label>
    <input class="input" type="text" bind:value={categoryNewIcon} placeholder="kitchen" />
    <p class="field-hint">{@html $_('pantry_sheet_extra.cat_field_hint_html')}</p>
    <div class="newcat-actions">
      <button class="btn btn-secondary" on:click={() => categoryNewOpen = false}>{$_('pantry_sheet_extra.cancel')}</button>
      <button class="btn btn-primary" on:click={confirmNewPantryCategory}>{$_('pantry_sheet_extra.create')}</button>
    </div>
  </div>
</Sheet>

<!-- Variant picker (Issue #4). Stacked over the main sheet. Reused for
     both "Make this a variant of..." (set-parent) and the generic's
     "Link an Existing Item" (add-existing-child) flow. -->
<Sheet bind:open={variantPickerOpen} title={variantPickerMode === 'set-parent' ? $_('pantry_item_sheet_ui.make_variant_of') : $_('pantry_item_sheet_ui.link_existing')} height="auto">
  <div class="variant-picker-body">
    <p class="field-hint">
      {variantPickerMode === 'set-parent'
        ? $_('pantry_item_sheet_ui.picker_hint_parent')
        : $_('pantry_item_sheet_ui.picker_hint_child')}
    </p>
    <input class="input" type="search" dir="auto" placeholder={$_('pantry.search_placeholder')}
      bind:value={variantPickerQuery} autofocus />
    <ul class="variant-picker-list">
      {#each variantPickerResults as r (r.id)}
        <li>
          <button class="variant-picker-row" on:click={() => variantPickerMode === 'set-parent' ? _setGenericParent(r.id) : _addExistingAsVariant(r.id)}>
            <span class="variant-picker-name" dir="auto">{r.name}</span>
            {#if r.brand}<span class="variant-picker-meta">{r.brand}</span>{/if}
          </button>
        </li>
      {:else}
        <li class="variant-picker-empty">{$_('pantry_item_sheet_ui.no_matching_items')}</li>
      {/each}
    </ul>
    <div class="variant-picker-actions">
      <button class="btn btn-secondary" on:click={() => variantPickerOpen = false}>{$_('pantry_sheet_extra.cancel')}</button>
    </div>
  </div>
</Sheet>

<!-- Inline barcode scanner. -->
<BarcodeScanner bind:open={editorScannerOpen} on:scan={onScan} on:close={() => editorScannerOpen = false} />

<!-- Variant-aware delete confirmation. Only opens when the user hits
     delete on a generic that has children. Lets them pick whether the
     variants survive as standalone items or get removed together. -->
{#if item && isGeneric}
  <Dialog
    bind:open={deleteWithVariantsOpen}
    title={$_('pantry_item_sheet_ui.remove_named_title', { values: { name: item.name } })}
    confirmText={$_('pantry_item_sheet_ui.remove')}
    cancelText={$_('common.cancel')}
    dangerous={true}
    on:confirm={_confirmVariantDelete}
    on:cancel={() => deleteWithVariantsOpen = false}
  >
    <p class="variant-delete-msg">
      {$_('pantry_item_sheet_ui.variant_delete_msg', { values: { n: variantContext.children.length } })}
    </p>
    <label class="variant-delete-row">
      <input type="radio" name="variant-delete-mode"
        checked={!deleteCascade}
        on:change={() => deleteCascade = false} />
      <span class="variant-delete-label">
        <span class="variant-delete-title">{$_('pantry_sheet_extra.keep_standalone')}</span>
        <span class="variant-delete-hint">{$_('pantry_item_sheet_ui.keep_standalone_hint')}</span>
      </span>
    </label>
    <label class="variant-delete-row">
      <input type="radio" name="variant-delete-mode"
        checked={deleteCascade}
        on:change={() => deleteCascade = true} />
      <span class="variant-delete-label">
        <span class="variant-delete-title">{$_('pantry_sheet_extra.remove_variants_too')}</span>
        <span class="variant-delete-hint">{$_('pantry_item_sheet_ui.remove_variants_hint', { values: { n: variantContext.children.length } })}</span>
      </span>
    </label>
  </Dialog>
{/if}

<style>
  .state { padding: 40px 0; display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--text-3); }
  .state.error { color: var(--danger); }
  .spin { animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .sheet-content { display: flex; flex-direction: column; gap: 14px; padding: 4px 4px 12px; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
  .col-identity {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  /* Hero photo + stub sit inside a rounded wrapper with overflow
     hidden, so any white-background photo gets cleanly clipped at the
     rounded corners — mirroring ImagePicker's preview-wrap in edit
     mode so view and edit feel identical. */
  .hero-wrap {
    width: calc(100% - 16px);
    aspect-ratio: 1 / 1;
    margin: 8px;
    background: var(--surface-2);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex; align-items: center; justify-content: center;
  }
  .hero-photo {
    width: 100%; height: 100%;
    object-fit: cover;
    display: block;
  }
  .hero-stub {
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
  }
  .hero-stub .material-symbols-rounded { font-size: 64px; color: var(--text-3); }
  .identity-info { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
  .col-data { display: flex; flex-direction: column; gap: 12px; }
  .brand { color: var(--text-3); font-size: 13px; font-weight: 500; }
  .meta-pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .pill {
    display: inline-flex; align-items: center; gap: 4px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: var(--radius-full, 99px);
    padding: 3px 9px; font-size: 11px; font-weight: 600;
  }
  .pill.subtle { background: var(--surface-2); color: var(--text-3); border-color: var(--border); }
  .pill .material-symbols-rounded { font-size: 14px; }
  .pill.in {
    background: color-mix(in srgb, var(--success, #4caf50) 14%, transparent);
    color: var(--success, #4caf50);
    border-color: color-mix(in srgb, var(--success, #4caf50) 35%, transparent);
  }
  .pill.out {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 35%, transparent);
  }

  /* Stats — two bordered stat cards side-by-side. On Hand stays
     narrow (just a qty number); Serving Size takes the remaining
     width so its [num][unit picker] row fits comfortably. */
  /* In Stock as a switch (#60): the pill, with a small track whose knob
     slides across. Same colors as the read-only pill it replaced. */
  .stock-switch {
    font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
    padding: 3px 10px 3px 4px; gap: 6px;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .stock-switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .switch-track {
    position: relative; flex: 0 0 auto;
    width: 26px; height: 16px; border-radius: 999px;
    background: color-mix(in srgb, currentColor 30%, transparent);
    transition: background var(--dur-fast);
  }
  .switch-knob {
    position: absolute; top: 2px; left: 2px;
    width: 12px; height: 12px; border-radius: 50%;
    background: var(--surface-1);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .stock-switch.in .switch-track { background: currentColor; }
  .stock-switch.in .switch-knob { transform: translateX(10px); }
  @media (prefers-reduced-motion: reduce) {
    .switch-knob, .switch-track, .stock-switch { transition: none; }
  }

  /* On Hand - and + in the read view. */
  .stepper { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
  .step-value { flex: 1; text-align: center; font-variant-numeric: tabular-nums; }
  .step-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; flex: 0 0 32px; padding: 0;
    border-radius: 50%; border: 1px solid var(--border);
    background: var(--surface-2); color: var(--text-1); cursor: pointer;
    transition: background var(--dur-fast), border-color var(--dur-fast);
  }
  .step-btn .material-symbols-rounded { font-size: 18px; }
  .step-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .step-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .step-btn:disabled { opacity: 0.35; cursor: default; }

  .stats { display: flex; flex-direction: row; gap: 8px; align-items: stretch; }
  .stat {
    min-width: 0;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px 14px;
    display: flex; flex-direction: column; gap: 6px;
  }
  /* On Hand: fixed-narrow. Serving Size: fills the rest. */
  .stat:first-child  { flex: 0 0 132px; padding: 12px 10px; }
  .stat:last-child   { flex: 1 1 0; }
  /* On Hand's number input fills its (narrow) card. */
  .stat > .input.num { width: 100%; max-width: 100%; }
  .stat-label .muted { color: var(--text-3); font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: 4px; }
  .stat-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }
  .stat-value { font-size: 16px; font-weight: 700; color: var(--text-1); }
  .stat-value .muted { color: var(--text-3); font-weight: 400; font-size: 14px; }
  .stat-sub { font-size: 12px; color: var(--text-3); }


  .nutrition-wrap { display: flex; justify-content: center; }

  .notes {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px 14px;
  }
  .notes-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); margin-bottom: 4px; }
  .notes-body { margin: 0; color: var(--text-2); font-size: 14px; line-height: 1.5; white-space: pre-wrap; unicode-bidi: plaintext; }

  .actions {
    display: flex; gap: 8px; justify-content: space-between;
    padding-top: 4px;
  }
  .actions .btn {
    flex: 1; height: 44px; font-size: 14px;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  }
  .actions .btn .material-symbols-rounded { font-size: 18px; }
  .danger-btn {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
  }
  .danger-btn:hover {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
  }

  /* ── Edit-mode form bits ───────────────────────────────────────── */
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field.full { grid-column: 1 / -1; }
  .field.tight { margin-top: 6px; }
  .field-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
  }
  /* Inline Clear link inside the field label — appears when a value is
     set so the user can wipe a Combobox / Category selection that no
     longer applies. */
  .field-clear {
    background: transparent; border: none; cursor: pointer;
    color: var(--accent); font-size: 11px; font-weight: 600;
    text-transform: none; letter-spacing: 0; padding: 0;
  }
  .field-clear:hover { text-decoration: underline; }
  .field-hint { font-size: 11px; color: var(--text-3); line-height: 1.4; margin: 4px 0 0; }
  .input {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    color: var(--text-1); font-size: 14px;
    box-sizing: border-box; width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .input.num { font-variant-numeric: tabular-nums; }
  textarea.input { resize: vertical; min-height: 60px; font-family: inherit; }

  /* Barcode input + inline scan icon. */
  .barcode-wrap { position: relative; display: flex; }
  .barcode-input { padding-right: 44px; }
  .barcode-scan-inline {
    position: absolute; right: 4px; top: 50%;
    transform: translateY(-50%);
    width: 36px; height: 36px;
    border: none; background: transparent;
    color: var(--text-3); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .barcode-scan-inline:hover { color: var(--accent); }

  /* OFF action buttons. Wrap to a second row when the column is too
     narrow for both to sit side-by-side comfortably (mobile view). */
  .off-actions { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
  .off-btn {
    flex: 1 1 calc(50% - 3px); min-width: 0;
    font-size: 12px; padding: 8px 10px; height: 36px;
    display: inline-flex; align-items: center; justify-content: center;
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  }
  .off-btn-ico { font-size: 14px; vertical-align: middle; margin-right: 3px; flex-shrink: 0; }
  .off-verify-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; font-size: 12px; padding: 6px 2px 0;
  }
  .off-verify-ico { font-size: 14px; vertical-align: middle; margin-right: 4px; }
  .off-verify-checking { color: var(--text-3); }
  .off-verify-ok { color: var(--success, #4caf50); }
  .off-verify-pending { color: var(--text-3); }

  /* Stat-cell edit row: horizontal flow with wrap. Number stays
     compact (~90px), the unit picker takes ~130px so "cup ▾" fits,
     and any trailing free-text input (`.input.grow`) eats the
     remaining space. Wraps to a second line when the row can't hold
     it all. The :global(.unit-picker) rule is required because the
     global forms.css `.input { width: 100% }` would otherwise make
     the UnitPicker claim full width and wrap below the number. */
  .stat-edit { display: flex; gap: 6px; align-items: stretch; flex-wrap: nowrap; }
  .stat-edit .input.num { flex: 0 0 90px; width: 90px; min-width: 0; }
  .stat-edit .input.grow { flex: 1 1 140px; min-width: 0; }
  /* Unit picker grows into remaining cell width and shrinks freely
     so [num][unit] always stays on the same row inside the Serving
     Size card. */
  .stat-edit :global(.unit-picker) { flex: 1 1 0; min-width: 60px; }
  .stat-edit :global(.unit-picker .input) { width: 100%; }
  .stat-edit > :global(*) { min-width: 0; }
  .nutrient-edit-actions { display: inline-flex; align-items: center; gap: 8px; }
  /* Full-width ghost button under the nutrient grid — mirrors NT
     FoodEditor's "Show all nutrients" placement so the two forms
     look interchangeable when you're switching between the apps. */
  .all-nutrients-btn {
    width: 100%;
    margin-top: 8px;
  }
  /* Serving-size row link toggle — matches NT FoodEditor's
     .link-btn (icon-only, accent color when linked). Same 20px glyph
     so it reads at the same weight as the serving-size input. */
  .link-btn {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
    transition: color var(--dur-fast);
  }
  .link-btn:hover { color: var(--text-1); background: var(--surface-2); }
  .link-btn.linked { color: var(--accent); }
  .link-btn .material-symbols-rounded { font-size: 20px; }
  /* Scan Label — pill button matching NT FoodEditor exactly. Neutral
     surface (not accent-tinted); text + icon; sits at the right end
     of the Nutrition card header. */
  .scan-label-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 12px;
    border-radius: var(--radius-md);
    background: var(--surface-2);
    color: var(--text-1);
    border: 1px solid var(--border);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out);
  }
  .scan-label-btn:hover:not(:disabled) { background: var(--surface-3, var(--surface-2)); }
  .scan-label-btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .scan-label-btn .material-symbols-rounded { font-size: 18px; }
  /* progress_activity glyph rotates while the AI vision call is in
     flight. Same pattern used elsewhere in the app; kept scoped. */
  .scan-icon.spin {
    animation: scan-spin 1s linear infinite;
    display: inline-block;
  }
  @keyframes scan-spin { to { transform: rotate(360deg); } }

  /* Inline nutrient inputs grid. */
  .nutrient-edit {
    display: flex; flex-direction: column; gap: 8px;
    padding: 12px 14px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .nutrient-edit-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .nutrient-edit-head .muted { color: var(--text-3); font-weight: 400; text-transform: none; letter-spacing: 0; }
  .btn-link {
    background: transparent; border: none; padding: 0;
    color: var(--accent); font-size: 12px; font-weight: 600;
    cursor: pointer; font-family: inherit;
  }
  .btn-link:hover { text-decoration: underline; }
  .nutrient-grid { display: flex; flex-direction: column; gap: 4px; }
  .nutrient-row {
    display: grid; grid-template-columns: 1fr auto;
    align-items: center; gap: 8px; font-size: 13px;
  }
  .nutrient-name { color: var(--text-2); display: inline-flex; align-items: center; gap: 4px; }
  .nutrient-sub { color: var(--text-3); font-size: 11px; margin-left: 4px; }
  .nutrient-input { display: inline-flex; align-items: center; gap: 4px; }
  .nutrient-input .input {
    width: 80px; height: 32px;
    padding: 4px 8px; font-size: 13px; text-align: right;
  }
  .nutrient-unit { color: var(--text-3); font-size: 12px; min-width: 24px; }
  .derived-badge { font-size: 14px; color: var(--accent); cursor: help; }

  /* All-nutrient sub-sheet body. */
  .all-nutrients-hint { margin: 0 0 12px; color: var(--text-3); font-size: 13px; line-height: 1.5; }
  .all-nutrients-grid {
    display: grid; grid-template-columns: 1fr;
    gap: 4px; padding-bottom: 16px;
  }
  @media (min-width: 600px) {
    .all-nutrients-grid { grid-template-columns: 1fr 1fr; gap: 4px 24px; }
  }
  .all-nutrients-footer {
    display: flex; justify-content: flex-end;
    padding-top: 8px; border-top: 1px solid var(--border);
    margin-top: 12px;
  }
  .all-nutrients-footer .btn { min-width: 120px; height: 40px; }

  /* New-category dialog body. */
  .newcat-body { display: flex; flex-direction: column; gap: 4px; padding: 8px 4px 12px; }
  .newcat-actions { display: flex; gap: 8px; justify-content: flex-end; padding-top: 12px; }
  .newcat-actions .btn { min-width: 110px; height: 40px; }

  /* Responsive */
  @media (min-width: 768px) {
    .grid {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
      gap: 16px;
      align-items: start;
    }
  }

  /* Variants (Issue #4) */
  /* Used In (#60): the recipes that use the item. Same box as Variants. */
  .used-in {
    margin-top: 16px;
    padding: 12px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    scroll-margin-top: 12px;
    transition: border-color 0.6s var(--ease-out), box-shadow 0.6s var(--ease-out);
  }
  .used-in.flash {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .used-in-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .used-in-head .material-symbols-rounded { color: var(--accent); font-size: 20px; }
  .used-in-title { margin: 0; font-weight: 700; color: var(--text-1); font-size: 14px; }
  .used-in-count {
    font-size: 11px; font-weight: 700; color: var(--text-3);
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 999px; padding: 0 7px; line-height: 18px;
  }
  .used-in-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
  .used-in-row {
    display: flex; align-items: center; gap: 10px; width: 100%;
    min-height: 48px; padding: 6px 8px 6px 6px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-sm); cursor: pointer;
    font: inherit; color: var(--text-1); text-align: left;
    transition: border-color var(--dur-fast), background var(--dur-fast);
  }
  .used-in-row:hover { border-color: var(--accent); }
  .used-in-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .used-in-thumb {
    width: 36px; height: 36px; flex: 0 0 36px;
    border-radius: 8px; object-fit: cover; background: var(--surface-2);
  }
  .used-in-thumb.stub { display: inline-flex; align-items: center; justify-content: center; color: var(--text-3); }
  .used-in-thumb.stub .material-symbols-rounded { font-size: 20px; }
  .used-in-name {
    flex: 1; min-width: 0; font-size: 14px; font-weight: 500;
    display: flex; flex-direction: column; overflow-wrap: anywhere;
  }
  .used-in-via { font-size: 12px; font-weight: 400; color: var(--text-3); }
  .used-in-chevron { color: var(--text-3); font-size: 20px; flex: 0 0 auto; }
  .used-in-more, .used-in-retry {
    background: none; border: none; padding: 8px 2px 0; cursor: pointer;
    font: inherit; font-size: 13px; font-weight: 600; color: var(--accent);
  }
  .used-in-retry { padding: 0; }
  .used-in-note { margin: 0; color: var(--text-3); font-size: 13px; line-height: 1.5; }
  .used-in-sub {
    margin: 12px 0 6px; font-size: 11px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3);
  }
  .used-in-skel {
    height: 48px; border-radius: var(--radius-sm);
    background: linear-gradient(90deg, var(--surface-1) 25%, var(--surface-2) 50%, var(--surface-1) 75%);
    background-size: 200% 100%;
    animation: used-in-shimmer 1.2s linear infinite;
  }
  @keyframes used-in-shimmer { to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) {
    .used-in-skel { animation: none; }
    .used-in { transition: none; }
  }

  .variants {
    margin-top: 16px;
    padding: 12px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .variants-head {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 6px;
  }
  .variants-head .material-symbols-rounded { color: var(--accent); font-size: 20px; }
  .variants-title { font-weight: 700; color: var(--text-1); font-size: 14px; }
  .variants-note { margin: 0 0 10px; color: var(--text-3); font-size: 12px; line-height: 1.5; }
  .variants-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .variants-actions .btn { display: inline-flex; align-items: center; gap: 6px; }
  .variants-actions .btn .material-symbols-rounded { font-size: 16px; }

  .variant-list { list-style: none; padding: 0; margin: 0 0 10px; }
  .variant-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: 4px;
    font-size: 13px;
  }
  .variant-row-icon { font-size: 16px; color: var(--text-3); }
  .variant-row-name { flex: 1; color: var(--text-1); font-weight: 500; }
  .variant-row-meta { color: var(--text-3); font-size: 12px; }
  .variant-row-chip {
    display: inline-flex; align-items: center; gap: 3px;
    font-size: 11px; font-weight: 600;
    padding: 2px 8px; border-radius: 999px;
    background: var(--surface-2); color: var(--text-3);
    border: 1px solid var(--border);
    white-space: nowrap;
  }
  .variant-row-chip-icon { font-size: 13px; }
  .variant-row-chip-warn {
    background: color-mix(in srgb, var(--warn, orange) 14%, transparent);
    color: var(--warn, orange);
    border-color: color-mix(in srgb, var(--warn, orange) 40%, transparent);
  }
  .variant-row-chip-past {
    background: color-mix(in srgb, var(--danger, red) 14%, transparent);
    color: var(--danger, red);
    border-color: color-mix(in srgb, var(--danger, red) 40%, transparent);
  }
  .variant-row-chip-out {
    background: color-mix(in srgb, var(--text-3) 12%, transparent);
    color: var(--text-3);
  }

  .variant-add { display: flex; flex-direction: column; gap: 6px; }
  .variant-add .input { width: 100%; }
  .variant-add-actions { display: flex; gap: 6px; align-items: center; }
  .variant-add-spacer { flex: 1; }
  /* Distinct card around the inline Add Variant form so it doesn't
     visually bleed into the surrounding Recipe nutrition source picker
     (which sits in the same section but is unrelated). */
  .variant-add-card {
    margin-top: 10px;
    padding: 12px;
    background: color-mix(in srgb, var(--accent) 6%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
    border-radius: var(--radius-md);
  }
  .variant-add-head {
    color: var(--text-1);
    font-weight: 700;
    font-size: 12px;
    margin-bottom: 4px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .variant-add-hint {
    color: var(--text-3);
    font-size: 12px;
    line-height: 1.4;
    margin: 0 0 10px;
  }
  .variant-add-empty {
    color: var(--text-3);
    font-size: 12px;
    line-height: 1.4;
    margin: 2px 0 0;
    font-style: italic;
  }

  /* Variant-aware delete dialog inner content. */
  .variant-delete-msg {
    color: var(--text-2);
    font-size: 13px;
    line-height: 1.45;
    margin: 0 0 12px;
  }
  .variant-delete-row {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 6px 0;
    cursor: pointer;
  }
  .variant-delete-row input[type="radio"] { margin-top: 3px; }
  .variant-delete-label { display: flex; flex-direction: column; gap: 2px; }
  .variant-delete-title { color: var(--text-1); font-size: 13px; font-weight: 600; }
  .variant-delete-hint  { color: var(--text-3); font-size: 12px; line-height: 1.4; }
  .variant-name-toggle {
    background: transparent; border: none;
    color: var(--accent);
    font-size: 12px; font-weight: 600;
    cursor: pointer; padding: 0;
  }
  .variant-name-toggle:hover { text-decoration: underline; }

  /* Inline suggestion list under the Add Variant input (Issue #4 UX) */
  .variant-suggest { list-style: none; padding: 0; margin: 0; }
  .variant-suggest li + li { margin-top: 4px; }
  .variant-suggest-row {
    display: flex; align-items: center; gap: 8px;
    width: 100%;
    padding: 8px 10px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: border-color var(--dur-fast), background var(--dur-fast);
  }
  .variant-suggest-row:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--surface-1)); }
  .variant-suggest-row .material-symbols-rounded { font-size: 16px; color: var(--text-3); flex-shrink: 0; }
  .variant-suggest-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
  .variant-suggest-meta { color: var(--text-3); font-size: 12px; }

  .nutrition-source {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .nutrition-source-head {
    color: var(--text-1);
    font-weight: 700;
    font-size: 12px;
    margin-bottom: 4px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .nutrition-source-hint {
    color: var(--text-3);
    font-size: 12px;
    line-height: 1.4;
    margin: 0 0 8px;
  }
  .nutrition-source-row {
    display: flex; gap: 8px; align-items: flex-start;
    padding: 4px 0;
    cursor: pointer;
  }
  .nutrition-source-row input[type="radio"] { margin-top: 3px; }
  .nutrition-source-label { display: flex; flex-direction: column; gap: 1px; }
  .nutrition-source-title { color: var(--text-1); font-size: 13px; font-weight: 500; }

  /* Expiry display in view mode (Issue #9) */
  .expires-row {
    display: flex; align-items: center; gap: 8px;
    margin-top: 12px;
    padding: 8px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-2);
    font-size: 13px;
  }
  .expires-row .material-symbols-rounded { font-size: 18px; color: var(--text-3); }
  .expires-row.warn {
    background: color-mix(in srgb, var(--warning, #f59e0b) 12%, var(--surface-1));
    border-color: color-mix(in srgb, var(--warning, #f59e0b) 35%, var(--border));
    color: var(--warning, #f59e0b);
  }
  .expires-row.warn .material-symbols-rounded { color: var(--warning, #f59e0b); }
  .expires-row.past {
    background: color-mix(in srgb, var(--danger) 12%, var(--surface-1));
    border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
    color: var(--danger);
  }
  .expires-row.past .material-symbols-rounded { color: var(--danger); }
  .field-hint-inline { color: var(--text-3); font-weight: 400; font-size: 11px; margin-left: 6px; }

  .expires-hint-row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px;
    background: var(--surface-2);
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    color: var(--text-3);
    font-size: 12px;
    line-height: 1.4;
  }
  .expires-hint-row .material-symbols-rounded { font-size: 16px; }

  .variants-hint { color: var(--text-3); font-size: 12px; margin-top: 8px; }

  .variant-picker-body { padding: 4px 0 0; display: flex; flex-direction: column; gap: 10px; }
  .variant-picker-list {
    list-style: none; padding: 0; margin: 0;
    max-height: 320px; overflow-y: auto;
  }
  .variant-picker-row {
    display: flex; align-items: center; gap: 10px;
    width: 100%; padding: 10px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: 4px;
    cursor: pointer;
    text-align: left;
  }
  .variant-picker-row:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--surface-1)); }
  .variant-picker-name { flex: 1; color: var(--text-1); font-weight: 500; font-size: 13px; }
  .variant-picker-meta { color: var(--text-3); font-size: 12px; }
  .variant-picker-empty { padding: 12px; text-align: center; color: var(--text-3); font-size: 13px; }
  .variant-picker-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 6px; border-top: 1px solid var(--border); }
</style>
