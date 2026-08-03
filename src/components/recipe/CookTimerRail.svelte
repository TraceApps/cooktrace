<script>
  /**
   * CookTimerRail — fixed bottom panel listing every running timer.
   *
   * Mounted globally by App.svelte so it persists across navigation.
   * Renders nothing when there are no timers. Each timer shows label,
   * remaining time (live updating), and three controls: +1 min, dismiss,
   * (and an implicit completion-state visual when done).
   *
   * Cook Mode pages override the rail to show inline rather than
   * float-bottom — this component just listens to the cookTimers store
   * and lays out cards. CSS makes the layout look right in both
   * contexts via a `compact` prop.
   */
  import { _ } from 'svelte-i18n';
  import { fade, fly } from 'svelte/transition';
  import { cookTimers, dismissTimer, addOneMinute, formatRemaining } from '../../stores/cookTimers.js';

  export let compact = false;

  // Live remaining millis per timer. Recomputed every store update,
  // which the ticker fires once per second.
  $: visible = ($cookTimers || []).filter(t => !t.dismissed);
  $: anyDone = visible.some(t => t.done);
</script>

{#if visible.length > 0}
  <div class="rail" class:compact in:fly={{ y: 20, duration: 180 }} out:fade={{ duration: 120 }}>
    {#each visible as t (t.id)}
      {@const remaining = Math.max(0, t.endsAt - Date.now())}
      <div class="timer" class:done={t.done}>
        <div class="timer-head">
          <span class="material-symbols-rounded timer-icon">{t.done ? 'notifications_active' : 'timer'}</span>
          <span class="timer-label">{t.label}</span>
        </div>
        <!-- Whole readout is a big tap target once the timer fires.
             Silences + dismisses the alarm. Before that it's inert
             so users still long-press / select normally. -->
        {#if t.done}
          <button type="button" class="timer-time pulse done-tap"
                  on:click={() => dismissTimer(t.id)}
                  aria-label="Dismiss timer">
            Done
          </button>
        {:else}
          <div class="timer-time">{formatRemaining(remaining)}</div>
        {/if}
        <div class="timer-actions">
          {#if !t.done}
            <button class="t-btn" on:click={() => addOneMinute(t.id)} title="+1 min">+1</button>
          {:else}
            <button class="t-btn" on:click={() => addOneMinute(t.id)} title="Snooze 1 min">{$_('cook_timer_rail.snooze')}</button>
          {/if}
          <button class="t-btn close" on:click={() => dismissTimer(t.id)} aria-label="Dismiss" title="Dismiss">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .rail {
    position: fixed;
    bottom: calc(var(--nav-h) + var(--safe-bottom) + 12px);
    right: 12px;
    left: 12px;
    z-index: 90;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    pointer-events: none;
  }
  .rail.compact {
    /* Cook Mode embeds this as a flex row inline at the page bottom. */
    position: static;
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: flex-start;
    pointer-events: auto;
  }
  @media (min-width: 720px) {
    .rail { left: auto; max-width: 480px; }
  }

  .timer {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    min-width: 220px;
    max-width: 320px;
  }
  .timer.done {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--surface-1));
    animation: ringRing 0.6s 1;
  }
  @keyframes ringRing {
    0%   { transform: translateX(0); }
    20%  { transform: translateX(-4px); }
    40%  { transform: translateX(4px); }
    60%  { transform: translateX(-2px); }
    80%  { transform: translateX(2px); }
    100% { transform: translateX(0); }
  }

  .timer-head {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .timer-icon {
    font-size: 18px;
    color: var(--accent);
    flex-shrink: 0;
  }
  .timer.done .timer-icon { animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.15); }
  }
  .timer-label {
    color: var(--text-1);
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .timer-time {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 16px;
    font-weight: 700;
    color: var(--text-1);
    flex-shrink: 0;
    min-width: 56px;
    text-align: right;
  }
  .timer.done .timer-time { color: var(--accent); }
  .timer-time.pulse { animation: pulseText 1.4s ease-in-out infinite; }
  /* Done-state tap target: a real button — generous padding, larger
     font so the readout is hard to miss, and a subtle press feedback
     so it reads as "tappable" not "decorative". */
  button.timer-time.done-tap {
    border: 1px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-radius: var(--radius-md);
    padding: 8px 14px;
    font-size: 18px;
    cursor: pointer;
    min-width: 84px;
    -webkit-tap-highlight-color: transparent;
  }
  button.timer-time.done-tap:hover  { background: color-mix(in srgb, var(--accent) 20%, transparent); }
  button.timer-time.done-tap:active { transform: scale(0.97); }
  @keyframes pulseText {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .timer-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .t-btn {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 26px;
    min-width: 26px;
  }
  .t-btn:hover { background: var(--surface-1); color: var(--text-1); }
  .t-btn.close { padding: 4px; }
  .t-btn .material-symbols-rounded { font-size: 14px; }
</style>
