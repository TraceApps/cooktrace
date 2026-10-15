/**
 * Calendar days on the server: today is the server's own local date, and
 * days move on the bare YYYY-MM-DD in UTC, so neither the time of night nor
 * a daylight-saving change can land a cook on the wrong day. (Reading the
 * UTC date of "now" gave tomorrow on a New York evening, yesterday on a
 * Sydney morning.)
 */

/** Today as YYYY-MM-DD, by the server's clock and time zone. */
export function localToday(now = new Date()) {
  return now.toLocaleDateString('sv-SE');
}

/** A YYYY-MM-DD moved by n calendar days. */
export function shiftDay(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
