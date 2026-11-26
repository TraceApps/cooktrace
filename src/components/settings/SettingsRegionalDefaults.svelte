<script>
  // Defaults for Everyone (cooktrace#93): the language, units, date and
  // time, and food search that anyone who hasn't chosen their own starts
  // with. Admins only (Settings > Users). Nothing is written into anyone's
  // settings: a person's own choice always wins, and a change here reaches
  // everyone who still hasn't chosen. "Each Device" leaves it to the
  // browser or phone. One set in the server's environment (DEFAULT_*)
  // shows here, locked.
  import { onMount } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { AVAILABLE_LOCALES } from '../../i18n/index.js';
  import { REGIONAL_OPTIONS } from '../../../server/lib/regional-options.js';
  import { applyInstanceDefaults } from '../../stores/settings.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { failed } from '../../lib/messages.js';
  import { isNative, getServerUrl, getAuthToken, apiUrl } from '../../lib/platform.js';

  let values = {};
  let locked = [];
  let loaded = false;
  let loadFailed = false;
  let busy = false;

  const langLabel = c => AVAILABLE_LOCALES.find(l => l.code === c)?.label || c;
  const countryKey = c => `settings_food_sources_ui.country_${c.toLowerCase().replace(/ /g, '_')}`;
  $: ROWS = [
    { key: 'language', label: $_('settings_page.regional.language'), opts: REGIONAL_OPTIONS.language.values.map(v => [v, langLabel(v)]) },
    { key: 'dateFormat', label: $_('settings_page.regional.date_format'), opts: [
      ['ISO', $_('settings_regional_ui.date_iso')], ['US', $_('settings_regional_ui.date_us')],
      ['EU', $_('settings_regional_ui.date_eu')], ['natural', $_('settings_page.regional.date_natural')]] },
    { key: 'timeFormat', label: $_('settings_page.regional.time_format'), opts: [
      ['12h', $_('settings_regional_ui.time_12h')], ['24h', $_('settings_regional_ui.time_24h')]] },
    { key: 'measurementSystem', label: $_('settings_page.regional.measurement_system'), opts: [
      ['imperial', $_('settings_page.regional.imperial')], ['metric', $_('settings_page.regional.metric')]] },
    { key: 'energyUnit', label: $_('settings_page.regional.energy'), opts: [
      ['kcal', $_('settings_regional_ui.energy_kcal')], ['kJ', $_('settings_regional_ui.energy_kj')]] },
    { key: 'offSearchLanguage', label: $_('settings_page.off.search_language'), opts: REGIONAL_OPTIONS.offSearchLanguage.values.map(v => [v, $_(`settings_food_sources_ui.lang_${v}`)]) },
    { key: 'offSearchCountry', label: $_('settings_page.off.search_country'), opts: REGIONAL_OPTIONS.offSearchCountry.values.map(v => [v, $_(countryKey(v))]) },
  ];

  function _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (isNative && getServerUrl()) {
      const t = getAuthToken();
      if (t) h['Authorization'] = `Bearer ${t}`;
    } else {
      const csrf = localStorage.getItem('ct:csrf');
      if (csrf) h['X-CSRF-Token'] = csrf;
    }
    return h;
  }

  function _take(body) {
    values = body?.values || {};
    locked = Array.isArray(body?.locked) ? body.locked : [];
    applyInstanceDefaults(values);
  }

  onMount(async () => {
    try {
      const res = await fetch(apiUrl('/api/app-config/defaults'), { credentials: 'include', headers: _headers() });
      if (!res.ok) throw new Error(String(res.status));
      _take(await res.json());
    } catch {
      // Offline or refused: say so, rather than rows that look unset and
      // unlocked (one the environment holds would be refused on save).
      loadFailed = true;
    }
    loaded = true;
  });

  async function save(key, value) {
    const before = values;
    values = { ...values };
    if (value) values[key] = value; else delete values[key];
    busy = true;
    try {
      const res = await fetch(apiUrl('/api/app-config/defaults'), {
        method: 'PUT', credentials: 'include', headers: _headers(),
        body: JSON.stringify({ values: { [key]: value || null } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `${res.status}`);
      _take(body);
      showSuccess($_('settings_defaults.saved'));
    } catch (e) {
      values = before;
      showError(failed('fail.save_defaults', e));
    } finally { busy = false; }
  }
</script>

<div class="setting-divider"></div>
<div class="setting-row defaults-head">
  <div>
    <span class="setting-label">{$_('settings_defaults.title')}</span>
    <div class="setting-desc">{$_('settings_defaults.desc')}</div>
  </div>
</div>
{#if loadFailed}
  <p class="setting-desc defaults-failed">{$_('settings_defaults.load_failed')}</p>
{:else if loaded}
  {#each ROWS as row}
    <div class="setting-row defaults-row">
      <div>
        <span class="setting-label">{row.label}</span>
        {#if locked.includes(row.key)}
          <div class="setting-desc">{$_('settings_defaults.locked', { values: { env: REGIONAL_OPTIONS[row.key].env } })}</div>
        {/if}
      </div>
      <div class="select-wrap">
        <select class="select sel-sm" value={values[row.key] || ''} disabled={busy || locked.includes(row.key)}
                aria-label={row.label} on:change={e => save(row.key, e.target.value)}>
          <option value="">{$_('settings_defaults.device_choice')}</option>
          {#each row.opts as [v, label]}<option value={v}>{label}</option>{/each}
        </select>
      </div>
    </div>
  {/each}
{/if}

<style>
  .defaults-head { padding-bottom: 4px; }
  .defaults-failed { padding: 0 16px 12px; }
  .defaults-row { padding-left: 28px; }
  .defaults-row .select-wrap { width: 170px; flex-shrink: 0; }
  .select:disabled { opacity: 0.6; cursor: default; }
  .sel-sm { height: 36px; font-size: 13px; }
  @media (max-width: 480px) {
    .defaults-row { padding-left: 16px; }
    .defaults-row .select-wrap { width: 160px; }
  }
</style>
