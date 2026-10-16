<script>
  import { textDir } from '../../lib/text-dir.js';
  /**
   * KitchenGear — render of recipe.tools as a mise-en-place checklist.
   * Naming nods to "tools" in the data layer (Schema.org `tool`,
   * Mealie `tools`) but presents to users as "Kitchen Gear" — warmer
   * and avoids the editorial deja-vu of cloning Mealie's "Tools" header.
   *
   * Plain text + checkbox layout. The previous version mapped tool
   * names to Material Symbols glyphs, but the icon set only honestly
   * covers about 8 cooking tools (cake, blender, scale, soup_kitchen,
   * outdoor_grill, oven, timer, thermostat) — every other entry was
   * a misleading approximation (whisk → blender, knife → restaurant,
   * cutting board → rectangle, parchment → description). Dropping the
   * column entirely is honest and visually cleaner.
   *
   * Check state is owned by the parent (RecipeView) so it can clear
   * checks on End-cook-mode / I-made-this and wipe stale state on
   * mount, mirroring how ingredient + step checks work.
   */
  import { createEventDispatcher } from 'svelte';

  export let items = [];
  export let title = 'Kitchen Gear';
  export let compact = false;
  /** Active cook session — checks only mutate while true. */
  export let cookMode = false;
  /** Set of item indices that are currently checked. */
  export let checked = new Set();

  const dispatch = createEventDispatcher();

  function toggle(idx) {
    if (!cookMode) return;
    dispatch('toggle', idx);
  }
</script>

{#if Array.isArray(items) && items.length > 0}
  <section class="kg" class:compact class:cook-mode-off={!cookMode}>
    <h2 class="kg-title">{title}</h2>
    <ul class="kg-list">
      {#each items as it, idx}
        <li class="kg-item" dir={textDir(it)} class:checked={checked.has(idx)}>
          <button
            class="check-btn"
            on:click={() => toggle(idx)}
            aria-label={checked.has(idx) ? 'Mark as not gathered' : 'Mark as gathered'}
          >
            <span class="material-symbols-rounded">{checked.has(idx) ? 'check_box' : 'check_box_outline_blank'}</span>
          </button>
          <span class="kg-name" dir="auto">{it}</span>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .kg {
    border-top: 1px solid var(--border);
    padding-top: 16px;
    margin-top: 20px;
  }
  .kg.compact {
    border-top: none;
    padding-top: 0;
    margin-top: 12px;
  }
  .kg-title {
    font-size: 16px;
    font-weight: 700;
    margin: 0 0 10px;
    color: var(--text-1);
  }
  .kg-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .kg-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
    color: var(--text-1);
    font-size: 14px;
  }
  .kg-name {
    flex: 1;
    line-height: 1.3;
  }

  .check-btn {
    background: transparent;
    border: 1px solid transparent;
    cursor: pointer;
    color: var(--text-3);
    padding: 0;
    border-radius: var(--radius-sm);
    line-height: 0;
    flex-shrink: 0;
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .check-btn:hover { color: var(--accent); }
  .check-btn :global(.material-symbols-rounded) { font-size: 22px; }

  .kg-item.checked .kg-name { text-decoration: line-through; opacity: 0.55; }
  .kg-item.checked .check-btn { color: var(--accent); }

  .kg.cook-mode-off .check-btn {
    cursor: default;
    opacity: 0.45;
  }
  .kg.cook-mode-off .check-btn:hover { color: var(--text-3); }
</style>
