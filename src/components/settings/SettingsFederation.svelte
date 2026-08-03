<script>
  import { _ } from 'svelte-i18n';
  import {
    ntInstanceUrl, ntInstanceToken, ntFederationEnabled, ntConnectionVerified,
  } from '../../stores/settings.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import ConnectionStatus from './ConnectionStatus.svelte';

  let testing = false;
  let showToken = false;
  // Save+Test pattern mirrors SettingsTrace: each field has its own Save
  // button that persists the draft AND runs the connection test. Status
  // pill at the top reflects the most recent test result; on success we
  // auto-enable the federation flag so the user doesn't have to flip a
  // separate toggle to get search / log-meal working.
  let urlDraft   = $ntInstanceUrl  || '';
  let tokenDraft = $ntInstanceToken || '';
  let saved      = false;
  let testStatus = '';   // '' | 'ok' | 'fail'
  let lastConnectedUser = '';
  let lastError = '';

  // Derive the visible pill state from a combination of the in-flight
  // test and the persisted verified flag, so the green Connected pill
  // survives leaving Settings and coming back.
  $: visibleStatus = testing
    ? 'testing'
    : (testStatus === 'fail' ? 'fail'
      : (($ntConnectionVerified && $ntFederationEnabled) || testStatus === 'ok') ? 'ok'
      : '');

  $: canTest = !!urlDraft.trim() && !!tokenDraft.trim();

  function _invalidate() {
    testStatus = '';
    lastError = '';
    // Any field edit invalidates the previous verification — the URL or
    // token might now be different from what was tested.
    if ($ntConnectionVerified) ntConnectionVerified.set(false);
    if ($ntFederationEnabled) ntFederationEnabled.set(false);
  }

  // URL + Token are coupled — neither has meaning without the other,
  // so a single Save persists both then runs the test.
  async function save() {
    ntInstanceUrl.set(urlDraft.replace(/\/$/, ''));
    ntInstanceToken.set(tokenDraft);
    saved = true;
    setTimeout(() => saved = false, 2000);
    await test({ silentOk: false });
  }

  async function test({ silentOk = false } = {}) {
    if (!canTest) {
      showError($_('settings_federation_ct.toast.url_token_required'));
      return;
    }
    testing = true;
    testStatus = '';
    lastError = '';
    try {
      const csrf = typeof localStorage !== 'undefined' ? localStorage.getItem('ct:csrf') : null;
      const res = await fetch('/api/nt/test', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify({ url: urlDraft, token: tokenDraft }),
      });
      const body = await res.json();
      if (body.ok) {
        testStatus = 'ok';
        lastConnectedUser = body.user?.username || body.user?.name || 'NutriTrace';
        // Auto-enable on first successful test so the user doesn't need
        // to flip the toggle separately. Subsequent successful re-tests
        // are no-ops since the flag is already on.
        ntFederationEnabled.set(true);
        ntConnectionVerified.set(true);
        if (!silentOk) showSuccess(`Connected to NutriTrace as ${lastConnectedUser}`);
      } else {
        testStatus = 'fail';
        lastError = body.error || 'Connection failed';
        ntFederationEnabled.set(false);
        ntConnectionVerified.set(false);
        showError(lastError);
      }
    } catch (e) {
      testStatus = 'fail';
      lastError = e.message || 'Connection failed';
      ntFederationEnabled.set(false);
      ntConnectionVerified.set(false);
      showError(lastError);
    } finally { testing = false; }
  }
</script>

<div class="card settings-card">
  <ConnectionStatus
    status={visibleStatus}
    connectedAs={lastConnectedUser || $ntInstanceUrl.replace(/^https?:\/\//, '')}
    error={lastError}
    onRetest={() => test()}
    retestDisabled={testing || !canTest}
  />

  <div class="setting-row">
    <div>
      <span class="setting-label">{$_('settings_federation_ct.connect_to_nt')}</span>
      <span class="setting-desc">Pull ingredient nutrition + log cooked meals to your NutriTrace diary automatically. Enter your NutriTrace URL and a personal access token (Settings → Profile → API Tokens on NutriTrace), then Save to test the connection.</span>
    </div>
  </div>

  <div class="setting-divider"></div>
  <div class="setting-row stack">
    <span class="setting-label">{$_('settings_federation_ct.instance_url')}</span>
    <input class="input" type="url" bind:value={urlDraft}
      placeholder="https://nutritrace.example.com"
      on:input={_invalidate} />
  </div>

  <div class="setting-divider"></div>
  <div class="setting-row stack">
    <span class="setting-label">{$_('settings_federation_ct.access_token')}</span>
    <div class="key-row">
      {#if showToken}
        <input class="input" type="text" bind:value={tokenDraft}
          placeholder={$_('settings_federation_ct.access_token_ph')}
          on:input={_invalidate} />
      {:else}
        <input class="input" type="password" bind:value={tokenDraft}
          placeholder={$_('settings_federation_ct.access_token_ph')}
          on:input={_invalidate} />
      {/if}
      <button class="key-toggle" on:click={() => showToken = !showToken} aria-label={showToken ? 'Hide' : 'Show'}>
        <span class="material-symbols-rounded">{showToken ? 'visibility_off' : 'visibility'}</span>
      </button>
      <button class="btn btn-primary save-btn" on:click={save}
        disabled={testing || !urlDraft.trim() || !tokenDraft.trim()}>
        {saved ? 'Saved' : (testing ? 'Testing…' : 'Save')}
      </button>
    </div>
  </div>
</div>

<style>
  .card.settings-card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-lg); overflow: hidden;
  }
  .setting-row {
    display: flex; justify-content: space-between; align-items: center;
    gap: 12px; padding: 14px 16px;
  }
  .setting-row.stack { flex-direction: column; align-items: stretch; gap: 8px; }
  .setting-row > div:first-child { flex: 1; min-width: 0; }
  .setting-label { font-size: 14px; color: var(--text-1); display: block; }
  .setting-desc { font-size: 12px; color: var(--text-3); margin-top: 4px; line-height: 1.4; display: block; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }

  .input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px;
    color: var(--text-1); font-size: 14px; font-family: inherit;
    box-sizing: border-box; width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }

  .key-row { display: flex; gap: 6px; align-items: stretch; flex-wrap: wrap; }
  .key-row .input { flex: 1; min-width: 220px; font-family: monospace; }
  .key-toggle {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); width: 40px; height: 40px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; color: var(--text-3);
  }
  .key-toggle:hover { color: var(--text-1); }
  .save-btn { height: 40px; min-width: 84px; }
</style>
