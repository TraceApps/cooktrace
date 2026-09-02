<script>
  /**
   * IngredientNameField, free-text ingredient name input with a
   * pantry-name suggestion dropdown.
   *
   * Replaces the native <input list> + <datalist> combo that used to
   * back this field: on mobile the browser/WebView renders that as its
   * own OS-level picker, with no awareness of the app's layout or the
   * on-screen keyboard, so it could cover the keyboard and most of the
   * screen. This is a small custom dropdown instead (same shape as
   * UnitPicker's popover), portaled to <body> and positioned against
   * window.visualViewport so it sizes itself to whatever space is
   * actually free above or below the input once the keyboard is up.
   *
   * Typing is always free text: value updates on every keystroke, a
   * suggestion is just a shortcut, never a requirement (unlike
   * Combobox's single mode, which expects a real pick-or-create).
   */
  import { onMount, onDestroy, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { portal } from '../../lib/portal.js';

  export let value = '';
  export let suggestions = [];
  export let placeholder = '';

  const _uid = Math.random().toString(36).slice(2);

  let inputEl;
  let popoverEl;
  let wrapEl;
  let open = false;
  let highlight = -1;
  let popStyle = '';

  function _norm(s) { return String(s || '').toLowerCase().trim(); }

  // Only suggest once there's something to match against, showing the
  // full pantry catalog unprompted on focus is its own kind of mess.
  $: q = _norm(value);
  $: filtered = q
    ? suggestions.filter(n => _norm(n).includes(q) && _norm(n) !== q)
    : [];
  $: if (highlight >= filtered.length) highlight = filtered.length - 1;
  $: showPopover = open && filtered.length > 0;

  function pick(name) {
    value = name;
    open = false;
    highlight = -1;
    if (inputEl) setTimeout(() => inputEl.blur(), 0);
  }

  function onInput(e) {
    value = e.target.value;
    open = true;
    highlight = -1;
    tick().then(_reposition);
  }

  function onFocus() {
    if (filtered.length > 0) { open = true; tick().then(_reposition); }
  }

  function onKey(e) {
    if (!open) return;
    if (e.key === 'ArrowDown') { highlight = Math.min(filtered.length - 1, highlight + 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { highlight = Math.max(0, highlight - 1); e.preventDefault(); }
    else if (e.key === 'Enter') {
      if (highlight >= 0 && filtered[highlight]) { pick(filtered[highlight]); e.preventDefault(); }
      else { open = false; }
    }
    else if (e.key === 'Escape') { open = false; highlight = -1; }
  }

  function onBlur() {
    // Deferred so a mousedown on a popover row registers before we close.
    setTimeout(() => {
      const a = document.activeElement;
      if (wrapEl?.contains(a) || popoverEl?.contains(a)) return;
      open = false;
      highlight = -1;
    }, 120);
  }

  // window.visualViewport shrinks to the space actually left after the
  // on-screen keyboard opens (on platforms that report it); plain
  // window.innerHeight doesn't reliably reflect that everywhere (notably
  // iOS Safari/PWA), which is how the old native datalist ended up
  // fighting the keyboard for space. Fall back to innerHeight where
  // visualViewport isn't available.
  function _viewport() {
    const vv = window.visualViewport;
    return vv ? { height: vv.height, offsetTop: vv.offsetTop } : { height: window.innerHeight, offsetTop: 0 };
  }

  function _reposition() {
    if (!inputEl) return;
    const r = inputEl.getBoundingClientRect();
    const { height: vh, offsetTop } = _viewport();
    const viewBottom = offsetTop + vh;
    const POP_MAX_H = 240;
    const GAP = 4;
    const spaceBelow = viewBottom - r.bottom - 8;
    const spaceAbove = r.top - offsetTop - 8;
    const placeAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
    const top = placeAbove
      ? Math.max(offsetTop + 8, r.top - GAP - Math.min(POP_MAX_H, spaceAbove))
      : r.bottom + GAP;
    const maxH = placeAbove ? Math.min(POP_MAX_H, spaceAbove) : Math.min(POP_MAX_H, spaceBelow);
    popStyle = `top:${top}px;left:${r.left}px;width:${r.width}px;max-height:${Math.max(0, maxH)}px;`;
  }
  function _onViewportChange() { if (open) _reposition(); }

  onMount(() => {
    window.addEventListener('resize', _onViewportChange);
    window.addEventListener('scroll', _onViewportChange, true);
    window.visualViewport?.addEventListener('resize', _onViewportChange);
    window.visualViewport?.addEventListener('scroll', _onViewportChange);
  });
  onDestroy(() => {
    window.removeEventListener('resize', _onViewportChange);
    window.removeEventListener('scroll', _onViewportChange, true);
    window.visualViewport?.removeEventListener('resize', _onViewportChange);
    window.visualViewport?.removeEventListener('scroll', _onViewportChange);
  });
</script>

<div class="ing-name-field" bind:this={wrapEl}>
  <input
    bind:this={inputEl}
    class="input ing-name"
    type="text"
    {placeholder}
    {value}
    on:input={onInput}
    on:focus={onFocus}
    on:blur={onBlur}
    on:keydown={onKey}
    autocomplete="off"
    spellcheck="false"
    role="combobox"
    aria-autocomplete="list"
    aria-haspopup="listbox"
    aria-expanded={showPopover}
    aria-controls="ing-name-popover-{_uid}"
  />
</div>

{#if showPopover}
  <div use:portal class="ing-name-popover" bind:this={popoverEl} role="listbox"
    id="ing-name-popover-{_uid}" style={popStyle} transition:fade={{ duration: 80 }}>
    {#each filtered as name, i}
      <button
        type="button"
        class="opt"
        class:active={highlight === i}
        role="option"
        aria-selected={_norm(value) === _norm(name)}
        on:mousedown|preventDefault={() => pick(name)}
        on:mouseenter={() => highlight = i}
      >
        {name}
      </button>
    {/each}
  </div>
{/if}

<style>
  .ing-name-field { flex: 1; min-width: 0; }
  /* padding-right leaves room for the parent's absolutely-positioned
     .ing-indicators (linked-pantry / has-note icons), which only show
     up at the same <=900px breakpoint the parent's own layout switches
     at (see RecipeEditor.svelte's .ing-row grid media query). */
  .ing-name-field .ing-name { width: 100%; padding-right: 8px; }
  @media (max-width: 900px) {
    .ing-name-field .ing-name { padding-right: 46px; }
  }

  /* Portaled to document.body so it escapes any ancestor
     overflow:hidden and is positioned/sized against the live
     viewport (see _reposition), not the OS's own idea of a picker. */
  .ing-name-popover {
    position: fixed;
    overflow-y: auto;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    z-index: 200;
    padding: 4px;
  }
  .opt {
    display: block;
    width: 100%;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    cursor: pointer;
    font-size: 13px;
    color: var(--text-1);
    text-align: left;
  }
  .opt:hover, .opt.active { background: var(--accent-dim); color: var(--accent); }
</style>
