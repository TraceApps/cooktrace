/**
 * The cook timers, rung by the phone itself in the Android app (#77).
 *
 * The countdown here is JavaScript in a WebView, and Android stops that soon
 * after the screen locks or the app is left, which is when a cook walks away
 * from the pan. So every running timer is handed to the phone
 * (KitchenTimersPlugin), which rings it at its end, through the lock screen
 * and with the app closed, and shows it counting in the notification shade
 * with +1 Min and Stop. The page then plays no alarm of its own: one alarm,
 * not two.
 *
 * Those buttons work with the app closed, so the phone's list can be newer
 * than this one. Each change is stamped, and whichever is newer wins: the app
 * reads the phone's list when it comes back to the front, and hears at once
 * while it is running.
 *
 * With notifications turned off for the app, the phone can only sound once,
 * so the page rings timers itself again whenever it can.
 */
import { get } from 'svelte/store';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { cookTimers, adoptNativeTimers, ringNatively } from '../stores/cookTimers.js';
import { tr } from './messages.js';

let KitchenTimers = registerPlugin('KitchenTimers');
const SEEN = 'ct:kitchentimersat';
const TOLD = 'ct:kitchentimerids';

// The phone's last change this app has taken in. Kept across reloads, and in
// memory too, for when storage can't be written.
let seenAt = 0;
function seen() {
  try { seenAt = Math.max(seenAt, Number(localStorage.getItem(SEEN) || 0) || 0); } catch {}
  return seenAt;
}
function setSeen(at) {
  // Never backwards: an answer can arrive after a newer change was heard.
  if (at <= seen()) return;
  seenAt = at;
  try { localStorage.setItem(SEEN, String(at)); } catch {}
}

// The timers the phone has heard of. One it hasn't is new here, not stopped
// there, however its start compares with the phone's last change: a timer
// started a moment before a Stop pressed on another one is still on its way.
let told = null;
function toldIds() {
  if (!told) {
    try { told = new Set(JSON.parse(localStorage.getItem(TOLD) || '[]')); } catch { told = new Set(); }
  }
  return told;
}
function tell(ids) {
  told = new Set(ids);
  try { localStorage.setItem(TOLD, JSON.stringify([...told])); } catch {}
}

/** The timers as the phone needs them: who, what for, and when. */
function forPhone(list = get(cookTimers)) {
  return list
    .filter(t => t && !t.dismissed && Number.isFinite(Number(t.endsAt)))
    .map(t => ({
      id: String(t.id),
      label: String(t.label || ''),
      recipe: String(t.recipeName || t.recipe || ''),
      endsAt: Number(t.endsAt),
      total: Number(t.durationSec ?? t.total) || 0,
    }));
}

/** What tells two lists apart for the phone: a timer's end, not its count. */
const shape = (timers) => JSON.stringify(timers.map(t => [t.id, t.label, t.recipe, t.endsAt]));

/** What the notifications say, in the app's language. */
function words() {
  return {
    timer: tr('cook_timers.timer', 'Timer'),
    done: tr('cook_timers.done_title', 'Timer Done'),
    add: tr('cook_timers.add_minute', '+1 Min'),
    stop: tr('cook_timers.stop', 'Stop'),
    channel: tr('cook_timers.channel', 'Cook Timers'),
    alarm_channel: tr('cook_timers.alarm_channel', 'Timer Alarms'),
  };
}

let last = null;     // the shape the phone was last given or gave
let pending = null;
let asked = false;

/** The phone's answer: who rings, and the change it is now as of. */
function heard(state) {
  if (!state) return;
  ringNatively(state.notify !== false);
  if (Number(state.at) > 0) setSeen(Number(state.at));
}

/** The phone's list, taken as the later word. */
function adopt(state) {
  const at = Number(state?.at) || 0;
  heard(state);
  const theirs = forPhone(Array.isArray(state?.timers) ? state.timers : []);
  last = shape(theirs);
  const heardOf = toldIds();
  adoptNativeTimers(theirs, (t) => !heardOf.has(String(t.id)));
  tell(theirs.map(t => t.id));
  // Anything kept here that the phone lacks (started since) goes back to it.
  if (shape(forPhone()) !== last) later();
}

async function send() {
  pending = null;
  const timers = forPhone();
  const now = shape(timers);
  if (now === last) return;
  try {
    const state = await KitchenTimers.sync({ timers, words: words(), since: seen() });
    if (state?.taken === false) { adopt(state); return; }
    heard(state);
    tell(timers.map(t => t.id));
    last = now;
  } catch { /* the page keeps counting; the phone hears on the next change */ }
}

function later() {
  if (pending != null) clearTimeout(pending);
  pending = setTimeout(send, 300);
}

/** Back in front: anything a notification changed meanwhile. */
async function catchUp() {
  try {
    const state = await KitchenTimers.read();
    if (Number(state?.at) > seen()) adopt(state);
    else heard(state);
  } catch {}
  later();
}

/**
 * The first timer asks for notifications (Android 13 and later need the
 * person's yes), since that is where "Timer done" rings.
 */
async function askOnce(timers) {
  if (asked || !timers.some(t => t.endsAt > Date.now())) return;
  asked = true;
  try {
    const { requestPermission } = await import('./notifications.js');
    // Allowed now: the phone shows the countdowns it couldn't before, and
    // rings from here on.
    if (await requestPermission()) heard(await KitchenTimers.rearm());
  } catch {}
}

let started = false;

/** Starts in the Android app. `plugin` stands in for the phone in tests. */
export function phoneTimers(plugin = null) {
  if (started) return;
  if (plugin) KitchenTimers = plugin;
  else if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;
  started = true;
  // The phone rings from the start; the first answer says if it can.
  ringNatively(true);
  Promise.resolve(KitchenTimers.addListener('changed', adopt)).catch(() => {});
  cookTimers.subscribe((list) => {
    const timers = forPhone(list);
    if (shape(timers) === last) return;
    askOnce(timers);
    later();
  });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') catchUp();
    });
  }
  catchUp();
}
