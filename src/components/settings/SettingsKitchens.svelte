<script>
  import { failed } from '../../lib/messages.js';
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
  import ActionSheet from '../ui/ActionSheet.svelte';

  let kitchens = [];
  let loading = false;
  let busy = false;
  let creating = false;
  let newName = '';

  // Per-kitchen expanded panel state
  let openId = null;
  let members = {};      // { kitchenId: [member, ...] }
  let inviteRole = 'member';  // Role the new member joins with
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
    catch (e) { showError(failed('fail.load_kitchens', e)); kitchens = []; }
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
      showSuccess($_('done.kitchen_created', { values: { name: k.name } }));
    } catch (e) { showError(failed('fail.create_kitchen', e)); }
    finally { creating = false; }
  }

  async function loadMembers(id) {
    try { members[id] = await NtApi.getKitchenMembers(id); members = members; }
    catch (e) { showError(failed('fail.load_members', e)); }
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
      await NtApi.addKitchenMember(kitchenId, username, inviteRole);
      showSuccess($_('done.member_added', { values: { name: username } }));
      inviteName = '';
      inviteTyped = '';
      await loadMembers(kitchenId);
      // Update member_count cached on the row.
      kitchens = kitchens.map(k => k.id === kitchenId ? { ...k, member_count: (members[kitchenId] || []).length } : k);
    } catch (e) { showError(failed('fail.add_member', e)); }
    finally { inviteBusy = false; }
  }

  async function handOver(kitchenId, member) {
    const name = member.full_name || member.username;
    const ok = await confirmDialog({
      title: $_('settings_kitchens_ui.hand_over_title', { values: { name } }),
      message: $_('settings_kitchens_ui.hand_over_message', { values: { name } }),
      confirmText: $_('settings_kitchens_ui.hand_over'),
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.transferKitchen(kitchenId, member.user_id);
      await load();
      await loadMembers(kitchenId);
      showSuccess($_('done.kitchen_handed', { values: { name } }));
    } catch (e) { showError(failed('fail.hand_over', e)); }
  }

  // The roles, named once. A native select opens the operating system's own
  // list, which looks like nothing else in the app; this opens the same sheet
  // everything else here opens.
  $: roleName = {
    member: $_('settings_kitchens_ct.role_cook'),
    sous:   $_('settings_kitchens_ct.role_sous'),
    owner:  $_('settings_kitchens_ct.role_owner'),
  };
  $: memberRoleActions = [
    { label: roleName.member, icon: 'skillet',      value: 'member' },
    { label: roleName.sous,   icon: 'edit_note',    value: 'sous'   },
    // Handing the Kitchen over is not the same kind of act as the other two,
    // and the sheet can say so where a line in a dropdown cannot.
    { label: roleName.owner,  icon: 'stars',        value: 'owner', danger: true },
  ];
  $: inviteRoleActions = [
    { label: roleName.member, icon: 'skillet',   value: 'member' },
    { label: roleName.sous,   icon: 'edit_note', value: 'sous'   },
  ];

  /** Whose role is being picked, if anyone's. */
  let rolePicker = null;
  let invitePickerOpen = false;

  /**
   * A role chosen from the sheet. Head Chef is not a role you set on someone,
   * it is the Kitchen changing hands, so it asks first and nothing is written
   * until the answer is yes.
   */
  async function pickRole(value) {
    const open = rolePicker;
    rolePicker = null;
    if (!open || value === open.member.role) return;
    if (value === 'owner') { await handOver(open.kitchenId, open.member); return; }
    setRole(open.kitchenId, open.member, value);
  }

  async function removeMember(kitchenId, member) {
    const isSelf = member.user_id === $currentUser?.id;
    const ok = await confirmDialog({
      title: isSelf ? $_('settings_kitchens_ui.leave_title') : $_('settings_kitchens_ui.remove_title', { values: { name: member.username } }),
      message: isSelf
        ? $_('settings_kitchens_ui.leave_message')
        : $_('settings_kitchens_ui.remove_message', { values: { name: member.username } }),
      confirmText: isSelf ? $_('settings_kitchens_ct.leave') : $_('settings_kitchens_ct.remove'),
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
    } catch (e) { showError(failed('fail.remove_member', e)); }
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
        title: $_('settings_kitchens_ui.auto_share_title', { values: { name: k.name } }),
        message: otherMembers === 0
          ? $_('settings_kitchens_ui.auto_share_only_you')
          : $_('settings_kitchens_ui.auto_share_message', { values: { count: otherMembers } }),
        confirmText: $_('settings_kitchens_ui.turn_on'),
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
        showSuccess(res.recipes > 0 ? $_('done.auto_share_on_n', { values: { count: res.recipes } }) : $_('done.auto_share_on'));
      } else {
        showSuccess($_('done.auto_share_off'));
      }
    } catch (e) { showError(failed('fail.auto_share', e)); }
    finally { autoShareBusyId = null; }
  }

  async function deleteKitchen(k) {
    const ok = await confirmDialog({
      title: $_('settings_kitchens_ui.delete_title', { values: { name: k.name } }),
      message: $_('settings_kitchens_ui.delete_message'),
      confirmText: $_('common.delete'),
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.deleteKitchen(k.id);
      kitchens = kitchens.filter(x => x.id !== k.id);
      openId = null;
      showSuccess($_('settings_kitchens_ct.toast.kitchen_deleted'));
    } catch (e) { showError(failed('fail.delete_kitchen', e)); }
  }

  function isOwner(k) { return k.role === 'owner'; }

  // Kitchen roles. 'sous' may edit the recipes shared into this kitchen,
  // 'member' is read-only and stays the default a member joins with.
  function everyoneEdits(kitchenId) {
    const rest = (members[kitchenId] || []).filter(m => m.role !== 'owner');
    return rest.length > 0 && rest.every(m => m.role === 'sous');
  }

  async function setRole(kitchenId, member, role) {
    const prev = member.role;
    if (prev === role) return;
    members[kitchenId] = (members[kitchenId] || []).map(m => m.user_id === member.user_id ? { ...m, role } : m);
    try {
      await NtApi.setKitchenMemberRole(kitchenId, member.user_id, role);
      showSuccess(role === 'sous'
        ? $_('settings_kitchens_ct.toast.can_edit_now', { values: { name: member.full_name || member.username } })
        : $_('settings_kitchens_ct.toast.read_only_now', { values: { name: member.full_name || member.username } }));
    } catch (e) {
      members[kitchenId] = (members[kitchenId] || []).map(m => m.user_id === member.user_id ? { ...m, role: prev } : m);
      showError(failed('fail.change_role', e));
    }
  }

  async function setAllRoles(kitchenId, role) {
    const targets = (members[kitchenId] || []).filter(m => m.role !== 'owner' && m.role !== role);
    if (targets.length === 0) return;
    const ids = new Set(targets.map(m => m.user_id));
    const prev = members[kitchenId];
    members[kitchenId] = prev.map(m => ids.has(m.user_id) ? { ...m, role } : m);
    try {
      for (const m of targets) await NtApi.setKitchenMemberRole(kitchenId, m.user_id, role);
      showSuccess(role === 'sous'
        ? $_('settings_kitchens_ct.toast.all_can_edit')
        : $_('settings_kitchens_ct.toast.all_read_only'));
    } catch (e) {
      members[kitchenId] = prev;
      showError(failed('fail.change_roles', e));
    }
  }
</script>

<div class="card settings-card">
  {#if !$userMgmtActive}
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_kitchens_ct.um_required')}</span>
        <span class="setting-desc">{$_('settings_kitchens_ui.um_required_desc')}</span>
      </div>
    </div>
  {:else}
    <!-- Create -->
    <div class="setting-row stack">
      <span class="setting-label">{$_('settings_kitchens_ct.create_new_kitchen')}</span>
      <span class="setting-desc">{$_('settings_kitchens_ui.create_desc')}</span>
      <div class="create-row">
        <input class="input" type="text" placeholder={$_('settings_kitchens_ct.new_name_ph')} bind:value={newName}
          on:keydown={(e) => { if (e.key === 'Enter') createKitchen(); }} />
        <button class="btn btn-primary" on:click={createKitchen} disabled={creating || !newName.trim()}>
          {creating ? $_('settings_kitchens_ui.creating') : $_('settings_kitchens_ui.create')}
        </button>
      </div>
    </div>

    <!-- List -->
    {#if loading}
      <div class="setting-row"><Spinner label={$_('common.loading')} /></div>
    {:else if kitchens.length === 0}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-desc">{$_('settings_kitchens_ui.empty')}</span>
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
                {$_('settings_kitchens_ui.member_count', { values: { count: k.member_count } })}
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
                  <span class="auto-share-title">{$_('settings_kitchens_ui.auto_share_my_recipes')}</span>
                  <span class="auto-share-hint">
                    {#if k.auto_share}
                      {$_('settings_kitchens_ui.auto_share_on_hint', { values: { count: k.auto_shared_count || 0 } })}
                    {:else}
                      {$_('settings_kitchens_ui.auto_share_off_hint')}
                    {/if}
                  </span>
                </div>
                <button class="switch" class:on={k.auto_share}
                  disabled={autoShareBusyId === k.id}
                  on:click={() => toggleAutoShare(k)}
                  aria-pressed={k.auto_share}
                  aria-label={$_('settings_kitchens_ui.toggle_auto_share')}>
                  <span class="switch-knob"></span>
                </button>
              </div>

              {#if isOwner(k) && (members[k.id] || []).some(m => m.role !== 'owner')}
                <!-- Three roles in one sentence read as a wall. A line each,
                     strongest first, is the shape of the thing being
                     described and can be scanned rather than parsed. -->
                <div class="role-help">
                  <div class="roles">
                    <p class="setting-desc roles-lead">{$_('settings_kitchens_ct.roles_help')}</p>
                    <ul class="role-list">
                      <li><b>{$_('settings_kitchens_ct.role_owner')}</b> {$_('settings_kitchens_ct.role_help_owner')}</li>
                      <li><b>{$_('settings_kitchens_ct.role_sous')}</b> {$_('settings_kitchens_ct.role_help_sous')}</li>
                      <li><b>{$_('settings_kitchens_ct.role_cook')}</b> {$_('settings_kitchens_ct.role_help_cook')}</li>
                    </ul>
                  </div>
                  <button class="btn btn-secondary btn-sm" on:click={() => setAllRoles(k.id, everyoneEdits(k.id) ? 'member' : 'sous')}>
                    {everyoneEdits(k.id)
                      ? $_('settings_kitchens_ct.nobody_edits')
                      : $_('settings_kitchens_ct.everyone_edits')}
                  </button>
                </div>
              {/if}

              <div class="member-list">
                {#each (members[k.id] || []) as m (m.user_id)}
                  <div class="member-row">
                    <span class="member-name">
                      {m.full_name || m.username}
                      {#if m.role === 'owner'}<span class="badge">{$_('settings_kitchens_ct.owner_badge')}</span>{/if}
                      {#if m.user_id === $currentUser?.id}<span class="muted">{$_('settings_kitchens_ui.you')}</span>{/if}
                    </span>
                    {#if isOwner(k) && m.role !== 'owner'}
                      <!-- Head Chef sits with the other roles because that is
                           what it is. It is the one that cannot be taken back
                           by the person choosing it, so it asks first and the
                           picker goes back to where it was if the answer is
                           no. -->
                      <button class="role-pill"
                        aria-haspopup="dialog"
                        aria-label={$_('settings_kitchens_ct.role_for', { values: { name: m.full_name || m.username } })}
                        on:click={() => rolePicker = { kitchenId: k.id, member: m }}>
                        <span class="role-pill-text">{roleName[m.role] || roleName.member}</span>
                        <span class="material-symbols-rounded" aria-hidden="true">expand_more</span>
                      </button>
                    {:else if m.role === 'sous'}
                      <span class="badge">{$_('settings_kitchens_ct.role_sous')}</span>
                    {/if}
                    {#if isOwner(k) && m.user_id !== $currentUser?.id}
                      <button class="btn-icon-sm danger"
                        title={$_('settings_kitchens_ct.remove')}
                        aria-label={$_('settings_kitchens_ct.remove_member', { values: { name: m.full_name || m.username } })}
                        on:click={() => removeMember(k.id, m)}>
                        <span class="material-symbols-rounded">person_remove</span>
                      </button>
                    {:else if m.user_id === $currentUser?.id && !isOwner(k)}
                      <button class="btn btn-danger btn-sm" on:click={() => removeMember(k.id, m)}>{$_('settings_kitchens_ct.leave')}</button>
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
                        ? $_('settings_kitchens_ui.invite_ph')
                        : $_('settings_kitchens_ct.invite_username_ph')}
                      creatable={true}
                      createLabel={$_('settings_kitchens_ui.add')}
                      maxResults={20}
                      on:create={() => invite(k.id)}
                    />
                  </div>
                  <button class="role-pill"
                    aria-haspopup="dialog"
                    aria-label={$_('settings_kitchens_ct.invite_role')}
                    on:click={() => invitePickerOpen = true}>
                    <span class="role-pill-text">{roleName[inviteRole] || roleName.member}</span>
                    <span class="material-symbols-rounded" aria-hidden="true">expand_more</span>
                  </button>
                  <button class="btn btn-secondary" on:click={() => invite(k.id)}
                    disabled={inviteBusy || (!inviteName.trim() && !inviteTyped.trim())}>
                    {inviteBusy ? $_('settings_kitchens_ui.adding') : $_('settings_kitchens_ui.add')}
                  </button>
                </div>
                <div class="kitchen-actions">
                  <button class="btn btn-danger btn-sm" on:click={() => deleteKitchen(k)}>{$_('settings_kitchens_ct.delete_kitchen')}</button>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  {/if}
</div>

<ActionSheet
  open={rolePicker != null}
  title={rolePicker ? (rolePicker.member.full_name || rolePicker.member.username) : ''}
  actions={memberRoleActions}
  on:select={e => pickRole(e.detail.value)}
  on:cancel={() => rolePicker = null}
/>

<ActionSheet
  bind:open={invitePickerOpen}
  title={$_('settings_kitchens_ct.invite_role')}
  actions={inviteRoleActions}
  on:select={e => inviteRole = e.detail.value}
/>

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
  .btn-link.danger { color: var(--danger); }

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
    gap: 10px;
    padding: 6px 0;
    font-size: 13px;
  }
  .member-name { display: inline-flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
  .member-row .role-picker { margin-left: auto; }
  .role-help {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-wrap: wrap; padding: 2px 0 8px;
  }
  .roles { flex: 1 1 260px; min-width: 0; }
  .roles-lead { margin: 0 0 4px; }
  .role-list {
    list-style: none;
    margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 2px;
    font-size: 13px; color: var(--text-2);
  }
  .role-list b { color: var(--text-1); font-weight: 600; }
  .invite-row { display: flex; gap: 8px; margin-top: 4px; align-items: center; }
  .invite-row .input { flex: 1; }
  .invite-picker { flex: 1; min-width: 0; }
  .kitchen-actions { display: flex; justify-content: flex-end; padding-top: 10px; }

  /* Small versions of the page's buttons, for a row that is a line of text
     high. Same shapes, less of them. */
  .btn-sm { padding: 6px 11px; font-size: 12px; }
  .btn-danger {
    background: rgba(255,92,92,0.14);
    color: var(--danger);
    border-color: rgba(255,92,92,0.3);
  }
  .btn-danger:hover { background: rgba(255,92,92,0.22); }
  /* The one control that holds what you can do to a member. */
  .btn-icon-sm {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; flex: 0 0 auto;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    cursor: pointer;
  }
  .btn-icon-sm:hover { background: var(--surface-3); color: var(--text-1); }
  /* The role control. A native select opens the operating system's list,
     which is the one thing on this page that looks like another app; this is
     an ordinary button that opens the sheet everything else here opens. */
  .role-pill {
    display: inline-flex; align-items: center; gap: 4px;
    flex: 0 0 auto;
    height: 32px;
    padding: 0 6px 0 11px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full, 999px);
    color: var(--text-1);
    font-size: 12px; font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color var(--dur-fast, 0.12s), background var(--dur-fast, 0.12s);
  }
  .role-pill:hover { border-color: var(--accent); background: var(--surface-3); }
  .role-pill:active { transform: scale(0.97); }
  .role-pill .material-symbols-rounded { font-size: 18px; color: var(--text-2); }
  .role-pill-text { overflow: hidden; text-overflow: ellipsis; }

  .btn-icon-sm.danger { color: var(--danger); border-color: rgba(255,92,92,0.3); }
  .btn-icon-sm.danger:hover { background: rgba(255,92,92,0.14); color: var(--danger); }
  .btn-icon-sm .material-symbols-rounded { font-size: 18px; }
</style>
