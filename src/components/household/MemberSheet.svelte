<!--
  MemberSheet: one person in the household. Name, allergies, diet,
  dislikes and the days they're home.

  Props: open (bindable), member (null for a new one), suggestName (a new
  one's name to start with), firstDay (0 Sunday)
  Events: save (member), remove (member)
-->
<script>
  import { createEventDispatcher } from 'svelte';
  import { _, locale } from 'svelte-i18n';
  import Sheet from '../ui/Sheet.svelte';
  import { ALLERGENS, DIETS, allergenKey } from '../../lib/allergens.js';
  import { weekdayNames } from '../../lib/week.js';

  export let open = false;
  export let member = null;
  export let suggestName = '';
  export let firstDay = 0;

  const dispatch = createEventDispatcher();

  let name = '';
  let allergies = [];
  let diet = [];
  let dislikes = [];
  let days = [];
  let dislikeText = '';
  let error = '';
  let wasOpen = false;

  $: if (open && !wasOpen) {
    wasOpen = true;
    name = member?.name || suggestName || '';
    allergies = [...(member?.allergies || [])];
    diet = [...(member?.diet || [])];
    dislikes = [...(member?.dislikes || [])];
    days = [...(member?.days || [])];
    dislikeText = '';
    error = '';
  }
  $: if (!open) wasOpen = false;

  $: dayOrder = Array.from({ length: 7 }, (_, i) => (firstDay + i) % 7);
  $: shortNames = weekdayNames($locale, firstDay, 'narrow');
  $: longNames = weekdayNames($locale, firstDay, 'long');

  const toggle = (list, v) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

  function addDislike() {
    const parts = dislikeText.split(',').map(s => s.trim()).filter(Boolean);
    for (const p of parts) if (!dislikes.some(d => d.toLowerCase() === p.toLowerCase())) dislikes = [...dislikes, p];
    dislikeText = '';
  }
  function onDislikeKey(e) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addDislike(); }
  }

  function save() {
    addDislike();
    if (!name.trim()) { error = $_('household.name_required'); return; }
    dispatch('save', {
      id: member?.id || `m${Date.now().toString(36)}`,
      name: name.trim(),
      allergies: ALLERGENS.filter(c => allergies.includes(c)),
      diet: Object.keys(DIETS).filter(d => diet.includes(d)),
      dislikes,
      days: [...days].sort(),
    });
    open = false;
  }
</script>

<Sheet bind:open title={member ? member.name : $_('household.new_title')}>
  <form class="member" on:submit|preventDefault={save}>
    <label class="field">
      <span class="label">{$_('household.name')}</span>
      <input class="input" type="text" maxlength="60" bind:value={name} placeholder={$_('household.name_placeholder')}
        aria-invalid={!!error} on:input={() => (error = '')} />
      {#if error}<span class="error" role="alert">{error}</span>{/if}
    </label>

    <fieldset class="field">
      <legend class="label">{$_('household.allergies')}</legend>
      <div class="chips">
        {#each ALLERGENS as code (code)}
          <button type="button" class="chip" class:on={allergies.includes(code)} aria-pressed={allergies.includes(code)}
            on:click={() => (allergies = toggle(allergies, code))}>
            {#if allergies.includes(code)}<span class="material-symbols-rounded" aria-hidden="true">check</span>{/if}{$_(`allergens.${allergenKey(code)}`)}
          </button>
        {/each}
      </div>
    </fieldset>

    <fieldset class="field">
      <legend class="label">{$_('household.diet')}</legend>
      <div class="chips">
        {#each Object.keys(DIETS) as d (d)}
          <button type="button" class="chip" class:on={diet.includes(d)} aria-pressed={diet.includes(d)}
            on:click={() => (diet = toggle(diet, d))}>
            {#if diet.includes(d)}<span class="material-symbols-rounded" aria-hidden="true">check</span>{/if}{$_(`diets.${d}`)}
          </button>
        {/each}
      </div>
    </fieldset>

    <div class="field">
      <label class="label" for="member-dislikes">{$_('household.dislikes')}</label>
      {#if dislikes.length}
        <div class="chips">
          {#each dislikes as d (d)}
            <span class="tag">{d}<button type="button" class="tag-x" aria-label={$_('household.remove_dislike', { values: { item: d } })}
              on:click={() => (dislikes = dislikes.filter(x => x !== d))}><span class="material-symbols-rounded" aria-hidden="true">close</span></button></span>
          {/each}
        </div>
      {/if}
      <input id="member-dislikes" class="input" type="text" maxlength="60" bind:value={dislikeText}
        placeholder={$_('household.dislikes_placeholder')} on:keydown={onDislikeKey} on:blur={addDislike} />
    </div>

    <fieldset class="field">
      <legend class="label">{$_('household.home')}</legend>
      <div class="days" role="group">
        {#each dayOrder as d, i (d)}
          <button type="button" class="day" class:on={days.includes(d)} aria-pressed={days.includes(d)} aria-label={longNames[i]}
            on:click={() => (days = toggle(days, d))}>{shortNames[i]}</button>
        {/each}
      </div>
      <span class="hint">{$_('household.home_hint')}</span>
    </fieldset>

    <div class="actions">
      {#if member}
        <button type="button" class="btn btn-secondary danger" on:click={() => { dispatch('remove', member); open = false; }}>
          <span class="material-symbols-rounded" aria-hidden="true">person_remove</span>{$_('household.remove')}
        </button>
      {/if}
      <button type="submit" class="btn btn-primary">
        <span class="material-symbols-rounded" aria-hidden="true">check</span>{$_('household.save')}
      </button>
    </div>
  </form>
</Sheet>

<style>
  .member { display: flex; flex-direction: column; gap: 16px; padding-bottom: 8px; }
  .field { display: flex; flex-direction: column; gap: 8px; border: none; margin: 0; padding: 0; min-width: 0; }
  .label { padding: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); }
  .input {
    min-height: 44px; box-sizing: border-box; padding: 0 12px; border-radius: var(--radius-md);
    border: 1px solid var(--border-strong); background: var(--bg); color: var(--text-1); font: inherit; font-size: 15px;
  }
  .error { font-size: 12px; color: var(--danger); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px; min-height: 36px; padding: 0 12px;
    border-radius: var(--radius-full); border: 1px solid var(--border-strong); background: transparent;
    color: var(--text-2); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .chip.on { background: var(--accent-dim); border-color: transparent; color: var(--accent); }
  .chip .material-symbols-rounded { font-size: 16px; }
  .tag {
    display: inline-flex; align-items: center; gap: 2px; padding: 0 4px 0 12px; min-height: 32px;
    border-radius: var(--radius-full); background: var(--surface-2); color: var(--text-1); font-size: 13px;
  }
  .tag-x {
    width: 28px; height: 28px; border: none; border-radius: var(--radius-full); background: transparent;
    color: var(--text-2); display: flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .tag-x .material-symbols-rounded { font-size: 16px; }
  .days { display: flex; gap: 6px; flex-wrap: wrap; }
  .day {
    width: 40px; height: 40px; padding: 0; border-radius: var(--radius-full); border: 1px solid var(--border-strong);
    background: transparent; color: var(--text-2); font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
  }
  .day.on { background: var(--accent-dim); border-color: transparent; color: var(--accent); }
  .hint { font-size: 12px; color: var(--text-2); }
  .actions { display: flex; gap: 8px; }
  .actions .btn { flex: 1; min-height: 48px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .danger { color: var(--danger); }
</style>
