/**
 * messages.js: what went wrong, said the same way everywhere.
 *
 * failed('fail.save_category', err) -> "Couldn't save the category: name is
 * required." The action names what couldn't be done (a `fail.*` string,
 * "Couldn't ..."); the reason is the error's own words, or that the server
 * can't be reached, or nothing when there's nothing useful to add.
 */
import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { isOfflineError } from './offline-edits.js';

const t = (key, values) => get(_)(key, values ? { values } : undefined);

// Messages that say nothing a person can use.
const EMPTY = /^(error|failed|unknown( error)?|undefined|null|\[object object\])$/i;
const HTTP_ONLY = /^((http|api error|server responded)\s*)?\d{3}(\s+[a-z ]+)?$/i;

/** An error as a reason: lowercase, no closing period, or '' when it adds nothing. */
export function reasonOf(err) {
  if (!err) return '';
  if (isOfflineError(err)) return t('fail.offline');
  let s = String(err?.message ?? err ?? '').trim().replace(/^error:\s*/i, '').replace(/[.\s]+$/, '');
  if (!s || EMPTY.test(s) || HTTP_ONLY.test(s)) return '';
  // "Name is required" -> "name is required"; "OIDC ..." and "NutriTrace ..." keep theirs.
  if (/^[A-Z][a-z']*\b(?![-.]?[A-Z])/.test(s) && !/^I\b/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  return s;
}

/** "Couldn't save the category: name is required." */
export function failed(key, err, values) {
  const what = t(key, values);
  const why = reasonOf(err);
  return why ? t('fail.because', { what, why }) : t('fail.plain', { what });
}
