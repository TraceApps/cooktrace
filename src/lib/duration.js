/**
 * src/lib/duration.js — human-friendly duration formatting for minutes.
 *
 * Recipe times (prep / cook / total) are stored as raw minutes and
 * used to be rendered as `45m`. That worked fine at 5-59 min but got
 * unreadable at 120m+ ("how long is 375m again?"). This helper wraps
 * the render so the same value shows up as `2h 15m` — one call site,
 * one convention.
 *
 * Rules:
 *   < 1 min          → ''      (caller decides whether to show anything)
 *   >= 1 && < 60 min → `Nm`    (unchanged from the old inline format)
 *   >= 60 min        → `Nh Mm` (or just `Nh` if the minutes part is 0)
 */
export function formatDuration(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return '';
  const total = Math.round(m);
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const rest = total % 60;
  if (rest === 0) return `${h}h`;
  return `${h}h ${rest}m`;
}
