<!--
  OptionalServings: servings that are only there when someone sets them.

  Planning a cook doesn't ask how many it's for: with none set, the shopping
  list buys the recipe as written and nothing shows on the plan. A person who
  cooks for a different number taps Set and picks one; Clear takes it away.

  Props:
    value (bindable): a whole number, or null for not set
    start: what Set begins on (the recipe's own servings), 2 when not given
    label: for screen readers
  Fires `change` with the new value (a number, or null).
-->
<script>
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import ServingsStepper from './ServingsStepper.svelte';

  export let value = null;
  export let start = null;
  export let label = '';

  const dispatch = createEventDispatcher();

  function set() {
    const n = Math.round(Number(start));
    value = Number.isFinite(n) && n > 0 ? Math.min(99, n) : 2;
    dispatch('change', value);
  }
  function clear() {
    value = null;
    dispatch('change', null);
  }
</script>

<div class="optional-servings">
  {#if value != null}
    <ServingsStepper bind:value {label} on:change={(e) => dispatch('change', e.detail)} />
    <button type="button" class="link" on:click={clear} aria-label={$_('cookdiary_page.servings_clear')} title={$_('cookdiary_page.servings_clear')}>
      <span class="material-symbols-rounded">close</span>
    </button>
  {:else}
    <button type="button" class="set" on:click={set}>
      <span class="material-symbols-rounded" aria-hidden="true">person</span>{$_('cookdiary_page.servings_set')}
    </button>
  {/if}
</div>

<style>
  .optional-servings { display: inline-flex; align-items: center; gap: 6px; }
  .set {
    display: inline-flex; align-items: center; gap: 4px;
    min-height: 32px; padding: 4px 10px 4px 8px;
    background: transparent; color: var(--text-2);
    border: 1px dashed var(--border); border-radius: 999px;
    font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .set:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .set .material-symbols-rounded { font-size: 16px; }
  .link {
    width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center;
    background: transparent; border: none; border-radius: var(--radius-sm); color: var(--text-3); cursor: pointer;
  }
  .link:hover { color: var(--text-1); background: var(--surface-2); }
  .link .material-symbols-rounded { font-size: 16px; }
</style>
