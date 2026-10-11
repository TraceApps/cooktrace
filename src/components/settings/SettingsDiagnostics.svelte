<script>
  // Diagnostics section — extracted from Settings.svelte. Owns the
  // verbose-logging toggle, the "View logs" trigger, and the full
  // Sheet that shows the log buffer + share/copy/clear actions and
  // the optional crash-report block. Mirrors NutriTrace's Diagnostics
  // section. Verbose mode flips a flag in localStorage that the logger
  // reads; the buffer + crash files come from log-capture.js, which is
  // imported first in main.js so console.* and window error events are
  // intercepted before any other module runs.
  import { _ } from 'svelte-i18n';
  import { isNative } from '../../lib/platform.js';
  import { fold } from '../../lib/fold.js';
  import {
    isVerboseLogging, setVerboseLogging,
    getLogBufferText, clearLogBuffer,
    getLogFileUri, getLastCrashFileUri,
    hasCrashReport, clearCrashReport,
  } from '../../lib/log-capture.js';
  import { showError } from '../../stores/toast.js';
  import Toggle from './Toggle.svelte';
  import Sheet from '../ui/Sheet.svelte';

  let _logsSheet = false;
  let _logsText = '';
  let _logsCopied = false;
  let _verboseLogging = isVerboseLogging();
  let _hasCrashReport = false;

  function _openLogsSheet() {
    _logsText = getLogBufferText() || $_('settings_diagnostics_ui.no_lines');
    _logsCopied = false;
    _hasCrashReport = hasCrashReport();
    _logsSheet = true;
  }
  async function _copyLogs() {
    try {
      await navigator.clipboard.writeText(_logsText);
      _logsCopied = true;
      setTimeout(() => _logsCopied = false, 2000);
    } catch {
      showError($_('settings_page.toast.copy_failed'));
    }
  }
  async function _shareLogs() {
    try {
      if (isNative) {
        const { Share } = await import('@capacitor/share');
        await Share.share({
          title: $_('settings_diagnostics_ui.share_logs_title'),
          text: _logsText,
          dialogTitle: $_('settings_diagnostics_ui.share_logs_dialog'),
        });
      } else if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: $_('settings_diagnostics_ui.share_logs_title'), text: _logsText });
      } else {
        await _copyLogs();
      }
    } catch {
      // User cancelled — silent.
    }
  }
  // Share a file from Directory.Data via the Android share intent. Direct
  // file:// URIs into private app data fail silently on Android target SDK
  // 24+: the receiving app gets the intent but can't read the URI, so it
  // falls back to the share intent's text field and saves THAT as the file
  // contents (the title-only file bug). Fix: copy the source file into
  // Directory.Cache first; Capacitor's auto-generated FileProvider XML
  // whitelists the cache directory and translates the file URI into a
  // content:// URI the receiving app can actually read. Ported from
  // NutriTrace #60 fix (commit a69c661).
  async function _shareFileViaCache({ srcPath, cacheBasename, title, text, dialogTitle }) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const src = await Filesystem.readFile({ path: srcPath, directory: Directory.Data, encoding: Encoding.UTF8 });
    const cachePath = `${cacheBasename}-${Date.now()}.txt`;
    await Filesystem.writeFile({ path: cachePath, data: src.data, directory: Directory.Cache, encoding: Encoding.UTF8 });
    const { uri } = await Filesystem.getUri({ path: cachePath, directory: Directory.Cache });
    const { Share } = await import('@capacitor/share');
    await Share.share({ title, text, url: uri, dialogTitle });
  }
  async function _shareLogFile() {
    try {
      const f = await getLogFileUri();
      if (!f) { showError($_('settings_page.toast.no_log_file')); return; }
      await _shareFileViaCache({
        srcPath: f.path,
        cacheBasename: 'cooktrace-log',
        title: $_('settings_diagnostics_ui.share_logs_title'),
        text: $_('settings_diagnostics_ui.log_file_text'),
        dialogTitle: $_('settings_diagnostics_ui.share_log_file_dialog'),
      });
    } catch { /* user cancelled */ }
  }
  async function _shareCrashReport() {
    try {
      const f = await getLastCrashFileUri();
      if (!f) { _hasCrashReport = false; return; }
      await _shareFileViaCache({
        srcPath: f.path,
        cacheBasename: 'cooktrace-crash',
        title: $_('settings_diagnostics_ui.crash_report_title'),
        text: $_('settings_diagnostics_ui.crash_report_title'),
        dialogTitle: $_('settings_diagnostics_ui.share_crash_dialog'),
      });
    } catch { /* user cancelled */ }
  }
  function _clearCrashReport() {
    clearCrashReport();
    _hasCrashReport = false;
  }
  function _clearLogs() {
    clearLogBuffer();
    _logsText = $_('settings_diagnostics_ui.cleared');
  }
  function _toggleVerbose(on) {
    _verboseLogging = on;
    setVerboseLogging(on);
  }
</script>

<div class="section-body">
  <div class="card settings-card">
    <!-- What the device reports about its own hinge. Foldable layouts are
         driven entirely by this, so when one does not behave, this is the
         first thing to look at: a phone says "not a foldable", an opened one
         says "opened flat", and only a half-open one reports a crease. -->
    <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:4px">
      <span class="setting-label">{$_('settings_diagnostics_ui.foldable')}</span>
      <div class="setting-desc">
        {#if $fold && $fold.posture === 'flat'}
          {$_('settings_diagnostics_ui.fold_flat', { values: { start: $fold.start, end: $fold.end } })}
        {:else if $fold}
          {$_($fold.posture === 'book' ? 'settings_diagnostics_ui.fold_half_book' : 'settings_diagnostics_ui.fold_half_laptop', { values: { start: $fold.start, end: $fold.end } })}
        {:else}
          {$_('settings_diagnostics_ui.fold_none')}
        {/if}
      </div>
    </div>

    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.diag.mode')}</span>
        <div class="setting-desc">{isNative ? $_('settings_diagnostics_ui.mode_desc_native') : $_('settings_diagnostics_ui.mode_desc_web')}</div>
      </div>
      <Toggle checked={_verboseLogging} on:change={e => _toggleVerbose(e.detail)} />
    </div>
    <div class="setting-divider"></div>
    <div class="setting-row" style="flex-direction:column;align-items:flex-start;gap:8px">
      <span class="setting-label">{$_('settings_page.diag.view_logs')}</span>
      <p class="setting-desc" style="line-height:1.5">
        {$_('settings_page.diag.logs_desc_prefix')}<a href="https://github.com/traceapps/cooktrace/issues" target="_blank" rel="noopener" class="about-link">{$_('settings_page.diag.logs_desc_github')}</a>.{isNative ? $_('settings_page.diag.logs_desc_android') : ''}{$_('settings_page.diag.logs_desc_suffix')}
      </p>
      <button class="btn btn-secondary" style="height:40px;font-size:13px" on:click={_openLogsSheet}>
        <span class="material-symbols-rounded" style="font-size:16px">terminal</span>
        {hasCrashReport() ? $_('settings_diagnostics_ui.view_logs_crash') : $_('settings_diagnostics_ui.view_logs')}
      </button>
    </div>
  </div>
</div>

<!-- Diagnostic logs viewer — mounted here (paired with the openers /
     state) instead of at the shell so the section is self-contained. -->
<Sheet bind:open={_logsSheet} title={$_('settings_diagnostics_ui.logs_title')}>
  <div style="padding:0 4px 8px">
    <p class="setting-desc" style="line-height:1.5;margin-bottom:10px">
      {$_('settings_diagnostics_ui.logs_sheet_desc')}
    </p>
    <textarea readonly style="width:100%;height:280px;font-family:monospace;font-size:11px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm,6px);background:var(--surface-2);color:var(--text-1);resize:vertical;white-space:pre">{_logsText}</textarea>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="btn btn-primary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_copyLogs}>
        {#if _logsCopied}
          <span class="material-symbols-rounded" style="font-size:16px">check</span> {$_('updates.server.copied')}
        {:else}
          <span class="material-symbols-rounded" style="font-size:16px">content_copy</span> {$_('settings.users.copy')}
        {/if}
      </button>
      <button class="btn btn-secondary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_shareLogs}>
        <span class="material-symbols-rounded" style="font-size:16px">share</span> {$_('settings_diagnostics_ui.share_text')}
      </button>
      <button class="btn btn-secondary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_clearLogs}>
        <span class="material-symbols-rounded" style="font-size:16px">delete</span> {$_('common.clear')}
      </button>
    </div>
    {#if isNative && _verboseLogging}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-secondary" style="flex:1;height:40px;font-size:13px" on:click={_shareLogFile}>
          <span class="material-symbols-rounded" style="font-size:16px">description</span> {$_('settings_diagnostics_ui.share_log_file')}
        </button>
      </div>
      <p class="setting-desc" style="margin-top:6px;font-size:11px">
        {$_('settings_diagnostics_ui.log_file_desc')}
      </p>
    {/if}
    {#if isNative && _hasCrashReport}
      <div style="margin-top:14px;padding:10px;background:color-mix(in srgb,var(--danger) 8%, transparent);border-left:3px solid var(--danger);border-radius:var(--radius-sm,6px)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger)">warning</span>
          <strong style="color:var(--danger);font-size:14px">{$_('settings_page.diag.crash_available')}</strong>
        </div>
        <p class="setting-desc" style="margin:0 0 8px;font-size:12px">
          {$_('settings_diagnostics_ui.crash_desc')}
        </p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" style="flex:1;height:36px;font-size:12px" on:click={_shareCrashReport}>
            <span class="material-symbols-rounded" style="font-size:14px">share</span> {$_('settings_diagnostics_ui.share_crash')}
          </button>
          <button class="btn btn-secondary" style="flex:1;height:36px;font-size:12px" on:click={_clearCrashReport}>
            {$_('recipe_view_ct.versions.dismiss')}
          </button>
        </div>
      </div>
    {/if}
  </div>
</Sheet>

<style>
  .about-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
