<!--
  DatePicker — calendar-based date selector matching the diary date-bar
  aesthetic. Caller decides whether to wrap in a Sheet/modal or render inline.

  Props:
    value (bindable) — selected date as 'YYYY-MM-DD'
    min              — earliest selectable date as 'YYYY-MM-DD' (optional)
    max              — latest selectable date as 'YYYY-MM-DD' (optional, e.g.
                       pass localDateStr() to forbid future dates)

  Events:
    select { detail: 'YYYY-MM-DD' } — fires when the user taps a day.

  Year range: derived from min/max when present, else ±10 years from today.
  For birthday-style pickers (max set, no min) the year grid extends ~100
  years back so a date 30+ years prior is reachable in two taps.
-->
<script>
  import { createEventDispatcher } from 'svelte';
  import { _, locale } from 'svelte-i18n';
  import { localDateStr } from '../../lib/db.js';

  export let value = '';
  export let min = '';
  export let max = '';

  const dispatch = createEventDispatcher();

  // Initialise calendar view from value (or today if empty)
  function _seedDate(v) {
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return new Date(v + 'T12:00:00');
    }
    return new Date();
  }
  let _seed = _seedDate(value);
  let calYear  = _seed.getFullYear();
  let calMonth = _seed.getMonth();

  $: calFirstDay    = new Date(calYear, calMonth, 1).getDay();
  $: calDaysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  // Nav-bound caps
  $: calAtMax = (() => {
    if (!max) return false;
    const [my, mm] = max.split('-').map(Number);
    return calYear > my || (calYear === my && calMonth + 1 > mm);
  })();
  $: calAtMin = (() => {
    if (!min) return false;
    const [my, mm] = min.split('-').map(Number);
    return calYear < my || (calYear === my && calMonth + 1 < mm);
  })();

  let showYearPicker  = false;
  let showMonthPicker = false;
  $: calMonthName = new Date(calYear, calMonth, 1).toLocaleDateString($locale || undefined, { month: 'long' });

  // Year-grid range: respect min/max if set, otherwise default ±10 years from
  // today (suitable for date-jumping in Diary). When max is set without min
  // (the birthday case), span ~100 years back so users picking a long-ago
  // date can reach it in one tap on the year grid + one tap on the day grid.
  $: yearRange = (() => {
    const today = new Date().getFullYear();
    if (min && max) {
      const a = Number(min.slice(0, 4));
      const b = Number(max.slice(0, 4));
      return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    }
    if (max) {
      const b = Number(max.slice(0, 4));
      return Array.from({ length: 105 }, (_, i) => (b - 100) + i);
    }
    if (min) {
      const a = Number(min.slice(0, 4));
      return Array.from({ length: 105 }, (_, i) => a + i);
    }
    return Array.from({ length: 22 }, (_, i) => (today - 10) + i);
  })();

  // Month and weekday names come from Intl in the app's language.
  $: monthNames = Array.from({ length: 12 }, (_x, idx) => ({
    idx,
    short: new Date(2024, idx, 1).toLocaleDateString($locale || undefined, { month: 'short' }),
  }));
  // 2024-01-07 is a Sunday, so the row starts on Sunday like the grid.
  $: weekdayNames = Array.from({ length: 7 }, (_x, i) =>
    new Date(2024, 0, 7 + i).toLocaleDateString($locale || undefined, { weekday: 'short' }));

  function _todayStr() { return localDateStr(); }

  function calPrevMonth() {
    showYearPicker = false; showMonthPicker = false;
    if (calAtMin) return;
    if (calMonth === 0) { calMonth = 11; calYear--; } else calMonth--;
  }
  function calNextMonth() {
    showYearPicker = false; showMonthPicker = false;
    if (calAtMax) return;
    if (calMonth === 11) { calMonth = 0; calYear++; } else calMonth++;
  }

  function _selectDay(ds) {
    if (max && ds > max) return;
    if (min && ds < min) return;
    value = ds;
    dispatch('select', ds);
  }
</script>

<div class="date-picker">
  <!-- Month / year navigation -->
  <div class="dp-nav">
    <button class="btn-icon dp-nav-btn" on:click={calPrevMonth} disabled={calAtMin} aria-label={$_('date_picker_ui.previous_month')}>
      <span class="material-symbols-rounded">chevron_left</span>
    </button>
    <div class="dp-month-year">
      <button class="dp-month-btn" on:click={() => { showMonthPicker = !showMonthPicker; showYearPicker = false; }} title={$_('date_picker_ui.pick_month')}>
        {calMonthName}<span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle;margin-left:2px">{showMonthPicker ? 'expand_less' : 'expand_more'}</span>
      </button>
      <button class="dp-year-btn" on:click={() => { showYearPicker = !showYearPicker; showMonthPicker = false; }} title={$_('date_picker_ui.pick_year')}>
        {calYear}<span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle;margin-left:2px">{showYearPicker ? 'expand_less' : 'expand_more'}</span>
      </button>
    </div>
    <button class="btn-icon dp-nav-btn" on:click={calNextMonth} disabled={calAtMax} aria-label={$_('date_picker_ui.next_month')}>
      <span class="material-symbols-rounded">chevron_right</span>
    </button>
  </div>

  {#if showYearPicker}
    <div class="dp-year-grid">
      {#each yearRange as yr}
        <button class="dp-yr-btn" class:dp-yr-sel={yr === calYear}
          on:click={() => { calYear = yr; showYearPicker = false; }}>{yr}</button>
      {/each}
    </div>
  {:else if showMonthPicker}
    <div class="dp-month-grid">
      {#each monthNames as m}
        <button class="dp-mo-btn" class:dp-mo-sel={m.idx === calMonth}
          on:click={() => { calMonth = m.idx; showMonthPicker = false; }}>{m.short}</button>
      {/each}
    </div>
  {:else}
    <div class="dp-grid">
      {#each weekdayNames as dh}
        <div class="dp-dh">{dh}</div>
      {/each}
      {#each {length: calFirstDay} as _blank}
        <div></div>
      {/each}
      {#each {length: calDaysInMonth} as _day, di}
        {@const day = di + 1}
        {@const ds = calYear + '-' + String(calMonth+1).padStart(2,'0') + '-' + String(day).padStart(2,'0')}
        {@const blocked = (max && ds > max) || (min && ds < min)}
        <button class="dp-day"
          class:dp-today={ds === _todayStr()}
          class:dp-sel={ds === value}
          disabled={blocked}
          on:click={() => _selectDay(ds)}>
          {day}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .date-picker { padding-bottom: 4px; }
  .dp-nav {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 8px 8px;
  }
  .dp-nav-btn { color: var(--text-2); }
  .dp-nav-btn:disabled { opacity: 0.3; cursor: default; }
  .dp-month-year { display: flex; align-items: center; gap: 6px; }
  .dp-month-btn {
    font-size: 16px; font-weight: 700; color: var(--text-1);
    background: var(--surface-2); border: none; cursor: pointer;
    border-radius: var(--radius-sm); padding: 2px 8px;
    display: flex; align-items: center;
    transition: background var(--dur-fast);
  }
  .dp-month-btn:hover { background: var(--surface-3); }
  .dp-year-btn {
    font-size: 16px; font-weight: 700; color: var(--accent);
    background: var(--accent-dim); border: none; cursor: pointer;
    border-radius: var(--radius-sm); padding: 2px 8px;
    display: flex; align-items: center;
    transition: background var(--dur-fast);
  }
  .dp-year-btn:hover { background: color-mix(in srgb, var(--accent) 20%, transparent); }
  .dp-year-grid {
    display: grid; grid-template-columns: repeat(4, 1fr);
    gap: 4px; padding: 4px 8px 8px; max-height: 220px; overflow-y: auto;
  }
  .dp-yr-btn {
    padding: 8px 4px; font-size: 14px; font-weight: 500;
    border-radius: var(--radius-sm); background: none; border: none;
    cursor: pointer; color: var(--text-1); transition: background var(--dur-fast);
    text-align: center;
  }
  .dp-yr-btn:hover { background: var(--surface-2); }
  .dp-yr-btn.dp-yr-sel { background: var(--accent); color: #fff; font-weight: 700; }
  .dp-month-grid {
    display: grid; grid-template-columns: repeat(3, 1fr);
    gap: 4px; padding: 4px 8px 8px;
  }
  .dp-mo-btn {
    padding: 10px 4px; font-size: 14px; font-weight: 500;
    border-radius: var(--radius-sm); background: none; border: none;
    cursor: pointer; color: var(--text-1); transition: background var(--dur-fast);
    text-align: center;
  }
  .dp-mo-btn:hover { background: var(--surface-2); }
  .dp-mo-btn.dp-mo-sel { background: var(--accent); color: #fff; font-weight: 700; }
  .dp-grid {
    display: grid; grid-template-columns: repeat(7, 1fr);
    gap: 2px; padding: 0 8px 4px;
  }
  .dp-dh {
    text-align: center; font-size: 11px; font-weight: 600;
    color: var(--text-3); padding: 4px 0;
  }
  .dp-day {
    aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
    font-size: 14px; border-radius: var(--radius-full);
    background: none; border: none; cursor: pointer;
    color: var(--text-1); transition: background var(--dur-fast);
    -webkit-tap-highlight-color: transparent;
  }
  .dp-day:hover:not(:disabled) { background: var(--surface-2); }
  .dp-day:disabled { color: var(--text-3); opacity: 0.35; cursor: default; }
  .dp-day.dp-today { color: var(--accent); font-weight: 700; }
  .dp-day.dp-sel { background: var(--accent) !important; color: #fff; font-weight: 600; }
</style>
