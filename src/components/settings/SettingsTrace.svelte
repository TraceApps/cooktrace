<script>
  import { aiEnabled, aiProvider, aiApiKey, aiModel, aiBaseUrl, aiAssistantName, aiKeyVerified, smartLogEnabled, traceChefHat, envLocks as envLocksStore } from '../../stores/settings.js';
  import { AI_PROVIDERS, AI_DEFAULT_MODELS, AI_MODELS, AI_MODEL_CUSTOM, callAI, callAIProxy } from '../../lib/aiChat.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import ConnectionStatus from './ConnectionStatus.svelte';

  // Subscribe to the global envLocks store (populated by App.svelte at
  // startup). Same envLocks shape across the apps. Mirrors NutriTrace #36.
  export let envLocks = { ai: false, ai_enabled: false };
  $: envLocks = $envLocksStore;
  // When env-locked, the toggle's displayed state comes from AI_ENABLED env
  // var, not the per-user store (which stays empty under env-lock because
  // user_settings doesn't pick up server-wide env values).
  $: _displayedAiEnabled = envLocks.ai ? !!envLocks.ai_enabled : $aiEnabled;

  let showKey = false;
  let testing = false;
  let testStatus = '';   // '' | 'ok' | 'fail'

  // Drafts for fields that have explicit Save buttons. Matching the
  // NutriTrace pattern: paste / type freely, then click Save to commit.
  // The draft is initialised from the store and re-synced when the
  // store changes (e.g. settings sync from another device).
  //
  // Sync via a guarded reactive that only fires when the STORE value
  // actually changes. The previous `$: draft = $store || draft` form
  // reran on every keystroke (because `draft` is one of its
  // dependencies) and silently overwrote the user's typing once a
  // value had been saved before, surfacing as "field is read-only"
  // for any user trying to update their key or base URL. (Issue #5.)
  let aiApiKeyDraft  = $aiApiKey  || '';
  let aiBaseUrlDraft = $aiBaseUrl || '';
  let aiKeySaved     = false;
  let aiBaseUrlSaved = false;
  let _aiApiKeySynced  = $aiApiKey;
  let _aiBaseUrlSynced = $aiBaseUrl;
  $: if ($aiApiKey !== _aiApiKeySynced) {
    _aiApiKeySynced = $aiApiKey;
    aiApiKeyDraft = $aiApiKey || '';
  }
  $: if ($aiBaseUrl !== _aiBaseUrlSynced) {
    _aiBaseUrlSynced = $aiBaseUrl;
    aiBaseUrlDraft = $aiBaseUrl || '';
  }

  // Save now also runs the connection test. If it succeeds the user
  // gets a toast + green check + the Trace FAB unlocks. If it fails
  // the toast tells them why and aiKeyVerified stays off. This
  // collapses the previous "Save then click Test separately" flow
  // into one action, and removes the dedicated Test row entirely.
  async function saveAiKey() {
    aiApiKey.set(aiApiKeyDraft);
    aiKeySaved = true;
    setTimeout(() => aiKeySaved = false, 2000);
    await testConnection({ silentOk: false });
  }
  async function saveAiBaseUrl() {
    aiBaseUrl.set(aiBaseUrlDraft.trim());
    aiBaseUrlSaved = true;
    setTimeout(() => aiBaseUrlSaved = false, 2000);
    await testConnection({ silentOk: false });
  }

  $: providerModels = AI_MODELS[$aiProvider] || [];

  // Escape hatch: branded providers' preset list includes an AI_MODEL_CUSTOM
  // sentinel. When the select shows the sentinel, a free-text input appears
  // so users can enter a model ID we haven't hardcoded (e.g. after a vendor
  // renames). $aiModel remains the source of truth persisted to the store.
  let aiModelSelectVal;
  let aiCustomModelVal = '';
  {
    const saved = $aiModel;
    const isPreset = providerModels.includes(saved) && saved !== AI_MODEL_CUSTOM;
    if (saved && !isPreset && $aiProvider !== 'custom') {
      aiModelSelectVal = AI_MODEL_CUSTOM;
      aiCustomModelVal = saved;
    } else {
      aiModelSelectVal = saved || AI_DEFAULT_MODELS[$aiProvider] || '';
    }
  }

  function _syncModelFromSelect() {
    if ($aiProvider === 'custom') return;
    const next = (aiModelSelectVal === AI_MODEL_CUSTOM)
      ? aiCustomModelVal.trim()
      : (aiModelSelectVal || '');
    aiModel.set(next);
    _invalidate();
  }
  function _modelLabel(m) {
    return m === AI_MODEL_CUSTOM ? 'Custom…' : m;
  }
  // Required fields the user must fill in for a meaningful test.
  $: canTest = !envLocks.ai
    && !!$aiApiKey?.trim()
    && !!$aiModel?.trim()
    && ($aiProvider !== 'custom' || !!$aiBaseUrl?.trim());

  // Any change to the auth fields invalidates the prior test result.
  // Clears aiKeyVerified so the FAB hides until the user retests.
  function _invalidate() {
    if ($aiKeyVerified) aiKeyVerified.set(false);
    testStatus = '';
  }

  // When the provider changes and the current model isn't valid for it,
  // snap to the provider's default. (User can still edit freely.)
  function onProviderChange(e) {
    const next = e.target.value;
    aiProvider.set(next);
    const valid = AI_MODELS[next] || [];
    if (next !== 'custom' && !valid.includes($aiModel)) {
      aiModel.set(AI_DEFAULT_MODELS[next] || '');
    }
    // Sync escape-hatch state so the select reflects the new provider
    if (next !== 'custom') {
      const saved = $aiModel;
      const isPreset = (AI_MODELS[next] || []).includes(saved) && saved !== AI_MODEL_CUSTOM;
      if (saved && !isPreset) {
        aiModelSelectVal = AI_MODEL_CUSTOM;
        aiCustomModelVal = saved;
      } else {
        aiModelSelectVal = saved;
        aiCustomModelVal = '';
      }
    }
    _invalidate();
  }

  async function testConnection({ silentOk = false } = {}) {
    if (!canTest && !envLocks.ai) {
      showError('Fill in provider, API key, and model first');
      return;
    }
    testing = true;
    testStatus = '';
    try {
      // The test must mirror how the rest of the app actually calls AI:
      //  - env-locked installs hit the server proxy (key on the server)
      //  - everyone else calls the provider DIRECTLY from the client
      //    using the GUI-entered key (matches aiChat.js callAI path)
      // The previous version always hit /api/ai/chat which 503'd with
      // "AI not configured on server" whenever AI_API_KEY env var wasn't
      // set, even though the user had pasted a working key in the form.
      const messages = [{ role: 'user', content: 'Say "hi" in one word.' }];
      const systemPrompt = 'You are a test bot. Reply with exactly one short word.';
      let text;
      if (envLocks.ai) {
        text = await callAIProxy({ messages, systemPrompt });
      } else {
        text = await callAI({
          provider:  $aiProvider,
          apiKey:    $aiApiKey,
          model:     $aiModel,
          baseUrl:   $aiBaseUrl,
          messages,
          systemPrompt,
        });
      }
      if (!text || typeof text !== 'string') {
        throw new Error('Empty response from AI');
      }
      testStatus = 'ok';
      aiKeyVerified.set(true);
      if (!silentOk) showSuccess('Trace AI connected — assistant is ready');
    } catch (e) {
      testStatus = 'fail';
      aiKeyVerified.set(false);
      showError(e.message || 'Test failed');
    } finally {
      testing = false;
    }
  }
</script>

<div class="card settings-card">
  {#if _displayedAiEnabled}
    {@const _provider = AI_PROVIDERS.find(p => p.id === $aiProvider)}
    {@const _label = envLocks.ai ? 'Environment-locked' :
      (_provider ? _provider.label : ($aiProvider || ''))}
    <ConnectionStatus
      status={testing ? 'testing' : ($aiKeyVerified || testStatus === 'ok' || (envLocks.ai && envLocks.ai_enabled) ? 'ok' : (testStatus === 'fail' ? 'fail' : ''))}
      connectedAs={_label}
      onRetest={() => testConnection()}
      retestDisabled={testing}
    />
  {/if}
  <div class="setting-row">
    <div>
      <span class="setting-label">Enable Trace Assistant</span>
      <span class="setting-desc">Floating chat button on every page. Uses your own AI provider key — never shared.</span>
    </div>
    <input type="checkbox" class="toggle-cb" checked={_displayedAiEnabled} on:change={e => { if (!envLocks.ai) aiEnabled.set(e.target.checked); }} disabled={envLocks.ai} />
  </div>

  {#if _displayedAiEnabled}
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">Provider</span>
      <div class="select-wrap expand-left" style="width:220px">
        <select class="select sel-sm" value={$aiProvider} on:change={onProviderChange} disabled={envLocks.ai}>
          {#each AI_PROVIDERS as p}
            <option value={p.id}>{p.label}</option>
          {/each}
        </select>
      </div>
    </div>

    {#if $aiProvider === 'custom'}
      <div class="setting-divider"></div>
      <div class="setting-row stack">
        <span class="setting-label">Base URL <span class="setting-desc">/v1/chat/completions endpoint</span></span>
        <div class="key-row">
          <input class="input" type="url" bind:value={aiBaseUrlDraft}
            placeholder="https://api.example.com/v1"
            on:input={_invalidate} />
          <button class="btn btn-primary save-btn" on:click={saveAiBaseUrl}>
            {#if aiBaseUrlSaved}<span class="material-symbols-rounded">check</span>{:else}Save{/if}
          </button>
        </div>
      </div>
    {/if}

    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">Model</span>
      {#if providerModels.length > 0 && $aiProvider !== 'custom'}
        <div class="select-wrap" style="width:220px">
          <select class="select sel-sm" bind:value={aiModelSelectVal} on:change={_syncModelFromSelect}>
            {#each providerModels as m}<option value={m}>{_modelLabel(m)}</option>{/each}
          </select>
        </div>
      {:else}
        <input class="input" type="text" style="width:220px" value={$aiModel}
          placeholder={AI_DEFAULT_MODELS[$aiProvider] || ''}
          on:change={e => { aiModel.set(e.target.value); _invalidate(); }} />
      {/if}
    </div>
    {#if aiModelSelectVal === AI_MODEL_CUSTOM && $aiProvider !== 'custom'}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">Custom Model ID</span>
        <input class="input" type="text" style="width:220px"
          placeholder={$aiProvider === 'gemini' ? 'gemini-3.5-flash' : $aiProvider === 'claude' ? 'claude-sonnet-5' : 'gpt-4o'}
          bind:value={aiCustomModelVal} on:input={_syncModelFromSelect} />
      </div>
      <div style="padding:8px 16px 12px;display:flex;gap:8px;align-items:flex-start">
        <span class="material-symbols-rounded" style="font-size:16px;color:var(--muted);flex-shrink:0;margin-top:2px">info</span>
        <div class="setting-desc" style="margin:0;line-height:1.5">
          Enter the exact model ID from the vendor (e.g.
          {#if $aiProvider === 'gemini'}<a href="https://ai.google.dev/gemini-api/docs/models" target="_blank" rel="noopener" class="about-link">Google's model list</a>
          {:else if $aiProvider === 'claude'}<a href="https://docs.anthropic.com/en/docs/about-claude/models/overview" target="_blank" rel="noopener" class="about-link">Anthropic's model list</a>
          {:else}<a href="https://platform.openai.com/docs/models" target="_blank" rel="noopener" class="about-link">OpenAI's model list</a>{/if}). Use this if the preset dropdown doesn't have the model you want.
        </div>
      </div>
    {/if}

    <div class="setting-divider"></div>
    <div class="setting-row stack">
      <span class="setting-label">API Key {envLocks.ai ? '(locked by env var)' : ''}</span>
      <div class="key-row">
        {#if showKey}
          <input class="input" type="text"
            bind:value={aiApiKeyDraft}
            placeholder={envLocks.ai ? '(set on server)' : 'sk-…'}
            disabled={envLocks.ai}
            on:input={_invalidate} />
        {:else}
          <input class="input" type="password"
            bind:value={aiApiKeyDraft}
            placeholder={envLocks.ai ? '(set on server)' : 'sk-…'}
            disabled={envLocks.ai}
            on:input={_invalidate} />
        {/if}
        <button class="key-toggle" on:click={() => showKey = !showKey}
          aria-label={showKey ? 'Hide' : 'Show'} disabled={envLocks.ai}>
          <span class="material-symbols-rounded">{showKey ? 'visibility_off' : 'visibility'}</span>
        </button>
        {#if !envLocks.ai}
          <button class="btn btn-primary save-btn" on:click={saveAiKey}>
            {#if aiKeySaved}<span class="material-symbols-rounded">check</span>{:else}Save{/if}
          </button>
        {/if}
      </div>
    </div>

    <div class="setting-divider"></div>
    <div class="setting-row stack">
      <span class="setting-label">Assistant Name</span>
      <input class="input" type="text" value={$aiAssistantName} placeholder="Trace"
        on:change={e => aiAssistantName.set(e.target.value || 'Trace')} />
    </div>

    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">Chef Hat</span>
        <span class="setting-desc">
          A small flourish for CookTrace — same Trace face, with a chef hat on top everywhere it appears.
        </span>
      </div>
      <input type="checkbox" class="toggle-cb"
        checked={$traceChefHat}
        on:change={e => traceChefHat.set(e.target.checked)} />
    </div>

    <!-- Smart Log: hold the FAB → dictate → AI parses + executes
         tools (add to shopping list, log a cook, mark out of stock,
         search recipes, etc.). Off by default; tap-to-dictate still
         works either way. -->
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">Smart Log</span>
        <span class="setting-desc">
          Hold the Trace button, speak what you cooked / bought / need, and let Trace add it for you. Examples: "I cooked the lasagna," "Add bananas to my shopping list," "I'm out of eggs," "Plan tacos for Friday." Tap-to-dictate (transcript only) still works when Smart Log is off.
        </span>
      </div>
      <input type="checkbox" class="toggle-cb"
        checked={$smartLogEnabled}
        on:change={e => smartLogEnabled.set(e.target.checked)} />
    </div>

    <!-- Status row — Save runs the test on each click, so this is a
         The connection status banner at the top of this card is the
         single source of truth for AI connection state — Re-test lives
         there. No separate row needed. -->
  {/if}
</div>

<style>
  .card.settings-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .setting-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
  }
  .setting-row.stack { flex-direction: column; align-items: stretch; gap: 8px; }
  .setting-row > div:first-child { flex: 1; min-width: 0; }
  .setting-label { font-size: 14px; color: var(--text-1); display: block; }
  .setting-desc { font-size: 12px; color: var(--text-3); margin-top: 4px; line-height: 1.4; display: block; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }

  .input {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 9px 12px;
    color: var(--text-1);
    font-size: 14px;
    font-family: inherit;
    box-sizing: border-box;
    width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .input:disabled { opacity: 0.6; cursor: not-allowed; }

  /* Keep all three children (input, eye-toggle, save) at the same
     height + vertically centered — the row was previously stretching
     the input and locking save to 40px which produced a 1–2px misalign. */
  .key-row { display: flex; gap: 6px; align-items: center; }
  .key-row > * { height: 40px; box-sizing: border-box; }
  .key-row .input { flex: 1; font-family: monospace; }
  .save-btn {
    font-size: 13px;
    white-space: nowrap;
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
  }
  .save-btn .material-symbols-rounded { font-size: 16px; }
  .key-toggle {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); width: 40px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; color: var(--text-3);
  }
  .key-toggle:hover:not(:disabled) { color: var(--text-1); }
  .key-toggle:disabled { opacity: 0.5; cursor: not-allowed; }

  .select-wrap { position: relative; display: inline-block; }
  .select-wrap::after {
    content: ''; position: absolute; right: 10px; top: 50%;
    transform: translateY(-25%) rotate(45deg);
    width: 7px; height: 7px;
    border-right: 2px solid var(--text-3); border-bottom: 2px solid var(--text-3);
    pointer-events: none;
  }
  .select {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 7px 28px 7px 10px;
    color: var(--text-1); font-size: 13px; width: 100%;
    appearance: none; -webkit-appearance: none; cursor: pointer;
  }
  .select:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .sel-sm { height: 36px; font-size: 13px; }

  /* expand-left: anchor the native dropdown to the right edge so it
     opens leftward instead of rightward. Useful when the select sits
     on the right side of a narrow panel and the longest option might
     otherwise spill past the panel. Pure CSS using direction:rtl on
     the select; option text is forced back to LTR + left-aligned so
     content reads normally. */
  .select-wrap.expand-left .select {
    direction: rtl;
    text-align: left;
  }
  .select-wrap.expand-left .select option {
    direction: ltr;
    text-align: left;
  }

  .toggle-cb {
    width: 40px; height: 24px;
    appearance: none; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 99px;
    position: relative; cursor: pointer;
    transition: background var(--dur-fast);
  }
  .toggle-cb::after {
    content: ''; position: absolute; top: 1px; left: 1px;
    width: 20px; height: 20px; background: var(--text-3); border-radius: 50%;
    transition: transform var(--dur-base) var(--ease-spring), background var(--dur-fast);
  }
  .toggle-cb:checked { background: var(--accent-dim); border-color: var(--accent); }
  .toggle-cb:checked::after { background: var(--accent); transform: translateX(16px); }
</style>
