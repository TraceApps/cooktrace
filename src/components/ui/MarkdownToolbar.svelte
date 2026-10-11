<script>
  /**
   * MarkdownToolbar — formatting buttons that operate on a plain
   * <textarea> and insert markdown syntax around the current selection.
   * Keeps storage as plain text (importer-friendly) while giving users a
   * RichTextEditor-style affordance.
   *
   * Caller wires it like:
   *   <MarkdownToolbar bind:textarea {onChange} />
   *   <textarea bind:this={textarea} bind:value={text} />
   *
   * `onChange` is optional — needed only when the parent depends on a
   * synchronous reactive update (the toolbar mutates the textarea
   * directly, then dispatches an `input` event so `bind:value` wakes).
   */
  import { _ } from 'svelte-i18n';

  export let textarea = null;
  export let onChange = null;

  function _focus() {
    if (textarea) textarea.focus();
  }

  function _wrapSelection(left, right = left) {
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const v = textarea.value;
    const before = v.slice(0, start);
    const sel = v.slice(start, end);
    const after = v.slice(end);
    // If the selection already has the markers, strip them (toggle).
    if (sel.startsWith(left) && sel.endsWith(right) && sel.length >= left.length + right.length) {
      const inner = sel.slice(left.length, sel.length - right.length);
      textarea.value = before + inner + after;
      textarea.setSelectionRange(start, start + inner.length);
    } else {
      textarea.value = before + left + sel + right + after;
      // Place cursor between markers if no selection; else select the wrapped run.
      if (sel.length === 0) {
        const caret = start + left.length;
        textarea.setSelectionRange(caret, caret);
      } else {
        textarea.setSelectionRange(start + left.length, start + left.length + sel.length);
      }
    }
    _emit();
  }

  function _prefixLines(prefix, isOrdered = false) {
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const v = textarea.value;
    // Expand selection to full lines.
    const lineStart = v.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = v.indexOf('\n', end);
    const blockEnd = lineEnd === -1 ? v.length : lineEnd;
    const block = v.slice(lineStart, blockEnd);
    const lines = block.split('\n');
    const prefixed = lines
      .map((line, i) => {
        if (line.length === 0) return line;
        const p = isOrdered ? `${i + 1}. ` : prefix;
        return p + line;
      })
      .join('\n');
    textarea.value = v.slice(0, lineStart) + prefixed + v.slice(blockEnd);
    textarea.setSelectionRange(lineStart, lineStart + prefixed.length);
    _emit();
  }

  function _emit() {
    // Fire input event so Svelte's bind:value picks up the change.
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    if (onChange) onChange(textarea.value);
    _focus();
  }

  function bold()       { _wrapSelection('**'); }
  function italic()     { _wrapSelection('*'); }
  function underline()  { _wrapSelection('__'); }
  function bullet()     { _prefixLines('- ', false); }
  function numbered()   { _prefixLines('', true); }
</script>

<div class="md-toolbar" role="toolbar" aria-label={$_('rich_text_editor_ui.formatting')}>
  <button type="button" class="md-btn" on:click={bold} title={$_('markdown_toolbar_ui.bold_hint')} aria-label={$_('rich_text_editor_ui.bold')}
    on:mousedown|preventDefault>
    <strong>B</strong>
  </button>
  <button type="button" class="md-btn" on:click={italic} title={$_('markdown_toolbar_ui.italic_hint')} aria-label={$_('rich_text_editor_ui.italic')}
    on:mousedown|preventDefault>
    <em>I</em>
  </button>
  <button type="button" class="md-btn" on:click={underline} title={$_('markdown_toolbar_ui.underline_hint')} aria-label={$_('rich_text_editor_ui.underline')}
    on:mousedown|preventDefault>
    <span style="text-decoration: underline">U</span>
  </button>
  <span class="md-sep" aria-hidden="true"></span>
  <button type="button" class="md-btn" on:click={bullet} title={$_('rich_text_editor_ui.bullet_list')} aria-label={$_('rich_text_editor_ui.bullet_list')}
    on:mousedown|preventDefault>
    <span class="material-symbols-rounded">format_list_bulleted</span>
  </button>
  <button type="button" class="md-btn" on:click={numbered} title={$_('rich_text_editor_ui.numbered_list')} aria-label={$_('rich_text_editor_ui.numbered_list')}
    on:mousedown|preventDefault>
    <span class="material-symbols-rounded">format_list_numbered</span>
  </button>
</div>

<style>
  .md-toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-bottom: 0;
    border-top-left-radius: var(--radius-md);
    border-top-right-radius: var(--radius-md);
    background: var(--surface-1);
  }
  .md-btn {
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
  .md-btn:hover { background: var(--surface-2); color: var(--text-1); }
  .md-btn :global(.material-symbols-rounded) { font-size: 16px; }
  .md-sep {
    width: 1px;
    height: 18px;
    background: var(--border);
    margin: 0 4px;
  }
</style>
