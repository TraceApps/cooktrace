<script>
  /**
   * PlanCookDialog: plan a cook for a day, or for any day of that day's
   * week, with its meal and how many it's for. The Diary's Plan a Cook,
   * the Week view's free days, a recipe's Plan button and a recipe card's
   * Plan a Cook all use it (#61).
   *
   * Given a `recipe`, it plans that one and shows it at the top. Without
   * one, it lists your recipes to pick from (`pickId` picked first).
   * Dispatches `planned` with the new diary entry.
   *
   * Given a planned `entry`, it edits that plan instead (#81): its day (any
   * day, today or later), meal and servings, the recipe staying as it is.
   * Dispatches `saved` with what the server said (its `list`, when the
   * shopping list followed).
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import { closeOnBack } from '../../lib/back-stack.js';
  import { failed } from '../../lib/messages.js';
  import { NtApi } from '../../lib/api.js';
  import { household } from '../../stores/settings.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { cleanHousehold, homeOn, cardAllergens } from '../../lib/allergens.js';
  import { firstDayOfWeek, weekStartOf, isoDay, fromIso } from '../../lib/week.js';
  import { foldText } from '../../lib/search-text.js';
  import AllergenChips from '../allergens/AllergenChips.svelte';
  import DateInput from '../ui/DateInput.svelte';
  import ServingsStepper from '../ui/ServingsStepper.svelte';

  export let open = false;
  /** The recipe to plan; null lists your recipes to pick from. */
  export let recipe = null;
  /** In the list, the recipe picked when it opens. */
  export let pickId = null;
  /** The day it opens on (YYYY-MM-DD); today when not given. */
  export let date = null;
  /** A planned cook to edit: { id, recipe_id, recipe_name, date, any_day, meal_type, servings }. */
  export let entry = null;
  /** The edited plan's recipe in full, when the page has it (allergens). */
  export let entryRecipe = null;

  const dispatch = createEventDispatcher();
  const firstDay = firstDayOfWeek();
  const today = () => isoDay(new Date());

  let planDate = today();
  let anyDay = false;
  let mealType = null;      // 'breakfast' | 'lunch' | 'dinner' | 'snack' | null
  let servings = 2;         // how many to cook for: the list scales to it
  let servingsSet = false;  // changed by hand: picking a recipe keeps it
  let recipeId = null;
  let recipes = [];         // for the list, loaded when it's first needed
  let search = '';
  let busy = false;
  let wasOpen = false;
  let servingsFrom = null; // editing: the servings it opened on

  $: MEALS = [
    { id: 'breakfast', label: $_('cookdiary_page.week.meal_breakfast'), icon: 'free_breakfast' },
    { id: 'lunch',     label: $_('cookdiary_page.week.meal_lunch'),     icon: 'lunch_dining'   },
    { id: 'dinner',    label: $_('cookdiary_page.week.meal_dinner'),    icon: 'restaurant'     },
    { id: 'snack',     label: $_('cookdiary_page.week.meal_snack'),     icon: 'cookie'         },
  ];

  // Fresh each time it opens. (A function, so this runs on `open` alone:
  // a reactive `wasOpen = open` would be sorted ahead of it.)
  $: _opened(open);
  function _opened(now) {
    if (now && !wasOpen) { reset(); tick().then(() => panel?.focus()); }
    wasOpen = now;
  }
  let panel;
  async function reset() {
    if (entry) {
      // An any-day plan is dated its week's first day, which may be gone:
      // turned into a dated plan, it starts on today at the earliest.
      planDate = entry.any_day && entry.date < today() ? today() : (entry.date || today());
      anyDay = !!entry.any_day;
      mealType = entry.meal_type || null;
      // A plan without servings shops for the recipe as written; it keeps
      // none unless they're changed here.
      const n = Math.round(Number(entry.servings ?? entryRecipe?.servings));
      servings = Number.isFinite(n) && n > 0 ? n : 2;
      servingsFrom = servings;
      servingsSet = true;
      search = '';
      recipeId = entry.recipe_id;
      return;
    }
    planDate = date || today();
    anyDay = false;
    mealType = null;
    search = '';
    servingsSet = false;
    servings = 2;
    recipeId = null;
    if (recipe) { pick(recipe.id, recipe); return; }
    if (recipes.length === 0) {
      try {
        const list = await NtApi.getRecipes();
        recipes = list.slice().sort((a, b) =>
          (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }));
      } catch { recipes = []; }
    }
    if (pickId != null) pick(Number(pickId));
  }

  // Who you cook for (Settings > Household): servings start at who's home
  // that day (everyone, for any day of the week). Without a household, at
  // the recipe's own. Either way a change by hand stays.
  $: members = cleanHousehold($household);
  $: if (open && !servingsSet && members.length) {
    servings = Math.max(1, homeOn(members, anyDay ? null : planDate).length);
  }
  function pick(id, r = recipes.find(x => x.id === id)) {
    recipeId = id;
    if (servingsSet || members.length) return;
    const n = Math.round(Number(r?.servings));
    servings = Number.isFinite(n) && n > 0 ? n : 2;
  }

  $: shown = search.trim()
    ? recipes.filter(r => foldText(r.name).includes(foldText(search).trim()))
    : recipes;

  function close() { open = false; }

  // The recipe at the top: the one given, or the edited plan's.
  $: shownRecipe = recipe || (entry ? {
    ...(entryRecipe || {}),
    id: entry.recipe_id,
    name: entry.recipe_name || entryRecipe?.name || '',
    imgUrl: entry.recipe_img_url ? resolveAssetUrl(entry.recipe_img_url) : null,
  } : null);

  async function save() {
    if (!recipeId) { showError($_('cookdiary_page.toast.pick_recipe')); return; }
    busy = true;
    if (entry) {
      try {
        const result = await NtApi.updateDiaryEntry(entry.id, {
          date: anyDay ? isoDay(weekStartOf(fromIso(planDate), firstDay)) : planDate,
          any_day: anyDay,
          meal_type: mealType || null,
          ...(entry.servings != null || servings !== servingsFrom ? { servings } : {}),
        });
        open = false;
        dispatch('saved', result || {});
      } catch (e) {
        showError(failed('fail.update_entry', e));
      } finally {
        busy = false;
      }
      return;
    }
    try {
      // Any day of the week: dated the week's first day.
      const entry = await NtApi.createDiaryEntry({
        recipe_id: recipeId,
        date: anyDay ? isoDay(weekStartOf(fromIso(planDate), firstDay)) : planDate,
        kind: 'planned',
        meal_type: mealType || null,
        servings,
        any_day: anyDay,
      });
      showSuccess($_('cookdiary_page.toast.planned'));
      open = false;
      dispatch('planned', entry);
    } catch (e) {
      showError(failed('fail.plan_cook', e));
    } finally {
      busy = false;
    }
  }
</script>

<!-- Escape closes it, as Back does. -->
<svelte:window on:keydown={(e) => { if (open && e.key === 'Escape') close(); }} />

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div use:portal class="modal-backdrop" on:click|self={close} use:closeOnBack={close} transition:fade={{ duration: 160 }}>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="plan-cook-title" tabindex="-1" bind:this={panel} on:click|stopPropagation>
      <header class="modal-header">
        <h2 id="plan-cook-title">{entry ? $_('cookdiary_page.edit_plan') : $_('cookdiary_page.plan_a_cook')}</h2>
        <button class="btn-icon" on:click={close} aria-label={$_('common.close')}><span class="material-symbols-rounded">close</span></button>
      </header>
      <div class="modal-body">
        {#if shownRecipe}
          <div class="recipe-row fixed">
            {#if shownRecipe.imgUrl}
              <img src={shownRecipe.imgUrl} alt="" />
            {:else}
              <span class="material-symbols-rounded">restaurant</span>
            {/if}
            <span class="recipe-text">
              <span class="recipe-name" dir="auto">{shownRecipe.name}</span>
              {#if members.length}<AllergenChips summary={cardAllergens(shownRecipe)} recipe={shownRecipe} {members} date={anyDay ? '' : planDate} />{/if}
            </span>
          </div>
        {/if}
        <label class="field">
          <span class="field-label">{$_('cookdiary_page.date')}</span>
          <DateInput bind:value={planDate} min={entry ? today() : ''} />
        </label>
        <button type="button" class="meal-chip any-day-toggle" class:active={anyDay}
          aria-pressed={anyDay} on:click={() => anyDay = !anyDay}>
          <span class="material-symbols-rounded">{anyDay ? 'check' : 'inbox'}</span>
          {$_('cookdiary_page.week.any_day_toggle')}
        </button>
        <div class="field">
          <span class="field-label">{$_('cookdiary_page.meal')} <span class="field-hint">{$_('cookdiary_page.optional')}</span></span>
          <div class="meal-chips" role="group" aria-label={$_('cook_diary_ui.meal_type')}>
            {#each MEALS as m}
              <button type="button" class="meal-chip" class:active={mealType === m.id}
                aria-pressed={mealType === m.id}
                on:click={() => mealType = (mealType === m.id ? null : m.id)}>
                <span class="material-symbols-rounded">{m.icon}</span>
                {m.label}
              </button>
            {/each}
          </div>
        </div>
        <div class="field servings-field">
          <span class="field-label">{$_('cookdiary_page.servings')}</span>
          <ServingsStepper bind:value={servings} label={$_('cookdiary_page.servings')}
            on:change={() => servingsSet = true} />
        </div>
        {#if !shownRecipe}
          <label class="field">
            <span class="field-label">{$_('cookdiary_page.recipe')}</span>
            <input class="input" type="search" placeholder={$_('cook_diary_ui.search')} bind:value={search} />
          </label>
          <div class="recipe-picker">
            {#each shown as r (r.id)}
              <button class="recipe-row" class:active={recipeId === r.id} on:click={() => pick(r.id)}>
                {#if r.imgUrl}
                  <img src={r.imgUrl} alt="" loading="lazy" />
                {:else}
                  <span class="material-symbols-rounded">restaurant</span>
                {/if}
                <span class="recipe-text">
                  <span class="recipe-name" dir="auto">{r.name}</span>
                  {#if members.length}<AllergenChips summary={cardAllergens(r)} recipe={r} {members} date={anyDay ? '' : planDate} />{/if}
                </span>
                {#if recipeId === r.id}<span class="material-symbols-rounded check">check</span>{/if}
              </button>
            {:else}
              <p class="empty-line">{$_('cook_diary_ui.no_recipes_match')}</p>
            {/each}
          </div>
        {/if}
      </div>
      <footer class="modal-footer">
        <button class="btn btn-secondary" on:click={close}>{$_('cookdiary_page.cancel')}</button>
        <button class="btn btn-primary" on:click={save} disabled={busy}>
          {busy ? $_('cookdiary_page.saving') : entry ? $_('cookdiary_page.save_plan') : $_('cookdiary_page.plan_it')}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed; inset: 0;
    background: var(--overlay, rgba(0, 0, 0, 0.55));
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    z-index: 130; display: flex; align-items: center; justify-content: center;
    padding: 16px;
  }
  .modal:focus { outline: none; }
  .modal {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); width: 100%; max-width: 460px;
    max-height: min(calc(100vh - 32px), calc(100dvh - 2 * var(--safe-top) - 16px)); display: flex; flex-direction: column;
    box-shadow: 0 16px 48px rgba(0,0,0,0.4);
  }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px; border-bottom: 1px solid var(--border);
  }
  .modal-header h2 { margin: 0; font-size: 17px; font-weight: 700; color: var(--text-1); }
  .modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; flex: 1; overflow-y: auto; }
  .modal-footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; border-top: 1px solid var(--border); }
  .btn-icon {
    background: transparent; border: none; cursor: pointer;
    color: var(--text-3); width: 34px; height: 34px;
    display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-sm);
  }
  .btn-icon:hover { color: var(--text-1); background: var(--surface-2); }

  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 13px; font-weight: 600; color: var(--text-2); }
  .field-hint { font-weight: 400; color: var(--text-3); font-size: 12px; }
  /* Servings: the label on the left, the stepper on the right. */
  .servings-field { flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; }
  .input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px; color: var(--text-1);
    font-size: 14px; box-sizing: border-box; width: 100%;
  }

  /* Meal chips: the same look as the cook dialog's. */
  .meal-chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .meal-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 6px 10px; min-height: 32px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-full, 99px);
    color: var(--text-2); font-size: 12px; font-weight: 600; cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .meal-chip:hover { color: var(--text-1); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .meal-chip.active { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }
  .meal-chip .material-symbols-rounded { font-size: 14px; }
  .any-day-toggle { align-self: flex-start; }

  .recipe-picker { display: flex; flex-direction: column; gap: 4px; max-height: 280px; overflow-y: auto; padding: 4px 0; }
  .recipe-row {
    display: flex; align-items: center; gap: 10px;
    background: transparent; border: 1px solid transparent;
    border-radius: var(--radius-sm); padding: 6px 10px;
    cursor: pointer; text-align: left; font: inherit; color: inherit;
  }
  .recipe-row:hover { background: var(--surface-2); }
  .recipe-row.active { background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
  /* The recipe being planned, at the top: not a choice. */
  .recipe-row.fixed { cursor: default; background: var(--surface-2); padding: 8px 10px; }
  .recipe-row img { width: 40px; height: 40px; border-radius: var(--radius-sm); object-fit: cover; flex-shrink: 0; }
  .recipe-row > .material-symbols-rounded:first-child { color: var(--text-3); width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .recipe-text { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; text-align: left; }
  .recipe-name { font-size: 14px; color: var(--text-1); overflow-wrap: anywhere; }
  .recipe-row.fixed .recipe-name { font-weight: 600; }
  .recipe-row.active .recipe-name { color: var(--accent); font-weight: 600; }
  .recipe-row .check { color: var(--accent); }
  .empty-line { color: var(--text-3); font-size: 13px; text-align: center; padding: 16px; margin: 0; font-style: italic; }
</style>
