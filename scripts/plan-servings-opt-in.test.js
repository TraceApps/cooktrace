/**
 * Servings on a plan are optional and never filled in (the user's call):
 * planning a cook, Build My Week and Trace's plan_cook set none unless
 * someone says how many; the Week view and the Diary show none for a plan
 * without. Before, the plan dialog started at who's home or the recipe's
 * servings, Build My Week and Trace used the household, and every plan
 * showed a servings pill.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the plan dialog sets no servings itself', () => {
  const s = read('src/components/diary/PlanCookDialog.svelte');
  assert.match(s, /let servings = null;/);
  assert.doesNotMatch(s, /homeOn\(/, 'no household prefill');
  assert.match(s, /\.\.\.\(servings != null \? \{ servings \} : \{\}\)/, 'a new plan carries servings only when set');
  assert.match(s, /<OptionalServings/);
  assert.doesNotMatch(s, /<ServingsStepper/);
});

test('Build My Week sets servings only when asked to', () => {
  const s = read('src/components/diary/BuildWeekSheet.svelte');
  assert.match(s, /let servings = null;/);
  assert.doesNotMatch(s, /homeOn|servingsFor|members\.length\) servings/, 'no household servings');
  assert.match(s, /\.\.\.\(servings != null \? \{ servings \} : \{\}\)/);
});

test("Trace's plan_cook leaves servings out unless the user said", () => {
  const t = read('src/components/ai/Trace.svelte');
  const block = t.slice(t.indexOf("case 'plan_cook':"), t.indexOf("case 'add_to_shopping':"));
  assert.doesNotMatch(block, /homeOn|members/);
  assert.match(read('src/lib/aiChat.js'), /Only set it when the user says how many/);
});

test('the Week view and tray show servings only for plans that have them', () => {
  const s = read('src/components/diary/WeekView.svelte');
  assert.match(s, /Number\(e\.servings\) > 0 \? Math\.round\(Number\(e\.servings\)\) : null/);
  assert.match(s, /\{#if servingsOf\(e\)\}\s*<ServingsStepper/);
});

test('the Diary list shows the servings pill only for a plan that has them', () => {
  const s = read('src/routes/CookDiary.svelte');
  assert.match(s, /e\.kind === 'planned' && e\.servings > 0/);
});
