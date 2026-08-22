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
    _logsText = getLogBufferText() || '(no log lines captured yet)';
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
          title: 'CookTrace diagnostic logs',
          text: _logsText,
          dialogTitle: 'Share CookTrace logs',
        });
      } else if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: 'CookTrace diagnostic logs', text: _logsText });
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
        title: 'CookTrace diagnostic logs',
        text: 'CookTrace log file',
        dialogTitle: 'Share CookTrace log file',
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
        title: 'CookTrace crash report',
        text: 'CookTrace crash report',
        dialogTitle: 'Share CookTrace crash report',
      });
    } catch { /* user cancelled */ }
  }
  function _clearCrashReport() {
    clearCrashReport();
    _hasCrashReport = false;
  }
  function _clearLogs() {
    clearLogBuffer();
    _logsText = '(cleared)';
  }
  function _toggleVerbose(on) {
    _verboseLogging = on;
    setVerboseLogging(on);
  }
</script>

<div class="section-body">
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.diag.mode')}</span>
        <div class="setting-desc">Enables detailed app-internal logs (sync, settings, notifications){isNative ? ' and writes them to a daily log file on disk so they survive crashes and reloads.' : ' and verbose console output.'} Off by default; turn on while reproducing a bug, then export below.</div>
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
        View logs{hasCrashReport() ? ' · crash report available' : ''}
      </button>
    </div>
  </div>
</div>

<!-- Diagnostic logs viewer — mounted here (paired with the openers /
     state) instead of at the shell so the section is self-contained. -->
<Sheet bind:open={_logsSheet} title="Diagnostic Logs">
  <div style="padding:0 4px 8px">
    <p class="setting-desc" style="line-height:1.5;margin-bottom:10px">
      Recent log lines (capped at 500 normally, 1000 in verbose mode). Header shows app version + platform so the recipient knows what they're looking at.
    </p>
    <textarea readonly style="width:100%;height:280px;font-family:monospace;font-size:11px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm,6px);background:var(--surface-2);color:var(--text-1);resize:vertical;white-space:pre">{_logsText}</textarea>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="btn btn-primary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_copyLogs}>
        {#if _logsCopied}
          <span class="material-symbols-rounded" style="font-size:16px">check</span> Copied
        {:else}
          <span class="material-symbols-rounded" style="font-size:16px">content_copy</span> Copy
        {/if}
      </button>
      <button class="btn btn-secondary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_shareLogs}>
        <span class="material-symbols-rounded" style="font-size:16px">share</span> Share Text
      </button>
      <button class="btn btn-secondary" style="flex:1;min-width:120px;height:40px;font-size:13px" on:click={_clearLogs}>
        <span class="material-symbols-rounded" style="font-size:16px">delete</span> Clear
      </button>
    </div>
    {#if isNative && _verboseLogging}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-secondary" style="flex:1;height:40px;font-size:13px" on:click={_shareLogFile}>
          <span class="material-symbols-rounded" style="font-size:16px">description</span> Share Log File
        </button>
      </div>
      <p class="setting-desc" style="margin-top:6px;font-size:11px">
        Today's persisted log on disk (rotates daily, last 7 days kept). Better for long sessions or after a crash; the in-memory buffer above resets every reload.
      </p>
    {/if}
    {#if isNative && _hasCrashReport}
      <div style="margin-top:14px;padding:10px;background:color-mix(in srgb,var(--danger) 8%, transparent);border-left:3px solid var(--danger);border-radius:var(--radius-sm,6px)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="material-symbols-rounded" style="font-size:18px;color:var(--danger)">warning</span>
          <strong style="color:var(--danger);font-size:14px">{$_('settings_page.diag.crash_available')}</strong>
        </div>
        <p class="setting-desc" style="margin:0 0 8px;font-size:12px">
          The app captured an uncaught error. Share the report to help track it down, then dismiss it.
        </p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" style="flex:1;height:36px;font-size:12px" on:click={_shareCrashReport}>
            <span class="material-symbols-rounded" style="font-size:14px">share</span> Share Crash Report
          </button>
          <button class="btn btn-secondary" style="flex:1;height:36px;font-size:12px" on:click={_clearCrashReport}>
            Dismiss
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
