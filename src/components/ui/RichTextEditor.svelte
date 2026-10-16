<script>
  /**
   * RichTextEditor — small contenteditable rich-text input for free-form
   * recipe notes. Toolbar supports Bold / Italic / Bullet / Numbered list.
   *
   * Storage shape: HTML string (a sanitized subset). Empty editors save
   * as null so the field stays unset rather than carrying an empty
   * <p></p>. Caller renders the saved HTML via `{@html}` after running
   * it through `sanitizeRichText()` again on the display side.
   *
   * The sanitizer is intentionally aggressive: only the small set of
   * inline / list tags relevant to "user notes" survives, with all
   * attributes stripped. Self-hosted app, single-tenant note authoring,
   * but defense-in-depth still cheap.
   */
  import { onMount, createEventDispatcher } from 'svelte';
  import { _ } from 'svelte-i18n';

  /** Two-way bindable HTML string. */
  export let value = '';
  export let placeholder = '';
  $: shownPlaceholder = placeholder || $_('rich_text_editor_ui.placeholder');
  /** Visible row count target — controls min-height. */
  export let rows = 4;

  const dispatch = createEventDispatcher();
  let editor;
  let _internalUpdate = false;

  // Reactively push external value changes into the contenteditable
  // surface — but only when the change came from outside (not a user
  // keystroke we just dispatched). Without the guard the cursor would
  // jump to the start every time the user typed.
  $: if (editor && !_internalUpdate && (value || '') !== editor.innerHTML) {
    editor.innerHTML = sanitizeRichText(value || '');
  }

  function _onInput() {
    _internalUpdate = true;
    value = sanitizeRichText(editor.innerHTML);
    dispatch('change', value);
    setTimeout(() => { _internalUpdate = false; }, 0);
  }

  function exec(command, value = null) {
    editor.focus();
    document.execCommand(command, false, value);
    _onInput();
  }

  // Color picker — show a small palette popover; clicking a swatch
  // applies it via execCommand('foreColor'). The 8-color palette is
  // intentionally short so the editor stays focused on note-writing
  // not on graphic design.
  let colorOpen = false;
  const COLORS = [
    { nameKey: 'rich_text_editor_ui.color_default', value: '' },
    { nameKey: 'rich_text_editor_ui.color_red',     value: '#EF4444' },
    { nameKey: 'rich_text_editor_ui.color_orange',  value: '#F59E0B' },
    { nameKey: 'rich_text_editor_ui.color_yellow',  value: '#EAB308' },
    { nameKey: 'rich_text_editor_ui.color_green',   value: '#10B981' },
    { nameKey: 'rich_text_editor_ui.color_blue',    value: '#3B82F6' },
    { nameKey: 'rich_text_editor_ui.color_purple',  value: '#A855F7' },
    { nameKey: 'rich_text_editor_ui.color_pink',    value: '#EC4899' },
  ];
  function applyColor(c) {
    if (!c.value) {
      // "Default" — strip foreground color from the selection.
      exec('removeFormat');
    } else {
      exec('foreColor', c.value);
    }
    colorOpen = false;
  }

  // Strip unrecognised tags + attributes on paste so users can't
  // smuggle styles or scripts in from copied web content.
  function _onPaste(e) {
    const html = e.clipboardData?.getData('text/html');
    const text = e.clipboardData?.getData('text/plain');
    if (html) {
      e.preventDefault();
      document.execCommand('insertHTML', false, sanitizeRichText(html));
    } else if (text) {
      e.preventDefault();
      document.execCommand('insertText', false, text);
    }
  }

  onMount(() => {
    if (editor) editor.innerHTML = sanitizeRichText(value || '');
  });
</script>

<div class="rte">
  <div class="rte-toolbar" role="toolbar" aria-label={$_('rich_text_editor_ui.formatting')}>
    <button type="button" class="rte-btn" on:click={() => exec('bold')} title={$_('rich_text_editor_ui.bold_shortcut')} aria-label={$_('rich_text_editor_ui.bold')}>
      <strong>B</strong>
    </button>
    <button type="button" class="rte-btn" on:click={() => exec('italic')} title={$_('rich_text_editor_ui.italic_shortcut')} aria-label={$_('rich_text_editor_ui.italic')}>
      <em>I</em>
    </button>
    <button type="button" class="rte-btn" on:click={() => exec('underline')} title={$_('rich_text_editor_ui.underline_shortcut')} aria-label={$_('rich_text_editor_ui.underline')}>
      <span style="text-decoration: underline">U</span>
    </button>
    <button type="button" class="rte-btn" on:click={() => exec('strikeThrough')} title={$_('rich_text_editor_ui.strikethrough')} aria-label={$_('rich_text_editor_ui.strikethrough')}>
      <span style="text-decoration: line-through">S</span>
    </button>
    <span class="rte-sep" aria-hidden="true"></span>
    <div class="rte-color-wrap">
      <button type="button" class="rte-btn" on:click={() => colorOpen = !colorOpen}
        title={$_('rich_text_editor_ui.text_color')} aria-label={$_('rich_text_editor_ui.text_color')} aria-haspopup="true" aria-expanded={colorOpen}>
        <span class="material-symbols-rounded">format_color_text</span>
      </button>
      {#if colorOpen}
        <div class="rte-color-pop" role="menu">
          {#each COLORS as c}
            <button type="button" class="rte-color-swatch" on:click={() => applyColor(c)}
              title={$_(c.nameKey)} aria-label={$_(c.nameKey)}
              style={c.value ? `background:${c.value}` : ''}
              class:default={!c.value}>
              {#if !c.value}
                <span class="material-symbols-rounded">format_color_reset</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <span class="rte-sep" aria-hidden="true"></span>
    <button type="button" class="rte-btn" on:click={() => exec('insertUnorderedList')} title={$_('rich_text_editor_ui.bullet_list')} aria-label={$_('rich_text_editor_ui.bullet_list')}>
      <span class="material-symbols-rounded">format_list_bulleted</span>
    </button>
    <button type="button" class="rte-btn" on:click={() => exec('insertOrderedList')} title={$_('rich_text_editor_ui.numbered_list')} aria-label={$_('rich_text_editor_ui.numbered_list')}>
      <span class="material-symbols-rounded">format_list_numbered</span>
    </button>
  </div>
  <div
    class="rte-area" dir="auto"
    contenteditable="true"
    bind:this={editor}
    on:input={_onInput}
    on:paste={_onPaste}
    role="textbox"
    aria-multiline="true"
    aria-placeholder={shownPlaceholder}
    style="min-height: {rows * 1.5}em"
  ></div>
  {#if !value}
    <span class="rte-placeholder" aria-hidden="true">{shownPlaceholder}</span>
  {/if}
</div>

<style>
  .rte {
    position: relative;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2);
    overflow: hidden;
  }
  .rte:focus-within {
    border-color: var(--accent);
    outline: 2px solid var(--accent-dim);
  }
  .rte-toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }
  .rte-btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    width: 28px; height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text-2);
    font-size: 13px;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .rte-btn:hover { background: var(--surface-2); color: var(--text-1); }
  .rte-btn :global(.material-symbols-rounded) { font-size: 16px; }
  .rte-sep {
    width: 1px;
    height: 18px;
    background: var(--border);
    margin: 0 4px;
  }

  /* Color picker — popover wraps its trigger so it positions correctly
     without absolute calculations, and a small grid of round swatches
     makes the choices visually obvious. */
  .rte-color-wrap { position: relative; }
  .rte-color-pop {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 10;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    padding: 8px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    min-width: 144px;
  }
  .rte-color-swatch {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 1px solid var(--border);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: transform var(--dur-fast);
  }
  .rte-color-swatch:hover { transform: scale(1.1); }
  .rte-color-swatch.default {
    background: var(--surface-2);
    color: var(--text-3);
  }
  .rte-color-swatch.default :global(.material-symbols-rounded) { font-size: 14px; }
  .rte-area {
    padding: 10px 12px;
    color: var(--text-1);
    font-size: 14px;
    line-height: 1.5;
    outline: none;
  }
  .rte-area :global(p) { margin: 0 0 8px; }
  .rte-area :global(p:last-child) { margin-bottom: 0; }
  .rte-area :global(ul),
  .rte-area :global(ol) { margin: 4px 0 8px; padding-inline-start: 24px; }
  /* Each paragraph its own way: the editor keeps no dir in notes, so an
     Arabic paragraph and an English one each read from their first letter. */
  .rte-area :global(p), .rte-area :global(li) { unicode-bidi: plaintext; }
  .rte-area :global(li) { margin: 2px 0; }
  .rte-placeholder {
    position: absolute;
    top: 50px; /* below toolbar */
    left: 12px;
    color: var(--text-3);
    font-size: 14px;
    pointer-events: none;
  }
</style>

<script context="module">
  // Allowed tags + their permitted child positions. Anything else gets
  // unwrapped (kids preserved) or dropped wholesale. Intentionally
  // narrow — nothing here can execute script, load resources, or carry
  // styles. SPAN + FONT are kept solely so the foreColor execCommand
  // output (which uses one or the other depending on browser) can be
  // displayed; we filter their attributes down to color only.
  const ALLOWED = new Set([
    'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
    'UL', 'OL', 'LI', 'P', 'BR', 'DIV',
    'SPAN', 'FONT',
  ]);
  // Hex color regex — only #RRGGBB or #RGB allowed in the color attr /
  // style. Rejects expressions, urls, anything else.
  const HEX_COLOR_RX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

  /**
   * Run an HTML string through a small allowlist filter. Strips every
   * attribute (no class / on*), drops any tag not in ALLOWED, and keeps
   * only `color: #...` style on SPAN and `color="#..."` on FONT so
   * RichTextEditor's color picker output survives the round-trip.
   * Exposed so callers can re-sanitize when rendering for display.
   */
  export function sanitizeRichText(html) {
    if (!html) return '';
    if (typeof document === 'undefined') return html; // SSR no-op
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    _walk(wrapper);
    // Treat a tree of only <br> / whitespace as empty.
    const txt = (wrapper.textContent || '').trim();
    if (!txt && !wrapper.querySelector('img')) return '';
    return wrapper.innerHTML;
  }

  function _walk(node) {
    const kids = Array.from(node.children || []);
    for (const child of kids) {
      if (!ALLOWED.has(child.tagName)) {
        // Unwrap: replace this element with its children so we don't
        // lose user content embedded in disallowed tags.
        while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }
      // Strip everything but the narrow color attrs we keep on the
      // tags execCommand actually produces.
      const isFont = child.tagName === 'FONT';
      const isSpan = child.tagName === 'SPAN';
      let preservedColor = '';
      if (isFont) {
        const c = child.getAttribute('color') || '';
        if (HEX_COLOR_RX.test(c.trim())) preservedColor = c.trim();
      } else if (isSpan) {
        const m = (child.getAttribute('style') || '').match(/color\s*:\s*(#[0-9a-f]{3,6})/i);
        if (m && HEX_COLOR_RX.test(m[1])) preservedColor = m[1];
      }
      while (child.attributes.length > 0) {
        child.removeAttribute(child.attributes[0].name);
      }
      if (preservedColor) {
        if (isFont) child.setAttribute('color', preservedColor);
        else if (isSpan) child.setAttribute('style', `color: ${preservedColor}`);
      } else if (isSpan) {
        // No color → unwrap the span, it's just clutter.
        while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }
      _walk(child);
    }
  }
</script>
