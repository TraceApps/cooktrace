<script>
  /**
   * What you have on the go, from anywhere in the app.
   *
   * Cook mode survives closing the app and more than one recipe can be in it,
   * which is the normal way to cook a meal. Without this there was nowhere to
   * see that, so a dish you never formally finished sat there for days and
   * the only way to reach it was to remember which recipe it was.
   */
  import { push, location } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { activeCooks, cookList } from '../../stores/cooks.js';

  $: cooks = cookList($activeCooks);
  // Not the one you are already looking at.
  $: showing = cooks.filter(c => $location !== `/recipe/${c.localId}`);
</script>

{#if showing.length}
  <div class="cooking-now" role="navigation" aria-label={$_('cooking_now.label')}>
    <span class="cooking-now-label">
      {showing.length > 1 ? $_('cooking_now.label_many', { values: { n: showing.length } }) : $_('cooking_now.label')}
    </span>
    <div class="cooking-now-chips">
      {#each showing as cook (cook.localId)}
        <button class="cooking-now-chip" on:click={() => push(`/recipe/${cook.localId}`)}>
          <span class="cooking-now-dot"></span>
          <span class="cooking-now-name">{cook.name || $_('cooking_now.untitled')}</span>
        </button>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* Fixed, above the nav bar, because this has to be visible from wherever
     you happen to be: the whole point is telling you something is cooking
     when you are not on its page. In the normal flow it sat at the bottom of
     the document where nobody would ever scroll to find it. Below the Trace
     button (80) and the timer pill so it cannot cover either. */
  .cooking-now {
    position: fixed;
    z-index: 60;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(var(--nav-h, 0px) + var(--safe-bottom, 0px) + 12px);
    max-width: min(92vw, 560px);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: var(--radius-full);
    background: var(--surface-2);
    border: 1px solid var(--border);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .cooking-now::-webkit-scrollbar { display: none; }
  .cooking-now-label {
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-2);
  }
  .cooking-now-chips { display: flex; gap: 6px; }
  .cooking-now-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    max-width: 220px;
    padding: 4px 10px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text-1);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .cooking-now-chip:hover { border-color: var(--accent); }
  .cooking-now-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A cook is live: the same pulse the timer rail uses. */
  .cooking-now-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: cooking-pulse 2s ease-in-out infinite;
  }
  @keyframes cooking-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.35; }
  }
  @media (prefers-reduced-motion: reduce) {
    .cooking-now-dot { animation: none; }
  }
</style>
