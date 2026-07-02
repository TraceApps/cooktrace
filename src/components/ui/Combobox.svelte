<script>
  /**
   * Combobox — text input with type-to-filter dropdown.
   *
   * Supports two modes:
   *   - single: one selected value (string). Shown in the input.
   *   - chips:  many values (string[]). Shown as removable chips above
   *             the input; type + Enter (or click match) appends.
   *
   * Both modes support inline create — when the typed text doesn't
   * match anything and `creatable` is true, a "+ Create '<text>'" row
   * appears at the bottom of the dropdown. Clicking it (or pressing
   * Enter when it's highlighted) fires `create` with the raw text. The
   * parent decides what to do — for chip mode it usually just appends;
   * for single mode that needs a confirm dialog (e.g. recipe category)
   * the parent handles the dialog and then calls `acceptCreated(name)`.
   *
   * Props:
   *   mode         : 'single' | 'chips'         (default 'single')
   *   value        : string (single) | string[] (chips)
   *   options      : Array<{ name: string, count?: number, color?: string, ...}>
   *                  Anything with .name works.
   *   placeholder  : input placeholder text
   *   creatable    : show the "+ Create" row when no exact match
   *   createLabel  : override the create-row text. Defaults to "Create".
   *   maxResults   : cap dropdown items (default Infinity — show all).
   *                  The popover itself scrolls via max-height +
   *                  overflow-y, so it handles any list size. Pass an
   *                  explicit number only when you want to hint at a
   *                  smaller suggestion list. Was 8 originally, which
   *                  clipped tag / kitchen-gear / category browsing
   *                  and forced users to type-filter to reach items
   *                  they should have been able to scroll to.
   *
   * Events:
   *   on:select  → e.detail = the chosen option object
   *   on:create  → e.detail = the raw typed string
   *   on:change  → fires on every effective value change
   */
  import { createEventDispatcher } from 'svelte';
  import { portal } from '../../lib/portal.js';

  export let mode = 'single';
  export let value = mode === 'chips' ? [] : '';
  export let options = [];
  export let placeholder = 'Type to search…';
  export let creatable = true;
  export let createLabel = 'Create';
  export let maxResults = Infinity;
  export let disabled = false;

  const dispatch = createEventDispatcher();

  let inputEl;
  let wrapperEl;
  let popoverEl;
  let popoverPos = { left: 0, top: 0, width: 0 };
  // In-progress text the user is typing — bindable so callers can pull
  // it for an external "Add" button without forcing the user to press
  // Enter or pick a suggestion first.
  export let typed = '';
  let open = false;
  let highlightIndex = 0;

  // Lowercased trim — consistent with the server's matching.
  function _norm(s) { return String(s || '').toLowerCase().trim(); }

  $: filtered = (() => {
    const q = _norm(typed);
    const list = (options || []).map(o => typeof o === 'string' ? { name: o } : (o || {}));
    if (!q) return list.slice(0, maxResults);
    return list
      .filter(o => _norm(o.name).includes(q))
      .slice(0, maxResults);
  })();

  // Should we show the inline create row? Only if there's typed text
  // AND no exact (case-insensitive) match in the filtered list.
  $: canCreate = creatable
    && typed.trim().length > 0
    && !filtered.some(o => _norm(o.name) === _norm(typed));

  $: rowCount = filtered.length + (canCreate ? 1 : 0);

  // Clamp highlight when results shrink as user types.
  $: if (highlightIndex >= rowCount) highlightIndex = Math.max(0, rowCount - 1);

  function _positionPopover() {
    if (!wrapperEl) return;
    const r = wrapperEl.getBoundingClientRect();
    popoverPos = { left: r.left, top: r.bottom + 4, width: r.width };
  }

  function openPopover() {
    if (disabled) return;
    open = true;
    highlightIndex = 0;
    _positionPopover();
  }
  function closePopover() {
    open = false;
  }

  // Close on outside click or scroll. Repositions on resize/scroll.
  function _onWindow(e) {
    if (!open) return;
    if (e.type === 'resize' || e.type === 'scroll') _positionPopover();
    if (e.type === 'mousedown') {
      if (popoverEl && popoverEl.contains(e.target)) return;
      if (wrapperEl && wrapperEl.contains(e.target)) return;
      closePopover();
    }
  }

  // The popover is portaled to <body>, so when it lives inside a Sheet
  // (or any inner scroll container) the host's wheel / touchmove never
  // reach that container while a finger or cursor is over the popover
  // area; the host stops scrolling. Close on any outside wheel /
  // touchmove instead — matches the conventional "drop a menu by
  // scrolling" behaviour on mobile + desktop. Inside-the-popover scroll
  // is left alone so the internal list still scrolls.
  function _onOutsideScroll(e) {
    if (!open) return;
    if (popoverEl && popoverEl.contains(e.target)) return;
    closePopover();
  }

  function selectOption(opt) {
    if (mode === 'chips') {
      const next = Array.isArray(value) ? [...value] : [];
      if (!next.some(v => _norm(v) === _norm(opt.name))) next.push(opt.name);
      value = next;
      typed = '';
      dispatch('select', opt);
      dispatch('change', value);
      // Keep the dropdown open after selecting in chip mode so the user
      // can rapidly add several. For single mode we close.
    } else {
      value = opt.name;
      typed = '';
      closePopover();
      dispatch('select', opt);
      dispatch('change', value);
    }
  }

  function fireCreate() {
    const t = typed.trim();
    if (!t) return;
    // Single mode: parent owns the create flow (e.g. confirm dialog).
    // Chip mode: append immediately, friction-free.
    if (mode === 'chips') {
      const next = Array.isArray(value) ? [...value] : [];
      if (!next.some(v => _norm(v) === _norm(t))) next.push(t);
      value = next;
      typed = '';
      dispatch('change', value);
      dispatch('create', t);
    } else {
      // Stay open so the parent can show its dialog without flicker.
      dispatch('create', t);
    }
  }

  function removeChip(name) {
    if (mode !== 'chips') return;
    value = (value || []).filter(v => _norm(v) !== _norm(name));
    dispatch('change', value);
  }

  function onKeydown(e) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      openPopover();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape')          { closePopover(); return; }
    if (e.key === 'ArrowDown')       { e.preventDefault(); highlightIndex = Math.min(rowCount - 1, highlightIndex + 1); return; }
    if (e.key === 'ArrowUp')         { e.preventDefault(); highlightIndex = Math.max(0, highlightIndex - 1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIndex < filtered.length) selectOption(filtered[highlightIndex]);
      else if (canCreate) fireCreate();
      return;
    }
    if (e.key === 'Backspace' && typed === '' && mode === 'chips') {
      // Quick remove last chip on backspace when input is empty.
      const arr = Array.isArray(value) ? value : [];
      if (arr.length > 0) {
        value = arr.slice(0, -1);
        dispatch('change', value);
      }
    }
  }

  // Public method so a parent's create-confirmation flow can stamp the
  // chosen name back in (single mode). Chip mode doesn't need this —
  // fireCreate() already appends.
  export function acceptCreated(name) {
    if (mode === 'single') {
      value = name;
      typed = '';
      closePopover();
      dispatch('change', value);
    } else {
      const next = Array.isArray(value) ? [...value] : [];
      if (!next.some(v => _norm(v) === _norm(name))) next.push(name);
      value = next;
      typed = '';
      dispatch('change', value);
    }
  }
</script>

<svelte:window on:mousedown={_onWindow} on:resize={_onWindow} on:scroll={_onWindow} />
<svelte:document on:wheel|capture={_onOutsideScroll} on:touchmove|capture={_onOutsideScroll} />

<div class="cb" bind:this={wrapperEl} class:disabled>
  {#if mode === 'chips'}
    <div class="chips">
      {#each (value || []) as v}
        <span class="chip">
          {v}
          <button class="chip-x" on:click={() => removeChip(v)} aria-label={`Remove ${v}`} type="button">
            <span class="material-symbols-rounded">close</span>
          </button>
        </span>
      {/each}
      <input
        bind:this={inputEl}
        class="cb-input chip-input"
        type="text"
        placeholder={(value && value.length) ? '' : placeholder}
        bind:value={typed}
        on:focus={openPopover}
        on:input={() => { open = true; _positionPopover(); }}
        on:keydown={onKeydown}
        {disabled}
      />
    </div>
  {:else}
    <input
      bind:this={inputEl}
      class="cb-input"
      type="text"
      {placeholder}
      value={typed || (value || '')}
      on:focus={() => { typed = ''; openPopover(); }}
      on:input={(e) => { typed = e.target.value; open = true; _positionPopover(); }}
      on:keydown={onKeydown}
      {disabled}
    />
    <span class="cb-caret material-symbols-rounded" class:flipped={open}>expand_more</span>
  {/if}
</div>

{#if open && rowCount > 0}
  <div use:portal
    class="cb-popover"
    bind:this={popoverEl}
    style="left:{popoverPos.left}px; top:{popoverPos.top}px; width:{popoverPos.width}px;"
    role="listbox">
    {#each filtered as opt, i (opt.name)}
      <button type="button" class="cb-row" class:active={i === highlightIndex}
        on:mousedown|preventDefault={() => selectOption(opt)}
        on:mouseenter={() => highlightIndex = i}>
        {#if opt.color}
          <span class="cb-dot" style={`background:${opt.color}`}></span>
        {:else if opt.icon}
          <span class="material-symbols-rounded cb-icon">{opt.icon}</span>
        {/if}
        <span class="cb-name">{opt.name}</span>
        {#if opt.count != null}
          <span class="cb-count">{opt.count}</span>
        {/if}
      </button>
    {/each}
    {#if canCreate}
      <button type="button" class="cb-row cb-create" class:active={highlightIndex === filtered.length}
        on:mousedown|preventDefault={fireCreate}
        on:mouseenter={() => highlightIndex = filtered.length}>
        <span class="material-symbols-rounded cb-icon">add</span>
        <span class="cb-name">{createLabel} "<strong>{typed.trim()}</strong>"</span>
      </button>
    {/if}
  </div>
{/if}

<style>
  .cb {
    position: relative;
    display: flex;
    align-items: center;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0;
    box-sizing: border-box;
  }
  .cb:focus-within {
    border-color: var(--accent);
    outline: 2px solid var(--accent-dim);
  }
  .cb.disabled { opacity: 0.6; pointer-events: none; }

  .cb-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-1);
    font-size: 14px;
    padding: 10px 14px;
    min-width: 80px;
  }
  .cb-caret {
    color: var(--text-3);
    font-size: 20px;
    margin-right: 8px;
    transition: transform var(--dur-fast);
    pointer-events: none;
  }
  .cb-caret.flipped { transform: rotate(180deg); }

  .chips {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    padding: 3px 4px 3px 10px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 600;
  }
  .chip-x {
    background: transparent;
    border: none;
    cursor: pointer;
    color: inherit;
    padding: 0;
    width: 20px; height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
  }
  .chip-x:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .chip-x .material-symbols-rounded { font-size: 14px; }
  .chip-input { padding: 4px 6px; min-width: 100px; }

  .cb-popover {
    position: fixed;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
    max-height: 280px;
    overflow-y: auto;
    z-index: 1100;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .cb-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--text-1);
    font-size: 14px;
    text-align: left;
    width: 100%;
  }
  .cb-row.active,
  .cb-row:hover { background: var(--surface-2); }
  .cb-row.cb-create {
    color: var(--accent);
    font-weight: 600;
    border-top: 1px solid var(--border);
    margin-top: 2px;
    padding-top: 9px;
  }
  .cb-row.cb-create strong { color: var(--text-1); }
  .cb-dot {
    flex-shrink: 0;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .cb-icon {
    flex-shrink: 0;
    font-size: 18px;
    color: var(--text-3);
  }
  .cb-row.cb-create .cb-icon,
  .cb-row.active .cb-icon { color: var(--accent); }
  .cb-name { flex: 1; }
  .cb-count {
    font-size: 12px;
    color: var(--text-3);
    background: var(--surface-2);
    padding: 1px 6px;
    border-radius: 999px;
  }
</style>
