<script>
  // About section — extracted from Settings.svelte. Owns the app hero
  // (logo + version + platform tag), the feature-highlight rows, the
  // Ko-fi support-dev link, and the disclaimer footnote.
  import { _ } from 'svelte-i18n';
  import { APP_VERSION } from '../../lib/version.js';
  import { iconUrl, isNative } from '../../lib/platform.js';
</script>

<div class="section-body">
  <div class="card settings-card">
    <div class="about-hero">
      <img src={iconUrl('/icons/logo.png')} alt="CookTrace" class="about-icon" />
      <div>
        <div class="about-name">{$_('settings_page.about.app_name')}</div>
        <div class="about-version text-3 text-sm">
          {APP_VERSION}
          <span class="platform-tag">{isNative ? 'Android' : 'PWA'}</span>
        </div>
      </div>
    </div>
    <div class="setting-divider"></div>
    <div class="about-desc">
      Trace Every Recipe — From Pantry to Plate. CookTrace keeps your
      recipes, pantry, cook diary, and shopping list together in one place,
      with optional federation to NutriTrace for nutrition tracking. Your data
      lives on your server, not in the cloud.
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">database</span>
      <span>Self-hosted — your data, your server</span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">phone_android</span>
      <span>Native Android app with offline support, plus a PWA for any browser</span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">lock</span>
      <span>No tracking, no ads, no third-party analytics</span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">hub</span>
      <span>{$_('settings_page.about.federation_prefix')}<a href="https://github.com/traceapps/nutritrace" target="_blank" rel="noopener" class="about-link">NutriTrace</a>{$_('settings_page.about.federation_suffix')}</span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-row">
      <span class="material-symbols-rounded about-feat-icon">code</span>
      <span>{$_('settings_page.about.family_prefix')}<a href="https://github.com/traceapps" target="_blank" rel="noopener" class="about-link">TraceApps</a>{$_('settings_page.about.family_suffix')}</span>
    </div>
    <div class="setting-divider"></div>
    <div class="about-row" style="flex-direction:column;align-items:flex-start;gap:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <span class="material-symbols-rounded about-feat-icon">volunteer_activism</span>
        <span>{$_('settings_page.about.support_dev')}</span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;padding-left:30px">
        <a href="https://ko-fi.com/traceapps" target="_blank" rel="noopener" class="btn btn-secondary" style="height:30px;font-size:12px;padding:0 12px">
          <span class="material-symbols-rounded" style="font-size:14px">coffee</span> Ko-fi
        </a>
      </div>
      <div class="setting-desc" style="padding-left:30px;font-size:11px">CookTrace is free to self-host. Donations are appreciated but never required.</div>
    </div>
    <div class="setting-divider"></div>
    <div class="about-desc" style="font-size:11px;color:var(--text-3);line-height:1.5">
      CookTrace is not medical or dietary software. Recipe nutrition values are
      estimates based on user-entered data and may contain inaccuracies. Always
      consult a healthcare professional for medical or dietary advice. Use at
      your own discretion.
    </div>
  </div>
</div>

<style>
  .about-hero {
    display: flex; align-items: center; gap: 14px;
    padding: 16px;
  }
  .about-icon {
    width: 56px; height: 56px; border-radius: 12px;
    flex-shrink: 0; object-fit: contain;
  }
  .about-name { font-size: 18px; font-weight: 700; color: var(--text-1); }
  .about-version { font-size: 12px; color: var(--text-3); margin-top: 2px; display: flex; align-items: center; gap: 6px; }
  .platform-tag {
    font-size: 10px; font-weight: 700; letter-spacing: 0.05em;
    padding: 2px 6px; border-radius: var(--radius-sm);
    background: var(--accent-dim); color: var(--accent);
  }
  .about-desc {
    font-size: 13px; color: var(--text-2); line-height: 1.6;
    padding: 14px 16px;
  }
  .about-row {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 16px;
    font-size: 13px; color: var(--text-2);
  }
  .about-feat-icon {
    font-size: 18px; color: var(--accent);
    width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .about-link {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
