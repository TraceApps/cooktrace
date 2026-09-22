/**
 * The clock, shared between the phone and the wrist.
 *
 * A cook is one activity in one kitchen: the phone is propped on the counter
 * because that is where the recipe is readable, and the watch is the thing
 * that walks away with you. Splitting the timers between them defeats having
 * both, so whichever device set one, both hold it and either can ring you.
 *
 * Only while a cook has been handed to the watch. That is an explicit act,
 * pressing Cook on the phone, and it is the gate for all of this: off a cook,
 * nothing is sent, the watch is never woken to hear about a timer, and it
 * never schedules an alarm for one. A watch in a drawer stays in the drawer.
 *
 * Every write to the Data Layer starts the watch's listener service, so a
 * burst of changes settles into one write rather than one per tap.
 */
import { get } from 'svelte/store';
import { isNative } from './platform.js';
import { cookTimers, adoptTimers } from '../stores/cookTimers.js';
import { activeCooks, cookList } from '../stores/cooks.js';
import { publishTimers, readTimers } from './wear-pairing.js';

const STAMP = 'ct:timersat';

/** Is there a cook on the watch to share a clock with? */
export function sharingTimers() {
  return cookList(get(activeCooks)).some(c => c.serverId > 0);
}

function stamp() {
  try { return Number(localStorage.getItem(STAMP) || 0) || 0; } catch { return 0; }
}
function setStamp(at) {
  try { localStorage.setItem(STAMP, String(at)); } catch {}
}

/** The timers as the watch needs them: a key, a label and a deadline. */
function forWatch() {
  const now = Date.now();
  return get(cookTimers)
    .filter(t => t && !t.dismissed && !t.done && Number(t.endsAt) > now)
    .sort((a, b) => a.endsAt - b.endsAt)
    // The watch runs eight at once, which is already more pans than hands.
    .slice(0, 8)
    .map(t => ({
      key: String(t.id),
      label: String(t.label || ''),
      total: Number(t.durationSec) || 0,
      endsAt: Number(t.endsAt) || 0,
    }));
}

let pending = null;
let last = '';

/** Tell the watch what is counting, once the changes settle. */
export function tellWatch({ now = false } = {}) {
  if (!isNative) return;
  const send = () => {
    pending = null;
    if (!sharingTimers()) {
      // Off a cook, forget what was last sent. Otherwise a timer still
      // running when the next cook starts would match the last shape and be
      // held back as "nothing new", leaving the watch without it.
      last = '';
      return;
    }
    const timers = forWatch();
    // Nothing to say: the ticking itself changes nothing on the wire, since
    // every timer is a deadline rather than a count.
    const shape = JSON.stringify(timers);
    if (shape === last) return;
    last = shape;
    const at = Date.now();
    setStamp(at);
    publishTimers(timers, at).catch(() => {});
  };
  if (pending != null) clearTimeout(pending);
  if (now) send();
  else pending = setTimeout(send, 800);
}

/** The watch started, extended or stopped one. Take its word if it is newer. */
export async function hearWatch() {
  if (!isNative || !sharingTimers()) return;
  const at = stamp();
  const theirs = await readTimers(at);
  if (theirs === undefined) return;
  // The stamp this device last sent: anything started here since then is
  // newer than what the watch could have seen.
  adoptTimers(theirs, at);
  // What was adopted is now this device's state too, so the stamp moves with
  // it and the same record is not adopted again on the next look.
  setStamp(Date.now());
  last = JSON.stringify(forWatch());
}

let started = false;

/**
 * Follow the timers for as long as the app is running. The subscription is
 * free when there is no cook: the gate is checked before anything is sent.
 */
export function watchTimers() {
  if (!isNative || started) return;
  started = true;
  cookTimers.subscribe(() => tellWatch());
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      hearWatch().catch(() => {});
    });
  }
  hearWatch().catch(() => {});
}
