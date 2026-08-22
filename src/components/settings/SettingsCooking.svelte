<script>
  // Cooking section — extracted from Settings.svelte. Default servings,
  // auto-add-ingredients, show shared, url import engine + optional
  // fallback dropdown, shopping-list grouping + checked behavior.
  import { _ } from 'svelte-i18n';
  import { isNative, getServerUrl } from '../../lib/platform.js';
  import {
    defaultServings, autoCreatePantryFromRecipes, mixSharedIntoRecipes,
    urlImportEngine, urlImportFallback,
    shoppingGroupBy, shoppingCheckedBehavior,
    aiEnabled, aiKeyVerified,
  } from '../../stores/settings.js';

  // Enhanced engine (recipe-scrapers) needs the CookTrace server; smart
  // engine needs a verified AI key.
  $: enhancedAvailable = !isNative || !!getServerUrl();
  $: smartAvailable    = $aiEnabled && $aiKeyVerified;
</script>

<div class="section-body">
  <div class="card settings-card">
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.cooking.default_servings')}</span>
        <div class="setting-desc">Used when a new recipe doesn't specify how many it makes.</div>
      </div>
      <input type="number" min="1" max="20" class="input num" value={$defaultServings}
        on:change={(e) => defaultServings.set(parseInt(e.target.value, 10) || 2)} />
    </div>

    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">Auto-Add Ingredients to Pantry</span>
        <div class="setting-desc">When saving a recipe, automatically create Pantry rows for ingredient names that aren't linked yet. Off by default; turn on if you want your Pantry catalog to grow as you add or edit recipes. Manual links via the Pantry Link picker always work regardless.</div>
      </div>
      <input type="checkbox" class="toggle-cb" checked={$autoCreatePantryFromRecipes}
        on:change={e => autoCreatePantryFromRecipes.set(e.target.checked)} />
    </div>

    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.cooking.show_shared')}</span>
        <div class="setting-desc">When on, recipes shared with you (via a Kitchen or a direct grant) appear alongside your own on the Recipes tab. Each shared card keeps a "Shared by" badge plus a mint Kitchen chip so you can tell what's yours at a glance. Off by default; the Shared segment stays available either way.</div>
      </div>
      <input type="checkbox" class="toggle-cb" checked={$mixSharedIntoRecipes}
        on:change={e => mixSharedIntoRecipes.set(e.target.checked)} />
    </div>

    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.cooking.url_import_engine')}</span>
        <div class="setting-desc">
          {@html $_('settings_page.cooking.url_engine_desc_standard_html')}
          {@html $_('settings_page.cooking.url_engine_desc_enhanced_html')}
          {@html $_('settings_page.cooking.url_engine_desc_smart_html')}
        </div>
      </div>
      <div class="select-wrap" style="width:170px">
        <select class="select sel-sm" value={$urlImportEngine || 'standard'}
          on:change={e => urlImportEngine.set(e.target.value)}>
          <option value="standard">{$_('settings_page.cooking.engine_standard')}</option>
          <option value="enhanced" disabled={!enhancedAvailable}>
            {$_('settings_page.cooking.engine_enhanced')}{!enhancedAvailable ? $_('settings_page.cooking.engine_enhanced_server_suffix') : ''}
          </option>
          <option value="smart" disabled={!smartAvailable}>
            {$_('settings_page.cooking.engine_smart')}{!smartAvailable ? $_('settings_page.cooking.engine_smart_required_suffix') : ''}
          </option>
        </select>
      </div>
    </div>

    {#if ($urlImportEngine || 'standard') === 'smart'}
      <div class="setting-note">
        <span class="material-symbols-rounded">info</span>
        <span>{$_('settings_page.cooking.smart_note')}</span>
      </div>
    {/if}

    {#if ($urlImportEngine || 'standard') === 'enhanced'}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_page.cooking.enhanced_fallback')}</span>
          <div class="setting-desc">{$_('settings_page.cooking.enhanced_fallback_desc')}</div>
        </div>
        <div class="select-wrap" style="width:170px">
          <select class="select sel-sm" value={$urlImportFallback || 'standard'}
            on:change={e => urlImportFallback.set(e.target.value)}>
            <option value="standard">{$_('settings_page.cooking.engine_standard')}</option>
            <option value="smart" disabled={!smartAvailable}>
              {$_('settings_page.cooking.engine_smart')}{!smartAvailable ? $_('settings_page.cooking.engine_smart_required_suffix') : ''}
            </option>
          </select>
        </div>
      </div>
    {/if}

    <div class="setting-divider"></div>
    <div class="setting-subhead">{$_('settings_page.cooking.shopping_list')}</div>

    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.cooking.default_grouping')}</span>
        <div class="setting-desc">How the shopping list is grouped when it opens. By Aisle uses the per-item aisle (auto-populated from the linked pantry item's category); By Recipe keeps items with the recipe that added them; Flat is one uninterrupted list.</div>
      </div>
      <div class="select-wrap" style="width:170px">
        <select class="select sel-sm" value={$shoppingGroupBy || 'aisle'}
          on:change={e => shoppingGroupBy.set(e.target.value)}>
          <option value="aisle">{$_('settings_page.cooking.group_by_aisle')}</option>
          <option value="recipe">{$_('settings_page.cooking.group_by_recipe')}</option>
          <option value="flat">{$_('settings_page.cooking.group_by_flat')}</option>
        </select>
      </div>
    </div>

    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_page.cooking.checked_items')}</span>
        <div class="setting-desc">What happens to items after you check them off. Sink to bottom keeps them visible so you can uncheck by mistake; Hide removes them from view with a one-tap "Show Checked" toggle if you need them back.</div>
      </div>
      <div class="select-wrap" style="width:170px">
        <select class="select sel-sm" value={$shoppingCheckedBehavior || 'bottom'}
          on:change={e => shoppingCheckedBehavior.set(e.target.value)}>
          <option value="bottom">{$_('settings_page.cooking.sink_to_bottom')}</option>
          <option value="hide">{$_('settings_page.cooking.hide')}</option>
        </select>
      </div>
    </div>
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
  .input.num {
    width: 80px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    color: var(--text-1);
    text-align: right;
    font-size: 13px;
  }
  .setting-note {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin: 10px 0 0;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: var(--radius-sm);
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-2);
  }
  .setting-note :global(.material-symbols-rounded) {
    font-size: 18px;
    color: var(--accent);
    flex-shrink: 0;
    margin-top: 1px;
  }
  .setting-subhead {
    padding: 12px 16px 4px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
  }
</style>
