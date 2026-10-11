/**
 * format.js — date / time / number formatting that respects user settings.
 *
 * Use `formatDate(input, fmt)` in components by reading `$dateFormat` from
 * the settings store and passing it through. Naïve SQLite timestamps
 * (no timezone marker) are coerced to UTC to match what the server stored.
 */

import { get } from 'svelte/store';
import { locale } from 'svelte-i18n';
import { relativeTime } from './relative-time.js';

// The app's language, for month names ("May 4, 2026", "4 may 2026").
function _locale() {
  try { return get(locale) || undefined; } catch { return undefined; }
}

function _toDate(input) {
  if (input == null || input === '') return null;
  if (input instanceof Date) return input;
  if (typeof input !== 'string') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // A day ("2026-10-09", a cook's date) is that day where the user is. Read
  // as UTC midnight it showed a day early anywhere west of UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [y, m, d] = input.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  // SQLite-naïve timestamp ("YYYY-MM-DD HH:MM:SS"): treat as UTC.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(input)) {
    const d = new Date(input.replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

function _pad(n) { return n < 10 ? `0${n}` : `${n}`; }

/**
 * Format a date according to the user's `dateFormat` setting.
 *   'ISO'     → 2026-05-04
 *   'US'      → 05/04/2026
 *   'EU'      → 04/05/2026
 *   'natural' → May 4, 2026   (default fallback)
 */
export function formatDate(input, fmt = 'natural') {
  const d = _toDate(input);
  if (!d) return '';
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  switch (fmt) {
    case 'ISO': return `${y}-${_pad(m)}-${_pad(day)}`;
    case 'US':  return `${_pad(m)}/${_pad(day)}/${y}`;
    case 'EU':  return `${_pad(day)}/${_pad(m)}/${y}`;
    case 'natural':
    default:    return d.toLocaleDateString(_locale(), { month: 'short', day: 'numeric', year: 'numeric' });
  }
}

/**
 * Smart "updated" formatter — shows relative time for recent edits,
 * absolute date once it's been a while. Threshold is 7 days.
 */
export function formatUpdated(input, fmt = 'natural') {
  const d = _toDate(input);
  if (!d) return '';
  const ageDays = (Date.now() - d.getTime()) / 86400000;
  // Recent edits read like the rest of the app ("3 Hours Ago"), in its language.
  if (ageDays < 7) return relativeTime(d);
  return formatDate(d, fmt);
}

/** Extract a clean domain from a URL ("https://www.seriouseats.com/x" → "seriouseats.com"). */
export function domainFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
