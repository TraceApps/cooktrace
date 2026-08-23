<script>
  import { push } from 'svelte-spa-router';

  // Close: prefer browser back so opening a recipe from Diary /
  // Shopping / a cookbook returns to that origin instead of always
  // dumping the user on the Recipes tab. Falls back to /recipes when
  // there's no history (deep link from an external app or a new tab).
  function _closeRecipe() {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back();
    } else {
      push('/recipes');
    }
  }
  import { fade } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { formatDuration } from '../lib/duration.js';
  import { NtApi } from '../lib/api.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import StarRating from '../components/ui/StarRating.svelte';
  import { sanitizeRichText } from '../components/ui/RichTextEditor.svelte';
  import NutritionFactsBox from '../components/recipe/NutritionFactsBox.svelte';
  import CookLogDialog from '../components/recipe/CookLogDialog.svelte';
  import { relativeTime, shortDate } from '../lib/relative-time.js';
  import { formatDate, formatUpdated, domainFromUrl } from '../lib/format.js';
  import { dateFormat } from '../stores/settings.js';
  import { scaleQty, displayQty, displayQtyParts, parseQty } from '../lib/qty.js';
  import { convertWithinFamily, convertQty, unitFamily } from '../lib/recipe-nutrition.js';
  import { resolveAssetUrl, isNative, getServerUrl } from '../lib/platform.js';
  import { portal } from '../lib/portal.js';
  import RecipeComments from '../components/recipe/RecipeComments.svelte';
  import KitchenGear from '../components/recipe/KitchenGear.svelte';
  import { splitWithTimes } from '../lib/parseTimes.js';
  import { formatStepText } from '../lib/step-format.js';
  import { startTimer, formatRemaining } from '../stores/cookTimers.js';
  import { cookModeActive } from '../stores/cookMode.js';
  import { currentUser } from '../stores/auth.js';
  import { onDestroy, tick } from 'svelte';
  import { computeRecipeNutrition, computeRecipeMass, lookupCommonDensity } from '../lib/recipe-nutrition.js';
  import ActionSheet from '../components/ui/ActionSheet.svelte';
  import { buildRecipeCardPages, buildRecipeShareText } from '../lib/recipe-card.js';
  import { svgToPngBlob, shareBlobs } from '../lib/shopping-card.js';

  export let params = {};

  let recipe = null;
  // Measured editor-header height — exposed as --editor-header-h on
  // the page-shell so the sticky TopTimerPill can pin directly below
  // the header instead of sliding underneath it on scroll.
  let editorHeaderH = 0;
  let loading = true;
  let loadError = null;
  let cookBusy = false;

  // Owner-only edit / delete. Admins can edit anything (matches the
  // server-side gate on PUT/DELETE). Anyone else viewing a recipe
  // shared with them via a Kitchen or per-user grant sees a
  // read-only view — the Edit / Delete buttons drop out and the
  // header shows the creator's byline so they know who to ask about
  // changes.
  $: canEdit = !!recipe && (
    recipe.user_id == null ||
    recipe.user_id === $currentUser?.id ||
    $currentUser?.role === 'admin'
  );
  $: isSharedView = !!recipe && recipe.user_id != null
    && $currentUser?.id != null
    && recipe.user_id !== $currentUser.id;

  // Scaling — multiplier applied to every ingredient qty + the displayed
  // serving count. 1 = original. Custom serving input drives this too.
  let scale = 1;
  // Sliding pill behind the active scaling chip — measured from the
  // chip's bounding rect so the pill animates smoothly between
  // ×0.5 / ×1 / ×2 / ×3 instead of hard-swapping the active fill.
  let scaleChipsEl = null;
  let scaleChipRefs = [];
  let scalePillX = 0, scalePillW = 0, scalePillReady = false;
  const SCALE_FACTORS = [0.5, 1, 2, 3];
  function _measureScalePill() {
    if (!scaleChipsEl) return;
    const idx = SCALE_FACTORS.indexOf(scale);
    const btn = idx >= 0 ? scaleChipRefs[idx] : null;
    if (!btn) { scalePillReady = false; return; }
    const c = scaleChipsEl.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    scalePillX = b.left - c.left + scaleChipsEl.scrollLeft;
    scalePillW = b.width;
    scalePillReady = true;
  }
  $: if (scale != null && scaleChipsEl) tick().then(_measureScalePill);
  $: scaledServings = recipe?.servings ? Math.round(recipe.servings * scale * 10) / 10 : null;

  // ── Inline unit converter ────────────────────────────────────────────
  // Per-ingredient: tap the ↔ icon to open a small menu of major target
  // units. Pick one → the row displays in that unit; pick Original →
  // revert. Read-only — recipe data is never modified.
  //
  // Cross-family conversions (volume → weight, e.g. cup → g) need
  // per-row density, resolved in this order:
  //   1. Linked pantry row's g_per_cup column.
  //   2. Built-in lookupCommonDensity(name) — covers ~250 staples.
  //   3. Otherwise the cross-family options are hidden for that row.
  // Major target units offered in the dropdown — intentionally short.
  const MAJOR_VOLUME_UNITS = ['tsp', 'tbsp', 'fl oz', 'cup', 'ml', 'l'];
  const MAJOR_WEIGHT_UNITS = ['g', 'kg', 'oz', 'lb'];
  // Per-row chosen target. Map<key, unit>. Absent key = show original.
  let convertedTargets = new Map();
  // Open menu key (one menu open at a time). Click outside closes.
  let openMenuKey = null;
  // Lazy pantry cache — fetched on first convert click. Map<id, row>
  // so we can look up g_per_cup / serving_unit per ingredient.
  let pantryById = null;
  let _pantryLoading = false;
  async function _ensurePantryLoaded() {
    if (pantryById || _pantryLoading) return;
    _pantryLoading = true;
    try {
      const rows = await NtApi.getPantry();
      pantryById = new Map((rows || []).map(p => [p.id, p]));
    } catch { pantryById = new Map(); }
    finally { _pantryLoading = false; }
  }
  async function openConvertMenu(key) {
    await _ensurePantryLoaded();
    openMenuKey = openMenuKey === key ? null : key;
  }
  function pickTarget(key, unit) {
    const next = new Map(convertedTargets);
    if (unit == null) next.delete(key);
    else next.set(key, unit);
    convertedTargets = next;
    openMenuKey = null;
  }
  // Click-outside handler for the open menu — close when the tap
  // didn't land on the menu itself or on the convertible qty button
  // that triggered it.
  function _onDocClick(e) {
    if (openMenuKey == null) return;
    if (!e.target.closest?.('.convert-menu') && !e.target.closest?.('.ing-qty.convertible')) {
      openMenuKey = null;
    }
  }
  if (typeof window !== 'undefined') {
    document.addEventListener('click', _onDocClick, true);
    onDestroy(() => document.removeEventListener('click', _onDocClick, true));
  }
  // Resolve g_per_cup for an ingredient: linked pantry row first, then
  // built-in name table.
  function _densityFor(ing, byId) {
    if (byId && ing.pantry_item_id != null) {
      const p = byId.get(ing.pantry_item_id);
      if (p && Number.isFinite(p.g_per_cup) && p.g_per_cup > 0) return p.g_per_cup;
    }
    const guess = lookupCommonDensity(ing.name || '');
    return Number.isFinite(guess) && guess > 0 ? guess : null;
  }
  // Build the list of options for a given row's input unit. Hides
  // cross-family options when density is unavailable, and the row's
  // own unit (so users can't pick "convert to the same thing").
  function targetOptionsFor(ing, byId) {
    const fam = unitFamily(ing.unit);
    if (fam !== 'volume' && fam !== 'weight') return [];
    const u = (ing.unit || '').toLowerCase().trim();
    const hasDens = _densityFor(ing, byId) != null;
    const out = [];
    // Volume options
    for (const v of MAJOR_VOLUME_UNITS) {
      if (v === u) continue;
      // weight → volume needs density too
      if (fam === 'weight' && !hasDens) continue;
      out.push({ unit: v, label: v });
    }
    // Weight options
    for (const w of MAJOR_WEIGHT_UNITS) {
      if (w === u) continue;
      if (fam === 'volume' && !hasDens) continue;
      out.push({ unit: w, label: w });
    }
    return out;
  }
  // Compute converted display parts for a row given the chosen target.
  // Falls back to null when the conversion isn't possible.
  function convertedParts(ing, scale, byId, target) {
    if (!target) return null;
    const baseQty = parseQty(ing.qty);
    if (!Number.isFinite(baseQty)) return null;
    const scaledQty = baseQty * scale;
    const dens = _densityFor(ing, byId);
    const fromFam = unitFamily(ing.unit);
    const toFam = unitFamily(target);
    let result;
    if (fromFam === toFam) {
      result = convertWithinFamily(scaledQty, ing.unit, target);
    } else {
      result = convertQty(scaledQty, ing.unit, target, dens);
    }
    if (result == null || !Number.isFinite(result)) return null;
    const rounded = Math.abs(result - Math.round(result)) < 0.05
      ? String(Math.round(result))
      : (Math.round(result * 10) / 10).toString();
    return { whole: rounded, fraction: '', unit: target };
  }
  function canConvert(ing) {
    const fam = unitFamily(ing.unit);
    if (fam !== 'volume' && fam !== 'weight') return false;
    return Number.isFinite(parseQty(ing.qty));
  }

  // Cook log dialog + history
  let cookDialogOpen = false;
  let editingCook = null;
  let cooks = [];
  let cooksLoading = false;

  // Lightbox state for click-to-zoom on cook history thumbs.
  let lightboxPhotos = [];
  let lightboxIndex = -1;
  function closeLightbox() { lightboxIndex = -1; lightboxPhotos = []; }
  function lightboxPrev() { if (lightboxIndex > 0) lightboxIndex -= 1; }
  function lightboxNext() { if (lightboxIndex < lightboxPhotos.length - 1) lightboxIndex += 1; }
  function onLightboxKey(e) {
    if (lightboxIndex < 0) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') lightboxPrev();
    else if (e.key === 'ArrowRight') lightboxNext();
  }
  $: if (Number.isFinite(id)) loadCooks();
  async function loadCooks() {
    cooksLoading = true;
    try { cooks = await NtApi.getCooks(id); }
    catch { cooks = []; }
    finally { cooksLoading = false; }
  }

  // Cook mode — wake-lock + bigger fonts + sectioned step focus.
  // Ingredient + step checks are SESSION-scoped: tied to an active cook
  // session so they survive a reload (stove interruption, accidental
  // tab close) but auto-clear when the session ends. Outside cook mode
  // the boxes render as plain visual decorations and clicks are inert
  // — matches AllRecipes / NYT Cooking / Mealie behavior and avoids
  // the "I tapped a box browsing yesterday and it's still checked"
  // surprise. cookMode itself is persisted so a reload mid-cook
  // returns you to cooking with checks intact.
  const _initialId = parseInt(params.id, 10);
  let cookMode = Number.isFinite(_initialId) && typeof localStorage !== 'undefined'
    && localStorage.getItem(`ct:cookmode:${_initialId}`) === '1';
  // One-shot cleanup: if we're not inside an active session on entry,
  // wipe any leftover checks. Catches both the legacy "persisted forever"
  // state from before this gate existed and any orphaned entries from
  // crashed sessions where End/I-made-this never ran.
  if (!cookMode && Number.isFinite(_initialId) && typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(`ct:checks:${_initialId}:ing`);
      localStorage.removeItem(`ct:checks:${_initialId}:step`);
      localStorage.removeItem(`ct:checks:${_initialId}:tool`);
    } catch {}
  }
  let wakeLockSentinel = null;
  $: cookModeActive.set(cookMode);
  onDestroy(() => cookModeActive.set(false));
  $: ingChecks = _loadChecks(id, 'ing');
  $: stepChecks = _loadChecks(id, 'step');
  $: toolChecks = _loadChecks(id, 'tool');

  function _loadChecks(rid, kind) {
    if (!Number.isFinite(rid) || typeof localStorage === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem(`ct:checks:${rid}:${kind}`);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
  }
  function _saveChecks(rid, kind, set) {
    if (!Number.isFinite(rid) || typeof localStorage === 'undefined') return;
    try { localStorage.setItem(`ct:checks:${rid}:${kind}`, JSON.stringify([...set])); } catch {}
  }
  function _saveCookMode(rid, on) {
    if (!Number.isFinite(rid) || typeof localStorage === 'undefined') return;
    try {
      if (on) localStorage.setItem(`ct:cookmode:${rid}`, '1');
      else    localStorage.removeItem(`ct:cookmode:${rid}`);
    } catch {}
  }
  // Resolve a step's ref_ids → the actual ingredient objects from the
  // recipe's grouped-ingredients tree. Used to render the per-step
  // inline ingredient list (issue #40). Returns in refIds order so the
  // author can control the order in which linked ingredients appear
  // under the step. Silently drops any dangling id (survived a save
  // race, or the linked ingredient got deleted on a foreign client).
  function _resolveStepIngs(refIds) {
    if (!recipe || !Array.isArray(recipe.ingredients)) return [];
    const byId = new Map();
    for (const g of recipe.ingredients) {
      for (const it of (g.items || [])) if (it?.id) byId.set(it.id, it);
    }
    const out = [];
    for (const id of refIds) {
      const it = byId.get(id);
      if (it) out.push(it);
    }
    return out;
  }
  function toggleIng(key) {
    if (!cookMode) return; // checks only mutate during an active cook session
    if (ingChecks.has(key)) ingChecks.delete(key);
    else ingChecks.add(key);
    ingChecks = ingChecks;
    _saveChecks(id, 'ing', ingChecks);
  }
  function toggleStep(idx) {
    if (!cookMode) return; // see toggleIng
    if (stepChecks.has(idx)) stepChecks.delete(idx);
    else stepChecks.add(idx);
    stepChecks = stepChecks;
    _saveChecks(id, 'step', stepChecks);
  }
  function toggleTool(idx) {
    if (!cookMode) return; // see toggleIng
    if (toolChecks.has(idx)) toolChecks.delete(idx);
    else toolChecks.add(idx);
    toolChecks = toolChecks;
    _saveChecks(id, 'tool', toolChecks);
  }
  function resetChecks() {
    ingChecks = new Set(); stepChecks = new Set(); toolChecks = new Set();
    _saveChecks(id, 'ing', ingChecks);
    _saveChecks(id, 'step', stepChecks);
    _saveChecks(id, 'tool', toolChecks);
  }

  // Keep-screen-awake in cook mode. Two paths: on Capacitor native we
  // use @capacitor-community/keep-awake, which flips FLAG_KEEP_SCREEN_ON
  // on the WebView activity — bulletproof. On PWA we fall back to the
  // Web Wake Lock API, which is well-supported in modern browsers but
  // was unreliable across Android WebView versions (silent failures
  // are why native cook mode stopped keeping the screen on after some
  // WebView update). Native path never touches wakeLockSentinel.
  async function _acquireWakeLock() {
    if (isNative) {
      try {
        const { KeepAwake } = await import('@capacitor-community/keep-awake');
        await KeepAwake.keepAwake();
      } catch { /* plugin missing or platform said no — silent */ }
      return;
    }
    if ('wakeLock' in navigator) {
      try { wakeLockSentinel = await navigator.wakeLock.request('screen'); }
      catch { /* user denied or API unavailable — silent */ }
    }
  }
  async function _releaseWakeLock() {
    if (isNative) {
      try {
        const { KeepAwake } = await import('@capacitor-community/keep-awake');
        await KeepAwake.allowSleep();
      } catch { /* silent */ }
      return;
    }
    if (wakeLockSentinel) {
      try { wakeLockSentinel.release(); } catch {}
      wakeLockSentinel = null;
    }
  }

  async function startCookMode() {
    cookMode = true;
    _saveCookMode(id, true);
    await _acquireWakeLock();
  }
  async function endCookMode() {
    cookMode = false;
    _saveCookMode(id, false);
    // Session over — clear so the next cook starts fresh.
    resetChecks();
    await _releaseWakeLock();
  }
  // If the user navigates away or backgrounds the tab, release the lock.
  // It auto-re-acquires on visibility return when cookMode is still
  // true. Native re-uses the same path — KeepAwake.keepAwake() is
  // idempotent (safe to call multiple times).
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', async () => {
      if (cookMode && document.visibilityState === 'visible') {
        await _acquireWakeLock();
      }
    });
  }

  $: id = parseInt(params.id, 10);

  async function load() {
    loading = true;
    loadError = null;
    try {
      recipe = await NtApi.getRecipe(id);
    } catch (e) {
      loadError = e.message || 'Could not load recipe';
      showError(loadError);
    } finally {
      loading = false;
    }
    // Kick off the pantry load so the FDA box can render "~Xg per
    // serving" instead of "1 of N" once we have densities + per-piece
    // masses to work with. Non-blocking — the box re-renders when the
    // promise resolves and the reactive recipeMassG flips from null.
    _ensurePantryLoaded();
  }
  $: if (Number.isFinite(id)) load();

  // Mass per serving for the FDA box. Null until pantry is loaded; null
  // forever if any ingredient lacks convertible mass data (the box
  // falls back to "1 of N" in that case). Re-runs whenever the recipe
  // or pantry refresh.
  $: recipeMassResult = (recipe && pantryById)
    ? computeRecipeMass(recipe, pantryById)
    : null;
  $: recipeMassG = (recipeMassResult && recipeMassResult.complete)
    ? recipeMassResult.perServingG
    : null;

  async function remove() {
    const ok = await confirmDialog({
      title: 'Delete recipe?',
      message: `"${recipe.name}" will be removed.`,
      confirmText: 'Delete',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.deleteRecipe(recipe.id);
      showSuccess($_('recipe_view_ct.toast.recipe_deleted'));
      push('/recipes');
    } catch (e) {
      showError(e.message || 'Delete failed');
    }
  }

  // ── Share menu ───────────────────────────────────────────
  // Two-option sheet from the header share icon: Share Card (PNG)
  // or Share Link (public URL). Mirrors the recipe long-press menu
  // but accessible without leaving the recipe view. Advanced
  // per-user / kitchen sharing still lives on the Recipes page
  // long-press menu — too modal-heavy to duplicate here.
  let shareSheetOpen = false;
  // Share Link requires a server (mints + hosts the /r/<token> URL).
  // Hide the option entirely when running Android in local-only mode
  // so the user doesn't see something that immediately errors.
  $: _canShareLink = !isNative || !!getServerUrl();
  $: shareActions = recipe ? [
    { label: 'Share Card', icon: 'image', value: 'card' },
    ...(_canShareLink ? [{
      label: recipe.share_token ? 'Copy Share Link' : 'Create Share Link',
      icon: recipe.share_token ? 'link' : 'add_link',
      value: 'link',
    }] : []),
  ] : [];
  function openShareSheet() {
    if (!recipe) return;
    shareSheetOpen = true;
  }
  async function onShareSelect(ev) {
    const v = ev.detail?.value;
    if (v === 'card') await shareAsCard();
    else if (v === 'link') await shareAsLink();
  }
  async function shareAsCard() {
    showSuccess($_('recipe_view_ct.toast.preparing_share'));
    try {
      const pages = await buildRecipeCardPages(recipe);
      const safe = (recipe.name || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'recipe';
      const parts = [];
      for (const pg of pages) {
        const blob = await svgToPngBlob(pg.svg, pg.width, pg.height);
        const fname = pages.length > 1
          ? `${safe}-page-${pg.pageNum}-of-${pg.totalPages}.png`
          : `${safe}.png`;
        parts.push({ blob, filename: fname });
      }
      const res = await shareBlobs(parts, recipe.name);
      if (res.downloaded) showSuccess(parts.length > 1 ? `Saved ${parts.length} pages` : 'Saved card');
    } catch (e) {
      showError(e.message || 'Could not share');
    }
  }
  async function shareAsLink() {
    try {
      let token = recipe.share_token;
      if (!token) {
        const res = await NtApi.mintRecipeShareToken(recipe.id);
        token = res.share_token;
        recipe = { ...recipe, share_token: token };
      }
      const url = `${window.location.origin}/#/r/${token}`;
      if (navigator.share) {
        try {
          await navigator.share({ title: recipe.name, url });
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          // fall through to clipboard
        }
      }
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        showSuccess($_('recipe_view_ct.toast.link_copied'));
      } else {
        showError($_('recipe_view_ct.toast.share_unsupported'));
      }
    } catch (e) {
      showError(e.message || 'Could not share');
    }
  }

  function openCookLog(cook = null) {
    editingCook = cook;
    cookDialogOpen = true;
  }

  async function onCookLogSave(e) {
    cookBusy = true;
    try {
      if (editingCook) {
        await NtApi.updateCook(recipe.id, editingCook.id, e.detail);
        showSuccess($_('recipe_view_ct.toast.diary_updated'));
      } else {
        recipe = await NtApi.markCooked(recipe.id, e.detail);
        showSuccess($_('recipe_view_ct.toast.logged_cooked'));
        // "I made this" is the natural end of a cook session — clear
        // checks + drop out of cook mode so the next visit is fresh.
        if (cookMode) endCookMode();
      }
      await loadCooks();
      // Recipe aggregates change after cook events — re-fetch.
      if (editingCook) recipe = await NtApi.getRecipe(recipe.id);
    } catch (err) {
      showError(err.message || 'Could not log cook');
    } finally {
      cookBusy = false;
      editingCook = null;
    }
  }

  async function deleteCook(cookId) {
    const ok = await confirmDialog({
      title: 'Delete cook entry?',
      message: 'This removes the entry from your cook history. The recipe stays.',
      confirmText: 'Delete',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.deleteCook(recipe.id, cookId);
      await loadCooks();
      recipe = await NtApi.getRecipe(recipe.id);
    } catch (e) {
      showError(e.message || 'Could not delete');
    }
  }

  async function setRating(e) {
    const next = e.detail;
    try {
      const updated = await NtApi.updateRecipe(recipe.id, { ...recipe, rating: next });
      recipe = updated;
    } catch (err) {
      showError(err.message || 'Could not save rating');
    }
  }

  // Brief heart-pop animation on toggle. The CSS class clears itself
  // on animationend; this flag just triggers it.
  let favPopping = false;
  async function toggleFavorite() {
    const next = !recipe.favorite;
    favPopping = true;
    try {
      const updated = await NtApi.updateRecipe(recipe.id, { ...recipe, favorite: next });
      recipe = updated;
    } catch (err) {
      showError(err.message || 'Could not update favorite');
    }
  }

  function totalMinutes(r) {
    if (r?.total_minutes != null) return r.total_minutes;
    return (r?.prep_minutes || 0) + (r?.cook_minutes || 0) + (r?.rest_minutes || 0);
  }

  // Map a video URL (external or local) onto a render mode.
  //   'iframe' → embed src (YouTube / Vimeo)
  //   'video'  → direct media URL for <video src>
  //   'link'   → unknown host, just show a "watch" link
  function _videoEmbed(url) {
    if (!url) return { kind: 'link', src: null };
    const s = String(url).trim();
    // Local upload — pass through resolveAssetUrl so it works on
    // Capacitor + behind a proxy.
    if (s.startsWith('/uploads/') || s.startsWith('uploads/')) {
      return { kind: 'video', src: resolveAssetUrl(s) };
    }
    // Direct media file (mp4, webm, mov, m4v)
    if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(s)) {
      return { kind: 'video', src: s };
    }
    // YouTube — youtu.be/<id> or youtube.com/watch?v=<id> or /shorts/<id>
    const yt = s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/);
    if (yt) return { kind: 'iframe', src: `https://www.youtube.com/embed/${yt[1]}` };
    // Vimeo — vimeo.com/<id> (digits)
    const vm = s.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (vm) return { kind: 'iframe', src: `https://player.vimeo.com/video/${vm[1]}` };
    return { kind: 'link', src: s };
  }

  // ── Recompute nutrition from pantry ─────────────────────────────────
  // The auto-calc engine already lives in src/lib/recipe-nutrition.js;
  // this UI just exposes it from the recipe view (was editor-only).
  // The result panel surfaces "computed from N/M" + skipped reasons,
  // with per-row "Auto-fill density" actions for the missing-density
  // case so the user can keep tightening the calculation in place.
  let recomputeResult = null;  // { nutrition, used, skipped: [...], total }
  let recomputeBusy = false;

  async function runRecompute() {
    if (!recipe) return;
    recomputeBusy = true;
    try {
      const pantry = await NtApi.getPantry();
      const byId = new Map(pantry.map(p => [p.id, p]));
      const byLowerName = new Map(pantry.map(p => [p.name.toLowerCase(), p]));
      // Backfill pantry_item_id by name for any ingredient missing a link.
      const stamped = (recipe.ingredients || []).map(g => ({
        ...g,
        items: (g.items || []).map(it => {
          if (it.pantry_item_id) return it;
          const m = byLowerName.get((it.name || '').toLowerCase());
          return m ? { ...it, pantry_item_id: m.id } : it;
        }),
      }));
      const result = computeRecipeNutrition(stamped, byId);
      // Augment each skipped row with the pantry id we tried (if any),
      // so the inline "fix density" button knows which row to write to.
      const enriched = (result.skipped || []).map(s => {
        const m = byLowerName.get((s.name || '').toLowerCase());
        return { ...s, pantry_id: m?.id ?? null, suggested_density: lookupCommonDensity(s.name) };
      });
      recomputeResult = { ...result, skipped: enriched };
    } catch (e) {
      showError(e.message || 'Recompute failed');
    } finally {
      recomputeBusy = false;
    }
  }

  async function applyRecompute() {
    if (!recipe || !recomputeResult) return;
    try {
      // Convert totals → per-serving (recipe.servings is the divisor).
      const div = Number(recipe.servings) > 0 ? Number(recipe.servings) : 1;
      const perServing = {};
      for (const [k, v] of Object.entries(recomputeResult.nutrition)) {
        perServing[k] = Math.round((v / div) * 100) / 100;
      }
      const updated = await NtApi.updateRecipe(recipe.id, { ...recipe, nutrition: perServing });
      recipe = updated;
      recomputeResult = null;
      showSuccess(`Saved auto-calc — ${recomputeResult?.used ?? '?'} of ${recomputeResult?.total ?? '?'} ingredients`);
    } catch (e) {
      showError(e.message || 'Could not save');
    }
  }

  // Per-row: set the missing density on a pantry item and re-run.
  // Prefers the built-in density table; falls back to leaving it for
  // the user to set via Trace if there's no match.
  async function fixDensityForSkip(row) {
    if (!row?.pantry_id) return;
    const dens = row.suggested_density || lookupCommonDensity(row.name);
    if (!dens) {
      showError(`No built-in density for "${row.name}". Ask Trace: "set the density of ${row.name}".`);
      return;
    }
    try {
      await NtApi.updatePantryItem(row.pantry_id, { g_per_cup: dens });
      showSuccess(`Set ${row.name} to ${dens} g/cup`);
      await runRecompute();
    } catch (e) {
      showError(e.message || 'Could not set density');
    }
  }

</script>

<div class="page-shell editor-page" class:cook-mode={cookMode} style="--editor-header-h: {editorHeaderH}px">
  <!-- In cook mode the header itself is the indicator: tinted accent
       background, a small "Cooking" label by the title, and a single
       Exit button on the right that drops out of cook mode. Edit /
       Delete / Close are hidden because they don't fit the focused
       cooking task. -->
  <header class="editor-header" class:cook-mode={cookMode} bind:offsetHeight={editorHeaderH}>
    <h2 class="editor-title">{recipe?.name || 'Recipe'}</h2>
    {#if cookMode}
      <span class="cook-mode-tag" aria-hidden="true">
        <span class="material-symbols-rounded cook-mode-icon">soup_kitchen</span>
        <span class="cook-mode-label">{$_('recipe.cook_mode')}</span>
      </span>
      <button class="btn-icon close-btn" on:click={endCookMode} aria-label="Exit Cook Mode" title="Exit Cook Mode">
        <span class="material-symbols-rounded">close</span>
      </button>
    {:else}
      {#if recipe}
        {#if isSharedView}
          <!-- Small lock chip so the reader knows the recipe is
               read-only for them and who owns it. Byline appears in
               the header body below. -->
          <span class="shared-chip" title="Shared with you — read only">
            <span class="material-symbols-rounded">lock</span>
            <span class="shared-chip-label">{$_('recipe_view_ct.shared_chip')}</span>
          </span>
        {/if}
        <button class="btn-icon" on:click={openShareSheet} aria-label="Share" title="Share">
          <span class="material-symbols-rounded">share</span>
        </button>
        {#if canEdit}
          <button class="btn-icon" on:click={() => push(`/recipes/edit/${recipe.id}`)} aria-label="Edit" title="Edit">
            <span class="material-symbols-rounded">edit</span>
          </button>
          <button class="btn-icon danger" on:click={remove} aria-label="Delete" title="Delete">
            <span class="material-symbols-rounded">delete</span>
          </button>
        {/if}
      {/if}
      <button class="btn-icon close-btn" on:click={_closeRecipe} aria-label="Close" title="Close">
        <span class="material-symbols-rounded">close</span>
      </button>
    {/if}
  </header>

  <div class="editor-content">
    {#if loading}
      <div class="state" in:fade={{ duration: 120 }}>
        <span class="material-symbols-rounded spin">progress_activity</span>
      </div>
    {:else if loadError}
      <div class="state error">
        <span class="material-symbols-rounded">error</span>
        <p>{loadError}</p>
        <button class="btn btn-secondary" on:click={load}>{$_('recipe_view_ct.retry')}</button>
      </div>
    {:else if recipe}
      <div class="body">
        <!-- Recipe header — side-by-side on desktop. Hero on the left,
             title / description / byline / rating + actions / meta /
             tags on the right so the screen real estate stays used and
             the body grid below lands closer to the fold. Stacks back
             to a single column on mobile. -->
        <div class="recipe-header">
          {#if recipe.imgUrl}
            <div class="hero">
              <img src={recipe.imgUrl} alt="" />
            </div>
          {/if}
          <div class="recipe-meta">
        {#if recipe.category}
          <button class="category-pill"
            style={recipe.category.color ? `--cat-color:${recipe.category.color}` : ''}
            on:click={() => push(`/recipes?category=${recipe.category.slug}`)}
            title={`Filter recipes by ${recipe.category.name}`}>
            {recipe.category.name}
          </button>
        {/if}
        <h1 class="recipe-name">{recipe.name}</h1>
        {#if recipe.description}
          <p class="recipe-desc">{recipe.description}</p>
        {/if}

        <!-- Provenance subline: who added this, where it came from, and
             cook history all on one row. Replaces the dedicated Source
             section + the standalone "Last Cooked" line below the meta
             strip — same data, less vertical real estate. -->
        {#if recipe.created_by_full_name || recipe.created_by_username || recipe.created_at || recipe.source_url || recipe.last_cooked_at || recipe.cook_count > 0}
          <p class="byline">
            {#if recipe.created_by_full_name || recipe.created_by_username}
              {@const creatorDisplay = recipe.created_by_full_name || recipe.created_by_username}
              <span class="byline-author">
                <span class="byline-avatar" aria-hidden="true">
                  {#if recipe.creator_avatar_url}
                    <img src={resolveAssetUrl(recipe.creator_avatar_url)} alt="" />
                  {:else}
                    {creatorDisplay.charAt(0).toUpperCase()}
                  {/if}
                </span>
                Added by <strong>{creatorDisplay}</strong>
              </span>
            {/if}
            {#if recipe.created_at}
              {#if recipe.created_by_full_name || recipe.created_by_username}<span class="dot">·</span>{/if}
              <span title={recipe.created_at}>{formatDate(recipe.created_at, $dateFormat)}</span>
            {/if}
            {#if recipe.source_url && domainFromUrl(recipe.source_url)}
              <span class="dot">·</span>
              <span class="byline-source">
                From <a href={recipe.source_url} target="_blank" rel="noopener noreferrer">
                  {domainFromUrl(recipe.source_url)}
                </a>
              </span>
            {/if}
            {#if recipe.last_cooked_at}
              <span class="dot">·</span>
              <span title={relativeTime(recipe.last_cooked_at)}>
                Last Cooked {formatDate(recipe.last_cooked_at, $dateFormat)}
              </span>
            {/if}
            {#if recipe.cook_count > 0}
              <span class="dot">·</span>
              <span>Cooked {recipe.cook_count} {recipe.cook_count === 1 ? 'Time' : 'Times'}</span>
            {/if}
          </p>
        {/if}

        <!-- Rating + favorite + cook button row -->
        <div class="rating-row">
          <div class="rating-cluster">
            <StarRating value={recipe.rating} on:change={setRating} size={22} />
            <button
              class="fav-btn"
              class:active={recipe.favorite}
              class:popping={favPopping}
              on:click={toggleFavorite}
              on:animationend={() => favPopping = false}
              aria-label={recipe.favorite ? 'Remove from favorites' : 'Add to favorites'}
              title={recipe.favorite ? 'Favorited' : 'Favorite'}
            >
              <span class="material-symbols-rounded">{recipe.favorite ? 'favorite' : 'favorite_border'}</span>
            </button>
          </div>
          <div class="cook-actions-row">
            <button class="btn btn-secondary cook-btn" on:click={cookMode ? endCookMode : startCookMode}>
              <span class="material-symbols-rounded">{cookMode ? 'visibility_off' : 'soup_kitchen'}</span>
              {cookMode ? 'End Cook Mode' : 'Start Cooking'}
            </button>
            <button class="btn btn-secondary cook-btn" on:click={() => openCookLog()} disabled={cookBusy}>
              <span class="material-symbols-rounded">restaurant</span>
              {cookBusy ? 'Logging…' : 'I Cooked This'}
            </button>
          </div>
        </div>

        <!-- Time + servings + yield -->
        <div class="meta-row">
          {#if recipe.prep_minutes}
            <div class="meta-stat">
              <span class="material-symbols-rounded meta-icon">schedule</span>
              <div class="meta-text"><span class="meta-label">{$_('recipe.prep_time')}</span><span class="meta-value">{formatDuration(recipe.prep_minutes)}</span></div>
            </div>
          {/if}
          {#if recipe.cook_minutes}
            <div class="meta-stat">
              <span class="material-symbols-rounded meta-icon">local_fire_department</span>
              <div class="meta-text"><span class="meta-label">{$_('recipe.cook_time')}</span><span class="meta-value">{formatDuration(recipe.cook_minutes)}</span></div>
            </div>
          {/if}
          {#if recipe.rest_minutes}
            <div class="meta-stat">
              <span class="material-symbols-rounded meta-icon">hourglass_top</span>
              <div class="meta-text"><span class="meta-label">{$_('recipe.rest_time')}</span><span class="meta-value">{formatDuration(recipe.rest_minutes)}</span></div>
            </div>
          {/if}
          {#if totalMinutes(recipe) > 0}
            <div class="meta-stat">
              <span class="material-symbols-rounded meta-icon">timer</span>
              <div class="meta-text"><span class="meta-label">{$_('recipe.total_time')}</span><span class="meta-value">{formatDuration(totalMinutes(recipe))}</span></div>
            </div>
          {/if}
          {#if recipe.servings}
            <div class="meta-stat">
              <span class="material-symbols-rounded meta-icon">restaurant</span>
              <div class="meta-text"><span class="meta-label">{$_('recipe_view_ct.serves')}</span><span class="meta-value">{recipe.servings}</span></div>
            </div>
          {/if}
          {#if recipe.yield_text}
            <div class="meta-stat">
              <span class="material-symbols-rounded meta-icon">scale</span>
              <div class="meta-text"><span class="meta-label">{$_('recipe_view_ct.yield')}</span><span class="meta-value">{recipe.yield_text}</span></div>
            </div>
          {/if}
        </div>

        <!-- Tags chip row. Kitchen Gear has graduated to its own section
             under Ingredients; it no longer rides this row. -->
        {#if recipe.tags?.length}
          <div class="chips-stack">
            <div class="chip-row">
              <span class="chip-label">{$_('recipe_view_ct.tags')}</span>
              {#each recipe.tags as tag}
                <span class="chip">{tag}</span>
              {/each}
            </div>
          </div>
        {/if}
          </div><!-- /.recipe-meta -->
        </div><!-- /.recipe-header -->

        <!-- Layout grid:
             • mobile (<960):  one column, everything stacks
             • tablet (960+):  Ingredients(+KitchenGear) | Steps(+Notes), Nutrition full-width below
             • desktop (1280+): Ingredients(+KitchenGear) | Steps(+Notes) | Nutrition
             Cook History + Comments + Last Updated render full-width below
             outside this grid. -->
        <div class="layout">
        <div class="col col-left">
        <section class="section ingredients-section">
          <h2 class="section-title">
            <span class="material-symbols-rounded section-icon">restaurant_menu</span>
            <span class="section-title-text">{$_('recipe.ingredients')}</span>
            {#if recipe.servings}
              <span class="section-hint">
                {scaledServings} {scaledServings === 1 ? 'Serving' : 'Servings'}
              </span>
            {/if}
          </h2>

          <!-- Scaling chips + custom input. Only shown when we have servings
               to scale against (otherwise the math has no anchor). -->
          {#if recipe.servings}
            <div class="scale-row">
              <div class="scale-chips" role="radiogroup" aria-label="Scale"
                bind:this={scaleChipsEl}
                style="--scale-pill-x:{scalePillX}px; --scale-pill-w:{scalePillW}px">
                {#if scalePillReady}<span class="scale-pill" aria-hidden="true"></span>{/if}
                {#each [0.5, 1, 2, 3] as f, i}
                  <button
                    class="scale-chip"
                    class:active={scale === f}
                    bind:this={scaleChipRefs[i]}
                    on:click={() => scale = f}
                    aria-pressed={scale === f}
                  >×{f}</button>
                {/each}
              </div>
              <label class="scale-custom">
                <span class="scale-custom-label">{$_('recipe.servings')}</span>
                <input
                  type="number"
                  min="0.25"
                  step="0.25"
                  class="input num"
                  value={scaledServings}
                  on:input={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v > 0) scale = v / recipe.servings;
                  }}
                />
              </label>
            </div>
          {/if}

          {#if recipe.ingredients?.length}
            {#each recipe.ingredients as group, gi}
              {#if group.name && (recipe.ingredients.length > 1 || group.name)}
                <h3 class="ingredient-group-title">{group.name}</h3>
              {/if}
              <ul class="ingredients">
                {#each group.items as ing, ii}
                  {@const key = `${gi}-${ii}`}
                  <li class="ingredient" class:checked={ingChecks.has(key)}>
                    <button
                      class="check-btn"
                      on:click={() => toggleIng(key)}
                      aria-label={ingChecks.has(key) ? 'Mark as not gathered' : 'Mark as gathered'}
                    >
                      <span class="material-symbols-rounded">{ingChecks.has(key) ? 'check_box' : 'check_box_outline_blank'}</span>
                    </button>
                    {#if ing.qty || ing.unit}
                      {@const _target = convertedTargets.get(key) || null}
                      {@const _converted = _target ? convertedParts(ing, scale, pantryById, _target) : null}
                      {@const _qp = _converted || displayQtyParts(ing.qty, ing.unit, scale)}
                      {@const _displayUnit = _converted ? _converted.unit : (ing.unit ?? '')}
                      {@const _convertible = canConvert(ing)}
                      <span class="qty-cluster">
                        <!-- The qty itself is the affordance: tap to open
                             the conversion picker (only when convertible).
                             Plain span otherwise. A subtle dotted underline
                             flags it without adding a separate button. -->
                        <svelte:element this={_convertible ? 'button' : 'span'}
                          class="ing-qty"
                          class:convertible={_convertible}
                          class:converted={!!_target}
                          class:open={openMenuKey === key}
                          type={_convertible ? 'button' : undefined}
                          on:click={_convertible ? () => openConvertMenu(key) : undefined}
                          aria-haspopup={_convertible ? 'menu' : undefined}
                          aria-expanded={_convertible ? openMenuKey === key : undefined}
                          title={_convertible ? 'Tap to convert units' : undefined}>
                          {#if _qp.whole}<span class="qty-whole">{_qp.whole}</span>{/if}
                          {#if _qp.whole && _qp.fraction}{' '}{/if}
                          {#if _qp.fraction}<span class="qty-fraction">{_qp.fraction}</span>{/if}
                          {#if (ing.qty && _displayUnit) || _converted}{' '}{/if}{_displayUnit}
                        </svelte:element>
                        {#if _convertible && openMenuKey === key}
                          <div class="convert-menu" role="menu">
                            <button class="convert-menu-item"
                              class:on={!_target}
                              on:click={() => pickTarget(key, null)}>
                              Original ({ing.unit || '—'})
                            </button>
                            {#each targetOptionsFor(ing, pantryById) as opt}
                              <button class="convert-menu-item"
                                class:on={_target === opt.unit}
                                on:click={() => pickTarget(key, opt.unit)}>
                                {opt.label}
                              </button>
                            {/each}
                          </div>
                        {/if}
                      </span>
                    {/if}
                    <span class="ing-text">
                      <span class="ing-name">{ing.name || ''}</span>
                      {#if ing.note}<span class="ing-note">{ing.note}</span>{/if}
                    </span>
                  </li>
                {/each}
              </ul>
            {/each}
          {:else}
            <p class="empty-line">No ingredients listed.</p>
          {/if}
        </section>

        <!-- Kitchen Gear sits in the same column as Ingredients (left)
             on wide screens — same mental mode (a checklist of stuff
             you need before you start). Empty list → component renders
             nothing. -->
        <KitchenGear
          items={recipe.tools || []}
          {cookMode}
          checked={toolChecks}
          on:toggle={(e) => toggleTool(e.detail)}
        />
        </div><!-- /.col-left -->

        <div class="col col-mid">
        <section class="section">
          <h2 class="section-title">
            <span class="material-symbols-rounded section-icon">format_list_numbered</span>
            <span class="section-title-text">{$_('recipe.instructions')}</span>
          </h2>
          {#if recipe.steps?.length}
            <ol class="steps">
              {#each recipe.steps as step, i}
                {@const title = typeof step === 'string' ? '' : (step.title || '')}
                {@const text  = typeof step === 'string' ? step : (step.text || '')}
                {@const stepImg = typeof step === 'string' ? null : (step.imgUrl || null)}
                {@const parts = splitWithTimes(text)}
                {@const stepRefIds = (typeof step === 'string' || !Array.isArray(step.refIds)) ? [] : step.refIds}
                {@const stepIngs = stepRefIds.length > 0 ? _resolveStepIngs(stepRefIds) : []}
                <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
                <li class="step" class:checked={stepChecks.has(i)} id={`step-${i}`}
                  on:click={(e) => {
                    // Whole-row toggle, but bail if the tap landed on
                    // an interactive child (time chip, embedded link).
                    if (e.target.closest('.time-chip, a, button:not(.step-badge)')) return;
                    toggleStep(i);
                  }}>
                  <button
                    type="button"
                    class="step-badge"
                    class:done={stepChecks.has(i)}
                    on:click|stopPropagation={() => toggleStep(i)}
                    aria-pressed={stepChecks.has(i)}
                    aria-label={stepChecks.has(i) ? `Step ${i + 1} done — tap to undo` : `Mark step ${i + 1} done`}
                    title={stepChecks.has(i) ? 'Done — tap to undo' : 'Mark done'}
                  >
                    {#if stepChecks.has(i)}
                      <span class="material-symbols-rounded badge-check">check</span>
                    {:else}
                      <span class="badge-num">
                        <span class="badge-num-label">{$_('recipe_view_ct.step')}</span>
                        <span class="badge-num-value">{i + 1}</span>
                      </span>
                    {/if}
                  </button>
                  <div class="step-body">
                    {#if title}
                      <span class="step-heading">
                        <span class="step-title">{title}</span>
                      </span>
                    {/if}
                    {#if stepIngs.length > 0}
                      <!-- Per-step linked ingredients (issue #40). Small
                           inline list so users don't scroll back to the
                           top ingredients section during Cook Mode. -->
                      <ul class="step-ings" aria-label={`Ingredients for step ${i + 1}`}>
                        {#each stepIngs as ing (ing.id)}
                          <li class="step-ing">
                            {#if ing.qty || ing.unit}
                              <span class="step-ing-qty">{ing.qty || ''}{ing.qty && ing.unit ? ' ' : ''}{ing.unit || ''}</span>
                            {/if}
                            <span class="step-ing-name">{ing.name}</span>
                            {#if ing.note}<span class="step-ing-note">{ing.note}</span>{/if}
                          </li>
                        {/each}
                      </ul>
                    {/if}
                    {#if stepImg}
                      <img class="step-image" src={resolveAssetUrl(stepImg)} alt={`Step ${i + 1}`} loading="lazy" />
                    {/if}
                    {#if text}
                      <span class="step-text">
                        {#each parts as p}
                          {#if p.type === 'text'}{@html formatStepText(p.value)}{:else}<button
                            class="time-chip"
                            on:click={() => startTimer({
                              label: title || `Step ${i + 1}`,
                              durationSec: p.durationSec,
                              recipeId: recipe.id,
                              recipeName: recipe.name,
                              stepIndex: i,
                            })}
                            title={`Start ${formatRemaining(p.durationSec * 1000)} timer`}
                          ><span class="material-symbols-rounded">play_arrow</span>{p.value}</button>{/if}
                        {/each}
                      </span>
                    {/if}
                  </div>
                </li>
              {/each}
            </ol>
          {:else}
            <p class="empty-line">No steps yet.</p>
          {/if}
        </section>

        <!-- Video Instructions — only shows when the user has set
             a video. Handles YouTube + Vimeo via an iframe embed and
             local /uploads/ paths via a plain <video>. -->
        {#if recipe.video_url}
          {@const v = _videoEmbed(recipe.video_url)}
          <section class="section video-section">
            <h2 class="section-title">
              <span class="material-symbols-rounded section-icon">play_circle</span>
              <span class="section-title-text">{$_('recipe.video_instructions')}</span>
            </h2>
            {#if v.kind === 'iframe'}
              <div class="video-frame">
                <iframe src={v.src} title="Video instructions"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowfullscreen loading="lazy"></iframe>
              </div>
            {:else if v.kind === 'video'}
              <video class="video-native" controls preload="metadata" src={v.src}></video>
            {:else}
              <a class="video-fallback" href={recipe.video_url} target="_blank" rel="noopener noreferrer">
                <span class="material-symbols-rounded">play_circle</span>
                Watch the video
              </a>
            {/if}
          </section>
        {/if}

        <!-- Notes follow Steps — author tips read inline with the
             instructions on wide screens, in the same column. -->
        {#if recipe.notes}
          <section class="section">
            <h2 class="section-title">
              <span class="material-symbols-rounded section-icon">sticky_note_2</span>
              <span class="section-title-text">{$_('recipe_view_ct.notes')}</span>
            </h2>
            <!-- Notes can contain a sanitized subset of HTML (bold,
                 italic, bullets, numbered lists) emitted by the
                 RichTextEditor component. Re-sanitize here defensively
                 so a notes value that bypasses the editor (server
                 import, JSON paste) can't smuggle in scripts. -->
            <div class="notes">{@html sanitizeRichText(recipe.notes)}</div>
          </section>
        {/if}
        </div><!-- /.col-mid -->

        <div class="col col-right">
        <section class="section nutrition-section">
          <NutritionFactsBox
            nutrition={recipe.nutrition}
            servings={recipe.servings}
            yieldText={recipe.yield_text}
            {recipeMassG}
          />
          <div class="recompute-card">
            {#if !recomputeResult}
              <button class="btn btn-secondary recompute-btn" on:click={runRecompute} disabled={recomputeBusy}>
                <span class="material-symbols-rounded">calculate</span>
                {recomputeBusy ? 'Computing…' : 'Recompute from Pantry'}
              </button>
              <p class="recompute-hint">Walks each ingredient against your pantry's nutrition data.</p>
            {:else}
              <div class="recompute-summary">
                <span class="material-symbols-rounded
                  {recomputeResult.used === recomputeResult.total ? 'ok' : 'warn'}">
                  {recomputeResult.used === recomputeResult.total ? 'check_circle' : 'info'}
                </span>
                <span>
                  Computed from <strong>{recomputeResult.used}</strong> of <strong>{recomputeResult.total}</strong>
                  {recomputeResult.total === 1 ? 'ingredient' : 'ingredients'}
                </span>
              </div>
              {#if recomputeResult.skipped && recomputeResult.skipped.length > 0}
                <ul class="skipped-list">
                  {#each recomputeResult.skipped as row (row.name + row.reason)}
                    <li class="skipped-row">
                      <span class="skip-name">{row.name}</span>
                      <span class="skip-reason">{row.reason}</span>
                      {#if row.pantry_id && row.suggested_density}
                        <button class="btn btn-secondary tiny" on:click={() => fixDensityForSkip(row)}
                          title={`Set ${row.suggested_density} g/cup`}>
                          Set {row.suggested_density} g/cup
                        </button>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
              <div class="recompute-actions">
                <button class="btn btn-secondary tiny" on:click={() => recomputeResult = null}>{$_('recipe_view_ct.cancel')}</button>
                <button class="btn btn-primary tiny" on:click={applyRecompute}>
                  <span class="material-symbols-rounded">save</span>
                  Save This Calculation
                </button>
              </div>
            {/if}
          </div>
        </section>
        </div><!-- /.col-right -->
        </div><!-- /.layout -->

        <!-- Cook history — only when there's at least one entry. Full
             width below the layout grid: photos look better wide and
             this is "your log", visually separated from the recipe
             content above. -->
        {#if cooks.length > 0}
          <section class="section cook-history-section">
            <h2 class="section-title">
              <span class="material-symbols-rounded section-icon">history</span>
              <span class="section-title-text">{$_('recipe.cook_history')}</span>
            </h2>
            <ul class="cook-list">
              {#each cooks as c (c.id)}
                {@const photoList = (Array.isArray(c.photos) && c.photos.length > 0) ? c.photos : (c.photo_url ? [c.photo_url] : [])}
                <li class="cook-entry">
                  {#if photoList.length > 0}
                    <div class="cook-photos">
                      {#each photoList as p, pi}
                        <button type="button" class="cook-photo-btn" on:click={() => { lightboxPhotos = photoList; lightboxIndex = pi; }} aria-label="View photo">
                          <img class="cook-photo" src={resolveAssetUrl(p)} alt="" loading="lazy" />
                        </button>
                      {/each}
                    </div>
                  {/if}
                  <div class="cook-body">
                    <div class="cook-head">
                      <span class="cook-date">{shortDate(c.date)}</span>
                      <span class="cook-rel">{relativeTime(c.date)}</span>
                    </div>
                    {#if c.cooked_by_full_name || c.cooked_by_username}
                      <p class="cook-by">by {c.cooked_by_full_name || c.cooked_by_username}</p>
                    {/if}
                    {#if c.notes}<p class="cook-notes">{c.notes}</p>{/if}
                  </div>
                  <div class="cook-actions">
                    <button class="btn-icon small" on:click={() => openCookLog(c)} aria-label="Edit" title="Edit">
                      <span class="material-symbols-rounded">edit</span>
                    </button>
                    <button class="btn-icon small danger" on:click={() => deleteCook(c.id)} aria-label="Delete" title="Delete">
                      <span class="material-symbols-rounded">delete</span>
                    </button>
                  </div>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <section class="section comments-section">
          <RecipeComments recipeId={recipe.id} />
        </section>

        <!-- Footer: just the freshness stamp. Authorship + source URL
             moved into the byline up top; everything else covered by
             the byline / Cook History / Comments sections. -->
        {#if recipe.updated_at && recipe.updated_at !== recipe.created_at}
          <p class="last-updated" title={recipe.updated_at}>
            Last Updated {formatUpdated(recipe.updated_at, $dateFormat)}
          </p>
        {/if}
      </div>
    {/if}
  </div>
</div>

<CookLogDialog
  bind:open={cookDialogOpen}
  recipeName={recipe?.name || ''}
  editing={editingCook}
  on:save={onCookLogSave}
/>

<!-- Share menu — Share Card (PNG) or Share Link (public URL). -->
<ActionSheet
  bind:open={shareSheetOpen}
  title="Share Recipe"
  actions={shareActions}
  on:select={onShareSelect}
/>

<!-- Photo lightbox for cook-history thumbs (click any thumb to zoom). -->
<svelte:window on:keydown={onLightboxKey} />
{#if lightboxIndex >= 0 && lightboxPhotos[lightboxIndex]}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div use:portal class="lb-backdrop" on:click={closeLightbox}
    in:fade={{ duration: 160 }} out:fade={{ duration: 120 }}>
    <button class="lb-close" on:click|stopPropagation={closeLightbox} aria-label="Close" title="Close (Esc)">
      <span class="material-symbols-rounded">close</span>
    </button>
    {#if lightboxPhotos.length > 1}
      <button class="lb-nav lb-prev" on:click|stopPropagation={lightboxPrev}
        disabled={lightboxIndex === 0} aria-label="Previous">
        <span class="material-symbols-rounded">chevron_left</span>
      </button>
      <button class="lb-nav lb-next" on:click|stopPropagation={lightboxNext}
        disabled={lightboxIndex === lightboxPhotos.length - 1} aria-label="Next">
        <span class="material-symbols-rounded">chevron_right</span>
      </button>
      <div class="lb-counter">{lightboxIndex + 1} / {lightboxPhotos.length}</div>
    {/if}
    <img class="lb-img" src={resolveAssetUrl(lightboxPhotos[lightboxIndex])} alt="" on:click|stopPropagation />
  </div>
{/if}

<style>
  /* editor-page + editor-header inherit from base.css */
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
  .btn-icon.danger:hover {
    background: color-mix(in srgb, var(--error, #ef4444) 18%, transparent);
    color: var(--error, #ef4444);
  }
  .btn-icon.close-btn:hover {
    background: color-mix(in srgb, var(--error, #ef4444) 18%, transparent);
    color: var(--error, #ef4444);
  }
  /* "Shared" chip in the header — signals read-only view for a
     recipe the current user doesn't own. Text collapses under 480px
     so the header stays uncluttered on phones. */
  .shared-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    height: 28px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
  .shared-chip .material-symbols-rounded { font-size: 14px; }
  @media (max-width: 480px) {
    .shared-chip-label { display: none; }
    .shared-chip { padding: 4px 8px; }
  }

  .state {
    text-align: center;
    padding: 80px 16px;
    color: var(--text-3);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .state.error { color: var(--error, #f87171); }
  .spin {
    font-size: 32px;
    animation: spin 1.2s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Hero — fixed aspect ratio + cover crop, so every recipe header
     reads at the same height regardless of source image. Mobile gets
     a taller 4:3 to fill more of the above-the-fold view; desktop
     widens to 16:9 (overridden in the >=720px media block below).
     Center crop matches what Mealie / NYT Cooking / Paprika do. */
  .hero {
    width: 100%;
    aspect-ratio: 4 / 3;
    max-height: min(60vh, 520px);
    overflow: hidden;
    background:
      linear-gradient(
        180deg,
        var(--surface-2) 0%,
        var(--surface-1) 100%
      );
  }
  .hero img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center;
    display: block;
  }

  /* Recipe header — single column on mobile, side-by-side hero +
     meta on desktop. Hero takes ~58% of the header width, meta
     stack fills the rest. Hero rounds at the corners on desktop
     to read as a "card" inside the header rather than a full-bleed
     banner. */
  .recipe-header {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .recipe-meta {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  @media (min-width: 960px) {
    .recipe-header {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
      gap: 28px;
      align-items: start;
      margin-bottom: 4px;
    }
    /* Keep the hero capped at a consistent 16:9 frame even on tall
       portrait sources. align-self: start so it doesn't try to
       stretch to match the meta column's height (was producing
       blown-up heroes on recipes with shorter meta + tall source
       images). */
    .recipe-header .hero {
      aspect-ratio: 16 / 9;
      max-height: 480px;
      border-radius: var(--radius-lg);
      align-self: start;
    }
  }

  .body {
    padding: 20px var(--page-px) 32px;
    /* Mobile: full width with --page-px padding.
       Tablet (~768): caps at ~880 for comfortable single-column reading.
       Desktop (≥960):  caps at 1180 for a comfortable 2-col layout.
       Ultra (≥1280):  bumps to 1440 to give the 3-col layout room to
                        breathe without sprawling on 1920px monitors. */
    max-width: 1180px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }
  @media (min-width: 1280px) {
    .body { max-width: 1440px; }
  }

  /* Layout grid:
     • mobile (<960):  single column, stacks naturally via flex
     • tablet (960+):  2 columns — Left (Ingredients + Kitchen Gear)
                       and Mid (Steps + Notes). Nutrition flows full
                       width below the grid via the `.col-right` wrap
                       grid-column-spanning to both columns.
     • ultra (1280+):  3 columns — Nutrition gets its own right column. */
  .layout {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  @media (min-width: 960px) {
    /* Wider screens get the genre-standard 16:9 hero — same fixed
       cover crop, just less vertical real-estate so the page below
       lands closer to the fold. */
    .hero { aspect-ratio: 16 / 9; }

    .layout {
      display: grid;
      grid-template-columns: minmax(280px, 0.85fr) 1.15fr;
      gap: 28px;
      align-items: flex-start;
    }
    /* On 2-col, Nutrition spans both columns and flows below. */
    .col-right { grid-column: 1 / -1; }
    /* Sticky left column — Ingredients + Kitchen Gear stay in view as
       you scroll the steps. We deliberately don't set overflow-y here
       any more: setting it to auto forces overflow-x to be clipped
       too, which silently chopped the section heading's -10px hang
       so Ingredients / Instructions weren't visually shifting like
       Comments was. Trade: extremely long ingredient lists scroll
       the whole page rather than scrolling inside the column — fine
       for ~20-row recipes which is the realistic ceiling. */
    .col-left {
      position: sticky;
      top: 16px;
    }
  }
  @media (min-width: 1280px) {
    .layout {
      grid-template-columns: minmax(280px, 0.8fr) minmax(0, 1.2fr) minmax(280px, 0.85fr);
      gap: 32px;
    }
    .col-right {
      grid-column: auto;
      position: sticky;
      top: 16px;
      align-self: start;
    }
  }
  /* Each column is itself a flex stack — Ingredients above Kitchen
     Gear, Steps above Notes, etc. */
  .col {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .category-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin: 0 0 10px;
    cursor: pointer;
    border: 1px solid color-mix(in srgb, var(--cat-color, var(--accent)) 40%, transparent);
    background: color-mix(in srgb, var(--cat-color, var(--accent)) 14%, transparent);
    color: var(--cat-color, var(--accent));
    transition: background var(--dur-fast);
  }
  .category-pill:hover {
    background: color-mix(in srgb, var(--cat-color, var(--accent)) 24%, transparent);
  }

  .recipe-name {
    font-size: 28px;
    font-weight: 700;
    margin: 0 0 8px;
    color: var(--text-1);
    line-height: 1.2;
  }
  .recipe-desc {
    color: var(--text-2);
    margin: 0 0 12px;
    font-size: 15px;
    line-height: 1.5;
  }

  /* Byline: who added this and where it came from. Replaces the
     standalone Source section — keeps the top of the page focused on
     identity / provenance with a single tight line. */
  .byline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 0 0 18px;
    color: var(--text-3);
    font-size: 13px;
    line-height: 1.4;
  }
  .byline strong { color: var(--text-2); font-weight: 700; }
  .byline .dot { opacity: 0.6; }
  .byline-author {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .byline-avatar {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-contrast, #0a0b0f);
    font-weight: 700;
    font-size: 11px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .byline-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .byline-source a {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }
  .byline-source a:hover { text-decoration: underline; }

  .last-updated {
    margin: 32px 0 0;
    text-align: center;
    color: var(--text-3);
    font-size: 11.5px;
    font-style: italic;
    opacity: 0.8;
  }
  .comments-section {
    margin-top: 32px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
  }
  .cook-history-section {
    margin-top: 32px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
  }

  .rating-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
  }
  .rating-cluster {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .fav-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-3);
    padding: 4px;
    border-radius: var(--radius-sm);
    line-height: 0;
    transition: color var(--dur-fast), transform var(--dur-fast) var(--ease-spring);
    -webkit-tap-highlight-color: transparent;
  }
  .fav-btn .material-symbols-rounded { font-size: 24px; font-variation-settings: 'FILL' 0; }
  .fav-btn.active {
    color: var(--error, #f87171);
  }
  .fav-btn.active .material-symbols-rounded { font-variation-settings: 'FILL' 1; }
  .fav-btn:hover { transform: scale(1.12); }
  /* Pop animation on favorite toggle — quick scale + settle, mirroring
     the StarRating star pop so the two heart/star interactions feel
     like siblings. Respects reduced-motion. */
  .fav-btn.popping {
    animation: fav-pop 360ms var(--ease-spring) both;
  }
  @keyframes fav-pop {
    0%   { transform: scale(1); }
    35%  { transform: scale(1.45); }
    65%  { transform: scale(0.92); }
    100% { transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .fav-btn.popping { animation: none; }
  }

  .cook-actions-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .cook-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .cook-btn .material-symbols-rounded { font-size: 18px; }

  /* ── Cook mode ────────────────────────────────────────────────────────── */
  /* The editor-header itself becomes the cook-mode banner: same height
     and layout as normal, just tinted accent so it's unmistakably
     "cooking right now" without adding a second bar above the title. */
  .editor-header.cook-mode {
    background: color-mix(in srgb, var(--accent) 22%, var(--surface-1));
    border-bottom-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  }
  /* Right-side "Cook Mode" tag sitting next to the Exit X. Pill chip
     so it reads as a status badge, not a button. */
  .cook-mode-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: var(--radius-full, 99px);
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
    flex-shrink: 0;
  }
  .cook-mode-icon {
    color: var(--accent);
    font-size: 16px;
  }
  .cook-mode-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  /* In cook mode: bigger ingredient + step text for hands-busy reading. */
  .cook-mode .ingredient,
  .cook-mode .step-text { font-size: 17px; line-height: 1.55; }
  .cook-mode .ing-qty { min-width: 90px; }

  .check-btn {
    background: transparent;
    border: 1px solid transparent;
    cursor: pointer;
    color: var(--text-3);
    padding: 0;
    border-radius: var(--radius-sm);
    line-height: 0;
    flex-shrink: 0;
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .check-btn:hover { color: var(--accent); }
  .check-btn .material-symbols-rounded { font-size: 22px; }

  .ingredient.checked .ing-name,
  .ingredient.checked .ing-qty,
  .ingredient.checked .ing-note { text-decoration: line-through; opacity: 0.55; }
  .ingredient.checked .check-btn { color: var(--accent); }

  /* Step toggle — rounded "STEP N" chip when undone, collapses to an
     accent-filled circle with a check when done. Doubles as the
     step's number badge so the click target lands where the eye
     already goes. Scale-pop animation runs each time Svelte
     re-creates the inner span on state change. */
  .step-badge {
    flex-shrink: 0;
    height: 28px;
    min-width: 28px;
    padding: 0 10px;
    border-radius: 999px;
    border: 2px solid var(--border);
    background: var(--surface-1);
    color: var(--text-2);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.04em;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background var(--dur-fast), border-color var(--dur-fast),
                color var(--dur-fast), transform var(--dur-fast);
    -webkit-tap-highlight-color: transparent;
  }
  .step-badge:hover { border-color: var(--accent); color: var(--accent); }
  .step-badge:active { transform: scale(0.94); }
  .step-badge.done {
    /* Collapse back to a circle when the check icon takes over so
       the badge doesn't read as oversized. */
    width: 28px;
    min-width: 0;
    padding: 0;
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg);
  }
  .step-badge .badge-num {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    line-height: 1;
  }
  .step-badge .badge-num-label {
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
  }
  .step-badge:hover .badge-num-label { color: var(--accent); }
  .step-badge .badge-num-value {
    font-size: 13px;
    font-weight: 800;
  }
  .step-badge .badge-check {
    font-size: 18px;
    line-height: 1;
    animation: badge-pop 220ms cubic-bezier(0.22, 1.36, 0.36, 1) 1;
  }
  @keyframes badge-pop {
    0%   { transform: scale(0.55); opacity: 0; }
    65%  { transform: scale(1.12); opacity: 1; }
    100% { transform: scale(1);    opacity: 1; }
  }

  /* Done state — fade + strikethrough on the step text and (if any)
     title. Muted text-3 strike color so it reads as "complete", not
     as an error-red correction. The whole row also gets a soft
     accent stripe on the left so it's quickly distinguishable when
     scanning the list. */
  .step.checked .step-text,
  .step.checked .step-title {
    opacity: 0.58;
    text-decoration: line-through;
    text-decoration-color: var(--text-3);
    text-decoration-thickness: 1.5px;
  }

  /* Whole row clickable in cook mode. Outside cook mode the badge
     dims and the row's pointer cursor goes away so casual taps don't
     read as broken — toggleStep itself is already cook-mode-gated. */
  .editor-page.cook-mode .step { cursor: pointer; }
  .editor-page.cook-mode .step:hover .step-badge:not(.done) {
    border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
  }
  .editor-page:not(.cook-mode) .check-btn {
    cursor: default;
    opacity: 0.45;
  }
  .editor-page:not(.cook-mode) .check-btn:hover { color: var(--text-3); }
  .editor-page:not(.cook-mode) .step-badge {
    cursor: default;
    opacity: 0.55;
  }
  .editor-page:not(.cook-mode) .step-badge:hover {
    border-color: var(--border);
    color: var(--text-2);
  }

  .meta-row {
    display: flex;
    gap: 24px;
    flex-wrap: wrap;
    padding: 14px 0;
    border-bottom: 1px solid var(--border);
  }
  .meta-stat { display: flex; align-items: center; gap: 10px; }
  .meta-icon {
    font-size: 22px;
    color: var(--accent);
    opacity: 0.85;
    flex-shrink: 0;
  }
  .meta-text { display: flex; flex-direction: column; gap: 1px; }
  .meta-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-3);
    font-weight: 700;
    line-height: 1;
  }
  .meta-value { font-size: 16px; font-weight: 600; color: var(--text-1); line-height: 1.1; }

  .cook-history {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-3);
    font-size: 13px;
    margin: 14px 0 0;
  }
  .cook-history .material-symbols-rounded { font-size: 16px; }

  .chips-stack { display: flex; flex-direction: column; gap: 8px; margin: 14px 0; }
  .chip-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .chip-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
    font-weight: 700;
    margin-right: 4px;
    min-width: 40px;
  }
  .chip {
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius-full, 99px);
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 600;
  }
  .chip.tool {
    background: var(--surface-2);
    color: var(--text-2);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .chip.tool .material-symbols-rounded { font-size: 13px; opacity: 0.7; }

  .section { margin-top: 24px; }
  /* Section heading — true heading (not a tracked all-caps label).
     Icon prefix carries the section's identity, the text wraps in
     its own span so a short accent bar underlines just the title
     and not the icon or the hint. Sizes up to a real read-anchor
     instead of feeling like a tag above content. */
  .section-title {
    margin: 0 0 14px;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-1);
    font-size: 16px;
    font-weight: 800;
    letter-spacing: -0.01em;
    /* Defeat any inherited uppercase / heavy tracking from print or
       legacy section-label styles — this is a true heading now. */
    text-transform: none;
  }
  /* Box-model alignment with the row content below:
       - .check-btn: column X=0, border 1px transparent, glyph
         padding ~4px → visible at column X + 5
       - .section-icon: no border, glyph padding ~4px → visible at
         column X + margin-left + 4
     Equating gives margin-left: 1px. Round to 0 — visually
     identical and keeps the heading flush with the column box. */
  .section-title { margin-left: 0; }
  .section-icon {
    font-size: 22px;
    color: var(--accent);
    flex-shrink: 0;
    line-height: 1;
  }
  .section-title-text {
    display: inline-block;
    padding-bottom: 4px;
    border-bottom: 2px solid var(--accent);
    line-height: 1.1;
    text-transform: none;
  }
  .section-hint {
    font-size: 12px;
    color: var(--text-3);
    font-weight: 500;
    margin-left: 2px;
    text-transform: none;
  }

  /* Nutrition section is just a wrapper — the FDA box has its own styling. */
  .nutrition-section { display: flex; justify-content: center; }

  .cook-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
  .cook-entry {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 10px 12px;
  }
  .cook-photos {
    display: flex; gap: 6px; flex-wrap: wrap; flex-shrink: 0;
  }
  .cook-photo-btn {
    width: 80px; height: 80px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: zoom-in;
    overflow: hidden;
    flex-shrink: 0;
    transition: border-color var(--dur-fast), transform var(--dur-fast);
  }
  .cook-photo-btn:hover { border-color: var(--accent); transform: scale(1.04); }
  .cook-photo {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

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
  .cook-body { flex: 1; min-width: 0; }
  .cook-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .cook-date { font-weight: 600; color: var(--text-1); font-size: 14px; }
  .cook-rel { font-size: 12px; color: var(--text-3); }
  .cook-by    { color: var(--text-3); font-size: 12px; margin: 2px 0 0; font-style: italic; }
  .cook-notes { color: var(--text-2); font-size: 13px; line-height: 1.4; margin: 4px 0 0; }
  .cook-actions { display: flex; gap: 2px; flex-shrink: 0; }
  .cook-actions .btn-icon { color: var(--text-3); }
  .cook-actions .btn-icon:hover { color: var(--text-1); }
  .cook-actions .btn-icon.danger:hover { color: var(--error, #f87171); }

  .scale-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    /* Group chips + the Servings input on the left of the column
       with a comfortable gap, instead of pinning the input against
       the right edge (where the column divider was crowding it). */
    justify-content: flex-start;
    gap: 18px;
    margin-bottom: 12px;
  }
  .scale-chips {
    position: relative;
    display: inline-flex;
    gap: 4px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 3px;
  }
  /* Sliding pill behind the active chip — positioned by JS-measured
     CSS vars so it animates between options instead of hard-swapping
     the active background. */
  .scale-pill {
    position: absolute;
    left: 0;
    top: 3px;
    bottom: 3px;
    width: var(--scale-pill-w, 0px);
    transform: translateX(var(--scale-pill-x, 0px));
    background: var(--accent-dim);
    border-radius: var(--radius-sm);
    transition: transform var(--dur-base) var(--ease-spring),
                width var(--dur-base) var(--ease-spring);
    pointer-events: none;
    z-index: 0;
  }
  .scale-chip {
    position: relative;
    z-index: 1;
    background: transparent;
    color: var(--text-2);
    border: none;
    border-radius: var(--radius-sm);
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: color var(--dur-fast);
  }
  .scale-chip:hover { color: var(--text-1); }
  .scale-chip.active { color: var(--accent); }
  .scale-custom {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-3);
  }
  .scale-custom .input.num {
    width: 70px;
    text-align: right;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 5px 8px;
    color: var(--text-1);
    font-size: 13px;
  }
  .scale-custom-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
  }

  /* Subgroup titles inside Ingredients (e.g. "Rice", "Sauce"). Sits
     at the column's content edge so it aligns with the rows below. */
  .ingredient-group-title {
    margin: 14px 0 8px;
    font-size: 13px;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: 0.02em;
  }
  .ingredient-group-title:first-of-type { margin-top: 0; }

  .ingredients { list-style: none; padding: 0; margin: 0; }
  .ingredient {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 8px 0;
    border-top: 1px solid var(--border);
    font-size: 14px;
    color: var(--text-1);
    line-height: 1.4;
  }
  .ingredient .check-btn { align-self: center; }
  .ingredient:first-child { border-top: none; }
  /* Wraps the qty (now the conversion trigger) so the popover menu
     can position relative to it without disturbing the row. */
  .qty-cluster {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  /* Default qty rendering — matches everywhere a qty is read-only. */
  .ing-qty {
    font-weight: 600;
    color: var(--accent);
    flex-shrink: 0;
    min-width: 70px;
  }
  /* Cookbook fraction typography: shrink the fractional part so a
     mixed number like "1 1/2" reads as 1 + a small ½, not as
     equal-weight "1 1/2". */
  .ing-qty .qty-fraction {
    font-size: 0.78em;
    vertical-align: 0.12em;
    margin-left: 1px;
    letter-spacing: -0.02em;
  }
  /* Convertible variant — qty becomes a button. A subtle dotted
     underline flags the affordance without adding a separate button.
     Hover tints the surface; converted state gets a soft accent fill
     so the user can tell which rows have been swapped. */
  .ing-qty.convertible {
    background: transparent;
    border: 0;
    padding: 2px 6px;
    margin-left: -6px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--accent);
    text-decoration: underline dotted color-mix(in srgb, var(--accent) 55%, transparent);
    text-decoration-thickness: 1.5px;
    text-underline-offset: 3px;
    transition: background var(--dur-fast), text-decoration-color var(--dur-fast);
  }
  .ing-qty.convertible:hover,
  .ing-qty.convertible:focus-visible {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    text-decoration-color: var(--accent);
    outline: none;
  }
  .ing-qty.convertible.converted {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .ing-qty.convertible.open {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }

  /* Inline dropdown for unit choice. Anchors to the qty button now
     instead of the retired ↔ icon; same narrow profile so the row
     doesn't reflow when the menu opens. */
  .convert-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    min-width: 140px;
    padding: 4px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  }
  .convert-menu-item {
    background: transparent;
    border: none;
    text-align: left;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--text-1);
    font-size: 13px;
    font-family: inherit;
  }
  .convert-menu-item:hover { background: var(--surface-2); }
  .convert-menu-item.on {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    font-weight: 600;
  }
  .ing-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .ing-note { color: var(--text-3); font-size: 13px; line-height: 1.3; }

  .steps { list-style: none; padding: 0; margin: 0; }
  .step {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }
  .step:first-child { border-top: none; }
  /* Brief accent highlight when a top timer pill scrolls a step
     into view, so the user immediately sees what was targeted. */
  :global(.step-flash) {
    animation: step-flash 1.4s ease-out 1;
  }
  @keyframes step-flash {
    0%   { background: color-mix(in srgb, var(--accent) 22%, transparent); }
    100% { background: transparent; }
  }
  .step-check { margin-top: 2px; }
  .step-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }
  .step-heading {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }
  /* "Step N:" sits in front of the optional title text; matches its
     size so the line reads as one heading rather than a small label
     followed by a larger phrase. Muted color keeps it visually
     subordinate without shrinking. */
  .step-heading-num {
    font-size: 15px;
    color: var(--text-3);
    font-weight: 600;
  }
  .step-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-1);
  }
  .step-text { color: var(--text-1); line-height: 1.5; font-size: 15px; }

  /* Per-step linked ingredients (issue #40) — small inline list so
     users don't scroll back to the top ingredients section during
     Cook Mode. Sits between the step heading and the step text /
     image so the quantities read as part of the step context. */
  .step-ings {
    list-style: none;
    margin: 4px 0 6px;
    padding: 8px 12px;
    display: flex; flex-direction: column; gap: 4px;
    background: color-mix(in srgb, var(--accent) 6%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
    border-radius: var(--radius-md);
  }
  .step-ing {
    display: flex; align-items: baseline; gap: 6px;
    font-size: 13px; color: var(--text-2); line-height: 1.4;
  }
  .step-ing-qty {
    font-weight: 700; color: var(--accent);
    min-width: 70px;
    font-variant-numeric: tabular-nums;
  }
  .step-ing-name { color: var(--text-1); font-weight: 500; }
  .step-ing-note { color: var(--text-3); font-style: italic; font-size: 12px; }
  /* Cook mode scales the inline list to match the surrounding step
     text (17px / 1.55) so quantities read at arm's length. */
  .cook-mode .step-ing { font-size: 16px; line-height: 1.5; }
  .cook-mode .step-ing-qty { min-width: 90px; font-size: 16px; }
  .cook-mode .step-ing-note { font-size: 14px; }
  /* When the step is checked done, fade the inline ingredients to
     match the muted .step-text / .step-title treatment above. */
  .step.checked .step-ings { opacity: 0.55; }
  .step-image {
    display: block;
    width: 100%;
    max-width: 480px;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    margin: 6px 0 4px;
  }

  .notes {
    color: var(--text-2);
    line-height: 1.5;
    margin: 0;
    padding: 12px;
    background: var(--surface-1);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
  }
  /* Rich-text notes can contain p / ul / ol / li — give them readable
     spacing matching how they look in the editor's preview. */
  .notes :global(p) { margin: 0 0 8px; }
  .notes :global(p:last-child) { margin-bottom: 0; }
  .notes :global(ul),
  .notes :global(ol) { margin: 4px 0 8px; padding-left: 24px; }
  .notes :global(li) { margin: 2px 0; }
  .empty-line { color: var(--text-3); margin: 0; font-size: 13px; font-style: italic; }

  /* Video Instructions block. 16:9 responsive iframe + native video
     fallback. Hidden entirely when recipe.video_url is null. */
  .video-section { margin-top: 4px; }
  .video-frame {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .video-frame iframe {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    border: 0;
  }
  .video-native {
    width: 100%;
    aspect-ratio: 16 / 9;
    background: black;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
  }
  .video-fallback {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 10px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--accent);
    font-weight: 600;
    text-decoration: none;
    font-size: 14px;
  }
  .video-fallback:hover { background: var(--surface-1); }
  .video-fallback .material-symbols-rounded { font-size: 22px; }

  /* Recompute card sits under the FDA box on wide screens. On mobile
     it stacks naturally below since .nutrition-section is flex column. */
  .nutrition-section { flex-direction: column; gap: 12px; }
  .recompute-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px;
    width: 100%;
    max-width: 380px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .recompute-btn {
    display: inline-flex; align-items: center; gap: 6px;
    width: 100%;
    justify-content: center;
  }
  .recompute-btn .material-symbols-rounded { font-size: 18px; }
  .recompute-hint {
    margin: 0;
    color: var(--text-3);
    font-size: 12px;
    text-align: center;
  }
  .recompute-summary {
    display: flex; align-items: center; gap: 8px;
    color: var(--text-2);
    font-size: 13px;
  }
  .recompute-summary .material-symbols-rounded { font-size: 18px; }
  .recompute-summary .ok   { color: var(--success, #4ade80); }
  .recompute-summary .warn { color: var(--accent); }
  .skipped-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex; flex-direction: column;
    gap: 8px;
    max-height: 240px;
    overflow-y: auto;
  }
  .skipped-row {
    display: flex; align-items: center; gap: 8px;
    flex-wrap: wrap;
    padding: 8px 10px;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    font-size: 12px;
  }
  .skip-name { font-weight: 700; color: var(--text-1); }
  .skip-reason {
    flex: 1;
    color: var(--text-3);
    line-height: 1.3;
  }
  .recompute-actions {
    display: flex; gap: 8px; justify-content: flex-end;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .recompute-actions .btn .material-symbols-rounded { font-size: 14px; margin-right: 2px; }

  /* Inline time chip rendered next to detected duration mentions in
     step text. Click starts a timer scoped to the step. */
  .time-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    padding: 1px 8px 1px 4px;
    border-radius: 999px;
    font-size: inherit;
    font-weight: 600;
    cursor: pointer;
    margin: 0 1px;
    line-height: 1.4;
    transition: background var(--dur-fast);
  }
  .time-chip:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .time-chip .material-symbols-rounded {
    font-size: 14px;
    line-height: 1;
  }

  /* ── Print stylesheet ─────────────────────────────────────────────────
     Cmd-P / Ctrl-P → a clean recipe card prints to one or two pages.
     Strip every navigation, toolbar, comment, cook history, FAB, and
     interaction. What remains: hero image (small), name + servings +
     time, ingredients (left), steps (right), notes. White background,
     black text, page-break-friendly so multi-page recipes don't slice
     a step in half. */
  @media print {
    /* Force everything to safe print colors. */
    :global(body), :global(html) {
      background: #fff !important;
      color: #000 !important;
    }
    :global(*) { box-shadow: none !important; text-shadow: none !important; }
    /* Hide chrome the cook doesn't need on paper. */
    :global(nav),
    :global(.bottom-nav),
    :global(.sidebar),
    :global(.editor-header),
    :global(.fab),
    :global(.action-sheet),
    :global(.toast),
    :global(.cb-dialog-backdrop),
    :global(.sheet-backdrop),
    .editor-header,
    .meta-pill,
    .scale-row,
    .check-btn,
    .convert-menu,
    .step-check,
    .star-btn,
    .time-chip,
    .cooked-actions,
    .cook-list,
    .comments-section,
    .last-updated,
    .editor-page > header { display: none !important; }
    /* Hero image: small thumbnail above the title, not a banner. */
    .hero-img,
    .recipe-img,
    img.hero {
      max-width: 220px !important;
      max-height: 160px !important;
      float: right;
      margin: 0 0 12px 16px;
    }
    /* Layout: collapse the column grid to a single page-friendly flow. */
    .layout {
      display: block !important;
      grid-template-columns: none !important;
      gap: 0 !important;
    }
    .col-left, .col-mid, .col-right {
      page-break-inside: avoid;
      margin-bottom: 16px;
      max-height: none !important;
      overflow: visible !important;
      position: static !important;
    }
    /* Headings + body text in print sizes. */
    .recipe-name { font-size: 22pt !important; margin-bottom: 8pt; }
    .section-title { font-size: 12pt !important; margin: 12pt 0 6pt; }
    .ingredient, .step { page-break-inside: avoid; }
    .ing-qty .qty-fraction { vertical-align: baseline; font-size: 1em; }
    /* Serif body for printable readability. */
    :global(body) {
      font-family: Georgia, 'Times New Roman', serif !important;
    }
    .ingredients, .steps { padding: 0 !important; list-style: none !important; }
    .ingredient, .step {
      border: none !important;
      padding: 4pt 0 !important;
    }
    .step-num,
    .step-heading-num { color: #000 !important; font-weight: bold !important; }
    .step-image { display: none !important; }  /* skip per-step photos in print to save ink */
    .notes {
      background: transparent !important;
      border: 1px dashed #999 !important;
      padding: 8pt 10pt !important;
      page-break-inside: avoid;
    }
    .nutrition-section { display: none !important; }  /* nutrition box renders poorly on B&W */
    @page { margin: 0.6in; }
  }
</style>
