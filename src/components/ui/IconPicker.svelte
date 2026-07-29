<!--
  IconPicker — Material Symbols Rounded picker. Opens a sheet with a
  search input and a grid of icon previews; click one to select.

  Built around a curated list of food / household icons (the ones a
  pantry/recipe app actually wants) plus a free-text fallback so power
  users can type any Material Symbols name and use it as-is. The free-
  text input prevents the picker from being a hard wall when someone
  wants a niche icon that isn't on the curated list.

  Props:
    value (bindable) — selected icon name (Material Symbols Rounded)
    placeholder      — input placeholder
-->
<script>
  import { _ } from 'svelte-i18n';
  import { createEventDispatcher } from 'svelte';
  import Sheet from './Sheet.svelte';

  export let value = '';
  export let placeholder = 'Pick an icon';

  const dispatch = createEventDispatcher();

  // Curated icon catalog. Order ≈ usage frequency — food first, then
  // appliances/tools, then storage/household. Each entry can list a
  // few `keywords` so search lands on the icon even when the user
  // types a synonym ("fridge" → kitchen, "tea" → emoji_food_beverage).
  const ICONS = [
    // Produce / fresh
    { name: 'eco',                keywords: ['fresh', 'leaf', 'green', 'produce', 'plant'] },
    { name: 'nutrition',          keywords: ['health', 'fruit'] },
    { name: 'local_florist',      keywords: ['herb', 'flower'] },
    { name: 'agriculture',        keywords: ['farm', 'grain'] },
    { name: 'spa',                keywords: ['leaf', 'herb'] },
    { name: 'park',               keywords: ['tree'] },
    // Bread / bakery
    { name: 'bakery_dining',      keywords: ['bread', 'bakery', 'croissant'] },
    { name: 'cake',               keywords: ['dessert', 'baking'] },
    { name: 'cookie',             keywords: ['snack', 'sweet'] },
    { name: 'icecream',           keywords: ['frozen', 'dessert'] },
    { name: 'donut_large',        keywords: ['donut', 'sweet'] },
    // Meat / protein
    { name: 'lunch_dining',       keywords: ['burger', 'meat'] },
    { name: 'kebab_dining',       keywords: ['meat', 'skewer'] },
    { name: 'set_meal',           keywords: ['fish', 'seafood', 'sushi'] },
    { name: 'egg',                keywords: ['egg', 'dairy'] },
    // Dairy / liquid
    { name: 'water_drop',         keywords: ['liquid', 'drink'] },
    { name: 'local_drink',        keywords: ['drink', 'juice'] },
    { name: 'coffee',             keywords: ['coffee', 'beverage'] },
    { name: 'wine_bar',           keywords: ['wine', 'alcohol'] },
    { name: 'sports_bar',         keywords: ['beer', 'alcohol'] },
    { name: 'liquor',             keywords: ['alcohol', 'spirits'] },
    { name: 'free_breakfast',     keywords: ['tea', 'cup', 'coffee'] },
    { name: 'emoji_food_beverage',keywords: ['tea', 'drink'] },
    // Pantry staples
    { name: 'rice_bowl',          keywords: ['rice', 'grain'] },
    { name: 'ramen_dining',       keywords: ['noodles', 'pasta'] },
    { name: 'soup_kitchen',       keywords: ['soup', 'stock'] },
    { name: 'restaurant',         keywords: ['meal', 'dinner'] },
    { name: 'dinner_dining',      keywords: ['pasta', 'dinner'] },
    { name: 'tapas',              keywords: ['snack'] },
    { name: 'fastfood',           keywords: ['snack'] },
    { name: 'flatware',           keywords: ['utensils', 'silverware'] },
    // Spice / seasoning
    { name: 'whatshot',           keywords: ['spicy', 'hot'] },
    { name: 'grain',              keywords: ['grain', 'cereal', 'rice'] },
    // Appliances
    { name: 'kitchen',            keywords: ['fridge', 'refrigerator'] },
    { name: 'microwave',          keywords: ['microwave', 'appliance'] },
    { name: 'blender',            keywords: ['blender', 'appliance'] },
    { name: 'oven_gen',           keywords: ['oven', 'appliance'] },
    { name: 'coffee_maker',       keywords: ['coffee', 'appliance'] },
    // Cookware
    { name: 'outdoor_grill',      keywords: ['grill', 'bbq'] },
    { name: 'skillet',            keywords: ['pan', 'cookware'] },
    { name: 'cookie',             keywords: ['cookie'] },
    { name: 'cake',               keywords: ['cake'] },
    // Storage / household
    { name: 'inventory_2',        keywords: ['storage', 'box'] },
    { name: 'shopping_basket',    keywords: ['basket'] },
    { name: 'shopping_bag',       keywords: ['bag'] },
    { name: 'shopping_cart',      keywords: ['cart'] },
    { name: 'ac_unit',            keywords: ['frozen', 'freezer', 'ice'] },
    { name: 'thermostat',         keywords: ['temperature', 'cold'] },
    { name: 'medication',         keywords: ['pill', 'supplement'] },
    // Cleaning / paper / non-food
    { name: 'soap',               keywords: ['cleaning', 'household'] },
    { name: 'cleaning_services',  keywords: ['cleaning'] },
    { name: 'cleaning_bucket',    keywords: ['cleaning', 'bucket'] },
    { name: 'wash',               keywords: ['laundry', 'detergent'] },
    { name: 'recycling',          keywords: ['recycle'] },
    // Catch-alls / decorative
    { name: 'star',               keywords: ['favorite'] },
    { name: 'bookmark',           keywords: ['bookmark'] },
    { name: 'category',           keywords: ['category', 'misc'] },
    { name: 'label',              keywords: ['tag'] },
  ];
  // Dedupe (a few entries above appear twice with different keywords).
  const SEEN = new Set();
  const CATALOG = ICONS.filter(i => { if (SEEN.has(i.name)) return false; SEEN.add(i.name); return true; });

  let open = false;
  let query = '';
  let customName = '';

  $: filtered = (() => {
    const q = query.trim().toLowerCase();
    if (!q) return CATALOG;
    return CATALOG.filter(i =>
      i.name.includes(q) || i.keywords.some(k => k.includes(q))
    );
  })();

  function pick(name) {
    value = name;
    dispatch('select', name);
    open = false;
  }
  function applyCustom() {
    const n = customName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!n) return;
    pick(n);
    customName = '';
  }
  function clear() {
    value = '';
    dispatch('select', '');
    open = false;
  }
</script>

<button type="button" class="picker-trigger" on:click={() => { open = true; query = ''; }}>
  <span class="material-symbols-rounded preview">{value || 'category'}</span>
  <span class="label">{value || placeholder}</span>
  <span class="material-symbols-rounded chev">arrow_drop_down</span>
</button>

{#if open}
  <Sheet bind:open title="Pick an Icon">
    <div class="picker-body">
      <input class="input" type="search" placeholder="Search icons…" bind:value={query} autofocus />

      {#if filtered.length === 0}
        <p class="empty">No matches in the curated list.</p>
      {:else}
        <div class="grid">
          {#each filtered as i (i.name)}
            <button type="button" class="cell" class:active={value === i.name}
              on:click={() => pick(i.name)}
              title={i.name}>
              <span class="material-symbols-rounded">{i.name}</span>
              <span class="cell-name">{i.name}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- Free-text fallback — for any Material Symbol not on the curated
           list. Lower-priority placement so the curated grid stays the
           default path. -->
      <details class="custom">
        <summary>{$_('icon_picker_ct.summary')}</summary>
        <div class="custom-row">
          <input class="input" type="text" placeholder="e.g. dining"
            bind:value={customName}
            on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyCustom(); } }} />
          {#if customName.trim()}
            <span class="material-symbols-rounded preview-custom">{customName.trim()}</span>
          {/if}
          <button class="btn btn-secondary tiny" type="button" on:click={applyCustom} disabled={!customName.trim()}>Use</button>
        </div>
        <p class="hint">
          Browse the full set at <a href="https://fonts.google.com/icons" target="_blank" rel="noopener noreferrer">fonts.google.com/icons</a>.
        </p>
      </details>

      <div class="footer-row">
        <button class="btn btn-secondary" type="button" on:click={clear}>{$_('icon_picker_ct.clear')}</button>
      </div>
    </div>
  </Sheet>
{/if}

<style>
  .picker-trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px 7px 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    font-size: 14px;
    cursor: pointer;
    min-width: 0;
    transition: border-color var(--dur-fast), background var(--dur-fast);
  }
  .picker-trigger:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .picker-trigger .preview { color: var(--accent); font-size: 22px; flex-shrink: 0; }
  .picker-trigger .label {
    flex: 1;
    text-align: left;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-2);
  }
  .picker-trigger .chev { color: var(--text-3); font-size: 20px; flex-shrink: 0; }

  .picker-body { display: flex; flex-direction: column; gap: 14px; }
  .input {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 9px 12px;
    color: var(--text-1);
    font-size: 14px;
    width: 100%;
    box-sizing: border-box;
  }
  .empty { color: var(--text-3); font-size: 13px; padding: 24px 0; text-align: center; margin: 0; font-style: italic; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
    gap: 6px;
    max-height: 360px;
    overflow-y: auto;
    padding: 2px;
  }
  .cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 10px 6px 8px;
    background: var(--surface-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--text-1);
    transition: background var(--dur-fast), border-color var(--dur-fast), color var(--dur-fast);
    min-width: 0;
  }
  .cell:hover {
    background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }
  .cell.active {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--accent);
  }
  .cell .material-symbols-rounded { font-size: 26px; color: var(--accent); }
  .cell.active .material-symbols-rounded { color: var(--accent); }
  .cell-name {
    font-size: 9px;
    font-weight: 600;
    color: var(--text-3);
    line-height: 1.2;
    text-align: center;
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cell.active .cell-name { color: var(--accent); }

  .custom { border-top: 1px solid var(--border); padding-top: 12px; font-size: 13px; }
  .custom summary { color: var(--text-2); cursor: pointer; padding: 4px 0; font-weight: 600; }
  .custom-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }
  .custom-row .input { flex: 1; }
  .preview-custom { color: var(--accent); font-size: 22px; }
  .hint { color: var(--text-3); font-size: 12px; margin: 8px 0 0; }
  .hint a { color: var(--accent); }

  .footer-row { display: flex; justify-content: flex-end; }

  .btn {
    border: 1px solid transparent; padding: 8px 14px;
    border-radius: var(--radius-sm); cursor: pointer;
    font-size: 14px; font-weight: 600;
  }
  .btn-secondary {
    background: var(--surface-2); color: var(--text-1);
    border-color: var(--border);
  }
  .btn-secondary:hover { background: color-mix(in srgb, var(--text-1) 8%, var(--surface-2)); }
  .btn.tiny { padding: 6px 10px; font-size: 12px; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
