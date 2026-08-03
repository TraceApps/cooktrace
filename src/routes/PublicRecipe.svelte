<script>
  /**
   * PublicRecipe — read-only recipe viewer reachable via /r/:token.
   *
   * Loads through `/api/r/:token`, an unauthenticated endpoint. The
   * page intentionally avoids any per-user state (no Cook Mode, no
   * checkbox state, no comments, no favorite, no rating writes) and
   * shows just the recipe content + a soft "View on CookTrace" CTA.
   */
  import { _ } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { resolveAssetUrl } from '../lib/platform.js';
  import { formatDuration } from '../lib/duration.js';
  import { formatDate, domainFromUrl } from '../lib/format.js';
  import { dateFormat } from '../stores/settings.js';
  import { scaleQty, displayQty } from '../lib/qty.js';
  import KitchenGear from '../components/recipe/KitchenGear.svelte';
  import NutritionFactsBox from '../components/recipe/NutritionFactsBox.svelte';
  import { splitWithTimes } from '../lib/parseTimes.js';
  import { startTimer, formatRemaining } from '../stores/cookTimers.js';
  import { apiUrl } from '../lib/platform.js';

  export let params = {};
  $: token = params.token || '';

  let recipe = null;
  let loading = true;
  let loadError = null;
  let scale = 1;
  $: scaledServings = recipe?.servings ? Math.round(recipe.servings * scale * 10) / 10 : null;

  async function load() {
    loading = true;
    loadError = null;
    try {
      const res = await fetch(apiUrl(`/api/r/${encodeURIComponent(token)}`), {
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!res.ok) {
        if (res.status === 404) loadError = 'This share link is no longer valid.';
        else loadError = `Server error (${res.status})`;
        return;
      }
      recipe = await res.json();
    } catch (e) {
      loadError = e.message || 'Could not load recipe';
    } finally {
      loading = false;
    }
  }
  $: if (token) load();

  function totalMinutes(r) {
    if (r?.total_minutes != null) return r.total_minutes;
    return (r?.prep_minutes || 0) + (r?.cook_minutes || 0) + (r?.rest_minutes || 0);
  }
</script>

<div class="public-shell">
  <header class="bar">
    <span class="brand">
      <span class="material-symbols-rounded">restaurant_menu</span>
      CookTrace
    </span>
  </header>

  <main class="content">
    {#if loading}
      <div class="state" in:fade={{ duration: 120 }}>
        <span class="material-symbols-rounded spin">progress_activity</span>
      </div>
    {:else if loadError}
      <div class="state error">
        <span class="material-symbols-rounded">error</span>
        <h2>{loadError}</h2>
        <p>Ask the person who shared this for an updated link.</p>
      </div>
    {:else if recipe}
      {#if recipe.img_url}
        <div class="hero">
          <img src={resolveAssetUrl(recipe.img_url)} alt="" />
        </div>
      {/if}

      <div class="body">
        {#if recipe.category}
          <span class="cat-pill"
            style={recipe.category.color ? `--cat-color:${recipe.category.color}` : ''}>
            {recipe.category.name}
          </span>
        {/if}
        <h1>{recipe.name}</h1>
        {#if recipe.description}<p class="desc">{recipe.description}</p>{/if}

        <p class="byline">
          {#if recipe.created_by_full_name || recipe.created_by_username}
            <span>{$_('public_recipe_ct.shared_by_prefix')}<strong>{recipe.created_by_full_name || recipe.created_by_username}</strong></span>
          {/if}
          {#if recipe.created_at}
            <span class="dot">·</span>
            <span>{formatDate(recipe.created_at, $dateFormat)}</span>
          {/if}
          {#if recipe.source_url && domainFromUrl(recipe.source_url)}
            <span class="dot">·</span>
            <span>{$_('public_recipe_ct.from_prefix')}<a href={recipe.source_url} target="_blank" rel="noopener noreferrer">{domainFromUrl(recipe.source_url)}</a></span>
          {/if}
        </p>

        <div class="meta-row">
          {#if recipe.prep_minutes}
            <div class="meta-stat">
              <span class="material-symbols-rounded">schedule</span>
              <span><strong>{formatDuration(recipe.prep_minutes)}</strong> {$_('public_recipe_ct.prep')}</span>
            </div>
          {/if}
          {#if recipe.cook_minutes}
            <div class="meta-stat">
              <span class="material-symbols-rounded">local_fire_department</span>
              <span><strong>{formatDuration(recipe.cook_minutes)}</strong> {$_('public_recipe_ct.cook')}</span>
            </div>
          {/if}
          {#if recipe.rest_minutes}
            <div class="meta-stat">
              <span class="material-symbols-rounded">hourglass_top</span>
              <span><strong>{formatDuration(recipe.rest_minutes)}</strong> {$_('public_recipe_ct.rest')}</span>
            </div>
          {/if}
          {#if totalMinutes(recipe) > 0}
            <div class="meta-stat">
              <span class="material-symbols-rounded">timer</span>
              <span><strong>{formatDuration(totalMinutes(recipe))}</strong> {$_('public_recipe_ct.total')}</span>
            </div>
          {/if}
          {#if recipe.servings}
            <div class="meta-stat">
              <span class="material-symbols-rounded">restaurant</span>
              <span><strong>{recipe.servings}</strong> {$_('public_recipe_ct.servings')}</span>
            </div>
          {/if}
        </div>

        <div class="layout">
          <section class="col col-left">
            <h2>{$_('public_recipe_ct.ingredients')}</h2>
            {#if recipe.servings}
              <div class="scale-row">
                <span class="scale-label">{$_('public_recipe_ct.scale')}</span>
                {#each [0.5, 1, 2, 3] as f}
                  <button class="scale-chip" class:active={scale === f} on:click={() => scale = f}>×{f}</button>
                {/each}
              </div>
            {/if}
            {#if recipe.ingredients?.length}
              {#each recipe.ingredients as group}
                {#if group.name}<h3 class="grp-name">{group.name}</h3>{/if}
                <ul class="ing-list">
                  {#each group.items as ing}
                    <li>
                      {#if ing.qty || ing.unit}
                        <span class="qty">{displayQty(ing.qty, ing.unit, scale)}{ing.qty && ing.unit ? ' ' : ''}{ing.unit || ''}</span>
                      {/if}
                      <span>{ing.name}</span>
                      {#if ing.note}<span class="note">— {ing.note}</span>{/if}
                    </li>
                  {/each}
                </ul>
              {/each}
            {:else}
              <p class="empty">{$_('public_recipe_ct.no_ingredients')}</p>
            {/if}

            <KitchenGear items={recipe.tools || []} />
          </section>

          <section class="col col-mid">
            <h2>{$_('public_recipe_ct.steps')}</h2>
            {#if recipe.steps?.length}
              <ol class="steps">
                {#each recipe.steps as step, i}
                  {@const text = typeof step === 'string' ? step : (step.text || '')}
                  {@const title = typeof step === 'string' ? '' : (step.title || '')}
                  {@const parts = splitWithTimes(text)}
                  <li>
                    <span class="step-num">{i + 1}</span>
                    <div>
                      {#if title}<strong>{title}: </strong>{/if}
                      {#each parts as p}
                        {#if p.type === 'text'}{p.value}{:else}<button
                          class="time-chip"
                          on:click={() => startTimer({
                            label: `${recipe.name} · Step ${i + 1}`,
                            durationSec: p.durationSec,
                          })}
                          title={`Start ${formatRemaining(p.durationSec * 1000)} timer`}
                        ><span class="material-symbols-rounded">play_arrow</span>{p.value}</button>{/if}
                      {/each}
                    </div>
                  </li>
                {/each}
              </ol>
            {:else}
              <p class="empty">{$_('public_recipe_ct.no_steps')}</p>
            {/if}

            {#if recipe.notes}
              <h2>{$_('public_recipe_ct.notes')}</h2>
              <p class="notes">{recipe.notes}</p>
            {/if}
          </section>

          <section class="col col-right">
            <NutritionFactsBox
              nutrition={recipe.nutrition}
              servings={recipe.servings}
              yieldText={recipe.yield_text}
            />
          </section>
        </div>
      </div>
    {/if}
  </main>

  <footer class="footer">
    <p>{@html $_('public_recipe_ct.powered_by_html')}</p>
  </footer>
</div>

<style>
  .public-shell {
    min-height: 100vh;
    background: var(--bg, var(--surface-1));
    color: var(--text-1);
    display: flex;
    flex-direction: column;
  }
  .bar {
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    color: var(--accent);
    font-size: 15px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .brand .material-symbols-rounded { font-size: 20px; }

  .content { flex: 1; }

  .state {
    text-align: center;
    padding: 80px 20px;
    color: var(--text-3);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .state.error h2 { color: var(--text-1); margin: 8px 0 4px; }
  .spin { font-size: 32px; animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .hero {
    width: 100%;
    max-height: min(60vh, 520px);
    overflow: hidden;
    background: var(--surface-2);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .hero img { max-width: 100%; max-height: 100%; object-fit: contain; }

  .body {
    padding: 20px var(--page-px) 40px;
    max-width: 1180px;
    margin: 0 auto;
  }
  @media (min-width: 1280px) {
    .body { max-width: 1440px; }
  }

  .cat-pill {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin-bottom: 10px;
    border: 1px solid color-mix(in srgb, var(--cat-color, var(--accent)) 40%, transparent);
    background: color-mix(in srgb, var(--cat-color, var(--accent)) 14%, transparent);
    color: var(--cat-color, var(--accent));
  }
  h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.2; }
  .desc { color: var(--text-2); font-size: 15px; margin: 0 0 12px; }

  .byline {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 0 18px;
    color: var(--text-3);
    font-size: 13px;
  }
  .byline strong { color: var(--text-2); }
  .byline .dot { opacity: 0.6; }
  .byline a { color: var(--accent); text-decoration: none; }
  .byline a:hover { text-decoration: underline; }

  .meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding: 14px 0;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    margin-bottom: 20px;
  }
  .meta-stat {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-3);
  }
  .meta-stat strong { color: var(--text-1); font-weight: 700; }
  .meta-stat .material-symbols-rounded { font-size: 18px; color: var(--accent); }

  .layout {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  @media (min-width: 960px) {
    .layout {
      display: grid;
      grid-template-columns: minmax(280px, 0.85fr) 1.15fr;
      gap: 28px;
      align-items: flex-start;
    }
    .col-right { grid-column: 1 / -1; }
    .col-left { position: sticky; top: 16px; }
  }
  @media (min-width: 1280px) {
    .layout {
      grid-template-columns: minmax(280px, 0.8fr) minmax(0, 1.2fr) minmax(280px, 0.85fr);
      gap: 32px;
    }
    .col-right { grid-column: auto; position: sticky; top: 16px; align-self: start; }
  }
  .col { display: flex; flex-direction: column; min-width: 0; }
  h2 { font-size: 18px; font-weight: 700; margin: 0 0 12px; }
  .grp-name { font-size: 14px; font-weight: 700; margin: 12px 0 8px; color: var(--text-2); }

  .ing-list { list-style: none; padding: 0; margin: 0 0 16px; display: flex; flex-direction: column; gap: 6px; }
  .ing-list li { font-size: 14px; line-height: 1.4; color: var(--text-1); }
  .qty { font-weight: 700; margin-right: 4px; color: var(--accent); }
  .note { color: var(--text-3); font-style: italic; }

  .scale-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 0 12px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 12px;
  }
  .scale-label { font-size: 12px; color: var(--text-3); margin-right: 4px; }
  .scale-chip {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .scale-chip.active {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    color: var(--accent);
  }

  .steps { padding-left: 0; margin: 0; list-style: none; display: flex; flex-direction: column; gap: 14px; }
  .steps li { display: flex; gap: 12px; font-size: 14px; line-height: 1.55; color: var(--text-1); }
  .step-num {
    flex-shrink: 0;
    width: 28px; height: 28px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
    display: flex; align-items: center; justify-content: center;
    font-weight: 700;
    font-size: 13px;
  }

  .time-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    padding: 1px 8px 1px 4px;
    border-radius: 999px;
    font-size: inherit;
    font-weight: 600;
    cursor: pointer;
    margin: 0 1px;
  }
  .time-chip:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .time-chip .material-symbols-rounded { font-size: 14px; line-height: 1; }

  .notes { color: var(--text-2); font-size: 14px; line-height: 1.5; white-space: pre-wrap; }
  .empty { color: var(--text-3); font-size: 13px; font-style: italic; }

  .footer {
    border-top: 1px solid var(--border);
    padding: 16px 20px;
    text-align: center;
    color: var(--text-3);
    font-size: 12px;
  }
  .footer strong { color: var(--accent); }
</style>
