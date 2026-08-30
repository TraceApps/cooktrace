<script>
  import { onMount, onDestroy } from 'svelte';
  import { slide } from 'svelte/transition';
  import { push } from 'svelte-spa-router';
  import { fade } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { NtApi } from '../lib/api.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { resolveAssetUrl } from '../lib/platform.js';
  import { defaultServings } from '../stores/settings.js';
  import StarRating from '../components/ui/StarRating.svelte';
  import UnitPicker from '../components/ui/UnitPicker.svelte';
  import ImagePicker from '../components/ui/ImagePicker.svelte';
  import RichTextEditor from '../components/ui/RichTextEditor.svelte';
  import MarkdownToolbar from '../components/ui/MarkdownToolbar.svelte';
  import Combobox from '../components/ui/Combobox.svelte';
  import ActionSheet from '../components/ui/ActionSheet.svelte';
  import { NUTRIMENTS, DEFAULT_VISIBLE_NUTRIMENT_IDS } from '../lib/nutriments.js';
  import { visibleNutriments } from '../stores/settings.js';
  import { computeRecipeNutrition } from '../lib/recipe-nutrition.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { parseQty, formatQty } from '../lib/qty.js';
  import Spinner from '../components/ui/Spinner.svelte';

  // Units where decimal qtys feel awkward — auto-format to fractions
  // (0.25 cup → 1/4 cup, 0.5 tsp → 1/2 tsp). Volume-y units only;
  // grams / ml / oz / lb stay as decimals because fractions read worse.
  const FRACTION_UNITS = new Set([
    'tsp', 'tbsp', 'cup', 'pt', 'qt', 'gal', 'fl oz',
  ]);
  function _normaliseQtyForUnit(qty, unit) {
    if (!qty) return qty;
    const u = (unit || '').toLowerCase().trim();
    if (!FRACTION_UNITS.has(u)) return qty;
    const n = parseQty(qty);
    if (n == null) return qty;             // pass through "to taste" etc.
    if (!Number.isFinite(n) || n < 0) return qty;
    const formatted = formatQty(n);
    return formatted || qty;
  }

  export let params = {};

  $: id = params.id ? parseInt(params.id, 10) : null;
  $: isEdit = Number.isFinite(id);

  // ── Form state ─────────────────────────────────────────────────────────
  let name = '';
  let description = '';
  let imgUrl = '';
  let imgUploading = false;
  let rating = null;
  let yieldText = '';
  let servings = $defaultServings || 2;
  let prepMinutes = '';
  let cookMinutes = '';
  // Rest / rise / marinate / chill / soak — the hands-off slot.
  // Empty means "no rest time"; when set it rolls into the auto-calc
  // for Total below.
  let restMinutes = '';
  // Empty = 'auto' (derive from prep + cook + rest); a value here overrides.
  let totalMinutes = '';
  // Placeholder in the Total input shows what the auto-calc would be
  // right now, so the user sees the fallback value before deciding
  // whether to override.
  $: totalAutoCalc = (parseInt(prepMinutes, 10) || 0) + (parseInt(cookMinutes, 10) || 0) + (parseInt(restMinutes, 10) || 0);
  // Grouped ingredients: [{ name?: 'Sauce', items: [{qty,unit,name,note}] }, ...]
  // Default: one unnamed group (renders as a flat list until the user
  // adds a second group).
  let ingredientGroups = [_blankGroup()];
  let steps = [{ title: '', text: '' }];
  let stepTextareas = [];
  // Tags + Kitchen Gear use the chip-combobox: state is an array of
  // strings, populated from existing recipes via /api/recipes/tags
  // (tools). Inline-create lets users invent new ones on the fly.
  let tags = [];
  let tools = [];
  let tagOptions = [];
  let toolOptions = [];
  let categoryId = '';   // empty string = none; coerced to null on save
  let categories = [];
  // Combobox single mode for category. The displayed value is the name;
  // when the user picks an existing one we cache the id. Inline-create
  // routes to a small confirm dialog (categoryNew*) below.
  let categoryName = '';
  let comboCategoryRef;
  let categoryNewOpen = false;
  let categoryNewName = '';
  let categoryNewColor = null;
  const SWATCHES = [
    '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
    '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#a855f7',
    '#ec4899', '#d97706',
  ];
  let sourceUrl = '';
  let videoUrl  = '';        // YouTube/Vimeo/etc. URL OR /uploads/<id>.mp4
  let videoUploading = false;
  let _videoFileInput;
  let _videoCameraInput;
  // Add-from-pantry picker — opens a modal where the user multi-selects
  // pantry rows that get appended as ingredients to the targeted group.
  let pantryPickerOpen = false;
  let pantryPickerGi = 0;
  let pantryPickerQuery = '';
  let pantryPickerSelected = new Set();
  let pantryPickerRows = [];
  let pantryPickerLoading = false;
  // 'add' = pick one or more rows, append (or replace the leading blank).
  // 'swap' = replace one specific existing row's name/unit with a single
  // pantry pick. Keeps the user's qty + note since those reflect the
  // recipe's needs, not the pantry item's metadata.
  let pantryPickerMode = 'add';
  let pantryPickerSwapPath = null; // { gi, ii } when mode === 'swap'
  function openPantryPicker(gi) {
    pantryPickerMode = 'add';
    pantryPickerSwapPath = null;
    pantryPickerGi = gi;
    pantryPickerOpen = true;
    pantryPickerQuery = '';
    pantryPickerSelected = new Set();
    _loadPantryRowsIfNeeded();
  }
  function openPantrySwap(gi, ii) {
    pantryPickerMode = 'swap';
    pantryPickerSwapPath = { gi, ii };
    pantryPickerGi = gi;
    pantryPickerOpen = true;
    pantryPickerQuery = '';
    pantryPickerSelected = new Set();
    _loadPantryRowsIfNeeded();
  }

  // Detach an ingredient from its Pantry link without removing the row
  // or changing its display name. Called by the same icon button when
  // the row is currently linked — tap once on a linked row → unlink;
  // tap on an unlinked row → open the link picker.
  function unlinkRowAt(gi, ii) {
    const groups = ingredientGroups.map(g => ({ ...g, items: [...g.items] }));
    const target = groups[gi];
    const existing = target?.items?.[ii];
    if (target && existing) {
      const { pantry_item_id, ...rest } = existing;
      target.items[ii] = rest;
      ingredientGroups = groups;
    }
  }
  function _loadPantryRowsIfNeeded() {
    if (pantryPickerRows.length === 0) {
      pantryPickerLoading = true;
      NtApi.getPantry()
        .then(rows => { pantryPickerRows = rows || []; })
        .catch(() => { pantryPickerRows = []; })
        .finally(() => { pantryPickerLoading = false; });
    }
  }
  // Best-effort preload so the swap-button tooltip can show the
  // actual linked pantry-item name from first paint, not the generic
  // "Linked to a Pantry item" placeholder.
  onMount(() => { _loadPantryRowsIfNeeded(); });
  // Lookup map: pantry_item_id → display name, used by the swap-button
  // tooltip + the linked-item badge below ingredient rows.
  $: pantryNamesById = new Map(pantryPickerRows.map(p => [p.id, p.name]));
  function closePantryPicker() { pantryPickerOpen = false; }
  function togglePantrySelected(id) {
    if (pantryPickerMode === 'swap') {
      // Single-select: tapping a different row replaces the previous pick.
      pantryPickerSelected = new Set([id]);
      return;
    }
    const next = new Set(pantryPickerSelected);
    if (next.has(id)) next.delete(id); else next.add(id);
    pantryPickerSelected = next;
  }
  function confirmPantryPicker() {
    const picked = pantryPickerRows.filter(r => pantryPickerSelected.has(r.id));
    if (picked.length === 0) { closePantryPicker(); return; }

    if (pantryPickerMode === 'swap' && pantryPickerSwapPath) {
      const { gi, ii } = pantryPickerSwapPath;
      const groups = ingredientGroups.map(g => ({ ...g, items: [...g.items] }));
      const target = groups[gi];
      const existing = target?.items?.[ii];
      const p = picked[0];
      if (target && existing) {
        // Decouple display name from pantry link: keep whatever the
        // user typed in the ingredient name field ("salt") and just
        // attach the pantry_item_id so the row carries the linked
        // brand / nutrition / stock metadata. Unit fills only when
        // the user hasn't typed one yet — never overwrites.
        target.items[ii] = {
          ...existing,
          unit: existing.unit || p.serving_unit || '',
          pantry_item_id: p.id,
        };
        ingredientGroups = groups;
      }
      closePantryPicker();
      return;
    }

    const groups = ingredientGroups.map(g => ({ ...g, items: [...g.items] }));
    const target = groups[pantryPickerGi] || groups[0];
    // Replace the leading blank row if present, then append the rest.
    const leadIdx = target.items.findIndex(it => !it.name?.trim());
    const newRows = picked.map(p => ({
      qty: '', unit: p.serving_unit || '',
      name: p.name, note: '',
      pantry_item_id: p.id,
    }));
    if (leadIdx === 0 && target.items.length === 1) {
      target.items = newRows;
    } else {
      target.items = [...target.items, ...newRows];
    }
    ingredientGroups = groups;
    closePantryPicker();
  }
  $: pantryPickerFiltered = (() => {
    const q = pantryPickerQuery.trim().toLowerCase();
    if (!q) return pantryPickerRows;
    return pantryPickerRows.filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.brand || '').toLowerCase().includes(q));
  })();
  let notes = '';
  // Sparse object keyed by nutriment id — only populated keys persist.
  // The editor renders inputs for whichever nutriments the user chose to
  // see (visibleNutriments setting), defaulting to NT's curated subset.
  let nutrition = {};
  let nutritionOpen = false;
  let autoCalcStatus = '';

  async function autoCalcNutrition() {
    autoCalcStatus = 'Loading pantry…';
    try {
      // Pull the latest pantry rows so we have nutrition data + serving.
      const pantry = await NtApi.getPantry();
      const byId = new Map(pantry.map(p => [p.id, p]));

      // The editor stores ingredients per-group; flatten + ensure each
      // item has a pantry_item_id (server stamps it on save, but we
      // also try to look up by lowercase name as a fallback).
      const byLowerName = new Map(pantry.map(p => [p.name.toLowerCase(), p]));
      const ingredientsForCalc = ingredientGroups.map(g => ({
        ...g,
        items: (g.items || []).map(it => {
          if (it.pantry_item_id) return it;
          const match = byLowerName.get((it.name || '').toLowerCase());
          return match ? { ...it, pantry_item_id: match.id } : it;
        }),
      }));

      const result = computeRecipeNutrition(ingredientsForCalc, byId);
      if (result.used === 0) {
        autoCalcStatus = `No pantry rows had nutrition data. Add serving + nutrition to pantry items first.`;
        return;
      }

      const hadValues = Object.values(nutrition).some(v => Number.isFinite(v) && v > 0);
      if (hadValues) {
        const ok = await confirmDialog({
          title: 'Replace existing nutrition?',
          message: 'You have manually-entered values for this recipe. Auto-calc will overwrite them.',
          confirmText: 'Replace',
        });
        if (!ok) { autoCalcStatus = ''; return; }
      }

      // Total → per-serving (recipe.servings is the divisor).
      const div = Number(servings) > 0 ? Number(servings) : 1;
      const perServing = {};
      for (const [k, v] of Object.entries(result.nutrition)) {
        perServing[k] = Math.round((v / div) * 100) / 100;
      }
      nutrition = perServing;
      const skipped = result.total - result.used;
      autoCalcStatus = skipped > 0
        ? `Computed from ${result.used} of ${result.total} ingredients — ${skipped} skipped (no pantry data or unit mismatch).`
        : `Computed from all ${result.total} ingredients.`;
    } catch (e) {
      autoCalcStatus = `Couldn't compute: ${e.message || 'pantry load failed'}`;
    }
  }
  $: visibleNutSet = new Set(
    Array.isArray($visibleNutriments) && $visibleNutriments.length > 0
      ? $visibleNutriments
      : DEFAULT_VISIBLE_NUTRIMENT_IDS
  );
  // Show full catalog when the panel is "expanded all" — defer for now,
  // visibleNutriments is the single knob.
  $: editableNutriments = NUTRIMENTS.filter(n => visibleNutSet.has(n.id));

  function _blankGroup() {
    return { name: '', items: [_blankIngredient()] };
  }

  let loading = isEdit;
  let saving = false;

  // Pantry catalog for ingredient-name autocomplete. Lazy-loaded once on
  // mount so typing in an ingredient name suggests known pantry items.
  let pantryNames = [];
  async function _loadPantryNames() {
    try {
      const items = await NtApi.getPantry();
      pantryNames = (items || []).map(i => i.name).sort((a, b) => a.localeCompare(b));
    } catch { pantryNames = []; }
  }

  // Stable per-ingredient id — used by the per-step "linked ingredients"
  // feature (issue #40) so steps can reference specific ingredients
  // across reorders / renames. crypto.randomUUID is fine on every
  // browser the app supports and inside Capacitor's WebView; a Math
  // fallback keeps SSR / test harnesses that lack it happy.
  function _newIngId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch { /* fall through */ }
    return 'ing_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  function _blankIngredient() {
    return { id: _newIngId(), qty: '', unit: '', name: '', note: '' };
  }

  async function load() {
    if (!isEdit) return;
    try {
      const r = await NtApi.getRecipe(id);
      name        = r.name || '';
      description = r.description || '';
      imgUrl      = r.imgUrl || '';
      rating      = r.rating ?? null;
      yieldText   = r.yield_text || '';
      servings    = r.servings || 2;
      prepMinutes  = r.prep_minutes  ?? '';
      cookMinutes  = r.cook_minutes  ?? '';
      restMinutes  = r.rest_minutes  ?? '';
      totalMinutes = r.total_minutes ?? '';
      // Server returns ingredients in grouped shape: [{name, items: [...]}].
      // Each item is mapped to controlled-input strings.
      ingredientGroups = (r.ingredients?.length ? r.ingredients : [_blankGroup()])
        .map(g => ({
          name: g.name || '',
          items: (g.items?.length ? g.items : [_blankIngredient()])
            .map(i => {
              // Backfill a stable id for legacy recipes so per-step link
              // refs have something to point at once the user edits.
              const row = {
                id: i.id || _newIngId(),
                qty: i.qty ?? '', unit: i.unit ?? '', name: i.name ?? '', note: i.note ?? '',
              };
              // Carry the manual Pantry link forward — without this the
              // round-trip silently drops it and the row falls back to
              // auto-name resolve, losing the user's pick.
              if (i.pantry_item_id != null) row.pantry_item_id = i.pantry_item_id;
              return row;
            }),
        }));
      // Steps support an optional `title` (short summary like "Preheat Oven")
      // shown as "Step N: Title" in the view. Old string-only steps still load.
      // `refIds` is the per-step "linked ingredients" set (issue #40) —
      // preserved as-is when present, kept empty for legacy steps.
      steps       = r.steps?.length
        ? r.steps.map(s => typeof s === 'string'
            ? { title: '', text: s, refIds: [], imgUrl: '' }
            : {
                title: s.title || '',
                text: s.text || '',
                refIds: Array.isArray(s.refIds) ? [...s.refIds] : [],
                // imgUrl was set by the step-photo picker but never
                // hydrated back on load, so any saved step photo was
                // silently dropped on the next edit. Fix while we're
                // here since we're rewriting this block anyway.
                imgUrl: s.imgUrl || '',
              })
        : [{ title: '', text: '', refIds: [], imgUrl: '' }];
      tags        = Array.isArray(r.tags)  ? [...r.tags]  : [];
      tools       = Array.isArray(r.tools) ? [...r.tools] : [];
      categoryId  = r.category_id != null ? String(r.category_id) : '';
      categoryName = r.category?.name || '';
      sourceUrl   = r.source_url || '';
      videoUrl    = r.video_url  || '';
      notes       = r.notes || '';
      // Hydrate nutrition with whatever the recipe has — `_derived` flags + numbers.
      const incomingNut = (r.nutrition && typeof r.nutrition === 'object') ? r.nutrition : {};
      nutrition = { ...incomingNut };
      // Auto-expand the panel if any value is set.
      nutritionOpen = Object.entries(incomingNut)
        .some(([k, v]) => k !== '_derived' && v != null && v !== '');
    } catch (e) {
      showError(e.message || 'Could not load recipe');
      push('/recipes');
    } finally {
      loading = false;
    }
  }
  // Video upload — reuses /api/upload but with a friendlier "this might
  // take a minute" message since video files are far bigger than recipe
  // images. The upload helper enforces a server-side cap; we surface
  // its error verbatim if it kicks back. The file input also accepts
  // `capture` so on mobile it offers the camera as a record path.
  async function uploadVideoFile(file) {
    if (!file) return;
    if (!/^video\//.test(file.type)) {
      showError($_('recipe_editor_ct.toast.pick_video'));
      return;
    }
    videoUploading = true;
    try {
      const res = await NtApi.uploadImage(file); // same multipart handler accepts video
      const url = res?.url || res?.path || '';
      if (!url) throw new Error('Upload failed');
      videoUrl = url;
      showSuccess($_('recipe_editor_ct.toast.video_uploaded'));
    } catch (e) {
      showError(e.message || 'Could not upload video');
    } finally {
      videoUploading = false;
    }
  }
  function _onVideoFile(e) {
    const f = e.target?.files?.[0];
    if (f) uploadVideoFile(f);
    if (e.target) e.target.value = '';
  }
  function clearVideo() { videoUrl = ''; }

  async function _loadCategories() {
    try { categories = await NtApi.getRecipeCategories(); }
    catch { categories = []; }
  }
  async function _loadTaxonomies() {
    try {
      const [t, tl] = await Promise.all([
        NtApi.getRecipeTags().catch(() => []),
        NtApi.getRecipeTools().catch(() => []),
      ]);
      tagOptions = t || [];
      toolOptions = tl || [];
    } catch { /* non-fatal — combobox just shows empty results */ }
  }
  onMount(() => {
    load();
    _loadPantryNames();
    _loadCategories();
    _loadTaxonomies();
    _maybeRestoreDraft();
  });

  // ── Auto-save drafts ────────────────────────────────────────────────
  // Tab close / accidental nav doesn't lose 30 minutes of typing. Save
  // a snapshot of the editing state to localStorage every ~1.5s while
  // the user is making changes; restore on next mount if a draft exists
  // for this id (or 'new' for a not-yet-saved recipe). Cleared on
  // successful save + on Cancel.
  const _draftKey = () => `ct:recipeEditDraft:${isEdit ? id : 'new'}`;
  let _draftTimer = null;
  let _draftRestorable = false;   // becomes true after a draft is found
  let _draftRestored = false;     // user accepted the restore offer
  function _draftSnapshot() {
    return {
      v: 1,
      ts: Date.now(),
      name, description, imgUrl, rating, yieldText, servings,
      prepMinutes, cookMinutes, ingredientGroups, steps,
      tags, tools, categoryId, categoryName, notes, videoUrl,
      nutrition,
    };
  }
  function _saveDraft() {
    try { localStorage.setItem(_draftKey(), JSON.stringify(_draftSnapshot())); } catch {}
  }
  function _clearDraft() {
    try { localStorage.removeItem(_draftKey()); } catch {}
  }
  function _maybeRestoreDraft() {
    try {
      const raw = localStorage.getItem(_draftKey());
      if (!raw) return;
      const draft = JSON.parse(raw);
      // Stale drafts (>14 days) — drop silently rather than annoying the
      // user with a banner about an ancient session.
      if (!draft || !draft.ts || (Date.now() - draft.ts) > 14 * 24 * 3600 * 1000) {
        _clearDraft(); return;
      }
      _draftRestorable = true;
    } catch {}
  }
  function restoreDraft() {
    try {
      const raw = localStorage.getItem(_draftKey());
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.name != null) name = d.name;
      if (d.description != null) description = d.description;
      if (d.imgUrl != null) imgUrl = d.imgUrl;
      if (d.rating != null) rating = d.rating;
      if (d.yieldText != null) yieldText = d.yieldText;
      if (d.servings != null) servings = d.servings;
      if (d.prepMinutes != null) prepMinutes = d.prepMinutes;
      if (d.cookMinutes != null) cookMinutes = d.cookMinutes;
      if (d.ingredientGroups != null) ingredientGroups = d.ingredientGroups;
      if (d.steps != null) steps = d.steps;
      if (d.tags != null) tags = d.tags;
      if (d.tools != null) tools = d.tools;
      if (d.categoryId != null) categoryId = d.categoryId;
      if (d.categoryName != null) categoryName = d.categoryName;
      if (d.notes != null) notes = d.notes;
      if (d.videoUrl != null) videoUrl = d.videoUrl;
      if (d.nutrition != null) nutrition = d.nutrition;
      _draftRestored = true;
      _draftRestorable = false;
      showSuccess($_('recipe_editor_ct.toast.draft_restored'));
    } catch (e) {
      showError($_('recipe_editor_ct.toast.cant_restore_draft'));
      _clearDraft();
      _draftRestorable = false;
    }
  }
  function discardDraft() {
    _clearDraft();
    _draftRestorable = false;
  }
  // Fire a debounced save whenever a watched field changes. Skip while
  // initial load is in flight and while saving (to avoid resurrecting
  // a draft we're about to clear).
  $: if (!loading && !saving && (
    name || description || ingredientGroups || steps || notes ||
    tags || tools || rating || servings || categoryId
  )) {
    if (_draftTimer) clearTimeout(_draftTimer);
    _draftTimer = setTimeout(_saveDraft, 1500);
  }
  onDestroy(() => { if (_draftTimer) clearTimeout(_draftTimer); });

  // The category combobox feeds names; resolve back to the user's
  // catalog when the value changes via selection.
  function onCategorySelect(e) {
    const opt = e.detail;
    const match = categories.find(c => c.name.toLowerCase() === (opt?.name || '').toLowerCase());
    if (match) { categoryId = String(match.id); categoryName = match.name; }
  }
  function onCategoryClear() {
    categoryId = '';
    categoryName = '';
  }
  function openNewCategoryDialog(e) {
    categoryNewName = (e?.detail || '').trim();
    categoryNewColor = SWATCHES[Math.floor(Math.random() * SWATCHES.length)];
    categoryNewOpen = true;
  }
  async function confirmNewCategory() {
    const name = categoryNewName.trim();
    if (!name) return;
    try {
      const c = await NtApi.createRecipeCategory({ name, color: categoryNewColor });
      categories = [...categories, c];
      categoryId = String(c.id);
      categoryName = c.name;
      // Tell the combobox to display the chosen name.
      comboCategoryRef?.acceptCreated(c.name);
      categoryNewOpen = false;
    } catch (err) {
      showError(err.message || 'Could not create category');
    }
  }

  // Group helpers
  // Removing a section keeps its ingredients — we merge them into the
  // previous group so order doesn't shuffle and the user doesn't lose
  // work. If the section being removed is the first, items merge into
  // the next one. If it's the only group, just drop the name (turns
  // back into the default ungrouped list).
  function removeGroup(gi) {
    const next = [...ingredientGroups];
    const target = next[gi];
    if (!target) return;
    const items = target.items || [];
    if (next.length === 1) {
      // Single group: clear the name + keep its items.
      next[0] = { name: '', items: items.length > 0 ? items : [_blankIngredient()] };
      ingredientGroups = next;
      return;
    }
    const mergeInto = gi > 0 ? gi - 1 : 1; // prev sibling or next if first
    next[mergeInto] = {
      ...next[mergeInto],
      items: [...next[mergeInto].items, ...items],
    };
    next.splice(gi, 1);
    ingredientGroups = next;
  }

  // Mealie-style "Toggle Section" — splits the current group at the
  // given ingredient. Items 0..ii-1 stay in the current group; items
  // ii..end become a new group placed below, ready to be named.
  // If `ii` is 0 and the group has more than 1 item, we instead create
  // an empty named group ABOVE the current one (so the user can label
  // the leading section without affecting positions).
  function toggleSectionAt(gi, ii) {
    const cur = ingredientGroups[gi];
    if (!cur) return;
    // Splitting at row `ii` means everything from ii onwards becomes a
    // new section; the row that triggered it sits as the FIRST item of
    // the new section, so the section header lands directly above the
    // ingredient the user clicked from. Sections start without any
    // placeholder rows.
    const head = cur.items.slice(0, ii);
    const tail = cur.items.slice(ii);
    const headGroup = head.length > 0 ? [{ ...cur, items: head }] : [];
    const tailGroup = { name: 'New section', items: tail };
    ingredientGroups = [
      ...ingredientGroups.slice(0, gi),
      ...headGroup,
      tailGroup,
      ...ingredientGroups.slice(gi + 1),
    ];
  }

  // ── Drag-and-drop reorder ─────────────────────────────────────────
  // Tracks the row currently being dragged (gi/ii) and the drop target
  // (gi/ii). Drop inserts the dragged ingredient before the target row,
  // moving it across groups freely. Empty groups left behind get
  // patched with a blank row so the editor stays usable.
  let dragSource = null; // { gi, ii } | null
  let dragOver = null;   // { gi, ii } | null
  function _onDragStart(gi, ii, e) {
    dragSource = { gi, ii };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `${gi}:${ii}`);
    }
  }
  function _onDragOver(gi, ii, e) {
    if (!dragSource) return;
    if (dragSource.gi === gi && dragSource.ii === ii) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOver = { gi, ii };
  }
  function _onDragLeave(gi, ii) {
    if (dragOver && dragOver.gi === gi && dragOver.ii === ii) dragOver = null;
  }
  function _onDrop(targetGi, targetIi, e) {
    e.preventDefault();
    if (!dragSource) return;
    const { gi: sGi, ii: sIi } = dragSource;
    dragSource = null; dragOver = null;
    if (sGi === targetGi && sIi === targetIi) return;
    // Pull the moved item out of source.
    const next = ingredientGroups.map(g => ({ ...g, items: [...g.items] }));
    const [moved] = next[sGi].items.splice(sIi, 1);
    if (!moved) return;
    // If we removed from the same group BEFORE the target, the target
    // index shifts back by one.
    let insertIdx = targetIi;
    if (sGi === targetGi && sIi < targetIi) insertIdx -= 1;
    next[targetGi].items.splice(insertIdx, 0, moved);
    ingredientGroups = next;
  }
  function _onDragEnd() { dragSource = null; dragOver = null; }

  // Step drag-reorder — same pattern as ingredients but flat array
  // (no groups), so the source/target shape is just a single index.
  let stepDragSource = null; // number | null
  let stepDragOver = null;   // number | null
  function _onStepDragStart(i, e) {
    stepDragSource = i;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `step:${i}`);
    }
  }
  function _onStepDragOver(i, e) {
    if (stepDragSource == null) return;
    if (stepDragSource === i) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    stepDragOver = i;
  }
  function _onStepDragLeave(i) { if (stepDragOver === i) stepDragOver = null; }
  function _onStepDrop(targetI, e) {
    e.preventDefault();
    if (stepDragSource == null) return;
    const src = stepDragSource;
    stepDragSource = null; stepDragOver = null;
    if (src === targetI) return;
    const next = [...steps];
    const [moved] = next.splice(src, 1);
    if (!moved) return;
    const insertIdx = src < targetI ? targetI - 1 : targetI;
    next.splice(insertIdx, 0, moved);
    steps = next;
  }
  function _onStepDragEnd() { stepDragSource = null; stepDragOver = null; }

  function addIngredient(gi) {
    ingredientGroups[gi].items = [...ingredientGroups[gi].items, _blankIngredient()];
    ingredientGroups = ingredientGroups;
  }
  function removeIngredient(gi, ii) {
    ingredientGroups[gi].items = ingredientGroups[gi].items.filter((_, idx) => idx !== ii);
    // Only the unnamed root group needs a placeholder — named sections
    // can sit empty as headers until the user adds rows via the global
    // Add button (or drags one in).
    if (
      ingredientGroups[gi].items.length === 0 &&
      !ingredientGroups[gi].name &&
      ingredientGroups.length === 1
    ) {
      ingredientGroups[gi].items = [_blankIngredient()];
    }
    ingredientGroups = ingredientGroups;
  }
  function addStep() { steps = [...steps, { title: '', text: '', refIds: [], imgUrl: '' }]; }

  // Toggle whether a given ingredient id is linked from step `si`.
  // Called from the per-step chip picker below the step text.
  function toggleStepIngredientRef(si, ingId) {
    const cur = Array.isArray(steps[si]?.refIds) ? steps[si].refIds : [];
    const next = cur.includes(ingId) ? cur.filter(x => x !== ingId) : [...cur, ingId];
    steps[si] = { ...steps[si], refIds: next };
    steps = steps;
  }
  // Flat list of all ingredients across every group, in visual order,
  // for the per-step link picker.
  $: allIngredientOptions = ingredientGroups
    .flatMap(g => (g.items || []))
    .filter(i => i && i.id && (i.name || '').trim())
    .map(i => ({ id: i.id, name: i.name, qty: i.qty, unit: i.unit }));

  // Per-step link panel expand state — collapsed by default so the
  // chip strip doesn't hog vertical space in the editor. Set of step
  // indices currently expanded. Auto-expand any step that already has
  // linked ingredients on load so the user sees the current state.
  let stepLinksExpanded = new Set();
  function toggleStepLinksPanel(si) {
    const next = new Set(stepLinksExpanded);
    if (next.has(si)) next.delete(si); else next.add(si);
    stepLinksExpanded = next;
  }
  // On steps change (load / add / remove), pre-expand any step that
  // has linked ingredients so the user can see them at a glance.
  // Otherwise the count in the header is the only signal.
  $: if (steps) {
    const auto = new Set(stepLinksExpanded);
    steps.forEach((s, i) => {
      if (Array.isArray(s?.refIds) && s.refIds.length > 0) auto.add(i);
    });
    if (auto.size !== stepLinksExpanded.size) stepLinksExpanded = auto;
  }
  // Resolve a ref id → the current ingredient row (for chip labels).
  function _findIngById(id) {
    for (const g of ingredientGroups) {
      for (const it of (g.items || [])) if (it.id === id) return it;
    }
    return null;
  }

  // ── Ingredient row kebab menu (mobile) ─────────────────────────────
  // Under 600px the three per-row action buttons (link-to-pantry,
  // start-section, delete) crush the name field. Collapse them behind
  // a single kebab on mobile; the actions surface via an ActionSheet.
  // Note editing lives here too — the second-line note input reveals
  // when the ingredient has a note OR the user just tapped Add Note.
  // Desktop keeps the visible-buttons layout via a CSS media query.
  let ingActionOpen = false;
  let ingActionGi = -1, ingActionIi = -1;
  // Keys are "gi:ii" strings. Auto-populated on mount so any ingredient
  // arriving with an existing note lands with its note row already open.
  let notesExpanded = new Set();
  function _ingKey(gi, ii) { return `${gi}:${ii}`; }
  function _isNoteOpen(gi, ii, ing) {
    return !!(ing.note && ing.note.trim()) || notesExpanded.has(_ingKey(gi, ii));
  }
  function openIngredientMenu(gi, ii) {
    ingActionGi = gi; ingActionIi = ii;
    ingActionOpen = true;
  }
  $: ingActionTarget = (ingActionGi >= 0 && ingActionIi >= 0)
    ? (ingredientGroups[ingActionGi]?.items?.[ingActionIi] ?? null)
    : null;
  $: ingActions = ingActionTarget ? [
    {
      label: (ingActionTarget.note && ingActionTarget.note.trim()) ? 'Edit Note' : 'Add Note',
      icon: 'edit_note',
      value: 'note',
    },
    {
      label: ingActionTarget.pantry_item_id ? 'Unlink Pantry' : 'Link to Pantry',
      icon: 'kitchen',
      value: 'pantry',
    },
    { label: 'Start Section Here', icon: 'subdirectory_arrow_right', value: 'section' },
    { label: 'Delete',              icon: 'delete',                   value: 'delete', danger: true },
  ] : [];
  function onIngredientAction(e) {
    const v = e.detail?.value;
    const gi = ingActionGi, ii = ingActionIi;
    ingActionGi = -1; ingActionIi = -1;
    if (gi < 0 || ii < 0) return;
    const ing = ingredientGroups[gi]?.items?.[ii];
    if (!ing) return;
    if (v === 'note') {
      const next = new Set(notesExpanded);
      next.add(_ingKey(gi, ii));
      notesExpanded = next;
    } else if (v === 'pantry') {
      if (ing.pantry_item_id) unlinkRowAt(gi, ii);
      else openPantrySwap(gi, ii);
    } else if (v === 'section') {
      toggleSectionAt(gi, ii);
    } else if (v === 'delete') {
      removeIngredient(gi, ii);
    }
  }

  // Step-photo modal — replaces the bulky inline ImagePicker per row
  // with a compact "Add Photo" icon button that pops open the same
  // three-source picker (Camera / Upload / URL) in a dialog on demand.
  // The form stays compact when no photo is set.
  let stepPhotoSheetIdx = null;
  function openStepPhotoSheet(i) { stepPhotoSheetIdx = i; }
  function closeStepPhotoSheet() { stepPhotoSheetIdx = null; }
  function removeStep(i) {
    steps = steps.filter((_, idx) => idx !== i);
    if (steps.length === 0) steps = [{ title: '', text: '' }];
  }

  // ImagePicker handles upload / camera / URL internally — no local helpers needed.

  async function save() {
    if (!name.trim()) {
      showError($_('recipe_editor_ct.toast.name_required'));
      return;
    }
    saving = true;
    try {
      // Save groups as { name, items: [...] } — drop empty groups, drop
      // ingredients with no name.
      const cleanedIngredients = ingredientGroups
        .map(g => ({
          name:  (g.name ?? '').toString().trim(),
          items: g.items
            .map(i => {
              const cleaned = {
                // Stable id survives across save/load so per-step
                // ref_ids keep pointing at the same ingredient even
                // after renames / reorders (issue #40).
                id:   i.id || _newIngId(),
                qty:  (i.qty  ?? '').toString().trim(),
                unit: (i.unit ?? '').toString().trim(),
                name: (i.name ?? '').toString().trim(),
                note: (i.note ?? '').toString().trim(),
              };
              // Persist the manual Pantry link if the user set one via
              // the Link picker. Without this, the field gets stripped
              // on save and the row falls back to auto-name-resolve on
              // the next load — losing the user's brand / nutrition pick.
              if (i.pantry_item_id != null) cleaned.pantry_item_id = i.pantry_item_id;
              return cleaned;
            })
            .filter(i => i.name),
        }))
        .filter(g => g.items.length > 0 || g.name);

      // Build a set of ingredient ids that survived the cleanup so we
      // can prune any dangling refIds pointing at removed rows.
      const _liveIngIds = new Set(
        cleanedIngredients.flatMap(g => g.items.map(i => i.id))
      );

      const cleanedSteps = steps
        .map(s => {
          const cleaned = {
            title: (s.title ?? '').toString().trim(),
            text:  (s.text  ?? '').toString().trim(),
          };
          // Preserve per-step linked ingredients (issue #40). Filter
          // against live ingredient ids so removed rows don't leave
          // dangling refs. Only persist when non-empty to keep the
          // JSON shape identical to legacy for recipes that never use
          // the feature.
          if (Array.isArray(s.refIds) && s.refIds.length > 0) {
            const kept = s.refIds.filter(id => _liveIngIds.has(id));
            if (kept.length > 0) cleaned.refIds = kept;
          }
          // Preserve step photo (was silently dropped on every save
          // before this patch — the picker set steps[i].imgUrl but
          // save() didn't include it in the persisted object).
          if (s.imgUrl) cleaned.imgUrl = s.imgUrl;
          return cleaned;
        })
        .filter(s => s.title || s.text || s.imgUrl);

      // Combobox stores chip arrays directly. Trim + drop empties on
      // save so any noise from inline create doesn't persist.
      const cleanedTags  = (tags  || []).map(t => String(t).trim()).filter(Boolean);
      const cleanedTools = (tools || []).map(t => String(t).trim()).filter(Boolean);

      // Drop empty/zero nutrition fields so we don't store noise. The
      // `_derived` flag is server-managed and stripped here — the server
      // re-derives on save.
      const cleanedNutrition = {};
      for (const [k, v] of Object.entries(nutrition)) {
        if (k === '_derived') continue;
        if (v == null || v === '') continue;
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) cleanedNutrition[k] = n;
      }

      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        imgUrl: imgUrl || null,
        rating: rating ?? null,
        yield_text: yieldText.trim() || null,
        servings: parseInt(servings, 10) || null,
        prep_minutes:  prepMinutes  === '' ? null : parseInt(prepMinutes,  10),
        cook_minutes:  cookMinutes  === '' ? null : parseInt(cookMinutes,  10),
        rest_minutes:  restMinutes  === '' ? null : parseInt(restMinutes,  10),
        total_minutes: totalMinutes === '' ? null : parseInt(totalMinutes, 10),
        ingredients: cleanedIngredients,
        steps: cleanedSteps,
        tags: cleanedTags,
        tools: cleanedTools,
        category_id: categoryId === '' ? null : parseInt(categoryId, 10),
        nutrition: cleanedNutrition,
        source_url: sourceUrl.trim() || null,
        video_url:  videoUrl.trim()  || null,
        notes: notes.trim() || null,
      };

      const saved = isEdit
        ? await NtApi.updateRecipe(id, payload)
        : await NtApi.createRecipe(payload);

      showSuccess(isEdit ? 'Recipe saved' : 'Recipe created');
      _clearDraft();
      push(`/recipes/${saved.id}`);
    } catch (e) {
      showError(e.message || 'Save failed');
    } finally {
      saving = false;
    }
  }

  function cancel() {
    _clearDraft();
    if (isEdit) push(`/recipes/${id}`);
    else push('/recipes');
  }
</script>

<div class="page-shell editor-page">
  <header class="editor-header">
    <h2 class="editor-title">{isEdit ? 'Edit Recipe' : 'New Recipe'}</h2>
    <button class="btn btn-primary editor-save" on:click={save} disabled={saving || imgUploading}>
      {imgUploading ? 'Uploading…' : saving ? 'Saving…' : 'Save'}
    </button>
    <button class="btn-icon close-btn" on:click={cancel} aria-label="Close" title="Close">
      <span class="material-symbols-rounded">close</span>
    </button>
  </header>

  <div class="editor-content">
    {#if loading}
      <div class="state" in:fade={{ duration: 120 }}>
        <span class="material-symbols-rounded spin">progress_activity</span>
      </div>
    {:else}
      <div class="form-wrap">
        <div class="form">
          {#if _draftRestorable && !_draftRestored}
            <div class="draft-banner" transition:slide={{ duration: 180 }}>
              <span class="material-symbols-rounded">restore</span>
              <span class="draft-msg">Unsaved draft from a previous session — restore?</span>
              <div class="draft-actions">
                <button class="btn btn-secondary tiny" type="button" on:click={discardDraft}>{$_('recipe_editor_ct.discard')}</button>
                <button class="btn btn-primary tiny" type="button" on:click={restoreDraft}>{$_('recipe_editor_ct.restore')}</button>
              </div>
            </div>
          {/if}
          <!-- Hero image — Camera / Upload / URL.
               `expand` makes the preview + button row span the form's full
               width to match the inputs below; `bind:uploading` lets the
               Save button block while a photo is mid-upload. Wrapped in
               a width-capped container so the 16:9 preview doesn't blow
               up to ~830px tall on wide monitors when the form-wrap is
               at its 1480px max. */-->
          <div class="hero-wrap">
            <ImagePicker bind:value={imgUrl} aspect="16 / 9" expand bind:uploading={imgUploading} />
          </div>

          <!-- Name + description -->
          <label class="field">
            <span class="field-label">{$_('editor.name_required')}</span>
            <input class="input" type="text" bind:value={name} placeholder={$_('recipe_editor_ct.name_ph')} />
          </label>

          <label class="field">
            <span class="field-label">{$_('editor.description')}</span>
            <textarea
              class="input"
              rows="4"
              bind:value={description}
              placeholder="Quick one-bowl loaf, freezes well"
            ></textarea>
          </label>

          <!-- Rating -->
          <div class="field rating-field">
            <span class="field-label">{$_('editor.rating')}</span>
            <StarRating bind:value={rating} size={26} />
          </div>

          <!-- Time + servings + yield -->
          <div class="field-row">
            <label class="field flex">
              <span class="field-label">{$_('editor.prep_min')}</span>
              <input class="input num" type="number" min="0" bind:value={prepMinutes} />
            </label>
            <label class="field flex">
              <span class="field-label">{$_('editor.cook_min')}</span>
              <input class="input num" type="number" min="0" bind:value={cookMinutes} />
            </label>
            <label class="field flex">
              <span class="field-label" title="Any hands-off time: dough rise, meat rest, marinate, chill, soak, ferment. Rolls into the auto-calculated Total below.">Rest (min)</span>
              <input class="input num" type="number" min="0" bind:value={restMinutes} />
            </label>
            <label class="field flex">
              <span class="field-label" title="Auto-calculated from prep + cook + rest unless you set a value here. Use it to include time the three component fields don't cover.">Total (min)</span>
              <input class="input num" type="number" min="0"
                placeholder={totalAutoCalc > 0 ? `auto: ${totalAutoCalc}` : 'auto'}
                bind:value={totalMinutes} />
            </label>
            <label class="field flex">
              <span class="field-label">{$_('recipe.servings')}</span>
              <input class="input num" type="number" min="1" bind:value={servings} />
            </label>
          </div>

          <label class="field">
            <span class="field-label">{$_('recipe_editor_ct.yield')} <span class="field-hint">{$_('recipe_editor_ct.yield_hint')}</span></span>
            <input class="input" type="text" bind:value={yieldText} placeholder="" />
          </label>

          <!-- Two-column body on desktop: Ingredients on the left,
               Steps on the right. Mirrors the RecipeView layout so
               editing and viewing share the same shape. Stacks on
               mobile via the @media block in styles. -->
          <div class="editor-grid">
          <!-- Ingredients (grouped) -->
          <section class="section editor-col-ing">
            <h2 class="section-title">{$_('recipe_editor_ct.ingredients')}</h2>
            <!-- Datalist of known pantry items — populates as you type into
                 the ingredient name field. New names auto-create pantry
                 rows on save (server-side). -->
            <datalist id="pantry-names">
              {#each pantryNames as n}<option value={n}></option>{/each}
            </datalist>

            {#each ingredientGroups as group, gi (gi)}
              <div class="ing-group">
                {#if ingredientGroups.length > 1 || group.name}
                  <div class="ing-group-header">
                    <input
                      class="input ing-group-name"
                      type="text"
                      bind:value={group.name}
                      placeholder="Section name (e.g. Sauce, Dough)"
                    />
                    <button class="btn-icon small" on:click={() => removeGroup(gi)}
                      aria-label="Remove section" title="Remove section">
                      <span class="material-symbols-rounded">delete_sweep</span>
                    </button>
                  </div>
                {/if}

                {#each group.items as ing, ii (ii)}
                  <div class="ing-row"
                    class:dragging={dragSource && dragSource.gi === gi && dragSource.ii === ii}
                    class:drag-over={dragOver && dragOver.gi === gi && dragOver.ii === ii}
                    on:dragover={(e) => _onDragOver(gi, ii, e)}
                    on:dragleave={() => _onDragLeave(gi, ii)}
                    on:drop={(e) => _onDrop(gi, ii, e)}>
                    <button
                      class="ing-handle"
                      draggable="true"
                      on:dragstart={(e) => _onDragStart(gi, ii, e)}
                      on:dragend={_onDragEnd}
                      aria-label="Drag to reorder"
                      title="Drag to reorder">
                      <span class="material-symbols-rounded">drag_indicator</span>
                    </button>
                    <input class="input ing-qty"  type="text" bind:value={ing.qty}  placeholder="1"
                      on:blur={() => ing.qty = _normaliseQtyForUnit(ing.qty, ing.unit)} />
                    <UnitPicker bind:value={ing.unit} placeholder="unit"
                      on:change={() => ing.qty = _normaliseQtyForUnit(ing.qty, ing.unit)} />
                    <div class="ing-name-wrap">
                      <input class="input ing-name" type="text" bind:value={ing.name} placeholder="flour"
                        list="pantry-names" autocomplete="off" />
                      <!-- Mobile state indicators: signal linked-pantry
                           and has-note state on the primary row so the
                           user sees what's stashed behind the kebab
                           without opening it. Non-interactive; the
                           kebab is the tap target. -->
                      <span class="ing-indicators">
                        {#if ing.pantry_item_id}
                          <span class="ing-ind linked" title={pantryNamesById.get(ing.pantry_item_id) ? `Linked to ${pantryNamesById.get(ing.pantry_item_id)}` : 'Linked to Pantry'}>
                            <span class="material-symbols-rounded">kitchen</span>
                          </span>
                        {/if}
                        {#if ing.note && ing.note.trim()}
                          <span class="ing-ind note" title="Has a note">
                            <span class="material-symbols-rounded">edit_note</span>
                          </span>
                        {/if}
                      </span>
                    </div>
                    <input class="input ing-note" type="text" bind:value={ing.note} placeholder="sifted" />
                    <button class="btn-icon small pantry-swap-btn desktop-only-btn"
                      class:linked={!!ing.pantry_item_id}
                      on:click={() => ing.pantry_item_id ? unlinkRowAt(gi, ii) : openPantrySwap(gi, ii)}
                      aria-label={ing.pantry_item_id
                        ? `Linked to ${pantryNamesById.get(ing.pantry_item_id) || 'a Pantry item'} — click to unlink`
                        : 'Link to a Pantry item'}
                      title={ing.pantry_item_id
                        ? (pantryNamesById.get(ing.pantry_item_id)
                            ? `Linked to ${pantryNamesById.get(ing.pantry_item_id)} — click to unlink`
                            : 'Linked to a Pantry item — click to unlink')
                        : 'Link to a Pantry item'}>
                      <span class="material-symbols-rounded">kitchen</span>
                    </button>
                    <button class="btn-icon small desktop-only-btn" on:click={() => toggleSectionAt(gi, ii)}
                      aria-label="Start a section here" title="Start a new section at this row">
                      <span class="material-symbols-rounded">subdirectory_arrow_right</span>
                    </button>
                    <button class="btn-icon small desktop-only-btn" on:click={() => removeIngredient(gi, ii)} aria-label="Remove" title="Remove">
                      <span class="material-symbols-rounded">delete</span>
                    </button>
                    <!-- Kebab lives on mobile only. Rolls up the three
                         actions above + note editing into one tap. -->
                    <button class="btn-icon small ing-kebab" on:click={() => openIngredientMenu(gi, ii)}
                      aria-label="Ingredient actions" title="Actions">
                      <span class="material-symbols-rounded">more_vert</span>
                    </button>
                  </div>
                  <!-- Mobile-only expanded note row. Renders whenever
                       the ingredient already has a note OR the user
                       just tapped Add Note from the kebab menu. Never
                       shown on desktop — the note has its own column
                       in the primary grid there. -->
                  {#if _isNoteOpen(gi, ii, ing)}
                    <div class="ing-note-row">
                      <input class="input ing-note-mobile" type="text"
                        bind:value={ing.note}
                        placeholder="Note (e.g. sifted, room-temp)"
                        autofocus={notesExpanded.has(_ingKey(gi, ii)) && !(ing.note && ing.note.trim())} />
                    </div>
                  {/if}
                {/each}

              </div>
            {/each}

            <!-- One global Add row at the very bottom — appends to the
                 last section. Sections are created contextually via the
                 row-level "Start a section here" arrow, so per-section
                 add buttons would be redundant. -->
            <div class="ing-add-row">
              <button class="btn btn-secondary add-btn" on:click={() => addIngredient(ingredientGroups.length - 1)}>
                <span class="material-symbols-rounded">add</span> Add Ingredient
              </button>
              <button class="btn btn-secondary add-btn pantry-add-btn" on:click={() => openPantryPicker(ingredientGroups.length - 1)}>
                <span class="material-symbols-rounded">kitchen</span> Add from Pantry
              </button>
            </div>
          </section>

          <!-- Steps -->
          <section class="section editor-col-steps">
            <h2 class="section-title">{$_('recipe_editor_ct.steps')}</h2>
            {#each steps as _, i (i)}
              <div class="step-row"
                class:dragging={stepDragSource === i}
                class:drag-over={stepDragOver === i}
                on:dragover={(e) => _onStepDragOver(i, e)}
                on:dragleave={() => _onStepDragLeave(i)}
                on:drop={(e) => _onStepDrop(i, e)}>
                <button class="step-handle"
                  draggable="true"
                  on:dragstart={(e) => _onStepDragStart(i, e)}
                  on:dragend={_onStepDragEnd}
                  type="button"
                  aria-label="Drag to reorder"
                  title="Drag to reorder">
                  <span class="material-symbols-rounded">drag_indicator</span>
                </button>
                <span class="step-num">{i + 1}</span>
                <div class="step-fields">
                  <input
                    class="input step-title-input"
                    type="text"
                    bind:value={steps[i].title}
                    placeholder="Optional summary (e.g. Preheat Oven)"
                  />
                  <div class="step-text-wrap">
                    <MarkdownToolbar bind:textarea={stepTextareas[i]} onChange={(v) => steps[i].text = v} />
                    <textarea
                      class="input step-text-input"
                      rows="4"
                      bind:this={stepTextareas[i]}
                      bind:value={steps[i].text}
                      placeholder="Preheat oven to 350°F…"
                    ></textarea>
                  </div>
                  {#if i === 0}
                    <p class="step-hint">
                      Markdown: <strong>**bold**</strong>, <em>*italic*</em>, <u>__underline__</u>, <code>- bullet</code>, <code>1. number</code>. Time mentions like <em>15 minutes</em> become tappable timers.
                    </p>
                  {/if}
                  <!-- Per-step ingredient links (issue #40). Users tap
                       ingredients to attach them to this step; Cook
                       Mode then renders those inline below the step so
                       quantities are visible without scrolling back to
                       the top. Ingredients not linked to any step
                       still appear in the standard top list. Only
                       renders when there are named ingredients to link
                       against. -->
                  {#if allIngredientOptions.length > 0}
                    {@const _linked = new Set(Array.isArray(steps[i]?.refIds) ? steps[i].refIds : [])}
                    {@const _expanded = stepLinksExpanded.has(i)}
                    <div class="step-links" class:expanded={_expanded}>
                      <button type="button" class="step-links-toggle"
                        on:click={() => toggleStepLinksPanel(i)}
                        aria-expanded={_expanded}
                        title={_expanded ? 'Hide ingredient links' : 'Link ingredients used in this step'}>
                        <span class="material-symbols-rounded">link</span>
                        <span class="step-links-label">
                          {_linked.size > 0
                            ? `${_linked.size} ingredient${_linked.size === 1 ? '' : 's'} linked`
                            : 'Link ingredients used in this step'}
                        </span>
                        <span class="material-symbols-rounded step-links-chev" class:open={_expanded}>expand_more</span>
                      </button>
                      {#if _expanded}
                        <div class="step-links-chips" transition:slide={{ duration: 140 }}>
                          {#each allIngredientOptions as opt (opt.id)}
                            <button type="button" class="step-link-chip" class:active={_linked.has(opt.id)}
                              on:click={() => toggleStepIngredientRef(i, opt.id)}
                              title={_linked.has(opt.id) ? 'Unlink from this step' : 'Link to this step'}>
                              {#if _linked.has(opt.id)}
                                <span class="material-symbols-rounded">check</span>
                              {/if}
                              <span class="step-link-chip-name">{opt.name}</span>
                            </button>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {/if}
                  <!-- Step photo: collapsed-by-default. Empty state shows
                       a small + Add Photo button next to the row's other
                       icons so the form stays compact. Once an image
                       lives on the step, we render a thumbnail with a
                       remove button; tapping the thumbnail re-opens
                       the picker for replacement. -->
                  {#if steps[i].imgUrl}
                    <div class="step-photo-mounted">
                      <img class="step-photo-thumb" src={resolveAssetUrl(steps[i].imgUrl)} alt="" />
                      <button class="btn btn-secondary tiny" on:click={() => steps[i].imgUrl = ''}
                        type="button" aria-label="Remove step photo" title="Remove">
                        <span class="material-symbols-rounded">close</span>
                        Remove
                      </button>
                    </div>
                  {/if}
                </div>
                <div class="step-actions">
                  <button class="btn-icon small" on:click={() => openStepPhotoSheet(i)}
                    aria-label="Add a step photo" title={steps[i].imgUrl ? 'Replace step photo' : 'Add a step photo'}>
                    <span class="material-symbols-rounded">add_a_photo</span>
                  </button>
                  <button class="btn-icon small" on:click={() => removeStep(i)} aria-label="Remove">
                    <span class="material-symbols-rounded">delete</span>
                  </button>
                </div>
              </div>
            {/each}
            <button class="btn btn-secondary add-btn" on:click={addStep}>
              <span class="material-symbols-rounded">add</span> Add Step
            </button>
          </section>
          </div><!-- /.editor-grid -->

          <!-- Category + Tags + Kitchen Gear -->
          <div class="field">
            <span class="field-label">{$_('editor.category')}</span>
            <Combobox
              bind:this={comboCategoryRef}
              mode="single"
              value={categoryName}
              options={categories.map(c => ({ name: c.name, color: c.color }))}
              placeholder="Pick or create a category…"
              creatable={true}
              createLabel="Create category"
              on:select={onCategorySelect}
              on:create={openNewCategoryDialog}
              on:change={(e) => { if (!e.detail) onCategoryClear(); }}
            />
            <span class="field-hint">{@html $_('recipe_editor_ct.category_hint_html')}</span>
          </div>

          <div class="field">
            <span class="field-label">{$_('recipe.tags')}</span>
            <Combobox
              mode="chips"
              bind:value={tags}
              options={tagOptions}
              placeholder={tags.length ? '' : 'dessert, baking, freezer-friendly…'}
              creatable={true}
              createLabel="Create tag"
            />
            <span class="field-hint">Type to filter existing tags or create a new one.</span>
          </div>

          <div class="field">
            <span class="field-label">{$_('recipe.kitchen_gear')}</span>
            <Combobox
              mode="chips"
              bind:value={tools}
              options={toolOptions}
              placeholder={tools.length ? '' : 'spatula, parchment paper, sheet tray, dutch oven…'}
              creatable={true}
              createLabel="Add gear"
            />
            <span class="field-hint">Tools, pans, parchment, anything you'd reach for. Type to filter or create new.</span>
          </div>

          <!-- Nutrition (per serving) — collapsible. Renders inputs for the
               nutriments the user has chosen to see (visibleNutriments
               setting), defaulting to NT's curated subset. Empty values are
               dropped on save; sodium ↔ salt auto-derives server-side. -->
          <section class="section">
            <button type="button" class="section-toggle" on:click={() => nutritionOpen = !nutritionOpen}>
              <span class="material-symbols-rounded">{nutritionOpen ? 'expand_less' : 'expand_more'}</span>
              <span>{$_('recipe_editor_ct.nutrition')} <span class="field-hint">{$_('pantry_editor_ct.icon_hint')}</span></span>
            </button>
            {#if nutritionOpen}
              <p class="field-hint" style="margin: 4px 0 8px;">
                Customize which nutrients appear here in Settings &rarr; Nutrition.
              </p>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 12px">
                <button type="button" class="btn btn-secondary" style="height:34px;font-size:12px" on:click={autoCalcNutrition}>
                  <span class="material-symbols-rounded" style="font-size:16px">auto_fix_high</span>
                  Auto-calc from pantry
                </button>
                {#if autoCalcStatus}
                  <span class="field-hint" style="font-size:11px">{autoCalcStatus}</span>
                {/if}
              </div>
              <div class="nut-grid">
                {#each editableNutriments as nut (nut.id)}
                  <label class="field nut-field" class:nut-sub={nut.subOf}>
                    <span class="field-label">
                      {nut.label}
                      <span class="field-hint">{nut.unit}</span>
                    </span>
                    <input
                      class="input num"
                      type="number"
                      min="0"
                      step={nut.unit === 'g' || nut.unit === 'mg' ? '0.1' : 'any'}
                      bind:value={nutrition[nut.id]}
                    />
                  </label>
                {/each}
              </div>
            {/if}
          </section>

          <label class="field">
            <span class="field-label">{$_('editor.source_url')}</span>
            <input class="input" type="url" bind:value={sourceUrl} placeholder="https://example.com/the-best-banana-bread" />
          </label>

          <!-- Video Instructions — three-button row matching the
               ImagePicker pattern (Record → Upload → URL field), plus
               an inline preview of the chosen video. Section hides
               itself in RecipeView when video_url is null. -->
          <div class="field">
            <span class="field-label">{$_('recipe_editor_ct.video_instructions')} <span class="field-hint">{$_('recipe_editor_ct.optional_hint')}</span></span>
            <div class="video-picker">
              <input type="file" accept="video/*" capture="environment"
                bind:this={_videoCameraInput} on:change={_onVideoFile} hidden />
              <input type="file" accept="video/*"
                bind:this={_videoFileInput}   on:change={_onVideoFile} hidden />
              <button class="vid-btn" type="button"
                on:click={() => _videoCameraInput?.click()}
                disabled={videoUploading}
                title="Record with your camera">
                <span class="material-symbols-rounded">videocam</span>
                <span>{$_('recipe_editor_ct.record')}</span>
              </button>
              <button class="vid-btn" type="button"
                on:click={() => _videoFileInput?.click()}
                disabled={videoUploading}
                title="Upload a video file">
                <span class="material-symbols-rounded">upload</span>
                <span>{$_('recipe_editor_ct.upload')}</span>
              </button>
              <div class="vid-url-wrap">
                <span class="material-symbols-rounded">link</span>
                <input class="input vid-url" type="url" bind:value={videoUrl}
                  placeholder="Paste YouTube / Vimeo / video URL" />
              </div>
            </div>
            {#if videoUploading}
              <p class="video-hint upload">Uploading video…</p>
            {:else if videoUrl}
              <div class="video-preview">
                {#if videoUrl.startsWith('/uploads/') || videoUrl.startsWith('uploads/')}
                  <video class="video-preview-media" controls preload="metadata"
                    src={resolveAssetUrl(videoUrl)}></video>
                  <span class="video-hint">{$_('recipe_editor_ct.local_upload')}</span>
                {:else}
                  <a class="video-link" href={videoUrl} target="_blank" rel="noopener noreferrer">
                    <span class="material-symbols-rounded">open_in_new</span>
                    {videoUrl}
                  </a>
                  <span class="video-hint">{$_('recipe_editor_ct.external_url')}</span>
                {/if}
                <button class="btn-icon small" type="button" on:click={clearVideo}
                  aria-label="Clear video" title="Clear video">
                  <span class="material-symbols-rounded">close</span>
                </button>
              </div>
            {/if}
          </div>

          <div class="field">
            <span class="field-label">{$_('recipe.notes')}</span>
            <RichTextEditor bind:value={notes} placeholder="Tweaks, observations, who liked it…" rows={4} />
          </div>

        </div>
      </div>
    {/if}
  </div>
</div>

<!-- New-category dialog. Single-mode combobox fires `create` with the
     typed string; we open this so the user can pick a color before the
     row is written. Confirm calls back into the combobox so its display
     value updates atomically. -->
{#if pantryPickerOpen}
  <div class="cat-modal-backdrop" on:click={closePantryPicker}>
    <div class="cat-modal pantry-picker-modal" on:click|stopPropagation>
      <h3 class="cat-modal-title">{pantryPickerMode === 'swap' ? 'Link to a Pantry Item' : 'Add from Pantry'}</h3>
      {#if pantryPickerMode === 'swap'}
        <p class="pp-hint">Pick a Pantry item to link this ingredient to. Your typed name, quantity, and notes stay the same — the link just attaches the brand, nutrition, and stock data behind the scenes.</p>
      {/if}
      <input class="input" type="search" placeholder="Search pantry…"
        bind:value={pantryPickerQuery} autofocus />
      <div class="pantry-picker-list">
        {#if pantryPickerLoading}
          <Spinner block label="Loading pantry…" />
        {:else if pantryPickerFiltered.length === 0}
          <p class="empty">{pantryPickerRows.length === 0 ? 'Your pantry is empty.' : `No pantry items match "${pantryPickerQuery}".`}</p>
        {:else}
          {#each pantryPickerFiltered as p (p.id)}
            <label class="pp-row" class:on={pantryPickerSelected.has(p.id)}>
              <input type="checkbox" checked={pantryPickerSelected.has(p.id)}
                on:change={() => togglePantrySelected(p.id)} />
              <span class="pp-name">{p.name}</span>
              {#if p.brand}<span class="pp-brand">{p.brand}</span>{/if}
              {#if !p.in_stock}<span class="pp-out">Out</span>{/if}
            </label>
          {/each}
        {/if}
      </div>
      <div class="cat-modal-actions">
        <button class="btn btn-secondary" on:click={closePantryPicker}>{$_('recipe_editor_ct.cancel')}</button>
        <button class="btn btn-primary" on:click={confirmPantryPicker}
          disabled={pantryPickerSelected.size === 0}>
          {pantryPickerMode === 'swap' ? 'Link' : `Add ${pantryPickerSelected.size > 0 ? pantryPickerSelected.size : ''}`}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if categoryNewOpen}
  <div class="cat-modal-backdrop" on:click={() => categoryNewOpen = false}>
    <div class="cat-modal" on:click|stopPropagation>
      <h3 class="cat-modal-title">{$_('recipe_editor_ct.cat_modal_title')}</h3>
      <label class="field">
        <span class="field-label">{$_('recipe_editor_ct.name')}</span>
        <input class="input" type="text" bind:value={categoryNewName} autofocus />
      </label>
      <label class="field">
        <span class="field-label">{$_('recipe_editor_ct.color')}</span>
        <div class="cat-modal-swatches">
          {#each SWATCHES as sw}
            <button class="swatch" class:active={categoryNewColor === sw}
              style={`background:${sw}`}
              on:click={() => categoryNewColor = sw}
              title={sw} aria-label={`Color ${sw}`} type="button"></button>
          {/each}
          <button class="swatch none" class:active={!categoryNewColor}
            on:click={() => categoryNewColor = null}
            title="No color" aria-label="No color" type="button"></button>
        </div>
      </label>
      <div class="cat-modal-actions">
        <button class="btn btn-secondary" on:click={() => categoryNewOpen = false}>{$_('recipe_editor_ct.cancel')}</button>
        <button class="btn btn-primary" on:click={confirmNewCategory} disabled={!categoryNewName.trim()}>{$_('recipe_editor_ct.create')}</button>
      </div>
    </div>
  </div>
{/if}

<!-- Step-photo picker dialog. Reuses the existing ImagePicker component
     (Camera / Upload / URL) so we don't duplicate any of that logic; the
     dialog is just a thin shell that lets us hide the picker until the
     user actually wants to attach a photo to a specific step. -->
{#if stepPhotoSheetIdx != null && steps[stepPhotoSheetIdx]}
  <div class="cat-modal-backdrop" on:click={closeStepPhotoSheet}>
    <div class="cat-modal" on:click|stopPropagation>
      <header class="step-photo-modal-head">
        <h3 class="cat-modal-title">Step {stepPhotoSheetIdx + 1} Photo</h3>
        <button class="btn-icon" on:click={closeStepPhotoSheet} aria-label="Close" title="Close">
          <span class="material-symbols-rounded">close</span>
        </button>
      </header>
      <ImagePicker bind:value={steps[stepPhotoSheetIdx].imgUrl}
        aspect="16 / 9"
        placeholder={$_('recipe_editor_ct.add_step_photo_ph')} />
      <div class="cat-modal-actions">
        <button class="btn btn-primary" on:click={closeStepPhotoSheet}>{$_('recipe_editor_ct.done')}</button>
      </div>
    </div>
  </div>
{/if}

<!-- Ingredient kebab-menu action sheet (mobile). Rolls up the three
     per-row action buttons + "Add Note" so the primary row can give
     the name field the space it needs to be readable. -->
<ActionSheet
  bind:open={ingActionOpen}
  title={ingActionTarget?.name || 'Ingredient'}
  actions={ingActions}
  on:select={onIngredientAction}
/>

<style>
  /* editor-page + editor-header inherit from base.css */
  .editor-save { height: 36px; padding: 0 16px; font-size: 13px; }

  .btn-icon {
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    width: 40px; height: 40px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    color: var(--text-1);
    flex-shrink: 0;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .btn-icon:hover { background: var(--surface-2); }
  .btn-icon.close-btn:hover {
    background: color-mix(in srgb, var(--error, #ef4444) 18%, transparent);
    color: var(--error, #ef4444);
  }
  .btn-icon.small { width: 34px; height: 34px; }
  .btn-icon.small:hover { color: var(--error, #f87171); }
  /* Pantry-swap button: muted by default, accent-tinted when the row
     is already linked to a Pantry item so users can see at a glance
     which ingredients carry their stocked-brand metadata. */
  .btn-icon.pantry-swap-btn:hover { color: var(--accent); background: var(--surface-2); }
  .btn-icon.pantry-swap-btn.linked {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .btn-icon.pantry-swap-btn.linked:hover {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
  }

  .state {
    text-align: center;
    padding: 80px 16px;
    color: var(--text-3);
  }
  .spin {
    font-size: 32px;
    animation: spin 1.2s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .form-wrap {
    padding: 18px var(--page-px) 32px;
    /* Mobile / narrow: comfortable single-column reading width.
       At >=960px the body gets a 2-col Ingredients|Steps layout so
       we widen the cap to give each column room without ingredient
       rows wrapping aggressively. */
    max-width: 880px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }
  @media (min-width: 1100px) {
    .form-wrap { max-width: 1280px; }
  }
  @media (min-width: 1400px) {
    .form-wrap { max-width: 1480px; }
  }
  @media (min-width: 1700px) {
    .form-wrap { max-width: 1760px; }
  }
  .form { display: flex; flex-direction: column; gap: 16px; }

  /* Cap the hero image preview so it stays a header anchor rather
     than dominating the viewport on wide monitors. Mobile / tablet
     keeps the full-width preview; desktop centers a comfortable
     ~820px frame (~460px tall at 16:9) so the page reads as
     "header image then form" rather than "left-stuck preview". */
  .hero-wrap { width: 100%; }
  @media (min-width: 960px) {
    .hero-wrap {
      max-width: 820px;
      margin: 0 auto;
    }
  }

  /* Two-column editing body: Ingredients on the left, Steps on the
     right. Stacks on narrow screens. Each column is a flex item so
     section internals (drag handles, action buttons) flow normally. */
  .editor-grid {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  /* Phone landscape (Pixel 6 Pro ≈ 892px, foldables 900-1100px) used
     to trip the old 960px breakpoint and jam both columns into cramped
     space. Held until 1200px so any phone stays single-column stacked;
     tablets in landscape and real desktops still get the two-column
     Ingredients-left / Steps-right view. Below 1200px each panel gets
     the whole viewport width, so the ingredient row's own 8-column
     desktop grid (~276px chrome + name + note) has plenty of room to
     breathe even between the 900px kebab-off and the 1200px 2-col
     thresholds. */
  @media (min-width: 1200px) {
    .editor-grid {
      display: grid;
      grid-template-columns: minmax(420px, 1.1fr) minmax(0, 1fr);
      gap: 28px;
      align-items: flex-start;
    }
    .editor-col-ing,
    .editor-col-steps { margin-top: 0; }
  }
  @media (min-width: 1400px) {
    /* On wider monitors give Ingredients a real breathing column
       without starving Steps. */
    .editor-grid {
      grid-template-columns: minmax(520px, 1.15fr) minmax(0, 1fr);
    }
  }

  .image-block {
    width: 100%;
    aspect-ratio: 16 / 9;
    background: var(--surface-1);
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    position: relative;
  }
  .image-preview { width: 100%; height: 100%; object-fit: cover; display: block; }
  .image-placeholder {
    width: 100%; height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    font-size: 14px;
  }
  .image-placeholder .material-symbols-rounded {
    font-size: 36px;
    color: var(--accent);
    opacity: 0.7;
  }
  .image-actions {
    position: absolute;
    bottom: 8px;
    right: 8px;
    display: flex;
    gap: 6px;
  }
  .file-input { display: none; }

  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .field-hint { font-weight: 400; color: var(--text-3); font-size: 12px; }
  .field-row { display: flex; gap: 10px; }
  .field-row .flex { flex: 1; min-width: 0; }

  .input {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 9px 12px;
    color: var(--text-1);
    font-size: 14px;
    font-family: inherit;
    width: 100%;
    box-sizing: border-box;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  textarea.input { resize: vertical; min-height: 44px; }
  .input.num { text-align: right; }

  .section { margin-top: 8px; }
  .section-title {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
    margin: 0 0 8px;
  }

  .ing-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--surface-1) 60%, transparent);
    margin-bottom: 12px;
  }
  .ing-group-header {
    display: flex;
    gap: 6px;
    align-items: center;
    padding-bottom: 4px;
    border-bottom: 1px dashed var(--border);
    margin-bottom: 6px;
  }
  .ing-group-name {
    flex: 1;
    font-weight: 600;
    color: var(--accent);
    background: transparent;
    border-color: transparent;
  }
  .ing-group-name:focus {
    background: var(--surface-1);
    border-color: var(--border);
  }

  .ing-row {
    position: relative;
    display: grid;
    /* Desktop: drag | qty | unit | name-wrap | note | pantry | section | delete
       The kebab is display:none on desktop so it takes no track. */
    grid-template-columns: 22px 60px 92px 1fr 1fr 34px 34px 34px;
    gap: 6px;
    margin-bottom: 6px;
    align-items: center;
    transition: background var(--dur-fast);
    border-radius: var(--radius-sm);
  }
  .ing-row .input { padding: 7px 9px; font-size: 13px; }
  /* Name-wrap holds the input + the mobile indicator icons (linked,
     has-note). On desktop the indicators hide because the note column
     and the pantry-link button already convey that state visibly. */
  .ing-name-wrap {
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .ing-name-wrap .ing-name { width: 100%; padding-right: 8px; }
  .ing-indicators {
    display: none; /* desktop */
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    gap: 2px;
    align-items: center;
    pointer-events: none;
  }
  .ing-ind { display: inline-flex; align-items: center; justify-content: center; }
  .ing-ind .material-symbols-rounded { font-size: 15px; color: var(--accent); }
  .ing-ind.note .material-symbols-rounded { color: var(--text-3); }
  .ing-kebab { display: none; /* desktop */ }
  .ing-note-row {
    /* Second-line note input. Aligns under the name column so it reads
       as attached to the ingredient rather than a standalone field. */
    display: none;
    grid-column: 1 / -1;
    padding: 0 6px 6px 34px; /* left-indent past the drag handle */
  }
  .ing-note-row .ing-note-mobile { width: 100%; }
  .ing-row.dragging { opacity: 0.4; }
  .ing-row.drag-over::before {
    content: '';
    position: absolute;
    left: 0; right: 0; top: -3px;
    height: 2px;
    background: var(--accent);
    border-radius: 1px;
  }

  .ing-handle {
    background: transparent;
    border: none;
    cursor: grab;
    color: var(--text-3);
    padding: 0;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
  }
  .ing-handle:hover { color: var(--text-1); background: var(--surface-2); }
  .ing-handle:active { cursor: grabbing; }
  .ing-handle .material-symbols-rounded { font-size: 18px; }

  @media (max-width: 900px) {
    /* Mobile + phone-landscape + tablet-portrait: drag | qty | unit |
       name-wrap (with indicators) | kebab. Below ~900px the desktop
       eight-column grid crushes the name field even in landscape
       (~750-850px on typical phones). Actions surface via ActionSheet
       on kebab tap; any active note appears on a second inline row. */
    .ing-row {
      grid-template-columns: 22px 50px 78px 1fr 34px;
    }
    .ing-row .ing-note { display: none; }
    .ing-row .desktop-only-btn { display: none; }
    .ing-row .ing-kebab { display: inline-flex; }
    .ing-indicators { display: inline-flex; }
    .ing-name-wrap .ing-name { padding-right: 46px; }
    .ing-note-row { display: block; }
  }

  /* Video picker — three-row layout mirroring ImagePicker:
     Record (camera) | Upload | URL field. */
  .video-picker {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-top: 6px;
  }
  .vid-btn {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    color: var(--text-1);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 40px;
  }
  .vid-btn:hover:not(:disabled) { background: var(--surface-1); border-color: var(--accent-dim); color: var(--accent); }
  .vid-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .vid-btn .material-symbols-rounded { font-size: 18px; color: var(--accent); }
  .vid-url-wrap {
    grid-column: span 2;
    display: flex; align-items: center; gap: 6px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding-left: 10px;
  }
  .vid-url-wrap .material-symbols-rounded { color: var(--text-3); font-size: 18px; }
  .vid-url {
    flex: 1; border: none; background: transparent;
    padding: 9px 10px;
  }
  .vid-url:focus { outline: none; }

  .video-preview {
    margin-top: 8px;
    padding: 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .video-preview-media {
    width: 100%;
    max-height: 180px;
    border-radius: var(--radius-sm);
    background: black;
  }
  .video-link {
    display: inline-flex; align-items: center; gap: 4px;
    color: var(--accent);
    text-decoration: none;
    font-size: 13px;
    word-break: break-all;
    flex: 1; min-width: 0;
  }
  .video-link .material-symbols-rounded { font-size: 14px; flex-shrink: 0; }
  .video-hint {
    color: var(--text-3);
    font-size: 11px;
    background: var(--surface-1);
    padding: 2px 8px;
    border-radius: 999px;
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .video-hint.upload { background: transparent; padding: 0; text-transform: none; letter-spacing: 0; font-weight: 500; margin-top: 6px; }

  /* Pantry picker modal */
  .pantry-picker-modal { max-width: 480px; max-height: 80vh; }
  .pp-hint { margin: 0 0 8px; color: var(--text-3); font-size: 12px; line-height: 1.4; }
  .pantry-picker-list {
    flex: 1;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    max-height: 320px;
  }
  .pp-row {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 12px;
    border-top: 1px solid var(--border);
    cursor: pointer;
  }
  .pp-row:first-child { border-top: none; }
  .pp-row:hover, .pp-row.on { background: var(--surface-2); }
  .pp-row input { accent-color: var(--accent); }
  .pp-name  { flex: 1; color: var(--text-1); font-weight: 600; font-size: 14px; }
  .pp-brand { color: var(--text-3); font-size: 11px; }
  .pp-out   {
    background: color-mix(in srgb, var(--error, #f87171) 18%, transparent);
    color: var(--error, #f87171);
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .pantry-picker-list .empty {
    color: var(--text-3); font-size: 13px;
    padding: 24px; text-align: center; margin: 0;
  }
  .pantry-add-btn { margin-left: 6px; }

  /* One global Add row beneath all ingredient sections. Inline-flex so
     the two buttons sit side-by-side; the pantry-add-btn already has
     its 6px margin so we don't add gap here. */
  .ing-add-row {
    display: flex;
    align-items: center;
    margin-top: 8px;
  }

  .step-row {
    position: relative;
    display: flex;
    gap: 10px;
    margin-bottom: 12px;
    align-items: flex-start;
    transition: background var(--dur-fast);
    border-radius: var(--radius-sm);
  }
  .step-row.dragging { opacity: 0.4; }
  .step-row.drag-over::before {
    content: '';
    position: absolute;
    left: 0; right: 0; top: -3px;
    height: 2px;
    background: var(--accent);
    border-radius: 1px;
  }
  .step-handle {
    background: transparent;
    border: none;
    cursor: grab;
    color: var(--text-3);
    padding: 0;
    width: 22px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
    margin-top: 0;
  }
  .step-handle:hover { color: var(--text-1); background: var(--surface-2); }
  .step-handle:active { cursor: grabbing; }
  .step-handle .material-symbols-rounded { font-size: 18px; }
  .step-num {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--accent-dim);
    color: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 13px;
    margin-top: 6px;
  }
  .step-fields {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .step-title-input {
    font-size: 13px;
    font-weight: 600;
  }
  /* Markdown toolbar + textarea share a single rounded border so the
     toolbar reads as part of the input rather than a floating bar. */
  .step-text-wrap {
    display: flex;
    flex-direction: column;
  }
  .step-text-input {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
    border-top: 0;
  }
  /* Step row's right-side icon column. Holds Add-photo + Delete
     stacked vertically so the row stays compact on narrow viewports. */
  .step-actions {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex-shrink: 0;
  }
  /* Thumbnail rendered after a step photo has been attached. Sits in
     the field column under the textarea; tap Remove to clear, tap the
     Add-photo button again to replace. */
  .step-photo-mounted {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-top: 6px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2);
  }
  .step-photo-thumb {
    width: 96px;
    height: 54px; /* 16/9 */
    object-fit: cover;
    border-radius: var(--radius-sm);
  }
  .step-photo-mounted .btn.tiny {
    height: 28px;
    font-size: 12px;
    padding: 0 10px;
  }

  .rating-field {
    flex-direction: row;
    align-items: center;
    gap: 14px;
  }
  .rating-field .field-label { margin-bottom: 0; }

  .section-toggle {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-1);
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0;
    margin: 0 0 10px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .section-toggle:hover { color: var(--accent); }
  .section-toggle .material-symbols-rounded { font-size: 18px; }

  .nut-grid {
    display: grid;
    /* min-width 160px guarantees "Total Carbohydrate g" /
       "Saturated Fat g" / etc. all fit on one line — auto-fill still
       packs as many columns as the form-wrap allows. */
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 10px;
  }
  /* Long FDA-style labels stay on one line; the unit ("g" / "mg")
     wraps to the next line under the label if absolutely necessary,
     which we'd rather avoid via the wider min-width above. */
  .nut-grid .field-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .add-btn {
    margin-top: 8px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .add-btn .material-symbols-rounded { font-size: 18px; }

  /* Restore-draft banner — appears at the top of the form when an
     auto-saved draft from a previous session exists. Dismiss to
     start fresh, Restore to populate every field with the draft. */
  .draft-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    margin-bottom: 14px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: var(--radius-md);
    font-size: 13px;
    flex-wrap: wrap;
  }
  .draft-banner .material-symbols-rounded { color: var(--accent); font-size: 18px; }
  .draft-msg { flex: 1; min-width: 200px; color: var(--text-1); }
  .draft-actions { display: flex; gap: 6px; }
  .draft-actions .btn.tiny { height: 28px; font-size: 12px; padding: 0 10px; }

  .step-hint {
    margin: 4px 0 0;
    color: var(--text-3);
    font-size: 11px;
    line-height: 1.4;
  }
  .step-hint strong, .step-hint em, .step-hint u { color: var(--text-2); }

  /* Per-step ingredient links (issue #40). Collapsed by default — a
     small toggle row shows the count and expands to reveal the chip
     picker. Keeps the editor vertically compact when the user isn't
     using the feature; opens with a soft slide when they are. */
  .step-links {
    display: flex; flex-direction: column; gap: 6px;
    margin: 8px 0 2px;
    padding: 6px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    transition: padding var(--dur-fast);
  }
  .step-links.expanded { padding: 8px 10px 10px; }
  .step-links-toggle {
    display: flex; align-items: center; gap: 6px;
    width: 100%;
    background: transparent; border: none; padding: 4px 0;
    color: var(--text-3);
    font: inherit; cursor: pointer;
    text-align: left;
  }
  .step-links-toggle:hover .step-links-label { color: var(--text-1); }
  .step-links-toggle > .material-symbols-rounded { font-size: 14px; color: var(--accent); flex-shrink: 0; }
  .step-links-label {
    flex: 1;
    font-size: 11px; font-weight: 600; color: var(--text-3);
    text-transform: uppercase; letter-spacing: 0.04em;
    transition: color var(--dur-fast);
  }
  .step-links-chev { font-size: 18px !important; color: var(--text-3) !important; transition: transform 160ms ease; }
  .step-links-chev.open { transform: rotate(180deg); }
  .step-links-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .step-link-chip {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 3px 10px;
    border-radius: var(--radius-full, 99px);
    font: inherit; font-size: 12px; font-weight: 500;
    cursor: pointer;
    max-width: 240px;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .step-link-chip:hover { color: var(--text-1); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .step-link-chip.active {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .step-link-chip .material-symbols-rounded { font-size: 13px; }
  .step-link-chip-name {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    max-width: 200px;
  }

  /* New-category dialog. Modest modal — backdrop + centered card. */
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
  /* Header row with a close X to the right of the title. Matches
     CT's dominant modal pattern (Shopping, Sheet, CookbookImportDialog,
     editor page-header). Older cat-modal instances (Pantry picker,
     New category) keep their explicit Cancel button because they
     need commit-vs-cancel semantics. */
  .step-photo-modal-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .step-photo-modal-head .btn-icon {
    width: 32px; height: 32px;
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3);
    border-radius: 50%;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .step-photo-modal-head .btn-icon:hover { background: var(--surface-2); color: var(--text-1); }
  .step-photo-modal-head .btn-icon .material-symbols-rounded { font-size: 20px; }
  .cat-modal-swatches {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .swatch {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
    transition: transform var(--dur-fast), border-color var(--dur-fast);
  }
  .swatch:hover { transform: scale(1.1); }
  .swatch.active {
    border-color: var(--text-1);
    transform: scale(1.1);
  }
  .swatch.none {
    background: var(--surface-2);
    border: 1px dashed var(--border);
    position: relative;
  }
  .swatch.none::after {
    content: '';
    position: absolute;
    inset: 6px;
    border-top: 1.5px solid var(--text-3);
    transform: rotate(45deg);
  }
  .cat-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
</style>
