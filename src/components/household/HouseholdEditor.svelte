<!--
  HouseholdEditor: the people you cook for, as cards. Each shows their
  allergies, diets and dislikes, and the days they're home as toggles you
  can change right there; Edit opens the rest. Used in Settings and in the
  setup wizard. Saves to the synced `household` setting.
-->
<script>
  import { _, locale } from 'svelte-i18n';
  import { household } from '../../stores/settings.js';
  import { showSuccess } from '../../stores/toast.js';
  import MemberSheet from './MemberSheet.svelte';
  import { allergenKey, cleanHousehold } from '../../lib/allergens.js';
  import { firstDayOfWeek, weekdayNames } from '../../lib/week.js';

  /** Shown as the first member's name when the list starts empty. */
  export let suggestName = '';

  $: members = cleanHousehold($household);
  $: firstDay = firstDayOfWeek($locale);
  $: dayOrder = Array.from({ length: 7 }, (_, i) => (firstDay + i) % 7);
  $: shortNames = weekdayNames($locale, firstDay, 'narrow');
  $: longNames = weekdayNames($locale, firstDay, 'long');

  let sheetOpen = false;
  let editing = null;

  function openNew() { editing = null; sheetOpen = true; }
  function openEdit(m) { editing = m; sheetOpen = true; }

  function save(e) {
    const m = e.detail;
    const at = members.findIndex(x => x.id === m.id);
    household.set(at === -1 ? [...members, m] : members.map((x, i) => (i === at ? m : x)));
  }
  function remove(e) {
    household.set(members.filter(x => x.id !== e.detail.id));
    showSuccess($_('household.removed', { values: { name: e.detail.name } }));
  }
  // Every day is the same as none picked: home all week.
  function toggleDay(m, d) {
    const all = m.days.length ? m.days : [0, 1, 2, 3, 4, 5, 6];
    let next = all.includes(d) ? all.filter(x => x !== d) : [...all, d].sort();
    if (next.length === 7) next = [];
    household.set(members.map(x => (x.id === m.id ? { ...x, days: next } : x)));
  }
  const homeOnDay = (m, d) => !m.days.length || m.days.includes(d);
  const initial = name => (String(name).trim()[0] || '?').toLocaleUpperCase();
</script>

<div class="household">
  {#each members as m, i (m.id)}
    <article class="member">
      <div class="top">
        <span class="avatar" data-tone={i % 4} aria-hidden="true">{initial(m.name)}</span>
        <span class="name">{m.name}</span>
        <button class="icon-btn" aria-label={$_('household.edit', { values: { name: m.name } })} on:click={() => openEdit(m)}>
          <span class="material-symbols-rounded" aria-hidden="true">edit</span>
        </button>
      </div>
      <div class="row">
        <span class="row-label">{$_('household.allergies')}</span>
        {#each m.allergies as a (a)}
          <span class="chip warn"><span class="material-symbols-rounded" aria-hidden="true">warning</span>{$_(`allergens.${allergenKey(a)}`)}</span>
        {:else}
          <span class="muted">{$_('household.none')}</span>
        {/each}
      </div>
      {#if m.diet.length}
        <div class="row">
          <span class="row-label">{$_('household.diet')}</span>
          {#each m.diet as d (d)}<span class="chip">{$_(`diets.${d}`)}</span>{/each}
        </div>
      {/if}
      {#if m.dislikes.length}
        <div class="row">
          <span class="row-label">{$_('household.dislikes')}</span>
          {#each m.dislikes as d (d)}<span class="chip">{d}</span>{/each}
        </div>
      {/if}
      <div class="row">
        <span class="row-label">{$_('household.home')}</span>
        <div class="days" role="group" aria-label={$_('household.days_home', { values: { name: m.name } })}>
          {#each dayOrder as d, j (d)}
            <button class="day" class:on={homeOnDay(m, d)} aria-pressed={homeOnDay(m, d)} aria-label={longNames[j]}
              on:click={() => toggleDay(m, d)}>{shortNames[j]}</button>
          {/each}
        </div>
      </div>
    </article>
  {/each}

  <button class="add" on:click={openNew}>
    <span class="material-symbols-rounded" aria-hidden="true">person_add</span>{$_('household.add')}
  </button>
</div>

<MemberSheet bind:open={sheetOpen} member={editing} suggestName={members.length ? '' : suggestName} {firstDay} on:save={save} on:remove={remove} />

<style>
  .household { display: flex; flex-direction: column; gap: 10px; }
  .member {
    display: flex; flex-direction: column; gap: 10px; padding: 12px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-lg);
  }
  .top { display: flex; align-items: center; gap: 10px; }
  .avatar {
    width: 36px; height: 36px; flex: none; border-radius: var(--radius-full);
    display: flex; align-items: center; justify-content: center;
    font-size: 15px; font-weight: 800; color: var(--bg); background: var(--accent);
  }
  .avatar[data-tone='1'] { background: var(--accent-2); }
  .avatar[data-tone='2'] { background: var(--warning); }
  .avatar[data-tone='3'] { background: var(--info); }
  .name { flex: 1; min-width: 0; font-size: 15px; font-weight: 700; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .icon-btn {
    width: 44px; height: 44px; flex: none; border: none; border-radius: var(--radius-md); background: transparent;
    color: var(--text-2); display: flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .icon-btn:hover { background: var(--surface-2); }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .row-label { width: 76px; flex: none; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-2); }
  .chip {
    display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: var(--radius-full);
    background: var(--surface-2); color: var(--text-2); font-size: 12px; font-weight: 500;
  }
  .chip.warn { background: color-mix(in srgb, var(--warning) 14%, transparent); color: var(--warning); font-weight: 600; }
  .chip .material-symbols-rounded { font-size: 14px; }
  .muted { font-size: 12px; color: var(--text-2); }
  .days { display: flex; gap: 4px; flex-wrap: wrap; }
  .day {
    width: 36px; height: 36px; padding: 0; border-radius: var(--radius-full); border: 1px solid var(--border-strong);
    background: transparent; color: var(--text-2); font: inherit; font-size: 12px; font-weight: 700; cursor: pointer;
  }
  .day.on { background: var(--accent-dim); border-color: transparent; color: var(--accent); }
  .add {
    min-height: 48px; border: 1.5px dashed var(--border-strong); border-radius: var(--radius-lg); background: transparent;
    color: var(--text-2); display: flex; align-items: center; justify-content: center; gap: 6px;
    font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .add:hover { color: var(--text-1); border-color: var(--text-3); }
</style>
