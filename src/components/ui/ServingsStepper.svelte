<!--
  ServingsStepper: a number of servings with − and + either side.

  Props:
    value (bindable): servings, a whole number from min to max
    min, max: limits (1 and 99)
    label: what it counts, for screen readers ("Servings")
  Fires `change` with the new value after a tap.
-->
<script>
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';

  export let value = 1;
  export let min = 1;
  export let max = 99;
  export let label = '';

  const dispatch = createEventDispatcher();

  function step(by) {
    const cur = Number(value) || min;
    const next = Math.min(max, Math.max(min, Math.round(cur) + by));
    if (next === value) return;
    value = next;
    dispatch('change', next);
  }
</script>

<div class="stepper" role="group" aria-label={label || $_('servings_stepper.servings')}>
  <button type="button" class="step" on:click={() => step(-1)} disabled={value <= min}
    aria-label={$_('servings_stepper.fewer')}>
    <span class="material-symbols-rounded" aria-hidden="true">remove</span>
  </button>
  <span class="value" aria-live="polite">
    <span class="material-symbols-rounded person" aria-hidden="true">person</span>{value}
  </span>
  <button type="button" class="step" on:click={() => step(1)} disabled={value >= max}
    aria-label={$_('servings_stepper.more')}>
    <span class="material-symbols-rounded" aria-hidden="true">add</span>
  </button>
</div>

<style>
  .stepper {
    display: inline-flex;
    align-items: center;
    height: 40px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
  }
  .step {
    width: 40px;
    height: 40px;
    border: none;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-1);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .step:hover:not(:disabled) { background: var(--surface-3); }
  .step:active:not(:disabled) { transform: scale(0.92); }
  .step:disabled { color: var(--text-3); cursor: default; }
  .step .material-symbols-rounded { font-size: 18px; }
  .value {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-width: 34px;
    justify-content: center;
    font-size: 14px;
    font-weight: 700;
    color: var(--text-1);
    font-variant-numeric: tabular-nums;
  }
  .person { font-size: 14px; color: var(--text-2); }
</style>
