<script>
  /**
   * RecipeComments — threaded comment list for a recipe.
   *
   * Storage is a flat (recipe_comments) table with a parent_id column
   * for threading. We render as a tree by grouping replies under their
   * parent. A comment can be replied to but reply depth is visually
   * capped at one level (replies-of-replies still attach to the root
   * thread for readability) — server still preserves the full chain.
   */
  import { onMount } from 'svelte';
  import { NtApi } from '../../lib/api.js';
  import { currentUser, userMgmtActive } from '../../stores/auth.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import { confirmDialog } from '../../stores/confirmDialog.js';
  import { relativeTime } from '../../lib/relative-time.js';
  import { resolveAssetUrl } from '../../lib/platform.js';
  import RichTextEditor, { sanitizeRichText } from '../ui/RichTextEditor.svelte';

  export let recipeId;

  let comments = [];
  let loading = true;
  let posting = false;
  let draft = '';
  let editingId = null;
  let editDraft = '';
  // Reply state: id of the comment we're replying to (null = top-level draft).
  let replyingTo = null;
  let replyDraft = '';
  // Show 5 newest top-level threads by default. Replies under each
  // top-level thread always render; only the parent count is capped.
  const COLLAPSED_LIMIT = 5;
  let showAll = false;

  $: canPost = !$userMgmtActive || !!$currentUser;

  // Build a tree: top-level (parent_id == null) plus a map of children
  // by parent. For visual simplicity replies-of-replies fold into the
  // top-level thread of the original parent.
  $: threads = (() => {
    const byParent = new Map();
    const top = [];
    for (const c of comments) {
      if (c.parent_id == null) top.push(c);
      else {
        const arr = byParent.get(c.parent_id) || [];
        arr.push(c);
        byParent.set(c.parent_id, arr);
      }
    }
    // Walk top-level oldest → newest so threads stay chronological. Nested
    // replies inside each thread also chronological. We fold deeper
    // replies up to the top-level by following parent_id chains.
    const rootIdOf = new Map(); // child id → top-level ancestor id
    function rootFor(c) {
      if (c.parent_id == null) return c.id;
      if (rootIdOf.has(c.id)) return rootIdOf.get(c.id);
      let cur = c;
      const seen = new Set();
      while (cur && cur.parent_id != null && !seen.has(cur.id)) {
        seen.add(cur.id);
        const parent = comments.find(x => x.id === cur.parent_id);
        if (!parent) break;
        cur = parent;
      }
      const root = cur?.id ?? c.id;
      rootIdOf.set(c.id, root);
      return root;
    }
    const repliesByRoot = new Map();
    for (const c of comments) {
      if (c.parent_id == null) continue;
      const root = rootFor(c);
      const arr = repliesByRoot.get(root) || [];
      arr.push(c);
      repliesByRoot.set(root, arr);
    }
    return top.map(t => ({
      ...t,
      replies: (repliesByRoot.get(t.id) || []).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '')),
    }));
  })();
  $: visibleThreads = (showAll || threads.length <= COLLAPSED_LIMIT)
    ? threads
    : threads.slice(threads.length - COLLAPSED_LIMIT);

  async function load() {
    loading = true;
    try {
      comments = await NtApi.getRecipeComments(recipeId);
    } catch (e) {
      showError(e.message || 'Could not load comments');
      comments = [];
    } finally {
      loading = false;
    }
  }
  onMount(load);

  async function submit() {
    const body = draft.trim();
    if (!body) return;
    posting = true;
    try {
      const c = await NtApi.postRecipeComment(recipeId, body);
      comments = [...comments, c];
      draft = '';
      showAll = true;
    } catch (e) {
      showError(e.message || 'Could not post comment');
    } finally {
      posting = false;
    }
  }
  async function submitReply(parentId) {
    const body = replyDraft.trim();
    if (!body) return;
    posting = true;
    try {
      const c = await NtApi.postRecipeComment(recipeId, body, parentId);
      comments = [...comments, c];
      replyDraft = '';
      replyingTo = null;
    } catch (e) {
      showError(e.message || 'Could not post reply');
    } finally {
      posting = false;
    }
  }

  function startEdit(c) {
    editingId = c.id;
    editDraft = c.body;
  }
  function cancelEdit() { editingId = null; editDraft = ''; }
  async function saveEdit(c) {
    const body = editDraft.trim();
    if (!body) return;
    try {
      const updated = await NtApi.updateRecipeComment(recipeId, c.id, body);
      comments = comments.map(x => x.id === c.id ? updated : x);
      cancelEdit();
      showSuccess('Comment updated');
    } catch (e) {
      showError(e.message || 'Could not save');
    }
  }

  async function remove(c) {
    const ok = await confirmDialog({
      title: 'Delete comment?',
      message: 'This cannot be undone.',
      confirmText: 'Delete',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await NtApi.deleteRecipeComment(recipeId, c.id);
      comments = comments.filter(x => x.id !== c.id);
    } catch (e) {
      showError(e.message || 'Could not delete');
    }
  }

  function canEdit(c) {
    if (!$currentUser) return false;
    if ($currentUser.role === 'admin') return true;
    return c.user_id === $currentUser.id;
  }
  function displayName(c) {
    // Match the cook-byline + recipe-author convention: prefer the
    // user's full name, fall back to the username (which is the
    // email in most installs).
    return c.created_by_full_name || c.created_by_username || 'Anonymous';
  }
  function initial(name) {
    const s = (name || '?').trim();
    return s.charAt(0).toUpperCase() || '?';
  }

</script>

<div class="comments">
  <div class="head">
    <h2 class="title">
      <span class="material-symbols-rounded title-icon">forum</span>
      <span class="title-text">Comments</span>
    </h2>
    <span class="count" class:zero={comments.length === 0}>{comments.length}</span>
  </div>

  {#if loading}
    <div class="state" in:fade={{ duration: 120 }}>
      <span class="material-symbols-rounded spin">progress_activity</span>
    </div>
  {:else}
    {#if comments.length === 0}
      <p class="empty">No comments yet. {canPost ? 'Be the first.' : 'Sign in to leave one.'}</p>
    {:else}
      {#if !showAll && threads.length > COLLAPSED_LIMIT}
        <button class="show-more" on:click={() => showAll = true}>
          Show all {threads.length} threads
        </button>
      {/if}

      <ul class="list">
        {#each visibleThreads as c (c.id)}
          <li class="comment">
            <div class="avatar" aria-hidden="true">
              {#if c.created_by_avatar_url}
                <img src={resolveAssetUrl(c.created_by_avatar_url)} alt="" />
              {:else}
                {initial(displayName(c))}
              {/if}
            </div>
            <div class="body-col">
              <div class="meta">
                <span class="author">{displayName(c)}</span>
                <span class="dot">·</span>
                <span class="when" title={c.created_at}>{relativeTime(c.created_at)}</span>
                {#if c.updated_at && c.updated_at !== c.created_at}
                  <span class="edited" title={`Last edited ${c.updated_at}`}>(edited)</span>
                {/if}
              </div>
              {#if editingId === c.id}
                <RichTextEditor bind:value={editDraft} placeholder="Edit your comment…" rows={3} />
                <div class="edit-actions">
                  <button class="btn btn-secondary tiny" on:click={cancelEdit}>Cancel</button>
                  <button class="btn btn-primary tiny" on:click={() => saveEdit(c)}
                    disabled={!editDraft.trim()}>Save</button>
                </div>
              {:else}
                <div class="text">{@html sanitizeRichText(c.body)}</div>
                <div class="row-actions">
                  {#if canPost}
                    <button class="btn-link" on:click={() => { replyingTo = c.id; replyDraft = ''; }}>
                      Reply
                    </button>
                  {/if}
                  {#if canEdit(c)}
                    <button class="btn-icon small" on:click={() => startEdit(c)} aria-label="Edit" title="Edit">
                      <span class="material-symbols-rounded">edit</span>
                    </button>
                    <button class="btn-icon small danger" on:click={() => remove(c)} aria-label="Delete" title="Delete">
                      <span class="material-symbols-rounded">delete</span>
                    </button>
                  {/if}
                </div>
              {/if}

              {#if c.replies && c.replies.length > 0}
                <ul class="reply-list">
                  {#each c.replies as r (r.id)}
                    <li class="comment reply">
                      <div class="avatar small" aria-hidden="true">
                        {#if r.created_by_avatar_url}
                          <img src={resolveAssetUrl(r.created_by_avatar_url)} alt="" />
                        {:else}
                          {initial(displayName(r))}
                        {/if}
                      </div>
                      <div class="body-col">
                        <div class="meta">
                          <span class="author">{displayName(r)}</span>
                          <span class="dot">·</span>
                          <span class="when" title={r.created_at}>{relativeTime(r.created_at)}</span>
                          {#if r.updated_at && r.updated_at !== r.created_at}
                            <span class="edited">(edited)</span>
                          {/if}
                        </div>
                        {#if editingId === r.id}
                          <RichTextEditor bind:value={editDraft} placeholder="Edit reply…" rows={2} />
                          <div class="edit-actions">
                            <button class="btn btn-secondary tiny" on:click={cancelEdit}>Cancel</button>
                            <button class="btn btn-primary tiny" on:click={() => saveEdit(r)}
                              disabled={!editDraft.trim()}>Save</button>
                          </div>
                        {:else}
                          <div class="text">{@html sanitizeRichText(r.body)}</div>
                          {#if canEdit(r)}
                            <div class="row-actions">
                              <button class="btn-icon small" on:click={() => startEdit(r)} aria-label="Edit" title="Edit">
                                <span class="material-symbols-rounded">edit</span>
                              </button>
                              <button class="btn-icon small danger" on:click={() => remove(r)} aria-label="Delete" title="Delete">
                                <span class="material-symbols-rounded">delete</span>
                              </button>
                            </div>
                          {/if}
                        {/if}
                      </div>
                    </li>
                  {/each}
                </ul>
              {/if}

              {#if replyingTo === c.id}
                <div class="reply-composer">
                  <RichTextEditor bind:value={replyDraft}
                    placeholder={`Reply to ${displayName(c)}…`} rows={2} />
                  <div class="edit-actions">
                    <button class="btn btn-secondary tiny" on:click={() => { replyingTo = null; replyDraft = ''; }}>Cancel</button>
                    <button class="btn btn-primary tiny" on:click={() => submitReply(c.id)}
                      disabled={posting || !replyDraft.trim()}>
                      {posting ? 'Posting…' : 'Post reply'}
                    </button>
                  </div>
                </div>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    {#if canPost}
      <div class="composer">
        <RichTextEditor bind:value={draft} placeholder="Add a comment…" rows={3} />
        <div class="composer-actions">
          <span class="hint">Supports bold / italic / lists</span>
          <button class="btn btn-primary" on:click={submit}
            disabled={posting || !draft.trim()}>
            {posting ? 'Posting…' : 'Post Comment'}
          </button>
        </div>
      </div>
    {:else}
      <p class="signin-prompt">Sign in to leave a comment.</p>
    {/if}
  {/if}
</div>

<style>
  .comments {
    margin-top: 8px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    /* Heading icon sits at the component's content edge (X=0),
       which puts the visible glyph at the same X as the "No
       comments yet" / composer body text below — both inherit the
       same column padding. */
    margin-left: 0;
  }
  .title {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-1);
    font-size: 16px;
    font-weight: 800;
    letter-spacing: -0.01em;
    text-transform: none;
  }
  .title-icon {
    font-size: 22px;
    color: var(--accent);
    flex-shrink: 0;
    line-height: 1;
  }
  .title-text {
    display: inline-block;
    padding-bottom: 4px;
    border-bottom: 2px solid var(--accent);
    line-height: 1.1;
    text-transform: none;
  }
  .count {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-3);
    background: var(--surface-2);
    padding: 2px 8px;
    border-radius: 999px;
  }
  .count.zero { opacity: 0.6; }

  .state {
    text-align: center;
    padding: 32px;
    color: var(--text-3);
  }
  .spin {
    font-size: 24px;
    animation: spin 1.2s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .empty {
    color: var(--text-3);
    font-size: 14px;
    margin: 8px 0 16px;
  }

  .show-more {
    background: none;
    border: none;
    color: var(--accent);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    padding: 4px 0;
    margin-bottom: 12px;
  }
  .show-more:hover { text-decoration: underline; }

  .list {
    list-style: none;
    padding: 0;
    margin: 0 0 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .comment {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .avatar {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-contrast, #0a0b0f);
    font-weight: 700;
    font-size: 15px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .body-col {
    flex: 1;
    min-width: 0;
  }
  .meta {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 13px;
    margin-bottom: 4px;
  }
  .author { font-weight: 700; color: var(--text-1); }
  .dot { color: var(--text-3); }
  .when, .edited { color: var(--text-3); }
  .edited { font-style: italic; font-size: 12px; }

  .text {
    margin: 0;
    color: var(--text-1);
    font-size: 14px;
    line-height: 1.5;
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  /* Rich-text body — comments support bold / italic / underline /
     bullets / numbered lists. Match the editor's preview spacing so
     read view feels continuous with the edit view. */
  .text :global(p) { margin: 0 0 6px; }
  .text :global(p:last-child) { margin-bottom: 0; }
  .text :global(ul),
  .text :global(ol) { margin: 4px 0 6px; padding-left: 22px; }
  .text :global(li) { margin: 2px 0; }

  .row-actions {
    display: flex;
    gap: 4px;
    margin-top: 4px;
  }
  .btn-icon {
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text-3);
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .btn-icon:hover { background: var(--surface-2); color: var(--text-1); }
  .btn-icon.danger:hover {
    background: color-mix(in srgb, var(--error, #ef4444) 18%, transparent);
    color: var(--error, #ef4444);
  }
  .btn-icon .material-symbols-rounded { font-size: 16px; }

  .edit-area, .composer-area {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 64px;
  }
  .edit-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 8px;
  }

  .composer {
    margin-top: 8px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  .composer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 8px;
  }
  .hint {
    font-size: 12px;
    color: var(--text-3);
  }
  .signin-prompt {
    margin-top: 8px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    color: var(--text-3);
    font-size: 13px;
    font-style: italic;
  }

  /* Threaded replies render as a slightly inset list under the parent. */
  .reply-list {
    list-style: none;
    margin: 12px 0 0 0;
    padding: 0 0 0 16px;
    border-left: 2px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .comment.reply { padding-top: 0; }
  .avatar.small { width: 26px; height: 26px; font-size: 12px; }

  .btn-link {
    background: none; border: none; padding: 0;
    color: var(--accent); font-weight: 600; font-size: 12px;
    cursor: pointer;
  }
  .btn-link:hover { text-decoration: underline; }

  .reply-composer {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px dashed var(--border);
  }
</style>
