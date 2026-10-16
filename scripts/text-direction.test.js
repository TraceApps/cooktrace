/**
 * Right-to-left text: Arabic, Hebrew and mixed lines (TraceApps/notetrace#21).
 *
 * A line of the user's own text takes its direction from its first letter,
 * as dir="auto" does. Single texts carry dir="auto"; rows whose box, amount
 * or number must sit on the reading side take textDir() of their text (a
 * dir="auto" row would skip its children). Notes and comments read each
 * paragraph its own way. Share cards draw Arabic lines from the right.
 * Display only: nothing that is saved changes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { textDir, lineDirs } from '../src/lib/text-dir.js';
import { buildRecipeCardPages } from '../src/lib/recipe-card.js';
import { buildShoppingCardSvg } from '../src/lib/shopping-card.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('textDir: the first letter decides, as dir="auto" does', () => {
  const cases = [
    ['مرحبا', 'rtl'], ['שלום', 'rtl'], ['ܫܠܡܐ', 'rtl'],
    ['Hello', 'ltr'], ['Привет', 'ltr'], ['你好', 'ltr'],
    ['123 مرحبا', 'rtl'], ['- عنصر', 'rtl'], ['  English عربي', 'ltr'],
    ['قهوة مع sugar', 'rtl'], ['Coffee مع سكر', 'ltr'],
    ['', undefined], ['42', undefined], ['!? 3.5', undefined], [null, undefined], [undefined, undefined],
  ];
  for (const [text, want] of cases) assert.equal(textDir(text), want, JSON.stringify(text));
  // Direction marks count, as for dir="auto".
  assert.equal(textDir('‏Hello'), 'rtl');
  assert.equal(textDir('‎مرحبا'), 'ltr');
  // An empty line reads like the one above it.
  assert.deepEqual(lineDirs(['حليب', '', 'Bread', '', '']), ['rtl', 'rtl', 'ltr', 'ltr', 'ltr']);
});

test('recipe rows put their box, amount and number on the reading side', () => {
  const view = read('../src/routes/RecipeView.svelte');
  assert.match(view, /<li class="ingredient" dir=\{textDir\(ing\.name \|\| ing\.note\)\}/);
  assert.match(view, /<li class="step" dir=\{textDir\(title \|\| text\)\}/);
  assert.match(view, /<li class="step-ing" dir=\{textDir\(ing\.name \|\| ing\.note\)\}/);
  // The unit menu of an Arabic amount opens from the right, inside the row.
  assert.match(view, /\.ingredient\[dir="rtl"\] \.convert-menu \{ left: auto; right: 0; \}/);
  assert.match(view, /<h1 class="recipe-name"[^>]*dir="auto"|<h1[^>]*dir="auto"[^>]*class="recipe-name"/);
  // Notes read paragraph by paragraph: an Arabic one from the right, an English one from the left.
  assert.match(view, /\.notes :global\(p\), \.notes :global\(li\)[^{]*\{ unicode-bidi: plaintext; \}/);
  const pub = read('../src/routes/PublicRecipe.svelte');
  assert.match(pub, /<li dir=\{textDir\(ing\.name \|\| ing\.note\)\}>/);
  assert.match(pub, /<li dir=\{textDir\(title \|\| text\)\}>/);
  assert.match(pub, /\.notes \{[^}]*unicode-bidi: plaintext;/);
  const editor = read('../src/routes/RecipeEditor.svelte');
  assert.match(editor, /dir=\{textDir\(ing\.name \|\| ing\.note\)\}/);
  assert.match(editor, /dir=\{textDir\(steps\[i\]\.title \|\| steps\[i\]\.text\)\}/);
  // The phone's note row sits under its ingredient, on the same side.
  assert.match(editor, /<div class="ing-note-row" dir=\{textDir\(ing\.name \|\| ing\.note\)\}>/);
  // The comma stays between a name and a note that read different ways.
  assert.match(read('../src/routes/RecipeVersion.svelte'), /\{#if it\.note\}, <span class="note" dir="auto">\{it\.note\}<\/span>/);
  const compare = read('../src/components/recipe/VersionCompare.svelte');
  assert.match(compare, /<li class="row \{x\.kind\}" dir=\{textDir\(\(x\.to \|\| x\.from\)\.name \|\| \(x\.to \|\| x\.from\)\.note\)\}>/);
  assert.match(compare, /<li class="row \{x\.kind\}" dir=\{textDir\(stepText\(x\.to \|\| x\.from\)\)\}>/);
  assert.match(read('../src/routes/Shopping.svelte'), /<li class="row" dir=\{textDir\(it\.name\)\}/);
  assert.match(read('../src/components/ai/Trace.svelte'), /<div class="bubble" dir="auto">/);
  // Inputs type either way.
  assert.match(read('../src/components/ui/Combobox.svelte'), /dir="auto"/);
  assert.match(read('../src/components/ui/UnitPicker.svelte'), /class="input unit-input" dir="auto"/);
});

const recipe = (name, group, items, steps) => ({ name, servings: 2, ingredients: [{ name: group, items }, { name: 'Extra', items: [{ name: 'salt' }] }], steps });

test('share cards draw an Arabic line from the right, its amount on the left', async () => {
  const [page] = await buildRecipeCardPages(recipe('شوربة العدس بالليمون والكمون الطازج', 'الشوربة',
    [{ name: 'عدس أحمر', qty: '1', unit: 'كوب' }, { name: 'flour', qty: '2', unit: 'tbsp' }],
    ['اغسل العدس جيدا.', 'Boil the water.']));
  const svg = page.svg;
  // Each line of a long Arabic name is its own <text> from the right edge
  // (WebKit runs the lines of one right-to-left <text> together).
  assert.equal((svg.match(/<text x="560" direction="rtl" y="\d+"[^>]*font-size="38"/g) || []).length, 2);
  assert.doesNotMatch(svg, /<tspan x="\d+" dy="46">/);
  // The group name: no letter spacing, which pulls Arabic letters apart.
  assert.match(svg, /<text x="560" direction="rtl"[^>]*font-weight="700" fill="#4FFFB0" font-style="italic">الشوربة<\/text>/);
  // Arabic ingredient from the right, its amount on the left; English as before.
  assert.match(svg, /<text x="560" direction="rtl"[^>]*>• عدس أحمر<\/text>/);
  assert.match(svg, /<text x="40" direction="rtl" y="\d+" text-anchor="end"[^>]*>1 كوب<\/text>/);
  assert.match(svg, /<text x="40" y="\d+"[^>]*>• flour<\/text>/);
  assert.match(svg, /<text x="560" y="\d+" text-anchor="end"[^>]*>2 tbsp<\/text>/);
  // An Arabic step has its number on the right.
  assert.match(svg, /<circle cx="546"[\s\S]*?<text x="520" direction="rtl"[^>]*>اغسل العدس جيدا\.<\/text>/);
  assert.match(svg, /<circle cx="54"[\s\S]*?<text x="80" y="\d+"[^>]*>Boil the water\.<\/text>/);
});

test('an English card is drawn exactly as before', async () => {
  const [page] = await buildRecipeCardPages(recipe('Lentil Soup with Lemon and Cumin', 'Soup',
    [{ name: 'red lentils', qty: '1', unit: 'cup' }], ['Rinse the lentils.']));
  assert.doesNotMatch(page.svg, /direction=/);
  assert.match(page.svg, /<text x="40" y="436"[^>]*\n\s*font-size="38" font-weight="800" fill="#FFFFFF">Lentil Soup with Lemon<tspan x="40" dy="46">and Cumin<\/tspan><\/text>/);
  assert.match(page.svg, /font-weight="700" letter-spacing="1" fill="#4FFFB0" font-style="italic">Soup</);
  const shop = buildShoppingCardSvg([{ name: 'Coffee', quantity: 2 }], { date: new Date('2026-10-15T12:00:00Z') }).svg;
  assert.doesNotMatch(shop, /direction=/);
});

test('a shopping card puts an Arabic item\'s box on the right, its amount on the left', () => {
  const { svg } = buildShoppingCardSvg([{ name: 'قهوة', quantity: 2, unit: 'كيس' }, { name: 'Eggs', quantity: 12 }], { date: new Date('2026-10-15T12:00:00Z') });
  assert.match(svg, /<rect x="538"[^>]*\/>\s*<!-- Name -->\s*<text x="524" direction="rtl"[^>]*>قهوة<\/text>\s*<text x="40" direction="rtl" y="\d+" text-anchor="end"[^>]*>2 كيس<\/text>/);
  assert.match(svg, /<rect x="40"[^>]*\/>\s*<!-- Name -->\s*<text x="76" y="\d+"[^>]*>Eggs<\/text>\s*<text x="560" y="\d+" text-anchor="end"/);
});
