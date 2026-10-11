/**
 * A cook's date is a day, not a moment: one logged today said "21 Hours
 * Ago" at 9:31 PM (the day read as midnight, then counted in hours). Days
 * count as days: Today, Yesterday, 3 Days Ago. Timestamps keep minutes and hours.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime } from '../src/lib/relative-time.js';

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test('a day counts in days, whatever the time of day', () => {
  const late = at(2026, 10, 10, 21, 31);
  assert.equal(relativeTime('2026-10-10', late), 'Today');
  assert.equal(relativeTime('2026-10-10', at(2026, 10, 10, 0, 5)), 'Today');
  assert.equal(relativeTime('2026-10-09', late), 'Yesterday');
  assert.equal(relativeTime('2026-10-09', at(2026, 10, 10, 0, 5)), 'Yesterday');
  assert.equal(relativeTime('2026-10-07', late), '3 Days Ago');
  assert.equal(relativeTime('2026-10-11', late), 'Tomorrow');
  assert.equal(relativeTime('2026-10-14', late), 'In 4 Days');
  assert.equal(relativeTime('2026-09-01', late), 'A Month Ago');
  assert.equal(relativeTime('2025-10-10', late), 'A Year Ago');
});

test('a moment still counts in minutes and hours', () => {
  const now = Date.UTC(2026, 9, 11, 1, 31);
  assert.equal(relativeTime('2026-10-11 01:29:00', now), '2 Minutes Ago');
  assert.equal(relativeTime('2026-10-10 22:31:00', now), '3 Hours Ago');
});
