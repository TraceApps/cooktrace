<!--
  TopTimerPill — global floating cook-timer rail.

  Lives once at the App.svelte root so a timer started on a recipe page
  follows the user to Pantry / Diary / Shopping / Settings without
  losing its progress. Multiple concurrent timers stack vertically
  inside a single rail so cooking-in-parallel reads at a glance.

  Each pill shows: a 44px circular progress ring with the live MM:SS
  countdown, a centered two-line label (recipe name kicker on top, step
  title below), and +1 / × actions on the right.

  The whole rail is draggable to any spot in the viewport — the drag
  handle is the name strip (the +1 / × / step-link controls stay
  tappable). Position persists in localStorage and is clamped back into
  view on resize.
-->
<script>
  import { _ } from 'svelte-i18n';
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { onMount, onDestroy } from 'svelte';
  import { cookTimers, dismissTimer, addOneMinute, formatRemaining } from '../../stores/cookTimers.js';

  $: visible = ($cookTimers || []).filter(t => !t.dismissed);

  function progressPct(t) {
    if (!t || !Number.isFinite(t.durationSec) || t.durationSec <= 0) return 100;
    if (t.done) return 100;
    const elapsed = (Date.now() - t.startedAt) / 1000;
    return Math.min(100, Math.max(0, (elapsed / t.durationSec) * 100));
  }

  // Tap the step name to scroll the originating <li id="step-N"> into
  // view in RecipeView. No-ops when the user isn't on the recipe page;
  // the rail is global, so this is best-effort.
  function jumpToStep(stepIndex) {
    if (typeof document === 'undefined' || stepIndex == null) return;
    const el = document.getElementById(`step-${stepIndex}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('step-flash');
    setTimeout(() => el.classList.remove('step-flash'), 1400);
  }

  // ── Position + drag-and-drop ─────────────────────────────────────
  // Default: top-center, just under the safe-area / topbar. Persists
  // a single {x,y} for the whole rail so multi-timer order stays
  // intact when the user repositions.
  const POS_KEY = 'ct:timer-rail-pos';
  let pos = null;            // { x, y } or null = use default top-center
  let railEl;
  let dragging = false;
  let dragStart = null;      // { startX, startY, originX, originY }

  function _loadPos() {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return v;
    } catch {}
    return null;
  }
  function _savePos(v) {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(POS_KEY, JSON.stringify(v)); } catch {}
  }
  function _clamp(v) {
    if (!v || !railEl) return v;
    const r = railEl.getBoundingClientRect();
    const m = 8;
    const maxX = window.innerWidth  - r.width  - m;
    const maxY = window.innerHeight - r.height - m;
    return { x: Math.max(m, Math.min(v.x, maxX)), y: Math.max(m, Math.min(v.y, maxY)) };
  }

  function _onDown(e) {
    if (!railEl) return;
    // Start the drag only when the gesture begins on the handle area;
    // children with the .no-drag class (action buttons, step links)
    // bubble through to their own click handlers.
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const point = e.touches ? e.touches[0] : e;
    const r = railEl.getBoundingClientRect();
    dragging = true;
    dragStart = { startX: point.clientX, startY: point.clientY, originX: r.left, originY: r.top };
    // Initialise pos from current rect so the first frame doesn't jump.
    pos = { x: r.left, y: r.top };
    document.body.classList.add('timer-dragging');
    e.preventDefault();
  }
  function _onMove(e) {
    if (!dragging || !dragStart) return;
    const point = e.touches ? e.touches[0] : e;
    const dx = point.clientX - dragStart.startX;
    const dy = point.clientY - dragStart.startY;
    pos = _clamp({ x: dragStart.originX + dx, y: dragStart.originY + dy });
    if (e.cancelable) e.preventDefault();
  }
  function _onUp() {
    if (!dragging) return;
    dragging = false;
    dragStart = null;
    document.body.classList.remove('timer-dragging');
    if (pos) _savePos(pos);
  }
  function _onResize() {
    if (pos) pos = _clamp(pos);
  }

  onMount(() => {
    pos = _loadPos();
    window.addEventListener('mousemove', _onMove);
    window.addEventListener('mouseup', _onUp);
    window.addEventListener('touchmove', _onMove, { passive: false });
    window.addEventListener('touchend', _onUp);
    window.addEventListener('resize', _onResize);
  });
  onDestroy(() => {
    if (typeof window === 'undefined') return;
    window.removeEventListener('mousemove', _onMove);
    window.removeEventListener('mouseup', _onUp);
    window.removeEventListener('touchmove', _onMove);
    window.removeEventListener('touchend', _onUp);
    window.removeEventListener('resize', _onResize);
  });

  // Default style: top-center via translateX(-50%). Once the user
  // drags, an explicit { left, top } pair takes over.
  $: railStyle = pos
    ? `left:${pos.x}px; top:${pos.y}px; transform:none;`
    : `left:50%; top:calc(env(safe-area-inset-top, 0px) + 56px); transform:translateX(-50%);`;
</script>

{#if visible.length > 0}
  <div class="timer-rail"
    bind:this={railEl}
    style={railStyle}
    class:dragging
    in:fly={{ y: -16, duration: 220, easing: cubicOut }}
    out:fade={{ duration: 140 }}
    on:mousedown={_onDown}
    on:touchstart|nonpassive={_onDown}>
    {#each visible as t (t.id)}
      {@const remaining = Math.max(0, t.endsAt - Date.now())}
      {@const pct = progressPct(t)}
      <div class="pill" class:done={t.done}>
        <!-- When the timer has fired, the whole ring becomes a tap
             target that silences + dismisses the alarm. While running
             it's a plain div so users can long-press / interact with
             the pill body underneath without surprises. -->
        {#if t.done}
          <button type="button" class="ring-wrap no-drag ring-tap"
                  on:click|stopPropagation={() => dismissTimer(t.id)}
                  aria-label="Dismiss timer">
            <svg class="ring" viewBox="0 0 36 36" aria-hidden="true">
              <circle class="ring-track" cx="18" cy="18" r="15.5"/>
              <circle class="ring-arc"   cx="18" cy="18" r="15.5"
                style="stroke-dashoffset: {97.4 - (97.4 * pct) / 100}"/>
            </svg>
            <span class="ring-time pulse">{$_('top_timer_pill.done')}</span>
          </button>
        {:else}
          <div class="ring-wrap">
            <svg class="ring" viewBox="0 0 36 36" aria-hidden="true">
              <circle class="ring-track" cx="18" cy="18" r="15.5"/>
              <circle class="ring-arc"   cx="18" cy="18" r="15.5"
                style="stroke-dashoffset: {97.4 - (97.4 * pct) / 100}"/>
            </svg>
            <span class="ring-time">{formatRemaining(remaining)}</span>
          </div>
        {/if}

        <!-- Drag handle = the centered name strip. Stacks recipe-name
             kicker on top and a "STEP N · Step title" line below as
             the bigger primary label. Whole strip taps to scroll to
             the originating step in RecipeView. -->
        <button type="button"
          class="pill-text drag-handle"
          class:linked={Number.isFinite(t.stepIndex)}
          on:click={() => jumpToStep(t.stepIndex)}
          title={Number.isFinite(t.stepIndex) ? 'Jump to this step' : t.label}>
          {#if t.recipeName}
            <span class="pill-recipe">{t.recipeName}</span>
          {/if}
          <span class="pill-step-row">
            {#if Number.isFinite(t.stepIndex)}
              <span class="pill-step-badge">Step {t.stepIndex + 1}</span>
            {/if}
            <span class="pill-step">{t.label}</span>
          </span>
        </button>

        <div class="pill-actions no-drag">
          <button class="t-btn" on:click|stopPropagation={() => addOneMinute(t.id)}
            title={t.done ? 'Snooze 1 min' : 'Add 1 min'}>
            +1
          </button>
          <button class="t-btn close" on:click|stopPropagation={() => dismissTimer(t.id)}
            aria-label="Dismiss timer" title="Dismiss">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  /* Floating rail. Position is set via inline style so the user can
     drag it anywhere in the viewport; the inline style toggles between
     centered-default (transform: translateX(-50%)) and an explicit
     {left, top} pair once a drag has happened. */
  .timer-rail {
    position: fixed;
    z-index: 80;
    display: flex;
    flex-direction: column;
    gap: 6px;
    pointer-events: none;
  }
  .timer-rail.dragging { transition: none; }

  /* Glass pill — translucent surface + heavy backdrop blur, falls back
     to a solid surface on browsers without backdrop-filter. */
  .pill {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px 6px 6px;
    background: color-mix(in srgb, var(--surface-1) 60%, transparent);
    border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    border-radius: var(--radius-full, 99px);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
    backdrop-filter: blur(14px) saturate(160%);
    -webkit-backdrop-filter: blur(14px) saturate(160%);
    max-width: min(92vw, 420px);
  }
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .pill { background: var(--surface-1); }
  }
  .pill.done {
    border-color: color-mix(in srgb, var(--accent) 70%, transparent);
    background: color-mix(in srgb, var(--accent) 14%, color-mix(in srgb, var(--surface-1) 60%, transparent));
    animation: ringRing 0.6s 1;
  }
  @keyframes ringRing {
    0%   { transform: translateX(0); }
    20%  { transform: translateX(-3px); }
    40%  { transform: translateX(3px); }
    60%  { transform: translateX(-2px); }
    80%  { transform: translateX(2px); }
    100% { transform: translateX(0); }
  }

  /* Ring + time. */
  .ring-wrap {
    position: relative;
    width: 44px;
    height: 44px;
    flex-shrink: 0;
  }
  /* When the timer fires the ring-wrap becomes a button. Reset
     button styling, give it a soft glow + a press feedback so it
     reads as tappable. The pulse animation on .ring-time still runs
     on top so the alarm urgency stays. */
  button.ring-wrap.ring-tap {
    border: none;
    padding: 0;
    background: transparent;
    cursor: pointer;
    border-radius: 50%;
    -webkit-tap-highlight-color: transparent;
  }
  button.ring-wrap.ring-tap:hover  { background: color-mix(in srgb, var(--accent) 18%, transparent); }
  button.ring-wrap.ring-tap:active { transform: scale(0.94); }
  .ring { width: 100%; height: 100%; transform: rotate(-90deg); }
  .ring-track {
    fill: none;
    stroke: color-mix(in srgb, var(--border) 80%, transparent);
    stroke-width: 3;
  }
  .ring-arc {
    fill: none;
    stroke: var(--accent);
    stroke-width: 3;
    stroke-linecap: round;
    stroke-dasharray: 97.4;
    transition: stroke-dashoffset 0.4s linear;
  }
  .ring-time {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    font-weight: 700;
    color: var(--text-1);
    letter-spacing: -0.02em;
  }
  .ring-time.pulse {
    color: var(--accent);
    animation: pulseText 1.4s ease-in-out infinite;
  }
  @keyframes pulseText {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.55; }
  }

  /* Centered two-line label. Drag handle. Becomes a tap target when
     a stepIndex is present so the user can jump to the step. */
  .pill-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    padding: 2px 6px;
    background: transparent;
    border: 0;
    text-align: center;
    cursor: grab;
    color: var(--text-1);
  }
  .timer-rail.dragging .pill-text { cursor: grabbing; }
  .pill-text.linked:hover .pill-step { color: var(--accent); }
  .pill-recipe {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--accent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
    line-height: 1.1;
  }
  /* Bottom row of the centered label: Step N badge + step title side
     by side. Stays a single line via the inner ellipsis on .pill-step. */
  .pill-step-row {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    min-width: 0;
  }
  .pill-step-badge {
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
    flex-shrink: 0;
    white-space: nowrap;
    line-height: 1.1;
  }
  .pill-step {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    line-height: 1.2;
  }

  .pill-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    margin-left: 4px;
  }
  .t-btn {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 4px 8px;
    border-radius: var(--radius-full, 99px);
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 24px;
    min-width: 24px;
  }
  .t-btn:hover { background: var(--surface-1); color: var(--text-1); }
  .t-btn.close { padding: 4px; }
  .t-btn .material-symbols-rounded { font-size: 14px; }

  /* Disable text selection across the body while dragging so the
     name strip doesn't accidentally get highlighted. */
  :global(body.timer-dragging) {
    user-select: none;
    -webkit-user-select: none;
    cursor: grabbing;
  }
</style>
