/**
 * Notes saved as plain text (imports, AI agents, the API) kept their
 * words but lost their line breaks on the recipe page, which shows notes
 * as rich text. With no tag in them, each line break is now a <br>; the
 * editor's own HTML is untouched. sanitizeRichText (RichTextEditor.svelte)
 * runs it on everything it shows and edits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plainTextAsHtml } from '../src/lib/plain-text-html.js';

test('plain text keeps its line breaks', () => {
  assert.equal(plainTextAsHtml('Family favorite.\n\nNutrition (from Paprika):\nCalories: 210'),
    'Family favorite.<br><br>Nutrition (from Paprika):<br>Calories: 210');
  assert.equal(plainTextAsHtml('one\r\ntwo\rthree'), 'one<br>two<br>three');
});

test('plain text is shown as text, never as markup', () => {
  assert.equal(plainTextAsHtml('x<y\nz'), 'x&lt;y<br>z', 'a stray < is text');
  assert.equal(plainTextAsHtml('Salt & pepper\n3 < 4 > 2'), 'Salt &amp; pepper<br>3 &lt; 4 &gt; 2');
});

test("the editor's HTML and one-line text are left as they are", () => {
  assert.equal(plainTextAsHtml('<p>One</p>\n<p>Two</p>'), '<p>One</p>\n<p>Two</p>');
  assert.equal(plainTextAsHtml('<b>bold</b>'), '<b>bold</b>');
  assert.equal(plainTextAsHtml('Just one line & done'), 'Just one line & done');
});

test('every rich text shown or edited goes through it', () => {
  const src = readFileSync(new URL('../src/components/ui/RichTextEditor.svelte', import.meta.url), 'utf8');
  assert.match(src, /wrapper\.innerHTML = plainTextAsHtml\(html\);/);
});
