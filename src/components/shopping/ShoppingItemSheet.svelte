<!--
  ShoppingItemSheet: one list item in full. What's on the list, what the
  pantry has, which planned cooks need it (on which day, how much), the
  kinds the pantry keeps of it, a size hint, and a note.

  Props:
    open (bindable)
    item: the list row (a merged row carries `members`)
    recipes: Map of recipe id to recipe (names, photos)
    pantry: the pantry rows
  Events: check (item), note ({ item, notes }), close
-->
<script>
  import { createEventDispatcher } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { _, locale } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import { displayQty, ingredientKey, unitFamily, convertQty, sumAmounts, roundForList } from '../../lib/quantity.js';
  import { parseSources } from '../../lib/shopping-plan.js';
  import { lookupCommonDensity } from '../../lib/recipe-nutrition.js';
  import { fromIso } from '../../lib/week.js';

  export let open = false;
  export let item = null;
  export let recipes = new Map();
  export let pantry = [];

  const dispatch = createEventDispatcher();

  const amount = (qty, unit) => {
    const q = displayQty(qty, unit);
    return [q, q && unit ? unit : (q ? '' : unit || '')].filter(Boolean).join(' ');
  };

  $: members = item ? (item.members || [item]) : [];
  $: sources = members.flatMap(m => parseSources(m.sources));
  // The pantry item it's for: its link, else one of the same name.
  $: pantryItem = (() => {
    if (!item) return null;
    const linked = members.map(m => m.pantry_id).find(id => id != null);
    if (linked != null) return pantry.find(p => p.id === linked) || null;
    const key = ingredientKey(item.name);
    return pantry.find(p => p.generic_parent_id == null && ingredientKey(p.name) === key) || null;
  })();
  // A generic item's variants, or a variant's siblings: the kinds bought.
  $: kinds = (() => {
    if (!pantryItem) return [];
    const parent = pantryItem.generic_parent_id ?? pantryItem.id;
    return pantry.filter(p => p.generic_parent_id === parent && p.id !== pantryItem.id).map(p => p.name);
  })();
  $: stock = (() => {
    if (!pantryItem) return null;
    const variantsIn = pantry.filter(p => p.generic_parent_id === pantryItem.id && p.in_stock);
    const inStock = !!pantryItem.in_stock || variantsIn.length > 0;
    return {
      inStock,
      amount: pantryItem.quantity != null ? amount(pantryItem.quantity, pantryItem.unit) : '',
      expires: pantryItem.expires_on ? String(pantryItem.expires_on).slice(0, 10) : null,
    };
  })();
  $: soon = stock?.expires && stock.expires <= _inDays(3);
  function _inDays(n) {
    const d = new Date(); d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  $: total = item ? amount(item.quantity, item.unit) : '';
  // About how much one is, or how much the amount weighs.
  $: sizeHint = (() => {
    if (!item) return '';
    const fam = unitFamily(item.unit);
    if ((!fam || fam === 'count') && pantryItem?.serving_size && unitFamily(pantryItem.serving_unit) === 'weight') {
      return $_('shopping_item.size_piece', { values: { amount: amount(pantryItem.serving_size, pantryItem.serving_unit) } });
    }
    if (fam === 'volume' && item.quantity != null) {
      const density = pantryItem?.g_per_cup || lookupCommonDensity(item.name);
      const grams = convertQty(Number(item.quantity), item.unit, 'g', density);
      if (grams) return $_('shopping_item.size_weight', { values: { amount: total, grams: Math.round(grams) } });
    }
    return '';
  })();
  // Each cook's line, with its day and its recipe.
  $: cookRows = sources.map(s => {
    const r = s.recipe_id != null ? recipes.get(s.recipe_id) : null;
    return {
      key: `${s.diary_id}|${s.recipe_id}|${s.ref}`,
      recipeId: r ? r.id : null,
      name: r?.name || s.name,
      img: r?.imgUrl || (r?.img_url ? resolveAssetUrl(r.img_url) : ''),
      day: s.date ? fromIso(s.date).toLocaleDateString($locale || undefined, { weekday: 'short' }) : $_('shopping_item.recipe'),
      amount: s.qty != null ? amount(roundForList(s.qty, s.unit), s.unit) : $_('shopping_item.as_needed'),
    };
  });
  // What the cooks need together, against what the list says.
  $: cooksTotal = (() => {
    const t = sumAmounts(sources.filter(s => s.qty != null).map(s => ({ qty: s.qty, unit: s.unit })));
    return t.qty != null ? amount(roundForList(t.qty, t.unit), t.unit) : '';
  })();

  let note = '';
  let noteFor = null;
  $: if (item && noteFor !== item.id) { noteFor = item.id; note = members[0]?.notes || ''; }
  function saveNote() {
    if (!item) return;
    const next = note.trim();
    if (next === (members[0]?.notes || '')) return;
    dispatch('note', { item, notes: next });
  }
  function close() { saveNote(); open = false; dispatch('close'); }
</script>

<Sheet bind:open title={item?.name || ''} on:close={close}>
  {#if item}
    <div class="item-sheet">
      <div class="col">
        <div class="tiles">
          <div class="tile">
            <span class="tile-label">{$_('shopping_item.on_list')}</span>
            <span class="tile-value">{total || $_('shopping_item.no_amount')}</span>
            {#if cooksTotal && sources.length > 1}<span class="tile-sub">{$_('shopping_item.for_n_cooks', { values: { n: new Set(sources.map(s => s.diary_id ?? s.recipe_id)).size } })}</span>{/if}
          </div>
          <div class="tile" class:have={stock?.inStock}>
            <span class="tile-label">{$_('shopping_item.in_pantry')}</span>
            <span class="tile-value">
              {#if !pantryItem}{$_('shopping_item.not_tracked')}
              {:else if stock.inStock}{stock.amount || $_('shopping_item.in_stock')}
              {:else}{$_('shopping_item.out_of_stock')}{/if}
            </span>
            {#if stock?.expires}<span class="tile-sub" class:soon>{$_('shopping_item.use_by', { values: { date: fromIso(stock.expires).toLocaleDateString($locale || undefined, { month: 'short', day: 'numeric' }) } })}</span>{/if}
          </div>
        </div>

        {#if cookRows.length}
          <section class="block">
            <h4>{$_('shopping_item.for_these_cooks')}</h4>
            <ul class="cooks">
              {#each cookRows as c (c.key)}
                <li>
                  <button class="cook" on:click={() => { if (c.recipeId != null) { close(); push(`/recipes/${c.recipeId}`); } }} disabled={c.recipeId == null}>
                    {#if c.img}<img src={c.img} alt="" loading="lazy" />{:else}<span class="ph material-symbols-rounded" aria-hidden="true">restaurant</span>{/if}
                    <span class="cook-name">{c.name}</span>
                    <span class="day">{c.day}</span>
                    <span class="cook-amount">{c.amount}</span>
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      </div>

      <div class="col">
        {#if kinds.length || sizeHint}
          <section class="block panel">
            {#if kinds.length}
              <div class="kinds">
                <span class="muted">{$_('shopping_item.kinds')}</span>
                {#each kinds as k}<span class="kind">{k}</span>{/each}
              </div>
            {/if}
            {#if sizeHint}
              <p class="hint"><span class="material-symbols-rounded" aria-hidden="true">scale</span>{sizeHint}</p>
            {/if}
          </section>
        {/if}

        <label class="block note">
          <span class="label">{$_('shopping_item.note')}</span>
          <input class="input" type="text" maxlength="500" placeholder={$_('shopping_item.note_placeholder')}
            bind:value={note} on:change={saveNote} on:blur={saveNote} />
        </label>

        <div class="actions">
          {#if pantryItem}
            <button class="btn btn-secondary" on:click={() => { close(); push(`/pantry/${pantryItem.id}`); }}>
              <span class="material-symbols-rounded" aria-hidden="true">kitchen</span>{$_('shopping_item.open_pantry')}
            </button>
          {/if}
          <button class="btn btn-primary" on:click={() => { saveNote(); dispatch('check', item); open = false; }}>
            <span class="material-symbols-rounded" aria-hidden="true">{item.checked ? 'undo' : 'check'}</span>
            {item.checked ? $_('shopping_item.uncheck') : $_('shopping_item.check_off')}
          </button>
        </div>
      </div>
    </div>
  {/if}
</Sheet>

<style>
  .item-sheet { display: flex; flex-direction: column; gap: 14px; padding-bottom: 8px; }
  .col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .tile { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); min-width: 0; }
  .tile-label { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); }
  .tile-value { font-size: 18px; font-weight: 800; color: var(--text-1); }
  .tile-sub { font-size: 12px; color: var(--text-2); }
  .tile-sub.soon { color: var(--warning); font-weight: 600; }
  .tile.have { background: var(--accent-dim); }
  .tile.have .tile-label, .tile.have .tile-value { color: var(--accent); }
  .block { display: flex; flex-direction: column; gap: 6px; }
  h4, .label { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); }
  .cooks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .cook {
    width: 100%; min-height: 48px; display: flex; align-items: center; gap: 10px;
    background: none; border: none; border-bottom: 1px solid var(--border); padding: 4px 0;
    color: var(--text-1); font: inherit; text-align: left; cursor: pointer;
  }
  .cook:disabled { cursor: default; }
  .cook img, .cook .ph { width: 36px; height: 36px; border-radius: var(--radius-sm); object-fit: cover; flex: none; }
  .ph { display: flex; align-items: center; justify-content: center; background: var(--surface-2); color: var(--text-3); font-size: 18px; }
  .cook-name { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .day { padding: 3px 8px; border-radius: var(--radius-full); background: var(--surface-2); font-size: 12px; font-weight: 500; color: var(--text-2); }
  .cook-amount { min-width: 72px; text-align: right; font-size: 14px; font-weight: 600; }
  .panel { padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); gap: 8px; }
  .kinds { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .muted { font-size: 12px; color: var(--text-2); }
  .kind { padding: 3px 10px; border-radius: var(--radius-full); background: var(--surface-3); font-size: 12px; font-weight: 500; color: var(--text-1); }
  .hint { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); }
  .hint .material-symbols-rounded { font-size: 18px; }
  .input {
    min-height: 44px; box-sizing: border-box; padding: 0 12px; border-radius: var(--radius-md);
    border: 1px solid var(--border-strong); background: var(--bg); color: var(--text-1); font: inherit; font-size: 14px;
  }
  .actions { display: flex; gap: 8px; }
  .actions .btn { flex: 1; min-height: 48px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }

  /* Room for two columns (a tablet, an unfolded foldable): the amounts and
     cooks on the left, the pantry, the note and the actions on the right. */
  :global(html.wide-content) .item-sheet { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
</style>
