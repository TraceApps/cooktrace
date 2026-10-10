<!--
  AllergenChips: what a recipe contains, as chips. One that's a problem for
  someone in the household names them ("Peanuts · Alex"); "may contain" is
  dashed. A help, not a guarantee (lib/allergens.js).

  Props:
    summary: { contains, traces } as recipeAllergens() or allergenSummary() give them
    members: the household (cleanHousehold)
    date: YYYY-MM-DD, to count only who's home that day; none: everyone
    only: 'conflicts' (recipe cards, the week) or 'all' (the recipe view)
-->
<script>
  import { _, locale } from 'svelte-i18n';
  import { ALLERGENS, allergenKey, conflicts } from '../../lib/allergens.js';

  export let summary = null;
  export let members = [];
  export let date = '';
  export let only = 'conflicts';

  $: list = new Intl.ListFormat($locale || undefined, { style: 'short', type: 'conjunction' });
  const codeOf = x => (typeof x === 'string' ? x : x?.code);
  $: hit = conflicts(summary, members, { date: date || undefined });
  $: hitContains = new Map(hit.contains.map(x => [x.code, x.who]));
  $: hitTraces = new Map(hit.traces.map(x => [x.code, x.who]));
  $: contains = (summary?.contains || []).map(codeOf).filter(c => hitContains.has(c) || (only === 'all' && ALLERGENS.includes(c)));
  $: traces = (summary?.traces || []).map(codeOf).filter(c => hitTraces.has(c) || (only === 'all' && ALLERGENS.includes(c)));

  function text(code, who) {
    const what = $_(`allergens.${allergenKey(code)}`);
    return who?.length ? $_('allergen_info.conflict', { values: { what, who: list.format(who) } }) : what;
  }
</script>

{#if contains.length || traces.length}
  <span class="chips">
    {#each contains as c (c)}
      <span class="chip" class:warn={hitContains.has(c)}>
        {#if hitContains.has(c)}<span class="material-symbols-rounded" aria-hidden="true">warning</span>{/if}{text(c, hitContains.get(c))}
      </span>
    {/each}
    {#each traces as c (c)}
      <span class="chip trace" class:warn={hitTraces.has(c)} title={$_('allergen_info.may_contain')}>
        <span class="sr">{$_('allergen_info.may_contain')}: </span>{text(c, hitTraces.get(c))}
      </span>
    {/each}
  </span>
{/if}

<style>
  .chips { display: inline-flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
    padding: 3px 10px; border-radius: var(--radius-full);
    background: var(--surface-2); color: var(--text-2);
    font-size: 12px; font-weight: 500; line-height: 1.3;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .chip.warn { background: color-mix(in srgb, var(--warning) 14%, transparent); color: var(--warning); font-weight: 600; }
  .chip.trace { background: transparent; border: 1px dashed var(--border-strong); padding: 2px 9px; }
  .chip.trace.warn { border-color: color-mix(in srgb, var(--warning) 60%, transparent); }
  .chip .material-symbols-rounded { font-size: 14px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
