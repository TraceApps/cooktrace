/**
 * Share to OFF with no Open Food Facts login asks for it inside the editor
 * (TraceApps/nutritrace#284). The first fix linked to Settings > Food
 * Sources, which left the editor: a pantry item not saved yet lost
 * everything typed into it, in the full-page editor and in the sheet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const editors = {
  'full-page editor': read('../src/routes/PantryEditor.svelte'),
  'pantry sheet': read('../src/components/pantry/PantryItemSheet.svelte'),
};

for (const [name, src] of Object.entries(editors)) {
  test(`${name}: no login asks for it in place, then shares`, () => {
    const block = src.slice(src.indexOf('{#if offNeedsAccount}'), src.indexOf('{/if}', src.indexOf('{#if offNeedsAccount}')));
    assert.ok(block.length > 0, 'the no-account block exists');
    assert.doesNotMatch(block, /href=["'{]?[^"'\s>]*#\/settings/, 'it does not navigate away from the editor');
    assert.match(block, /<OffAccountInline\s+on:saved=\{\(\) => \{ offNeedsAccount = false; shareOrViewOnOFF\(\); \}\}/);
    assert.match(src, /if \(e\?\.kind === 'no_account' \|\| e\?\.kind === 'login'\) offNeedsAccount = true;/, 'a wrong login reopens the fields too');
  });
}

test('the inline fields save to the same settings as Settings > Food Sources', () => {
  const src = read('../src/components/pantry/OffAccountInline.svelte');
  assert.match(src, /import \{ offUsername, offPassword \} from '\.\.\/\.\.\/stores\/settings\.js'/);
  assert.match(src, /offUsername\.set\(user\.trim\(\)\)/);
  assert.match(src, /offPassword\.set\(pass\)/);
  assert.doesNotMatch(src, /<form/, 'no nested form inside an editor');
  const en = JSON.parse(read('../src/i18n/en.json'));
  for (const k of ['need_account', 'save_and_share']) assert.ok(en.off_share[k], k);
});
