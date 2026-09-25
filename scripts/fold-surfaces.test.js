/**
 * Every surface a cook cannot move has a rule that moves it off the crease.
 *
 * A recipe, a list or a photo is free to cross a fold: it can be scrolled,
 * panned or zoomed. A dialog, a sheet or the Trace panel cannot, so each one
 * is named here, and a new one gets noticed when it is added rather than when
 * someone unfolds a phone in a kitchen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles/fold.css', import.meta.url), 'utf8');

test('the book rules cover every fixed surface', () => {
  for (const sel of ['.dialog-backdrop', '.sheet-backdrop', '.as-backdrop', '.panel', '.rail']) {
    assert.match(css, new RegExp(`html\\.fold-book [^{]*\\${sel}`), `book: ${sel}`);
  }
});

test('the tabletop rules cover every fixed surface', () => {
  for (const sel of ['.dialog-backdrop', '.sheet-panel', '.as-panel', '.panel']) {
    assert.match(css, new RegExp(`html\\.fold-tabletop [^{]*\\${sel}`), `tabletop: ${sel}`);
  }
});

test('the rules read the crease rather than guessing where it is', () => {
  assert.doesNotMatch(css, /50vw|50dvw/);
  assert.match(css, /var\(--fold-start\)/);
  assert.match(css, /var\(--fold-end\)/);
});

test('the stylesheet is loaded, and last so it wins', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const styles = [...main.matchAll(/import '\.\/styles\/([a-z-]+)\.css';/g)].map(m => m[1]);
  assert.ok(styles.includes('fold'), 'fold.css is imported');
  assert.equal(styles[styles.length - 1], 'fold', 'and it comes last');
});
