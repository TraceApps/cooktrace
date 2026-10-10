<script>
  // Household section: who you cook for (lib/allergens.js). Planned
  // servings follow who's home that day, and allergy warnings name who
  // they're for. Saved to the synced `household` setting.
  import { _ } from 'svelte-i18n';
  import HouseholdEditor from '../household/HouseholdEditor.svelte';
  import { currentUser } from '../../stores/auth.js';
  import { DB } from '../../lib/db.js';

  // The first member starts as you: your name signed in, or the one the
  // setup wizard asked for on a phone with no account.
  $: you = $currentUser?.nickname || $currentUser?.full_name || $currentUser?.username || DB.getSetting('localUserName', '') || $_('household.you');
</script>

<div class="section-body">
  <p class="intro">{$_('household.intro')}</p>
  <HouseholdEditor suggestName={you} />
  <p class="note">
    <span class="material-symbols-rounded" aria-hidden="true">info</span>
    <span>{$_('household.disclaimer')}</span>
  </p>
</div>

<style>
  .intro { margin: 0 0 12px; font-size: 13px; line-height: 1.45; color: var(--text-2); }
  .note {
    display: flex; gap: 8px; margin: 12px 0 0; padding: 10px 12px; border-radius: var(--radius-md);
    background: var(--surface-1); border: 1px solid var(--border);
    font-size: 12px; line-height: 1.45; color: var(--text-2);
  }
  .note .material-symbols-rounded { font-size: 18px; }
</style>
