<!--
  WeekView: one week of the Cook Diary, cooked and planned together.

  Days behind you show what was cooked; today and the days ahead show the
  planned cooks, each with a servings stepper, and today's (or an earlier
  day's) plan can be marked cooked. Planned cooks for "any day" of the week
  sit in a tray above the days. The summary says what the plan needs and
  builds or updates the shopping list for the week.

  Props:
    days: [{ iso, weekday, num, isToday, isPast, entries }]
    anyDay: planned cooks for any day of the week
    needs: weekNeeds() for the week's plan, or null for a week gone by
    building: the list is being built
    usesUp: usesUp() for the week ({ items, ideas }), or null
    recipes: Map of recipe id -> recipe, for allergens
    members: the household; a planned cook names who it's a problem for
      among those home that day (lib/allergens.js)
  Events: open (entry), actions (entry), cooked (entry), servings ({ entry, value }),
    plan ({ date }), planAnyDay, build, buildWeek, planRecipe (recipe)
-->
<script>
  import { createEventDispatcher } from 'svelte';
  import { _, locale } from 'svelte-i18n';
  import ServingsStepper from '../ui/ServingsStepper.svelte';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import { longpress } from '../../lib/long-press.js';
  import AllergenChips from '../allergens/AllergenChips.svelte';
  import { cardAllergens } from '../../lib/allergens.js';

  export let days = [];
  export let anyDay = [];
  export let needs = null;
  export let building = false;
  export let usesUp = null;
  export let recipes = new Map();
  export let members = [];
  const allergensOf = e => {
    const r = e.recipe_id != null ? recipes.get(e.recipe_id) : null;
    return r ? cardAllergens(r) : null;
  };
  let usesUpEl;
  $: list = new Intl.ListFormat($locale || undefined, { style: 'long', type: 'conjunction' });

  const dispatch = createEventDispatcher();

  function photo(e) {
    const p = e.kind === 'cooked' ? (e.photo_url || e.recipe_img_url) : e.recipe_img_url;
    return p ? resolveAssetUrl(p) : '';
  }
  const servingsOf = e => (Number(e.servings) > 0 ? Math.round(Number(e.servings)) : 2);
  const MEAL_ICONS = { breakfast: 'free_breakfast', lunch: 'lunch_dining', dinner: 'restaurant', snack: 'cookie' };
</script>

{#if needs}
  <section class="week-summary" aria-label={$_('cookdiary_page.week.summary')}>
    <div class="tiles">
      <div class="tile">
        <span class="tile-value">{needs.meals}</span>
        <span class="tile-label">{$_('cookdiary_page.week.planned')}</span>
      </div>
      <div class="tile">
        <span class="tile-value">{needs.toBuy}</span>
        <span class="tile-label">{$_('cookdiary_page.week.to_buy')}</span>
      </div>
      <div class="tile">
        <span class="tile-value">{needs.inPantry}</span>
        <span class="tile-label">{$_('cookdiary_page.week.in_pantry')}</span>
      </div>
      {#if usesUp?.items?.length}
        <button class="tile good" on:click={() => usesUpEl?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          aria-label={$_('cookdiary_page.week.go_uses_up')}>
          <span class="tile-value">{needs.expiring}<span class="material-symbols-rounded" aria-hidden="true">eco</span></span>
          <span class="tile-label">{$_('cookdiary_page.week.uses_up')}</span>
        </button>
      {:else}
        <div class="tile" class:good={needs.expiring > 0}>
          <span class="tile-value">
            {needs.expiring}
            {#if needs.expiring > 0}<span class="material-symbols-rounded" aria-hidden="true">eco</span>{/if}
          </span>
          <span class="tile-label">{$_('cookdiary_page.week.uses_up')}</span>
        </div>
      {/if}
    </div>
    <div class="summary-actions">
      <button class="btn btn-secondary plan-week" on:click={() => dispatch('buildWeek')}>
        <span class="material-symbols-rounded" aria-hidden="true">auto_awesome</span>{$_('cookdiary_page.week.build_my_week')}
      </button>
      <button class="btn btn-primary build" on:click={() => dispatch('build')} disabled={building || needs.meals === 0}>
        <span class="material-symbols-rounded" class:spin={building} aria-hidden="true">{building ? 'progress_activity' : 'add_shopping_cart'}</span>
        {needs.built ? $_('cookdiary_page.week.update_list') : $_('cookdiary_page.week.build_list')}
      </button>
    </div>
  </section>
{/if}

{#if anyDay.length}
  <section class="tray" aria-label={$_('cookdiary_page.week.any_day_title')}>
    <header class="tray-head">
      <span class="material-symbols-rounded" aria-hidden="true">inbox</span>
      <h3>{$_('cookdiary_page.week.any_day_title')}</h3>
    </header>
    <div class="tray-cards">
      {#each anyDay as e (e.id)}
        <button class="tray-card" on:click={() => dispatch('actions', e)}
          aria-label={$_('cookdiary_page.week.any_day_card', { values: { name: e.recipe_name || 'Recipe' } })}>
          {#if photo(e)}<img src={photo(e)} alt="" loading="lazy" />{:else}<span class="ph material-symbols-rounded" aria-hidden="true">restaurant</span>{/if}
          <span class="tray-text">
            <span class="name">{e.recipe_name || 'Recipe'}</span>
            <span class="sub">{$_('cookdiary_page.servings_count', { values: { count: servingsOf(e) } })}</span>
            {#if members.length}<AllergenChips summary={allergensOf(e)} {members} />{/if}
          </span>
        </button>
      {/each}
    </div>
  </section>
{/if}

<ol class="days">
  {#each days as d (d.iso)}
    <li class="day" class:today={d.isToday}>
      <div class="day-date" aria-hidden="true">
        <span class="wd">{d.isToday ? $_('cookdiary_page.week.today') : d.weekday}</span>
        <span class="num">{d.num}</span>
      </div>
      <div class="day-body">
        <span class="sr-only">{d.label}</span>
        {#each d.entries as e (e.id)}
          {#if e.kind === 'cooked'}
            <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
            <article class="card cooked" use:longpress on:longpress={() => dispatch('actions', e)}
              on:contextmenu|preventDefault={() => dispatch('actions', e)}>
              <button class="card-main" on:click={() => dispatch('open', e)}>
                {#if photo(e)}<img src={photo(e)} alt="" loading="lazy" />{:else}<span class="ph material-symbols-rounded" aria-hidden="true">restaurant</span>{/if}
                <span class="card-text">
                  <span class="name">{e.recipe_name || 'Recipe'}</span>
                  <span class="chips">
                    <span class="chip done"><span class="material-symbols-rounded" aria-hidden="true">check_circle</span>{$_('cookdiary_page.week.cooked')}</span>
                    {#if e.rating > 0}
                      <span class="stars" aria-label={$_('cookdiary_page.week.stars', { values: { n: e.rating } })}>
                        {#each [1, 2, 3, 4, 5] as n}<span class="material-symbols-rounded" class:on={e.rating >= n} aria-hidden="true">star</span>{/each}
                      </span>
                    {/if}
                  </span>
                </span>
              </button>
            </article>
          {:else}
            <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
            <article class="card planned" class:now={d.isToday || d.isPast}
              use:longpress on:longpress={() => dispatch('actions', e)}
              on:contextmenu|preventDefault={() => dispatch('actions', e)}>
              <div class="card-row">
                <button class="card-main" on:click={() => dispatch('open', e)}>
                  {#if photo(e)}<img src={photo(e)} alt="" loading="lazy" />{:else}<span class="ph material-symbols-rounded" aria-hidden="true">restaurant</span>{/if}
                  <span class="card-text">
                    <span class="name">{e.recipe_name || 'Recipe'}</span>
                    {#if e.meal_type}
                      <span class="chips"><span class="chip"><span class="material-symbols-rounded" aria-hidden="true">{MEAL_ICONS[e.meal_type] || 'restaurant'}</span>{$_(`cookdiary_page.week.meal_${e.meal_type}`)}</span></span>
                    {/if}
                    {#if members.length}<AllergenChips summary={allergensOf(e)} {members} date={d.iso} />{/if}
                  </span>
                </button>
                <ServingsStepper value={servingsOf(e)} label={$_('cookdiary_page.servings')}
                  on:change={(ev) => dispatch('servings', { entry: e, value: ev.detail })} />
              </div>
              {#if d.isToday || d.isPast}
                <button class="btn btn-primary mark" on:click={() => dispatch('cooked', e)}>
                  <span class="material-symbols-rounded" aria-hidden="true">check</span>{$_('cookdiary_page.week.mark_cooked')}
                </button>
              {/if}
            </article>
          {/if}
        {/each}
        {#if !d.entries.length}
          {#if d.isPast}
            <p class="nothing">{$_('cookdiary_page.week.nothing_cooked')}</p>
          {:else}
            <button class="plan-day" on:click={() => dispatch('plan', { date: d.iso })}>
              <span class="material-symbols-rounded" aria-hidden="true">add</span>{$_('cookdiary_page.plan_a_cook')}
            </button>
          {/if}
        {/if}
      </div>
    </li>
  {/each}
</ol>

{#if usesUp?.items?.length}
  <section class="uses-up" bind:this={usesUpEl} aria-label={$_('cookdiary_page.week.uses_up_title')}>
    <header class="uses-head">
      <span class="material-symbols-rounded" aria-hidden="true">eco</span>
      <h3>{$_('cookdiary_page.week.uses_up_title')}</h3>
      <span class="uses-sub">{$_('cookdiary_page.week.uses_up_sub')}</span>
    </header>
    <ul class="soon">
      {#each usesUp.items as x (x.family)}
        <li class="soon-item">
          <span class="soon-name">{x.name}</span>
          <span class="soon-days" class:urgent={x.daysLeft != null && x.daysLeft <= 2}>{$_('cookdiary_page.week.days_left', { values: { n: Math.max(0, x.daysLeft ?? 0) } })}</span>
          {#if x.plannedBy.length}<span class="soon-in">{$_('cookdiary_page.week.in_plan', { values: { names: list.format(x.plannedBy) } })}</span>{/if}
        </li>
      {/each}
    </ul>
    {#each usesUp.ideas as idea (idea.recipe.id)}
      <div class="idea">
        {#if idea.recipe.imgUrl || idea.recipe.img_url}
          <img src={idea.recipe.imgUrl || resolveAssetUrl(idea.recipe.img_url)} alt="" loading="lazy" />
        {:else}<span class="ph material-symbols-rounded" aria-hidden="true">restaurant</span>{/if}
        <span class="idea-text">
          <span class="name">{idea.recipe.name}</span>
          <span class="sub">{$_('cookdiary_page.week.idea_uses', { values: { items: list.format(idea.uses) } })}</span>
          {#if members.length}<AllergenChips summary={cardAllergens(idea.recipe)} {members} />{/if}
        </span>
        <button class="btn btn-primary idea-plan" on:click={() => dispatch('planRecipe', idea.recipe)}
          aria-label={$_('cookdiary_page.week.plan_recipe', { values: { name: idea.recipe.name } })}>
          <span class="material-symbols-rounded" aria-hidden="true">add</span>{$_('cookdiary_page.week.plan')}
        </button>
      </div>
    {/each}
  </section>
{/if}

<style>
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  /* Summary: four tiles in a row and the list button. */
  .week-summary {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 14px;
  }
  .tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
  .tile {
    display: flex; flex-direction: column; gap: 2px;
    padding: 8px 10px; background: var(--surface-2); border-radius: var(--radius-md); min-width: 0;
  }
  .tile-value { display: inline-flex; align-items: center; gap: 3px; font-size: 19px; font-weight: 800; line-height: 1.1; color: var(--text-1); }
  .tile-value .material-symbols-rounded { font-size: 16px; }
  .tile-label { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); }
  .tile.good { background: var(--accent-dim); }
  .tile.good .tile-value, .tile.good .tile-label { color: var(--accent); }
  .summary-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .summary-actions .btn { flex: 1 1 160px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
  button.tile { border: none; font: inherit; text-align: left; cursor: pointer; }

  /* Uses up: what's about to expire, and what would use it. */
  .uses-up {
    margin-top: 16px; background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); padding: 12px; display: flex; flex-direction: column; gap: 10px; scroll-margin-top: 140px;
  }
  .uses-head { display: flex; align-items: center; gap: 6px; }
  .uses-head .material-symbols-rounded { font-size: 18px; color: var(--accent); }
  .uses-head h3 { margin: 0; font-size: 14px; font-weight: 700; color: var(--text-1); }
  .uses-sub { margin-left: auto; font-size: 12px; color: var(--text-2); }
  .soon { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; }
  .soon-item { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; background: var(--surface-2); border-radius: var(--radius-md); min-width: 0; }
  .soon-name { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .soon-days { font-size: 12px; color: var(--text-2); }
  .soon-days.urgent { color: var(--warning); font-weight: 600; }
  .soon-in { font-size: 11px; color: var(--accent); }
  .idea { display: flex; align-items: center; gap: 10px; padding: 8px; border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border)); border-radius: var(--radius-md); }
  .idea img, .idea .ph { width: 48px; height: 48px; border-radius: var(--radius-sm); object-fit: cover; flex: none; }
  .idea-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .idea-plan { min-height: 40px; display: inline-flex; align-items: center; gap: 4px; padding: 0 12px; flex: none; }
  .spin { animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Any day this week. */
  .tray { margin-bottom: 14px; }
  .tray-head { display: flex; align-items: center; gap: 6px; color: var(--text-2); margin-bottom: 8px; }
  .tray-head h3 { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
  .tray-head .material-symbols-rounded { font-size: 16px; }
  .tray-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .tray-card {
    display: flex; gap: 10px; align-items: center; padding: 8px; min-width: 0; min-height: 56px;
    background: var(--surface-1); border: 1px dashed var(--border-strong); border-radius: var(--radius-md);
    color: var(--text-1); text-align: left; cursor: pointer; font: inherit;
  }
  .tray-card img, .tray-card .ph { width: 40px; height: 40px; border-radius: var(--radius-sm); object-fit: cover; flex: none; }
  .tray-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }

  /* Days. */
  .days { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .day { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 10px; align-items: start; }
  .day-date { display: flex; flex-direction: column; align-items: center; gap: 2px; padding-top: 6px; }
  .wd { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); }
  .num {
    width: 32px; height: 32px; border-radius: var(--radius-full);
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; font-weight: 800; color: var(--text-1);
  }
  .day.today .wd { color: var(--accent); }
  .day.today .num { background: var(--accent); color: var(--accent-text); }
  .day-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }

  .card {
    display: flex; flex-direction: column; gap: 8px; padding: 10px; min-width: 0;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg);
  }
  .card.cooked { background: color-mix(in srgb, var(--surface-1) 60%, transparent); }
  .card.planned.now { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .card-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .card-main {
    flex: 1; min-width: 0; display: flex; gap: 12px; align-items: center;
    background: none; border: none; padding: 0; color: inherit; font: inherit; text-align: left; cursor: pointer;
  }
  .card-main img, .card-main .ph { width: 56px; height: 56px; border-radius: var(--radius-md); object-fit: cover; flex: none; }
  .ph { display: flex; align-items: center; justify-content: center; background: var(--surface-2); color: var(--text-3); font-size: 22px; }
  .card-text { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .name { font-size: 15px; font-weight: 700; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tray-text .name { font-size: 14px; font-weight: 600; }
  .sub { font-size: 12px; color: var(--text-2); }
  .chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px;
    border-radius: var(--radius-full); background: var(--surface-2);
    font-size: 12px; font-weight: 500; color: var(--text-2);
  }
  .chip .material-symbols-rounded { font-size: 14px; }
  .chip.done { background: var(--accent-dim); color: var(--accent); font-weight: 600; }
  .stars { display: inline-flex; gap: 1px; color: var(--text-3); }
  .stars .material-symbols-rounded { font-size: 15px; }
  .stars .on { color: var(--warning); font-variation-settings: 'FILL' 1; }
  .mark { min-height: 40px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .nothing { margin: 8px 0 0; font-size: 13px; color: var(--text-3); }
  .plan-day {
    min-height: 48px; display: flex; align-items: center; justify-content: center; gap: 6px;
    border: 1.5px dashed var(--border-strong); border-radius: var(--radius-lg); background: transparent;
    color: var(--text-2); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .plan-day:hover { border-color: var(--accent); color: var(--accent); }

  /* Wide screens and unfolded foldables: the days in two columns. */
  :global(html.wide-content) .days { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
</style>
