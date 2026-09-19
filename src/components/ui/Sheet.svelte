<script>
  import { closeOnBack } from '../../lib/back-stack.js';
  import { fly, fade } from 'svelte/transition';
  import { cubicOut }  from 'svelte/easing';
  import { createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';

  export let open   = false;
  export let title  = '';
  export let height = 'auto';  // 'auto' | 'full' | '60vh' etc.

  const dispatch = createEventDispatcher();
  let _locked = false;
  let _lockTimer;
  $: if (open) {
    clearTimeout(_lockTimer);
    _locked = true;
    _lockTimer = setTimeout(() => _locked = false, 400);
  }

  function close() {
    open = false;
    dispatch('close');
  }

  function onBackdropClick(e) {
    if (_locked) return;
    if (e.target === e.currentTarget) close();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div use:portal class="sheet-backdrop" on:click={onBackdropClick} use:closeOnBack={close}
    in:fade={{ duration: 200 }} out:fade={{ duration: 160 }}>
    <div
      class="sheet-panel"
      class:sheet-full={height === 'full'}
      style={height !== 'auto' && height !== 'full' ? `height:${height}` : ''}
      in:fly={{ y: 80, duration: 280, easing: cubicOut }}
      out:fly={{ y: 80, duration: 200 }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <!-- Handle bar -->
      <div class="sheet-handle"></div>

      {#if title}
        <div class="sheet-header">
          <h3 class="sheet-title">{title}</h3>
          <!-- Right-side action group: optional inline action icons
               (Edit, Delete, etc.) sit immediately next to the close
               button so all chrome stays tightly grouped in the top
               right corner — mirroring RecipeView's pattern. -->
          <div class="sheet-header-actions">
            <slot name="headerActions" />
            <button class="btn-icon close-btn" on:click={close} aria-label={$_('common.close')} title={$_('common.close')}>
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
        </div>
      {/if}

      <div class="sheet-body" class:no-title={!title}>
        <slot />
      </div>
    </div>
  </div>
{/if}

<style>
  .sheet-backdrop {
    position: fixed; inset: 0;
    background: var(--overlay);
    backdrop-filter: var(--backdrop-blur);
    -webkit-backdrop-filter: var(--backdrop-blur);
    /* Above CookLogDialog (130), ActionSheet (120), and Dialog (150)
       so a Sheet launched from inside a modal (e.g. DateInput's
       calendar picker) actually appears on top of the modal. */
    z-index: 200;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }
  .sheet-panel {
    width: 100%;
    max-height: 90dvh;
    background: var(--surface-1);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    border-top: 1px solid var(--border);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding-bottom: var(--safe-bottom);
  }
  .sheet-full { height: 90dvh; }

  /* Desktop / wide tablet — cap the panel so the sheet doesn't sprawl
     across a 1920px viewport with empty side gutters. Keeps the
     slide-up-from-bottom animation but the panel lands as a centered
     card with breathing room and rounded corners on all sides. Mobile
     (<768px) keeps the edge-to-edge bottom-sheet behavior. */
  @media (min-width: 768px) {
    .sheet-panel {
      width: min(720px, calc(100% - 48px));
      max-height: min(85dvh, 800px);
      margin-bottom: 24px;
      border-radius: var(--radius-xl);
      border-top: 1px solid var(--border);
      box-shadow: 0 24px 64px rgba(0,0,0,0.45);
    }
    /* Drag handle is a touch affordance; on desktop it adds visual
       noise without function — hide it. */
    .sheet-handle { display: none; }
    .sheet-header { padding-top: 20px; }
  }
  .sheet-handle {
    width: 36px; height: 4px;
    background: var(--border-strong);
    border-radius: var(--radius-full);
    margin: 12px auto 0;
    flex-shrink: 0;
  }
  .sheet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    flex-shrink: 0;
  }
  .sheet-title { font-size: 17px; font-weight: 600; }
  .sheet-header-actions { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .sheet-body {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 20px 20px;
  }
  .sheet-body.no-title { padding-top: 16px; }
</style>
