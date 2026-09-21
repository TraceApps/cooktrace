<script>
  /**
   * What you have on the go, from anywhere in the app.
   *
   * Cook mode survives closing the app and more than one recipe can be in it,
   * which is the normal way to cook a meal: something in the oven while the
   * next thing is started. Without this there is nowhere to see that, so a
   * dish you never formally finished sits there for days and the only way
   * back to it is remembering which recipe it was.
   *
   * Sits low and to the left so it clears the assistant button, and shows at
   * most two dishes before it counts the rest, because this is a reminder,
   * not a list to manage.
   */
  import { onDestroy } from 'svelte';
  import { push, location } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { activeCooks, cookList } from '../../stores/cooks.js';
  import { resolveAssetUrl } from '../../lib/platform.js';

  const SHOWN = 2;

  $: cooks = cookList($activeCooks);
  // Not the one you are already looking at.
  $: showing = cooks.filter(c => $location !== `/recipes/${c.localId}`);
  $: visible = showing.slice(0, SHOWN);
  $: extra = showing.length - visible.length;

  // How long each has been going. A minute's resolution is plenty, and the
  // tick stops when the page is hidden so it costs nothing in a pocket.
  let now = Date.now();
  let ticker = null;
  function start() {
    if (ticker == null) ticker = setInterval(() => { now = Date.now(); }, 30000);
  }
  function stop() {
    if (ticker != null) { clearInterval(ticker); ticker = null; }
  }
  function onVisibility() {
    if (typeof document === 'undefined') return;
    if (document.hidden) stop(); else { now = Date.now(); start(); }
  }
  if (typeof document !== 'undefined') {
    start();
    document.addEventListener('visibilitychange', onVisibility);
    onDestroy(() => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    });
  }

  function since(at) {
    const mins = Math.max(0, Math.floor((now - (at || now)) / 60000));
    if (mins < 1) return $_('cooking_now.just_started');
    if (mins < 60) return $_('cooking_now.minutes', { values: { n: mins } });
    const hours = Math.floor(mins / 60);
    return $_('cooking_now.hours', { values: { n: hours, m: mins % 60 } });
  }
</script>

{#if visible.length}
  <div class="cooking-now" aria-label={$_('cooking_now.label')}>
    {#each visible as cook (cook.localId)}
      <button class="cook-row" on:click={() => push(`/recipes/${cook.localId}`)}>
        <span class="cook-thumb">
          {#if cook.img}
            <img src={resolveAssetUrl(cook.img)} alt="" loading="lazy" />
          {:else}
            <span class="material-symbols-rounded">skillet</span>
          {/if}
          <span class="cook-dot" aria-hidden="true"></span>
        </span>
        <span class="cook-text">
          <span class="cook-name">{cook.name || $_('cooking_now.untitled')}</span>
          <span class="cook-meta">{$_('cooking_now.label')} · {since(cook.at)}</span>
        </span>
        <span class="material-symbols-rounded cook-go">chevron_right</span>
      </button>
    {/each}
    {#if extra > 0}
      <button class="cook-more" on:click={() => push('/recipes')}>
        {$_('cooking_now.more', { values: { n: extra } })}
      </button>
    {/if}
  </div>
{/if}

<style>
  .cooking-now {
    position: fixed;
    z-index: 60;
    left: 12px;
    /* Clear of the assistant button, which owns the bottom right. */
    right: 84px;
    bottom: calc(var(--nav-h, 0px) + var(--safe-bottom, 0px) + 14px);
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 520px;
    pointer-events: none;
  }
  .cook-row,
  .cook-more {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 14px);
    background: var(--surface-1);
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.22);
    color: var(--text-1);
    text-align: left;
    cursor: pointer;
    transition: transform var(--dur-fast, 0.12s), border-color var(--dur-fast, 0.12s);
  }
  .cook-row:hover { border-color: var(--accent); }
  .cook-row:active { transform: scale(0.985); }

  .cook-thumb {
    position: relative;
    flex: 0 0 auto;
    width: 38px;
    height: 38px;
    border-radius: 10px;
    overflow: hidden;
    display: grid;
    place-items: center;
    background: var(--surface-2);
    color: var(--text-2);
  }
  .cook-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .cook-thumb .material-symbols-rounded { font-size: 20px; }

  /* A cook is live, and this is the only moving thing on the bar. */
  .cook-dot {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
    border: 2px solid var(--surface-1);
    animation: cook-pulse 2s ease-in-out infinite;
  }
  @keyframes cook-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.4; }
  }
  @media (prefers-reduced-motion: reduce) {
    .cook-dot { animation: none; }
  }

  .cook-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .cook-name {
    font-size: 14px;
    font-weight: 700;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cook-meta {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cook-go { flex: 0 0 auto; color: var(--text-2); font-size: 20px; }

  .cook-more {
    justify-content: center;
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 700;
    color: var(--text-2);
  }
</style>
