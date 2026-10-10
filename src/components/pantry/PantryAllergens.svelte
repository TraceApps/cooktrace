<!--
  PantryAllergens: what a product contains and may contain, where that
  came from ("From the label" when scanned or looked up on Open Food
  Facts, "You set this" once changed here), and Edit to change it. A
  problem for someone in the household names them ("Peanuts · Alex").

  Props:
    allergens: codes, or null when not known
    traces: codes, or null
    source: 'label' | 'user' | null
    members: the household, for naming who an allergen is a problem for
  Events: change ({ allergens, traces, allergens_source: 'user' }) on Done
-->
<script>
  import { createEventDispatcher } from 'svelte';
  import { _, locale } from 'svelte-i18n';
  import { ALLERGENS, allergenKey, avoids } from '../../lib/allergens.js';

  export let allergens = null;
  export let traces = null;
  export let source = null;
  export let members = [];

  const dispatch = createEventDispatcher();

  let editing = false;
  let pickContains = [];
  let pickTraces = [];

  $: list = new Intl.ListFormat($locale || undefined, { style: 'short', type: 'conjunction' });
  $: known = allergens != null;
  // Nothing listed: what the label says, or what you said.
  $: empty = source === 'user' ? $_('household.none') : $_('allergen_info.nothing_on_label');
  const who = code => members.filter(m => avoids(m).has(code)).map(m => m.name);
  function chipText(code) {
    const what = $_(`allergens.${allergenKey(code)}`);
    const w = who(code);
    return w.length ? $_('allergen_info.conflict', { values: { what, who: list.format(w) } }) : what;
  }

  function startEdit() {
    pickContains = [...(allergens || [])];
    pickTraces = [...(traces || [])];
    editing = true;
  }
  function done() {
    editing = false;
    const a = ALLERGENS.filter(c => pickContains.includes(c));
    const t = ALLERGENS.filter(c => pickTraces.includes(c) && !a.includes(c));
    const same = known && a.join() === (allergens || []).join() && t.join() === (traces || []).join();
    if (!same) dispatch('change', { allergens: a, traces: t, allergens_source: 'user' });
  }
  const toggle = (arr, c) => (arr.includes(c) ? arr.filter(x => x !== c) : [...arr, c]);
</script>

<section class="allergens" aria-label={$_('allergen_info.section')}>
  <div class="head">
    <span class="title">{$_('allergen_info.section')}</span>
    {#if known && source}
      <span class="source">
        <span class="material-symbols-rounded" aria-hidden="true">{source === 'user' ? 'edit' : 'label'}</span>
        {source === 'user' ? $_('allergen_info.source_you') : $_('allergen_info.source_label')}
      </span>
    {/if}
    <button type="button" class="edit" on:click={editing ? done : startEdit}>
      {editing ? $_('allergen_info.done') : $_('allergen_info.edit')}
    </button>
  </div>

  {#if !editing}
    {#if !known}
      <span class="muted">{$_('allergen_info.not_known')}</span>
    {:else}
      <div class="row">
        <span class="row-label">{$_('allergen_info.contains')}</span>
        {#each allergens as c (c)}
          <span class="chip" class:warn={who(c).length}>{chipText(c)}</span>
        {:else}
          <span class="muted">{empty}</span>
        {/each}
      </div>
      <div class="row">
        <span class="row-label">{$_('allergen_info.may_contain')}</span>
        {#each traces || [] as c (c)}
          <span class="chip trace" class:warn={who(c).length}>{chipText(c)}</span>
        {:else}
          <span class="muted">{empty}</span>
        {/each}
      </div>
    {/if}
  {:else}
    <span class="muted">{$_('allergen_info.pantry_tap')}</span>
    <div class="chips">
      {#each ALLERGENS as c (c)}
        <button type="button" class="pick" class:on={pickContains.includes(c)} aria-pressed={pickContains.includes(c)}
          on:click={() => { pickContains = toggle(pickContains, c); pickTraces = pickTraces.filter(x => x !== c); }}>
          {$_(`allergens.${allergenKey(c)}`)}
        </button>
      {/each}
    </div>
    <span class="muted">{$_('allergen_info.pantry_tap_traces')}</span>
    <div class="chips">
      {#each ALLERGENS.filter(c => !pickContains.includes(c)) as c (c)}
        <button type="button" class="pick trace" class:on={pickTraces.includes(c)} aria-pressed={pickTraces.includes(c)}
          on:click={() => (pickTraces = toggle(pickTraces, c))}>
          {$_(`allergens.${allergenKey(c)}`)}
        </button>
      {/each}
    </div>
  {/if}
  <p class="hint"><span class="material-symbols-rounded" aria-hidden="true">info</span>{$_('allergen_info.pantry_hint')}</p>
</section>

<style>
  .allergens {
    display: flex; flex-direction: column; gap: 10px; padding: 12px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg);
  }
  .head { display: flex; align-items: center; gap: 8px; }
  .title { font-size: 14px; font-weight: 700; color: var(--text-1); }
  .source {
    display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px; border-radius: var(--radius-full);
    background: var(--surface-2); color: var(--text-2); font-size: 11px; font-weight: 600;
  }
  .source .material-symbols-rounded { font-size: 13px; }
  .edit {
    margin-left: auto; min-height: 36px; padding: 0 12px; border: none; border-radius: var(--radius-md);
    background: transparent; color: var(--accent); font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
  }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .row-label { width: 96px; flex: none; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); }
  .chip {
    display: inline-flex; align-items: center; padding: 3px 10px; border-radius: var(--radius-full);
    background: var(--surface-2); color: var(--text-2); font-size: 12px; font-weight: 500;
  }
  .chip.warn { background: color-mix(in srgb, var(--warning) 14%, transparent); color: var(--warning); font-weight: 600; }
  .chip.trace { background: transparent; border: 1px dashed var(--border-strong); padding: 2px 9px; }
  .muted { font-size: 12px; color: var(--text-2); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .pick {
    min-height: 36px; padding: 0 12px; border-radius: var(--radius-full); border: 1px solid var(--border-strong);
    background: transparent; color: var(--text-2); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .pick.trace { border-style: dashed; }
  .pick.on { background: var(--accent-dim); border-color: transparent; color: var(--accent); }
  .hint { margin: 0; display: flex; gap: 6px; font-size: 12px; line-height: 1.4; color: var(--text-2); }
  .hint .material-symbols-rounded { font-size: 16px; }
</style>
