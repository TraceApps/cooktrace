<!--
  RecipeVersion: one version of a recipe (#54), at #/recipes/:id/history/:rev.
  What it had you cook (ingredients, steps, servings and times), how it
  differs from the version before and from the recipe now (Compare), the
  cooks made from it and how they turned out, and what can be done with it:
  log another cook of it, put it back, or delete it if it was never cooked.

  Opened from a cook (?cook=<id>): "You made this on ..." comes first.
-->
<script>
  import { _, locale } from 'svelte-i18n';
  import { pop, push, querystring } from 'svelte-spa-router';
  import { fade } from 'svelte/transition';
  import { NtApi } from '../lib/api.js';
  import { isNative, getServerUrl, resolveAssetUrl } from '../lib/platform.js';
  import { currentUser } from '../stores/auth.js';
  import { dateFormat } from '../stores/settings.js';
  import { formatDate } from '../lib/format.js';
  import { fromIso } from '../lib/week.js';
  import { displayQty } from '../lib/quantity.js';
  import { changeSummary } from '../lib/recipe-content.js';
  import { changeLines, detailRows } from '../lib/version-text.js';
  import { showError, showSuccess } from '../stores/toast.js';
  import { confirmDialog } from '../stores/confirmDialog.js';
  import VersionCompare from '../components/recipe/VersionCompare.svelte';
  import CookLogDialog from '../components/recipe/CookLogDialog.svelte';
  import StarRating from '../components/ui/StarRating.svelte';

  export let params = {};

  $: id = parseInt(params.id, 10);
  $: rev = String(params.rev || '');
  $: cookId = Number(new URLSearchParams($querystring || '').get('cook')) || null;

  let recipe = null;
  let history = null;
  let loading = true;
  let loadError = null;
  let busy = false;
  let compareWith = null; // 'current' | 'previous' | null
  let logOpen = false;

  async function load() {
    loading = true; loadError = null;
    try {
      [recipe, history] = await Promise.all([NtApi.getRecipe(id), NtApi.getRecipeRevisions(id)]);
    } catch (e) {
      loadError = e.message || $_('history.load_failed');
    } finally {
      loading = false;
    }
  }
  $: if (Number.isFinite(id) && rev) load();

  $: versions = history?.revisions || [];
  $: v = versions.find(x => x.rev === rev) || null;
  $: idx = v ? versions.indexOf(v) : -1;
  $: prev = idx > 0 ? versions[idx - 1] : null;
  $: current = versions.find(x => x.current) || null;
  $: total = versions.length ? versions[versions.length - 1].number : 0;
  $: cook = cookId && v ? (v.cooks || []).find(c => Number(c.id) === cookId) || null : null;
  $: sinceNow = v && current && !v.current ? changeSummary(v.data, current.data) : [];
  $: fromPrev = v && prev ? changeSummary(prev.data, v.data) : [];
  $: since = changeLines($_, sinceNow, 4);
  $: changed = changeLines($_, fromPrev, 4);
  $: details = v ? detailRows($_, v.data) : [];

  // Whoever may edit the recipe may put a version back or delete one.
  $: canEdit = !!recipe && (recipe.can_edit === true || recipe.user_id == null
    || recipe.user_id === $currentUser?.id || $currentUser?.role === 'admin'
    || (isNative && !getServerUrl()));

  // A cook's date is a calendar day: read it as one here, not as UTC midnight.
  const day = d => (d ? formatDate(fromIso(String(d).slice(0, 10)), $dateFormat) : '');
  function madeAt(at) {
    const raw = String(at || '');
    const d = new Date(raw.replace(' ', 'T') + (/[zZ]$|[+-]\d\d:?\d\d$/.test(raw) ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? '' : formatDate(d, $dateFormat);
  }
  const amount = it => [displayQty(it.qty, it.unit), it.unit].filter(Boolean).join(' ');
  const photosOf = c => {
    let p = c.photos;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
    return Array.isArray(p) && p.length ? p : (c.photo_url ? [c.photo_url] : []);
  };

  async function restore() {
    const ok = await confirmDialog({
      title: $_('history.restore_confirm_title', { values: { n: v.number } }),
      message: $_('history.restore_confirm'),
      confirmText: $_('history.restore'),
    });
    if (!ok) return;
    busy = true;
    try {
      await NtApi.restoreRecipeRevision(id, v.rev);
      showSuccess($_('history.restored', { values: { n: v.number } }));
      await load();
    } catch (e) { showError(e.message || $_('history.restore_failed')); }
    finally { busy = false; }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: $_('history.delete_confirm_title', { values: { n: v.number } }),
      message: $_('history.delete_confirm'),
      confirmText: $_('history.delete'),
      dangerous: true,
    });
    if (!ok) return;
    busy = true;
    try {
      await NtApi.deleteRecipeRevision(id, v.rev);
      showSuccess($_('history.deleted', { values: { n: v.number } }));
      push(`/recipes/${id}`);
    } catch (e) {
      showError(e.code === 'used' ? $_('history.used_stays') : e.code === 'current' ? $_('history.current_stays') : (e.message || $_('history.delete_failed')));
    } finally { busy = false; }
  }

  async function logCook(e) {
    busy = true;
    try {
      await NtApi.markCooked(id, { ...e.detail, recipe_rev: v.rev });
      showSuccess($_('history.cook_logged', { values: { n: v.number } }));
      await load();
    } catch (err) { showError(err.message || $_('history.cook_failed')); }
    finally { busy = false; }
  }
</script>

<div class="page-shell editor-page">
  <header class="editor-header">
    <button class="btn-icon" on:click={pop} aria-label={$_('history.back')} title={$_('history.back')}>
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    <div class="title-wrap">
      <h2 class="editor-title">{v ? $_('history.version', { values: { n: v.number } }) : $_('history.title')}</h2>
      {#if recipe}<span class="subtitle">{recipe.name}</span>{/if}
    </div>
  </header>

  <div class="page-content view-content">
    {#if loading}
      <div class="state" in:fade={{ duration: 120 }}><span class="material-symbols-rounded spin">progress_activity</span></div>
    {:else if loadError || !v}
      <div class="state error">
        <span class="material-symbols-rounded">error</span>
        <p>{loadError || $_('history.version_gone')}</p>
        <button class="btn btn-secondary" on:click={() => push(`/recipes/${id}`)}>{$_('history.open_current')}</button>
      </div>
    {:else}
      {#if cook}
        <section class="made" aria-label={$_('history.as_made')}>
          <span class="material-symbols-rounded made-icon" aria-hidden="true">skillet</span>
          <div class="made-text">
            <p class="made-title">{$_('history.made_on', { values: { date: day(cook.date) } })}</p>
            {#if cook.rating}<StarRating value={cook.rating} readOnly size={16} />{/if}
            {#if cook.notes}<p class="made-notes">{cook.notes}</p>{/if}
          </div>
        </section>
      {/if}

      <section class="card status">
        <div class="status-head">
          <span class="badge" class:current={v.current}>
            {v.current ? $_('history.current') : $_('history.version_of', { values: { n: v.number, total } })}
          </span>
          <span class="meta">{$_('history.saved_on', { values: { date: madeAt(v.created_at) } })}{#if v.created_by_name && v.created_by != null && v.created_by !== $currentUser?.id}{' · '}{$_('history.by', { values: { name: v.created_by_name } })}{/if}</span>
        </div>
        {#if !v.current}
          <div class="change-block">
            <p class="change-title">{$_('history.since_then')}</p>
            {#if since.lines.length}
              <ul class="changes">{#each since.lines as l}<li>{l}</li>{/each}</ul>
              {#if since.more}<p class="more">{$_('history.and_more', { values: { count: since.more } })}</p>{/if}
            {:else}<p class="more">{$_('history.no_changes')}</p>{/if}
          </div>
        {/if}
        {#if prev}
          <div class="change-block">
            <p class="change-title">{$_('history.changed_from', { values: { n: prev.number } })}</p>
            {#if changed.lines.length}
              <ul class="changes">{#each changed.lines as l}<li>{l}</li>{/each}</ul>
              {#if changed.more}<p class="more">{$_('history.and_more', { values: { count: changed.more } })}</p>{/if}
            {:else}<p class="more">{$_('history.no_changes')}</p>{/if}
          </div>
        {:else}
          <p class="more">{$_('history.first_kept')}</p>
        {/if}
        {#if (!v.current && current) || prev}
          <div class="compare-pick" role="group" aria-label={$_('history.compare')}>
            <span class="compare-label">{$_('history.compare_with')}</span>
            {#if !v.current && current}
              <button type="button" class="chip" class:on={compareWith === 'current'} aria-pressed={compareWith === 'current'}
                on:click={() => (compareWith = compareWith === 'current' ? null : 'current')}>{$_('history.the_current')}</button>
            {/if}
            {#if prev}
              <button type="button" class="chip" class:on={compareWith === 'previous'} aria-pressed={compareWith === 'previous'}
                on:click={() => (compareWith = compareWith === 'previous' ? null : 'previous')}>{$_('history.version', { values: { n: prev.number } })}</button>
            {/if}
          </div>
        {/if}
        {#if compareWith === 'current' && current}
          <VersionCompare from={v.data} to={current.data}
            fromLabel={$_('history.version', { values: { n: v.number } })} toLabel={$_('history.the_current')} />
        {:else if compareWith === 'previous' && prev}
          <VersionCompare from={prev.data} to={v.data}
            fromLabel={$_('history.version', { values: { n: prev.number } })} toLabel={$_('history.version', { values: { n: v.number } })} />
        {/if}
      </section>

      <div class="columns">
        <section class="card">
          <h3 class="card-title">{$_('history.ingredients')}</h3>
          {#if details.length}
            <dl class="details">
              {#each details as d (d.field)}<div><dt>{d.label}</dt><dd>{d.value}</dd></div>{/each}
            </dl>
          {/if}
          {#each v.data.ingredients as g, gi (gi)}
            {#if g.name}<p class="group">{g.name}</p>{/if}
            <ul class="ings">
              {#each g.items as it, ii (ii)}
                <li><span class="amt">{amount(it)}</span><span class="ing-name">{it.name}{#if it.note}<span class="note">, {it.note}</span>{/if}</span></li>
              {/each}
            </ul>
          {:else}
            <p class="more">{$_('history.no_ingredients')}</p>
          {/each}
        </section>

        <section class="card">
          <h3 class="card-title">{$_('history.steps')}</h3>
          {#if v.data.steps.length}
            <ol class="steps">
              {#each v.data.steps as st, si (si)}
                <li><span class="num" aria-hidden="true">{si + 1}</span><span class="step-text">{#if st.title}<strong>{st.title}</strong> {/if}{st.text}</span></li>
              {/each}
            </ol>
          {:else}<p class="more">{$_('history.no_steps')}</p>{/if}
        </section>
      </div>

      <section class="card">
        <h3 class="card-title">{$_('history.cooks_title')}</h3>
        {#each v.cooks || [] as c (c.id)}
          <div class="cook" class:this={cook && Number(c.id) === Number(cook.id)}>
            <div class="cook-head">
              <span class="cook-date">{day(c.date)}</span>
              {#if c.rating}<StarRating value={c.rating} readOnly size={14} />{/if}
            </div>
            {#if c.notes}<p class="cook-notes">{c.notes}</p>{/if}
            {#if photosOf(c).length}
              <div class="cook-photos">{#each photosOf(c) as p}<img src={resolveAssetUrl(p)} alt="" loading="lazy" />{/each}</div>
            {/if}
          </div>
        {:else}
          <p class="more">{$_('history.not_cooked')}</p>
        {/each}
      </section>

      <div class="actions">
        <button class="btn btn-primary" on:click={() => (logOpen = true)} disabled={busy}>
          <span class="material-symbols-rounded" aria-hidden="true">restaurant</span>{$_('history.cooked_this')}
        </button>
        {#if canEdit && !v.current}
          <button class="btn btn-secondary" on:click={restore} disabled={busy}>
            <span class="material-symbols-rounded" aria-hidden="true">restore</span>{$_('history.restore')}
          </button>
        {/if}
        {#if canEdit && !v.current && !v.used}
          <button class="btn btn-secondary danger" on:click={remove} disabled={busy}>
            <span class="material-symbols-rounded" aria-hidden="true">delete</span>{$_('history.delete')}
          </button>
        {/if}
        <button class="btn btn-ghost" on:click={() => push(`/recipes/${id}`)}>
          <span class="material-symbols-rounded" aria-hidden="true">menu_book</span>{$_('history.open_current')}
        </button>
      </div>
    {/if}
  </div>
</div>

<CookLogDialog bind:open={logOpen} recipeName={recipe ? `${recipe.name} · ${$_('history.version', { values: { n: v?.number || 1 } })}` : ''} on:save={logCook} />

<style>
  .editor-header {
    display: flex; align-items: center; gap: 8px;
    padding: calc(var(--safe-top) + 12px) 16px 12px;
    border-bottom: 1px solid var(--border); background: var(--surface-1);
    position: sticky; top: 0; z-index: 10;
  }
  .title-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .editor-title { font-size: 17px; font-weight: 700; margin: 0; color: var(--text-1); }
  .subtitle { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn-icon {
    background: transparent; border: none; cursor: pointer; color: var(--text-3); width: 40px; height: 40px;
    display: flex; align-items: center; justify-content: center; border-radius: var(--radius-sm);
  }
  .btn-icon:hover { background: var(--surface-2); color: var(--text-1); }
  .view-content {
    display: flex; flex-direction: column; gap: 12px; padding: 16px var(--page-px) 32px;
    width: 100%; box-sizing: border-box; max-width: 960px; margin: 0 auto;
  }
  .state { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 48px 16px; color: var(--text-2); text-align: center; }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .card {
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg);
    padding: 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0;
  }
  .card-title { margin: 0; font-size: 15px; font-weight: 700; color: var(--text-1); }
  .made {
    display: flex; gap: 12px; padding: 14px 16px; border-radius: var(--radius-lg);
    background: var(--accent-dim); color: var(--text-1);
  }
  .made-icon { color: var(--accent); font-size: 24px; }
  .made-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .made-title { margin: 0; font-size: 15px; font-weight: 700; }
  .made-notes { margin: 0; font-size: 13px; color: var(--text-2); }
  .status-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .badge {
    padding: 3px 10px; border-radius: var(--radius-full); background: var(--surface-2);
    font-size: 12px; font-weight: 700; color: var(--text-2);
  }
  .badge.current { background: var(--accent-dim); color: var(--accent); }
  .meta { font-size: 12px; color: var(--text-2); }
  .change-block { display: flex; flex-direction: column; gap: 4px; }
  .change-title { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); }
  .changes { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; font-size: 14px; color: var(--text-1); }
  .more { margin: 0; font-size: 13px; color: var(--text-2); }
  .compare-pick { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .compare-label { font-size: 13px; font-weight: 600; color: var(--text-2); margin-right: 2px; }
  .chip {
    min-height: 36px; padding: 0 12px; border-radius: var(--radius-full); border: 1px solid var(--border-strong);
    background: transparent; color: var(--text-2); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .chip.on { background: var(--accent-dim); border-color: transparent; color: var(--accent); }
  .columns { display: flex; flex-direction: column; gap: 12px; }
  .details { margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
  .details div { padding: 8px 10px; border-radius: var(--radius-md); background: var(--surface-2); }
  .details dt { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); }
  .details dd { margin: 2px 0 0; font-size: 15px; font-weight: 700; color: var(--text-1); }
  .group { margin: 6px 0 0; font-size: 12px; font-weight: 700; color: var(--text-2); }
  .ings { list-style: none; margin: 0; padding: 0; }
  .ings li { display: flex; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: 14px; color: var(--text-1); }
  .amt { min-width: 72px; font-weight: 700; color: var(--accent); }
  .ing-name { flex: 1; min-width: 0; }
  .note { color: var(--text-2); }
  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .steps li { display: flex; gap: 10px; font-size: 14px; line-height: 1.5; color: var(--text-1); }
  .num {
    flex: none; width: 24px; height: 24px; border-radius: var(--radius-full); background: var(--surface-2);
    display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: var(--text-2);
  }
  .step-text { flex: 1; min-width: 0; white-space: pre-line; }
  .cook { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; border-bottom: 1px solid var(--border); }
  .cook.this { background: color-mix(in srgb, var(--accent) 6%, transparent); border-radius: var(--radius-md); padding: 8px; }
  .cook-head { display: flex; align-items: center; gap: 10px; }
  .cook-date { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .cook-notes { margin: 0; font-size: 13px; color: var(--text-2); }
  .cook-photos { display: flex; gap: 6px; flex-wrap: wrap; }
  .cook-photos img { width: 64px; height: 64px; border-radius: var(--radius-md); object-fit: cover; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .actions .btn { min-height: 48px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .danger { color: var(--danger); }

  /* Room for two (a tablet, an unfolded foldable): ingredients beside steps. */
  :global(html.wide-content) .columns { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); align-items: start; }
</style>
