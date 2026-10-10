<!--
  HistorySheet: a recipe's versions (#54), newest first. The current one
  and every one you cooked are shown, each with what changed from the one
  before and how its cooks turned out; edits in between that were never
  cooked fold into "3 more edits" until opened. A version opens its page.

  Props: open (bindable), recipeId, history ({ revisions, unversioned }),
    conflicts (copies kept when two edits met; their own list opens with
    the `conflicts` event)
-->
<script>
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { push } from 'svelte-spa-router';
  import Sheet from '../ui/Sheet.svelte';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import { dateFormat } from '../../stores/settings.js';
  import { formatDate } from '../../lib/format.js';
  import { changeSummary } from '../../lib/recipe-content.js';
  import { changeLines, versionName } from '../../lib/version-text.js';
  import { currentUser } from '../../stores/auth.js';

  export let open = false;
  export let recipeId = null;
  export let history = null;
  export let conflicts = 0;

  const dispatch = createEventDispatcher();
  let unfolded = new Set();

  $: versions = history?.revisions || [];
  // Newest first, each with its changes from the one before it.
  $: rows = versions.map((v, i) => ({ ...v, changes: i > 0 ? changeSummary(versions[i - 1].data, v.data) : null })).reverse();
  // Shown: the current one and the cooked ones; runs of the rest fold.
  $: items = (() => {
    const out = [];
    let run = [];
    const flush = () => { if (run.length) { out.push({ fold: true, key: run[0].rev, list: run }); run = []; } };
    for (const v of rows) {
      if (v.current || v.cooks?.length) { flush(); out.push({ fold: false, key: v.rev, v }); }
      else run.push(v);
    }
    flush();
    return out;
  })();
  $: if (!open) unfolded = new Set();

  const when = at => {
    const raw = String(at || '');
    const d = new Date(raw.replace(' ', 'T') + (/[zZ]$|[+-]\d\d:?\d\d$/.test(raw) ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? '' : formatDate(d, $dateFormat);
  };
  const average = cooks => {
    const r = (cooks || []).map(c => Number(c.rating)).filter(n => n > 0);
    return r.length ? Math.round((r.reduce((a, b) => a + b, 0) / r.length) * 10) / 10 : null;
  };
  const photos = cooks => (cooks || []).flatMap(c => {
    let p = c.photos;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
    return Array.isArray(p) && p.length ? p : (c.photo_url ? [c.photo_url] : []);
  }).slice(0, 3);
  function openVersion(v) { open = false; push(`/recipes/${recipeId}/history/${v.rev}`); }
  function unfold(key) { unfolded = new Set([...unfolded, key]); }
</script>

<Sheet bind:open title={$_('history.title')}>
  <div class="history">
    <p class="intro">{$_('history.intro')}</p>
    {#if !versions.length}
      <p class="muted">{$_('history.empty')}</p>
    {/if}
    <ol class="list">
      {#each items as it (it.key)}
        {#if it.fold && !unfolded.has(it.key)}
          <li>
            <button type="button" class="fold" on:click={() => unfold(it.key)}>
              <span class="material-symbols-rounded" aria-hidden="true">unfold_more</span>
              {$_('history.more_edits', { values: { count: it.list.length } })}
            </button>
          </li>
        {:else}
          {#each it.fold ? it.list : [it.v] as v (v.rev)}
            {@const lines = v.changes ? changeLines($_, v.changes, 2) : null}
            {@const avg = average(v.cooks)}
            <li>
              <button type="button" class="version" class:folded={it.fold} on:click={() => openVersion(v)}>
                <span class="head">
                  <span class="name">{versionName($_, v)}</span>
                  {#if v.current}<span class="badge">{$_('history.current')}</span>{/if}
                  <span class="date">{when(v.created_at)}{#if v.created_by_name && v.created_by != null && v.created_by !== $currentUser?.id}{' · '}{v.created_by_name}{/if}</span>
                </span>
                {#if lines}
                  {#if lines.lines.length}
                    <span class="changes">{lines.lines.join(' · ')}{#if lines.more}{' · '}{$_('history.and_more', { values: { count: lines.more } })}{/if}</span>
                  {:else}
                    <span class="changes muted">{$_('history.no_changes')}</span>
                  {/if}
                {:else}
                  <span class="changes muted">{$_('history.first_kept')}</span>
                {/if}
                <span class="cooks">
                  {#if v.cooks?.length}
                    <span class="material-symbols-rounded" aria-hidden="true">restaurant</span>
                    {$_('history.cooked_n', { values: { count: v.cooks.length } })}
                    {#if avg}<span class="avg"><span class="material-symbols-rounded star" aria-hidden="true">star</span>{avg}</span>{/if}
                    {#each photos(v.cooks) as p}<img src={resolveAssetUrl(p)} alt="" loading="lazy" />{/each}
                  {:else}
                    <span class="muted">{$_('history.not_cooked')}</span>
                  {/if}
                </span>
              </button>
            </li>
          {/each}
        {/if}
      {/each}
    </ol>
    {#if history?.unversioned?.length}
      <p class="muted before">
        <span class="material-symbols-rounded" aria-hidden="true">schedule</span>
        {$_('history.before_history', { values: { count: history.unversioned.length } })}
      </p>
    {/if}
    {#if conflicts}
      <button type="button" class="btn btn-secondary conflicts" on:click={() => dispatch('conflicts')}>
        <span class="material-symbols-rounded" aria-hidden="true">call_split</span>
        {$_('history.conflicts', { values: { count: conflicts } })}
      </button>
    {/if}
  </div>
</Sheet>

<style>
  .history { display: flex; flex-direction: column; gap: 12px; padding-bottom: 8px; }
  .intro { margin: 0; font-size: 13px; line-height: 1.45; color: var(--text-2); }
  .muted { color: var(--text-2); font-size: 13px; margin: 0; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .version {
    width: 100%; display: flex; flex-direction: column; gap: 6px; padding: 12px; text-align: left;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg);
    color: var(--text-1); font: inherit; cursor: pointer;
  }
  .version:hover { background: var(--surface-2); }
  .version.folded { background: transparent; border-style: dashed; }
  .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .name { font-size: 15px; font-weight: 700; }
  .badge { padding: 2px 8px; border-radius: var(--radius-full); background: var(--accent-dim); color: var(--accent); font-size: 11px; font-weight: 700; }
  .date { margin-left: auto; font-size: 12px; color: var(--text-2); }
  .changes { font-size: 13px; line-height: 1.4; color: var(--text-1); }
  .cooks { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; color: var(--text-2); }
  .cooks .material-symbols-rounded { font-size: 16px; }
  .avg { display: inline-flex; align-items: center; gap: 2px; font-weight: 600; color: var(--text-1); }
  .star { color: var(--warning); font-variation-settings: 'FILL' 1; }
  .cooks img { width: 28px; height: 28px; border-radius: var(--radius-sm); object-fit: cover; }
  .fold {
    width: 100%; min-height: 44px; display: flex; align-items: center; justify-content: center; gap: 6px;
    background: transparent; border: 1.5px dashed var(--border-strong); border-radius: var(--radius-lg);
    color: var(--text-2); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .before { display: flex; align-items: center; gap: 6px; }
  .before .material-symbols-rounded { font-size: 16px; }
  .conflicts { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
</style>
