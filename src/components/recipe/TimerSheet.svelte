<script>
  /**
   * TimerSheet: a timer for any length, not only the times a step writes
   * down (#77). Cook Mode's Timer button and each step's Timer open it.
   *
   * Quick picks for the usual lengths, and a keypad for the rest that fills
   * in from the right the way a phone's Clock does: 1, 3, 0 is 1:30. Typing
   * works too, on a keyboard. Opened from a step, it starts on that step's
   * first time and is named for the step.
   */
  import { tick } from 'svelte';
  import { _ } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import { startTimer } from '../../stores/cookTimers.js';

  export let open = false;
  /** What the timer is for: a step's name, or empty for a plain timer. */
  export let label = '';
  export let recipeId = null;
  export let recipeName = null;
  export let stepIndex = null;
  /** Seconds it opens on (a step's first time), or 0. */
  export let seconds = 0;

  const PICKS = [1, 3, 5, 10, 15, 20, 30, 45, 60, 90];
  const MAX = 24 * 3600;

  // Up to six digits, hhmmss, filled from the right.
  let digits = '';
  let name = '';
  let wasOpen = false;

  $: _opened(open);
  function _opened(now) {
    if (now && !wasOpen) {
      digits = seconds > 0 ? fromSeconds(seconds) : '';
      name = label || '';
    }
    wasOpen = now;
  }

  function fromSeconds(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${h}${pad(m)}${pad(s)}`.replace(/^0+/, '').slice(-6);
  }

  $: padded = digits.padStart(6, '0');
  $: hh = Number(padded.slice(0, 2));
  $: mm = Number(padded.slice(2, 4));
  $: ss = Number(padded.slice(4, 6));
  // 90 typed as minutes is an hour and a half, as on a Clock.
  $: total = hh * 3600 + mm * 60 + ss;
  $: valid = total > 0 && total <= MAX;

  function press(d) {
    if (digits.length >= 6) return;
    if (!digits && /^0+$/.test(d)) return;
    digits = (digits + d).slice(0, 6);
  }
  function back() { digits = digits.slice(0, -1); }
  function pick(min) { digits = fromSeconds(min * 60); }

  function start() {
    if (!valid) return;
    startTimer({
      label: name.trim() || $_('cook_timers.timer'),
      durationSec: total,
      recipeId,
      recipeName,
      stepIndex,
    });
    open = false;
  }

  // A keyboard types the time, unless it is typing the name.
  function onKey(e) {
    if (!open || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLElement && e.target.closest('input, textarea')) {
      if (e.key === 'Enter' && valid) { e.preventDefault(); start(); }
      return;
    }
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); back(); }
    else if (e.key === 'Enter' && valid) { e.preventDefault(); start(); }
  }

  $: pickLabel = (min) => min < 60
    ? $_('cook_timers.minutes_short', { values: { n: min } })
    : (min % 60 === 0
      ? $_('cook_timers.hours_short', { values: { n: min / 60 } })
      : $_('cook_timers.hours_minutes_short', { values: { h: Math.floor(min / 60), m: min % 60 } }));
</script>

<svelte:window on:keydown={onKey} />

<Sheet bind:open title={$_('cook_timers.start_a_timer')}>
  <div class="timer-sheet">
    <!-- The time as typed, hours only once there are some. -->
    <div class="readout" class:empty={!digits} aria-live="polite"
      aria-label={$_('cook_timers.length_aria', { values: { h: hh, m: mm, s: ss } })}>
      {#if hh > 0}
        <span class="num">{hh}</span><span class="unit">{$_('cook_timers.unit_h')}</span>
      {/if}
      <span class="num">{String(mm).padStart(2, '0')}</span><span class="unit">{$_('cook_timers.unit_m')}</span>
      <span class="num">{String(ss).padStart(2, '0')}</span><span class="unit">{$_('cook_timers.unit_s')}</span>
    </div>

    <div class="picks" role="group" aria-label={$_('cook_timers.quick_picks')}>
      {#each PICKS as min}
        <button type="button" class="pick" class:active={total === min * 60} on:click={() => pick(min)}>
          {pickLabel(min)}
        </button>
      {/each}
    </div>

    <div class="keypad" role="group" aria-label={$_('cook_timers.keypad')}>
      {#each ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0'] as d}
        <button type="button" class="key" on:click={() => press(d)}>{d}</button>
      {/each}
      <button type="button" class="key back" on:click={back} disabled={!digits}
        aria-label={$_('cook_timers.backspace')} title={$_('cook_timers.backspace')}>
        <span class="material-symbols-rounded">backspace</span>
      </button>
    </div>

    <label class="field">
      <span class="field-label">{$_('cook_timers.name')} <span class="field-hint">{$_('cook_timers.optional')}</span></span>
      <input class="input" type="text" dir="auto" maxlength="60" bind:value={name}
        placeholder={$_('cook_timers.name_placeholder')} />
    </label>

    {#if total > MAX}
      <p class="too-long">{$_('cook_timers.too_long')}</p>
    {/if}

    <button type="button" class="btn btn-primary start" on:click={start} disabled={!valid}>
      <span class="material-symbols-rounded">play_arrow</span>
      {$_('cook_timers.start')}
    </button>
  </div>
</Sheet>

<style>
  .timer-sheet {
    display: flex; flex-direction: column; gap: 14px;
    max-width: 420px; margin: 0 auto; padding-top: 4px;
  }
  .readout {
    display: flex; align-items: baseline; justify-content: center; gap: 2px;
    font-variant-numeric: tabular-nums;
    color: var(--text-1);
    padding: 4px 0;
  }
  .readout.empty { color: var(--text-3); }
  .readout .num { font-size: 44px; font-weight: 700; letter-spacing: -0.02em; line-height: 1; }
  .readout .unit { font-size: 16px; font-weight: 600; color: var(--text-3); margin: 0 8px 0 2px; }
  .readout .unit:last-child { margin-right: 0; }

  .picks { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
  .pick {
    min-height: 36px; padding: 6px 12px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-full, 99px);
    color: var(--text-2); font-size: 13px; font-weight: 600; cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  .pick:hover { color: var(--text-1); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .pick.active { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }

  .keypad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .key {
    height: 52px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-1); font-size: 22px; font-weight: 600; cursor: pointer;
    font-variant-numeric: tabular-nums;
    display: inline-flex; align-items: center; justify-content: center;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  .key:hover { background: var(--surface-3); }
  .key:active { transform: scale(0.97); }
  .key:disabled { opacity: 0.4; cursor: default; }
  .key.back .material-symbols-rounded { font-size: 22px; }

  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .field-hint { font-weight: 400; color: var(--text-3); font-size: 12px; }
  .input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px; color: var(--text-1);
    font-size: 14px; box-sizing: border-box; width: 100%;
  }
  .too-long { margin: 0; color: var(--danger); font-size: 13px; text-align: center; }
  .start { width: 100%; }
</style>
