/**
 * A recipe's "Last Cooked" is a day ("2026-10-09"). Read as UTC midnight it
 * showed 10/08/2026 in New York. A day stays that day in every time zone;
 * timestamps still convert from UTC.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate } from '../src/lib/format.js';

const inZone = (tz, fn) => { const was = process.env.TZ; process.env.TZ = tz; try { fn(); } finally { process.env.TZ = was; } };

test('a day is the same day everywhere', () => {
  for (const tz of ['America/New_York', 'America/Los_Angeles', 'UTC', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
    inZone(tz, () => {
      assert.equal(formatDate('2026-10-09', 'US'), '10/09/2026', tz);
      assert.equal(formatDate('2026-10-09', 'ISO'), '2026-10-09', tz);
      assert.equal(formatDate('2026-10-09', 'EU'), '09/10/2026', tz);
    });
  }
});

test('a timestamp still converts from UTC', () => {
  inZone('America/New_York', () => {
    assert.equal(formatDate('2026-10-10 02:00:00', 'ISO'), '2026-10-09');
    assert.equal(formatDate('2026-10-10T02:00:00Z', 'ISO'), '2026-10-09');
  });
  inZone('Asia/Tokyo', () => assert.equal(formatDate('2026-10-09 20:00:00', 'ISO'), '2026-10-10'));
});
