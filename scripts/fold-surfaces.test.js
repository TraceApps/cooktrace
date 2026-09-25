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

test('a recipe opens like a cookbook, without waiting for a desktop width', () => {
  const view = readFileSync(new URL('../src/routes/RecipeView.svelte', import.meta.url), 'utf8');
  // The two-column layout starts at 960px, which a foldable's inner display
  // never reaches, so the snap is driven by the crease rather than a
  // breakpoint, and only when both pages are wide enough for a recipe.
  assert.match(view, /foldLeftW >= 280/);
  assert.match(view, /layoutW - foldLeftW - layoutHinge >= 280/);
  assert.match(view, /html\.fold-book\) \.layout\.fold-snap/);
  // Measured, never worked out from the sidebar's width.
  assert.match(view, /getBoundingClientRect\(\)[\s\S]*?layoutLeft/);
});

test('Settings splits at the crease too, on the same terms', () => {
  const settings = readFileSync(new URL('../src/routes/Settings.svelte', import.meta.url), 'utf8');
  assert.match(settings, /foldRailW >= 200/);
  assert.match(settings, /paneW - foldRailW >= 320/);
  assert.match(settings, /\.settings-two-pane\.fold-snap/);
});
