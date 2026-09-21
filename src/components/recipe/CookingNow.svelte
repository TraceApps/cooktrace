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
   * One line, never a stack. This is a status, like the now-playing bar in a
   * music app, and it has to sit on top of whatever you are reading without
   * burying it. With one dish it goes straight there; with several it names
   * the oldest and opens a picker, so every tap does something.
   */
  import { onDestroy } from 'svelte';
  import { push, location } from 'svelte-spa-router';
  import { _ } from 'svelte-i18n';
  import { activeCooks, cookList } from '../../stores/cooks.js';
  import ActionSheet from '../ui/ActionSheet.svelte';

  $: cooks = cookList($activeCooks);
  // Not the one you are already looking at.
  $: showing = cooks.filter(c => $location !== `/recipes/${c.localId}`);
  $: first = showing[0];

  let pickerOpen = false;
  $: pickerActions = showing.map(c => ({
    label: c.name || $_('cooking_now.untitled'),
    icon: 'skillet',
    value: c.localId,
  }));

  // How long each has been going. A minute's resolution is plenty, and the
  // tick stops when the page is hidden so it costs nothing in a pocket.
  let now = Date.now();
  let ticker = null;
  const start = () => { if (ticker == null) ticker = setInterval(() => { now = Date.now(); }, 30000); };
  const stop  = () => { if (ticker != null) { clearInterval(ticker); ticker = null; } };
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
    return $_('cooking_now.hours', { values: { n: Math.floor(mins / 60), m: mins % 60 } });
  }

  function open() {
    if (showing.length === 1) push(`/recipes/${first.localId}`);
    else pickerOpen = true;
  }
</script>

{#if first}
  <button class="cooking-now" on:click={open}
    aria-label={$_('cooking_now.label')}>
    <span class="cn-icon material-symbols-rounded">skillet</span>
    <span class="cn-text">
      {#if showing.length > 1}
        <b>{$_('cooking_now.label_many', { values: { n: showing.length } })}</b>
        <span class="cn-sub">{first.name || $_('cooking_now.untitled')}</span>
      {:else}
        <b>{first.name || $_('cooking_now.untitled')}</b>
        <span class="cn-sub">{$_('cooking_now.label')} · {since(first.at)}</span>
      {/if}
    </span>
    <span class="cn-go material-symbols-rounded">
      {showing.length > 1 ? 'expand_less' : 'chevron_right'}
    </span>
  </button>

  <ActionSheet
    bind:open={pickerOpen}
    title={$_('cooking_now.label_many', { values: { n: showing.length } })}
    actions={pickerActions}
    on:select={e => push(`/recipes/${e.detail.value}`)}
  />
{/if}

<style>
  /* One slim bar, low and to the left so it clears the assistant button and
     leaves the page readable behind it. Frosted rather than solid: the same
     treatment as the bottom nav, so the bar reads as chrome floating over the
     page instead of a card dropped on top of it, and you can still see what
     is underneath. Solid surface where the blur is unsupported. */
  .cooking-now {
    position: fixed;
    z-index: 60;
    left: 12px;
    right: 84px;
    bottom: calc(var(--nav-h, 0px) + var(--safe-bottom, 0px) + 12px);
    max-width: 380px;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--surface-1);
    box-shadow: var(--shadow-md);
    color: var(--text-1);
    text-align: left;
    cursor: pointer;
    transition: transform var(--dur-fast, 0.12s), border-color var(--dur-fast, 0.12s);
  }
  @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .cooking-now {
      /* --glass-surface sits at 0.88 for a full-width bar; a small pill can
         afford to be lighter, so thin it out and let the blur do the work. */
      background: color-mix(in srgb, var(--glass-surface) 76%, transparent);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      border-color: color-mix(in srgb, var(--border) 80%, transparent);
    }
  }
  .cooking-now:hover { border-color: var(--accent); }
  .cooking-now:active { transform: scale(0.985); }

  /* The only moving thing on the bar: a cook is live. */
  .cn-icon {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
    font-size: 17px;
    animation: cn-pulse 2.4s ease-in-out infinite;
  }
  @keyframes cn-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.55; }
  }
  @media (prefers-reduced-motion: reduce) {
    .cn-icon { animation: none; }
  }

  .cn-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; line-height: 1.15; }
  .cn-text b {
    font-size: 13px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cn-sub {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cn-go { flex: 0 0 auto; color: var(--text-2); font-size: 18px; }
</style>
