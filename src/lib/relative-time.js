/**
 * relative-time.js — short, friendly "x ago" / "in x" formatting.
 *
 * Pure function, no Intl.RelativeTimeFormat dependency (works in older
 * browsers + Capacitor WebView). Output matches NT's tone ("3d ago",
 * "just now", "2 weeks ago").
 */

export function relativeTime(input, now = Date.now()) {
  if (!input) return '';
  const date = _toDate(input);
  if (!date || Number.isNaN(date.getTime())) return '';

  // A day ("2026-10-10": a cook's date, when a recipe was last cooked) has
  // no time of day, so it counts in days: read as midnight and counted in
  // hours, a cook logged at 9:31 PM said "21 Hours Ago".
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) return _days(date, now);

  const diffSec = Math.round((now - date.getTime()) / 1000);
  const future = diffSec < 0;
  const sec = Math.abs(diffSec);

  if (sec < 45)             return future ? 'In Moments' : 'Just Now';
  if (sec < 90)             return future ? 'In a Minute' : 'A Minute Ago';
  if (sec < 60 * 45)        return _fmt(Math.round(sec / 60), 'Minute', future);
  if (sec < 60 * 90)        return future ? 'In an Hour' : 'An Hour Ago';
  if (sec < 60 * 60 * 22)   return _fmt(Math.round(sec / 3600), 'Hour', future);
  if (sec < 60 * 60 * 36)   return future ? 'Tomorrow' : 'Yesterday';
  if (sec < 60 * 60 * 24 * 26)  return _fmt(Math.round(sec / 86400), 'Day', future);
  if (sec < 60 * 60 * 24 * 45)  return future ? 'In a Month' : 'A Month Ago';
  if (sec < 60 * 60 * 24 * 320) return _fmt(Math.round(sec / (86400 * 30)), 'Month', future);
  if (sec < 60 * 60 * 24 * 548) return future ? 'In a Year' : 'A Year Ago';
  return _fmt(Math.round(sec / (86400 * 365)), 'Year', future);
}

// Whole calendar days between a day and today, by the local calendar.
function _days(day, now) {
  const today = new Date(now);
  const a = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate());
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const n = Math.round((b - a) / 86400000);
  const future = n < 0;
  const d = Math.abs(n);
  if (d === 0)   return 'Today';
  if (d === 1)   return future ? 'Tomorrow' : 'Yesterday';
  if (d < 26)    return _fmt(d, 'Day', future);
  if (d < 45)    return future ? 'In a Month' : 'A Month Ago';
  if (d < 320)   return _fmt(Math.round(d / 30), 'Month', future);
  if (d < 548)   return future ? 'In a Year' : 'A Year Ago';
  return _fmt(Math.round(d / 365), 'Year', future);
}

function _fmt(n, unit, future) {
  // unit is already Title Case ("Minute", "Day", "Year"). Pluralize and
  // wrap with "Ago" / "In" to keep the whole label in Title Case.
  const plural = n === 1 ? unit : `${unit}s`;
  return future ? `In ${n} ${plural}` : `${n} ${plural} Ago`;
}

/** Short absolute date: "May 4, 2026". */
export function shortDate(input) {
  if (!input) return '';
  const d = _toDate(input);
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Coerce server-supplied timestamps into Date objects.
 *
 * SQLite's `datetime('now')` returns a naïve string ("2026-05-04 03:30:00")
 * with no timezone marker — JavaScript would parse that as LOCAL time and
 * we'd end up off by the user's UTC offset (showing "in 4 hours" for a
 * value that was just written by the server). Detect that format and append
 * "Z" so it parses as UTC, matching what SQLite actually stored.
 */
function _toDate(input) {
  if (input instanceof Date) return input;
  if (typeof input !== 'string') return new Date(input);
  // Date-only string ("YYYY-MM-DD"): treat as LOCAL midnight, not UTC.
  // new Date("2026-05-14") parses as UTC midnight, which in any
  // western timezone resolves to May 13 local — showing the wrong day
  // in shortDate(). Diary `date` columns are date-only strings, so
  // this matters everywhere a cook-history date is rendered.
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [y, m, d] = input.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  // SQLite-naïve timestamp: "YYYY-MM-DD HH:MM:SS" (no timezone, no T)
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(input)) {
    return new Date(input.replace(' ', 'T') + 'Z');
  }
  return new Date(input);
}
