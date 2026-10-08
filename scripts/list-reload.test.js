/**
 * The list pages read the phone's copy again when a sync brings changes
 * (lib/sync-refresh.js). Two reads can overlap (the page opening while a
 * sync lands): only the newest one sets what's shown, the loading state
 * and an error; a quiet read after a sync never shows an error toast.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

for (const page of ['Recipes', 'Pantry', 'Shopping', 'CookDiary']) {
  test(`${page}: only the newest read sets the loading state; a quiet one never toasts`, () => {
    const src = readFileSync(new URL(`../src/routes/${page}.svelte`, import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('async function load({ quiet'), src.indexOf('\n  }\n', src.indexOf('async function load({ quiet')));
    assert.match(body, /const seq = \+\+_loadSeq;/);
    assert.match(body, /if \(!quiet\) \{ loading = true; loadError = null; \}/);
    assert.match(body, /finally \{\s*if \(seq === _loadSeq\) loading = false;/);
    assert.match(body, /if \(seq === _loadSeq && !quiet\) \{[^}]*showError\(loadError\)/s, 'a quiet read keeps quiet, and an older read never speaks');
    assert.doesNotMatch(body.replace(/if \(seq === _loadSeq && !quiet\) \{[^}]*\}/s, ''), /showError\(/, 'no other toast');
    assert.match(src, /onSyncChanges\(\(\) => \{?\s*load\(\{ quiet: true \}\)/);
  });
}

test('the phone keeps the same name groups the server merges by', async () => {
  const native = readFileSync(new URL('../src/lib/db-native.js', import.meta.url), 'utf8');
  const groups = JSON.parse(native.match(/const NAME_GROUPS = (\{[^\n]*\});/)[1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"'));
  const { SYNC_GROUPS } = await import('../server/lib/sync-fields.js');
  for (const [t, g] of Object.entries(groups)) assert.ok(SYNC_GROUPS[t].some(x => JSON.stringify(x) === JSON.stringify(g)), t);
});
