<script>
  import { onMount, tick } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { fade } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { formatDuration } from '../lib/duration.js';
  import { NtApi } from '../lib/api.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { pageBanners, bannerStyle, aiEnabled, aiKeyVerified, recipesSort, mixSharedIntoRecipes } from '../stores/settings.js';
  import ActionSheet from '../components/ui/ActionSheet.svelte';
  import ImportFromFileDialog from '../components/recipe/ImportFromFileDialog.svelte';
  import CookbookImportDialog from '../components/recipe/CookbookImportDialog.svelte';
  import ImportUrlDialog from '../components/recipe/ImportUrlDialog.svelte';
  import { relativeTime } from '../lib/relative-time.js';
  import { longpress } from '../lib/long-press.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import { buildRecipeCardPages, buildRecipeShareText } from '../lib/recipe-card.js';
  import { svgToPngBlob, shareBlobs } from '../lib/shopping-card.js';
  import { isNative, getServerUrl } from '../lib/platform.js';

  let createSheetOpen = false;
  // Measured page-header height — exposed as --header-h on page-shell so
  // sticky sub-bars can pin below it instead of sliding underneath.
  let headerH = 0;
  // The "Paste or upload" option opens a dialog that accepts BOTH a file
  // upload (.json, .html, Mealie/Tandoor/Paprika exports) AND a paste
  // textarea — parser auto-detects JSON vs HTML/schema.org/Recipe.
  // "Import from File" handles images (Trace AI vision) plus PDF / RTF /
  // TXT / MD (server-side text extraction + heuristic parse + optional
  // AI fallback for low-confidence inputs). Always visible; AI-dependent
  // paths inside the dialog gate themselves on the runtime AI config.
  $: createActions = [
    { label: 'Create Manually',          icon: 'edit_note',          value: 'manual' },
    { label: 'Import from URL',          icon: 'link',               value: 'url' },
    { label: 'Import from File', icon: 'upload_file', value: 'file' },
    { label: 'Import Cookbook',  icon: 'menu_book',   value: 'cookbook' },
    { label: 'Import from JSON/HTML',    icon: 'content_paste',      value: 'paste' },
  ];

  // Track whether the AI provider is env-locked. Photo import is
  // disabled in that mode because the server proxy doesn't relay
  // tool calls (no way to land a created recipe).
  let aiEnvLocked = false;
  onMount(async () => {
    try {
      const res = await fetch('/api/app-config', { credentials: 'include' });
      if (res.ok) { const d = await res.json(); aiEnvLocked = !!d?.envLocks?.ai; }
    } catch {}
  });

  let fileImportOpen = false;
  let cookbookImportOpen = false;
  function onCreateAction(e) {
    const v = e.detail?.value;
    if (v === 'manual') {
      push('/recipes/edit');
    } else if (v === 'url') {
      urlImportOpen = true;
    } else if (v === 'paste') {
      pasteImportOpen = true;
    } else if (v === 'file') {
      fileImportOpen = true;
    } else if (v === 'cookbook') {
      cookbookImportOpen = true;
    }
  }

  // ── URL import ─────────────────────────────────────────────────────────
  // The unified ImportUrlDialog owns the textarea, options, and either-or
  // routing (1 URL = direct save, N URLs = picker grid). We only hold the
  // open flag here.
  let urlImportOpen = false;

  // ── Paste / Upload import ──────────────────────────────────────────────
  let pasteImportOpen = false;
  let pasteText = '';
  let pasteFile = null;
  let pasteFileInput;
  let pasteBusy = false;
  let pasteAddToPantry = false;
  let pasteApplyTags = false;
  let pasteImportCategories = true;
  function onPasteFileChange(e) {
    const f = e.target.files?.[0];
    if (f) { pasteFile = f; pasteText = ''; }
  }
  function clearPasteFile() {
    pasteFile = null;
    if (pasteFileInput) pasteFileInput.value = '';
  }
  async function doPasteImport() {
    if (!pasteFile && !pasteText.trim()) {
      showError('Paste a recipe or pick a file first');
      return;
    }
    pasteBusy = true;
    try {
      const result = await NtApi.importRecipe({
        text: pasteFile ? undefined : pasteText.trim(),
        file: pasteFile || undefined,
        addToPantry: pasteAddToPantry,
        applyTags: pasteApplyTags,
        importCategories: pasteImportCategories,
      });
      pasteImportOpen = false;
      pasteText = '';
      clearPasteFile();
      if (result?.recipes && Array.isArray(result.recipes)) {
        showSuccess(`Imported ${result.count} recipes`);
        await load();
      } else {
        const created = result;
        const stepCount = (created.steps || []).reduce((n, s) => n + (s?.text ? 1 : 0), 0);
        if (stepCount === 0) {
          showError("Imported — but the source had no cooking steps. Open it to add them manually.");
        } else {
          showSuccess('Recipe imported');
        }
        push(`/recipes/${created.id}`);
      }
    } catch (e) {
      showError(e.message || 'Import failed');
    } finally {
      pasteBusy = false;
    }
  }
  // URL import logic now lives inside ImportUrlDialog.

  // ── Long-press card actions ────────────────────────────────────────────
  // Share Link / public-link entries need a server to mint and host
  // the /r/<token> URL — hidden entirely in local-only Android mode.
  let cardSheetOpen = false;
  let cardSheetTarget = null;
  $: _canShareLink = !isNative || !!getServerUrl();
  $: cardActions = cardSheetTarget ? [
    { label: 'Open Recipe',    icon: 'open_in_new',   value: 'open' },
    { label: cardSheetTarget.favorite ? 'Remove from Favorites' : 'Add to Favorites',
      icon: cardSheetTarget.favorite ? 'heart_minus' : 'favorite_border',
      value: 'favorite' },
    { label: 'Add to Cookbook', icon: 'auto_stories',  value: 'cookbook' },
    ...(_canShareLink ? [{
      label: cardSheetTarget.share_token ? 'Manage Share Link' : 'Create Share Link',
      icon: 'link', value: 'sharelink',
    }] : []),
    { label: 'Plan a Cook',    icon: 'event_available', value: 'plan' },
    { label: 'Add to Shopping List', icon: 'add_shopping_cart', value: 'shop' },
    { label: 'Duplicate',      icon: 'content_copy',  value: 'duplicate' },
    { label: 'Share Card',     icon: 'share',         value: 'share' },
    { label: 'Select Multiple', icon: 'check_circle', value: 'select-multi' },
    { label: 'Delete',         icon: 'delete',        value: 'delete', danger: true },
  ] : [];

  // ── Multi-select / bulk delete ──────────────────────────────────────────
  // Long-press a card → action sheet → "Select Multiple" enters this mode
  // with that one recipe pre-selected. Tapping the toolbar Select button
  // enters with no recipes selected. Tapping cards toggles selection
  // instead of navigating; long-press also toggles. Cancel exits cleanly.
  let selectMode = false;
  let selectedIds = new Set();
  function enterSelectMode(initialId = null) {
    selectMode = true;
    selectedIds = initialId != null ? new Set([initialId]) : new Set();
  }
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
  async function bulkDeleteSelected() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const ok = await confirmDialog({
      title: `Delete ${ids.length} ${ids.length === 1 ? 'recipe' : 'recipes'}?`,
      message: 'This cannot be undone.',
      confirmText: 'Delete',
      dangerous: true,
    });
    if (!ok) return;
    let success = 0, failed = 0;
    for (const id of ids) {
      try { await NtApi.deleteRecipe(id); success++; }
      catch { failed++; }
    }
    recipes = recipes.filter(r => !selectedIds.has(r.id));
    exitSelectMode();
    if (failed === 0) showSuccess(`Deleted ${success}`);
    else showError(`Deleted ${success}, ${failed} failed`);
  }

  // Add-to-Cookbook dialog state. Triggered from the long-press menu
  // OR from RecipeView in the future. Multi-select against the user's
  // cookbook list, pre-checked for cookbooks the recipe is already in.
  let cookbookDialogOpen = false;
  let cookbookDialogRecipe = null;
  let cookbookDialogSelected = new Set();
  let cookbookDialogPreexisting = new Set();
  async function openCookbookDialog(recipe) {
    cookbookDialogRecipe = recipe;
    cookbookDialogOpen = true;
    cookbookDialogSelected = new Set();
    cookbookDialogPreexisting = new Set();
    try {
      const inAlready = await NtApi.getCookbooksForRecipe(recipe.id);
      const ids = new Set((inAlready || []).map(c => c.id));
      cookbookDialogPreexisting = ids;
      cookbookDialogSelected = new Set(ids);
    } catch { /* non-fatal — dialog still works */ }
  }
  function toggleCookbookSelected(id) {
    const next = new Set(cookbookDialogSelected);
    if (next.has(id)) next.delete(id); else next.add(id);
    cookbookDialogSelected = next;
  }

  // ── Bulk: add the selected recipes to one or more cookbooks ───────
  // Distinct from the single-recipe dialog above. Pure-add (no remove
  // path) — the user just ticks which cookbooks should receive the
  // batch. Pre-existing memberships stay; this is "Add to" not "Move
  // to" so users don't accidentally lose existing assignments.
  let bulkCookbookOpen = false;
  let bulkCookbookSelected = new Set();
  let bulkCookbookBusy = false;
  function openBulkCookbookDialog() {
    if (selectedIds.size === 0) return;
    bulkCookbookSelected = new Set();
    bulkCookbookOpen = true;
  }
  function toggleBulkCookbookSelected(id) {
    const next = new Set(bulkCookbookSelected);
    if (next.has(id)) next.delete(id); else next.add(id);
    bulkCookbookSelected = next;
  }
  async function confirmBulkCookbook() {
    if (bulkCookbookSelected.size === 0) {
      bulkCookbookOpen = false;
      return;
    }
    const recipeIds = [...selectedIds];
    const cbIds = [...bulkCookbookSelected];
    bulkCookbookBusy = true;
    try {
      let totalAdded = 0;
      for (const cbId of cbIds) {
        const res = await NtApi.addRecipesToCookbook(cbId, recipeIds);
        totalAdded += res?.added ?? 0;
      }
      try { cookbooks = await NtApi.getCookbooks(); } catch {}
      showSuccess(`Added ${recipeIds.length} ${recipeIds.length === 1 ? 'recipe' : 'recipes'} to ${cbIds.length} ${cbIds.length === 1 ? 'cookbook' : 'cookbooks'}`);
      bulkCookbookOpen = false;
      selectMode = false;
      selectedIds = new Set();
    } catch (e) {
      showError(e.message || 'Could not add to cookbook');
    } finally {
      bulkCookbookBusy = false;
    }
  }
  // Share-link dialog state.
  let shareDialogOpen = false;
  let shareDialogRecipe = null;
  let shareDialogToken = null;
  let shareDialogBusy = false;

  // Cookbook share dialog — analogous to the recipe share dialog but
  // scoped to cookbooks. Two sections: Share with Users (per-user
  // grants) and Share with Kitchen (fan out to all members). No
  // public-link section — cookbook sharing is member-scoped only.
  let cookbookShareDialogOpen = false;
  let cookbookShareTarget = null;         // the cookbook being shared
  let cookbookSharePeers = [];            // users I can share with
  let cookbookShareGrants = new Set();    // user_ids currently granted
  let cookbookShareKitchens = [];         // my kitchens
  let cookbookShareKitchenBusyId = null;
  let cookbookShareBusy = false;
  // Loaded lazily alongside `cookbooks` so the Cookbooks tab can
  // show cookbooks that others shared with me, badged like Recipes'
  // Shared tab.
  let sharedCookbooks = [];

  async function openCookbookShareDialog(cb) {
    cookbookShareTarget = cb;
    cookbookShareDialogOpen = true;
    cookbookSharePeers = [];
    cookbookShareGrants = new Set();
    cookbookShareKitchens = [];
    cookbookShareKitchenBusyId = null;
    const [peers, grants, kitchens] = await Promise.all([
      NtApi.getSharePeers().catch(() => []),
      NtApi.getCookbookShares(cb.id).catch(() => []),
      NtApi.getKitchens().catch(() => []),
    ]);
    cookbookSharePeers = peers || [];
    cookbookShareGrants = new Set((grants || []).map(g => g.user_id));
    cookbookShareKitchens = kitchens || [];
  }
  async function toggleCookbookShareUser(userId) {
    if (!cookbookShareTarget || cookbookShareBusy) return;
    cookbookShareBusy = true;
    const isGranted = cookbookShareGrants.has(userId);
    try {
      if (isGranted) {
        await NtApi.unshareCookbookWithUser(cookbookShareTarget.id, userId);
        const next = new Set(cookbookShareGrants); next.delete(userId);
        cookbookShareGrants = next;
      } else {
        await NtApi.shareCookbookWithUsers(cookbookShareTarget.id, [userId]);
        const next = new Set(cookbookShareGrants); next.add(userId);
        cookbookShareGrants = next;
      }
    } catch (e) { showError(e.message || 'Could not update share'); }
    finally { cookbookShareBusy = false; }
  }
  async function shareCookbookWithKitchen(kitchen) {
    if (!cookbookShareTarget) return;
    cookbookShareKitchenBusyId = kitchen.id;
    try {
      const res = await NtApi.shareCookbookWithKitchen(kitchen.id, cookbookShareTarget.id);
      const fresh = await NtApi.getCookbookShares(cookbookShareTarget.id).catch(() => []);
      cookbookShareGrants = new Set((fresh || []).map(g => g.user_id));
      const added = res?.added ?? 0;
      if (added > 0) showSuccess(`Shared with ${added} ${added === 1 ? 'member' : 'members'} of ${kitchen.name}`);
      else showSuccess(`Already shared with everyone in ${kitchen.name}`);
    } catch (e) { showError(e.message || 'Could not share'); }
    finally { cookbookShareKitchenBusyId = null; }
  }
  function closeCookbookShareDialog() {
    cookbookShareDialogOpen = false;
    cookbookShareTarget = null;
  }
  // Per-user share grants (separate from public link). Loaded alongside
  // the dialog open so the user sees who already has access.
  let sharePeers = [];
  let shareGrants = new Set(); // user_ids currently granted
  let shareKitchens = [];      // [{ id, name, member_count, role, ... }]
  let shareKitchenBusyId = null;

  async function shareWithKitchen(kitchen) {
    if (!shareDialogRecipe) return;
    shareKitchenBusyId = kitchen.id;
    try {
      const res = await NtApi.shareRecipeWithKitchen(kitchen.id, shareDialogRecipe.id);
      // Bring per-user grants display in sync — kitchen-share fans out.
      const fresh = await NtApi.getRecipeShares(shareDialogRecipe.id).catch(() => []);
      shareGrants = new Set((fresh || []).map(g => g.user_id));
      const added = res?.added ?? 0;
      if (added > 0) showSuccess(`Shared with ${added} ${added === 1 ? 'member' : 'members'} of ${kitchen.name}`);
      else showSuccess(`Already shared with everyone in ${kitchen.name}`);
    } catch (e) { showError(e.message || 'Could not share'); }
    finally { shareKitchenBusyId = null; }
  }
  function shareLinkUrl(token) {
    if (typeof window === 'undefined' || !token) return '';
    return `${window.location.origin}/#/r/${token}`;
  }
  async function openShareDialog(recipe) {
    shareDialogRecipe = recipe;
    shareDialogOpen = true;
    shareDialogToken = recipe.share_token || null;
    sharePeers = [];
    shareGrants = new Set();
    shareKitchens = [];
    shareKitchenBusyId = null;
    // Load existing grants + peer list + kitchens in parallel.
    Promise.all([
      NtApi.getSharePeers().catch(() => []),
      NtApi.getRecipeShares(recipe.id).catch(() => []),
      NtApi.getKitchens().catch(() => []),
    ]).then(([peers, grants, kitchens]) => {
      sharePeers = peers || [];
      shareGrants = new Set((grants || []).map(g => g.user_id));
      shareKitchens = kitchens || [];
    });
    if (!shareDialogToken) {
      // No token yet — don't auto-mint anymore. The dialog now has both
      // a "Public Link" and a "Share with Users" section, so minting
      // happens on user action via createPublicLink().
    }
  }
  async function createPublicLink() {
    if (!shareDialogRecipe) return;
    shareDialogBusy = true;
    try {
      const res = await NtApi.mintRecipeShareToken(shareDialogRecipe.id);
      shareDialogToken = res.share_token;
      recipes = recipes.map(x => x.id === shareDialogRecipe.id ? { ...x, share_token: res.share_token } : x);
    } catch (e) {
      showError(e.message || 'Could not create link');
    } finally {
      shareDialogBusy = false;
    }
  }
  async function togglePeerGrant(peer) {
    if (!shareDialogRecipe) return;
    const had = shareGrants.has(peer.id);
    try {
      if (had) {
        await NtApi.unshareRecipeWithUser(shareDialogRecipe.id, peer.id);
        const next = new Set(shareGrants); next.delete(peer.id); shareGrants = next;
      } else {
        await NtApi.shareRecipeWithUsers(shareDialogRecipe.id, [peer.id]);
        const next = new Set(shareGrants); next.add(peer.id); shareGrants = next;
      }
    } catch (e) { showError(e.message || 'Could not update share'); }
  }
  async function rotateShareLink() {
    if (!shareDialogRecipe) return;
    shareDialogBusy = true;
    try {
      const res = await NtApi.mintRecipeShareToken(shareDialogRecipe.id);
      shareDialogToken = res.share_token;
      recipes = recipes.map(x => x.id === shareDialogRecipe.id ? { ...x, share_token: res.share_token } : x);
      showSuccess('New link generated');
    } catch (e) {
      showError(e.message || 'Could not rotate');
    } finally {
      shareDialogBusy = false;
    }
  }
  async function revokeShareLink() {
    if (!shareDialogRecipe) return;
    const ok = await confirmDialog({
      title: 'Revoke share link?',
      message: 'The link will stop working immediately. You can always create a new one later.',
      confirmText: 'Revoke',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.revokeRecipeShareToken(shareDialogRecipe.id);
      recipes = recipes.map(x => x.id === shareDialogRecipe.id ? { ...x, share_token: null } : x);
      shareDialogToken = null;
      shareDialogOpen = false;
      showSuccess('Link revoked');
    } catch (e) {
      showError(e.message || 'Could not revoke');
    }
  }
  async function copyShareLink() {
    const url = shareLinkUrl(shareDialogToken);
    if (!url) return;
    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(url);
        showSuccess('Copied to clipboard');
      } catch { showError('Copy failed'); }
    } else {
      showError('Clipboard not available');
    }
  }

  async function confirmCookbookDialog() {
    if (!cookbookDialogRecipe) return;
    // Diff: cookbooks newly checked = add, newly unchecked = remove.
    const adds = [...cookbookDialogSelected].filter(id => !cookbookDialogPreexisting.has(id));
    const dels = [...cookbookDialogPreexisting].filter(id => !cookbookDialogSelected.has(id));
    try {
      for (const cbId of adds) {
        await NtApi.addRecipesToCookbook(cbId, [cookbookDialogRecipe.id]);
      }
      for (const cbId of dels) {
        await NtApi.removeRecipeFromCookbook(cbId, cookbookDialogRecipe.id);
      }
      // Refresh cookbook counts.
      try { cookbooks = await NtApi.getCookbooks(); } catch {}
      const total = adds.length + dels.length;
      if (total > 0) showSuccess(`Updated ${total} cookbook${total === 1 ? '' : 's'}`);
      cookbookDialogOpen = false;
      cookbookDialogRecipe = null;
    } catch (e) {
      showError(e.message || 'Could not update');
    }
  }

  function openCardMenu(r) {
    cardSheetTarget = r;
    cardSheetOpen = true;
  }

  async function onCardAction(e) {
    const v = e.detail?.value;
    const r = cardSheetTarget;
    if (!r) return;
    cardSheetTarget = null;
    if (v === 'open')      push(`/recipes/${r.id}`);
    else if (v === 'select-multi') enterSelectMode(r.id);
    else if (v === 'cookbook') {
      openCookbookDialog(r);
    }
    else if (v === 'sharelink') {
      openShareDialog(r);
    }
    else if (v === 'favorite') {
      try {
        const updated = await NtApi.updateRecipe(r.id, { ...r, favorite: !r.favorite });
        recipes = recipes.map(x => x.id === r.id ? updated : x);
      } catch (err) { showError(err.message || 'Update failed'); }
    }
    else if (v === 'plan')     push(`/diary?plan=${r.id}`);
    else if (v === 'shop') {
      try {
        const result = await NtApi.shopFromRecipe(r.id, { only_missing: true });
        showSuccess(`Added ${result.added} item${result.added === 1 ? '' : 's'} to shopping list`);
      } catch (err) { showError(err.message || 'Could not add'); }
    }
    else if (v === 'duplicate') {
      try {
        const fresh = await NtApi.getRecipe(r.id);
        const { id: _, created_at, updated_at, last_cooked_at, cook_count, created_by_username, ...rest } = fresh;
        const dup = await NtApi.createRecipe({ ...rest, name: rest.name + ' (copy)', favorite: false, rating: null });
        recipes = [dup, ...recipes];
        showSuccess('Recipe duplicated');
      } catch (err) { showError(err.message || 'Duplicate failed'); }
    }
    else if (v === 'share') {
      // Client-side PNG share. Long recipes paginate; on native
      // multi-page is stitched into one tall PNG at share time.
      showSuccess('Preparing share…');
      try {
        const full = await NtApi.getRecipe(r.id);
        const pages = await buildRecipeCardPages(full);
        const safe = (full.name || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'recipe';
        const parts = [];
        for (const pg of pages) {
          const blob = await svgToPngBlob(pg.svg, pg.width, pg.height);
          const fname = pages.length > 1
            ? `${safe}-page-${pg.pageNum}-of-${pg.totalPages}.png`
            : `${safe}.png`;
          parts.push({ blob, filename: fname });
        }
        const res = await shareBlobs(parts, full.name);
        if (res.downloaded) showSuccess(parts.length > 1 ? `Saved ${parts.length} pages` : 'Saved card');
      } catch (e) {
        showError(e.message || 'Could not share');
      }
    }
    else if (v === 'delete') {
      const ok = await confirmDialog({
        title: 'Delete recipe?',
        message: `"${r.name}" will be removed.`,
        confirmText: 'Delete',
        dangerous: true,
      });
      if (!ok) return;
      try {
        await NtApi.deleteRecipe(r.id);
        recipes = recipes.filter(x => x.id !== r.id);
        showSuccess('Deleted');
      } catch (err) { showError(err.message || 'Delete failed'); }
    }
  }

  let recipes = [];
  let cookbooks = [];
  let sharedRecipes = [];
  let loading = true;
  let loadError = null;
  let query = '';

  // View mode toggle: 'recipes' / 'cookbooks' / 'shared'. Reflected in
  // the URL via `?view=...` so deep-links and back-navigation land in
  // the right tab. The 'shared' segment only renders when the user has
  // at least one recipe shared with them.
  let viewMode = 'recipes';

  // View-toggle pill geometry — measured from the active button's
  // actual layout so the pill sizes correctly even when buttons have
  // different widths (Recipes vs Cookbooks vs Shared have varying
  // text + count badges). Re-measured on viewMode change, on mount,
  // and on resize. CSS animates left/width via transitions.
  let vtContainer = null;
  // Explicit refs — Shared is rendered conditionally between Recipes
  // and Cookbooks so an integer-indexed array would shift depending
  // on whether sharedRecipes.length > 0. Named refs stay stable.
  let vtBtnRecipes = null;
  let vtBtnShared = null;
  let vtBtnCookbooks = null;
  let vtPillX = 0;
  let vtPillW = 0;
  function _measureVtPill() {
    if (!vtContainer) return;
    const btn = viewMode === 'shared' ? vtBtnShared
              : viewMode === 'cookbooks' ? vtBtnCookbooks
              : vtBtnRecipes;
    if (!btn) return;
    const cRect = vtContainer.getBoundingClientRect();
    const bRect = btn.getBoundingClientRect();
    vtPillX = bRect.left - cRect.left;
    vtPillW = bRect.width;
  }
  // Wait for the DOM update to flush — the toggle buttons are mounted
  // inside `{#if recipes.length || cookbooks.length || sharedRecipes.length}`
  // so on initial load the bind:this refs only populate after the
  // first reactive pass completes. tick() guarantees the bindings have
  // been applied before we measure; rAF could fire too early on cold
  // mount and leave the pill at zero width on the active "Recipes" tab.
  $: if (viewMode || sharedRecipes.length || cookbooks.length || recipes.length) {
    if (typeof window !== 'undefined') tick().then(_measureVtPill);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => tick().then(_measureVtPill));
  }

  // Category filter — driven by a clickable chip row OR a `?category=<slug>`
  // hash-query param (RecipeView's category pill links here).
  let categories = [];
  let activeCategorySlug = '';
  // Favorites toggle — first chip in the filter row. Independent of the
  // category filter (you can be filtering both Favorites + Dinner).
  let favoritesOnly = false;
  // Read ?category=<slug> from the hash query string. svelte-spa-router
  // hands us routes like #/recipes?category=dinner.
  function _readCategoryFromHash() {
    const h = typeof window !== 'undefined' ? window.location.hash : '';
    const q = h.split('?')[1] || '';
    const params = new URLSearchParams(q);
    return params.get('category') || '';
  }
  function _readViewFromHash() {
    const h = typeof window !== 'undefined' ? window.location.hash : '';
    const q = h.split('?')[1] || '';
    const params = new URLSearchParams(q);
    const v = params.get('view');
    if (v === 'cookbooks' || v === 'shared') return v;
    return 'recipes';
  }
  function _writeUrl() {
    if (typeof window === 'undefined') return;
    const base = '#/recipes';
    const params = new URLSearchParams();
    if (viewMode === 'cookbooks') params.set('view', 'cookbooks');
    if (activeCategorySlug) params.set('category', activeCategorySlug);
    const qs = params.toString();
    const next = qs ? `${base}?${qs}` : base;
    if (window.location.hash !== next && window.location.hash !== next.slice(1)) {
      window.history.replaceState(null, '', next);
    }
  }
  function setCategoryFilter(slug) {
    activeCategorySlug = slug || '';
    _writeUrl();
  }
  function setViewMode(mode) {
    viewMode = mode;
    if (mode === 'cookbooks') {
      // Drop the category filter when switching to cookbooks since it
      // doesn't apply there. Recipes view restores naturally on switch
      // back (URL state persists what it knows).
      activeCategorySlug = '';
    }
    _writeUrl();
  }

  $: filtered = (() => {
    const q = query.trim().toLowerCase();
    // Optional mix-in: when the user has "Show Shared Recipes in My
    // Main List" on, append the /shared-with-me collection to the
    // owned recipes. Cards keep their existing shared_by badge + the
    // new via-kitchen chip so ownership is still visually clear.
    let list = $mixSharedIntoRecipes ? [...recipes, ...sharedRecipes] : recipes;
    if (favoritesOnly) list = list.filter(r => r.favorite);
    if (activeCategorySlug) {
      list = list.filter(r => r.category && r.category.slug === activeCategorySlug);
    }
    if (q) {
      list = list.filter(r =>
        (r.name || '').toLowerCase().includes(q) ||
        (r.description || '').toLowerCase().includes(q) ||
        (r.tags || []).some(t => t.toLowerCase().includes(q)) ||
        (r.category?.name || '').toLowerCase().includes(q)
      );
    }
    return _applySort([...list], $recipesSort);
  })();

  // Sort modes mirror NutriTrace's foods/meals/recipes sort. The
  // default is fav-alpha — favorites float to the top, then everything
  // alphabetical. Pure alpha is available for users who want a flat list.
  function _applySort(arr, mode) {
    const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
    if (mode === 'alpha') {
      arr.sort(byName);
    } else if (mode === 'recent') {
      arr.sort((a, b) => {
        const al = a.last_cooked_at || '', bl = b.last_cooked_at || '';
        if (al && bl) return bl.localeCompare(al);
        if (al) return -1;
        if (bl) return 1;
        return byName(a, b);
      });
    } else if (mode === 'most') {
      arr.sort((a, b) => {
        const d = (b.cook_count || 0) - (a.cook_count || 0);
        return d !== 0 ? d : byName(a, b);
      });
    } else if (mode === 'newest') {
      arr.sort((a, b) => {
        const ac = a.created_at || '', bc = b.created_at || '';
        if (ac && bc) return bc.localeCompare(ac);
        return byName(a, b);
      });
    } else {
      // fav-alpha (default): favorites first, then alphabetical within each group.
      arr.sort((a, b) => {
        const af = a.favorite ? 1 : 0;
        const bf = b.favorite ? 1 : 0;
        if (af !== bf) return bf - af;
        return byName(a, b);
      });
    }
    return arr;
  }

  async function load() {
    loading = true;
    loadError = null;
    try {
      const [recipesRes, catsRes, cookbooksRes, sharedRes, sharedCbRes] = await Promise.all([
        NtApi.getRecipes(),
        NtApi.getRecipeCategories().catch(() => []),
        NtApi.getCookbooks().catch(() => []),
        NtApi.getRecipesSharedWithMe().catch(() => []),
        NtApi.getCookbooksSharedWithMe().catch(() => []),
      ]);
      recipes = recipesRes;
      categories = catsRes || [];
      cookbooks = cookbooksRes || [];
      sharedRecipes = sharedRes || [];
      sharedCookbooks = sharedCbRes || [];
      activeCategorySlug = _readCategoryFromHash();
      viewMode = _readViewFromHash();
      // Explicit re-measure after the toggle buttons render — the
      // reactive measurement above can fire while buttons are still
      // mounting (the `{#if recipes.length || ...}` gate flips true
      // and bind:this hasn't populated vtBtns yet). One more pass
      // after a tick guarantees the active pill is sized to the
      // active button on cold start.
      tick().then(() => requestAnimationFrame(_measureVtPill));
    } catch (e) {
      loadError = e.message || 'Could not load recipes';
      showError(loadError);
    } finally {
      loading = false;
    }
  }
  onMount(load);

  function totalMinutes(r) {
    if (r?.total_minutes != null) return r.total_minutes;
    return (r?.prep_minutes || 0) + (r?.cook_minutes || 0) + (r?.rest_minutes || 0);
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
      <button class="btn-icon header-action" on:click={bulkDeleteSelected} disabled={selectedIds.size === 0} aria-label="Delete selected" title="Delete selected">
        <span class="material-symbols-rounded">delete</span>
      </button>
      <button class="btn-icon header-action header-action-2" on:click={openBulkCookbookDialog} disabled={selectedIds.size === 0} aria-label="Add to Cookbook" title="Add to Cookbook">
        <span class="material-symbols-rounded">auto_stories</span>
      </button>
      <button class="btn-icon header-action header-action-3" on:click={exitSelectMode} aria-label="Cancel selection" title="Cancel">
        <span class="material-symbols-rounded">close</span>
      </button>
    {:else}
      <h1>{$_('routes.recipes.title')}</h1>
      <button class="btn-icon header-action" on:click={() => createSheetOpen = true} aria-label={$_('routes.recipes.new_recipe')} title={$_('routes.recipes.new_recipe')}>
        <span class="material-symbols-rounded">add</span>
      </button>
    {/if}
  </header>

  <ActionSheet
    bind:open={createSheetOpen}
    title="Add a Recipe"
    actions={createActions}
    on:select={onCreateAction}
  />

  <ActionSheet
    bind:open={cardSheetOpen}
    title={cardSheetTarget?.name || ''}
    actions={cardActions}
    on:select={onCardAction}
  />

  <ImportFromFileDialog bind:open={fileImportOpen} envLocked={aiEnvLocked} />
  <CookbookImportDialog bind:open={cookbookImportOpen} envLocked={aiEnvLocked} />

  {#if shareDialogOpen && shareDialogRecipe}
    <div class="cb-dialog-backdrop" on:click={() => shareDialogOpen = false}>
      <div class="cb-dialog share-dialog" on:click|stopPropagation>
        <header class="cb-dialog-head">
          <h3>Share Recipe</h3>
          <button class="btn-icon" on:click={() => shareDialogOpen = false} aria-label="Close">
            <span class="material-symbols-rounded">close</span>
          </button>
        </header>
        <p class="cb-dialog-sub">{shareDialogRecipe.name}</p>

        <!-- Section 1: Per-user grants (only relevant in multi-user mode) -->
        {#if sharePeers.length > 0}
          <section class="share-section">
            <h4 class="share-section-title">
              <span class="material-symbols-rounded">group</span>
              Share with Users
            </h4>
            <p class="share-section-hint">Picks land in their "Shared" tab. Read-only.</p>
            <ul class="peer-list">
              {#each sharePeers as p (p.id)}
                <label class="peer-row" class:on={shareGrants.has(p.id)}>
                  <input type="checkbox"
                    checked={shareGrants.has(p.id)}
                    on:change={() => togglePeerGrant(p)} />
                  <span class="peer-name">{p.name}</span>
                  {#if p.username && p.username !== p.name}
                    <span class="peer-handle">@{p.username}</span>
                  {/if}
                </label>
              {/each}
            </ul>
          </section>
        {/if}

        <!-- Section 1.5: Share with a Kitchen — fans out per-user
             grants to every member in one click. -->
        {#if shareKitchens.length > 0}
          <section class="share-section">
            <h4 class="share-section-title">
              <span class="material-symbols-rounded">cooking</span>
              Share with a Kitchen
            </h4>
            <p class="share-section-hint">Sends this recipe to every member of the Kitchen at once.</p>
            <ul class="peer-list">
              {#each shareKitchens as k (k.id)}
                <li class="peer-row">
                  <span class="material-symbols-rounded" style="font-size:18px;color:var(--accent);">cooking</span>
                  <span class="peer-name">{k.name}</span>
                  <span class="peer-handle">{k.member_count} {k.member_count === 1 ? 'member' : 'members'}</span>
                  <button class="btn btn-secondary" style="margin-left:auto;height:30px;font-size:12px"
                    on:click={() => shareWithKitchen(k)}
                    disabled={shareKitchenBusyId === k.id}>
                    {shareKitchenBusyId === k.id ? 'Sharing…' : 'Share'}
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <!-- Section 2: Public share link -->
        <section class="share-section">
          <h4 class="share-section-title">
            <span class="material-symbols-rounded">link</span>
            Public Link
          </h4>
          {#if !shareDialogToken}
            <p class="share-section-hint">Anyone with the link can view (no account needed).</p>
            <button class="btn btn-primary" on:click={createPublicLink} disabled={shareDialogBusy}>
              {shareDialogBusy ? 'Creating…' : 'Create Public Link'}
            </button>
          {:else}
            <p class="share-section-hint">Anyone with this link can view (read-only, no account needed).</p>
            <div class="link-row">
              <input
                class="input link-input"
                readonly
                value={shareLinkUrl(shareDialogToken)}
                on:click={(e) => e.target.select()}
              />
              <button class="btn btn-primary" on:click={copyShareLink}>
                <span class="material-symbols-rounded" style="font-size: 16px;">content_copy</span>
                Copy
              </button>
            </div>
            <div class="link-actions">
              <button class="btn btn-secondary" on:click={rotateShareLink} disabled={shareDialogBusy}>
                Rotate
              </button>
              <button class="btn btn-secondary danger-text" on:click={revokeShareLink}>
                Revoke
              </button>
            </div>
          {/if}
        </section>
      </div>
    </div>
  {/if}

  <!-- Cookbook share dialog. Modeled on the recipe share dialog above
       (Section 1: Share with Users; Section 1.5: Share with a Kitchen)
       minus the public-link section — cookbook sharing is member-
       scoped only. -->
  {#if cookbookShareDialogOpen && cookbookShareTarget}
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="cb-dialog-backdrop" on:click={closeCookbookShareDialog}>
      <div class="cb-dialog share-dialog" on:click|stopPropagation>
        <header class="cb-dialog-head">
          <span class="material-symbols-rounded">share</span>
          <h3>Share Cookbook</h3>
          <button class="cb-close" on:click={closeCookbookShareDialog}
            aria-label="Close">
            <span class="material-symbols-rounded">close</span>
          </button>
        </header>
        <p class="cb-dialog-sub">{cookbookShareTarget.name}</p>

        <section class="share-section">
          <h4 class="share-section-title">
            <span class="material-symbols-rounded">person</span>
            Share with Users
          </h4>
          <p class="share-section-hint">Grants read access. They can view and cook from the cookbook but can't edit it.</p>
          {#if cookbookSharePeers.length === 0}
            <p class="share-empty">No other users yet.</p>
          {:else}
            <ul class="peer-list">
              {#each cookbookSharePeers as p (p.user_id)}
                <li class="peer-row">
                  <span class="peer-name">{p.full_name || p.username}</span>
                  <span class="peer-handle">@{p.username}</span>
                  <label class="peer-check">
                    <input type="checkbox"
                      checked={cookbookShareGrants.has(p.user_id)}
                      disabled={cookbookShareBusy}
                      on:change={() => toggleCookbookShareUser(p.user_id)} />
                    <span>Share</span>
                  </label>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        {#if cookbookShareKitchens.length > 0}
          <section class="share-section">
            <h4 class="share-section-title">
              <span class="material-symbols-rounded">cooking</span>
              Share with a Kitchen
            </h4>
            <p class="share-section-hint">Sends the cookbook to every member of the Kitchen at once.</p>
            <ul class="peer-list">
              {#each cookbookShareKitchens as k (k.id)}
                <li class="peer-row">
                  <span class="material-symbols-rounded" style="font-size:18px;color:var(--accent);">cooking</span>
                  <span class="peer-name">{k.name}</span>
                  <span class="peer-handle">{k.member_count} {k.member_count === 1 ? 'member' : 'members'}</span>
                  <button class="btn btn-secondary" style="margin-left:auto;height:30px;font-size:12px"
                    on:click={() => shareCookbookWithKitchen(k)}
                    disabled={cookbookShareKitchenBusyId === k.id}>
                    {cookbookShareKitchenBusyId === k.id ? 'Sharing…' : 'Share'}
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      </div>
    </div>
  {/if}

  {#if bulkCookbookOpen}
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="cb-dialog-backdrop" on:click={() => !bulkCookbookBusy && (bulkCookbookOpen = false)}>
      <div class="cb-dialog" on:click|stopPropagation>
        <header class="cb-dialog-head">
          <h3>Add to Cookbook</h3>
          <button class="btn-icon" on:click={() => bulkCookbookOpen = false} aria-label="Close" disabled={bulkCookbookBusy}>
            <span class="material-symbols-rounded">close</span>
          </button>
        </header>
        <p class="cb-dialog-sub">{selectedIds.size} {selectedIds.size === 1 ? 'recipe' : 'recipes'} selected</p>
        <div class="cb-dialog-list">
          {#if cookbooks.length === 0}
            <p class="cb-dialog-empty">
              No cookbooks yet. Create one in
              <a href="#/manage/cookbooks" on:click|preventDefault={() => { bulkCookbookOpen = false; push('/manage/cookbooks'); }}>Manage &rarr; Cookbooks</a>.
            </p>
          {:else}
            {#each cookbooks.filter(cb => !cb.is_smart) as cb (cb.id)}
              <label class="cb-dialog-row" class:on={bulkCookbookSelected.has(cb.id)}>
                <input type="checkbox"
                  checked={bulkCookbookSelected.has(cb.id)}
                  on:change={() => toggleBulkCookbookSelected(cb.id)} />
                <span class="cb-dialog-name">{cb.name}</span>
                <span class="cb-dialog-count">{cb.recipe_count} {cb.recipe_count === 1 ? 'recipe' : 'recipes'}</span>
              </label>
            {/each}
            {#if cookbooks.every(cb => cb.is_smart)}
              <p class="cb-dialog-empty">
                All your cookbooks are smart cookbooks (auto-filtered).
                Recipes can't be added to a smart cookbook directly.
              </p>
            {/if}
          {/if}
        </div>
        <footer class="cb-dialog-actions">
          <button class="btn btn-secondary" on:click={() => bulkCookbookOpen = false} disabled={bulkCookbookBusy}>Cancel</button>
          <button class="btn btn-primary" on:click={confirmBulkCookbook} disabled={bulkCookbookBusy || bulkCookbookSelected.size === 0}>
            {bulkCookbookBusy ? 'Adding…' : 'Add'}
          </button>
        </footer>
      </div>
    </div>
  {/if}

  {#if cookbookDialogOpen && cookbookDialogRecipe}
    <div class="cb-dialog-backdrop" on:click={() => cookbookDialogOpen = false}>
      <div class="cb-dialog" on:click|stopPropagation>
        <header class="cb-dialog-head">
          <h3>Add to Cookbook</h3>
          <button class="btn-icon" on:click={() => cookbookDialogOpen = false} aria-label="Close">
            <span class="material-symbols-rounded">close</span>
          </button>
        </header>
        <p class="cb-dialog-sub">{cookbookDialogRecipe.name}</p>
        <div class="cb-dialog-list">
          {#if cookbooks.length === 0}
            <p class="cb-dialog-empty">
              No cookbooks yet. Create one in
              <a href="#/manage/cookbooks" on:click|preventDefault={() => { cookbookDialogOpen = false; push('/manage/cookbooks'); }}>Manage &rarr; Cookbooks</a>.
            </p>
          {:else}
            {#each cookbooks as cb (cb.id)}
              <label class="cb-dialog-row" class:on={cookbookDialogSelected.has(cb.id)}>
                <input type="checkbox"
                  checked={cookbookDialogSelected.has(cb.id)}
                  on:change={() => toggleCookbookSelected(cb.id)} />
                <span class="cb-dialog-name">{cb.name}</span>
                <span class="cb-dialog-count">{cb.recipe_count} {cb.recipe_count === 1 ? 'recipe' : 'recipes'}</span>
              </label>
            {/each}
          {/if}
        </div>
        <footer class="cb-dialog-actions">
          <button class="btn btn-secondary" on:click={() => cookbookDialogOpen = false}>Cancel</button>
          <button class="btn btn-primary" on:click={confirmCookbookDialog}>Save</button>
        </footer>
      </div>
    </div>
  {/if}

  <!-- URL import dialog (unified: 1 URL = direct save, N URLs = picker) -->
  <ImportUrlDialog bind:open={urlImportOpen} />

  <!-- Paste / upload import dialog (Phase 7). Auto-detects format —
       schema.org JSON-LD, schema.org HTML, Mealie / Tandoor / CookTrace
       JSON exports, Paprika .paprikarecipes / .paprikarecipe archives. -->
  {#if pasteImportOpen}
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="modal-backdrop" on:click|self={() => pasteImportOpen = false}>
      <div class="modal" on:click|stopPropagation>
        <header class="modal-header">
          <h2>JSON / HTML Import</h2>
          <button class="btn-icon" on:click={() => pasteImportOpen = false} aria-label="Close">
            <span class="material-symbols-rounded">close</span>
          </button>
        </header>
        <div class="modal-body">
          <p class="modal-hint">
            Paste a recipe (schema.org JSON-LD, the HTML of a recipe page, or a Mealie / Tandoor / CookTrace JSON export), or upload a file. Paprika <code>.paprikarecipes</code> archives import all included recipes at once.
          </p>
          <textarea
            class="input"
            rows="8"
            placeholder={'Paste JSON or HTML here…'}
            bind:value={pasteText}
            disabled={!!pasteFile}
            style="font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px;"
          ></textarea>
          <div class="paste-or">— or —</div>
          {#if pasteFile}
            <div class="paste-file">
              <span class="material-symbols-rounded">attach_file</span>
              <span class="paste-file-name">{pasteFile.name}</span>
              <button class="btn-icon" on:click={clearPasteFile} aria-label="Remove file">
                <span class="material-symbols-rounded">close</span>
              </button>
            </div>
          {:else}
            <button class="btn btn-secondary" on:click={() => pasteFileInput?.click()}>
              <span class="material-symbols-rounded">upload_file</span>
              Choose a file
            </button>
            <input bind:this={pasteFileInput} type="file"
              accept=".json,.html,.htm,.paprikarecipes,.paprikarecipe,application/json,text/html"
              on:change={onPasteFileChange} style="display:none" />
          {/if}
          <label class="opt-row">
            <input type="checkbox" bind:checked={pasteAddToPantry} />
            <span>
              <span class="opt-label">Link ingredients to your Pantry</span>
              <span class="opt-desc">Matches imported names to your existing Pantry items (case-insensitive) and creates new rows for any that don't exist yet.</span>
            </span>
          </label>
          <label class="opt-row">
            <input type="checkbox" bind:checked={pasteApplyTags} />
            <span>
              <span class="opt-label">Apply tags from the source</span>
            </span>
          </label>
          <label class="opt-row">
            <input type="checkbox" bind:checked={pasteImportCategories} />
            <span>
              <span class="opt-label">Import the source's category</span>
              <span class="opt-desc">Carries the category through and creates it in your catalog if it's new. Off = save uncategorized.</span>
            </span>
          </label>
        </div>
        <footer class="modal-footer">
          <button class="btn btn-secondary" on:click={() => pasteImportOpen = false}>Cancel</button>
          <button class="btn btn-primary" on:click={doPasteImport}
            disabled={pasteBusy || (!pasteFile && !pasteText.trim())}>
            {pasteBusy ? 'Importing…' : 'Import'}
          </button>
        </footer>
      </div>
    </div>
  {/if}

  <div class="page-content">
    <!-- Recipes / Cookbooks / Shared segmented control. Shown when
         there's anything to look at in any of the three views. The
         Shared segment only appears once at least one recipe has
         been shared with the user. -->
    {#if recipes.length > 0 || cookbooks.length > 0 || sharedRecipes.length > 0}
      <div class="view-toggle" role="radiogroup" aria-label="View"
        bind:this={vtContainer}
        style="--vt-pill-x:{vtPillX}px; --vt-pill-w:{vtPillW}px">
        <span class="vt-pill" aria-hidden="true"></span>
        <button class="vt-btn" class:active={viewMode === 'recipes'}
          bind:this={vtBtnRecipes}
          on:click={() => setViewMode('recipes')}
          aria-pressed={viewMode === 'recipes'}>
          <span class="material-symbols-rounded">menu_book</span>
          Recipes
          <span class="vt-count">{recipes.length}</span>
        </button>
        {#if sharedRecipes.length > 0}
          <!-- Shared sits between Recipes and Cookbooks — closer to
               "my recipes" mentally, since these are things I cook
               from. Cookbooks are curated collections, further right. -->
          <button class="vt-btn" class:active={viewMode === 'shared'}
            bind:this={vtBtnShared}
            on:click={() => setViewMode('shared')}
            aria-pressed={viewMode === 'shared'}>
            <span class="material-symbols-rounded">group</span>
            Shared
            <span class="vt-count">{sharedRecipes.length}</span>
          </button>
        {/if}
        <button class="vt-btn" class:active={viewMode === 'cookbooks'}
          bind:this={vtBtnCookbooks}
          on:click={() => setViewMode('cookbooks')}
          aria-pressed={viewMode === 'cookbooks'}>
          <span class="material-symbols-rounded">auto_stories</span>
          Cookbooks
          <span class="vt-count">{cookbooks.length}</span>
        </button>
      </div>
    {/if}

    {#if viewMode === 'recipes' && recipes.length > 0}
    <div class="sticky-controls">
      <div class="search-row">
        <span class="material-symbols-rounded search-icon">search</span>
        <input
          class="search"
          type="search"
          placeholder={$_('routes.recipes.search_placeholder')}
          bind:value={query}
        />
      </div>
      <div class="filter-row">
        {#if categories.length > 0}
          <div class="cat-filter" role="radiogroup" aria-label="Filter recipes">
            <button class="cat-chip fav-chip"
              class:active={favoritesOnly}
              on:click={() => favoritesOnly = !favoritesOnly}
              aria-pressed={favoritesOnly}
              title="Show only favorites">
              <span class="material-symbols-rounded">{favoritesOnly ? 'favorite' : 'favorite_border'}</span>
              Favorites
            </button>
            <button class="cat-chip"
              class:active={!activeCategorySlug}
              on:click={() => setCategoryFilter('')}
              aria-pressed={!activeCategorySlug}
            >All</button>
            {#each categories as c (c.id)}
              {@const isActive = activeCategorySlug === c.slug}
              <button class="cat-chip"
                class:active={isActive}
                style={c.color ? `--cat-color:${c.color}` : ''}
                on:click={() => setCategoryFilter(c.slug)}
                aria-pressed={isActive}
              >{c.name}</button>
            {/each}
          </div>
        {/if}
        <select class="sort-select" bind:value={$recipesSort} title="Sort recipes">
          <option value="fav-alpha">★ + A→Z</option>
          <option value="alpha">A → Z</option>
          <option value="recent">Recently Cooked</option>
          <option value="most">Most Cooked</option>
          <option value="newest">Newest</option>
        </select>
      </div>
    </div><!-- /.sticky-controls -->
    {/if}

    {#if loading}
      <!-- Skeleton placeholders matching the recipe-card grid shape so
           the initial render doesn't pop a spinner-then-cards. Keeps
           layout stable while the fetch lands. -->
      <div class="grid skeleton-grid" aria-busy="true" aria-label="Loading recipes">
        {#each Array(8) as _}
          <div class="skel skel-card">
            <div class="skel-img"></div>
            <div class="skel-body">
              <div class="skel-line w70"></div>
              <div class="skel-line w50"></div>
              <div class="skel-line w40"></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if loadError}
      <div class="state error" in:fade={{ duration: 120 }}>
        <span class="material-symbols-rounded">error</span>
        <p>{loadError}</p>
        <button class="btn btn-secondary" on:click={load}>Retry</button>
      </div>
    {:else if viewMode === 'shared'}
      <!-- Shared with me -->
      {#if sharedRecipes.length === 0}
        <div class="state empty" in:fade={{ duration: 120 }}>
          <span class="material-symbols-rounded empty-icon">group</span>
          <h2>Nothing Shared with You Yet</h2>
          <p>When another user shares a recipe with you it lands here.</p>
        </div>
      {:else}
        <div class="grid">
          {#each sharedRecipes as r (r.id)}
            <button class="card recipe-card"
              on:click={() => push(`/recipes/${r.id}`)}>
              <div class="card-image">
                {#if r.imgUrl}
                  <img src={r.imgUrl} alt="" loading="lazy" />
                {:else}
                  <span class="material-symbols-rounded card-image-fallback">restaurant</span>
                {/if}
                <span class="shared-badge" title={r.shared_by ? `Shared by ${r.shared_by}` : 'Shared with you'}>
                  <span class="material-symbols-rounded">group</span>
                  {r.shared_by || 'Shared'}
                </span>
                {#if r.via_kitchen_name}
                  <span class="via-kitchen-badge" title={`Shared via ${r.via_kitchen_name}`}>
                    <span class="material-symbols-rounded">cooking</span>
                    {r.via_kitchen_name}
                  </span>
                {/if}
              </div>
              <div class="card-body">
                {#if r.category}
                  <span class="card-category"
                    style={r.category.color ? `--cat-color:${r.category.color}` : ''}>
                    {r.category.name}
                  </span>
                {/if}
                <h3 class="card-name">{r.name}</h3>
                {#if r.description}<p class="card-desc">{r.description}</p>{/if}
                <div class="card-meta">
                  {#if totalMinutes(r) > 0}
                    <span class="meta-pill">
                      <span class="material-symbols-rounded">schedule</span>
                      {formatDuration(totalMinutes(r))}
                    </span>
                  {/if}
                  {#if r.servings}
                    <span class="meta-pill">
                      <span class="material-symbols-rounded">restaurant</span>
                      {r.servings}
                    </span>
                  {/if}
                </div>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    {:else if viewMode === 'cookbooks'}
      <!-- Cookbooks tab: your cookbooks first, then cookbooks others
           shared with you. Shared cards keep a "Shared by" badge +
           via-Kitchen chip so ownership is obvious. -->
      {#if cookbooks.length === 0 && sharedCookbooks.length === 0}
        <div class="state empty" in:fade={{ duration: 120 }}>
          <span class="material-symbols-rounded empty-icon">auto_stories</span>
          <h2>No Cookbooks Yet</h2>
          <p>Group your favorite recipes into cookbooks. Create one in <a href="#/manage/cookbooks" on:click|preventDefault={() => push('/manage/cookbooks')}>Manage &rarr; Cookbooks</a>.</p>
          <button class="btn btn-primary" on:click={() => push('/manage/cookbooks')}>Create Cookbook</button>
        </div>
      {:else}
        <div class="grid cookbook-grid">
          {#each cookbooks as cb (cb.id)}
            <button class="card cookbook-card"
              on:click={() => push(`/cookbooks/${cb.id}`)}>
              <div class="cb-card-cover">
                {#if cb.cover_image_url}
                  <img src={cb.cover_image_url} alt="" loading="lazy" />
                {:else}
                  <span class="material-symbols-rounded">auto_stories</span>
                {/if}
                <!-- Owner-only share affordance. stopPropagation so
                     tapping the icon opens the dialog instead of
                     navigating into the cookbook. -->
                <span class="cb-share-btn material-symbols-rounded"
                  role="button" tabindex="0"
                  title="Share cookbook"
                  aria-label="Share cookbook"
                  on:click|stopPropagation={() => openCookbookShareDialog(cb)}
                  on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCookbookShareDialog(cb); } }}>share</span>
              </div>
              <div class="cb-card-body">
                <h3 class="cb-card-name">{cb.name}</h3>
                {#if cb.description}<p class="cb-card-desc">{cb.description}</p>{/if}
                <span class="cb-card-count">
                  {cb.recipe_count} {cb.recipe_count === 1 ? 'recipe' : 'recipes'}
                </span>
              </div>
            </button>
          {/each}
          {#each sharedCookbooks as cb (cb.id)}
            <button class="card cookbook-card"
              on:click={() => push(`/cookbooks/${cb.id}`)}>
              <div class="cb-card-cover">
                {#if cb.cover_image_url}
                  <img src={cb.cover_image_url} alt="" loading="lazy" />
                {:else}
                  <span class="material-symbols-rounded">auto_stories</span>
                {/if}
                <span class="shared-badge" title={cb.shared_by ? `Shared by ${cb.shared_by}` : 'Shared with you'}>
                  <span class="material-symbols-rounded">group</span>
                  {cb.shared_by || 'Shared'}
                </span>
                {#if cb.via_kitchen_name}
                  <span class="via-kitchen-badge" title={`Shared via ${cb.via_kitchen_name}`}>
                    <span class="material-symbols-rounded">cooking</span>
                    {cb.via_kitchen_name}
                  </span>
                {/if}
              </div>
              <div class="cb-card-body">
                <h3 class="cb-card-name">{cb.name}</h3>
                {#if cb.description}<p class="cb-card-desc">{cb.description}</p>{/if}
                <span class="cb-card-count">
                  {cb.recipe_count} {cb.recipe_count === 1 ? 'recipe' : 'recipes'}
                </span>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    {:else if recipes.length === 0}
      <div class="state empty" in:fade={{ duration: 120 }}>
        <span class="material-symbols-rounded empty-icon">menu_book</span>
        <h2>{$_('routes.recipes.empty_title')}</h2>
        <p>{$_('routes.recipes.empty_desc')}</p>
        <button class="btn btn-primary" on:click={() => createSheetOpen = true}>{$_('routes.recipes.create_cta')}</button>
      </div>
    {:else if filtered.length === 0}
      <div class="state empty" in:fade={{ duration: 120 }}>
        <span class="material-symbols-rounded empty-icon">search_off</span>
        <p>{$_('routes.recipes.no_match', { values: { q: query } })}</p>
      </div>
    {:else}
      <div class="grid">
        {#each filtered as r (r.id)}
          <button class="card recipe-card"
            class:selecting={selectMode}
            class:selected={selectMode && selectedIds.has(r.id)}
            class:has-cat={!!r.category?.color}
            style={r.category?.color ? `--cat-color:${r.category.color}` : ''}
            use:longpress
            on:longpress={() => selectMode ? toggleSelected(r.id) : openCardMenu(r)}
            on:click={() => selectMode ? toggleSelected(r.id) : push(`/recipes/${r.id}`)}>
            {#if selectMode}
              <span class="select-mark material-symbols-rounded">
                {selectedIds.has(r.id) ? 'check_box' : 'check_box_outline_blank'}
              </span>
            {/if}
            <div class="card-image">
              {#if r.imgUrl}
                <img src={r.imgUrl} alt="" loading="lazy" />
              {:else}
                <span class="material-symbols-rounded card-image-fallback">restaurant</span>
              {/if}
              {#if r.favorite}
                <span class="card-fav material-symbols-rounded" title="Favorite">favorite</span>
              {/if}
              <!-- When "Show Shared Recipes in My Main List" is on, the
                   mixed-in cards keep their identity chips so ownership
                   is still obvious at a glance. Only renders when the
                   recipe was surfaced from /shared-with-me. -->
              {#if r.shared_with_me}
                <span class="shared-badge" title={r.shared_by ? `Shared by ${r.shared_by}` : 'Shared with you'}>
                  <span class="material-symbols-rounded">group</span>
                  {r.shared_by || 'Shared'}
                </span>
                {#if r.via_kitchen_name}
                  <span class="via-kitchen-badge" title={`Shared via ${r.via_kitchen_name}`}>
                    <span class="material-symbols-rounded">cooking</span>
                    {r.via_kitchen_name}
                  </span>
                {/if}
              {/if}
            </div>
            <div class="card-body">
              {#if r.category}
                <span class="card-category"
                  style={r.category.color ? `--cat-color:${r.category.color}` : ''}>
                  {r.category.name}
                </span>
              {/if}
              <h3 class="card-name">{r.name}</h3>
              {#if r.rating}
                <div class="card-rating" aria-label={`Rated ${r.rating} of 5`}>
                  {#each [1,2,3,4,5] as n}
                    <span class="material-symbols-rounded star" class:filled={n <= r.rating}>{n <= r.rating ? 'star' : 'star_border'}</span>
                  {/each}
                </div>
              {/if}
              {#if r.description}
                <p class="card-desc">{r.description}</p>
              {/if}
              <div class="card-meta">
                {#if totalMinutes(r) > 0}
                  <span class="meta-pill">
                    <span class="material-symbols-rounded">schedule</span>
                    {formatDuration(totalMinutes(r))}
                  </span>
                {/if}
                {#if r.servings}
                  <span class="meta-pill">
                    <span class="material-symbols-rounded">restaurant</span>
                    {r.servings}
                  </span>
                {/if}
                {#if r.last_cooked_at}
                  <span class="meta-pill subtle">
                    <span class="material-symbols-rounded">history</span>
                    {relativeTime(r.last_cooked_at)}
                  </span>
                {/if}
                {#if r.pantry_match && r.pantry_match.need > 0}
                  {@const pct = r.pantry_match.have / r.pantry_match.need}
                  <span class="meta-pill" class:full={pct === 1} class:partial={pct > 0 && pct < 1} class:none={pct === 0}>
                    <span class="material-symbols-rounded">kitchen</span>
                    {r.pantry_match.have}/{r.pantry_match.need}
                  </span>
                {/if}
                {#if r.tags?.length}
                  {#each r.tags.slice(0, 2) as tag}
                    <span class="meta-pill tag">{tag}</span>
                  {/each}
                {/if}
              </div>
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  /* Mirrors the hamburger button: fixed-positioned, 40×40, 12px from edge,
     same vertical offset. Floats above the page-header so it sits on the same
     line as the hamburger regardless of banner-on/banner-off state. */
  .header-action {
    position: fixed;
    top: calc(var(--safe-top) + 10px);
    right: 12px;
    width: 40px;
    height: 40px;
    border-radius: var(--radius-md);
    background: rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(10px) saturate(160%);
    -webkit-backdrop-filter: blur(10px) saturate(160%);
    border: 1px solid rgba(255, 255, 255, 0.18);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--accent);
    z-index: 41;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    transition: background var(--dur-fast), transform var(--dur-fast) var(--ease-spring);
  }
  .header-action:hover  { background: rgba(0, 0, 0, 0.5); }
  .header-action:active { transform: scale(0.92); }
  .header-action:disabled { opacity: 0.35; cursor: not-allowed; }
  .header-action.header-action-2 { right: 60px; }
  .header-action.header-action-3 { right: 108px; }
  /* Same select-mode header treatment used by Pantry — kill the banner
     shimmer while multi-select is on so the mode reads as focused. */
  .page-header.select-mode {
    background: var(--surface-1);
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  }

  /* Sticky list controls — search + filters + sort/select stay
     pinned at the top of the scroll container so the user doesn't
     have to scroll back up after exploring a long recipe list.
     A backdrop-blur + faded surface fill keeps the cards underneath
     readable as they scroll behind it. */
  .sticky-controls {
    position: sticky;
    /* Sit directly below the sticky page-header instead of sliding under
       it. --header-h is measured on the .page-shell at runtime so the
       offset adapts to the banner-on / banner-off / hamburger variants. */
    top: var(--header-h, 0px);
    z-index: 5;
    margin: 0 calc(-1 * var(--space-4)) 8px;
    padding: 8px var(--space-4) 4px;
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  }
  .search-row {
    position: relative;
    margin: 4px 0 16px;
  }
  .search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-3);
    pointer-events: none;
    font-size: 20px;
  }
  .search {
    width: 100%;
    box-sizing: border-box;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 10px 14px 10px 38px;
    color: var(--text-1);
    font-size: 14px;
  }
  .search:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }

  /* Segmented control: Recipes / Cookbooks / Shared tabs at the top of
     the page. The .vt-pill slides between buttons on selection — same
     visual language as the bottom nav and (now) the diary toggle. */
  .view-toggle {
    position: relative;
    display: flex;
    gap: 0;
    background: var(--surface-2);
    border-radius: var(--radius-md);
    padding: 4px;
    margin: 0 0 16px;
    width: fit-content;
  }
  .vt-pill {
    position: absolute;
    top: 4px;
    bottom: 4px;
    left: 0;
    width: var(--vt-pill-w, 0px);
    transform: translateX(var(--vt-pill-x, 0px));
    background: var(--surface-1);
    border-radius: var(--radius-sm);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
    transition: transform var(--dur-base) var(--ease-spring),
                width var(--dur-base) var(--ease-spring);
    pointer-events: none;
  }
  .vt-btn {
    position: relative;
    z-index: 1;
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3);
    font-size: 13px; font-weight: 600;
    padding: 8px 14px;
    border-radius: var(--radius-sm);
    display: inline-flex; align-items: center; gap: 6px;
    transition: color var(--dur-fast);
    flex: 1;
    justify-content: center;
    white-space: nowrap;
  }
  .vt-btn .material-symbols-rounded { font-size: 16px; }
  .vt-btn:hover { color: var(--text-1); }
  .vt-btn.active { color: var(--accent); }
  .vt-count {
    font-size: 11px;
    background: var(--surface-2);
    color: var(--text-3);
    padding: 1px 6px;
    border-radius: 999px;
  }
  .vt-btn.active .vt-count { background: var(--accent-dim); color: var(--accent); }

  /* Cookbook cards. Larger than recipe cards because they're catalogue
     entries, not individual dishes. */
  .cookbook-grid {
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  }
  .cookbook-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    cursor: pointer;
    text-align: left;
    padding: 0;
    display: flex; flex-direction: column;
    transition: transform var(--dur-fast), border-color var(--dur-fast);
  }
  .cookbook-card:hover { transform: translateY(-2px); border-color: var(--accent-dim); }
  .cb-card-cover {
    position: relative;
    aspect-ratio: 16 / 9;
    background: linear-gradient(135deg, var(--accent-dim), var(--surface-2));
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }
  .cb-card-cover img { width: 100%; height: 100%; object-fit: cover; }
  .cb-card-cover .material-symbols-rounded { font-size: 56px; color: var(--accent); opacity: 0.7; }
  /* Share affordance on owner-only cookbook cards. Tap the icon
     instead of the card to open the share dialog (stopPropagation
     handles it). Small enough not to compete with the cover art. */
  .cb-share-btn {
    position: absolute;
    top: 6px; right: 6px;
    width: 28px; height: 28px;
    background: rgba(0, 0, 0, 0.55);
    color: white;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 16px !important;
    opacity: 0;
    transition: opacity var(--dur-fast), background var(--dur-fast);
    cursor: pointer;
  }
  .cookbook-card:hover .cb-share-btn,
  .cookbook-card:focus-within .cb-share-btn { opacity: 1; }
  .cb-share-btn:hover { background: var(--accent); color: var(--accent-text, #0A0B0F); }
  /* Touch devices don't have :hover — keep the share icon visible so
     it's actually reachable on mobile. */
  @media (hover: none) { .cb-share-btn { opacity: 0.85; } }
  .cb-card-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 4px; }
  .cb-card-name { margin: 0; font-size: 16px; font-weight: 700; color: var(--text-1); }
  .cb-card-desc {
    margin: 0; font-size: 12px; color: var(--text-3);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    line-height: 1.4;
  }
  .cb-card-count {
    font-size: 11px; color: var(--text-3); font-weight: 600;
    margin-top: 2px;
  }

  /* Category filter chips — horizontal scroll on overflow so the row
     never breaks mid-name. Active chip gets the category's own color. */
  .cat-filter {
    display: flex;
    gap: 8px;
    margin: 0 0 16px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding-bottom: 2px;
  }
  .cat-filter::-webkit-scrollbar { display: none; }
  .cat-chip {
    flex-shrink: 0;
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .cat-chip:hover { background: var(--surface-2); color: var(--text-1); }
  .cat-chip.active {
    background: color-mix(in srgb, var(--cat-color, var(--accent)) 18%, transparent);
    border-color: color-mix(in srgb, var(--cat-color, var(--accent)) 55%, transparent);
    color: var(--cat-color, var(--accent));
  }
  /* Favorites chip — red instead of accent so it reads as a different
     axis from category, even when both are toggled at once. */
  .cat-chip.fav-chip {
    display: inline-flex; align-items: center; gap: 4px;
  }
  .cat-chip.fav-chip .material-symbols-rounded { font-size: 14px; }
  .cat-chip.fav-chip.active {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    color: var(--accent);
  }

  /* Filter row holds chips + sort. On wide screens it's flex; on
     narrow phones the chips wrap and the sort drops below. */
  .filter-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .filter-row .cat-filter { flex: 1; min-width: 0; margin: 0; }
  .sort-select {
    background: var(--surface-1);
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 6px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
  }
  .sort-select:hover { background: var(--surface-2); color: var(--text-1); }

  .state {
    text-align: center;
    padding: 60px 16px;
    color: var(--text-3);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .state.empty .empty-icon {
    font-size: 64px;
    color: var(--accent);
    opacity: 0.6;
  }
  .state h2 { color: var(--text-1); margin: 12px 0 0; font-size: 20px; }
  .state p { margin: 4px 0 8px; }
  .state.error { color: var(--error, #f87171); }
  .spin {
    font-size: 32px;
    animation: spin 1.2s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 14px;
    padding-top: 4px;
  }

  .recipe-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    cursor: pointer;
    text-align: left;
    padding: 0;
    display: flex;
    flex-direction: column;
    transition: transform var(--dur-fast), box-shadow var(--dur-fast), border-color var(--dur-fast);
    -webkit-tap-highlight-color: transparent;
  }
  @media (hover: hover) {
    .recipe-card:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-glow, 0 8px 24px rgba(0,0,0,0.18));
      border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
    }
  }
  .recipe-card:active { transform: scale(0.99); }
  /* Subtle category-color stripe along the left edge — carries the
     recipe's category color into the card body without overwhelming
     the imagery. Only applied when the recipe actually has a category
     with a color set; uncategorized cards stay neutral. */
  .recipe-card.has-cat {
    border-left: 3px solid var(--cat-color);
  }
  @media (hover: hover) {
    .recipe-card.has-cat:hover {
      border-color: color-mix(in srgb, var(--cat-color) 35%, var(--border));
      border-left-color: var(--cat-color);
    }
  }

  /* Skeleton loader — neutral placeholder cards that match the
     recipe-card aspect ratio + body padding. Subtle shimmer keeps
     the page feeling alive while the fetch is in flight. */
  .skeleton-grid { pointer-events: none; }
  .skel-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .skel-img {
    width: 100%;
    aspect-ratio: 4 / 3;
    background: var(--surface-2);
  }
  .skel-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
  .skel-line {
    height: 12px;
    border-radius: 6px;
    background: var(--surface-2);
  }
  .skel-line.w70 { width: 70%; }
  .skel-line.w50 { width: 50%; }
  .skel-line.w40 { width: 40%; }
  .skel { animation: skel-pulse 1.4s ease-in-out infinite; }
  .skel-img,
  .skel-line { animation: skel-pulse 1.4s ease-in-out infinite; }
  @keyframes skel-pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
  }

  .recipe-card.selecting { position: relative; }
  .recipe-card.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .select-mark {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 2;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 22px !important;
    border-radius: 50%;
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .recipe-card.selected .select-mark { color: var(--accent); background: rgba(0,0,0,0.7); }

  .select-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px 4px 8px;
  }
  .select-toggle.active {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    border-color: var(--accent);
    color: var(--accent);
  }
  .select-toggle .material-symbols-rounded { font-size: 18px; }


  .card-image {
    width: 100%;
    aspect-ratio: 16 / 10;
    background: var(--surface-2);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    position: relative;
  }
  .card-image img { width: 100%; height: 100%; object-fit: cover; }
  .card-image-fallback {
    font-size: 56px;
    color: var(--text-3);
    opacity: 0.5;
  }
  .card-fav {
    position: absolute;
    top: 8px;
    right: 8px;
    font-size: 22px;
    color: var(--error, #f87171);
    font-variation-settings: 'FILL' 1;
    text-shadow: 0 2px 6px rgba(0,0,0,0.45);
  }

  .card-rating {
    display: inline-flex;
    gap: 1px;
    margin-top: -2px;
  }
  .card-rating .star {
    font-size: 13px;
    color: var(--text-3);
    font-variation-settings: 'FILL' 0;
  }
  .card-rating .star.filled {
    color: var(--accent);
    font-variation-settings: 'FILL' 1;
  }

  .card-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 6px; }
  .card-category {
    align-self: flex-start;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 999px;
    color: var(--cat-color, var(--accent));
    background: color-mix(in srgb, var(--cat-color, var(--accent)) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--cat-color, var(--accent)) 35%, transparent);
  }
  .card-name {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-1);
    line-height: 1.3;
  }
  .card-desc {
    margin: 0;
    font-size: 12px;
    color: var(--text-3);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .card-meta {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .meta-pill {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: var(--surface-2);
    color: var(--text-2);
    border-radius: var(--radius-full, 99px);
    padding: 3px 8px;
    font-size: 11px;
    font-weight: 600;
  }
  .meta-pill .material-symbols-rounded { font-size: 14px; }
  .meta-pill.tag {
    background: var(--accent-dim);
    color: var(--accent);
  }
  .meta-pill.subtle {
    background: transparent;
    color: var(--text-3);
    border: 1px solid var(--border);
  }
  .meta-pill.full {
    background: color-mix(in srgb, var(--success, #22c55e) 18%, transparent);
    color: var(--success, #22c55e);
  }
  .meta-pill.partial {
    background: color-mix(in srgb, #f59e0b 16%, transparent);
    color: #f59e0b;
  }
  .meta-pill.none {
    background: transparent;
    color: var(--text-3);
    border: 1px solid var(--border);
  }

  /* URL import modal — same shape as other modals in the app */
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
    box-shadow: 0 16px 48px rgba(0,0,0,0.4);
  }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px; border-bottom: 1px solid var(--border);
  }
  .modal-header h2 { margin: 0; font-size: 17px; font-weight: 700; color: var(--text-1); }
  .modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .modal-hint { font-size: 13px; color: var(--text-3); margin: 0; line-height: 1.5; }
  .opt-row {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 6px 0;
    cursor: pointer;
  }
  .opt-row input[type="checkbox"] {
    margin-top: 3px; flex-shrink: 0;
    accent-color: var(--accent);
  }
  .opt-row .opt-label { display: block; font-size: 13px; color: var(--text-1); font-weight: 500; }
  .opt-row .opt-desc  { display: block; font-size: 12px; color: var(--text-3); margin-top: 2px; line-height: 1.4; }
  .paste-or {
    text-align: center; font-size: 12px; color: var(--text-3);
    padding: 4px 0;
  }
  .paste-file {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 13px;
  }
  .paste-file .material-symbols-rounded:first-child { color: var(--accent); font-size: 18px; }
  .paste-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  textarea.input { resize: vertical; min-height: 120px; }
  .modal-footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; border-top: 1px solid var(--border); }
  .input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 10px 12px; color: var(--text-1);
    font-size: 14px; box-sizing: border-box; width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .btn-icon {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3); padding: 4px; border-radius: var(--radius-sm);
  }
  .btn-icon:hover { color: var(--error, #f87171); background: color-mix(in srgb, var(--error, #ef4444) 12%, transparent); }
  .btn-icon .material-symbols-rounded { font-size: 22px; }

  /* Add-to-Cookbook dialog */
  .cb-dialog-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex; align-items: center; justify-content: center;
    z-index: 1200;
    padding: 16px;
  }
  .cb-dialog {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 0;
    width: 100%; max-width: 460px;
    max-height: 80vh;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
    display: flex; flex-direction: column;
  }
  .cb-dialog-head {
    padding: 16px 16px 8px;
    display: flex; align-items: center;
  }
  .cb-dialog-head h3 { margin: 0; flex: 1; font-size: 17px; font-weight: 700; color: var(--text-1); }
  .cb-dialog-sub {
    padding: 0 16px 12px;
    margin: 0;
    color: var(--text-3);
    font-size: 13px;
    border-bottom: 1px solid var(--border);
  }
  .cb-dialog-list {
    flex: 1; overflow-y: auto;
    padding: 4px 8px;
  }
  .cb-dialog-empty { color: var(--text-3); font-size: 13px; text-align: center; padding: 24px; }
  .cb-dialog-empty a { color: var(--accent); }
  .cb-dialog-row {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: background var(--dur-fast);
  }
  .cb-dialog-row:hover, .cb-dialog-row.on { background: var(--surface-2); }
  .cb-dialog-row input { accent-color: var(--accent); }
  .cb-dialog-name { flex: 1; color: var(--text-1); font-weight: 600; font-size: 14px; }
  .cb-dialog-count { color: var(--text-3); font-size: 11px; }
  .cb-dialog-actions {
    padding: 12px 16px;
    display: flex; justify-content: flex-end; gap: 8px;
    border-top: 1px solid var(--border);
  }

  /* Share dialog sections (per-user grants + public link) */
  .share-dialog { max-width: 500px; }
  .share-section {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .share-section:last-child { border-bottom: none; }
  .share-section-title {
    display: flex; align-items: center; gap: 8px;
    margin: 0 0 6px;
    font-size: 14px;
    font-weight: 700;
    color: var(--text-1);
  }
  .share-section-title .material-symbols-rounded { font-size: 18px; color: var(--accent); }
  .share-section-hint {
    margin: 0 0 10px;
    color: var(--text-3);
    font-size: 12px;
    line-height: 1.4;
  }
  .peer-list {
    list-style: none; padding: 0; margin: 0;
    max-height: 180px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .peer-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px;
    cursor: pointer;
    border-top: 1px solid var(--border);
  }
  .peer-row:first-child { border-top: none; }
  .peer-row:hover, .peer-row.on { background: var(--surface-2); }
  .peer-row input { accent-color: var(--accent); }
  .peer-name { flex: 1; color: var(--text-1); font-weight: 600; font-size: 13px; }
  .peer-handle {
    color: var(--text-3);
    font-size: 11px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .link-row { display: flex; gap: 6px; margin-bottom: 10px; }
  .link-input {
    flex: 1;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .link-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn.danger-text { color: var(--error, #f87171); }

  /* Shared-with-me badge on recipe cards */
  .shared-badge {
    position: absolute;
    top: 8px;
    left: 8px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: rgba(0, 0, 0, 0.55);
    color: white;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .shared-badge .material-symbols-rounded { font-size: 12px; }
  /* "via [Kitchen]" chip — mint accent to distinguish from the neutral
     shared-by badge above it. Sits directly under so both are readable
     at a glance without visual conflict. */
  .via-kitchen-badge {
    position: absolute;
    top: 34px;
    left: 8px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: color-mix(in srgb, var(--accent) 78%, black 22%);
    color: white;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    max-width: calc(100% - 16px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .via-kitchen-badge .material-symbols-rounded { font-size: 12px; }
</style>
