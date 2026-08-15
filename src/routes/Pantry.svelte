<script>
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { _ } from 'svelte-i18n';
  import { pageBanners, bannerStyle, pantryView } from '../stores/settings.js';
  import { NtApi } from '../lib/api.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { push } from 'svelte-spa-router';
  import ActionSheet from '../components/ui/ActionSheet.svelte';
  import BarcodeScanner from '../components/ui/BarcodeScanner.svelte';
  import PantryItemSheet from '../components/pantry/PantryItemSheet.svelte';
  import { longpress } from '../lib/long-press.js';
  // Pantry categories now load from the server (DB-backed) so user-created
  // ones show up in the filter chip row and grouped buckets. The legacy
  // hardcoded list (`pantry-categories.js`) is kept around as a defensive
  // fallback during the initial async load and as the icon-name dictionary
  // for older items whose `category` is a slug like "spice" / "dairy".
  import { PANTRY_CATEGORIES, categoryLabel, categoryIcon } from '../lib/pantry-categories.js';
  import {
    displayVariantName,
    buildVariantsByParent,
    topLevelItems,
    aggregateStock,
    matchesSearch,
    queryHitVariant,
    matchingVariants,
    classifySearchHit,
  } from '../lib/pantry-variants.js';
  import * as OFF from '../lib/off.js';
  import * as USDA from '../lib/usda.js';
  import { offEnabled, usdaEnabled, usdaApiKey, offSearchLanguage, offSearchCountry, pantryDefaultSource } from '../stores/settings.js';
  import { offCountryTagToFlag, offCountryTagToName } from '../lib/off-country-flag.js';
  import { portal } from '../lib/portal.js';
  import { slide } from 'svelte/transition';

  let items = [];
  // Tracks which generic items the user has expanded to show their
  // variants. Auto-populated for generics whose children matched the
  // current search query so search hits stay visible.
  let expandedGenerics = new Set();
  // Two-phase collapse: when the user closes an expanded generic, add
  // its id to collapsingGenerics for one animation tick before removing
  // it from expandedGenerics. That gives the variant cards time to
  // play their reverse CSS keyframe. Svelte's out: transition doesn't
  // fire in this tree (something in the parents suppresses it), so we
  // drive the exit manually.
  let collapsingGenerics = new Set();
  const _VARIANT_EXIT_MS = 220;

  // Expiry helper (Issue #9). Single threshold (14 days) for the
  // warning state. Items past expiry get a stronger red treatment.
  const EXPIRY_WARN_DAYS = 14;
  function _expiryStatus(dateStr) {
    if (!dateStr) return 'none';
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return 'none';
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const diff = (d - now) / (1000 * 60 * 60 * 24);
    if (diff < 0) return 'past';
    if (diff <= EXPIRY_WARN_DAYS) return 'warn';
    return 'ok';
  }
  function _expiryShortLabel(dateStr) {
    const status = _expiryStatus(dateStr);
    if (status === 'past') return 'Expired';
    if (status === 'warn') {
      const d = new Date(dateStr + 'T00:00:00');
      const now = new Date(); now.setHours(0, 0, 0, 0);
      const days = Math.round((d - now) / (1000 * 60 * 60 * 24));
      if (days === 0) return 'Expires today';
      if (days === 1) return 'Expires tomorrow';
      return `Expires in ${days}d`;
    }
    return '';
  }

  // Effective expiry for the list-card pill. A generic doesn't have
  // its own expiry; it aggregates from children, surfacing the worst
  // status (past > warn). Flat items and variants use their own.
  // Returns the date string we want the pill to render against, or
  // null when nothing should be shown.
  function _effectiveExpiry(item, isGen) {
    if (!isGen) return item?.expires_on || null;
    const kids = variantsByParent.get(item.id) || [];
    let pastDate = null;
    let warnDate = null;
    for (const k of kids) {
      if (!k.expires_on) continue;
      const s = _expiryStatus(k.expires_on);
      if (s === 'past' && (!pastDate || k.expires_on < pastDate)) pastDate = k.expires_on;
      else if (s === 'warn' && (!warnDate || k.expires_on < warnDate)) warnDate = k.expires_on;
    }
    return pastDate || warnDate || null;
  }
  let loading = true;
  let loadError = null;
  let query = '';
  // Measured page-header height — exposed as --header-h on page-shell
  // so the sticky toolbar pins below the header instead of underneath it.
  let headerH = 0;
  let stockFilter = 'all'; // 'all' | 'in' | 'out' | 'expiring'
  let categoryFilter = 'all'; // 'all' | <category slug> | 'uncategorized'
  // Sort key — applies after the category/stock filters. Defaults to
  // 'name' to preserve the existing alphabetical-by-name behaviour.
  let sortKey = 'name';      // 'name' | 'updated' | 'usage'

  // DB-backed catalog populated by load(). Built from the API response
  // so user-created categories appear in the filter chips + grouping.
  let pantryCategories = [];

  // ── External search source ──────────────────────────────────────────
  // 'local' = search only existing pantry items.
  // 'off'   = also query Open Food Facts when there's a query string.
  // 'usda'  = also query USDA when there's a query string.
  // 'all'   = fan-out to pantry + OFF + USDA in parallel, merged view.
  // Initial value comes from the pantryDefaultSource user pref (#128
  // port from NT). Default 'local' preserves prior behavior.
  let searchSource = pantryDefaultSource.get() || 'local';
  let offResults = [];
  let usdaResults = [];
  let externalLoading = false;
  let _searchTimer = null;
  // 'all' is only offered when at least 2 external sources are enabled —
  // otherwise it's not meaningfully different from just picking that one
  // source. Mirrors NutriTrace's availableSources shape.
  $: _perSourceOptions = [
    { value: 'local', label: 'Pantry' },
    ...($offEnabled  ? [{ value: 'off',  label: 'OFF'  }] : []),
    ...($usdaEnabled && $usdaApiKey ? [{ value: 'usda', label: 'USDA' }] : []),
  ];
  $: availableSources = _perSourceOptions.length >= 2
    ? [{ value: 'all', label: 'All' }, ..._perSourceOptions]
    : _perSourceOptions;

  // Re-run external search whenever the query or the source changes. In
  // 'all' or multi-mode, fan out to both OFF + USDA in parallel; the
  // dedicated single-source render reads from offResults / usdaResults
  // directly, and the all-mode render merges them.
  $: { _runExternalSearch(query, searchSource, pinnedSources); }
  function _runExternalSearch(q, src, _pinned) {
    clearTimeout(_searchTimer);
    offResults = [];
    usdaResults = [];
    if (src === 'local' || !q.trim()) return;
    // In all-mode (or multi), fetch every source the user has enabled.
    // In single-source mode, fetch only that source.
    const wantOff  = ($offEnabled  && (src === 'off'  || src === 'all'));
    const wantUsda = ($usdaEnabled && $usdaApiKey && (src === 'usda' || src === 'all'));
    if (!wantOff && !wantUsda) return;
    externalLoading = true;
    _searchTimer = setTimeout(async () => {
      try {
        const [offR, usdaR] = await Promise.all([
          wantOff  ? OFF.searchByName(q.trim())               : Promise.resolve([]),
          wantUsda ? USDA.searchByName(q.trim(), 1, $usdaApiKey) : Promise.resolve([]),
        ]);
        offResults  = offR  || [];
        usdaResults = usdaR || [];
      } catch (e) {
        offResults = [];
        usdaResults = [];
        showError(e.message || 'Search failed');
      } finally {
        externalLoading = false;
      }
    }, 350);
  }

  // Legacy single-source externalResults derived from whichever source is
  // active. Kept as a derived value so the existing render block below
  // doesn't need to know about the new fan-out plumbing.
  $: externalResults = searchSource === 'off' ? offResults
                     : searchSource === 'usda' ? usdaResults
                     : [];

  // ── Per-source quality-tier filters (OFF completeness + USDA data type) ──
  // Backdrop-pattern dropdown attached to the OFF + USDA source chips
  // via a caret. Multi-select checkboxes, default all-active (no filter).
  // Filters apply client-side after fetch, in single-source mode AND in
  // all/multi mode (filters items from that source within the merged view).
  const _OFF_TIERS  = ['hi', 'mid', 'lo', 'unknown'];
  const _USDA_TIERS = ['Foundation', 'SR Legacy', 'Survey (FNDDS)', 'Branded', 'Experimental', 'unknown'];
  let offTiersActive  = new Set(_OFF_TIERS);
  let usdaTiersActive = new Set(_USDA_TIERS);
  let offDropdownOpen  = false;
  let usdaDropdownOpen = false;
  let offCaretEl = null;
  let usdaCaretEl = null;
  let offDropdownPos  = { top: 0, right: 0 };
  let usdaDropdownPos = { top: 0, right: 0 };
  let offDropdownPanelEl = null;
  let usdaDropdownPanelEl = null;

  function _bucketOff(c) {
    if (typeof c !== 'number') return 'unknown';
    if (c >= 0.7) return 'hi';
    if (c >= 0.4) return 'mid';
    return 'lo';
  }
  function toggleOffTier(t) {
    const s = new Set(offTiersActive);
    if (s.has(t)) s.delete(t); else s.add(t);
    if (s.size === 0) s.add(t);  // never hide everything
    offTiersActive = s;
  }
  function toggleUsdaTier(t) {
    const s = new Set(usdaTiersActive);
    if (s.has(t)) s.delete(t); else s.add(t);
    if (s.size === 0) s.add(t);
    usdaTiersActive = s;
  }
  function resetOffTiers()  { offTiersActive  = new Set(_OFF_TIERS); }
  function resetUsdaTiers() { usdaTiersActive = new Set(_USDA_TIERS); }
  $: offTiersFiltered  = offTiersActive.size  !== _OFF_TIERS.length;
  $: usdaTiersFiltered = usdaTiersActive.size !== _USDA_TIERS.length;
  // Filter helpers used by both single-source render + all-mode render.
  $: offVisible  = offTiersFiltered  ? offResults.filter(f  => offTiersActive.has(_bucketOff(f.completeness)))
                                     : offResults;
  $: usdaVisible = usdaTiersFiltered ? usdaResults.filter(f => usdaTiersActive.has(f.dataType || 'unknown'))
                                     : usdaResults;

  // Dropdown open handlers — position via getBoundingClientRect from the
  // caret + close the other so only one is open at a time.
  function openOffDropdown() {
    usdaDropdownOpen = false;
    const r = offCaretEl?.getBoundingClientRect();
    if (r) offDropdownPos = { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) };
    offDropdownOpen = true;
  }
  function openUsdaDropdown() {
    offDropdownOpen = false;
    const r = usdaCaretEl?.getBoundingClientRect();
    if (r) usdaDropdownPos = { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) };
    usdaDropdownOpen = true;
  }
  function _closeTierDropdowns() {
    offDropdownOpen = false;
    usdaDropdownOpen = false;
  }
  function _onWindowClick(e) {
    if (!offDropdownOpen && !usdaDropdownOpen) return;
    const t = e.target;
    if (offCaretEl && offCaretEl.contains(t)) return;
    if (usdaCaretEl && usdaCaretEl.contains(t)) return;
    if (offDropdownOpen  && offDropdownPanelEl  && offDropdownPanelEl.contains(t))  return;
    if (usdaDropdownOpen && usdaDropdownPanelEl && usdaDropdownPanelEl.contains(t)) return;
    _closeTierDropdowns();
  }
  function _onWindowTouchMove() {
    if (offDropdownOpen || usdaDropdownOpen) _closeTierDropdowns();
  }

  // ── Multi-source chips (long-press to add) ─────────────────────────────
  // Same behaviour as NutriTrace Foods: long-press pins a chip alongside
  // the current source; multiple pins triggers a merged all-mode fan-out
  // (searchSource flipped to 'all' + _allModeItems filtered by pinnedSources).
  // Regular tap exits multi mode back to single-source.
  let pinnedSources = new Set();
  let _lpChipTimer = null;
  let _lpChipStartX = 0;
  let _lpChipStartY = 0;
  let _lpChipJustFired = false;
  function _startChipLongPress(sourceValue, e) {
    const t = e?.touches?.[0];
    _lpChipStartX = t?.clientX ?? 0;
    _lpChipStartY = t?.clientY ?? 0;
    clearTimeout(_lpChipTimer);
    _lpChipTimer = setTimeout(() => {
      _lpChipTimer = null;
      _toggleChipInMulti(sourceValue);
    }, 500);
  }
  function _maybeCancelChipLongPress(e) {
    if (!_lpChipTimer) return;
    const t = e?.touches?.[0];
    if (!t) return;
    const dx = Math.abs(t.clientX - _lpChipStartX);
    const dy = Math.abs(t.clientY - _lpChipStartY);
    if (dx > 10 || dy > 10) _cancelChipLongPress();
  }
  function _cancelChipLongPress() {
    if (_lpChipTimer) { clearTimeout(_lpChipTimer); _lpChipTimer = null; }
  }
  function _toggleChipInMulti(sourceValue) {
    if (sourceValue === 'all' || sourceValue === 'local') return;
    // Guard against double-fire from contextmenu + touchstart-timer.
    if (_lpChipJustFired) return;
    _lpChipJustFired = true;
    setTimeout(() => { _lpChipJustFired = false; }, 400);

    const s = new Set(pinnedSources);
    if (s.has(sourceValue)) {
      s.delete(sourceValue);
    } else {
      if (s.size === 0 && searchSource !== 'all' && searchSource !== sourceValue) {
        s.add(searchSource);
      }
      s.add(sourceValue);
    }
    if (s.size <= 1) {
      pinnedSources = new Set();
      if (s.size === 1) searchSource = [...s][0];
    } else {
      pinnedSources = s;
      searchSource = 'all';
    }
  }
  $: activeChips = {
    local:  pinnedSources.size > 0 ? pinnedSources.has('local')  : searchSource === 'local',
    off:    pinnedSources.size > 0 ? pinnedSources.has('off')    : searchSource === 'off',
    usda:   pinnedSources.size > 0 ? pinnedSources.has('usda')   : searchSource === 'usda',
    all:    pinnedSources.size === 0 && searchSource === 'all',
  };
  function _onChipTap(sourceValue) {
    _cancelChipLongPress();
    if (_lpChipJustFired) return;
    pinnedSources = new Set();
    searchSource = sourceValue;
  }
  function _isSourceActive(name) {
    return pinnedSources.size === 0 || pinnedSources.has(name);
  }

  // ── All-mode merged results ───────────────────────────────────────────
  // Fans out pantry + OFF + USDA into a single ordered list with per-row
  // source badges. Only runs when searchSource === 'all' (either via the
  // 'All' chip or via multi-mode which flips searchSource to 'all').
  // Pantry match uses matchesSearch() so brand-variant search works too
  // (mirrors what the local pantry render already does).
  // Flatten into the shape the render expects (fields on top-level, source
  // tag as `_source`). Wrapping as {source, item} broke every field access
  // in the all-mode row template — rows showed only the source badge with
  // no name / brand / barcode / thumbnail.
  $: _allModeItems = searchSource !== 'all' ? [] : [
    ...(_isSourceActive('local')
      ? (items || []).filter(f => query.trim() ? matchesSearch(f, query, buildVariantsByParent(items)) : false).map(f => ({ ...f, _source: 'local' }))
      : []),
    ...(_isSourceActive('off')  ? offVisible.map(f  => ({ ...f, _source: 'off'  })) : []),
    ...(_isSourceActive('usda') ? usdaVisible.map(f => ({ ...f, _source: 'usda' })) : []),
  ];
  function pickExternalResult(r) {
    // Open the sheet in create mode with the external-search result as
    // the prefill payload. No route navigation; user stays on Pantry.
    sheetPrefill = r;
    sheetItemId = null;
    sheetStartInEdit = true;
    sheetOpen = true;
  }

  // Editing happens on a dedicated /pantry/edit route (PantryEditor.svelte),
  // mirroring NutriTrace's FoodEditor pattern. The legacy in-page modal
  // state has been removed.

  // ── Selection mode ──────────────────────────────────────────────────
  // NT-family pattern: enter via long-press action sheet, exit via top-
  // right X, or automatically when the last item is deselected. No
  // bottom pill — actions live in the header where the normal quick-
  // action icons already sit.
  let selectMode = false;
  let selectedIds = new Set();
  function exitSelectMode() {
    selectMode = false;
    selectedIds = new Set();
  }
  function toggleSelected(id) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    selectedIds = next;
    if (selectedIds.size === 0) selectMode = false;
  }
  async function bulkDelete() {
    if (selectedIds.size === 0) return;
    const n = selectedIds.size;
    const ok = await confirmDialog({
      title: `Delete ${n} pantry item${n === 1 ? '' : 's'}?`,
      message: 'Recipes referencing them stay; this just drops them from your pantry.',
      confirmText: `Delete ${n}`,
      dangerous: true,
    });
    if (!ok) return;
    const ids = [...selectedIds];
    let failed = 0;
    for (const id of ids) {
      try { await NtApi.deletePantryItem(id); }
      catch { failed++; }
    }
    items = items.filter(i => !selectedIds.has(i.id));
    selectedIds = new Set();
    selectMode = false;
    if (failed === 0) showSuccess(`Removed ${ids.length} item${ids.length === 1 ? '' : 's'}`);
    else showError(`Removed ${ids.length - failed} of ${ids.length} — ${failed} failed`);
  }

  // Items match a category by either:
  //   - new `category_id` (resolved against pantryCategories on the server) OR
  //   - legacy `category` slug (kept in sync on every write).
  // `categoryFilter` holds a slug, so we compare against `i.category` first
  // and fall back to the resolved slug from pantryCategories[item.category_id].
  function _itemSlug(item) {
    if (item?.category) return item.category;
    if (item?.category_id) {
      const c = pantryCategories.find(x => x.id === item.category_id);
      return c?.slug || null;
    }
    return null;
  }

  // Variant-aware derivations (Issue #4). Hide variant rows from the
  // top-level list (they surface under their parents instead), and
  // build a parent-id-keyed lookup for the per-row variant fanout +
  // aggregate-stock pill.
  $: variantsByParent = buildVariantsByParent(items);
  $: topItems = topLevelItems(items);

  $: filtered = (() => {
    // Non-search filters (stock + category) run on top-level items only;
    // variants inherit their parent's category and their own stock rolls
    // up to the parent's aggregate for the stock pill.
    const preSearch = topItems
      .filter(i => {
        if (stockFilter === 'all') return true;
        if (stockFilter === 'expiring') {
          const myStatus = _expiryStatus(i.expires_on);
          if (myStatus === 'warn' || myStatus === 'past') return true;
          const kids = variantsByParent.get(i.id) || [];
          return kids.some(k => {
            const s = _expiryStatus(k.expires_on);
            return s === 'warn' || s === 'past';
          });
        }
        const agg = aggregateStock(i, variantsByParent);
        const inStock = agg.isGeneric ? agg.stocked > 0 : !!i.in_stock;
        return stockFilter === 'in' ? inStock : !inStock;
      })
      .filter(i => {
        if (categoryFilter === 'all') return true;
        if (categoryFilter === 'uncategorized') return !_itemSlug(i);
        return _itemSlug(i) === categoryFilter;
      });
    // Search classification (Issue #4 UX):
    //   * classifySearchHit === 'parent'   → include parent, no auto-expand
    //   * classifySearchHit === 'expanded' → include parent, expand it below
    //   * classifySearchHit === 'variants' → user typed brand-only tokens;
    //     surface each matching variant as its own top-level card with a
    //     "variant of Whole Milk" subtitle, and drop the parent from the
    //     result set (it wouldn't add anything the variant doesn't already
    //     communicate via its subtitle).
    const q = query.trim();
    const base = q
      ? (() => {
          const acc = [];
          for (const it of preSearch) {
            const cls = classifySearchHit(it, variantsByParent, q);
            if (cls === 'parent' || cls === 'expanded') {
              acc.push(it);
            } else if (cls === 'variants') {
              for (const v of matchingVariants(it, variantsByParent, q)) {
                acc.push({ ...v, _standaloneVariantParent: it });
              }
            }
          }
          return acc;
        })()
      : preSearch;
    // Apply sort. Stable secondary sort by name keeps tied entries
    // alphabetised so the order doesn't jitter on equal keys.
    const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
    if (sortKey === 'updated') {
      return base.slice().sort((a, b) =>
        (b.updated_at || '').localeCompare(a.updated_at || '') || byName(a, b)
      );
    }
    if (sortKey === 'usage') {
      return base.slice().sort((a, b) =>
        (b.recipe_count || 0) - (a.recipe_count || 0) || byName(a, b)
      );
    }
    return base.slice().sort(byName);
  })();

  // Auto-expand generics whose search classification is 'expanded' — the
  // user's query touched BOTH the parent and a specific variant, so the
  // matching variant should be visible under its parent right away.
  // 'variants' hits render standalone; 'parent' hits stay collapsed.
  $: {
    const q = query.trim();
    if (q) {
      const next = new Set(expandedGenerics);
      for (const it of topItems) {
        if (classifySearchHit(it, variantsByParent, q) === 'expanded') next.add(it.id);
      }
      if (next.size !== expandedGenerics.size) expandedGenerics = next;
    }
  }

  function toggleExpand(id) {
    if (expandedGenerics.has(id)) {
      // Start collapse — flag as collapsing, let the reverse animation
      // play, then unmount.
      collapsingGenerics = new Set(collapsingGenerics).add(id);
      setTimeout(() => {
        const nextExp = new Set(expandedGenerics); nextExp.delete(id);
        const nextCol = new Set(collapsingGenerics); nextCol.delete(id);
        expandedGenerics = nextExp;
        collapsingGenerics = nextCol;
      }, _VARIANT_EXIT_MS);
    } else {
      const next = new Set(expandedGenerics);
      next.add(id);
      expandedGenerics = next;
    }
  }

  // Counts per category, keyed by slug. Drives the chip badges.
  // Counts top-level items only (flat + generics); variants don't
  // show in the list so they shouldn't inflate category badges.
  $: categoryCounts = (() => {
    const c = { uncategorized: 0 };
    for (const cat of pantryCategories) c[cat.slug] = 0;
    for (const it of topItems) {
      const slug = _itemSlug(it);
      if (!slug) c.uncategorized++;
      else if (c[slug] != null) c[slug]++;
    }
    return c;
  })();

  // Top-level stocked count: a generic is "stocked" when at least one
  // variant is. Flat items use their own in_stock flag.
  $: stockedCount = topItems.filter(i => {
    const agg = aggregateStock(i, variantsByParent);
    return agg.isGeneric ? agg.stocked > 0 : !!i.in_stock;
  }).length;

  // Expiring-soon count (Issue #9). Counts top-level items whose own
  // expiry is warn/past OR whose any variant is. Used by the filter
  // chip badge.
  $: expiringSoonCount = topItems.filter(i => {
    const myStatus = _expiryStatus(i.expires_on);
    if (myStatus === 'warn' || myStatus === 'past') return true;
    const kids = variantsByParent.get(i.id) || [];
    return kids.some(k => {
      const s = _expiryStatus(k.expires_on);
      return s === 'warn' || s === 'past';
    });
  }).length;

  // Grouping: when "All categories" is selected AND no search query,
  // bucket the filtered items by category so each renders under its
  // own heading. Otherwise return a single flat bucket.
  $: groupedSections = (() => {
    // Non-default sort = the user wants a flat order, not category
    // grouping. Same when a specific filter or search is active.
    if (sortKey !== 'name' || categoryFilter !== 'all' || query.trim()) {
      return [{ key: '*', label: '', icon: '', items: filtered }];
    }
    const buckets = new Map();
    for (const it of filtered) {
      const slug = _itemSlug(it) || '__uncategorized__';
      if (!buckets.has(slug)) buckets.set(slug, []);
      buckets.get(slug).push(it);
    }
    const ordered = [];
    const emitted = new Set();
    for (const cat of pantryCategories) {
      const arr = buckets.get(cat.slug);
      if (arr && arr.length) {
        ordered.push({ key: cat.slug, label: cat.name, icon: cat.icon || 'kitchen', items: arr });
        emitted.add(cat.slug);
      }
    }
    // Fallback bucket: any item whose category slug doesn't match a known
    // pantryCategories entry (renamed/deleted category, cross-locale slug
    // mismatch, imported data referencing a foreign catalog) would
    // otherwise get silently dropped from the output when this grouping
    // path runs (sort=name + no filter + no query). Land them under
    // Uncategorized so items are never invisible. Fixes #41 where items
    // with Chinese category names disappeared on A-Z sort because their
    // slug didn't match anything in the current pantry-categories catalog.
    const unc = buckets.get('__uncategorized__') || [];
    const orphaned = [];
    for (const [slug, arr] of buckets) {
      if (slug === '__uncategorized__' || emitted.has(slug)) continue;
      orphaned.push(...arr);
      if (typeof console !== 'undefined') {
        console.warn(`[pantry] item slug "${slug}" not in pantryCategories catalog; grouping under Uncategorized (${arr.length} item${arr.length === 1 ? '' : 's'})`);
      }
    }
    if (unc.length || orphaned.length) {
      ordered.push({
        key: '__uncategorized__',
        label: 'Uncategorized',
        icon: 'help',
        items: [...unc, ...orphaned],
      });
    }
    return ordered;
  })();

  // Slug -> label / icon helpers for the card pills + filter chips.
  // Falls back to the legacy hardcoded helpers when the API list is
  // still loading (avoids flashing raw slugs).
  function _catNameBySlug(slug) {
    if (!slug) return 'Uncategorized';
    const c = pantryCategories.find(x => x.slug === slug);
    return c?.name || categoryLabel(slug);
  }
  function _catIconBySlug(slug) {
    if (!slug) return 'help';
    const c = pantryCategories.find(x => x.slug === slug);
    return c?.icon || categoryIcon(slug) || 'kitchen';
  }

  async function load() {
    loading = true;
    loadError = null;
    try {
      const [pantryRes, catsRes] = await Promise.all([
        NtApi.getPantry(),
        NtApi.getPantryCategories().catch(() => []),
      ]);
      items = pantryRes;
      pantryCategories = catsRes || [];
    } catch (e) {
      loadError = e.message || 'Could not load pantry';
      showError(loadError);
    } finally {
      loading = false;
    }
  }
  onMount(load);

  // Variant feature announcement (Issue #4 commit 4). One-shot banner
  // at the top of the Pantry page introducing the new feature. Dismiss
  // via the X; the key in localStorage keeps it dismissed across loads.
  // Versioned (v1) so a future announcement can re-show without
  // colliding with this one.
  const VARIANT_ANNOUNCE_KEY = 'ct:pantry:variant-announce-v1';
  let showVariantBanner = false;
  if (typeof localStorage !== 'undefined') {
    try { showVariantBanner = !localStorage.getItem(VARIANT_ANNOUNCE_KEY); } catch {}
  }
  function _dismissVariantBanner() {
    showVariantBanner = false;
    try { localStorage.setItem(VARIANT_ANNOUNCE_KEY, '1'); } catch {}
  }

  // Every create / edit / scan flow opens the same slide-up sheet now.
  // No more nav to a separate full-page editor: the sheet is the only
  // pantry editor in v1.0. itemId=null means create mode; startInEdit
  // tells the sheet to land in the form rather than the read view.
  let sheetOpen = false;
  let sheetItemId = null;
  let sheetStartInEdit = false;
  let sheetPrefill = null;
  function startCreate() {
    sheetPrefill = null;
    sheetItemId = null;
    sheetStartInEdit = true;
    sheetOpen = true;
  }
  function openItem(it) {
    sheetPrefill = null;
    sheetItemId = it.id;
    sheetStartInEdit = false;  // land in read view
    sheetOpen = true;
  }
  // Sheet's `changed` event lets us patch the in-memory grid so the
  // user sees stock / qty edits without a full reload.
  function onSheetChanged(e) {
    const updated = e.detail;
    if (!updated) return;
    items = items.map(i => i.id === updated.id ? { ...i, ...updated } : i);
  }
  function onSheetDeleted(e) {
    const id = e.detail?.id;
    if (id == null) return;
    items = items.filter(i => i.id !== id);
  }
  async function onSheetCreated(e) {
    // New row landed; refresh the list so it shows up + any side-effect
    // server fields (timestamps, derived flags) are reflected. Cheaper
    // to refetch than reconstruct locally.
    try { items = await NtApi.getPantry(); } catch {}
  }
  async function onSheetRefresh() {
    // Variant-relationship change (attach / detach / set-parent / add
    // new variant). The sheet emits 'changed' for the row it owns, but
    // those operations also mutate OTHER rows (the child being attached,
    // a flat item being promoted to a generic). A targeted local patch
    // can't fix the sibling row, so refetch the whole list.
    try { items = await NtApi.getPantry(); } catch {}
  }
  function startEdit(it) {
    sheetPrefill = null;
    sheetItemId = it.id;
    sheetStartInEdit = true;
    sheetOpen = true;
  }

  // ── Search-bar barcode scanner (mirrors NT Foods page) ────────────────
  let scannerOpen = false;
  async function onSearchScan(e) {
    const code = String(e?.detail?.code || e?.detail || '').trim();
    scannerOpen = false;
    if (!code) return;
    // 1. Already in pantry? Open the sheet in edit mode for that item.
    try {
      const existing = await NtApi.getPantryItemByBarcode?.(code);
      if (existing && existing.id) {
        startEdit(existing);
        return;
      }
    } catch {}
    // 2. Try OFF for a prefill — open the sheet in create mode.
    if ($offEnabled) {
      try {
        const off = await OFF.lookupBarcode(code);
        if (off) {
          sheetPrefill = { ...off, barcode: code };
          sheetItemId = null;
          sheetStartInEdit = true;
          sheetOpen = true;
          return;
        }
      } catch {}
    }
    // 3. USDA fallback by UPC (Branded products).
    if ($usdaEnabled && $usdaApiKey) {
      try {
        const usda = await USDA.lookupBarcode(code, $usdaApiKey);
        if (usda) {
          sheetPrefill = { ...usda, barcode: code };
          sheetItemId = null;
          sheetStartInEdit = true;
          sheetOpen = true;
          return;
        }
      } catch {}
    }
    // 4. Nothing found — open the sheet in create mode with just the barcode.
    sheetPrefill = { barcode: code };
    sheetItemId = null;
    sheetStartInEdit = true;
    sheetOpen = true;
  }

  // Click on a row → if in select mode, toggle; otherwise open the
  // read-only view (mirrors the recipe pattern: tap = view; action
  // sheet on long-press = edit / quick toggles / delete).
  function onRowClick(it) {
    if (selectMode) toggleSelected(it.id);
    else openItem(it);
  }
  // Long-press / right-click → open the row action sheet (NT pattern).
  // Inside select mode, long-press is a no-op (the menu would shadow
  // the bulk-action bar).
  let actionSheetOpen = false;
  let actionSheetItem = null;
  function onRowLongPress(it) {
    if (selectMode) return;
    actionSheetItem = it;
    actionSheetOpen = true;
  }
  $: rowActions = actionSheetItem ? [
    { label: 'Edit',                                                        icon: 'edit',         value: 'edit'   },
    { label: actionSheetItem.in_stock ? 'Mark as Out of Stock' : 'Mark as in Stock',
      icon: actionSheetItem.in_stock ? 'check_box_outline_blank' : 'check_box', value: 'stock'  },
    { label: 'Select Multiple',                                             icon: 'checklist',    value: 'select' },
    { label: 'Delete',                                                      icon: 'delete',       value: 'delete', danger: true },
  ] : [];
  async function onRowAction(e) {
    const v = e.detail?.value;
    const it = actionSheetItem;
    actionSheetItem = null;
    if (!it) return;
    if (v === 'edit')   startEdit(it);
    else if (v === 'stock')  await quickToggle(it);
    else if (v === 'select') {
      selectMode = true;
      selectedIds = new Set([it.id]);
    }
    else if (v === 'delete') await remove(it);
  }

  async function quickToggle(it) {
    // Quantity is the source of truth (v1.0). Marking out of stock
    // sets qty to 0; marking back in sets it to null (untracked, in
    // stock) so we don't have to invent a quantity. in_stock travels
    // alongside as a server-schema mirror so existing reads keep working.
    const nextInStock = Number(it.quantity) === 0; // currently out → going in
    const nextQty = nextInStock ? null : 0;
    const prevQty = it.quantity;
    const prevInStock = it.in_stock;
    items = items.map(i => i.id === it.id
      ? { ...i, quantity: nextQty, in_stock: nextInStock ? 1 : 0 }
      : i);
    try {
      await NtApi.updatePantryItem(it.id, { quantity: nextQty, in_stock: nextInStock ? 1 : 0 });
    } catch (e) {
      items = items.map(i => i.id === it.id ? { ...i, quantity: prevQty, in_stock: prevInStock } : i);
      showError(e.message || 'Could not update');
    }
  }

  async function remove(it) {
    const ok = await confirmDialog({
      title: 'Remove from pantry?',
      message: `"${it.name}" will be removed. Recipes referencing it stay; this just drops it from your library.`,
      confirmText: 'Remove',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.deletePantryItem(it.id);
      items = items.filter(i => i.id !== it.id);
      showSuccess($_('pantry_page.toast.removed'));
    } catch (e) {
      showError(e.message || 'Delete failed');
    }
  }
</script>

<div class="page-shell" style="--header-h: {headerH}px">
  <header class="page-header"
    class:banner-gradient={$bannerStyle === 'gradient' && !selectMode}
    class:banner-animated={$bannerStyle === 'animated' && !selectMode}
    class:select-mode={selectMode}
    bind:offsetHeight={headerH}>
    {#if selectMode}
      <h1>{selectedIds.size} Selected</h1>
      <button class="btn-icon header-action" on:click={bulkDelete} disabled={selectedIds.size === 0} aria-label="Delete selected" title="Delete selected">
        <span class="material-symbols-rounded">delete</span>
      </button>
      <button class="btn-icon header-action header-action-2" on:click={exitSelectMode} aria-label="Cancel selection" title="Cancel">
        <span class="material-symbols-rounded">close</span>
      </button>
    {:else}
      <h1>{$_('routes.pantry.title')}</h1>
      <button class="btn-icon header-action" on:click={startCreate} aria-label="Add item" title="Add item">
        <span class="material-symbols-rounded">add</span>
      </button>
    {/if}
  </header>

  <div class="page-content">
    {#if showVariantBanner && items.length > 0}
      <div class="variant-banner" in:fade={{ duration: 160 }}>
        <span class="material-symbols-rounded variant-banner-icon">category</span>
        <div class="variant-banner-body">
          <div class="variant-banner-title">{$_('pantry_page.variant_banner_title')}</div>
          <p class="variant-banner-desc">
            Group different brands of the same ingredient under one pantry entry. Open any item, scroll to Variants, and add a brand or store. Recipes that link to the generic match any of the variants. Your existing pantry works exactly as before until you opt in per item.
          </p>
        </div>
        <button class="variant-banner-close" on:click={_dismissVariantBanner} aria-label="Dismiss">
          <span class="material-symbols-rounded">close</span>
        </button>
      </div>
    {/if}
    {#if items.length > 0}
      <div class="toolbar sticky-controls">
        <div class="search-row">
          <span class="material-symbols-rounded search-icon">search</span>
          <input class="search" type="search" placeholder={$_('routes.pantry.search_placeholder')} bind:value={query} />
          <button class="search-scan" on:click={() => scannerOpen = true} aria-label="Scan barcode" title="Scan barcode">
            <span class="material-symbols-rounded">barcode_scanner</span>
          </button>
        </div>
        <!-- Single wrapping filter row: source picker (only when more
             than one source), stock chips, category chips, Select.
             Saves ~80px versus the previous three-row stack. -->
        <div class="filter-row">
          {#if availableSources.length > 1}
            <div class="source-chip-row inline">
              {#each availableSources as src (src.value)}
                {#if src.value === 'off'}
                  <div class="source-chip-wrap">
                    <button class="source-chip source-chip-split"
                            class:active={activeChips.off}
                            on:click={() => _onChipTap('off')}
                            on:contextmenu|preventDefault={() => _toggleChipInMulti('off')}
                            on:touchstart|passive={(e) => _startChipLongPress('off', e)}
                            on:touchmove|passive={_maybeCancelChipLongPress}
                            on:touchend={_cancelChipLongPress}
                            on:touchcancel={_cancelChipLongPress}>
                      {src.label}
                      {#if offTiersFiltered}<span class="tier-active-dot" title="OFF tier filter active"></span>{/if}
                    </button>
                    <button class="source-chip-caret"
                            class:active={activeChips.off}
                            class:open={offDropdownOpen}
                            bind:this={offCaretEl}
                            on:click={openOffDropdown}
                            aria-label="Filter OFF results by quality tier"
                            aria-expanded={offDropdownOpen}>
                      <span class="material-symbols-rounded">expand_more</span>
                    </button>
                  </div>
                {:else if src.value === 'usda'}
                  <div class="source-chip-wrap">
                    <button class="source-chip source-chip-split"
                            class:active={activeChips.usda}
                            on:click={() => _onChipTap('usda')}
                            on:contextmenu|preventDefault={() => _toggleChipInMulti('usda')}
                            on:touchstart|passive={(e) => _startChipLongPress('usda', e)}
                            on:touchmove|passive={_maybeCancelChipLongPress}
                            on:touchend={_cancelChipLongPress}
                            on:touchcancel={_cancelChipLongPress}>
                      {src.label}
                      {#if usdaTiersFiltered}<span class="tier-active-dot" title="USDA tier filter active"></span>{/if}
                    </button>
                    <button class="source-chip-caret"
                            class:active={activeChips.usda}
                            class:open={usdaDropdownOpen}
                            bind:this={usdaCaretEl}
                            on:click={openUsdaDropdown}
                            aria-label="Filter USDA results by data type"
                            aria-expanded={usdaDropdownOpen}>
                      <span class="material-symbols-rounded">expand_more</span>
                    </button>
                  </div>
                {:else}
                  <button class="source-chip"
                          class:active={activeChips[src.value]}
                          on:click={() => _onChipTap(src.value)}>
                    {src.label}
                  </button>
                {/if}
              {/each}
            </div>
            <span class="filter-divider" aria-hidden="true"></span>
          {/if}
          <div class="filter-chips">
            {#each [['all','All'], ['in','In Stock'], ['out','Out'], ['expiring','Expiring Soon']] as [v, label]}
              <button class="seg" class:active={stockFilter === v} on:click={() => stockFilter = v}>
                {label}
                {#if v === 'in'}<span class="seg-count">{stockedCount}</span>{/if}
                {#if v === 'out'}<span class="seg-count">{topItems.length - stockedCount}</span>{/if}
                {#if v === 'all'}<span class="seg-count">{topItems.length}</span>{/if}
                {#if v === 'expiring'}<span class="seg-count">{expiringSoonCount}</span>{/if}
              </button>
            {/each}
          </div>
          <span class="filter-divider" aria-hidden="true"></span>
          <div class="filter-chips category-chips">
            <button class="seg" class:active={categoryFilter === 'all'} on:click={() => categoryFilter = 'all'}>
              All
            </button>
            {#each pantryCategories as cat (cat.id)}
              {#if categoryCounts[cat.slug] > 0}
                <button class="seg" class:active={categoryFilter === cat.slug} on:click={() => categoryFilter = cat.slug}>
                  <span class="material-symbols-rounded" style="font-size:14px">{cat.icon || 'kitchen'}</span>
                  {cat.name}
                  <span class="seg-count">{categoryCounts[cat.slug]}</span>
                </button>
              {/if}
            {/each}
            {#if categoryCounts.uncategorized > 0}
              <button class="seg" class:active={categoryFilter === 'uncategorized'} on:click={() => categoryFilter = 'uncategorized'}>
                Uncategorized
                <span class="seg-count">{categoryCounts.uncategorized}</span>
              </button>
            {/if}
          </div>
          <!-- Sort menu. Lives in the toolbar next to the view toggle
               so users can quickly switch from "categorised grocery
               aisles" to "what's about to expire". -->
          <label class="sort-menu ml-auto" title="Sort items">
            <span class="material-symbols-rounded">sort</span>
            <select class="sort-select" bind:value={sortKey}>
              <option value="name">A → Z</option>
              <option value="updated">{$_('pantry_page.sort_updated')}</option>
              <option value="usage">{$_('pantry_page.sort_usage')}</option>
            </select>
          </label>
          <!-- Grid vs list only applies to the local pantry render. External
               OFF / USDA / All source chips use a single-column search-
               result layout that doesn't respond to this toggle, so hide
               it when the pantry list itself is hidden (source != local
               with an active query). -->
          {#if searchSource === 'local' || !query.trim()}
            <div class="view-toggle" role="group" aria-label="View mode">
              <button class="seg seg-icon" class:active={$pantryView === 'grid'}
                on:click={() => pantryView.set('grid')} title="Grid view" aria-pressed={$pantryView === 'grid'}>
                <span class="material-symbols-rounded" style="font-size:16px">grid_view</span>
              </button>
              <button class="seg seg-icon" class:active={$pantryView === 'list'}
                on:click={() => pantryView.set('list')} title="List view" aria-pressed={$pantryView === 'list'}>
                <span class="material-symbols-rounded" style="font-size:16px">view_list</span>
              </button>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    {#if loading}
      <!-- Skeleton placeholders matching the pantry card / list row
           shape, so the initial render doesn't pop a spinner-then-
           grid. Picks the right skeleton flavor for the active view
           mode so the layout stays stable. -->
      <div class="card-grid skeleton-grid" class:list={$pantryView === 'list'}
        aria-busy="true" aria-label="Loading pantry">
        {#each Array($pantryView === 'list' ? 8 : 12) as _}
          <div class="skel skel-pcard">
            <div class="skel-photo"></div>
            <div class="skel-body">
              <div class="skel-line w70"></div>
              <div class="skel-line w40"></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if loadError}
      <div class="state error">
        <span class="material-symbols-rounded">error</span>
        <p>{loadError}</p>
        <button class="btn btn-secondary" on:click={load}>{$_('pantry_page.retry')}</button>
      </div>
    {:else if items.length === 0}
      <div class="state empty">
        <span class="material-symbols-rounded empty-icon">kitchen</span>
        <h2>{$_('routes.pantry.empty_title')}</h2>
        <p>{$_('routes.pantry.empty_desc')}</p>
        <button class="btn btn-primary" on:click={startCreate}>{$_('routes.pantry.add_item')}</button>
      </div>
    {:else if searchSource !== 'local' && query.trim()}
      <!-- Pantry list intentionally hidden: OFF / USDA / All source chip
           with an active query is a filter-to-external, not "pantry PLUS
           external". The external-results block below renders the chosen
           source(s). Users get the pantry-first view back by picking the
           Pantry (local) chip or clearing the query. -->
    {:else if filtered.length === 0}
      {#if searchSource === 'local'}
        <div class="state empty">
          <span class="material-symbols-rounded empty-icon">search_off</span>
          <p>{$_('routes.pantry.no_match', { values: { q: query } })}</p>
        </div>
      {/if}
    {:else}
      {#each groupedSections as section (section.key)}
        {#if section.label}
          <h3 class="section-heading">
            <span class="material-symbols-rounded">{section.icon || 'help'}</span>
            {section.label}
            <span class="section-count">{section.items.length}</span>
          </h3>
        {/if}
        <div class="card-grid" class:list={$pantryView === 'list'}>
          {#each section.items as it (it.id)}
            {@const isSelected = selectMode && selectedIds.has(it.id)}
            {@const stockAgg = aggregateStock(it, variantsByParent)}
            {@const isGen = stockAgg.isGeneric}
            {@const effExp = _effectiveExpiry(it, isGen)}
            {@const inStockDisplay = isGen ? stockAgg.stocked > 0 : !!it.in_stock}
            {@const expanded = expandedGenerics.has(it.id)}
            {@const variants = isGen ? (variantsByParent.get(it.id) || []) : []}
            <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
            <article class="pcard"
              class:in-stock={inStockDisplay}
              class:selected={isSelected}
              class:generic={isGen}
              on:click={() => onRowClick(it)}
              use:longpress
              on:longpress={() => onRowLongPress(it)}
              on:contextmenu|preventDefault={() => onRowLongPress(it)}
              role="button" tabindex="0"
              on:keydown={(e) => { if (e.key === 'Enter') onRowClick(it); }}>

              <div class="pcard-photo">
                {#if it.img_url}
                  <img src={it.img_url} alt="" loading="lazy" />
                {:else}
                  <span class="material-symbols-rounded photo-stub">{_catIconBySlug(_itemSlug(it))}</span>
                {/if}
                {#if selectMode}
                  <button class="photo-stock"
                    class:on={isSelected}
                    on:click|stopPropagation={() => toggleSelected(it.id)}
                    aria-label={isSelected ? 'Deselect' : 'Select'}>
                    <span class="material-symbols-rounded">{isSelected ? 'check' : 'add'}</span>
                  </button>
                {:else if !isGen}
                  <button class="photo-stock"
                    class:on={inStockDisplay}
                    on:click|stopPropagation={() => quickToggle(it)}
                    aria-label={inStockDisplay ? 'Mark as out of stock' : 'Mark as in stock'}
                    title={inStockDisplay ? 'In stock' : 'Out of stock'}>
                    <span class="material-symbols-rounded">{inStockDisplay ? 'check' : 'add'}</span>
                  </button>
                {/if}
              </div>

              <div class="pcard-body">
                <div class="pcard-name">{it.name}</div>
                {#if it.brand}
                  <div class="pcard-brand">{it.brand}</div>
                {/if}
                {#if it._standaloneVariantParent}
                  <div class="pcard-variant-of">Variant of {it._standaloneVariantParent.name}</div>
                {/if}
                <div class="pcard-meta">
                  {#if isGen}
                    <span class="pcard-pill variants-pill" title={`${stockAgg.stocked} of ${stockAgg.total} variants in stock`}>
                      <span class="material-symbols-rounded">category</span>
                      {stockAgg.stocked} / {stockAgg.total}
                    </span>
                  {:else if it.quantity != null || it.unit}
                    <span class="pcard-qty">
                      {it.quantity ?? ''}{it.quantity != null && it.unit ? ' ' : ''}{it.unit ?? ''}
                    </span>
                  {/if}
                  <!-- Recipe-usage pill, only when actually used. -->
                  {#if it.recipe_count > 0}
                    <span class="pcard-pill usage-pill" title={`Used in ${it.recipe_count} recipe${it.recipe_count === 1 ? '' : 's'}`}>
                      <span class="material-symbols-rounded">restaurant</span>
                      {it.recipe_count}
                    </span>
                  {/if}
                  <!-- Expiry pill (Issue #9). For generics, the effExp
                       above is the earliest expiring child. For flat
                       items + variants, it's the row's own date. Only
                       renders on warn / past. -->
                  {#if effExp}
                    {@const expStatus = _expiryStatus(effExp)}
                    {#if expStatus === 'warn' || expStatus === 'past'}
                      <span class="pcard-pill expiry-pill" class:past={expStatus === 'past'} title={`Expires ${effExp}`}>
                        <span class="material-symbols-rounded">{expStatus === 'past' ? 'event_busy' : 'schedule'}</span>
                        {_expiryShortLabel(effExp)}
                      </span>
                    {/if}
                  {/if}
                  <!-- Category pill only when ungrouped (search/specific filter) -->
                  {#if !section.label && _itemSlug(it)}
                    {@const slug = _itemSlug(it)}
                    <span class="pcard-pill">
                      <span class="material-symbols-rounded">{_catIconBySlug(slug)}</span>
                      {_catNameBySlug(slug)}
                    </span>
                  {/if}
                </div>
              </div>

              {#if isGen}
                <button class="pcard-expand"
                  class:open={expanded}
                  on:click|stopPropagation={() => toggleExpand(it.id)}
                  aria-label={expanded ? 'Collapse variants' : 'Expand variants'}
                  title={expanded ? 'Collapse variants' : 'Expand variants'}>
                  <span class="material-symbols-rounded chevron-icon" class:up={expanded}>expand_more</span>
                </button>
              {/if}
            </article>

            {#if isGen && expanded}
              {#each variants as v, vIdx (v.id)}
                <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
                <article class="pcard variant-card"
                  class:in-stock={v.in_stock}
                  class:collapsing={collapsingGenerics.has(it.id)}
                  style={`--variant-stagger: ${vIdx * 60}ms;`}
                  on:click={() => onRowClick(v)}
                  use:longpress
                  on:longpress={() => onRowLongPress(v)}
                  on:contextmenu|preventDefault={() => onRowLongPress(v)}
                  role="button" tabindex="0"
                  on:keydown={(e) => { if (e.key === 'Enter') onRowClick(v); }}>
                  <div class="pcard-photo">
                    {#if v.img_url}
                      <img src={v.img_url} alt="" loading="lazy" />
                    {:else}
                      <span class="material-symbols-rounded photo-stub">label</span>
                    {/if}
                    {#if !selectMode}
                      <button class="photo-stock"
                        class:on={v.in_stock}
                        on:click|stopPropagation={() => quickToggle(v)}
                        aria-label={v.in_stock ? 'Mark as out of stock' : 'Mark as in stock'}
                        title={v.in_stock ? 'In stock' : 'Out of stock'}>
                        <span class="material-symbols-rounded">{v.in_stock ? 'check' : 'add'}</span>
                      </button>
                    {/if}
                  </div>
                  <div class="pcard-body">
                    <div class="pcard-name">{displayVariantName(v, it, { nested: true })}</div>
                    <div class="pcard-meta">
                      {#if v.quantity != null || v.unit}
                        <span class="pcard-qty">
                          {v.quantity ?? ''}{v.quantity != null && v.unit ? ' ' : ''}{v.unit ?? ''}
                        </span>
                      {/if}
                    </div>
                  </div>
                </article>
              {/each}
            {/if}
          {/each}
        </div>
      {/each}
    {/if}

    {#if searchSource === 'all' && query.trim()}
      <div class="ext-results">
        {#if externalLoading}
          <div class="loading-row">
            <span class="material-symbols-rounded spin">refresh</span>
            <span class="loading-text">Searching all sources…</span>
          </div>
        {:else if _allModeItems.length === 0}
          <div class="state empty">
            <span class="material-symbols-rounded empty-icon">search_off</span>
            <p>{$_('pantry_page.no_results_all')}</p>
          </div>
        {:else}
          <ul class="items">
            {#each _allModeItems as r, i (r._source + ':' + i + ':' + (r.barcode || r.name))}
              <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
              <li class="item ext-item" on:click={() => pickExternalResult(r)}
                role="button" tabindex="0"
                on:keydown={(e) => { if (e.key === 'Enter') pickExternalResult(r); }}>
                {#if r.img_url}
                  <img class="item-thumb" src={r.img_url} alt="" loading="lazy" />
                {:else}
                  <span class="material-symbols-rounded ext-stub-icon">qr_code_scanner</span>
                {/if}
                <div class="item-body">
                  <div class="item-name">
                    <span class="src-badge src-{r._source}">{r._source === 'off' ? 'OFF' : 'USDA'}</span>
                    {r.name}
                    {#if r._source === 'off' && r.completeness != null}
                      <span class="completeness-dot" class:high={r.completeness >= 0.85}
                            class:mid={r.completeness >= 0.6 && r.completeness < 0.85}
                            class:low={r.completeness < 0.6}
                            title="OFF completeness: {Math.round(r.completeness * 100)}%"></span>
                    {/if}
                    {#if r._source === 'off' && r.originTag}
                      {@const _flag = offCountryTagToFlag(r.originTag)}
                      {#if _flag}
                        <span class="origin-flag" title="Origin: {offCountryTagToName(r.originTag)}">{_flag}</span>
                      {/if}
                    {/if}
                    {#if r._source === 'usda' && r.dataType}
                      <span class="usda-type-badge" title="USDA data type: {r.dataType}">{r.dataType}</span>
                    {/if}
                  </div>
                  {#if r.brand}<div class="item-notes">{r.brand}</div>{/if}
                  {#if r.barcode}<div class="item-qty" style="font-size:11px">{r.barcode}</div>{/if}
                </div>
                <span class="material-symbols-rounded ext-add">add_circle</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {:else if searchSource !== 'local' && query.trim()}
      {@const _srcLabel = searchSource === 'off' ? 'OFF' : 'USDA'}
      {@const _visibleResults = searchSource === 'off' ? offVisible : usdaVisible}
      {@const _tiersFilteredHere = searchSource === 'off' ? offTiersFiltered : usdaTiersFiltered}
      <div class="ext-results">
        {#if externalLoading}
          <div class="loading-row">
            <span class="material-symbols-rounded spin">refresh</span>
            <span class="loading-text">Searching in {_srcLabel}…</span>
          </div>
        {:else if externalResults.length === 0}
          <div class="state empty">
            <span class="material-symbols-rounded empty-icon">search_off</span>
            <p>No results in {_srcLabel}</p>
          </div>
        {:else if _visibleResults.length === 0}
          <div class="state empty">
            <span class="material-symbols-rounded empty-icon">filter_alt_off</span>
            <p>All {_srcLabel} results hidden by tier filter</p>
            <button class="btn secondary" style="margin-top:8px" on:click={() => searchSource === 'off' ? resetOffTiers() : resetUsdaTiers()}>{$_('pantry_page.reset_filter')}</button>
          </div>
        {:else}
          <ul class="items">
            {#each _visibleResults as r, i (i + (r.barcode || r.name))}
              <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
              <li class="item ext-item" on:click={() => pickExternalResult(r)}
                role="button" tabindex="0"
                on:keydown={(e) => { if (e.key === 'Enter') pickExternalResult(r); }}>
                {#if r.img_url}
                  <img class="item-thumb" src={r.img_url} alt="" loading="lazy" />
                {:else}
                  <span class="material-symbols-rounded ext-stub-icon">qr_code_scanner</span>
                {/if}
                <div class="item-body">
                  <div class="item-name">
                    {r.name}
                    {#if searchSource === 'off' && r.completeness != null}
                      <span class="completeness-dot" class:high={r.completeness >= 0.85}
                            class:mid={r.completeness >= 0.6 && r.completeness < 0.85}
                            class:low={r.completeness < 0.6}
                            title="OFF completeness: {Math.round(r.completeness * 100)}%"></span>
                    {/if}
                    {#if searchSource === 'off' && r.originTag}
                      {@const _flag = offCountryTagToFlag(r.originTag)}
                      {#if _flag}
                        <span class="origin-flag" title="Origin: {offCountryTagToName(r.originTag)}">{_flag}</span>
                      {/if}
                    {/if}
                    {#if searchSource === 'usda' && r.dataType}
                      <span class="usda-type-badge" title="USDA data type: {r.dataType}">{r.dataType}</span>
                    {/if}
                  </div>
                  {#if r.brand}<div class="item-notes">{r.brand}</div>{/if}
                  {#if r.barcode}<div class="item-qty" style="font-size:11px">{r.barcode}</div>{/if}
                </div>
                <span class="material-symbols-rounded ext-add">add_circle</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </div>
</div>

<!-- Search-bar barcode scanner. -->
<BarcodeScanner bind:open={scannerOpen} on:scan={onSearchScan} on:close={() => scannerOpen = false} />

<!-- Long-press / right-click action sheet — opens on a single row when
     not in select mode. Mirrors the NT diary item context menu. -->
<ActionSheet
  bind:open={actionSheetOpen}
  title={actionSheetItem?.name || ''}
  actions={rowActions}
  on:select={onRowAction}
/>

<!-- Slide-up details sheet. Replaces the navigate-to-PantryView pattern
     so the user stays on the Pantry list and gets a fast read+act
     surface (toggle stock, bump qty) before tapping Edit for a full
     editor page. -->
<PantryItemSheet
  bind:open={sheetOpen}
  itemId={sheetItemId}
  startInEdit={sheetStartInEdit}
  prefill={sheetPrefill}
  on:changed={onSheetChanged}
  on:deleted={onSheetDeleted}
  on:created={onSheetCreated}
  on:refresh={onSheetRefresh}
/>

<svelte:window on:click={_onWindowClick} on:touchmove={_onWindowTouchMove}
               on:scroll={_closeTierDropdowns} on:resize={_closeTierDropdowns} />

{#if offDropdownOpen}
  <div class="tier-dropdown-backdrop" use:portal></div>
  <div class="tier-dropdown-panel" use:portal
       bind:this={offDropdownPanelEl}
       style="top:{offDropdownPos.top}px; right:{offDropdownPos.right}px"
       transition:slide={{ duration: 140 }}>
    <div class="tier-dropdown-head">
      <span>{$_('pantry_page.off_quality')}</span>
      {#if offTiersFiltered}
        <button class="tier-dropdown-reset" on:click={resetOffTiers}>{$_('pantry_page.reset')}</button>
      {/if}
    </div>
    <div class="tier-dropdown-options">
      {#each [['hi','Complete (85%+)','high'], ['mid','Partial (60-85%)','mid'], ['lo','Sparse (<60%)','low'], ['unknown','Unknown','low']] as [key, label, swatch] (key)}
        <label class="tier-option">
          <input type="checkbox" checked={offTiersActive.has(key)} on:change={() => toggleOffTier(key)} />
          <span class="tier-swatch tier-{swatch}"></span>
          <span class="tier-label">{label}</span>
        </label>
      {/each}
    </div>
  </div>
{/if}

{#if usdaDropdownOpen}
  <div class="tier-dropdown-backdrop" use:portal></div>
  <div class="tier-dropdown-panel" use:portal
       bind:this={usdaDropdownPanelEl}
       style="top:{usdaDropdownPos.top}px; right:{usdaDropdownPos.right}px"
       transition:slide={{ duration: 140 }}>
    <div class="tier-dropdown-head">
      <span>{$_('pantry_page.usda_data_type')}</span>
      {#if usdaTiersFiltered}
        <button class="tier-dropdown-reset" on:click={resetUsdaTiers}>{$_('pantry_page.reset')}</button>
      {/if}
    </div>
    <div class="tier-dropdown-options">
      {#each _USDA_TIERS as tier (tier)}
        <label class="tier-option">
          <input type="checkbox" checked={usdaTiersActive.has(tier)} on:change={() => toggleUsdaTier(tier)} />
          <span class="tier-label">{tier}</span>
        </label>
      {/each}
    </div>
  </div>
{/if}

<style>
  .header-action {
    position: fixed;
    top: calc(var(--safe-top) + 10px);
    right: 12px;
    width: 40px; height: 40px;
    border-radius: var(--radius-md);
    background: rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(10px) saturate(160%);
    -webkit-backdrop-filter: blur(10px) saturate(160%);
    border: 1px solid rgba(255, 255, 255, 0.18);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    color: var(--accent);
    z-index: 41;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }
  .header-action:hover  { background: rgba(0, 0, 0, 0.5); }
  .header-action:disabled { opacity: 0.35; cursor: not-allowed; }
  .header-action.header-action-2 { right: 60px; }
  /* Kills the animated / gradient banner shimmer while multi-select is
     active so the header reads as a distinct focused mode. */
  .page-header.select-mode {
    background: var(--surface-1);
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  }

  .toolbar { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }

  /* Sort menu — inline label + native select dressed up to match the
     seg buttons. Keeps it accessible (native keyboard nav) while
     reading visually as part of the toolbar. */
  .sort-menu {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0 4px 0 8px;
    cursor: pointer;
    color: var(--text-2);
    transition: border-color var(--dur-fast), color var(--dur-fast);
  }
  .sort-menu:hover { color: var(--text-1); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .sort-menu .material-symbols-rounded { font-size: 16px; color: inherit; }
  .sort-select {
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    color: inherit;
    border: none;
    padding: 6px 4px 6px 2px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    outline: none;
  }
  .sort-select option { background: var(--surface-1); color: var(--text-1); }

  /* Sticky list controls — pin search + filter row to the top of the
     scroll container so users don't have to scroll up to refine after
     browsing a long pantry. Backdrop-blur fade keeps the cards behind
     readable as they scroll up underneath. */
  .sticky-controls {
    position: sticky;
    /* Pin below the sticky page-header — --header-h is measured at
       runtime so the offset adapts to banner / hamburger variants. */
    top: var(--header-h, 0px);
    z-index: 5;
    margin: 0 calc(-1 * var(--space-4)) 12px;
    padding: 8px var(--space-4) 4px;
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  }
  /* Single wrapping filter row replacing the previous 3-row stack.
     Wraps on phones; on tablet/desktop everything sits side-by-side. */
  .filter-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
  }
  .filter-row .filter-chips { gap: 4px; }
  .filter-row .source-chip-row.inline { gap: 4px; }
  .filter-divider {
    width: 1px;
    align-self: stretch;
    background: var(--border);
    opacity: 0.5;
    margin: 4px 4px;
  }
  .ml-auto { margin-left: auto; }
  .search-row { position: relative; }
  .search-icon {
    position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
    color: var(--text-3); pointer-events: none; font-size: 20px;
  }
  .search {
    width: 100%; box-sizing: border-box;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 10px 44px 10px 38px;
    color: var(--text-1); font-size: 14px;
  }
  .search:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .search-scan {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    background: none; border: none; cursor: pointer;
    color: var(--text-3); padding: 4px;
    display: flex; align-items: center;
  }
  .search-scan:hover { color: var(--accent); }
  .search-scan .material-symbols-rounded { font-size: 22px; }

  /* External-source chips (Pantry / OFF / USDA) — same look as NT
     Foods source-chip row. */
  .source-chip-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .source-chip {
    background: var(--surface-2); color: var(--text-2);
    border: 1px solid var(--border); border-radius: var(--radius-full, 99px);
    padding: 5px 14px; font-size: 12px; font-weight: 600;
    cursor: pointer;
    transition: all var(--dur-fast);
  }
  .source-chip:hover { border-color: var(--accent); color: var(--text-1); }
  .source-chip.active {
    background: var(--accent-dim); color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  /* Suppress Android WebView long-press text selection on chips. */
  .source-chip, .source-chip-caret {
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  /* Split-chip architecture:
     - .source-chip-wrap owns the entire pill's border, background,
       hover state, and active state. Both children draw inside it.
     - .source-chip-split (label + optional dot) and .source-chip-caret
       (chevron) have zero border/background so hover on either half
       lights up the whole pill.
     - A subtle .source-chip-caret::before divider marks the split
       without introducing per-child hover targets.
     - Solid state (not per-layered): removed the earlier per-child
       .active + :has() combo that produced half-lit pills when a
       hover landed on only one child. */
  .source-chip-wrap {
    display: inline-flex; align-items: stretch; gap: 0;
    background: var(--surface-2);
    color: var(--text-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full, 99px);
    overflow: hidden;
    cursor: pointer;
    transition: all var(--dur-fast);
    /* Set the shared type on the wrap so children inherit consistently.
       Don't put `font: inherit` on the children — it's a shorthand that
       resets size/weight/family together, which reads as unset browser
       defaults and makes the split pills render larger than the
       non-split .source-chip pills. */
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
  }
  .source-chip-wrap:hover { border-color: var(--accent); color: var(--text-1); }
  .source-chip-wrap:has(.active) {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  /* Children: pure content areas, no borders/backgrounds. Inherit font
     from the wrap (see the note there) — do NOT set `font: inherit`,
     which is a shorthand and would clobber the intended size/weight. */
  .source-chip-wrap .source-chip-split,
  .source-chip-wrap .source-chip-caret {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    transition: none;
  }
  .source-chip-split {
    padding: 5px 8px 5px 14px;
    display: inline-flex; align-items: center; gap: 5px;
  }
  .source-chip-caret {
    padding: 0 6px 0 4px;
    display: inline-flex; align-items: center;
    position: relative;
  }
  /* Divider between the two halves — subtle vertical line, not a
     border on either child (which would make hover/active per-half). */
  .source-chip-caret::before {
    content: '';
    width: 1px;
    align-self: stretch;
    background: var(--border);
    margin-right: 4px;
    opacity: 0.6;
  }
  .source-chip-wrap:has(.active) .source-chip-caret::before {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .source-chip-caret .material-symbols-rounded {
    font-size: 16px;
    transition: transform var(--dur-fast);
  }
  .source-chip-caret.open .material-symbols-rounded { transform: rotate(180deg); }
  .tier-active-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--accent, #4caf50);
    display: inline-block;
  }

  /* Backdrop is transparent to pointer events so page scroll still works;
     dismiss is handled by <svelte:window> click/touchmove/scroll listeners. */
  .tier-dropdown-backdrop {
    position: fixed; inset: 0;
    z-index: 1000;
    pointer-events: none;
  }
  .tier-dropdown-panel {
    position: fixed;
    z-index: 1001;
    background: var(--surface-1); color: var(--text-1);
    border: 1px solid var(--border); border-radius: var(--radius-md, 10px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
    padding: 8px 4px;
    max-width: 260px;
  }
  .tier-dropdown-head {
    display: flex; justify-content: space-between; align-items: center;
    padding: 4px 10px 6px; font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--text-2); border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  .tier-dropdown-reset {
    background: transparent; border: none; color: var(--accent);
    font-size: 11px; font-weight: 700; cursor: pointer;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .tier-dropdown-options { display: flex; flex-direction: column; }
  .tier-option {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 10px; cursor: pointer;
    font-size: 13px;
    border-radius: 6px;
  }
  .tier-option:hover { background: var(--surface-2); }
  .tier-option input[type="checkbox"] { margin: 0; }
  .tier-swatch {
    width: 10px; height: 10px; border-radius: 50%;
    display: inline-block; flex-shrink: 0;
    background: var(--text-2);
  }
  .tier-swatch.tier-high { background: #4caf50; }
  .tier-swatch.tier-mid  { background: #ff9800; }
  .tier-swatch.tier-low  { background: #9e9e9e; }
  .tier-label { flex: 1; }

  /* Per-row quality decorations */
  .completeness-dot {
    display: inline-block;
    width: 8px; height: 8px; border-radius: 50%;
    vertical-align: middle;
    margin-left: 6px;
    background: var(--text-2);
  }
  .completeness-dot.high { background: #4caf50; }
  .completeness-dot.mid  { background: #ff9800; }
  .completeness-dot.low  { background: #9e9e9e; }
  .origin-flag {
    display: inline-block; margin-left: 6px; font-size: 14px;
    vertical-align: middle;
  }
  .usda-type-badge {
    display: inline-block; margin-left: 6px;
    font-size: 10px; font-weight: 700;
    padding: 1px 6px; border-radius: 4px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
    vertical-align: middle;
    text-transform: uppercase; letter-spacing: 0.3px;
  }
  .src-badge {
    display: inline-block;
    font-size: 10px; font-weight: 700;
    padding: 1px 6px; border-radius: 4px;
    margin-right: 6px;
    vertical-align: middle;
    text-transform: uppercase; letter-spacing: 0.3px;
  }
  .src-badge.src-off  { background: #2e7d32; color: #fff; }
  .src-badge.src-usda { background: #1565c0; color: #fff; }

  /* External-search results — no heading since the active source-chip
     already labels which API is being queried. */
  .ext-results { margin-top: 6px; }
  /* Loading row mirrors NT Foods exactly: centered icon + label,
     16px padding, 8px gap. */
  .loading-row {
    display: flex; align-items: center; justify-content: center;
    gap: 8px; padding: 16px;
  }
  .loading-row .spin { animation: spin 1.2s linear infinite; color: var(--text-3); }
  .loading-text { font-size: 13px; color: var(--text-2); }
  .ext-item { cursor: pointer; }
  .ext-item:hover { border-color: var(--accent); }
  .ext-stub-icon {
    width: 36px; height: 36px;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-3); flex-shrink: 0;
    background: var(--surface-2); border-radius: var(--radius-sm);
    font-size: 22px;
  }
  .ext-add { color: var(--accent); flex-shrink: 0; }

  .filter-chips { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
  .select-toggle { margin-left: auto; }
  .seg {
    background: var(--surface-2); color: var(--text-2);
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 6px 12px; font-size: 12px; font-weight: 600;
    cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  }
  .seg.active {
    background: var(--accent-dim); color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .seg-count {
    font-size: 10px; padding: 1px 5px; background: var(--surface-1);
    border-radius: var(--radius-full, 99px); color: var(--text-3);
    font-weight: 700;
  }
  .seg.active .seg-count { background: color-mix(in srgb, var(--accent) 25%, transparent); color: var(--accent); }

  /* Two-up grid/list view toggle. Sits in the filter row beside the
     Select button — adjacent .seg-icon buttons share borders so they
     read as one segmented control. */
  .view-toggle { display: inline-flex; gap: 0; }
  .view-toggle .seg-icon {
    padding: 6px 10px;
    border-radius: 0;
  }
  .view-toggle .seg-icon:first-child {
    border-top-left-radius: var(--radius-sm);
    border-bottom-left-radius: var(--radius-sm);
  }
  .view-toggle .seg-icon:last-child {
    border-top-right-radius: var(--radius-sm);
    border-bottom-right-radius: var(--radius-sm);
    border-left: none;
  }

  .state { text-align: center; padding: 60px 16px; color: var(--text-3); display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .state.empty .empty-icon { font-size: 64px; color: var(--accent); opacity: 0.6; }
  .state h2 { color: var(--text-1); margin: 12px 0 0; font-size: 20px; }
  .state.error { color: var(--error, #f87171); }
  .spin { font-size: 32px; animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Pantry card grid (the main local view) ────────────────────────
     `auto-fill` keeps cards a fixed minimum width and lets them flow
     into as many columns as the viewport allows: 1 col mobile, 2 col
     tablet, 3-5 col desktop. */
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
  }
  /* List mode — dense horizontal-row layout at every viewport. A
     thumbnail (72px desktop / 64px mobile) on the left, name + brand
     + meta stacked on the right. Grid mode keeps the vertical cards. */
  .card-grid.list {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .card-grid.list .pcard {
    flex-direction: row;
    align-items: center;
    min-height: 72px;
  }
  .card-grid.list .pcard:hover { transform: none; box-shadow: none; }
  .card-grid.list .pcard-photo {
    width: 72px; height: 72px;
    aspect-ratio: 1 / 1;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
  }
  .card-grid.list .pcard-photo .photo-stub { font-size: 30px; }
  .card-grid.list .photo-stock {
    top: 4px; right: 4px;
    width: 22px; height: 22px;
  }
  .card-grid.list .photo-stock .material-symbols-rounded { font-size: 13px; }
  .card-grid.list .pcard-body { padding: 10px 14px; gap: 3px; }
  .card-grid.list .pcard-name { font-size: 15px; -webkit-line-clamp: 1; }
  .card-grid.list .pcard-brand { font-size: 12px; }
  .card-grid.list .pcard-meta { margin-top: 3px; gap: 6px; }

  .section-heading {
    display: flex; align-items: center; gap: 8px;
    margin: 18px 0 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .section-heading:first-child { margin-top: 4px; }
  .section-heading .material-symbols-rounded {
    font-size: 16px; color: var(--accent);
  }
  .section-count {
    background: var(--surface-2);
    color: var(--text-3);
    border-radius: var(--radius-full, 99px);
    padding: 1px 8px;
    font-weight: 700;
    font-size: 10px;
  }

  .pcard {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    cursor: pointer;
    display: flex; flex-direction: column;
    transition: transform var(--dur-fast), border-color var(--dur-fast),
                box-shadow var(--dur-fast), opacity var(--dur-fast);
    -webkit-tap-highlight-color: transparent;
    -webkit-touch-callout: none;
    user-select: none;
  }
  .pcard:hover {
    border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
    box-shadow: 0 4px 16px rgba(0,0,0,0.18);
    transform: translateY(-1px);
  }
  .pcard:active { transform: scale(0.99); }

  /* Skeleton loaders for both grid + list view. Same shimmer pulse
     as Recipes; sized to match the card aspect ratio so the layout
     stays stable while the fetch is in flight. */
  .skeleton-grid { pointer-events: none; }
  .skel-pcard {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .skel-photo {
    width: 100%;
    aspect-ratio: 4 / 3;
    background: var(--surface-2);
  }
  .skel-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; }
  .skel-line {
    height: 12px;
    border-radius: 6px;
    background: var(--surface-2);
  }
  .skel-line.w70 { width: 70%; }
  .skel-line.w40 { width: 40%; }
  .skel-photo,
  .skel-line { animation: skel-pulse 1.4s ease-in-out infinite; }
  @keyframes skel-pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
  }
  /* List-mode skeletons collapse photo into a 64px square, body
     becomes a single inline row — mirrors the real list-view
     layout so users don't see a structure shift on data arrival. */
  .skeleton-grid.list .skel-pcard { flex-direction: row; align-items: stretch; }
  .skeleton-grid.list .skel-photo {
    flex: 0 0 64px;
    width: 64px;
    height: 64px;
    aspect-ratio: 1 / 1;
    border-right: 1px solid var(--border);
  }
  .skeleton-grid.list .skel-body { padding: 12px; flex-direction: row; gap: 12px; align-items: center; }
  .pcard:not(.in-stock) { opacity: 0.55; }
  .pcard.selected {
    opacity: 1;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-dim) inset;
  }

  .pcard-photo {
    position: relative;
    width: 100%;
    aspect-ratio: 4 / 3;
    background: var(--surface-2);
    overflow: hidden;
  }
  .pcard-photo img {
    width: 100%; height: 100%;
    object-fit: cover; display: block;
  }
  .pcard-photo .photo-stub {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 42px; color: var(--text-3); opacity: 0.4;
  }

  /* Stock pill in the card corner. Acts as the inline quick-toggle.
     Plus + on Add (out of stock); checkmark + accent on In stock. */
  .photo-stock {
    position: absolute; top: 8px; right: 8px;
    width: 30px; height: 30px;
    border-radius: 50%;
    background: rgba(0,0,0,0.55);
    color: #fff;
    border: none;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    transition: background var(--dur-fast), transform var(--dur-fast);
  }
  .photo-stock:hover { transform: scale(1.05); }
  .photo-stock .material-symbols-rounded { font-size: 18px; }
  .photo-stock.on {
    background: var(--accent);
    color: var(--accent-text, #fff);
  }

  .pcard-body {
    padding: 10px 12px 12px;
    display: flex; flex-direction: column; gap: 4px;
    flex: 1; min-width: 0;
  }
  .pcard-name {
    font-size: 14px; font-weight: 600; color: var(--text-1);
    line-height: 1.3;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .pcard-brand {
    font-size: 12px; color: var(--text-3);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* Subtitle shown when a search matched only variant-specific tokens
     (a brand the user typed) so a variant surfaced as its own top-
     level card. Keeps the parent-of relationship visible without
     needing to also render the parent card. */
  .pcard-variant-of {
    font-size: 11px; color: var(--text-3);
    font-style: italic;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    margin-top: 1px;
  }
  .pcard-meta {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    margin-top: 4px;
  }
  .pcard-qty {
    font-size: 12px; font-weight: 600; color: var(--accent);
    background: var(--accent-dim);
    padding: 2px 8px;
    border-radius: var(--radius-full, 99px);
  }
  .pcard-pill {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--surface-2); color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-full, 99px);
    padding: 2px 8px; font-size: 11px; font-weight: 600;
  }
  .pcard-pill .material-symbols-rounded { font-size: 12px; color: var(--accent); }
  /* Usage pill — accent-tinted, same family as the category pill. */
  .pcard-pill.usage-pill {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }
  .pcard-pill.usage-pill .material-symbols-rounded { color: var(--accent); }

  /* Generic + variant rendering (Issue #4) */
  .pcard.generic { position: relative; }
  .pcard-expand {
    position: absolute; top: 8px; right: 8px;
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text-2);
    width: 28px; height: 28px;
    border-radius: 999px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    transition: transform var(--dur-fast), border-color var(--dur-fast);
  }
  .pcard-expand:hover { border-color: var(--accent); color: var(--text-1); }
  .pcard-expand.open { background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  .pcard-expand .material-symbols-rounded { font-size: 18px; }
  /* Single icon, rotates on expand for a smooth open/close instead of
     swapping between two glyphs (which jumped). */
  .chevron-icon {
    transition: transform 0.24s cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .chevron-icon.up { transform: rotate(180deg); }
  .pcard-pill.variants-pill {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
  }
  .pcard.variant-card {
    margin-left: 16px;
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--accent) 4%, var(--surface-1));
    /* CSS-only entrance — plays on every mount. Reliable across
       WebViews where Svelte's fly transition may or may not fire due
       to grid layout containment / reduced-motion / etc. --variant-
       stagger is a per-card delay set inline based on the each-block
       index so cards cascade in one after another. */
    animation: variant-in 300ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
    animation-delay: var(--variant-stagger, 0ms);
  }
  /* Manual exit: toggleExpand sets .collapsing on every variant card
     for _VARIANT_EXIT_MS ms before actually removing them, so this
     reverse keyframe has time to play. */
  .pcard.variant-card.collapsing {
    animation: variant-out 220ms cubic-bezier(0.55, 0, 0.75, 0.1) forwards;
    animation-delay: 0ms;
  }
  @keyframes variant-in {
    from { transform: translateY(-24px); opacity: 0; }
    to   { transform: translateY(0);     opacity: 1; }
  }
  @keyframes variant-out {
    from { transform: translateY(0);     opacity: 1; }
    to   { transform: translateY(-20px); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .pcard.variant-card,
    .pcard.variant-card.collapsing { animation: none; }
  }
  .card-grid.list .pcard.variant-card { margin-left: 24px; }

  /* Variant feature announcement banner (Issue #4 commit 4) */
  .variant-banner {
    display: flex; align-items: flex-start; gap: 12px;
    margin: 12px 0;
    padding: 12px 14px;
    background: color-mix(in srgb, var(--accent) 10%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
    border-radius: var(--radius-md);
  }
  .variant-banner-icon { color: var(--accent); font-size: 24px; }
  .variant-banner-body { flex: 1; min-width: 0; }
  .variant-banner-title {
    font-weight: 700; color: var(--text-1); font-size: 14px;
    margin-bottom: 2px;
  }
  .variant-banner-desc {
    margin: 0;
    color: var(--text-2);
    font-size: 12px;
    line-height: 1.5;
  }
  .variant-banner-close {
    background: transparent; border: none;
    color: var(--text-3); cursor: pointer;
    padding: 0; line-height: 1;
  }
  .variant-banner-close:hover { color: var(--text-1); }
  .variant-banner-close .material-symbols-rounded { font-size: 20px; }

  /* Expiry pill on pantry cards (Issue #9) */
  .pcard-pill.expiry-pill {
    background: color-mix(in srgb, var(--warning, #f59e0b) 18%, transparent);
    color: var(--warning, #f59e0b);
  }
  .pcard-pill.expiry-pill .material-symbols-rounded { color: var(--warning, #f59e0b); }
  .pcard-pill.expiry-pill.past {
    background: color-mix(in srgb, var(--error, #f87171) 14%, transparent);
    color: var(--error, #f87171);
  }
  .pcard-pill.expiry-pill.past .material-symbols-rounded { color: var(--error, #f87171); }

  /* ── Phone layout: flip the card to a compact horizontal row ───────
     On a phone the 4:3 photo + stacked body makes each card 180px+
     tall, so you only see 3-4 items per screen. Phones get the same
     card component but with a tiny square thumb on the left and the
     info on the right — back to ~7-8 items per screen. */
  @media (max-width: 640px) {
    /* Grid mode on mobile: two columns of vertical cards (image on top,
       name + brand below) — like the Clabber Girl reference card. */
    .card-grid {
      gap: 8px;
      grid-template-columns: repeat(2, 1fr);
    }
    .pcard:hover { transform: none; box-shadow: none; }
    .section-heading { margin: 14px 0 6px; }

    /* Mobile-only tweaks layered on top of the desktop list rules:
       smaller thumbnail (64 vs 72), tighter typography. */
    .card-grid.list .pcard { min-height: 64px; }
    .card-grid.list .pcard-photo { width: 64px; height: 64px; }
    .card-grid.list .pcard-photo .photo-stub { font-size: 28px; }
    .card-grid.list .pcard-body { padding: 8px 10px; gap: 2px; }
    .card-grid.list .pcard-name { font-size: 14px; }
    .card-grid.list .pcard-brand { font-size: 11px; }
    .card-grid.list .pcard-meta { margin-top: 2px; gap: 4px; }
    .card-grid.list .pcard-qty,
    .card-grid.list .pcard-pill { font-size: 11px; padding: 1px 6px; }

    /* Skeleton list-mode mirror so layout doesn't pop on data arrival */
    .skeleton-grid.list .skel-photo { border-right: 1px solid var(--border); }
  }

  /* External-search results below the grid keep the dense list look
     since they're a separate context (browse-and-add). */
  .items { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
  .item {
    display: flex; align-items: center; gap: 10px;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 10px 12px;
    cursor: pointer;
    transition: opacity var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
    -webkit-tap-highlight-color: transparent;
    -webkit-touch-callout: none;
    user-select: none;
  }
  .item:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
  .item:active { background: var(--surface-2); }
  /* .in-stock only applies to local pantry rows — external OFF/USDA search
     results share the .item class but never get .in-stock (they aren't in
     your pantry), so exclude .ext-item to keep search results at full
     opacity instead of reading as "out of stock". */
  .item:not(.in-stock):not(.ext-item) { opacity: 0.6; }
  .item-name { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .cat-pill {
    display: inline-flex; align-items: center; gap: 3px;
    background: var(--surface-2); color: var(--text-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-full, 99px);
    padding: 1px 7px; font-size: 11px; font-weight: 600;
  }
  .cat-pill .material-symbols-rounded { font-size: 13px; color: var(--accent); }
  .category-chips {
    margin-top: 4px;
    overflow-x: auto;
    flex-wrap: nowrap;
    -webkit-overflow-scrolling: touch;
  }
  .category-chips::-webkit-scrollbar { display: none; }
  .category-chips .seg { flex-shrink: 0; }

  /* Advanced (nutrition) section in the edit modal */
  .adv-toggle {
    background: none; border: none; cursor: pointer;
    color: var(--text-1); font-size: 13px; font-weight: 600;
    padding: 8px 0; display: flex; align-items: center; gap: 6px;
    text-align: left;
  }
  .adv-toggle .chevron {
    font-size: 18px; color: var(--text-3);
    transition: transform var(--dur-base);
  }
  .adv-toggle .chevron.rotated { transform: rotate(90deg); }
  .adv-hint { color: var(--text-3); font-weight: 400; font-size: 11px; }
  .adv-body {
    display: flex; flex-direction: column; gap: 12px;
    padding: 6px 0 4px;
  }
  .adv-blurb { font-size: 12px; color: var(--text-3); margin: 0; line-height: 1.5; }
  .nutrition-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }
  .nutrition-cell { display: flex; flex-direction: column; gap: 4px; }
  .nutrition-label { font-size: 11px; font-weight: 600; color: var(--text-3); }
  .nutrition-input { padding: 7px 10px; font-size: 13px; }

  /* Plain select used for category dropdown */
  .select-wrap { position: relative; }
  .select {
    width: 100%; box-sizing: border-box;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px;
    color: var(--text-1); font-size: 14px; font-family: inherit;
    appearance: none; -webkit-appearance: none; cursor: pointer;
  }
  .select:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }

  .item.selected {
    opacity: 1;
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--surface-1));
  }


  .stock-toggle {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3); padding: 0; line-height: 0; flex-shrink: 0;
    transition: color var(--dur-fast);
  }
  .stock-toggle .material-symbols-rounded { font-size: 26px; }
  .item.in-stock .stock-toggle { color: var(--accent); }

  .item-thumb {
    width: 36px; height: 36px;
    object-fit: cover;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }
  .item-body { flex: 1; min-width: 0; }
  .item-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .item-qty { font-size: 12px; color: var(--accent); font-weight: 600; margin-top: 2px; }
  .item-notes { font-size: 12px; color: var(--text-3); margin-top: 2px; }

  .item-actions { display: flex; gap: 2px; flex-shrink: 0; }
  .btn-icon {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3); width: 34px; height: 34px;
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm);
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .btn-icon:hover { color: var(--text-1); background: var(--surface-2); }
  .btn-icon.danger:hover { color: var(--error, #f87171); }
  .btn-icon.small .material-symbols-rounded { font-size: 18px; }

  /* Modal editor */
  .modal-backdrop {
    position: fixed; inset: 0;
    background: var(--overlay, rgba(0, 0, 0, 0.55));
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    z-index: 130; display: flex; align-items: center; justify-content: center;
    padding: 16px;
  }
  .modal {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); width: 100%; max-width: 460px;
    max-height: calc(100vh - 32px); overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0,0,0,0.4);
  }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px; border-bottom: 1px solid var(--border);
  }
  .modal-header h2 { margin: 0; font-size: 17px; font-weight: 700; color: var(--text-1); }
  .modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .modal-footer {
    display: flex; gap: 8px; justify-content: flex-end;
    padding: 12px 16px; border-top: 1px solid var(--border);
  }

  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .field-row { display: flex; gap: 10px; }
  .field-row .flex { flex: 1; min-width: 0; }
  .check-field { flex-direction: row; align-items: center; gap: 8px; }
  .check-field input { width: 18px; height: 18px; accent-color: var(--accent); }
  .input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px; color: var(--text-1);
    font-size: 14px; font-family: inherit; width: 100%; box-sizing: border-box;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  textarea.input { resize: vertical; min-height: 50px; }
</style>
