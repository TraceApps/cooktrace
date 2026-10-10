<!--
  BuildWeekSheet: a week of dinners in one go. Choose how many and for how
  many people, and what matters (using up what's expiring, not repeating
  what was cooked lately, quick ones); the picks come ranked, each with
  why, a Swap for the next best, and the totals update as you go. Add to
  Week plans them on the week's free days (the rest for any day).

  Props: open (bindable), weekStart (YYYY-MM-DD), planned (the week's
  planned cooks), recipes (array), pantry, today
  Events: added ({ count })
-->
<script>
  import { createEventDispatcher } from 'svelte';
  import { _, locale } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import ServingsStepper from '../ui/ServingsStepper.svelte';
  import { NtApi } from '../../lib/api.js';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { buildWeek, freeDays, picksNeeds } from '../../lib/plan-ideas.js';
  import { fromIso, isoDay, planHorizon } from '../../lib/week.js';

  export let open = false;
  export let weekStart = '';
  export let planned = [];
  export let recipes = [];
  export let pantry = [];
  export let today = '';

  const dispatch = createEventDispatcher();

  let count = 5;
  let servings = 2;
  let useExpiring = true;
  let notRecent = true;
  let quick = false;
  let skip = {};
  let saving = false;
  let wasOpen = false;

  $: weekEnd = weekStart ? isoDay(new Date(fromIso(weekStart).getFullYear(), fromIso(weekStart).getMonth(), fromIso(weekStart).getDate() + 6)) : '';
  $: days = weekStart ? freeDays(weekStart, planned.filter(e => !e.any_day).map(e => e.date), today) : [];
  // Each time it opens: as many dinners as free days (up to five), fresh picks.
  $: if (open && !wasOpen) { wasOpen = true; count = Math.max(1, Math.min(days.length || 5, 5)); skip = {}; }
  $: if (!open) wasOpen = false;
  $: options = { useExpiring, notRecent, quick };
  $: picks = open ? buildWeek({
        recipes, pantry, today, horizon: planHorizon(weekEnd, today), count, options,
        exclude: new Set(planned.map(e => e.recipe_id)), skip,
      }) : [];
  $: totals = picksNeeds(picks, pantry, { today, horizon: planHorizon(weekEnd, today) });
  $: list = new Intl.ListFormat($locale || undefined, { style: 'long', type: 'conjunction' });

  function dayLabel(i) {
    const iso = days[i];
    return iso ? fromIso(iso).toLocaleDateString($locale || undefined, { weekday: 'short' }) : $_('build_week.any_day');
  }
  function reasonText(r) {
    if (r.kind === 'uses') return $_('build_week.reason_uses', { values: { items: list.format(r.items) } });
    if (r.kind === 'shares') return $_('build_week.reason_shares', { values: { item: r.item, with: r.with } });
    if (r.kind === 'have') return $_('build_week.reason_have', { values: { have: r.have, need: r.need } });
    if (r.kind === 'not_cooked') return $_('build_week.reason_not_cooked', { values: { weeks: r.weeks } });
    return $_('build_week.reason_new');
  }
  function swap(i, id) {
    const s = new Set(skip[i] || []);
    s.add(id);
    skip = { ...skip, [i]: s };
  }
  function toggle(name) {
    if (name === 'expiring') useExpiring = !useExpiring;
    else if (name === 'recent') notRecent = !notRecent;
    else quick = !quick;
    skip = {};
  }

  async function addToWeek() {
    saving = true;
    try {
      for (let i = 0; i < picks.length; i++) {
        const day = days[i];
        await NtApi.createDiaryEntry({
          recipe_id: picks[i].recipe.id,
          date: day || weekStart,
          kind: 'planned',
          meal_type: 'dinner',
          servings,
          any_day: !day,
        });
      }
      showSuccess($_('build_week.added', { values: { count: picks.length } }));
      open = false;
      dispatch('added', { count: picks.length });
    } catch (e) {
      showError(e.message || 'Could not plan');
    } finally {
      saving = false;
    }
  }
</script>

<Sheet bind:open title={$_('build_week.title')} height="full">
  <div class="build">
    <section class="options" aria-label={$_('build_week.options')}>
      <div class="opt-row">
        <span class="material-symbols-rounded" aria-hidden="true">restaurant</span>
        <span class="opt-label">{$_('build_week.dinners')}</span>
        <ServingsStepper bind:value={count} min={1} max={7} icon="" label={$_('build_week.dinners')} on:change={() => (skip = {})} />
      </div>
      <div class="opt-row">
        <span class="material-symbols-rounded" aria-hidden="true">group</span>
        <span class="opt-label">{$_('build_week.servings')}</span>
        <ServingsStepper bind:value={servings} label={$_('build_week.servings')} />
      </div>
      <div class="chips">
        <button type="button" class="chip" class:on={useExpiring} aria-pressed={useExpiring} on:click={() => toggle('expiring')}>
          {#if useExpiring}<span class="material-symbols-rounded" aria-hidden="true">check</span>{/if}{$_('build_week.use_expiring')}
        </button>
        <button type="button" class="chip" class:on={notRecent} aria-pressed={notRecent} on:click={() => toggle('recent')}>
          {#if notRecent}<span class="material-symbols-rounded" aria-hidden="true">check</span>{/if}{$_('build_week.not_recent')}
        </button>
        <button type="button" class="chip" class:on={quick} aria-pressed={quick} on:click={() => toggle('quick')}>
          {#if quick}<span class="material-symbols-rounded" aria-hidden="true">check</span>{/if}{$_('build_week.quick')}
        </button>
      </div>
    </section>

    {#if !picks.length}
      <p class="empty">{$_('build_week.none')}</p>
    {:else}
      <ol class="picks">
        {#each picks as p, i (p.recipe.id)}
          <li class="pick">
            <span class="pick-day">{dayLabel(i)}</span>
            {#if p.recipe.imgUrl || p.recipe.img_url}
              <img src={p.recipe.imgUrl || resolveAssetUrl(p.recipe.img_url)} alt="" loading="lazy" />
            {:else}<span class="ph material-symbols-rounded" aria-hidden="true">restaurant</span>{/if}
            <span class="pick-text">
              <span class="name">{p.recipe.name}</span>
              <span class="why" class:good={p.reason.kind === 'uses'}>{reasonText(p.reason)}</span>
            </span>
            <button class="swap" on:click={() => swap(i, p.recipe.id)} aria-label={$_('build_week.swap', { values: { name: p.recipe.name } })}>
              <span class="material-symbols-rounded" aria-hidden="true">swap_horiz</span>
            </button>
          </li>
        {/each}
      </ol>
    {/if}

    <div class="bar">
      <div class="bar-text">
        <span class="bar-main">{$_('build_week.summary', { values: { count: picks.length, toBuy: totals.toBuy } })}</span>
        {#if totals.expiring > 0}
          <span class="bar-sub"><span class="material-symbols-rounded" aria-hidden="true">eco</span>{$_('build_week.uses_n', { values: { n: totals.expiring } })}</span>
        {/if}
      </div>
      <button class="btn btn-primary add" on:click={addToWeek} disabled={saving || !picks.length}>
        <span class="material-symbols-rounded" aria-hidden="true">event_available</span>{$_('build_week.add')}
      </button>
    </div>
  </div>
</Sheet>

<style>
  .build { display: flex; flex-direction: column; gap: 12px; padding-bottom: 8px; }
  .options { background: var(--surface-2); border-radius: var(--radius-lg); padding: 4px 12px 12px; display: flex; flex-direction: column; }
  .opt-row { display: flex; align-items: center; gap: 8px; min-height: 52px; border-bottom: 1px solid var(--border); }
  .opt-row:nth-child(2) { border-bottom: none; }
  .opt-row .material-symbols-rounded { font-size: 20px; color: var(--text-2); }
  .opt-label { flex: 1; font-size: 14px; font-weight: 600; color: var(--text-1); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px; min-height: 36px; padding: 0 12px;
    border-radius: var(--radius-full); border: 1px solid var(--border-strong); background: transparent;
    color: var(--text-2); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .chip.on { background: var(--accent-dim); border-color: transparent; color: var(--accent); }
  .chip .material-symbols-rounded { font-size: 16px; }
  .empty { margin: 8px 0; color: var(--text-2); font-size: 14px; }
  .picks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .pick {
    display: flex; align-items: center; gap: 10px; padding: 8px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg);
  }
  .pick-day { width: 34px; flex: none; text-align: center; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); }
  .pick img, .pick .ph { width: 52px; height: 52px; border-radius: var(--radius-md); object-fit: cover; flex: none; }
  .ph { display: flex; align-items: center; justify-content: center; background: var(--surface-2); color: var(--text-3); font-size: 22px; }
  .pick-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .name { font-size: 14px; font-weight: 700; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .why { font-size: 12px; line-height: 1.3; color: var(--text-2); }
  .why.good { color: var(--accent); }
  .swap {
    width: 44px; height: 44px; flex: none; border: none; border-radius: var(--radius-md);
    background: var(--surface-2); color: var(--text-1); display: flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .swap:hover { background: var(--surface-3); }
  .bar {
    position: sticky; bottom: 0; display: flex; align-items: center; gap: 12px;
    padding: 12px 0 4px; background: var(--surface-1); border-top: 1px solid var(--border);
  }
  .bar-text { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .bar-main { font-size: 14px; font-weight: 700; color: var(--text-1); }
  .bar-sub { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--accent); }
  .bar-sub .material-symbols-rounded { font-size: 14px; }
  .add { min-height: 48px; display: inline-flex; align-items: center; gap: 6px; padding: 0 18px; }
</style>
