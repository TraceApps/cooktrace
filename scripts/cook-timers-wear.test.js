/**
 * The clock shared between the phone and the wrist.
 *
 * The rules that matter: the watch's word is taken for what is running, a
 * timer that has rung here is this device's business until it is dismissed,
 * and nothing crosses at all unless a cook has been handed over.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { get } from 'svelte/store';
import { cookTimers, adoptTimers, startTimer, dismissTimer } from '../src/stores/cookTimers.js';

function reset() {
  for (const t of get(cookTimers)) dismissTimer(t.id);
  cookTimers.set([]);
}

test('a timer started on the wrist appears on the phone', () => {
  reset();
  const endsAt = Date.now() + 600_000;
  adoptTimers([{ key: 'w1-123', label: 'Onions', total: 600, endsAt }]);
  const mine = get(cookTimers);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, 'w1-123');
  assert.equal(mine[0].label, 'Onions');
  assert.equal(mine[0].endsAt, endsAt);
  assert.equal(mine[0].done, false);
});

test('stopping it on the wrist stops it here', () => {
  reset();
  const endsAt = Date.now() + 600_000;
  adoptTimers([{ key: 'w1-123', label: 'Onions', total: 600, endsAt }]);
  adoptTimers([]);
  assert.equal(get(cookTimers).length, 0);
});

test('extending it on the wrist moves the deadline, not the timer', () => {
  reset();
  const endsAt = Date.now() + 600_000;
  adoptTimers([{ key: 'w1-123', label: 'Onions', total: 600, endsAt }]);
  adoptTimers([{ key: 'w1-123', label: 'Onions', total: 900, endsAt: endsAt + 300_000 }]);
  const mine = get(cookTimers);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, 'w1-123');
  assert.equal(mine[0].endsAt, endsAt + 300_000);
});

test('a timer that has rung here is not silenced by the watch dropping it', () => {
  reset();
  // The watch takes a timer off its list the moment it rings. That must not
  // read as "the wearer stopped it" and cancel an alarm nobody answered.
  const rung = startTimer({ label: 'Eggs', durationSec: 60 });
  cookTimers.update(list => list.map(t => (t.id === rung.id ? { ...t, done: true } : t)));
  adoptTimers([]);
  const mine = get(cookTimers);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].done, true);
  reset();
});

test('a timer already gone from both is not resurrected', () => {
  reset();
  adoptTimers([{ key: 'w1-123', label: 'Onions', total: 600, endsAt: Date.now() - 1000 }]);
  assert.equal(get(cookTimers).length, 0);
});

test('nothing crosses unless a cook has been handed to the watch', () => {
  const src = readFileSync(new URL('../src/lib/wear-timers.js', import.meta.url), 'utf8');
  // The gate is a cook with a server id, the same one the cooks themselves
  // are published under.
  assert.match(src, /export function sharingTimers\(\)[\s\S]*?c\.serverId > 0/);
  // Both directions are behind it.
  assert.match(src, /const send = \(\) => \{[\s\S]*?if \(!sharingTimers\(\)\) return;/);
  assert.match(src, /export async function hearWatch\(\)[\s\S]*?if \(!isNative \|\| !sharingTimers\(\)\) return;/);
});

test('a burst of timer changes is one write, and an unchanged list is none', () => {
  const src = readFileSync(new URL('../src/lib/wear-timers.js', import.meta.url), 'utf8');
  // Every write starts the watch's listener service, so they are coalesced.
  assert.match(src, /pending = setTimeout\(send, \d+\)/);
  // And a tick changes nothing on the wire: a timer is a deadline, not a
  // count, so the same list is not sent twice.
  assert.match(src, /if \(shape === last\) return;/);
});

test('the watch is never sent more timers than it can run', () => {
  const src = readFileSync(new URL('../src/lib/wear-timers.js', import.meta.url), 'utf8');
  assert.match(src, /\.slice\(0, 8\)/);
});
