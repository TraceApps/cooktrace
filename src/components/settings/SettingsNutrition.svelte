<script>
  import { _ } from 'svelte-i18n';
  import { NUTRIMENTS, DEFAULT_VISIBLE_NUTRIMENT_IDS, CUSTOM_NUTRIENT_UNITS, customNutrientId } from '../../lib/nutriments.js';
  import { visibleNutriments, customNutriments } from '../../stores/settings.js';
  import Sheet from '../ui/Sheet.svelte';

  // Effective set: user choice if any, else NT-style defaults.
  $: effectiveSet = new Set(
    Array.isArray($visibleNutriments) && $visibleNutriments.length > 0
      ? $visibleNutriments
      : DEFAULT_VISIBLE_NUTRIMENT_IDS
  );

  function toggle(id) {
    const next = new Set(effectiveSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    visibleNutriments.set([...next]);
  }
  function resetToDefaults() {
    visibleNutriments.set(null); // null → fall back to defaults
  }
  function showAll() {
    visibleNutriments.set(NUTRIMENTS.map(n => n.id));
  }

  // ── Custom nutrients (same flow as NutriTrace: a name and a unit) ──────
  let sheetOpen = false;
  let newLabel = '';
  let newUnit = 'g';

  function addCustom() {
    const label = newLabel.trim();
    if (!label) return;
    const id = customNutrientId(label);
    const list = $customNutriments || [];
    if (!list.some(n => n.id === id)) customNutriments.set([...list, { id, label, unit: newUnit }]);
    newLabel = '';
    newUnit = 'g';
    sheetOpen = false;
  }
  function removeCustom(id) {
    customNutriments.set(($customNutriments || []).filter(n => n.id !== id));
  }

  // Group for the UI.
  const CATEGORY_LABELS = {
    energy:  'settings_page.regional.energy',
    macro:   'settings_nutrition_ui.cat_macro',
    mineral: 'settings_nutrition_ui.cat_mineral',
    vitamin: 'settings_nutrition_ui.cat_vitamin',
    other:   'settings_nutrition_ui.cat_other',
  };
  $: groups = Object.entries(CATEGORY_LABELS).map(([cat, key]) => ({
    label: $_(key),
    items: NUTRIMENTS.filter(n => n.category === cat),
  })).filter(g => g.items.length > 0);
</script>

<div class="setting-card">
  <div class="setting-row stack">
    <div>
      <span class="setting-label">{$_('settings_nutrition_ct.visibility')}</span>
      <span class="setting-desc">{$_('settings_nutrition_ui.visibility_desc')}</span>
    </div>
    <div class="actions-row">
      <button class="seg" on:click={resetToDefaults}>{$_('settings_nutrition_ct.defaults')}</button>
      <button class="seg" on:click={showAll}>{$_('settings_nutrition_ct.show_all')}</button>
    </div>
  </div>

  {#each groups as group}
    <div class="nut-group">
      <p class="nut-group-label">{group.label}</p>
      <div class="nut-grid">
        {#each group.items as nut}
          <label class="nut-check" class:checked={effectiveSet.has(nut.id)}>
            <input
              type="checkbox"
              checked={effectiveSet.has(nut.id)}
              on:change={() => toggle(nut.id)}
            />
            <span class="nut-name">{nut.label}</span>
            <span class="nut-unit">{nut.unit}</span>
          </label>
        {/each}
      </div>
    </div>
  {/each}

  <div class="nut-group">
    <p class="nut-group-label">{$_('settings_nutrition_ui.custom_heading')}</p>
    <p class="setting-desc custom-desc">{$_('settings_nutrition_ui.custom_desc')}</p>
    {#each ($customNutriments || []) as cn (cn.id)}
      <div class="custom-row">
        <span class="nut-name">{cn.label}</span>
        <span class="nut-unit">{cn.unit}</span>
        <button type="button" class="custom-remove" title={$_('settings_nutrition_ui.custom_remove')}
          aria-label={$_('settings_nutrition_ui.custom_remove')} on:click={() => removeCustom(cn.id)}>
          <span class="material-symbols-rounded">delete</span>
        </button>
      </div>
    {:else}
      <p class="setting-desc">{$_('settings_nutrition_ui.custom_empty')}</p>
    {/each}
    <button type="button" class="seg custom-add" on:click={() => sheetOpen = true}>
      <span class="material-symbols-rounded">add</span>
      {$_('settings_nutrition_ui.custom_add')}
    </button>
  </div>
</div>

<Sheet bind:open={sheetOpen} title={$_('settings_nutrition_ui.custom_sheet_title')}>
  <div class="custom-form">
    <label class="custom-field">
      <span class="setting-label">{$_('settings_nutrition_ui.custom_name')}</span>
      <input class="input" placeholder={$_('settings_nutrition_ui.custom_name_placeholder')} bind:value={newLabel}
        on:keydown={(e) => e.key === 'Enter' && addCustom()} />
    </label>
    <label class="custom-field">
      <span class="setting-label">{$_('settings_nutrition_ui.custom_unit')}</span>
      <select class="input" bind:value={newUnit}>
        {#each CUSTOM_NUTRIENT_UNITS as u}<option value={u}>{u}</option>{/each}
      </select>
    </label>
    <button type="button" class="btn btn-primary" disabled={!newLabel.trim()} on:click={addCustom}>
      {$_('settings_nutrition_ui.custom_confirm')}
    </button>
  </div>
</Sheet>

<style>
  .setting-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 14px 16px;
  }
  .setting-row.stack {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 14px;
  }
  .setting-label { font-size: 14px; font-weight: 600; color: var(--text-1); display: block; }
  .setting-desc { font-size: 12px; color: var(--text-3); display: block; margin-top: 4px; line-height: 1.4; }
  .actions-row { display: flex; gap: 8px; }
  .seg {
    background: var(--surface-2);
    color: var(--text-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .seg:hover { color: var(--text-1); }

  .nut-group { margin-top: 10px; }
  .nut-group-label {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
  }
  .nut-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 4px;
  }
  .nut-check {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    background: transparent;
    transition: background var(--dur-fast);
    font-size: 13px;
  }
  .nut-check:hover { background: var(--surface-2); }
  .nut-check.checked { background: var(--accent-dim); }
  .nut-check input { width: 16px; height: 16px; accent-color: var(--accent); }
  .nut-name { flex: 1; color: var(--text-1); }
  .nut-check.checked .nut-name { color: var(--accent); font-weight: 600; }
  .custom-desc { margin: 0 0 8px; }
  .custom-row {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 10px; border-radius: var(--radius-sm); font-size: 13px;
  }
  .custom-row:hover { background: var(--surface-2); }
  .custom-remove {
    background: none; border: 0; cursor: pointer; color: var(--danger);
    width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm);
  }
  .custom-remove .material-symbols-rounded { font-size: 18px; }
  .custom-add { display: inline-flex; align-items: center; gap: 4px; margin-top: 8px; }
  .custom-add .material-symbols-rounded { font-size: 18px; }
  .custom-form { display: flex; flex-direction: column; gap: 16px; padding-top: 8px; }
  .custom-field { display: flex; flex-direction: column; gap: 6px; }
  .nut-unit {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: var(--text-3);
  }
</style>
