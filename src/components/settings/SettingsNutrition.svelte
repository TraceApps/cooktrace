<script>
  import { _ } from 'svelte-i18n';
  import { NUTRIMENTS, DEFAULT_VISIBLE_NUTRIMENT_IDS } from '../../lib/nutriments.js';
  import { visibleNutriments } from '../../stores/settings.js';

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

  // Group for the UI.
  const CATEGORY_LABELS = {
    energy:  'Energy',
    macro:   'Macros',
    mineral: 'Minerals',
    vitamin: 'Vitamins',
    other:   'Other',
  };
  $: groups = Object.entries(CATEGORY_LABELS).map(([cat, label]) => ({
    label,
    items: NUTRIMENTS.filter(n => n.category === cat),
  })).filter(g => g.items.length > 0);
</script>

<div class="setting-card">
  <div class="setting-row stack">
    <div>
      <span class="setting-label">{$_('settings_nutrition_ct.visibility')}</span>
      <span class="setting-desc">Pick which nutrients show up in the Nutrition Facts box on every recipe. Hidden nutrients can still be entered in the editor but won't display.</span>
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
</div>

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
  .nut-unit {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: var(--text-3);
  }
</style>
