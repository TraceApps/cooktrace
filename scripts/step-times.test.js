/**
 * The times a step mentions become timers one tap starts (#77), in every
 * language the app speaks, whatever language the app itself is in. The watch
 * finds them from the same words (Kitchen.kt), against the same cases
 * (step-times.json), so the phone and the wrist offer the same timers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { findTimes, splitWithTimes } from '../src/lib/parseTimes.js';

const here = new URL('.', import.meta.url);
const { cases } = JSON.parse(readFileSync(new URL('step-times.json', here), 'utf8'));
const WORDS = JSON.parse(readFileSync(new URL('../src/lib/time-words/time-words.json', here), 'utf8'));

for (const { text, times } of cases) {
  test(`times in "${text}"`, () => {
    assert.deepEqual(findTimes(text).map(t => [t.text, t.durationSec]), times);
  });
}

test('the step reads the same once its times are buttons', () => {
  for (const { text } of cases) {
    assert.equal(splitWithTimes(text).map(p => p.value).join(''), text);
  }
});

test('a time inside a longer number or word is not a time', () => {
  assert.deepEqual(findTimes('Step 120min'), [{ start: 5, end: 11, text: '120min', durationSec: 7200 }]);
  assert.deepEqual(findTimes('Mix well and cook 2 mins.').map(t => t.text), ['2 mins']);
  assert.deepEqual(findTimes('ab5 min'), []);
});

test('every language the app speaks has its time words', () => {
  const locales = readdirSync(new URL('../src/i18n/', here))
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
  assert.ok(locales.length > 1);
  for (const l of locales) {
    const w = WORDS[l];
    assert.ok(w, `src/lib/time-words/time-words.json has no "${l}": add how a ${l} recipe says hours, minutes and seconds`);
    for (const kind of ['hour', 'minute', 'second']) {
      assert.ok(Array.isArray(w[kind]) && w[kind].length, `"${l}" has no ${kind} words`);
    }
  }
});
