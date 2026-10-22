/**
 * Cook timers that ring when nobody is looking (#77).
 *
 * In a browser, each timer has a one-shot timeout at its exact end, so a tab
 * whose once-a-second ticker is being held back still rings on time. In the
 * Android app the phone rings them (KitchenTimers): every running timer is
 * handed over, the page plays no alarm of its own, and a +1 Min or Stop
 * pressed on the lock screen comes back to the app as the later word.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';

// The store only ticks in a browser.
globalThis.window = globalThis;
const timeouts = [];
const intervals = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => { const h = { fn, ms, cleared: false }; timeouts.push(h); return h; };
globalThis.clearTimeout = (h) => { if (h && typeof h === 'object') h.cleared = true; };
globalThis.setInterval = (fn, ms) => { const h = { fn, ms }; intervals.push(h); return h; };
globalThis.clearInterval = () => {};
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));

const { cookTimers, startTimer, dismissTimer, addOneMinute, ringNatively, adoptNativeTimers } =
  await import('../src/stores/cookTimers.js');

function reset() {
  for (const t of get(cookTimers)) dismissTimer(t.id);
  cookTimers.set([]);
  timeouts.length = 0;
  intervals.length = 0;
}
const live = () => timeouts.filter((h) => !h.cleared);
const alarms = () => intervals.filter((h) => h.ms === 1400);

test('each timer has a timeout at its exact end, which rings it', () => {
  reset();
  ringNatively(false);
  const t = startTimer({ label: 'Eggs', durationSec: 240 });
  const end = live().find((h) => h.ms >= 240_000 && h.ms < 241_000);
  assert.ok(end, 'a one-shot timeout at the end');
  clock += 240_100;
  end.fn();
  assert.equal(get(cookTimers).find((x) => x.id === t.id).done, true);
  assert.equal(alarms().length, 1, 'the page rings it');
  dismissTimer(t.id);
});

test('+1 min moves the timeout, and stopping a timer drops it', () => {
  reset();
  const t = startTimer({ label: 'Rice', durationSec: 600 });
  const first = live().find((h) => h.ms >= 600_000);
  addOneMinute(t.id);
  assert.equal(first.cleared, true);
  assert.ok(live().some((h) => h.ms >= 660_000 && h.ms < 661_000));
  dismissTimer(t.id);
  assert.equal(live().filter((h) => h.ms >= 60_000).length, 0);
});

test('with the phone ringing timers, the page does not ring too', () => {
  reset();
  ringNatively(true);
  const t = startTimer({ label: 'Pasta', durationSec: 60 });
  clock += 60_100;
  live().find((h) => h.ms >= 60_000).fn();
  assert.equal(get(cookTimers).find((x) => x.id === t.id).done, true, 'still shown as done');
  assert.equal(alarms().length, 0, 'no second alarm from the page');
  dismissTimer(t.id);
  ringNatively(false);
});

test("the phone's list is the later word: Stop and +1 Min from the lock screen", () => {
  reset();
  const a = startTimer({ label: 'Simmer', durationSec: 600 });
  const b = startTimer({ label: 'Rest', durationSec: 60 });
  clock += 61_000;
  live().find((h) => h.ms >= 60_000 && h.ms < 61_000).fn();
  assert.equal(get(cookTimers).find((x) => x.id === b.id).done, true);
  // Stop on the first, +1 Min on the one that rang.
  adoptNativeTimers([{ id: b.id, label: 'Rest', endsAt: clock + 60_000, total: 120 }]);
  const mine = get(cookTimers);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, b.id);
  assert.equal(mine[0].done, false);
  assert.equal(mine[0].endsAt, clock + 60_000);
  void a;
});

test('a timer the phone has not been told of yet is kept', () => {
  reset();
  const told = startTimer({ label: 'Soup', durationSec: 120 });
  const fresh = startTimer({ label: 'Toast', durationSec: 120 });
  adoptNativeTimers([], (t) => t.id === fresh.id);
  assert.deepEqual(get(cookTimers).map((t) => t.id), [fresh.id]);
  void told;
});

/** A phone that behaves like KitchenTimersPlugin: stamped, later word wins. */
function fakePhone() {
  const phone = { timers: [], at: 0, notify: true, synced: [], listeners: [] };
  phone.plugin = {
    async sync({ timers, words, since }) {
      phone.synced.push({ timers, words, since });
      if (phone.at > since) return { taken: false, timers: phone.timers, at: phone.at, notify: phone.notify };
      phone.timers = timers.map((t) => ({ ...t }));
      phone.at = clock;
      return { taken: true, timers: phone.timers, at: phone.at, notify: phone.notify };
    },
    async read() { return { timers: phone.timers, at: phone.at, notify: phone.notify }; },
    addListener(name, fn) { phone.listeners.push(fn); return Promise.resolve({ remove() {} }); },
  };
  // A button on the notification, with the app not looking.
  phone.press = (change) => {
    clock += 5;
    phone.timers = change(phone.timers);
    phone.at = clock;
    for (const fn of phone.listeners) fn({ timers: phone.timers, at: phone.at, notify: phone.notify });
  };
  return phone;
}

test('the Android app hands its timers to the phone, and hears its buttons', async () => {
  reset();
  globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, Math.min(ms, 5));
  const phone = fakePhone();
  const { phoneTimers } = await import('../src/lib/native-timers.js');
  phoneTimers(phone.plugin);
  await wait(30);

  const t = startTimer({ label: 'Onions', durationSec: 900, recipeName: 'Soup' });
  await wait(30);
  const sent = phone.synced.at(-1);
  assert.equal(sent.timers.length, 1);
  assert.equal(sent.timers[0].id, t.id);
  assert.equal(sent.timers[0].recipe, 'Soup');
  assert.equal(sent.timers[0].endsAt, t.endsAt);
  assert.equal(sent.words.done, 'Timer Done');
  assert.deepEqual(phone.timers.map((x) => x.id), [t.id]);

  // Stop on the lock screen: gone from the app too, and not sent back.
  const before = phone.synced.length;
  phone.press(() => []);
  await wait(30);
  assert.equal(get(cookTimers).length, 0);
  assert.equal(phone.synced.length, before, 'nothing to tell the phone');

  // A sync that missed a change made on the phone gets that change first,
  // and the timer started here since goes back on top of it.
  const kept = { id: 'k1', label: 'Bread', recipe: '', endsAt: clock + 300_000, total: 300 };
  phone.timers = [kept];
  phone.at = clock + 1;
  clock += 2;
  const mine = startTimer({ label: 'Garlic', durationSec: 60 });
  await wait(40);
  assert.deepEqual(get(cookTimers).map((x) => x.id).sort(), ['k1', mine.id].sort());
  assert.deepEqual(phone.timers.map((x) => x.id).sort(), ['k1', mine.id].sort());

  // A timer started a moment before Stop is pressed on another in the
  // shade, before the app has told the phone of it: kept, and then told.
  const quick = startTimer({ label: 'Eggs', durationSec: 240 });
  clock += 50;
  phone.press((list) => list.filter((x) => x.id !== 'k1'));
  await wait(40);
  assert.deepEqual(get(cookTimers).map((x) => x.id).sort(), [mine.id, quick.id].sort());
  assert.deepEqual(phone.timers.map((x) => x.id).sort(), [mine.id, quick.id].sort());
});
