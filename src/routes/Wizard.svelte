<script>
  import { push } from 'svelte-spa-router';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { DB } from '../lib/db.js';
  import { bulkSet } from '../stores/settings.js';
  import { currentUser, userMgmtActive, setupRequired, loadAuthState } from '../stores/auth.js';
  import { validatePassword, passwordStrength } from '../lib/validation.js';
  import { showError } from '../stores/toast.js';
  import { isNative, getServerUrl, apiUrl } from '../lib/platform.js';
  import Toggle from '../components/settings/Toggle.svelte';

  // Wizard variants:
  //   1. Native local mode: skip user-management step, just collect display name + cooking prefs
  //   2. PWA with no users yet (setup_required): force admin account creation, then prefs
  //   3. PWA with users already present: show multi-user toggle, then prefs
  const _isNativeLocal        = isNative && !getServerUrl();
  const _isPwa                = !isNative;
  const _forceAccountCreation = _isPwa && $setupRequired;

  let step = 0;
  let dir  = 1;

  // ── User management state ────────────────────────────────────────────────
  let enableUserMgmt = _forceAccountCreation;
  let umUsername = '';
  let umPassword = '';
  let umConfirm  = '';
  let umShowPass = false;
  let umFullName = '';
  let umNickname = '';
  let umEmail    = '';
  let umError = '';
  let umBusy = false;

  $: pwScore = passwordStrength(umPassword);

  $: STEPS = _isNativeLocal
    ? ['welcome','name','prefs','done']
    : ['welcome','account','prefs','done'];
  $: progress = ((step + 1) / STEPS.length) * 100;

  // ── Cooking prefs state ──────────────────────────────────────────────────
  // Locale-aware defaults: en-AU / en-NZ → kJ, everyone else → kcal.
  // metric vs imperial: en-US is the only major imperial locale; everyone
  // else metric. Both are still freely toggleable in Settings.
  function _localeDefaults() {
    let metric = false, kj = false;
    try {
      const lang = (typeof navigator !== 'undefined' && (navigator.language || '')).toLowerCase();
      metric = !!lang && !lang.startsWith('en-us');
      kj = lang === 'en-au' || lang === 'en-nz';
    } catch {}
    return { metric, kj };
  }
  const _ld = _localeDefaults();
  let displayName = '';
  let measurementSystem = _ld.metric ? 'metric' : 'imperial';
  let energyUnitVal = _ld.kj ? 'kJ' : 'kcal';
  let defaultServings = 2;
  let dietary = { vegetarian: false, vegan: false, glutenFree: false, dairyFree: false };

  function next() {
    dir = 1;
    if (step < STEPS.length - 1) step += 1;
  }
  function back() {
    dir = -1;
    if (step > 0) step -= 1;
  }

  async function submitAccount() {
    umError = '';
    if (!enableUserMgmt && !_forceAccountCreation) {
      next();
      return;
    }
    if (!umUsername.trim()) { umError = 'Username required'; return; }
    const pwErr = validatePassword(umPassword);
    if (pwErr) { umError = pwErr; return; }
    if (umPassword !== umConfirm) { umError = "Passwords don't match"; return; }

    umBusy = true;
    try {
      const csrf = localStorage.getItem('ct:csrf') || '';
      const headers = { 'Content-Type': 'application/json' };
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const res = await fetch(apiUrl('/api/auth/register'), {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          username: umUsername.trim(),
          password: umPassword,
          full_name: umFullName.trim() || null,
          nickname: umNickname.trim() || null,
          email:    umEmail.trim() || null,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `Registration failed (${res.status})`);
      }
      await loadAuthState();
      next();
    } catch (e) {
      umError = e.message;
      showError(e.message);
    } finally {
      umBusy = false;
    }
  }

  // Celebration beat — swap the wizard for a small "All Set" hero with
  // confetti before navigating home, so onboarding ends with a real
  // moment of closure instead of just snapping to /recipes. Honors
  // prefers-reduced-motion (confetti hidden, icon static). TraceApps
  // parity port from NutriTrace + LiftTrace's GA polish pass.
  let wizardDone = false;

  async function finish() {
    const settingsToSave = {
      measurementSystem,
      energyUnit: energyUnitVal,
      defaultServings,
      dietaryPrefs: Object.entries(dietary).filter(([_, v]) => v).map(([k]) => k),
      // New users finishing onboarding get gradient banners as their
      // default first impression. Existing users (who never re-run the
      // wizard) keep whatever bannerStyle / legacy pageBanners they had
      // — the migration in settings.js handles that path.
      bannerStyle: 'gradient',
    };
    await bulkSet(settingsToSave);
    if (displayName) DB.setSetting('localUserName', displayName);
    DB.setSetting('setupComplete', true);
    wizardDone = true;
    setTimeout(() => push('/recipes'), 1800);
  }
</script>

<div class="wizard">
  {#if wizardDone}
    <!-- Celebration screen — brief beat between finishing the wizard and
         landing on /recipes, so onboarding has a moment of closure
         instead of just blinking to the home page. Mirrors NutriTrace +
         LiftTrace byte-for-byte so the cross-app onboarding feel matches. -->
    <div class="wizard-done">
      <div class="wizard-confetti" aria-hidden="true">
        {#each Array(14) as _, i}<span class="conf c{i % 7}" style:--i={i}></span>{/each}
      </div>
      <span class="material-symbols-rounded wizard-done-icon">emoji_events</span>
      <h2 class="wizard-done-title">You're All Set!</h2>
      <p class="wizard-done-sub">Welcome to CookTrace. Loading your recipes…</p>
    </div>
  {:else}
  <div class="progress">
    <div class="progress-bar" style="width: {progress}%"></div>
  </div>

  {#key step}
    <div class="step" in:fly={{ x: dir > 0 ? 60 : -60, duration: 280, easing: cubicOut }}>

      <!-- Welcome -->
      {#if STEPS[step] === 'welcome'}
        <div class="step-hero">
          <div class="logo-icon">🍳</div>
          <h1 class="step-title">Welcome to CookTrace</h1>
          <p class="step-desc">
            Trace Every Recipe — From Pantry to Plate.
            Self-hosted recipes, pantry, and cook diary.
          </p>
        </div>
        <div class="step-actions center">
          <button class="btn-primary" on:click={next}>Get Started</button>
        </div>

      <!-- Name (native local) -->
      {:else if STEPS[step] === 'name'}
        <h1 class="step-title">What should Trace call you?</h1>
        <p class="step-desc">Used in Trace assistant greetings and the sidebar header.</p>
        <input class="input" bind:value={displayName} placeholder="Your name" />
        <div class="step-actions">
          <button class="btn-secondary" on:click={back}>Back</button>
          <button class="btn-primary" on:click={next}>Next</button>
        </div>

      <!-- Account (PWA) -->
      {:else if STEPS[step] === 'account'}
        {#if _forceAccountCreation}
          <div class="step-hero compact">
            <span class="material-symbols-rounded hero-icon">person_add</span>
            <h1 class="step-title">Create your admin account</h1>
            <p class="step-desc">Set up an admin account to secure your CookTrace instance. You can invite household members later.</p>
          </div>
        {:else}
          <div class="step-hero compact">
            <span class="material-symbols-rounded hero-icon">group</span>
            <h1 class="step-title">Multi-user setup</h1>
            <p class="step-desc">CookTrace can run in single-user mode (default) or multi-user mode with separate logins. You can always enable this later in Settings.</p>
          </div>

          <div class="toggle-row">
            <div>
              <div class="toggle-label">Enable User Accounts</div>
              <div class="toggle-hint">Each user gets their own recipes, pantry, settings, and profile</div>
            </div>
            <Toggle checked={enableUserMgmt} on:change={e => enableUserMgmt = e.detail} />
          </div>
        {/if}

        {#if enableUserMgmt}
          <div class="um-form" transition:fly={{ y: 10, duration: 200 }}>
            <p class="um-section-label">Admin Account</p>

            <div class="form-row-2">
              <label class="field">
                <span class="field-label">Username *</span>
                <input class="input" type="text" bind:value={umUsername} placeholder="admin" autocomplete="username" />
              </label>
              <label class="field">
                <span class="field-label">Nickname</span>
                <input class="input" type="text" bind:value={umNickname} placeholder="Optional" />
              </label>
            </div>

            <label class="field">
              <span class="field-label">Full Name</span>
              <input class="input" type="text" bind:value={umFullName} placeholder="Optional" />
            </label>

            <label class="field">
              <span class="field-label">Email</span>
              <input class="input" type="email" bind:value={umEmail}
                placeholder="Used for password resets (optional)" autocomplete="email" />
            </label>

            <div class="form-row-2">
              <label class="field">
                <span class="field-label">Password *</span>
                <div class="pw-wrap">
                  {#if umShowPass}
                    <input class="input pw-input" type="text" bind:value={umPassword} autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" placeholder="8+ chars, upper, lower, number, symbol" />
                  {:else}
                    <input class="input pw-input" type="password" bind:value={umPassword} autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" placeholder="8+ chars, upper, lower, number, symbol" />
                  {/if}
                  <button
                    type="button"
                    class="pw-toggle"
                    on:click={() => umShowPass = !umShowPass}
                    aria-label={umShowPass ? 'Hide password' : 'Show password'}
                    title={umShowPass ? 'Hide password' : 'Show password'}
                  >
                    <span class="material-symbols-rounded">{umShowPass ? 'visibility_off' : 'visibility'}</span>
                  </button>
                </div>
                {#if umPassword}
                  <div class="pw-strength s-{pwScore.score}">
                    <div class="pw-bar"><div class="pw-fill" style:width={`${(pwScore.score / 4) * 100}%`}></div></div>
                    <span class="pw-label">{pwScore.label}</span>
                  </div>
                {/if}
              </label>
              <label class="field">
                <span class="field-label">Confirm *</span>
                <input class="input" type="password" bind:value={umConfirm} autocomplete="new-password" passwordrules="minlength: 8; required: upper; required: lower; required: digit; required: special;" />
                {#if umConfirm && umPassword !== umConfirm}
                  <span class="pw-mismatch">Passwords don't match</span>
                {/if}
              </label>
            </div>

            {#if umError}<div class="error">{umError}</div>{/if}
          </div>
        {/if}

        <div class="step-actions">
          {#if enableUserMgmt}
            <button class="btn-primary" on:click={submitAccount} disabled={umBusy}>
              {umBusy ? 'Creating…' : 'Create Account'}
            </button>
          {:else}
            <button class="btn-primary" on:click={next}>Continue</button>
          {/if}
        </div>

      <!-- Cooking preferences -->
      {:else if STEPS[step] === 'prefs'}
        <h1 class="step-title">Cooking Preferences</h1>
        <p class="step-desc">These shape how recipes display and what shopping units use.</p>

        <label class="field">
          <span>Measurement System</span>
          <div class="seg-group">
            {#each ['imperial','metric'] as opt}
              <button
                class="seg" class:active={measurementSystem === opt}
                on:click={() => measurementSystem = opt}
              >{opt}</button>
            {/each}
          </div>
        </label>

        <label class="field">
          <span>Default Servings</span>
          <input
            type="number" min="1" max="20" class="input num"
            bind:value={defaultServings}
          />
        </label>

        <label class="field">
          <span>Dietary Preferences</span>
          <div class="checks">
            {#each [['vegetarian','Vegetarian'], ['vegan','Vegan'], ['glutenFree','Gluten-free'], ['dairyFree','Dairy-free']] as [key, label]}
              <label class="check">
                <input type="checkbox" bind:checked={dietary[key]} />
                <span>{label}</span>
              </label>
            {/each}
          </div>
        </label>

        <div class="step-actions">
          <button class="btn-secondary" on:click={back}>Back</button>
          <button class="btn-primary" on:click={next}>Next</button>
        </div>

      <!-- Done -->
      {:else if STEPS[step] === 'done'}
        <h1 class="step-title">You're all set</h1>
        <p class="step-desc">CookTrace is ready. Start by browsing or importing your first recipe.</p>
        <div class="step-actions">
          <button class="btn-primary" on:click={finish}>Open CookTrace</button>
        </div>
      {/if}
    </div>
  {/key}
  {/if}
</div>

<style>
  /* Celebration screen shown briefly between finishing the wizard and
     landing on /recipes. Ported byte-for-byte from NutriTrace +
     LiftTrace so the cross-app onboarding closure feels identical. */
  .wizard-done {
    position: relative;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px;
    padding: 48px 16px;
    text-align: center;
    overflow: hidden;
    flex: 1;
  }
  .wizard-done-icon {
    font-size: 72px;
    color: var(--accent);
    filter: drop-shadow(0 2px 14px color-mix(in srgb, var(--accent) 40%, transparent));
    animation: wizard-done-pop 0.5s var(--ease-out, cubic-bezier(0.34, 1.56, 0.64, 1)) both;
  }
  .wizard-done-title {
    font-size: 24px; font-weight: 800; margin: 0; color: var(--text-1);
    letter-spacing: -0.01em;
  }
  .wizard-done-sub { font-size: 14px; color: var(--text-3); margin: 0; }
  .wizard-confetti {
    position: absolute; inset: 0; pointer-events: none; overflow: hidden;
  }
  .wizard-confetti .conf {
    position: absolute; top: -8px; left: var(--x, 50%);
    width: 8px; height: 8px; border-radius: 2px;
    --x: calc(50% + (var(--i) - 7) * 22px);
    animation: wizard-conf-fall 1.6s ease-out var(--d, 0s) forwards;
    --d: calc(var(--i) * 60ms);
  }
  .wizard-confetti .c0 { background: var(--accent); }
  .wizard-confetti .c1 { background: color-mix(in srgb, var(--accent) 70%, white); }
  .wizard-confetti .c2 { background: #ffd166; }
  .wizard-confetti .c3 { background: #06d6a0; }
  .wizard-confetti .c4 { background: #ef476f; }
  .wizard-confetti .c5 { background: #118ab2; }
  .wizard-confetti .c6 { background: #f78c6b; }
  @keyframes wizard-done-pop {
    0%   { transform: scale(0.4); opacity: 0; }
    60%  { transform: scale(1.1); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }
  @keyframes wizard-conf-fall {
    0%   { transform: translate(0, -20px) rotate(0deg); opacity: 1; }
    100% { transform: translate(calc((var(--i) - 7) * 6px), 220px) rotate(540deg); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .wizard-confetti { display: none; }
    .wizard-done-icon { animation: none; }
  }

  .wizard {
    max-width: 480px;
    margin: 0 auto;
    padding: calc(var(--safe-top) + 24px) 24px calc(var(--safe-bottom) + 32px);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .progress {
    height: 4px;
    background: var(--surface-2);
    border-radius: var(--radius-full);
    overflow: hidden;
    margin-bottom: 32px;
  }
  .progress-bar {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    transition: width 0.3s var(--ease-out);
  }

  .step { flex: 1; display: flex; flex-direction: column; gap: 16px; }
  .step-title {
    font-size: 28px;
    font-weight: 700;
    margin: 0 0 4px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .step-desc { color: var(--text-3); font-size: 14px; margin: 0 0 16px; line-height: 1.5; }

  .step-hero {
    text-align: center;
    padding: 40px 0 16px;
  }
  .step-hero.compact { padding: 16px 0 8px; }
  .step-hero .step-title { font-size: 32px; margin-bottom: 12px; }
  .step-hero.compact .step-title { font-size: 26px; }
  .step-hero .step-desc { font-size: 15px; max-width: 360px; margin: 0 auto; }
  .logo-icon {
    font-size: 72px;
    line-height: 1;
    margin-bottom: 20px;
    filter: drop-shadow(0 4px 16px color-mix(in srgb, var(--accent) 40%, transparent));
  }
  .hero-icon {
    font-size: 48px;
    color: var(--accent);
    margin-bottom: 12px;
    display: inline-block;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 16px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .toggle-label { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .toggle-hint { font-size: 12px; color: var(--text-3); margin-top: 2px; line-height: 1.4; }

  .um-form { display: flex; flex-direction: column; gap: 12px; padding-top: 8px; }
  .um-section-label {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
    margin: 4px 0 0;
  }
  .form-row-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  @media (max-width: 480px) {
    .form-row-2 { grid-template-columns: 1fr; }
  }

  /* Password strength bar — same shape as NutriTrace for brand cohesion. */
  .pw-strength {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .pw-bar {
    flex: 1;
    height: 4px;
    background: var(--surface-2);
    border-radius: var(--radius-full, 99px);
    overflow: hidden;
  }
  .pw-fill {
    height: 100%;
    border-radius: var(--radius-full, 99px);
    transition: width var(--dur-base), background var(--dur-fast);
  }
  .pw-strength.s-0 .pw-fill, .pw-strength.s-1 .pw-fill { background: var(--error, #ef4444); }
  .pw-strength.s-2 .pw-fill { background: #f59e0b; }
  .pw-strength.s-3 .pw-fill { background: var(--accent); }
  .pw-strength.s-4 .pw-fill { background: var(--success, #22c55e); }
  .pw-label { font-size: 12px; color: var(--text-3); font-weight: 600; min-width: 80px; text-align: right; }
  .pw-strength.s-0 .pw-label, .pw-strength.s-1 .pw-label { color: var(--error, #ef4444); }
  .pw-strength.s-2 .pw-label { color: #f59e0b; }
  .pw-strength.s-3 .pw-label { color: var(--accent); }
  .pw-strength.s-4 .pw-label { color: var(--success, #22c55e); }
  .pw-mismatch { font-size: 12px; color: var(--error, #ef4444); margin-top: 4px; }

  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .field > span { font-size: 13px; color: var(--text-2); font-weight: 500; }

  .input {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    color: var(--text-1);
    font-size: 14px;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .input.num { max-width: 100px; }

  .pw-wrap { position: relative; }
  .pw-input { padding-right: 44px; width: 100%; box-sizing: border-box; }
  .pw-toggle {
    position: absolute;
    top: 50%;
    right: 4px;
    transform: translateY(-50%);
    width: 36px;
    height: 36px;
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .pw-toggle:hover { color: var(--text-1); background: var(--surface-2); }
  .pw-toggle .material-symbols-rounded { font-size: 20px; }
  .pw-strength { font-size: 12px; color: var(--text-3); margin-top: 4px; }

  .seg-group { display: flex; gap: 4px; }
  .seg {
    background: var(--surface-2);
    color: var(--text-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-transform: capitalize;
  }
  .seg.active {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .checks { display: flex; flex-direction: column; gap: 8px; padding: 8px 0; }
  .check {
    display: flex; align-items: center; gap: 10px;
    cursor: pointer; font-size: 14px; color: var(--text-1);
  }
  .check input { width: 18px; height: 18px; accent-color: var(--accent); }

  .error {
    color: var(--error, #f87171);
    font-size: 13px;
    background: color-mix(in srgb, var(--error, #f87171) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--error, #f87171) 25%, transparent);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
  }

  .step-actions {
    display: flex;
    gap: 12px;
    margin-top: 24px;
    justify-content: flex-end;
  }
  .step-actions.center { justify-content: center; }
  .btn-primary, .btn-secondary {
    border-radius: var(--radius-sm);
    padding: 12px 22px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn-primary {
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: var(--accent-text, #0A0B0F);
  }
  .btn-primary:disabled { opacity: 0.5; cursor: wait; }
  .btn-secondary {
    background: var(--surface-2);
    color: var(--text-1);
    border-color: var(--border);
  }
  .btn-secondary.tiny { padding: 6px 12px; font-size: 12px; }
</style>
