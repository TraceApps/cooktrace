<!--
  RecipeAllergens: the recipe view's allergen panel. What the recipe
  contains (a problem for someone in the household names them), what it
  may contain (dashed), who doesn't like an ingredient, a note that it's
  worked out and not a guarantee, and Correct for what the names and
  labels can't know (gluten-free flour).

  Props:
    recipe: with ingredients and allergen_overrides
    pantryById: Map of pantry id -> row (allergens, traces), or null
    members: the household (cleanHousehold)
    canCorrect: may this person change the recipe
  Events: corrected ({ allergen_overrides }) after a correction is saved
-->
<script>
  import { createEventDispatcher } from 'svelte';
  import { _, locale } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import AllergenChips from './AllergenChips.svelte';
  import { NtApi } from '../../lib/api.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { ALLERGENS, allergenKey, recipeAllergens, cleanOverrides, dislikesIn, conflicts } from '../../lib/allergens.js';

  export let recipe = null;
  export let pantryById = null;
  export let members = [];
  export let canCorrect = false;

  const dispatch = createEventDispatcher();

  $: info = recipe ? recipeAllergens(recipe, pantryById) : { contains: [], traces: [] };
  $: dislikes = recipe ? dislikesIn(recipe, members) : [];
  $: list = new Intl.ListFormat($locale || undefined, { style: 'short', type: 'conjunction' });
  // Allergens, or a diet someone home keeps (meat for a vegetarian).
  $: hits = conflicts(info, members);
  $: showContains = info.contains.some(x => ALLERGENS.includes(x.code)) || hits.contains.length > 0;
  $: anything = showContains || info.traces.length > 0 || dislikes.length > 0;

  // ── Correct ─────────────────────────────────────────────────────────
  let open = false;
  let picked = [];
  let saving = false;
  // What the names and labels say without a correction: the correction is
  // kept as the difference from it.
  $: base = recipe ? recipeAllergens(recipe, pantryById, null).contains.map(x => x.code).filter(c => ALLERGENS.includes(c)) : [];
  function startCorrect() {
    picked = info.contains.map(x => x.code).filter(c => ALLERGENS.includes(c));
    open = true;
  }
  async function save(fix) {
    saving = true;
    try {
      const next = cleanOverrides(fix);
      const res = await NtApi.setRecipeAllergens(recipe.id, next);
      const stored = res?.allergen_overrides !== undefined ? res.allergen_overrides
        : (next.add.length || next.remove.length ? JSON.stringify(next) : null);
      dispatch('corrected', { allergen_overrides: stored });
      showSuccess($_('allergen_info.saved'));
      open = false;
    } catch (e) {
      showError(e.message || 'Could not save');
    } finally {
      saving = false;
    }
  }
  const saveCorrection = () => save({ add: picked.filter(c => !base.includes(c)), remove: base.filter(c => !picked.includes(c)) });
  const toggle = c => (picked = picked.includes(c) ? picked.filter(x => x !== c) : [...picked, c]);
  $: hasCorrection = (() => { const f = cleanOverrides(recipe?.allergen_overrides); return f.add.length + f.remove.length > 0; })();
</script>

{#if anything || hasCorrection}
  <section class="allergens" aria-label={$_('allergen_info.section')}>
    {#if showContains}
      <div class="row">
        <span class="row-label">{$_('allergen_info.contains')}</span>
        <AllergenChips summary={{ contains: info.contains, traces: [] }} {members} only="all" />
      </div>
    {/if}
    {#if info.traces.length}
      <div class="row">
        <span class="row-label">{$_('allergen_info.may_contain')}</span>
        <AllergenChips summary={{ contains: [], traces: info.traces }} {members} only="all" />
      </div>
    {/if}
    {#each dislikes as d (d.item)}
      <p class="dislike">
        <span class="material-symbols-rounded" aria-hidden="true">sentiment_dissatisfied</span>
        {$_(d.who.length > 1 ? 'allergen_info.dislikes_many' : 'allergen_info.dislikes', { values: { who: list.format(d.who), item: d.item } })}
      </p>
    {/each}
    <div class="foot">
      <span class="material-symbols-rounded" aria-hidden="true">info</span>
      <span class="note">{$_('allergen_info.note')}</span>
      {#if canCorrect}
        <button type="button" class="correct" on:click={startCorrect}>{$_('allergen_info.correct')}</button>
      {/if}
    </div>
  </section>
{/if}

<Sheet bind:open title={$_('allergen_info.correct_title')}>
  <div class="sheet-body">
    <p class="desc">{$_('allergen_info.correct_desc')}</p>
    <div class="chips">
      {#each ALLERGENS as c (c)}
        <button type="button" class="pick" class:on={picked.includes(c)} aria-pressed={picked.includes(c)} on:click={() => toggle(c)}>
          {#if picked.includes(c)}<span class="material-symbols-rounded" aria-hidden="true">check</span>{/if}{$_(`allergens.${allergenKey(c)}`)}
        </button>
      {/each}
    </div>
    <div class="actions">
      {#if hasCorrection}
        <button type="button" class="btn btn-secondary" disabled={saving} on:click={() => save({ add: [], remove: [] })}>
          <span class="material-symbols-rounded" aria-hidden="true">restart_alt</span>{$_('allergen_info.reset')}
        </button>
      {/if}
      <button type="button" class="btn btn-primary" disabled={saving} on:click={saveCorrection}>
        <span class="material-symbols-rounded" aria-hidden="true">check</span>{$_('household.save')}
      </button>
    </div>
  </div>
</Sheet>

<style>
  .allergens {
    display: flex; flex-direction: column; gap: 8px; padding: 12px; margin-top: 12px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg);
  }
  .row { display: flex; align-items: flex-start; gap: 6px; }
  .row-label {
    width: 96px; flex: none; padding-top: 4px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2);
  }
  .dislike { margin: 0; display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-2); }
  .dislike .material-symbols-rounded { font-size: 16px; }
  .foot { display: flex; align-items: flex-start; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
  .foot .material-symbols-rounded { font-size: 16px; color: var(--text-2); }
  .note { flex: 1; font-size: 12px; line-height: 1.4; color: var(--text-2); }
  .correct {
    min-height: 32px; padding: 0 10px; margin: -6px 0; border: none; border-radius: var(--radius-md);
    background: transparent; color: var(--accent); font: inherit; font-size: 12px; font-weight: 700; cursor: pointer;
  }
  .sheet-body { display: flex; flex-direction: column; gap: 14px; padding-bottom: 8px; }
  .desc { margin: 0; font-size: 13px; line-height: 1.45; color: var(--text-2); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .pick {
    display: inline-flex; align-items: center; gap: 4px; min-height: 36px; padding: 0 12px;
    border-radius: var(--radius-full); border: 1px solid var(--border-strong); background: transparent;
    color: var(--text-2); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .pick.on { background: var(--accent-dim); border-color: transparent; color: var(--accent); }
  .pick .material-symbols-rounded { font-size: 16px; }
  .actions { display: flex; gap: 8px; }
  .actions .btn { flex: 1; min-height: 48px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
</style>
