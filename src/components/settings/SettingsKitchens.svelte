<script>
  /**
   * SettingsKitchens — manage household / roommate Kitchens.
   *
   * A Kitchen is a soft group of users; sharing a recipe with a
   * Kitchen fans out per-user shares to every member in one action.
   * MVP: create / delete kitchens, list + invite + remove members.
   * Sharing-by-kitchen is exposed in the Recipes share dialog (lives
   * elsewhere); this screen is the management surface.
   */
  import { _ } from 'svelte-i18n';
  import { onMount } from 'svelte';
  import { NtApi } from '../../lib/api.js';
  import { showSuccess, showError } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { currentUser, userMgmtActive } from '../../stores/auth.js';
  import Spinner from '../ui/Spinner.svelte';
  import Combobox from '../ui/Combobox.svelte';

  let kitchens = [];
  let loading = false;
  let busy = false;
  let creating = false;
  let newName = '';

  // Per-kitchen expanded panel state
  let openId = null;
  let members = {};      // { kitchenId: [member, ...] }
  let inviteName = '';        // Combobox picked value (display name string)
  let inviteTyped = '';       // Raw typed text (for freeform invite fallback)
  let inviteBusy = false;

  // Peer list for the invite autocomplete. Comes from /api/users/list
  // which is gated on sharing_enabled; if disabled we get [] and the
  // Combobox behaves like a plain create-on-enter input. Each entry is
  // { name, username } — name is the display label, username is what
  // the invite endpoint requires. Load once alongside kitchens.
  let peers = [];
  async function loadPeers() {
    try { peers = await NtApi.getUsersList(); }
    catch (e) {
      // Non-fatal — the Combobox falls back to freeform-invite. Log
      // instead of silent swallow so a 401/403/500 doesn't look like
      // "no other users" to the user.
      console.warn('[kitchens] getUsersList failed', e);
      peers = [];
    }
  }

  async function load() {
    loading = true;
    try {
      const [ks] = await Promise.all([NtApi.getKitchens(), loadPeers()]);
      kitchens = ks;
    }
    catch (e) { showError(e.message || 'Could not load Kitchens'); kitchens = []; }
    finally { loading = false; }
  }
  onMount(load);

  async function createKitchen() {
    const name = newName.trim();
    if (!name) return;
    creating = true;
    try {
      const k = await NtApi.createKitchen(name);
      kitchens = [...kitchens, k];
      newName = '';
      showSuccess(`Created Kitchen "${k.name}"`);
    } catch (e) { showError(e.message || 'Could not create'); }
    finally { creating = false; }
  }

  async function loadMembers(id) {
    try { members[id] = await NtApi.getKitchenMembers(id); members = members; }
    catch (e) { showError(e.message || 'Could not load members'); }
  }
  async function toggleOpen(id) {
    if (openId === id) { openId = null; return; }
    openId = id;
    inviteName = '';
    inviteTyped = '';
    if (!members[id]) await loadMembers(id);
  }

  // Resolve the invite input to a username. Priority:
  //   1. Combobox picked a peer whose display name matches — use their
  //      username (handles peers whose display name differs from
  //      username, e.g. "Joseph Lo Campo" -> "joe").
  //   2. Freeform typed text — send as-is; server looks up by username.
  //   3. Nothing typed — no-op.
  function _resolveInviteUsername() {
    const picked = (inviteName || '').trim();
    const typed  = (inviteTyped || '').trim();
    if (picked) {
      const peer = peers.find(p => p.name === picked || p.username === picked);
      if (peer?.username) return peer.username;
      return picked;
    }
    return typed;
  }

  async function invite(kitchenId) {
    const username = _resolveInviteUsername();
    if (!username) return;
    inviteBusy = true;
    try {
      await NtApi.addKitchenMember(kitchenId, username);
      showSuccess(`Added ${username}`);
      inviteName = '';
      inviteTyped = '';
      await loadMembers(kitchenId);
      // Update member_count cached on the row.
      kitchens = kitchens.map(k => k.id === kitchenId ? { ...k, member_count: (members[kitchenId] || []).length } : k);
    } catch (e) { showError(e.message || 'Could not add member'); }
    finally { inviteBusy = false; }
  }

  async function removeMember(kitchenId, member) {
    const isSelf = member.user_id === $currentUser?.id;
    const ok = await confirmDialog({
      title: isSelf ? 'Leave this Kitchen?' : `Remove ${member.username}?`,
      message: isSelf
        ? `You'll lose access to every recipe others shared with the Kitchen. Recipes you contributed to the Kitchen stay accessible to the remaining members.`
        : `${member.username} will lose access to every recipe others shared with the Kitchen. Recipes they contributed stay accessible to the rest of the Kitchen.`,
      confirmText: isSelf ? 'Leave' : 'Remove',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.removeKitchenMember(kitchenId, member.user_id);
      if (isSelf) {
        kitchens = kitchens.filter(k => k.id !== kitchenId);
        openId = null;
      } else {
        await loadMembers(kitchenId);
        kitchens = kitchens.map(k => k.id === kitchenId ? { ...k, member_count: (members[kitchenId] || []).length } : k);
      }
    } catch (e) { showError(e.message || 'Could not remove member'); }
  }

  // Per-user auto-share toggle. On enable, backfill every existing
  // recipe into every current member. On disable, existing grants
  // persist (the "we still cook from what you already shared" case);
  // Remove Member / Leave Kitchen is the destructive path that
  // revokes access in both directions.
  let autoShareBusyId = null;
  async function toggleAutoShare(k) {
    if (autoShareBusyId === k.id) return;
    const enabling = !k.auto_share;
    if (enabling) {
      const otherMembers = Math.max(0, (k.member_count || 1) - 1);
      const ok = await confirmDialog({
        title: `Auto-Share Your Recipes with ${k.name}?`,
        message: otherMembers === 0
          ? `You're the only member so far. Once you add others, every recipe you own now (or create later) will be shared with them automatically.`
          : `Every recipe you own now, and every recipe you create later, will be shared with the ${otherMembers} other ${otherMembers === 1 ? 'member' : 'members'} of this Kitchen. They'll see your full library.`,
        confirmText: 'Turn On',
      });
      if (!ok) return;
    }
    autoShareBusyId = k.id;
    try {
      const res = await NtApi.setKitchenAutoShare(k.id, enabling);
      kitchens = kitchens.map(x => x.id === k.id
        ? { ...x, auto_share: !!res.enabled, auto_shared_count: enabling ? (res.recipes || 0) : x.auto_shared_count }
        : x);
      if (enabling) {
        showSuccess(res.recipes > 0
          ? `Sharing ${res.recipes} ${res.recipes === 1 ? 'recipe' : 'recipes'} with this Kitchen`
          : `Auto-share is on — new recipes will be shared`);
      } else {
        showSuccess(`Auto-share turned off. Previously shared recipes stay visible; remove members to revoke access.`);
      }
    } catch (e) { showError(e.message || 'Could not update auto-share'); }
    finally { autoShareBusyId = null; }
  }

  // Safety valve: re-run the fan-out for an auto-share-on kitchen.
  // Covers the "toggle-on but members can't see anything" state that
  // shouldn't happen but occasionally does (race, silent DB error).
  // Idempotent — server uses INSERT OR IGNORE so this only fills in
  // whatever's missing.
  let resyncBusyId = null;
  async function resyncAutoShare(k) {
    resyncBusyId = k.id;
    try {
      const res = await NtApi.resyncKitchenAutoShare(k.id);
      kitchens = kitchens.map(x => x.id === k.id
        ? { ...x, auto_shared_count: res.recipes || x.auto_shared_count }
        : x);
      if (res.added > 0) {
        showSuccess(`Re-shared ${res.recipes} ${res.recipes === 1 ? 'recipe' : 'recipes'} (${res.added} new grant${res.added === 1 ? '' : 's'})`);
      } else {
        showSuccess(`Everything's already in sync (${res.recipes} ${res.recipes === 1 ? 'recipe' : 'recipes'})`);
      }
    } catch (e) { showError(e.message || 'Could not resync'); }
    finally { resyncBusyId = null; }
  }

  async function deleteKitchen(k) {
    const ok = await confirmDialog({
      title: `Delete Kitchen "${k.name}"?`,
      message: `The Kitchen goes away. Recipes shared through it stay accessible to the people they were shared with — this just ends the Kitchen structure.`,
      confirmText: 'Delete',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.deleteKitchen(k.id);
      kitchens = kitchens.filter(x => x.id !== k.id);
      openId = null;
      showSuccess($_('settings_kitchens_ct.toast.kitchen_deleted'));
    } catch (e) { showError(e.message || 'Could not delete'); }
  }

  function isOwner(k) { return k.role === 'owner'; }
</script>

<div class="card settings-card">
  {#if !$userMgmtActive}
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_kitchens_ct.um_required')}</span>
        <span class="setting-desc">Kitchens are a multi-user feature. Enable User Management in Settings → Users to create one.</span>
      </div>
    </div>
  {:else}
    <!-- Create -->
    <div class="setting-row stack">
      <span class="setting-label">{$_('settings_kitchens_ct.create_new_kitchen')}</span>
      <span class="setting-desc">A Kitchen is a household or shared group of users. Sharing a recipe with the Kitchen sends it to every member at once.</span>
      <div class="create-row">
        <input class="input" type="text" placeholder={$_('settings_kitchens_ct.new_name_ph')} bind:value={newName}
          on:keydown={(e) => { if (e.key === 'Enter') createKitchen(); }} />
        <button class="btn btn-primary" on:click={createKitchen} disabled={creating || !newName.trim()}>
          {creating ? 'Creating…' : 'Create'}
        </button>
      </div>
    </div>

    <!-- List -->
    {#if loading}
      <div class="setting-row"><Spinner label="Loading…" /></div>
    {:else if kitchens.length === 0}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-desc">No Kitchens yet. Create one above to start sharing recipes with a group.</span>
      </div>
    {:else}
      {#each kitchens as k (k.id)}
        <div class="setting-divider"></div>
        <div class="kitchen-row">
          <button class="kitchen-head" on:click={() => toggleOpen(k.id)}>
            <span class="material-symbols-rounded kitchen-icon">cooking</span>
            <span class="kitchen-info">
              <span class="kitchen-name">{k.name}</span>
              <span class="kitchen-meta">
                {k.member_count} {k.member_count === 1 ? 'member' : 'members'}
                {#if isOwner(k)}<span class="badge">{$_('settings_kitchens_ct.owner_badge')}</span>{/if}
              </span>
            </span>
            <span class="material-symbols-rounded chev" class:open={openId === k.id}>expand_more</span>
          </button>

          {#if openId === k.id}
            <div class="kitchen-body">
              <!-- Auto-share toggle. Per-user, per-kitchen. Enabling
                   backfills every existing recipe I own; disabling
                   leaves prior grants in place. -->
              <div class="auto-share-row" class:on={k.auto_share}>
                <div class="auto-share-copy">
                  <span class="auto-share-title">Auto-Share My Recipes</span>
                  <span class="auto-share-hint">
                    {#if k.auto_share}
                      Every recipe you create is shared with this Kitchen. {k.auto_shared_count || 0} recipe{(k.auto_shared_count || 0) === 1 ? '' : 's'} shared so far.
                    {:else}
                      Turn on to share your full recipe library with everyone in this Kitchen, now and going forward.
                    {/if}
                  </span>
                  {#if k.auto_share}
                    <button class="btn-link auto-share-resync"
                      disabled={resyncBusyId === k.id}
                      on:click={() => resyncAutoShare(k)}
                      title="Re-run the fan-out. Safe to click anytime — fills in any missing grants.">
                      <span class="material-symbols-rounded">autorenew</span>
                      {resyncBusyId === k.id ? 'Resyncing…' : 'Resync now'}
                    </button>
                  {/if}
                </div>
                <button class="switch" class:on={k.auto_share}
                  disabled={autoShareBusyId === k.id}
                  on:click={() => toggleAutoShare(k)}
                  aria-pressed={k.auto_share}
                  aria-label="Toggle auto-share">
                  <span class="switch-knob"></span>
                </button>
              </div>

              <div class="member-list">
                {#each (members[k.id] || []) as m (m.user_id)}
                  <div class="member-row">
                    <span class="member-name">
                      {m.full_name || m.username}
                      {#if m.role === 'owner'}<span class="badge">{$_('settings_kitchens_ct.owner_badge')}</span>{/if}
                      {#if m.user_id === $currentUser?.id}<span class="muted">(you)</span>{/if}
                    </span>
                    {#if isOwner(k) && m.user_id !== $currentUser?.id}
                      <button class="btn-link danger" on:click={() => removeMember(k.id, m)}>{$_('settings_kitchens_ct.remove')}</button>
                    {:else if m.user_id === $currentUser?.id && !isOwner(k)}
                      <button class="btn-link danger" on:click={() => removeMember(k.id, m)}>{$_('settings_kitchens_ct.leave')}</button>
                    {/if}
                  </div>
                {/each}
              </div>

              {#if isOwner(k)}
                <div class="invite-row">
                  <div class="invite-picker">
                    <Combobox
                      mode="single"
                      bind:value={inviteName}
                      bind:typed={inviteTyped}
                      options={peers}
                      placeholder={peers.length > 0
                        ? 'Type a name or username…'
                        : $_('settings_kitchens_ct.invite_username_ph')}
                      creatable={true}
                      createLabel="Add"
                      maxResults={20}
                      on:create={() => invite(k.id)}
                    />
                  </div>
                  <button class="btn btn-secondary" on:click={() => invite(k.id)}
                    disabled={inviteBusy || (!inviteName.trim() && !inviteTyped.trim())}>
                    {inviteBusy ? 'Adding…' : 'Add'}
                  </button>
                </div>
                <div class="kitchen-actions">
                  <button class="btn-link danger" on:click={() => deleteKitchen(k)}>{$_('settings_kitchens_ct.delete_kitchen')}</button>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .card.settings-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .setting-row {
    display: flex; justify-content: space-between; align-items: center;
    gap: 12px; padding: 14px 16px;
  }
  .setting-row.stack { flex-direction: column; align-items: stretch; gap: 8px; }
  .setting-label { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .setting-desc { font-size: 12px; color: var(--text-3); line-height: 1.4; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }

  .input {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 9px 12px;
    color: var(--text-1); font-size: 14px; box-sizing: border-box;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }

  .create-row { display: flex; gap: 8px; }
  .create-row .input { flex: 1; }

  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 9px 14px; font-size: 13px; cursor: pointer;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    white-space: nowrap;
  }
  .btn-primary { background: var(--accent); color: var(--accent-text, #0A0B0F); border-color: var(--accent); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary { background: var(--surface-2); color: var(--text-1); }
  .btn-secondary:hover { border-color: var(--accent); }
  .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-link {
    background: none; border: none; padding: 0;
    color: var(--accent); font-weight: 600; font-size: 12px;
    cursor: pointer;
  }
  .btn-link:hover { text-decoration: underline; }
  .btn-link.danger { color: var(--error, #f87171); }

  /* Kitchen row */
  .kitchen-row { padding: 0 16px; }
  .kitchen-head {
    width: 100%;
    display: flex; align-items: center; gap: 12px;
    background: transparent; border: none; cursor: pointer;
    padding: 14px 0;
    text-align: left;
    color: var(--text-1);
  }
  .kitchen-icon {
    font-size: 22px; color: var(--accent);
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    padding: 6px;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }
  .kitchen-info { flex: 1; min-width: 0; }
  .kitchen-name { font-size: 14px; font-weight: 600; display: block; }
  .kitchen-meta { font-size: 12px; color: var(--text-3); display: inline-flex; align-items: center; gap: 6px; }
  .badge {
    background: var(--accent-dim);
    color: var(--accent);
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .muted { color: var(--text-3); }
  .chev { color: var(--text-3); transition: transform var(--dur-fast); flex-shrink: 0; }
  .chev.open { transform: rotate(180deg); }

  .kitchen-body { padding: 0 0 14px 46px; display: flex; flex-direction: column; gap: 10px; }
  .auto-share-row {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: background var(--dur-fast), border-color var(--dur-fast);
  }
  .auto-share-row.on {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .auto-share-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .auto-share-title { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .auto-share-hint { font-size: 11px; color: var(--text-3); line-height: 1.4; }
  .auto-share-resync {
    align-self: flex-start;
    display: inline-flex; align-items: center; gap: 4px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-2);
    padding: 3px 8px;
    border-radius: var(--radius-sm);
    font: inherit; font-size: 11px; font-weight: 600;
    cursor: pointer;
    margin-top: 6px;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .auto-share-resync:hover:not(:disabled) { background: var(--surface-2); color: var(--text-1); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .auto-share-resync:disabled { opacity: 0.55; cursor: not-allowed; }
  .auto-share-resync .material-symbols-rounded { font-size: 13px; }
  .switch {
    width: 38px; height: 22px;
    border-radius: 999px;
    background: var(--surface-3, var(--border));
    border: 1px solid var(--border);
    position: relative;
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
    transition: background var(--dur-fast);
  }
  .switch:disabled { opacity: 0.5; cursor: wait; }
  .switch.on { background: var(--accent); border-color: var(--accent); }
  .switch-knob {
    position: absolute;
    top: 1px; left: 1px;
    width: 18px; height: 18px;
    background: #fff;
    border-radius: 999px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
    transition: transform var(--dur-fast) var(--ease-spring);
  }
  .switch.on .switch-knob { transform: translateX(16px); }
  .member-list { display: flex; flex-direction: column; gap: 4px; }
  .member-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 0;
    font-size: 13px;
  }
  .member-name { display: inline-flex; align-items: center; gap: 6px; }
  .invite-row { display: flex; gap: 8px; margin-top: 4px; align-items: center; }
  .invite-row .input { flex: 1; }
  .invite-picker { flex: 1; min-width: 0; }
  .kitchen-actions { display: flex; justify-content: flex-end; padding-top: 6px; }
</style>
