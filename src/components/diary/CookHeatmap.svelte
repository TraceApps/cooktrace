<!--
  CookHeatmap — GitHub-style contribution graph showing daily cooks
  over the last year. Reads `data` ([{ date, count }]) and renders a
  7-row × N-column grid where each cell is a single day, shaded by
  cook count (0, 1, 2, 3, 4+).

  The grid is column-major: each column is one week running Sun→Sat
  top-to-bottom, with the rightmost column ending on today. Months
  labels float along the top edge as the boundary between weeks
  shifts. Day labels (Mon / Wed / Fri) sit on the left.

  Mobile: the grid is allowed to overflow horizontally — same pattern
  GitHub uses on phones. Pinning the labels makes it scannable.
-->
<script>
  import { _ } from 'svelte-i18n';
  import { createEventDispatcher } from 'svelte';

  /** Array of { date: 'YYYY-MM-DD', count: number } */
  export let data = [];
  /** Number of weeks to display (each is a column). Default ~1y. */
  export let weeks = 52;

  const dispatch = createEventDispatcher();

  // Look up the count for any date in O(1).
  $: countMap = (() => {
    const m = new Map();
    for (const d of (data || [])) m.set(d.date, d.count || 0);
    return m;
  })();

  // Build the grid as a flat column-major array so a single grid
  // container with `grid-auto-flow: column` paints everything in the
  // right slot. We include exactly `weeks + 1` columns so today's
  // partial week shows up on the right.
  $: gridCells = (() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Start at the Sunday of the leftmost visible week.
    const start = new Date(today);
    start.setDate(today.getDate() - (weeks * 7) - today.getDay());
    const cols = weeks + 1;
    const cells = [];
    for (let w = 0; w < cols; w++) {
      for (let d = 0; d < 7; d++) {
        const date = new Date(start);
        date.setDate(start.getDate() + w * 7 + d);
        const future = date > today;
        const iso = _isoDate(date);
        cells.push({
          date: iso,
          jsDate: date,
          count: future ? -1 : (countMap.get(iso) || 0),
          future,
          // First-week marker for month labels — we paint the label on
          // the first cell of each new month at row 0.
          isMonthStart: d === 0 && date.getDate() <= 7,
          monthLabel: date.toLocaleString(undefined, { month: 'short' }),
        });
      }
    }
    return cells;
  })();

  // Aggregate stats for the legend / hover summary.
  $: total = (data || []).reduce((sum, d) => sum + (d.count || 0), 0);
  $: activeDays = (data || []).filter(d => (d.count || 0) > 0).length;

  function _isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  function _level(count) {
    if (count <= 0) return 0;
    if (count === 1) return 1;
    if (count === 2) return 2;
    if (count <= 4) return 3;
    return 4;
  }
  function _tooltip(cell) {
    if (cell.future) return '';
    const niceDate = cell.jsDate.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    });
    if (cell.count === 0) return `No cooks · ${niceDate}`;
    return `${cell.count} cook${cell.count === 1 ? '' : 's'} · ${niceDate}`;
  }
  function _click(cell) {
    if (cell.future) return;
    dispatch('select', { date: cell.date, count: cell.count });
  }

  // Build the column headers (month labels). Only show on the column
  // whose first row (Sunday) is within the first week of a month.
  $: monthHeaders = (() => {
    const out = [];
    for (let w = 0; w <= weeks; w++) {
      const sunIdx = w * 7;
      const sun = gridCells[sunIdx];
      if (!sun) continue;
      if (sun.isMonthStart) out.push({ col: w + 1, label: sun.monthLabel });
    }
    // Dedupe consecutive duplicates (e.g., two Sundays both in early Feb).
    return out.filter((h, i) => i === 0 || out[i - 1].label !== h.label);
  })();
</script>

<section class="heatmap-card" aria-label="Cook heatmap">
  <header class="hm-head">
    <div class="hm-title">
      <span class="material-symbols-rounded">grid_on</span>
      <h2>{$_('cook_heatmap.title')}</h2>
    </div>
    <div class="hm-summary">
      {total} {total === 1 ? 'Cook' : 'Cooks'} · {activeDays} Active {activeDays === 1 ? 'Day' : 'Days'}
    </div>
  </header>

  <div class="hm-scroll">
    <div class="hm-layout" style="--cols: {weeks + 1}">
      <!-- Month labels along the top -->
      <div class="hm-months">
        {#each monthHeaders as h (h.col + h.label)}
          <span class="hm-month" style="grid-column: {h.col}">{h.label}</span>
        {/each}
      </div>

      <!-- Day labels on the left (sparse — Mon/Wed/Fri only) -->
      <div class="hm-days">
        <span></span>
        <span>Mon</span>
        <span></span>
        <span>Wed</span>
        <span></span>
        <span>Fri</span>
        <span></span>
      </div>

      <!-- The grid itself. Column-major fill via grid-auto-flow. -->
      <div class="hm-grid">
        {#each gridCells as cell (cell.date)}
          <button class="cell"
            class:future={cell.future}
            data-level={_level(cell.count)}
            title={_tooltip(cell)}
            aria-label={_tooltip(cell)}
            type="button"
            disabled={cell.future}
            on:click={() => _click(cell)}></button>
        {/each}
      </div>
    </div>
  </div>

  <!-- Legend at the bottom — same colour ramp as the cells. -->
  <footer class="hm-legend">
    <span class="hm-legend-label">{$_('cook_heatmap.less')}</span>
    <span class="legend-cell" data-level="0"></span>
    <span class="legend-cell" data-level="1"></span>
    <span class="legend-cell" data-level="2"></span>
    <span class="legend-cell" data-level="3"></span>
    <span class="legend-cell" data-level="4"></span>
    <span class="hm-legend-label">{$_('cook_heatmap.more')}</span>
  </footer>
</section>

<style>
  .heatmap-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 14px 12px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    margin: 0 0 14px;
  }
  .hm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .hm-title {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-1);
  }
  .hm-title h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    color: var(--text-1);
  }
  .hm-title .material-symbols-rounded {
    color: var(--accent);
    font-size: 20px;
  }
  .hm-summary {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-3);
    letter-spacing: 0.02em;
  }

  /* Horizontal scroll keeps the grid scannable on narrow screens
     (same approach GitHub uses on phones). */
  .hm-scroll {
    overflow-x: auto;
    overflow-y: hidden;
    margin: 0 -4px;
    padding: 0 4px;
    touch-action: pan-x;
  }
  .hm-scroll::-webkit-scrollbar { height: 6px; }
  .hm-scroll::-webkit-scrollbar-thumb { background: var(--surface-2); border-radius: 4px; }

  /* --cell drives both row height and column width; everything else
     scales from it. Bumped up on wider screens so the heatmap actually
     fills the card on desktop instead of floating on the left. */
  .hm-layout {
    --cell: 11px;
    --gap: 2px;
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-rows: auto auto;
    column-gap: 6px;
    row-gap: 4px;
    min-width: max-content;
  }
  @media (min-width: 768px) {
    .hm-layout { --cell: 16px; --gap: 3px; min-width: 0; }
  }
  @media (min-width: 1024px) {
    .hm-layout { --cell: 20px; --gap: 3px; }
  }

  /* Month labels strip — column-aligned to the same grid the cells use. */
  .hm-months {
    grid-column: 2;
    grid-row: 1;
    display: grid;
    grid-template-columns: repeat(var(--cols), var(--cell));
    column-gap: var(--gap);
    height: 14px;
    align-items: end;
    font-size: 10px;
    color: var(--text-3);
    letter-spacing: 0.04em;
  }
  .hm-month {
    grid-row: 1;
    white-space: nowrap;
  }

  /* Day labels — sparse, only Mon/Wed/Fri so it isn't crowded. */
  .hm-days {
    grid-column: 1;
    grid-row: 2;
    display: grid;
    grid-template-rows: repeat(7, var(--cell));
    row-gap: var(--gap);
    font-size: 10px;
    color: var(--text-3);
    align-items: center;
    justify-items: end;
    padding-right: 4px;
    line-height: 1;
  }
  .hm-days span { white-space: nowrap; }

  /* The actual contribution grid. */
  .hm-grid {
    grid-column: 2;
    grid-row: 2;
    display: grid;
    grid-template-rows: repeat(7, var(--cell));
    grid-auto-flow: column;
    grid-auto-columns: var(--cell);
    gap: var(--gap);
  }
  .cell {
    width: var(--cell); height: var(--cell);
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--accent) 6%, var(--border));
    border-radius: 3px;
    background: var(--surface-2);
    cursor: pointer;
    transition: transform var(--dur-fast), filter var(--dur-fast);
  }
  .cell:hover:not(:disabled) { transform: scale(1.35); filter: brightness(1.15); z-index: 1; }
  .cell:disabled, .cell.future { cursor: default; background: transparent; border-color: transparent; }
  .cell[data-level="0"] { background: var(--surface-2); }
  .cell[data-level="1"] { background: color-mix(in srgb, var(--accent) 25%, var(--surface-2)); }
  .cell[data-level="2"] { background: color-mix(in srgb, var(--accent) 50%, var(--surface-2)); }
  .cell[data-level="3"] { background: color-mix(in srgb, var(--accent) 75%, var(--surface-2)); }
  .cell[data-level="4"] { background: var(--accent); }

  .hm-legend {
    display: flex;
    align-items: center;
    gap: 4px;
    justify-content: flex-end;
    font-size: 10px;
    color: var(--text-3);
    margin-top: 2px;
  }
  .hm-legend-label { letter-spacing: 0.04em; }
  .legend-cell {
    width: 10px; height: 10px;
    border-radius: 2px;
    border: 1px solid color-mix(in srgb, var(--accent) 6%, var(--border));
  }
  .legend-cell[data-level="0"] { background: var(--surface-2); }
  .legend-cell[data-level="1"] { background: color-mix(in srgb, var(--accent) 25%, var(--surface-2)); }
  .legend-cell[data-level="2"] { background: color-mix(in srgb, var(--accent) 50%, var(--surface-2)); }
  .legend-cell[data-level="3"] { background: color-mix(in srgb, var(--accent) 75%, var(--surface-2)); }
  .legend-cell[data-level="4"] { background: var(--accent); }
</style>
