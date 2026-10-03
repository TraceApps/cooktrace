// Install console.* wrappers BEFORE any other import logs anything,
// so the in-app diagnostic-log buffer captures the full app lifecycle.
import { setAppVersion } from './lib/log-capture.js';
import { APP_VERSION } from './lib/version.js';
if (typeof window !== 'undefined') window.__APP_VERSION__ = APP_VERSION;
setAppVersion(APP_VERSION);

import './styles/tokens.css';
import './styles/base.css';
import './styles/typography.css';
import './styles/animations.css';
import './styles/buttons.css';
import './styles/forms.css';
// Last, so its rules win over the layouts they move off a crease.
import './styles/fold.css';
import { DB } from './lib/db.js';
import { waitLocale } from 'svelte-i18n';
import { initI18n } from './i18n/index.js';
import { publicRecipeToken } from './lib/platform.js';

// Pick browser-detected locale for first paint; the App-level subscription to
// the `language` store flips it to the user's saved preference once that loads.
initI18n();

// Sync system theme changes when appearance = 'system'
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
  const appearance = localStorage.getItem('wl_appearance') || 'system';
  if (appearance === 'system') {
    document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    const meta = document.getElementById('theme-color-meta');
    if (meta) meta.content = e.matches ? '#0A0B0F' : '#F5F7FA';
  }
});

// A public recipe link (/r/<token>) opens on its own: no sign-in, no local
// database, no sync, just the recipe. Inside the app the login screen stood
// in front of it, so nobody without an account could open a shared link.
const publicToken = publicRecipeToken();
if (publicToken) {
  // The locale files load on demand, and the page has no app to wait for them.
  Promise.all([import('./routes/PublicRecipePage.svelte'), waitLocale()]).then(([{ default: PublicRecipePage }]) => {
    new PublicRecipePage({ target: document.getElementById('app'), props: { token: publicToken } });
  });
} else {
  boot();
}

function boot() {
  DB.init()
    .then(async () => {
      // Local SQLite layer: open the connection + run the schema before the
      // app mounts so the first NtApi call has a working DB underneath it.
      // No-op on web. Lazy on subsequent calls because getDb() memoises.
      const { isNative } = await import('./lib/platform.js');
      if (isNative) {
        const { dbInit } = await import('./lib/db-native.js');
        await dbInit();
        const { loadImageMap } = await import('./lib/platform.js');
        await loadImageMap();
      }
      // Loaded here rather than at the top so a public recipe link never pulls
      // in the app, whose stores start fetching account data as they load.
      const { default: App } = await import('./App.svelte');
      new App({ target: document.getElementById('app') });
    })
    .catch(err => {
      console.error('DB init failed:', err);
      document.getElementById('app').innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                    height:100dvh;padding:32px;text-align:center;gap:16px;font-family:sans-serif;">
          <span style="font-size:48px">⚠️</span>
          <h2 style="color:#F0F2F8">Database Error</h2>
          <p style="color:rgba(240,242,248,0.6);max-width:300px">
            Could not open the local database. Try closing other tabs or clearing site data.
          </p>
          <button onclick="location.reload()"
            style="padding:12px 24px;border-radius:12px;background:#4FFFB0;
                   color:#0A0B0F;font-weight:600;border:none;cursor:pointer;font-size:15px;">
            Retry
          </button>
        </div>`;
    });
}
