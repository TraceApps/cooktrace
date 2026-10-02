/**
 * cookTimers — global running-timer store.
 *
 * Multiple concurrent timers, each with a label and an end time. The
 * store ticks once per second and emits the same array on every tick
 * so the UI keeps live remaining-time labels current.
 *
 * Persistence: every timer is mirrored to localStorage so a tab refresh
 * mid-cook doesn't drop them. Completed timers stay in the list with
 * `done: true` until the user dismisses them, so a brief tab away
 * doesn't lose the chime opportunity.
 *
 * Audio + haptics:
 *  - With 3 / 2 / 1 seconds left we fire a short single-tone warn beep
 *    plus a 150ms vibration tap.
 *  - On hit-zero we start a looping ring-ring alarm (two-beep pattern,
 *    repeats ~1.4s) and a longer vibration burst until the user
 *    dismisses or +1's the timer.
 *
 * iOS needs a user-gesture-resumed AudioContext; we attempt resume on
 * each play and live with silent fallbacks (the Notification covers it).
 */
import { writable, get } from 'svelte/store';

const STORAGE_KEY = 'ct:timers';

// Shape: [{ id, label, recipeId?, stepIndex?, durationSec, endsAt, done, dismissed }]
function _load() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(t => t && typeof t.id === 'string' && Number.isFinite(t.endsAt));
  } catch { return []; }
}
function _save(timers) {
  if (typeof localStorage === 'undefined') return;
  try {
    // Drop dismissed entries from persistence — no point reloading dust.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(timers.filter(t => !t.dismissed)));
  } catch {}
}

export const cookTimers = writable(_load());

let _tickInterval = null;
let _audioCtx = null;

// Per-timer ephemeral state. Not persisted because it's tied to the
// active session — on reload, _lastSecondsLeft is undefined and the
// ticker just resumes from whatever's left without re-firing past
// warnings (good — we don't want a re-fired 3-2-1 beep on refresh).
const _lastSecondsLeft = new Map(); // timerId -> int seconds remaining last tick
const _alarmLoops      = new Map(); // timerId -> intervalId

function _ensureAudio() {
  if (typeof window === 'undefined') return null;
  try {
    if (!_audioCtx && typeof AudioContext !== 'undefined') {
      _audioCtx = new AudioContext();
    }
    if (_audioCtx && _audioCtx.state === 'suspended') {
      _audioCtx.resume().catch(() => {});
    }
  } catch {}
  return _audioCtx;
}

/** Single short pre-warning beep — fires on 3, 2, 1 seconds left. */
function _playWarnBeep() {
  const ctx = _ensureAudio();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.22, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
    osc.start(t0);
    osc.stop(t0 + 0.14);
  } catch {}
}

/** One ring-ring cycle (two short bursts) of the alarm sound. Called
 *  repeatedly by the alarm loop until the user dismisses or +1's. */
function _playAlarmRing() {
  const ctx = _ensureAudio();
  if (!ctx) return;
  try {
    const base = ctx.currentTime;
    // Two close-together ~120ms beeps with a 60ms gap between them.
    // Higher amplitude than the warn beep so it cuts through ambient
    // kitchen noise.
    [0, 0.18].forEach(off => {
      const t0 = base + off;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 950;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.18, t0 + 0.012);
      gain.gain.linearRampToValueAtTime(0.18, t0 + 0.10);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
      osc.start(t0);
      osc.stop(t0 + 0.14);
    });
  } catch {}
}

function _startAlarmLoop(timerId) {
  if (_alarmLoops.has(timerId)) return;
  _playAlarmRing();
  _vibrate([400, 200, 400, 200, 400]);
  // Re-trigger every 1.4s. setInterval is OK here because the loop is
  // bounded by user action (dismiss / +1) rather than running forever.
  const id = setInterval(() => {
    _playAlarmRing();
    _vibrate(220);
  }, 1400);
  _alarmLoops.set(timerId, id);
}

function _stopAlarmLoop(timerId) {
  const id = _alarmLoops.get(timerId);
  if (id != null) {
    clearInterval(id);
    _alarmLoops.delete(timerId);
  }
}

function _vibrate(pattern) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {}
}

function _ensureTicker() {
  if (_tickInterval || typeof window === 'undefined') return;
  _tickInterval = setInterval(() => {
    const list = get(cookTimers);
    if (list.length === 0) return;
    const now = Date.now();
    let mutated = false;
    const next = list.map(t => {
      if (!t.done) {
        // Pre-warn at 3 / 2 / 1 seconds remaining — beep + short
        // vibration on each transition. Use Math.ceil so we fire when
        // the displayed seconds-left flips, not when the underlying
        // millis pass through the boundary.
        const secondsLeft = Math.max(0, Math.ceil((t.endsAt - now) / 1000));
        const last = _lastSecondsLeft.get(t.id);
        if (last !== secondsLeft) {
          _lastSecondsLeft.set(t.id, secondsLeft);
          if (secondsLeft === 3 || secondsLeft === 2 || secondsLeft === 1) {
            _playWarnBeep();
            _vibrate(140);
          }
        }
        if (now >= t.endsAt) {
          mutated = true;
          _onComplete(t);
          return { ...t, done: true };
        }
      }
      return t;
    });
    // Always emit so live remaining-time labels update; only persist on
    // structural changes.
    cookTimers.set(next);
    if (mutated) _save(next);
  }, 1000);
}

function _onComplete(timer) {
  _startAlarmLoop(timer.id);

  // Browser notification (best-effort; user may not have granted permission).
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('Timer done', {
        body: timer.label || 'Cook timer finished',
        tag: timer.id,
        silent: false,
      });
    }
  } catch {}
}

export function startTimer({ label, durationSec, recipeId = null, recipeName = null, stepIndex = null }) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  _ensureTicker();
  // Best-effort notification permission ask on first start. The chime
  // works without it; the notification is a bonus.
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  } catch {}
  // First user-gesture-driven start is also a good place to nudge
  // AudioContext into a resumed state so iOS lets later beeps play.
  _ensureAudio();
  const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const timer = {
    id,
    label: label || 'Timer',
    // recipeName persisted on the timer so the global pill can display
    // it after the user has navigated away from the recipe page.
    recipeName: recipeName || null,
    recipeId,
    stepIndex,
    durationSec,
    startedAt: Date.now(),
    endsAt: Date.now() + durationSec * 1000,
    done: false,
    dismissed: false,
  };
  const next = [...get(cookTimers), timer];
  cookTimers.set(next);
  _save(next);
  return timer;
}

export function dismissTimer(id) {
  _stopAlarmLoop(id);
  _lastSecondsLeft.delete(id);
  const next = get(cookTimers).filter(t => t.id !== id);
  cookTimers.set(next);
  _save(next);
}

export function dismissAllDone() {
  for (const t of get(cookTimers)) {
    if (t.done) {
      _stopAlarmLoop(t.id);
      _lastSecondsLeft.delete(t.id);
    }
  }
  const next = get(cookTimers).filter(t => !t.done);
  cookTimers.set(next);
  _save(next);
}

export function addOneMinute(id) {
  // "+1 min" on a still-running timer pushes endsAt out by 60s and
  // un-marks done if it was just rung but the user wasn't ready.
  // Stops the alarm loop in either case so the user gets quiet while
  // the new 60s window plays out.
  _stopAlarmLoop(id);
  _lastSecondsLeft.delete(id);
  const list = get(cookTimers);
  const next = list.map(t => {
    if (t.id !== id) return t;
    const baseEnds = t.done ? Date.now() : Math.max(t.endsAt, Date.now());
    return { ...t, endsAt: baseEnds + 60_000, done: false };
  });
  cookTimers.set(next);
  _save(next);
}

/**
 * What the watch says is counting, taken as the later word.
 *
 * Only the running ones are reconciled. A timer that has rung and is sitting
 * there waiting to be dismissed is this device's business, not the watch's:
 * the watch drops a timer the moment it rings, and treating that as "the
 * watch stopped it" would silence an alarm nobody had answered yet.
 */
export function adoptTimers(list, since = 0) {
  if (!Array.isArray(list)) return;
  const now = Date.now();
  const theirs = new Map(
    list.filter(t => t && t.key && Number(t.endsAt) > now).map(t => [String(t.key), t]),
  );
  const mine = get(cookTimers);
  const next = [];
  for (const t of mine) {
    // Rung, or already counting down here and still counting there.
    if (t.done || t.dismissed) { next.push(t); continue; }
    const match = theirs.get(t.id);
    if (!match) {
      // A timer started here after the watch took its snapshot cannot be in
      // that snapshot, and its absence is not the watch saying it is over.
      // Without this, starting one on each device within a moment of the
      // other silently stops whichever was started first.
      if (since > 0 && Number(t.startedAt) > since) { next.push(t); continue; }
      // Gone from the watch: stopped there, so it stops here.
      _stopAlarmLoop(t.id);
      _lastSecondsLeft.delete(t.id);
      continue;
    }
    theirs.delete(t.id);
    const endsAt = Number(match.endsAt);
    next.push(endsAt === t.endsAt ? t : { ...t, endsAt });
  }
  // Started on the wrist, new to this device.
  for (const [key, t] of theirs) {
    const total = Number(t.total) || Math.max(1, Math.round((Number(t.endsAt) - now) / 1000));
    next.push({
      id: key,
      label: t.label || 'Timer',
      recipeName: null,
      recipeId: null,
      stepIndex: null,
      durationSec: total,
      startedAt: Number(t.endsAt) - total * 1000,
      endsAt: Number(t.endsAt),
      done: false,
      dismissed: false,
    });
  }
  const changed = next.length !== mine.length ||
    next.some((t, i) => t !== mine[i]);
  if (!changed) return;
  if (next.some(t => !t.done && !t.dismissed)) _ensureTicker();
  cookTimers.set(next);
  _save(next);
}

/** Format a remaining duration as "MM:SS" (or "H:MM:SS" past 1 hour). */
export function formatRemaining(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = n => n < 10 ? `0${n}` : `${n}`;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

// Boot the ticker if any timers are already alive at load time.
if (typeof window !== 'undefined' && get(cookTimers).length > 0) _ensureTicker();
