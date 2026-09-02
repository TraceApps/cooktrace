<script>
  // Food Sources section — extracted from Settings.svelte. Houses the
  // Pantry Search default-source picker, the Open Food Facts block
  // (toggle + language + country + upload + optional account creds),
  // the USDA block (toggle + API key), and the Barcode Scanner block
  // (beep + web-only flashlight override).
  import { _ } from 'svelte-i18n';
  import { isNative } from '../../lib/platform.js';
  import {
    offEnabled, offSearchLanguage, offSearchCountry, offUploadCountry,
    offUsername, offPassword,
    usdaEnabled, usdaApiKey,
    barcodeBeep, barcodeFlashlight,
    pantryDefaultSource,
  } from '../../stores/settings.js';

  const OFF_LANGUAGE_OPTS = [
    ['en','English'],['fr','French'],['de','German'],['es','Spanish'],['it','Italian'],
    ['pt','Portuguese'],['nl','Dutch'],['pl','Polish'],['ru','Russian'],['ja','Japanese'],
    ['zh','Chinese'],['ar','Arabic'],['ko','Korean'],
  ];
  const OFF_COUNTRY_OPTS = ['World',
    'Argentina','Australia','Austria','Belgium','Brazil','Canada','Chile','China',
    'Denmark','Finland','France','Germany','India','Ireland','Italy','Japan',
    'Mexico','Netherlands','New Zealand','Norway','Poland','Portugal','Singapore',
    'South Africa','South Korea','Spain','Sweden','Switzerland','United Kingdom',
    'United States'];
  let offShowPass = false;
</script>

<div class="section-body">
  <p class="sub-label">{$_('settings_page.pantry_search.section')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.pantry_search.default_source')}</span>
        <div class="setting-desc">{$_('settings_page.pantry_search.default_source_desc')}</div>
      </div>
      <div class="select-wrap" style="width:160px">
        <select class="select sel-sm" value={$pantryDefaultSource} on:change={e => pantryDefaultSource.set(e.target.value)}>
          <option value="all">{$_('settings_page.pantry_search.source_all')}</option>
          <option value="local">{$_('settings_page.pantry_search.source_local')}</option>
          {#if $offEnabled}<option value="off">OFF</option>{/if}
          {#if $usdaEnabled}<option value="usda">USDA</option>{/if}
        </select>
      </div>
    </div>
  </div>
  <p class="sub-label">{$_('settings_page.off.section')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.off.enable')}</span>
        <div class="setting-desc">
          Look up barcodes against the global crowd-sourced food database. No account needed for lookups; one is only required to upload edits via Share to OFF.
        </div>
      </div>
      <input type="checkbox" class="toggle-cb" checked={$offEnabled} on:change={e => offEnabled.set(e.target.checked)} />
    </div>
    {#if $offEnabled}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">{$_('settings_page.off.search_language')}</span>
        <div class="select-wrap" style="width:120px">
          <select class="select sel-sm" value={$offSearchLanguage} on:change={e => offSearchLanguage.set(e.target.value)}>
            {#each OFF_LANGUAGE_OPTS as [v,l]}<option value={v}>{l}</option>{/each}
          </select>
        </div>
      </div>
      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">{$_('settings_page.off.search_country')}</span>
        <div class="select-wrap" style="width:150px">
          <select class="select sel-sm" value={$offSearchCountry} on:change={e => offSearchCountry.set(e.target.value)}>
            {#each OFF_COUNTRY_OPTS as c}<option value={c}>{c}</option>{/each}
          </select>
        </div>
      </div>
      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">{$_('settings_page.off.upload_country')}</span>
        <div class="select-wrap" style="width:150px">
          <select class="select sel-sm" value={$offUploadCountry} on:change={e => offUploadCountry.set(e.target.value)}>
            <option value="Auto">{$_('settings_page.off.auto')}</option>
            {#each OFF_COUNTRY_OPTS.filter(c => c !== 'World') as c}<option value={c}>{c}</option>{/each}
          </select>
        </div>
      </div>
      <div class="setting-divider"></div>
      <div class="form-block">
        <label class="form-label">{$_('settings_page.off.account_username')}</label>
        <p class="hint">Optional — only needed to upload edits.
          <a href="https://world.openfoodfacts.org/cgi/user.pl" target="_blank" rel="noopener" class="link">Create an OFF account →</a>
        </p>
        <input class="input" type="text" placeholder={$_('settings_page.off.off_username_ph')} value={$offUsername}
          on:change={e => offUsername.set(e.target.value)} />
        <label class="form-label">{$_('settings_page.off.account_password')}</label>
        <div style="display:flex;gap:8px;align-items:center">
          {#if offShowPass}
            <input class="input" type="text" style="flex:1" placeholder={$_('settings_page.off.off_password_ph')}
              value={$offPassword} on:change={e => offPassword.set(e.target.value)} />
          {:else}
            <input class="input" type="password" style="flex:1" placeholder={$_('settings_page.off.off_password_ph')}
              value={$offPassword} on:change={e => offPassword.set(e.target.value)} />
          {/if}
          <button class="btn-icon" on:click={() => offShowPass = !offShowPass}
            title={offShowPass ? 'Hide' : 'Show'} aria-label="Toggle password visibility">
            <span class="material-symbols-rounded">{offShowPass ? 'visibility_off' : 'visibility'}</span>
          </button>
        </div>
      </div>
    {/if}
  </div>

  <p class="sub-label">{$_('settings_page.usda.section')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.usda.enable')}</span>
        <div class="setting-desc">
          Search the USDA nutrition database when adding pantry items.
          <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener" class="link">Get a free API key →</a>
        </div>
      </div>
      <input type="checkbox" class="toggle-cb" checked={$usdaEnabled} on:change={e => usdaEnabled.set(e.target.checked)} />
    </div>
    {#if $usdaEnabled}
      <div class="setting-divider"></div>
      <div class="form-block">
        <label class="form-label">{$_('settings_page.usda.api_key')}</label>
        <input class="input" type="text" placeholder={$_('settings_page.usda.api_key_ph')}
          value={$usdaApiKey} on:change={e => usdaApiKey.set(e.target.value)} />
      </div>
    {/if}
  </div>

  <p class="sub-label">{$_('settings_page.scanner.section')}</p>
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.scanner.beep_on_scan')}</span>
        <div class="setting-desc">Short audio confirmation when a barcode is recognized.</div>
      </div>
      <input type="checkbox" class="toggle-cb" checked={$barcodeBeep} on:change={e => barcodeBeep.set(e.target.checked)} />
    </div>
    {#if !isNative}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">Auto-Enable Flashlight</span>
          <div class="setting-desc">Turn on the rear-camera flashlight automatically when the scanner opens (web only — native uses the OS camera UI's own controls).</div>
        </div>
        <input type="checkbox" class="toggle-cb" checked={$barcodeFlashlight} on:change={e => barcodeFlashlight.set(e.target.checked)} />
      </div>
    {/if}
  </div>
</div>

<style>
  .select-wrap { position: relative; display: inline-block; }
  .select-wrap::after {
    content: '';
    position: absolute;
    right: 10px; top: 50%;
    transform: translateY(-25%) rotate(45deg);
    width: 7px; height: 7px;
    border-right: 2px solid var(--text-3);
    border-bottom: 2px solid var(--text-3);
    pointer-events: none;
  }
  .select {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 7px 28px 7px 10px;
    color: var(--text-1);
    font-size: 13px;
    width: 100%;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
  }
  .select:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .sel-sm { height: 36px; font-size: 13px; }
  .toggle-cb {
    width: 40px; height: 24px;
    appearance: none;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 99px;
    position: relative;
    cursor: pointer;
    transition: background var(--dur-fast);
  }
  .toggle-cb::after {
    content: '';
    position: absolute;
    top: 1px; left: 1px;
    width: 20px; height: 20px;
    background: var(--text-3);
    border-radius: 50%;
    transition: transform var(--dur-base) var(--ease-spring), background var(--dur-fast);
  }
  .toggle-cb:checked { background: var(--accent-dim); border-color: var(--accent); }
  .toggle-cb:checked::after { background: var(--accent); transform: translateX(16px); }
  .form-block { padding: 12px 16px 14px; display: flex; flex-direction: column; gap: 8px; }
  .form-block .form-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--text-3);
    margin-top: 4px;
  }
  .form-block .hint { font-size: 12px; color: var(--text-3); margin: 0 0 4px; line-height: 1.4; }
  .form-block .link { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  .form-block .input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px;
    color: var(--text-1); font-size: 14px;
    width: 100%; box-sizing: border-box;
  }
  .form-block .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
</style>
