<!--
  VersionCompare: two versions of a recipe side by side, as what changed
  from one to the other: ingredients lined up (a changed amount shows both),
  steps with the words that changed, and servings, yield and times.
  Unchanged lines are hidden until Show Everything.

  Props: from, to (recipe-content.js cookContent), fromLabel, toLabel
-->
<script>
  import { _ } from 'svelte-i18n';
  import { compareContent, diffWords, lineText } from '../../lib/recipe-content.js';
  import { formatDuration } from '../../lib/duration.js';
  import { detailLabel } from '../../lib/version-text.js';

  export let from = null;
  export let to = null;
  export let fromLabel = '';
  export let toLabel = '';

  let everything = false;

  $: diff = from && to ? compareContent(from, to) : null;
  $: ings = diff ? diff.ingredients.filter(x => everything || x.kind !== 'same') : [];
  $: steps = diff ? diff.steps.filter(x => everything || x.kind !== 'same') : [];
  $: sameIngs = diff ? diff.ingredients.filter(x => x.kind === 'same').length : 0;
  $: sameSteps = diff ? diff.steps.filter(x => x.kind === 'same').length : 0;
  $: nothing = diff && !diff.details.length && diff.ingredients.every(x => x.kind === 'same') && diff.steps.every(x => x.kind === 'same');
  const stepText = st => [st.title, st.text].filter(Boolean).join(': ');
  const val = (field, v) => (v == null || v === '' ? $_('history.none') : field.endsWith('_minutes') ? (formatDuration(v) || String(v)) : String(v));
</script>

{#if diff}
  <div class="compare">
    <p class="legend">
      <span class="from-label"><span class="material-symbols-rounded" aria-hidden="true">remove</span>{fromLabel}</span>
      <span class="to-label"><span class="material-symbols-rounded" aria-hidden="true">add</span>{toLabel}</span>
    </p>

    {#if nothing}
      <p class="muted">{$_('history.no_changes')}</p>
    {:else}
      {#if diff.details.length}
        <section class="block">
          <h4>{$_('history.details')}</h4>
          <ul class="rows">
            {#each diff.details as d (d.field)}
              <li class="row changed">
                <span class="mark material-symbols-rounded" aria-hidden="true">edit</span>
                <span class="text">{detailLabel($_, d.field)}: <del>{val(d.field, d.from)}</del> <ins>{val(d.field, d.to)}</ins></span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <section class="block">
        <h4>{$_('history.ingredients')}</h4>
        {#if ings.length}
          <ul class="rows">
            {#each ings as x, i (i)}
              <li class="row {x.kind}">
                <span class="mark material-symbols-rounded" aria-hidden="true">{x.kind === 'added' ? 'add' : x.kind === 'removed' ? 'remove' : x.kind === 'changed' ? 'edit' : 'check'}</span>
                {#if x.kind === 'changed'}
                  <span class="text"><del>{lineText(x.from)}</del> <ins>{lineText(x.to)}</ins></span>
                {:else if x.kind === 'removed'}
                  <span class="text"><del>{lineText(x.from)}</del><span class="sr">{$_('history.sr_removed')}</span></span>
                {:else if x.kind === 'added'}
                  <span class="text"><ins>{lineText(x.to)}</ins><span class="sr">{$_('history.sr_added')}</span></span>
                {:else}
                  <span class="text">{lineText(x.to)}</span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        {#if !everything && sameIngs}<p class="muted">{$_('history.unchanged_ingredients', { values: { count: sameIngs } })}</p>{/if}
      </section>

      <section class="block">
        <h4>{$_('history.steps')}</h4>
        {#if steps.length}
          <ol class="rows">
            {#each steps as x, i (i)}
              <li class="row {x.kind}">
                <span class="num" aria-hidden="true">{x.to?.n ?? x.from?.n}</span>
                {#if x.kind === 'changed'}
                  <span class="text">
                    {#each diffWords(stepText(x.from), stepText(x.to)) as w}{#if w.kind === 'added'}<ins>{w.text}</ins>{:else if w.kind === 'removed'}<del>{w.text}</del>{:else}{w.text}{/if}{/each}
                  </span>
                {:else if x.kind === 'removed'}
                  <span class="text"><del>{stepText(x.from)}</del><span class="sr">{$_('history.sr_removed')}</span></span>
                {:else if x.kind === 'added'}
                  <span class="text"><ins>{stepText(x.to)}</ins><span class="sr">{$_('history.sr_added')}</span></span>
                {:else}
                  <span class="text">{stepText(x.to)}</span>
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
        {#if !everything && sameSteps}<p class="muted">{$_('history.unchanged_steps', { values: { count: sameSteps } })}</p>{/if}
      </section>

      {#if sameIngs || sameSteps}
        <button type="button" class="btn btn-ghost toggle" on:click={() => (everything = !everything)} aria-pressed={everything}>
          <span class="material-symbols-rounded" aria-hidden="true">{everything ? 'unfold_less' : 'unfold_more'}</span>
          {everything ? $_('history.show_changes') : $_('history.show_everything')}
        </button>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .compare { display: flex; flex-direction: column; gap: 14px; }
  .legend { margin: 0; display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; font-weight: 600; }
  .legend span { display: inline-flex; align-items: center; gap: 4px; }
  .legend .material-symbols-rounded { font-size: 16px; }
  .from-label { color: var(--danger); }
  .to-label { color: var(--accent); }
  .block { display: flex; flex-direction: column; gap: 6px; }
  h4 { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); }
  .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .row {
    display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border);
    font-size: 14px; line-height: 1.45; color: var(--text-1);
  }
  .row.same { color: var(--text-2); }
  .mark { font-size: 18px; flex: none; margin-top: 1px; color: var(--text-3); }
  .row.added .mark { color: var(--accent); }
  .row.removed .mark { color: var(--danger); }
  .row.changed .mark { color: var(--warning); }
  .num {
    flex: none; width: 22px; height: 22px; border-radius: var(--radius-full); background: var(--surface-2);
    display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: var(--text-2);
  }
  .text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  del { color: var(--danger); text-decoration: line-through; text-decoration-thickness: 1px; background: color-mix(in srgb, var(--danger) 10%, transparent); border-radius: 3px; }
  ins { color: var(--accent); text-decoration: none; font-weight: 600; background: color-mix(in srgb, var(--accent) 12%, transparent); border-radius: 3px; }
  .muted { margin: 0; font-size: 12px; color: var(--text-2); }
  .toggle { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; min-height: 40px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
