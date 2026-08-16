<script>
  /**
   * Trace — assistant chat panel + FAB.
   *
   * Wires the multi-provider tool-use loop in `lib/aiChat.js` into a
   * cooking-domain tool handler that reads the user's recipes, pantry,
   * diary, and shopping list, and writes to them on request. Mirrors
   * NutriTrace's Trace experience so users get the same assistant
   * behavior across all three Trace apps.
   *
   * Image attach: tap the paperclip to add a photo. The user can ask
   * Trace to import a recipe from a cookbook page, identify a pantry
   * item, etc. Image is sent with the next user message in a
   * provider-specific format (Claude / OpenAI / Gemini).
   */
  import { tick, onMount } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { _ } from 'svelte-i18n';
  import TraceFace from './TraceFace.svelte';
  import TraceFaceChef from './TraceFaceChef.svelte';
  import {
    aiEnabled, aiEffectivelyEnabled, envLocks, aiAssistantName, aiProvider, aiApiKey, aiModel, aiBaseUrl,
    aiKeyVerified, energyUnit, measurementSystem, dateFormat, smartLogEnabled,
    traceChefHat,
  } from '../../stores/settings.js';
  // Pick the right mascot variant based on the per-user toggle. Reactive
  // so flipping it in Settings updates every avatar immediately.
  $: Mascot = $traceChefHat ? TraceFaceChef : TraceFace;
  import { showError, showSuccess } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { portal } from '../../lib/portal.js';
  import { NtApi } from '../../lib/api.js';
  import { isNative } from '../../lib/platform.js';
  import { callAI, callAIProxy, TOOLS, setToolHandler, AI_DEFAULT_MODELS } from '../../lib/aiChat.js';

  let panelOpen = false;
  let messages = [];      // { role, content, time? }

  // ── Draggable FAB (NutriTrace parity) ────────────────────────────────
  // Position stored as { x, y } in viewport pixels. Null = use the CSS
  // default (right + bottom). Loaded from localStorage `ct:aiFabPos`,
  // persisted whenever the user finishes a drag. Clamped to viewport
  // on resize so it can never end up off-screen.
  function _clampFabPos(p) {
    if (!p || typeof window === 'undefined') return p || null;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    const sz = 64; // FAB diameter
    const margin = 8;
    return {
      x: Math.max(margin, Math.min(window.innerWidth  - sz - margin, p.x)),
      y: Math.max(margin, Math.min(window.innerHeight - sz - margin, p.y)),
    };
  }
  let fabPos = (() => {
    if (typeof localStorage === 'undefined') return null;
    try {
      const saved = JSON.parse(localStorage.getItem('ct:aiFabPos') || 'null');
      const clamped = _clampFabPos(saved);
      if (saved && clamped && (clamped.x !== saved.x || clamped.y !== saved.y)) {
        localStorage.setItem('ct:aiFabPos', JSON.stringify(clamped));
      }
      return clamped;
    } catch { return null; }
  })();
  let _hasDragged = false;
  $: fabStyle = fabPos
    ? `left:${fabPos.x}px; top:${fabPos.y}px; right:auto; bottom:auto;`
    : '';
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      if (!fabPos) return;
      const c = _clampFabPos(fabPos);
      if (c && (c.x !== fabPos.x || c.y !== fabPos.y)) {
        fabPos = c;
        try { localStorage.setItem('ct:aiFabPos', JSON.stringify(c)); } catch {}
      }
    });
  }

  // ── FAB gesture model ──────────────────────────────────────────────
  // Three things can happen on a single press of the FAB:
  //   - Tap (no movement, < 600ms)        → toggle chat panel
  //   - Drag (movement > 6px before 600ms) → reposition FAB, persist
  //   - Hold (no movement, >= 600ms)       → Smart Log voice recording
  //                                          (only when smartLogEnabled)
  // Hold pattern matches NutriTrace's Trace FAB so a user moving
  // between apps gets the same gesture.
  const HOLD_THRESHOLD_MS = 600;
  const CANCEL_RADIUS_PX  = 100;   // slide further than this from FAB center → cancel preview
  let _holdTimer = null;
  let _fabRecording = false;     // true while hold-recording is live
  let _fabCancelPreview = false; // true once the finger has slid > CANCEL_RADIUS_PX away
  // Capture native plugin handle once so _stopVoice can cancel it. The
  // PWA path still tracks the Web Speech recogniser via _speechRec.
  let _commitNextTranscript = true;

  // Small haptic buzz on hold-record start / stop. No-op on web — only
  // wired in native via @capacitor/haptics (the plugin is already a CT
  // dependency for other gestures).
  async function _hapticBuzz(style = 'medium') {
    if (!isNative) return;
    try {
      const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
      const map = { light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy };
      await Haptics.impact({ style: map[style] || ImpactStyle.Medium });
    } catch {}
  }

  // Short audio confirmation on hold-record start / stop. Uses a fresh
  // Web Audio osc each time so there's no preloaded asset to ship.
  // Same envelope shape NutriTrace uses; muted when the user has
  // ct:traceBeep stored as the string "0".
  let _audioCtx = null;
  function _beep(frequency, durationMs) {
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem('ct:traceBeep') === '0') return;
      if (!_audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        _audioCtx = new Ctx();
      }
      const ctx = _audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      osc.type = 'sine';
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.012);
      gain.gain.linearRampToValueAtTime(0, now + (durationMs / 1000));
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + (durationMs / 1000) + 0.02);
    } catch {}
  }

  function startDrag(e) {
    // Only respond to primary button.
    if (e.button !== undefined && e.button !== 0) return;
    _hasDragged = false;
    _fabCancelPreview = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const sz = 64;
    const baseX = fabPos ? fabPos.x : window.innerWidth  - sz - 24;
    const baseY = fabPos ? fabPos.y : window.innerHeight - sz - 96;

    // Capture FAB center for cancel-preview distance math during the
    // hold-record gesture. Read once on pointerdown — the FAB doesn't
    // move while a recording is live (drag is mutually exclusive).
    const fabEl = e.currentTarget;
    let fabCenterX = 0, fabCenterY = 0;
    if (fabEl && fabEl.getBoundingClientRect) {
      const r = fabEl.getBoundingClientRect();
      fabCenterX = r.left + r.width / 2;
      fabCenterY = r.top  + r.height / 2;
    }

    // Always schedule the hold timer when the user presses the FAB.
    // Preconditions (Smart Log toggle, AI key, speech support, secure
    // context) are checked inside the timer so a failing condition can
    // surface a clear toast — silently doing nothing was the previous
    // behavior and made it look like the gesture itself was broken.
    _holdTimer = setTimeout(() => {
      _holdTimer = null;
      if (_hasDragged) return; // user started dragging — abort
      if (!_speechSupported) {
        showError($_('trace_ai_ct.toast.voice_unsupported'));
        return;
      }
      if (!$aiEnabled || (!$aiKeyVerified && !aiEnvLocked)) {
        showError($_('trace_ai_ct.toast.configure_ai'));
        return;
      }
      if (!$smartLogEnabled) {
        showError($_('trace_ai_ct.toast.enable_smart_log'));
        return;
      }
      if (!isNative && typeof window !== 'undefined' && !window.isSecureContext) {
        showError($_('trace_ai_ct.toast.voice_needs_https'));
        return;
      }
      _fabRecording = true;
      _commitNextTranscript = true;
      _hapticBuzz('medium');
      _beep(1000, 80); // start beep — high tone
      input = '';
      _startVoice({ smartLog: true, fromHold: true });
    }, HOLD_THRESHOLD_MS);

    function move(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Only enter drag mode if movement happened BEFORE recording
      // started. Once recording is live, finger movement is for the
      // cancel-preview gesture, not for repositioning the FAB.
      // Drag threshold: 30 px. Started at 6 (NT's value), but the
      // specific phone touch input here reports up to ~13 px of jitter
      // on a "still" hold within the 600 ms window. 30 px stays well
      // under deliberate drag motion (typically 50+ px) but ignores
      // natural finger drift so hold-to-record fires reliably.
      if (!_fabRecording && !_hasDragged && (Math.abs(dx) > 30 || Math.abs(dy) > 30)) {
        _hasDragged = true;
        if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = null; }
      }
      if (_hasDragged) {
        const next = _clampFabPos({ x: baseX + dx, y: baseY + dy });
        if (next) fabPos = next;
        return;
      }
      // Cancel-preview during recording: slide finger > CANCEL_RADIUS_PX
      // from the FAB center to mark for abort. Light haptic on entry
      // so the user can feel the threshold without looking.
      if (_fabRecording) {
        const fdx = ev.clientX - fabCenterX;
        const fdy = ev.clientY - fabCenterY;
        const dist = Math.sqrt(fdx * fdx + fdy * fdy);
        const shouldCancel = dist > CANCEL_RADIUS_PX;
        if (shouldCancel !== _fabCancelPreview) {
          _fabCancelPreview = shouldCancel;
          if (shouldCancel) _hapticBuzz('light');
        }
      }
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup',   up);
      window.removeEventListener('pointercancel', up);
      if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = null; }
      if (_hasDragged && fabPos) {
        try { localStorage.setItem('ct:aiFabPos', JSON.stringify(fabPos)); } catch {}
      }
      // Releasing while recording: commit unless cancel-preview is
      // active (finger is currently more than CANCEL_RADIUS_PX away
      // from the FAB).
      if (_fabRecording) {
        const commit = !_fabCancelPreview;
        _fabRecording = false;
        const wasCancel = _fabCancelPreview;
        _fabCancelPreview = false;
        if (!commit) _commitNextTranscript = false;
        _hapticBuzz('light');
        _beep(commit ? 600 : 350, 80); // lower tone for commit, lowest for cancel
        _stopVoice();
        if (wasCancel) {
          // Surface a tiny toast so the user knows the cancel actually
          // landed; otherwise a successful cancel looks identical to a
          // failed recording.
          showError($_('trace_ai_ct.toast.voice_cancelled'));
        }
      }
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup',   up);
    window.addEventListener('pointercancel', up);
  }
  // Suppress the synthetic click that follows a drag-end OR a Smart Log
  // hold so we don't accidentally toggle the chat panel.
  function onFabClick() {
    if (_hasDragged || _fabRecording) { _hasDragged = false; return; }
    // Also skip if a hold timer is still pending (the synthetic click
    // can fire before pointerup on some platforms).
    if (recording && _smartLogActive) return;
    panelOpen = !panelOpen;
  }
  let input = '';
  let busy = false;
  let messagesEl;
  let toolStatus = '';
  let attachedImage = null;        // { base64, mimeType, preview }
  // Derive env-lock state from the global envLocks store (populated by
  // App.svelte at startup with the Bearer token attached). Local fetch
  // here didn't carry auth and 401'd on native server mode, leaving
  // aiEnvLocked=false and the chat refusing to send when AI was
  // configured via env vars. Same pattern as NutriTrace rc.33 fix.
  $: aiEnvLocked = !!$envLocks.ai;

  $: assistantName = $aiAssistantName || 'Trace';

  onMount(async () => {

    // Load persisted chat history from the server so the conversation
    // travels across browsers + devices for the logged-in user. Mirrors
    // NutriTrace's onMount pattern. Fire-and-forget on errors — if the
    // server is unreachable the chat just starts empty (graceful
    // degradation). Logs surface so persistence failures show up in
    // the diagnostic log capture rather than dying silent.
    await _loadChatHistory();

    // Register the tool handler. Each tool delegates to NtApi; results
    // are JSON-stringified by aiChat.js before going back to the model.
    setToolHandler(async (name, args) => {
      switch (name) {
        // ── Read tools ───────────────────────────────────────────────
        case 'get_recipes': {
          try {
            const all = await NtApi.getRecipes();
            const q   = (args?.query    || '').toString().trim().toLowerCase();
            const cat = (args?.category || '').toString().trim().toLowerCase();
            const favOnly = !!args?.favorite;
            let filtered = all;
            if (q) filtered = filtered.filter(r =>
              (r.name || '').toLowerCase().includes(q) ||
              (r.description || '').toLowerCase().includes(q) ||
              (r.tags || []).some(t => t.toLowerCase().includes(q)));
            if (cat) filtered = filtered.filter(r =>
              (r.category?.name || '').toLowerCase() === cat ||
              (r.category?.slug || '').toLowerCase() === cat);
            if (favOnly) filtered = filtered.filter(r => !!r.favorite);
            return filtered.slice(0, 100).map(_summariseRecipe);
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'list_recipe_categories': {
          try {
            const rows = await NtApi.getRecipeCategories();
            return (rows || []).map(c => ({
              id: c.id, name: c.name, slug: c.slug, color: c.color || null,
              recipe_count: c.recipe_count ?? null,
            }));
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'list_pantry_categories': {
          try {
            const rows = await NtApi.getPantryCategories();
            return (rows || []).map(c => ({
              id: c.id, name: c.name, slug: c.slug, icon: c.icon || null,
            }));
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'get_recipe': {
          try {
            const r = await NtApi.getRecipe(parseInt(args?.id, 10));
            return _fullRecipe(r);
          } catch (e) { return { error: e.message || 'Not found' }; }
        }
        case 'get_pantry': {
          try {
            const opts = {};
            if (args?.in_stock_only) opts.in_stock = 1;
            if (args?.query) opts.q = args.query;
            const rows = await NtApi.getPantry(opts);
            const cat = (args?.category || '').toString().trim().toLowerCase();
            const filtered = cat
              ? rows.filter(p =>
                  (p.category?.name || '').toLowerCase() === cat ||
                  (p.category?.slug || '').toLowerCase() === cat)
              : rows;
            // Variant-aware shape (Issue #4). Standalone variants drop
            // from the top of the response; they ride along under their
            // parent in `variants[]`. This stops the AI from double-
            // counting (e.g. "Milk" and three branded variants all
            // appearing as four separate rows).
            const variantsByParent = new Map();
            for (const r of filtered) {
              if (r.generic_parent_id != null) {
                if (!variantsByParent.has(r.generic_parent_id)) variantsByParent.set(r.generic_parent_id, []);
                variantsByParent.get(r.generic_parent_id).push(r);
              }
            }
            const topLevel = filtered.filter(r => r.generic_parent_id == null);
            const shapeVariant = (v) => ({
              id: v.id,
              brand: v.brand || null,
              name: v.name,
              in_stock: !!v.in_stock,
              quantity: v.quantity ?? null,
              unit: v.unit ?? null,
              barcode: v.barcode || null,
              expires_on: v.expires_on ?? null,
            });
            const isInStock = (p) => {
              const kids = variantsByParent.get(p.id) || [];
              if (kids.length > 0) return kids.some(k => k.in_stock);
              return !!p.in_stock;
            };
            return topLevel
              // Filter by in_stock_only AFTER aggregation so a generic
              // with at least one stocked variant correctly surfaces.
              .filter(p => !args?.in_stock_only || isInStock(p))
              .map(p => {
                // For generics, the parent doesn't carry an expiry — the
                // variants each own one. Roll them up so the AI sees the
                // earliest date under the parent's expires_on, matching
                // the pill on the pantry list card.
                const kids = variantsByParent.get(p.id) || [];
                const kidExps = kids.map(k => k.expires_on).filter(Boolean);
                const earliestKidExp = kidExps.length
                  ? kidExps.reduce((a, b) => (a < b ? a : b))
                  : null;
                return {
                id: p.id,
                name: p.name,
                brand: p.brand || null,
                in_stock: isInStock(p),
                quantity: p.quantity ?? null,
                unit: p.unit ?? null,
                expires_on: p.expires_on ?? earliestKidExp,
                category: p.category?.name || null,
                serving: p.serving_size ? `${p.serving_size} ${p.serving_unit || 'g'}` : null,
                has_nutrition: !!(p.nutrition && Object.keys(p.nutrition).length > 0),
                barcode: p.barcode || null,
                notes: p.notes || null,
                ...((variantsByParent.get(p.id) || []).length > 0
                  ? { variants: (variantsByParent.get(p.id) || []).map(shapeVariant) }
                  : {}),
                };
              });
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'find_recipes_from_pantry': {
          try {
            const all = await NtApi.getRecipes();
            const minRatio = Number.isFinite(args?.min_ratio) ? args.min_ratio : 0.7;
            const ranked = all
              .map(r => ({
                r,
                ratio: (r.pantry_match && r.pantry_match.need > 0)
                  ? r.pantry_match.have / r.pantry_match.need
                  : 0,
              }))
              .filter(x => x.ratio >= minRatio)
              .sort((a, b) => b.ratio - a.ratio)
              .slice(0, 30);
            return ranked.map(({ r, ratio }) => ({
              ..._summariseRecipe(r),
              pantry_match: r.pantry_match || { have: 0, need: 0 },
              ratio: Math.round(ratio * 100) / 100,
            }));
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'get_diary': {
          try {
            const from = args?.from;
            const to = args?.to;
            if (!from || !to) return { error: 'from and to are required (YYYY-MM-DD)' };
            const rows = await NtApi.getCookDiary({ from, to });
            return (rows || []).map(d => ({
              id: d.id,
              date: d.date,
              kind: d.kind,
              recipe_id: d.recipe_id,
              recipe_name: d.recipe_name || null,
              servings: d.servings,
              meal_type: d.meal_type || null,
              rating: Number.isFinite(d.rating) ? d.rating : null,
              notes: d.notes || null,
              has_photo: !!(d.photo_url || (Array.isArray(d.photos) && d.photos.length > 0)),
            }));
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'get_shopping_list': {
          try {
            const rows = await NtApi.getShoppingList();
            return (rows || []).map(s => ({
              id: s.id,
              name: s.name,
              quantity: s.quantity ?? null,
              unit: s.unit ?? null,
              aisle: s.aisle ?? null,
              checked: !!s.checked,
              pantry_id: s.pantry_id ?? null,
              recipe_id: s.recipe_id ?? null,
              recipe_name: s.recipe_name ?? null,
            }));
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'get_cookbooks': {
          try {
            const rows = await NtApi.getCookbooks();
            return rows.map(c => ({
              id: c.id, name: c.name, slug: c.slug,
              description: c.description, recipe_count: c.recipe_count,
              is_smart: c.is_smart, smart_filter: c.smart_filter || null,
            }));
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'get_cookbook': {
          try {
            const cb = await NtApi.getCookbook(parseInt(args?.id, 10));
            return {
              id: cb.id, name: cb.name, description: cb.description,
              is_smart: cb.is_smart, smart_filter: cb.smart_filter || null,
              recipes: (cb.recipes || []).map(_summariseRecipe),
            };
          } catch (e) { return { error: e.message || 'Not found' }; }
        }

        // ── Write tools ──────────────────────────────────────────────
        case 'log_cook': {
          try {
            const id = parseInt(args?.recipe_id, 10);
            if (!Number.isFinite(id)) return { error: 'recipe_id required' };
            const payload = {};
            if (args?.date)      payload.date      = args.date;
            if (args?.notes)     payload.notes     = args.notes;
            if (args?.meal_type) payload.meal_type = args.meal_type;
            if (Number.isFinite(args?.rating)) payload.rating = args.rating;
            const updated = await NtApi.markCooked(id, payload);
            return { ok: true, recipe: { id: updated.id, name: updated.name, cook_count: updated.cook_count, last_cooked_at: updated.last_cooked_at } };
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'plan_cook': {
          try {
            const id = parseInt(args?.recipe_id, 10);
            const date = args?.date;
            if (!Number.isFinite(id) || !date) return { error: 'recipe_id and date required' };
            const r = await NtApi.createDiaryEntry({
              recipe_id: id, date, kind: 'planned',
              notes: args?.notes || null,
              meal_type: args?.meal_type || null,
            });
            return { ok: true, entry: r };
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'add_to_shopping': {
          try {
            const items = Array.isArray(args?.items) ? args.items : [];
            if (items.length === 0) return { error: 'items array required' };
            const created = [];
            for (const it of items) {
              if (!it?.name) continue;
              const row = await NtApi.addShoppingItem({
                name: String(it.name).trim(),
                quantity: it.quantity ?? null,
                unit: it.unit || null,
                aisle: it.aisle || null,
              });
              created.push({ id: row.id, name: row.name });
            }
            return { ok: true, added: created.length, items: created };
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'add_to_pantry': {
          try {
            if (!args?.name) return { error: 'name required' };
            const row = await NtApi.createPantryItem({
              name: String(args.name).trim(),
              in_stock: args.in_stock !== false,
              quantity: args.quantity ?? null,
              unit: args.unit || null,
              brand: args.brand || null,
              notes: args.notes || null,
            });
            return { ok: true, pantry_item: { id: row.id, name: row.name, in_stock: !!row.in_stock } };
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'set_pantry_density': {
          try {
            const id = parseInt(args?.pantry_id, 10);
            if (!Number.isFinite(id)) return { error: 'pantry_id required' };
            const dens = args?.g_per_cup;
            const next = (dens === null || dens === 0 || dens === '') ? null : Number(dens);
            if (next != null && (!Number.isFinite(next) || next <= 0 || next > 5000)) {
              return { error: 'g_per_cup must be between 0 and 5000' };
            }
            const row = await NtApi.updatePantryItem(id, { g_per_cup: next });
            return { ok: true, pantry_item: { id: row.id, name: row.name, g_per_cup: row.g_per_cup ?? null } };
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'set_pantry_stock': {
          try {
            const id = parseInt(args?.pantry_id, 10);
            if (!Number.isFinite(id)) return { error: 'pantry_id required' };
            const row = await NtApi.toggleStock(id, !!args?.in_stock);
            return { ok: true, pantry_item: { id: row.id, name: row.name, in_stock: !!row.in_stock } };
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'add_to_cookbook': {
          try {
            const cookbookId = parseInt(args?.cookbook_id, 10);
            const ids = Array.isArray(args?.recipe_ids) ? args.recipe_ids.map(n => parseInt(n, 10)).filter(Number.isFinite) : [];
            if (!Number.isFinite(cookbookId) || ids.length === 0) return { error: 'cookbook_id and recipe_ids required' };
            const res = await NtApi.addRecipesToCookbook(cookbookId, ids);
            return { ok: true, added: res.added };
          } catch (e) { return { error: e.message || 'Failed' }; }
        }
        case 'import_recipe_from_url': {
          try {
            const url = (args?.url || '').toString().trim();
            if (!url) return { error: 'url required' };
            const opts = {
              addToPantry: args?.add_to_pantry !== false,
              applyTags:   args?.apply_tags === true,
            };
            const created = await NtApi.scrapeRecipe(url, opts);
            return { ok: true, recipe: { id: created.id, name: created.name, source_url: created.source_url } };
          } catch (e) { return { error: e.message || 'Could not import' }; }
        }
        case 'create_recipe': {
          try {
            if (!args?.name)        return { error: 'name required' };
            if (!Array.isArray(args.ingredients)) return { error: 'ingredients required' };
            if (!Array.isArray(args.steps))       return { error: 'steps required' };
            const payload = {
              name: args.name,
              description: args.description || null,
              servings: args.servings || null,
              yield_text: args.yield_text || null,
              prep_minutes: args.prep_minutes || null,
              cook_minutes: args.cook_minutes || null,
              ingredients: args.ingredients,
              steps: args.steps,
              tags: Array.isArray(args.tags) ? args.tags : [],
              tools: Array.isArray(args.tools) ? args.tools : [],
              source_url: args.source_url || null,
              notes: args.notes || null,
            };
            const created = await NtApi.createRecipe(payload);
            return { ok: true, recipe: { id: created.id, name: created.name } };
          } catch (e) { return { error: e.message || 'Failed' }; }
        }

        default:
          return { error: `Unknown tool: ${name}` };
      }
    });
  });

  function _summariseRecipe(r) {
    return {
      id: r.id,
      name: r.name,
      description: r.description || null,
      servings: r.servings,
      prep_minutes: r.prep_minutes,
      cook_minutes: r.cook_minutes,
      rest_minutes: r.rest_minutes,
      total_minutes: r.total_minutes != null ? r.total_minutes : (r.prep_minutes || 0) + (r.cook_minutes || 0) + (r.rest_minutes || 0),
      rating: r.rating,
      favorite: !!r.favorite,
      last_cooked_at: r.last_cooked_at,
      cook_count: r.cook_count,
      category: r.category?.name || null,
      tags: r.tags || [],
      pantry_match: r.pantry_match || null,
    };
  }

  function _fullRecipe(r) {
    return {
      ..._summariseRecipe(r),
      yield_text: r.yield_text,
      ingredients: r.ingredients || [],
      steps: r.steps || [],
      tools: r.tools || [],
      source_url: r.source_url,
      notes: r.notes,
      nutrition: r.nutrition || null,
    };
  }

  function _systemPrompt(smartLog = false) {
    const today = new Date().toISOString().slice(0, 10);
    const energy = $energyUnit === 'kJ' ? 'kilojoules (kJ)' : 'kilocalories (kcal)';
    const sys = $measurementSystem === 'metric' ? 'metric (g, ml, °C)' : 'imperial (oz, cup, lb, °F)';
    const smartLogPreamble = smartLog ? `

[SMART LOG] The user dictated this with voice. Don't ask for confirmation — IMMEDIATELY call the right tool to act on it (cook log, pantry update, shopping list add, plan a cook, mark out of stock, search recipes, etc.). After acting, summarise the result in one short sentence. Examples:
- "I cooked the lasagna" → get_recipes → log_cook → "Logged Lasagna as cooked today (cook count now 4)."
- "Add bananas to my shopping list" → add_to_shopping → "Added 'bananas' to your shopping list."
- "I'm out of eggs" → get_pantry q='eggs' → set_pantry_stock in_stock=false → "Marked Eggs as out of stock."
- "I need a quick Italian meal under 30 minutes" → create_recipe with a generated recipe matching the criteria → "Created 'Quick Cacio e Pepe' (10 min prep, 15 min cook)."` : '';
    return `You are ${assistantName}, the cooking assistant inside CookTrace. You help with planning, cooking, scaling, substitutions, pantry management, and recipe discovery.${smartLogPreamble}

Today is ${today}. The user prefers ${sys} measurements and ${energy} for energy values. The user's date format is ${$dateFormat}.

You have tool access to the user's recipe library, pantry, cook diary, shopping list, and cookbooks. ALWAYS use tools to get real data instead of guessing. Examples:
- "What can I cook tonight?" → call find_recipes_from_pantry, then propose a few candidates with their have/need ratio
- "Do I have eggs?" → call get_pantry with query='eggs'
- "I just made the lasagna" → call get_recipes to find it, then log_cook
- "Add tomatoes and onions to my list" → call add_to_shopping with the items
- User pastes a recipe URL → call import_recipe_from_url to scrape and save it
- User attaches a photo of a cookbook page → call create_recipe to import it (extract name, ingredients, steps as best you can)
- User dictates a recipe by voice ("Here's how I make my chili: ...") → call create_recipe with the parsed ingredients and steps
- "I'm out of butter" → call get_pantry with query='butter' to find the id, then set_pantry_stock with in_stock=false
- "Plan tacos for Friday" → call get_recipes to find the recipe, then plan_cook with that date
- "What are my favorites?" / "Pick a favorite for tonight" → call get_recipes and filter where favorite is true

When you write to the user's data, summarise what you did briefly and concretely (e.g. "Logged 'Spaghetti Bolognese' as cooked today, count is now 7"). Keep replies short and actionable. Use the user's preferred units. If a tool returns { error: ... }, tell the user what went wrong and how to fix it.`;
  }

  async function send({ smartLog = false } = {}) {
    const text = input.trim();
    if ((!text && !attachedImage) || busy) return;
    if (!$aiEnabled) {
      showError($_('trace_ai_ct.toast.trace_disabled'));
      return;
    }
    input = '';
    const userMsg = { role: 'user', content: text || '(image attached)', time: _fmtTime() };
    if (smartLog) userMsg.smartLog = true; // visual hint badge in bubble
    if (attachedImage) userMsg.preview = attachedImage.preview;
    messages = [...messages, userMsg];
    // Persist the user turn to the server so other browsers / devices
    // pick it up on next load. Fire-and-forget — failure isn't fatal,
    // it just means this turn won't survive a refresh. Mirrors NT's
    // chat-history persistence shape exactly.
    NtApi.post('/api/ai/history', { role: 'user', content: userMsg.content })
      .catch(e => console.warn('[Trace] history save (user) failed:', e?.message || e));
    busy = true;
    toolStatus = '';
    await tick(); _scrollToBottom();

    try {
      const provider = $aiProvider;
      const apiKey = $aiApiKey;
      const model = $aiModel || AI_DEFAULT_MODELS[provider] || '';
      const baseUrl = $aiBaseUrl;
      const apiMessages = messages.map(m => ({ role: m.role, content: m.content })).slice(-20);
      // Inline the image into the last user message in the provider's format.
      if (attachedImage) {
        const lastIdx = apiMessages.length - 1;
        apiMessages[lastIdx] = _buildImageMessage(provider, text || 'Have a look at this.', attachedImage);
      }
      const reply = aiEnvLocked
        ? await callAIProxy({ messages: apiMessages, systemPrompt: _systemPrompt(smartLog) })
        : await callAI({
            provider, apiKey, model, baseUrl,
            messages: apiMessages,
            systemPrompt: _systemPrompt(smartLog),
            tools: TOOLS,
            onToolCall: (toolName) => { toolStatus = `Calling ${toolName.replace(/_/g, ' ')}…`; },
          });
      const reply2 = reply || '(no response)';
      messages = [...messages, { role: 'assistant', content: reply2, time: _fmtTime() }];
      NtApi.post('/api/ai/history', { role: 'assistant', content: reply2 })
        .catch(e => console.warn('[Trace] history save (assistant) failed:', e?.message || e));
    } catch (e) {
      messages = [...messages, { role: 'assistant', content: `⚠ ${e.message || 'AI request failed'}`, time: _fmtTime() }];
    } finally {
      busy = false;
      toolStatus = '';
      attachedImage = null;
      await tick(); _scrollToBottom();
    }
  }
  // Used by Smart Log auto-submit. Same as send() but flagged so the
  // system prompt nudges Trace toward immediate tool execution.
  function sendMessage(opts = {}) { return send(opts); }

  function _buildImageMessage(provider, text, image) {
    if (provider === 'claude') {
      return { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } },
        { type: 'text', text },
      ]};
    } else if (provider === 'openai' || provider === 'custom' || provider === 'oai-compat') {
      return { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
        { type: 'text', text },
      ]};
    } else if (provider === 'gemini') {
      return { role: 'user', content: text, _image: image };
    }
    return { role: 'user', content: text };
  }

  // ── Voice smart-logging ────────────────────────────────────────────
  // Tap the mic to start recording. Tap again (or stop talking for ~2s)
  // and the transcript drops into the input field with the chat panel
  // already open so the user can review + tweak before hitting send.
  // Uses Web Speech API; gracefully degrades to a "not supported"
  // toast on browsers without it.
  let recording = false;
  let _speechRec = null;
  let _speechSupported = (typeof window !== 'undefined') && (window.SpeechRecognition || window.webkitSpeechRecognition);
  // True when the current recording was kicked off by Smart Log (auto-
  // submit on stop). Cleared after each session.
  let _smartLogActive = false;

  function _toggleVoice() {
    if (!_speechSupported) {
      showError($_('trace_ai_ct.toast.voice_unsupported_full'));
      return;
    }
    if (recording) { _stopVoice(); return; }
    _startVoice({ smartLog: false });
  }
  // Smart Log entry: long-press / hold the mic button. Records, stops
  // when the user releases, and auto-submits to Trace with a system
  // prompt that nudges it to call the right tool (cook log, pantry
  // update, shopping add, etc.) and confirm in the response.
  function _startSmartLog() {
    if (!$smartLogEnabled) {
      _startVoice({ smartLog: false });
      return;
    }
    if (recording) return;
    input = '';                         // smart log replaces, never appends
    _startVoice({ smartLog: true });
  }
  function _endSmartLog() {
    if (!recording) return;
    _stopVoice();
  }
  // Shared post-record handler — fires after a successful or partial
  // transcript. Identical for both backends so the UI flow stays
  // consistent. `fromHold=true` means the FAB hold gesture, where the
  // panel needs to surface on commit.
  function _handleTranscript(text, { smartLog, fromHold, alreadyComposed = false }) {
    recording = false;
    _fabRecording = false;
    // Native path passes the raw transcript and we apply the voice
    // prefix here. Web path streams into `input` live via onresult, so
    // alreadyComposed=true skips the re-prefix.
    if (!alreadyComposed && text) {
      input = _voicePrefix !== null ? `${_voicePrefix}${text}`.trim() : text;
    }
    _voicePrefix = null;
    if (smartLog) {
      _smartLogActive = false;
      setTimeout(() => {
        if (!_commitNextTranscript) return; // user cancelled mid-record
        if (input?.trim()) {
          if (fromHold) panelOpen = true;
          sendMessage({ smartLog: true });
        }
      }, 60);
    }
  }

  function _startVoice({ smartLog = false, fromHold = false } = {}) {
    _voicePrefix = input ? `${input} ` : '';
    _smartLogActive = !!smartLog;
    recording = true;
    if (!fromHold) panelOpen = true;

    // Web Speech API path — works on both PWA and Android WebView now
    // that the manifest declares RECORD_AUDIO + MODIFY_AUDIO_SETTINGS
    // and the <queries> RecognitionService block. The native plugin
    // (@capacitor-community/speech-recognition) was considered but
    // ships with a proguard config that AGP 9 rejects; not worth a
    // gradle patch when the WebView path works fine.
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      recording = false; _fabRecording = false; _smartLogActive = false;
      showError($_('trace_ai_ct.toast.voice_unsupported'));
      return;
    }
    try {
      const rec = new SR();
      rec.continuous = false;
      rec.interimResults = true;   // live update while speaking for snappy feedback
      rec.lang = navigator.language || 'en-US';
      rec.onresult = (e) => {
        let text = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          text += e.results[i][0]?.transcript || '';
        }
        // Append to whatever was there before recording started so we
        // don't clobber a partial prompt.
        if (_voicePrefix !== null) input = `${_voicePrefix}${text}`.trim();
        else input = text;
      };
      rec.onerror = (e) => {
        recording = false;
        _fabRecording = false; // sync the FAB pulse state with the actual recorder
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          // Web Speech API is gated to secure contexts. Plain HTTP
          // (LAN dev, INSECURE_COOKIES installs) silently denies the
          // mic with this error. Surface it explicitly.
          if (typeof window !== 'undefined' && !window.isSecureContext) {
            showError($_('trace_ai_ct.toast.voice_needs_https_smart'));
          } else {
            showError($_('trace_ai_ct.toast.mic_denied'));
          }
        } else if (e.error !== 'aborted') {
          showError(`Voice error: ${e.error || 'unknown'}`);
        }
      };
      rec.onend = () => {
        // Web path runs through the shared transcript handler — `input`
        // has been updated live via onresult, so just commit it.
        _handleTranscript(input, { smartLog, fromHold, alreadyComposed: true });
      };
      _speechRec = rec;
      rec.start();
    } catch (e) {
      recording = false;
      _smartLogActive = false;
      showError(`Could not start mic: ${e.message || ''}`);
    }
  }
  function _stopVoice() {
    if (_speechRec) {
      try { _speechRec.stop(); } catch {}
      _speechRec = null;
    }
  }
  let _voicePrefix = null;

  let _imageInput;
  function _attachClick() { _imageInput?.click(); }
  function _onImagePicked(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) { showError($_('trace_ai_ct.toast.pick_image')); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = String(dataUrl).split(',')[1] || '';
      attachedImage = { base64, mimeType: f.type || 'image/jpeg', preview: dataUrl };
    };
    reader.readAsDataURL(f);
    e.target.value = '';
  }
  function _clearImage() { attachedImage = null; }

  function _scrollToBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  // Fetch persisted history and replace local messages. Called once
  // on mount, and again every time the chat panel opens so messages
  // sent from another browser / device show up without a full refresh.
  // No-op if nothing's persisted; never throws — failure logs to
  // console.warn for diagnostics.
  let _historyLoading = false;
  async function _loadChatHistory() {
    if (_historyLoading) return;
    _historyLoading = true;
    try {
      const rows = await NtApi.get('/api/ai/history');
      if (Array.isArray(rows)) {
        messages = rows.map(r => ({
          role: r.role,
          content: r.content,
          time: r.created_at ? _fmtFromCreatedAt(r.created_at) : _fmtTime(),
        }));
        await tick(); _scrollToBottom();
      }
    } catch (e) {
      console.warn('[Trace] history load failed:', e?.message || e);
    } finally {
      _historyLoading = false;
    }
  }
  // Re-sync whenever the panel opens. Cheap — server caps history at
  // 200 rows per user. Cross-browser activity (message sent in browser
  // B) shows up the next time browser A opens the chat without
  // requiring a full page refresh.
  let _wasPanelOpen = false;
  $: if (panelOpen && !_wasPanelOpen) {
    _wasPanelOpen = true;
    _loadChatHistory();
  } else if (!panelOpen) {
    _wasPanelOpen = false;
  }

  function _fmtTime() {
    const d = new Date();
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  }
  // SQLite stores created_at as `YYYY-MM-DD HH:MM:SS` UTC (no zone).
  // Append Z to parse as UTC, then format in the local timezone so
  // historical messages display the user's wall-clock time.
  function _fmtFromCreatedAt(iso) {
    if (!iso) return _fmtTime();
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return _fmtTime();
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  }
  async function clearChat() {
    if (!await confirmDialog({
      title: $_('trace.clear_confirm_title'),
      message: $_('trace.clear_confirm_message'),
      confirmText: $_('trace.clear_confirm_ok'),
      dangerous: true,
    })) return;
    messages = [];
    // Wipe server-side history too so the cleared state survives a
    // reload + travels across other browsers / devices.
    NtApi.del('/api/ai/history').catch(() => {});
  }
  // Welcome-screen quick-chip helper. Drops the canned text into the
  // input and fires send so the user gets a response without a second
  // tap. Mirrors NutriTrace's quickAsk pattern.
  function quickAsk(q) { input = q; send(); }
</script>

{#if $aiEffectivelyEnabled && (aiEnvLocked || $aiKeyVerified)}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <!-- Rendered as a <div> instead of <button> because Android WebView's
       native button gesture handling interferes with pointerdown/move/up
       sequencing during a long-press — the hold timer was silently
       cancelled before its 600ms threshold. Matches NutriTrace's
       Trace.svelte which uses the same pattern. role/tabindex preserve
       the accessibility surface. -->
  <div
    class="fab"
    class:open={panelOpen}
    class:recording={_fabRecording}
    class:cancel-preview={_fabCancelPreview}
    style={fabStyle}
    on:pointerdown={startDrag}
    on:click={onFabClick}
    on:keydown={e => e.key === 'Enter' && onFabClick()}
    role="button"
    tabindex="0"
    aria-label={_fabRecording ? 'Recording — release to send' : (panelOpen ? `Close ${assistantName}` : `Open ${assistantName}`)}
    title={_fabRecording ? 'Recording…' : (panelOpen ? `Hide ${assistantName}` : `Hold to Smart Log, tap to chat`)}
  >
    {#if _fabRecording}
      <span class="material-symbols-rounded fab-mic">mic</span>
    {:else if panelOpen}
      <span class="material-symbols-rounded">close</span>
    {:else}
      <svelte:component this={Mascot} />
    {/if}
  </div>

  <!-- Recording hint pill — centered above the FAB while recording.
       Tells the user how to commit or cancel without obscuring the
       FAB itself. Position math: FAB width 64px → center at +32. When
       FAB has been repositioned, the inline style overrides with the
       dragged coordinates. Ported from NutriTrace for parity. -->
  {#if _fabRecording}
    <div
      class="fab-record-hint"
      class:cancel={_fabCancelPreview}
      style={fabPos ? `left:${fabPos.x + 32}px; top:${fabPos.y - 44}px; right:auto; transform:translateX(-50%);` : ''}
    >
      {#if _fabCancelPreview}
        ✕ Release to Cancel
      {:else}
        ● Listening… Release to Send
      {/if}
    </div>
  {/if}

  {#if panelOpen}
    <!-- Backdrop — mobile only via CSS gate. Tap to dismiss. -->
    <div
      class="panel-backdrop"
      use:portal
      transition:fade={{ duration: 200 }}
      on:click={() => panelOpen = false}
      on:keydown={() => {}}
      role="button"
      tabindex="-1"
      aria-label="Close chat"
    ></div>

    <div class="panel" use:portal
      transition:fly={{ y: 600, duration: 320, easing: cubicOut }}>
      <!-- Drag handle indicator (mobile only). -->
      <div class="panel-drag-handle" aria-hidden="true"></div>
      <header class="panel-header">
        <div class="panel-brand">
          <div class="panel-avatar">
            <svelte:component this={Mascot} size={32} />
          </div>
          <div>
            <div class="panel-name">{assistantName}</div>
            <div class="panel-sub">{$_('trace.panel_sub')}</div>
          </div>
        </div>
        <div class="panel-header-actions">
          <!-- Clear chat is always visible (NT parity). Tapping with
               no messages is a no-op; the consistent affordance is
               worth the small footprint. -->
          <button class="btn-icon" on:click={clearChat} aria-label="Clear Chat" title="Clear Chat">
            <span class="material-symbols-rounded">delete_sweep</span>
          </button>
          <button class="btn-icon" on:click={() => panelOpen = false} aria-label="Close" title="Close">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
      </header>

      <div class="panel-body" bind:this={messagesEl}>
        {#if messages.length === 0}
          <!-- Welcome screen — animated TraceFace + greeting + quick-chip
               starters. Mirrors NutriTrace's Trace welcome layout for
               brand cohesion; chips swapped for cooking-relevant prompts. -->
          <div class="ai-welcome">
            <div class="ai-welcome-avatar">
              <svelte:component this={Mascot} size={56} />
            </div>
            <p class="ai-welcome-name">{$_('trace.welcome_name', { values: { name: assistantName } })}</p>
            <p class="ai-welcome-desc">
              {$_('trace.welcome_desc')}
            </p>
            <div class="ai-quick-chips">
              <button class="ai-chip" on:click={() => quickAsk($_('trace.chip_pantry_ask'))}>
                {$_('trace.chip_pantry')}
              </button>
              <button class="ai-chip" on:click={() => quickAsk($_('trace.chip_suggestion_ask'))}>
                {$_('trace.chip_suggestion')}
              </button>
              <button class="ai-chip" on:click={() => quickAsk($_('trace.chip_recent_ask'))}>
                {$_('trace.chip_recent')}
              </button>
              <button class="ai-chip" on:click={() => quickAsk($_('trace.chip_shopping_ask'))}>
                {$_('trace.chip_shopping')}
              </button>
            </div>
          </div>
        {/if}
        {#each messages as m}
          <div class="msg" class:user={m.role === 'user'} class:assistant={m.role === 'assistant'}>
            {#if m.role === 'assistant'}
              <div class="msg-avatar"><svelte:component this={Mascot} size={24} /></div>
            {/if}
            <div class="bubble">
              {#if m.preview}
                <img class="msg-img" src={m.preview} alt="" />
              {/if}
              {m.content}
            </div>
          </div>
        {/each}
        {#if busy}
          <div class="msg assistant">
            <div class="msg-avatar"><svelte:component this={Mascot} size={24} /></div>
            <div class="bubble typing">
              {#if toolStatus}
                <span class="tool-status">{toolStatus}</span>
              {:else}
                <span class="dots"><span></span><span></span><span></span></span>
              {/if}
            </div>
          </div>
        {/if}
      </div>

      {#if attachedImage}
        <div class="image-preview">
          <img src={attachedImage.preview} alt="" />
          <button class="image-clear" on:click={_clearImage} aria-label="Remove image">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
      {/if}

      <footer class="panel-input">
        <input type="file" accept="image/*" bind:this={_imageInput} on:change={_onImagePicked} style="display:none" />
        <button class="attach-btn" on:click={_attachClick} disabled={busy}
          aria-label="Attach Image" title="Attach Image">
          <span class="material-symbols-rounded">photo_camera</span>
        </button>
        <!-- In-chat voice button removed for parity with NutriTrace +
             LiftTrace. Voice input lives only on the FAB hold gesture
             (Smart Log) and on dedicated voice surfaces (Smart Log
             modal), not duplicated inside the chat composer. -->

        <textarea
          class="input"
          rows="1"
          bind:value={input}
          placeholder={recording ? $_('trace.listening') : $_('trace.ask_placeholder', { values: { name: assistantName } })}
          on:keydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={busy}
        ></textarea>
        <button class="send-btn" on:click={send}
          disabled={busy || (!input.trim() && !attachedImage)}
          aria-label="Send">
          <span class="material-symbols-rounded">arrow_upward</span>
        </button>
      </footer>
    </div>
  {/if}
{/if}

<style>
  /* FAB styling ported from NutriTrace's .ai-fab for TraceApps brand
     cohesion: animated 4-stop gradient (gradient-shift), continuous
     concentric ring-pulse glow, inner glass highlight via ::before,
     red recording state with its own ring-pulse, and a greyed
     cancel-preview state. */
  .fab {
    position: fixed;
    bottom: calc(var(--nav-h) + var(--safe-bottom, 0px) + 20px);
    right: 20px;
    width: 60px;
    height: 60px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2), var(--accent), var(--accent-2), var(--accent));
    background-size: 300% 300%;
    color: var(--accent-text);
    border: 1px solid rgba(255,255,255,0.25);
    backdrop-filter: blur(12px) saturate(180%);
    -webkit-backdrop-filter: blur(12px) saturate(180%);
    cursor: pointer;
    z-index: 400;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow:
      0 8px 32px rgba(0,0,0,0.35),
      inset 0 1px 0 rgba(255,255,255,0.35),
      inset 0 -2px 6px rgba(0,0,0,0.15);
    animation:
      gradient-shift 8s ease-in-out infinite,
      ring-pulse 2.6s ease-out infinite;
    transition: transform 0.18s ease, box-shadow 0.18s ease;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
    touch-action: none;
    overflow: visible;
  }
  /* Inner glass highlight overlay — matches NT exactly. */
  .fab::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45), rgba(255,255,255,0) 55%);
    pointer-events: none;
  }
  .fab:hover {
    transform: scale(1.08);
    box-shadow:
      0 12px 36px rgba(0,0,0,0.45),
      inset 0 1px 0 rgba(255,255,255,0.4),
      0 0 0 8px var(--accent-dim, color-mix(in srgb, var(--accent) 22%, transparent));
  }
  .fab:active { transform: scale(0.94); }
  .fab.open {
    animation: gradient-shift 8s ease-in-out infinite;
  }
  .fab .material-symbols-rounded {
    font-size: 26px;
    color: var(--accent-text, #fff);
    position: relative;
    z-index: 1;
  }

  /* Recording state — TraceFace morphs to mic icon. FAB turns red
     (universal "recording" color), gets a strong heartbeat ring,
     and scales up 8% for unambiguous live feedback. */
  .fab.recording {
    transform: scale(1.08);
    background: linear-gradient(135deg, #ef4444, #b91c1c, #ef4444, #dc2626, #ef4444);
    background-size: 300% 300%;
    border-color: rgba(255, 200, 200, 0.45);
    animation:
      gradient-shift 4s ease-in-out infinite,
      ring-pulse-record 1.1s ease-out infinite;
  }
  /* Cancel-preview state — finger has slid > CANCEL_RADIUS_PX from FAB.
     Greys out so the user knows releasing now will abort. */
  .fab.recording.cancel-preview {
    background: linear-gradient(135deg, #6b7280, #374151);
    border-color: rgba(255, 255, 255, 0.18);
    animation: gradient-shift 4s ease-in-out infinite;
    transform: scale(1.0);
    opacity: 0.85;
  }
  .fab-mic {
    color: var(--accent-text, #fff);
    position: relative;
    z-index: 1;
    filter: drop-shadow(0 1px 3px rgba(0,0,0,0.4));
    animation: mic-pulse 0.9s ease-in-out infinite;
    font-size: 30px;
  }
  @keyframes mic-pulse {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(1.12); }
  }
  /* Recording hint pill — centered above the FAB during the hold-to-
     record gesture. Switches text + color when the finger has slid
     into cancel-preview range so the user can see what releasing now
     will do. Ported from NutriTrace for gesture parity. */
  .fab-record-hint {
    position: fixed;
    right: 52px;
    transform: translateX(50%);
    bottom: calc(var(--nav-h, 0px) + var(--safe-bottom, 0px) + 92px);
    padding: 8px 16px;
    border-radius: 16px;
    background: rgba(0, 0, 0, 0.82);
    backdrop-filter: blur(10px) saturate(180%);
    -webkit-backdrop-filter: blur(10px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.18);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.2;
    color: #ffffff;
    z-index: 401;
    pointer-events: none;
    white-space: nowrap;
    text-align: center;
    box-shadow: 0 4px 18px rgba(0,0,0,0.45);
    animation: fab-hint-fade 0.18s ease-out;
  }
  .fab-record-hint.cancel {
    color: #fca5a5;
    border-color: rgba(252, 165, 165, 0.35);
  }
  @keyframes fab-hint-fade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  @keyframes gradient-shift {
    0%, 100% { background-position: 0% 50%; }
    50%      { background-position: 100% 50%; }
  }
  /* Concentric ring pulse — heartbeat outward, theme accent. This is
     the glow effect NT and LT have on every FAB. */
  @keyframes ring-pulse {
    0%   { box-shadow:
             0 8px 32px rgba(0,0,0,0.35),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.15),
             0 0 0 0 var(--accent-dim, color-mix(in srgb, var(--accent) 35%, transparent)); }
    70%  { box-shadow:
             0 8px 32px rgba(0,0,0,0.35),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.15),
             0 0 0 16px transparent; }
    100% { box-shadow:
             0 8px 32px rgba(0,0,0,0.35),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.15),
             0 0 0 0 transparent; }
  }
  /* Red recording ring pulse — same heartbeat, red instead of accent. */
  @keyframes ring-pulse-record {
    0%   { box-shadow:
             0 8px 32px rgba(0,0,0,0.4),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.2),
             0 0 0 0 rgba(239, 68, 68, 0.55); }
    70%  { box-shadow:
             0 8px 32px rgba(0,0,0,0.4),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.2),
             0 0 0 22px rgba(239, 68, 68, 0); }
    100% { box-shadow:
             0 8px 32px rgba(0,0,0,0.4),
             inset 0 1px 0 rgba(255,255,255,0.35),
             inset 0 -2px 6px rgba(0,0,0,0.2),
             0 0 0 0 rgba(239, 68, 68, 0); }
  }

  /* Mobile backdrop — dimmed overlay behind the bottom sheet so the
     chat reads as a full-attention surface. Hidden on desktop where
     the panel sits as a companion card over content. Mirrors NT's
     ai-backdrop. */
  .panel-backdrop {
    position: fixed; inset: 0;
    background: var(--overlay);
    backdrop-filter: var(--backdrop-blur);
    -webkit-backdrop-filter: var(--backdrop-blur);
    z-index: 440;
  }
  @media (min-width: 769px) {
    .panel-backdrop { display: none; }
  }

  /* Drag handle — shown on mobile as the bottom-sheet affordance. */
  .panel-drag-handle {
    width: 40px; height: 4px;
    border-radius: 2px;
    background: var(--text-3);
    opacity: 0.4;
    margin: 8px auto 4px;
    flex-shrink: 0;
  }

  /* Chat panel — mobile-first bottom sheet (full width, 88vh tall,
     rounded top corners, slides up from below). Desktop floats as a
     420 px card anchored bottom-right. Mirrors NT 1:1 for cross-app
     visual cohesion. */
  .panel {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    top: auto;
    width: 100%;
    height: 88vh;
    max-height: 88vh;
    background: var(--surface-1);
    border-top: 1px solid var(--border);
    border-radius: 20px 20px 0 0;
    z-index: 450;
    display: flex;
    flex-direction: column;
    box-shadow: 0 -8px 40px rgba(0,0,0,0.4);
    padding-bottom: var(--safe-bottom, 0px);
    overflow: hidden;
  }
  @media (min-width: 769px) {
    .panel {
      left: auto;
      right: 24px;
      bottom: calc(var(--nav-h, 0px) + var(--safe-bottom, 0px) + 96px);
      top: auto;
      width: 420px;
      height: min(640px, 80vh);
      max-height: 80vh;
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.45);
    }
    .panel-drag-handle { display: none; }
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }
  .panel-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 700;
    color: var(--text-1);
  }
  /* Brand block in the header — TraceFace avatar + stacked name/sub.
     Matches NutriTrace's Trace panel-header layout 1:1 for cross-app
     visual cohesion. */
  .panel-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .panel-avatar {
    width: 40px; height: 40px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .panel-name { font-weight: 700; color: var(--text-1); font-size: 14px; line-height: 1.2; }
  .panel-sub { color: var(--text-3); font-size: 11px; line-height: 1.3; }
  .panel-header-actions { display: flex; gap: 4px; }

  /* Welcome screen — large face + greeting + quick-chip starters. */
  .ai-welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 32px 20px;
    gap: 12px;
  }
  .ai-welcome-avatar {
    width: 72px; height: 72px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 4px;
  }
  .ai-welcome-name {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--text-1);
  }
  .ai-welcome-desc {
    margin: 0;
    color: var(--text-3);
    font-size: 13px;
    line-height: 1.5;
    max-width: 360px;
  }
  .ai-quick-chips {
    display: flex; flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-top: 6px;
  }
  .ai-chip {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-1);
    font-family: inherit;
    cursor: pointer;
    transition: background var(--dur-fast), border-color var(--dur-fast);
  }
  .ai-chip:hover {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }

  /* Per-message avatar — only rendered on assistant rows so the
     bubble has a small face anchor on its left. */
  .msg.assistant { gap: 8px; align-items: flex-end; }
  .msg-avatar {
    width: 28px; height: 28px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .bubble.typing { display: inline-flex; align-items: center; min-height: 32px; padding: 8px 14px; }
  .btn-icon {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3); padding: 4px;
    border-radius: var(--radius-sm);
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .btn-icon:hover { color: var(--text-1); background: var(--surface-2); }
  .btn-icon .material-symbols-rounded { font-size: 18px; }

  .panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--bg);
  }

  .msg { display: flex; }
  .msg.user { justify-content: flex-end; }
  .msg.assistant { justify-content: flex-start; }
  .bubble {
    max-width: 85%;
    padding: 9px 12px;
    border-radius: 14px;
    font-size: 14px;
    line-height: 1.45;
    word-wrap: break-word;
    white-space: pre-wrap;
  }
  .msg.user .bubble {
    background: var(--accent);
    color: var(--accent-text, #0A0B0F);
    border-bottom-right-radius: 4px;
  }
  .msg.assistant .bubble {
    background: var(--surface-1);
    color: var(--text-1);
    border: 1px solid var(--border);
    border-bottom-left-radius: 4px;
  }
  .msg-img {
    display: block;
    max-width: 100%;
    border-radius: 8px;
    margin-bottom: 6px;
  }
  .tool-status {
    color: var(--text-3);
    font-size: 12px;
    font-style: italic;
  }

  .dots { display: inline-flex; gap: 3px; }
  .dots span {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--text-3);
    animation: dot 1.2s ease-in-out infinite;
  }
  .dots span:nth-child(2) { animation-delay: 0.15s; }
  .dots span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes dot {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40%           { opacity: 1;   transform: scale(1); }
  }

  .image-preview {
    position: relative;
    margin: 6px 12px 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .image-preview img { display: block; width: 100%; max-height: 120px; object-fit: cover; }
  .image-clear {
    position: absolute; top: 6px; right: 6px;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    border: none;
    border-radius: 50%;
    width: 24px; height: 24px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .image-clear .material-symbols-rounded { font-size: 14px; }

  /* Input bar — NT parity: 12 x 16 padding, 8 px gap, align flex-end so
     the round attach + send buttons sit flush with the bottom of a
     multi-line textarea. */
  .panel-input {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    background: var(--surface-1);
    flex-shrink: 0;
  }
  /* Attach (photo_camera) — round, border-only, accent on hover. */
  .attach-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 50%;
    width: 40px; height: 40px;
    cursor: pointer;
    color: var(--text-3);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: color var(--dur-fast), border-color var(--dur-fast);
  }
  .attach-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
  .attach-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .attach-btn .material-symbols-rounded { font-size: 20px; }
  .mic-btn.recording {
    background: color-mix(in srgb, var(--error, #ef4444) 18%, transparent);
    border-color: var(--error, #ef4444);
    color: var(--error, #ef4444);
    animation: micPulse 1.2s ease-in-out infinite;
  }
  /* Smart Log session — same red ring but accented so it's distinct
     from a plain dictation session. */
  .mic-btn.recording.smart-log {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    border-color: var(--accent);
    color: var(--accent);
    animation: smartLogPulse 1.2s ease-in-out infinite;
  }
  @keyframes micPulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--error, #ef4444) 50%, transparent); }
    50%      { box-shadow: 0 0 0 6px color-mix(in srgb, var(--error, #ef4444) 0%, transparent); }
  }
  @keyframes smartLogPulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent); }
    50%      { box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 0%, transparent); }
  }
  /* Textarea — NT parity: stronger border, more rounded, taller line
     height, max 120 px scroll. */
  .input {
    flex: 1;
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    padding: 10px 14px;
    color: var(--text-1);
    font-family: inherit;
    font-size: 14px;
    line-height: 1.5;
    resize: none;
    max-height: 120px;
    overflow-y: auto;
    transition: border-color var(--dur-fast);
  }
  .input:focus { outline: none; border-color: var(--accent); }
  .input::placeholder { color: var(--text-3); }
  /* Send (paper plane) — round, gradient accent fill, scale-up on
     hover and scale-down on active. Matches NT exactly. */
  .send-btn {
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: var(--accent-text, #0A0B0F);
    border: none;
    border-radius: 50%;
    width: 40px; height: 40px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: transform var(--dur-fast), opacity var(--dur-fast);
  }
  .send-btn:disabled { opacity: 0.4; cursor: default; }
  .send-btn:not(:disabled):hover  { transform: scale(1.08); }
  .send-btn:not(:disabled):active { transform: scale(0.94); }
  .send-btn .material-symbols-rounded { font-size: 20px; }
</style>
