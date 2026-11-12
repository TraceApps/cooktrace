import { register, init, getLocaleFromNavigator } from 'svelte-i18n';

// Languages with a dedicated locale file. As contributors add translations,
// register them here and add an entry to AVAILABLE_LOCALES so the language
// picker in Settings → Regional & Units shows the new option.
register('en', () => import('./en.json'));
register('es', () => import('./es.json'));
register('fr', () => import('./fr.json'));
register('sv', () => import('./sv.json'));

export const AVAILABLE_LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'sv', label: 'Svenska' },
];

export function initI18n(initialLocale) {
  init({
    fallbackLocale: 'en',
    initialLocale: initialLocale || pickInitialLocale(),
    // Log missing-key warnings to the browser console only in dev — in
    // production builds they'd spam the console for users running a locale
    // that isn't fully translated yet.
    warnOnMissingMessages: !!import.meta.env.DEV,
  });
}

/**
 * The locale to use when the user has never chosen one: the browser or
 * phone's own language if we have it, English otherwise.
 *
 * Exported because the `language` setting defaults to the same value
 * (nutritrace#323). With a hardcoded 'en' default, App.svelte switched a Spanish
 * browser back to English as soon as it mounted. LiftTrace does the same.
 */
export function pickInitialLocale() {
  // No browser (stores loaded by tests in Node): English.
  let nav = null;
  try { nav = getLocaleFromNavigator(); } catch { /* no navigator */ }
  if (!nav) return 'en';
  const short = nav.split('-')[0];
  return AVAILABLE_LOCALES.some(l => l.code === short) ? short : 'en';
}
