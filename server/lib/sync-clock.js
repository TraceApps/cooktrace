/**
 * Edit times from devices, on the server's clock.
 *
 * A device stamps an edit with its own clock when the edit is made, which
 * may be days before it syncs, and that clock may be minutes off. The push
 * says what time the device thinks it is (client_now), so its edit times
 * can be moved onto the server's clock before two edits of one row are
 * compared: the newer one stays.
 */

// A time as stored here or sent by a device: SQLite's datetime('now')
// ("YYYY-MM-DD HH:MM:SS", UTC with no zone), with or without fractions,
// or ISO 8601. NaN when it isn't one.
export function utcMs(v) {
  if (v == null || v === '') return NaN;
  let s = String(v).trim();
  if (/^\d{4}-\d\d-\d\d$/.test(s)) s += 'T00:00:00';
  s = s.replace(/^(\d{4}-\d\d-\d\d) /, '$1T');
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s)) s += 'Z';
  return Date.parse(s);
}

// How far the device's clock is behind the server's: the server's time when
// the push arrived (`receivedAt`, taken before its body was read, so an
// upload's time doesn't count) less the device's time when it sent it. A
// clock any distance off is corrected: one reset to years ago is still the
// same device, editing now. 0 when the device doesn't say (older apps).
export function clockOffset(clientNow, receivedAt = Date.now()) {
  if (typeof clientNow !== 'string') return 0;
  const t = utcMs(clientNow);
  if (!Number.isFinite(t)) return 0;
  return (Number.isFinite(receivedAt) ? receivedAt : Date.now()) - t;
}

const _fmt = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// A device's edit time on the server's clock, stored as the server stores
// its own. One that can't be read is kept as it came. No edit arriving now
// was made later than now: a clock running fast would otherwise leave a
// time no other device's edit can beat.
export function editTime(updatedAt, offsetMs) {
  const now = Date.now();
  if (updatedAt == null || updatedAt === '') return _fmt(now);
  const t = utcMs(updatedAt);
  if (!Number.isFinite(t)) return updatedAt;
  // A correction that lands before 2000 came from a clock that can't be
  // right (a device set to the year 9999): the edit is taken as made now.
  const c = t + offsetMs;
  if (!Number.isFinite(c) || c < Date.UTC(2000, 0, 1)) return _fmt(now);
  return _fmt(Math.min(c, now));
}

/** The later of two times, either one possibly missing. */
export function latestTime(a, b) {
  const x = utcMs(a), y = utcMs(b);
  if (!Number.isFinite(y)) return a;
  if (!Number.isFinite(x)) return b;
  return y > x ? b : a;
}

// Edit times are whole seconds, so two times this close are a tie.
export const TIE_MS = 1000;

// Whether the server's copy of a row is newer than an edit arriving now
// (already on the server's clock). A tie goes to the arriving edit.
export function serverIsNewer(serverUpdatedAt, editedAt) {
  const a = utcMs(serverUpdatedAt);
  const b = utcMs(editedAt);
  return Number.isFinite(a) && Number.isFinite(b) && a > b + TIE_MS;
}
