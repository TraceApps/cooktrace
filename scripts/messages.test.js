/**
 * Every failure reads the same way: "Couldn't save the category: name is
 * required." The action comes from the app's strings, the reason from the
 * error, and an error with nothing useful to say adds nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addMessages, init } from 'svelte-i18n';
import { failed, reasonOf } from '../src/lib/messages.js';

const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
const es = JSON.parse(readFileSync(new URL('../src/i18n/es.json', import.meta.url), 'utf8'));
addMessages('en', en);
addMessages('es', es);
init({ fallbackLocale: 'en', initialLocale: 'en' });

test('the error is the reason', () => {
  assert.equal(failed('fail.save_category', new Error('Name is required')), "Couldn't save the category: name is required.");
  assert.equal(failed('fail.save_category', 'Name is required.'), "Couldn't save the category: name is required.");
  assert.equal(failed('fail.save_category', { message: 'Error: Name is required' }), "Couldn't save the category: name is required.");
});

test('an error with nothing to say adds nothing', () => {
  for (const err of [undefined, null, '', new Error(''), new Error('Failed'), new Error('HTTP 500'), new Error('API error 500'), new Error('Server responded 502'), new Error('500 Internal Server Error'), { message: undefined }]) {
    assert.equal(failed('fail.save_category', err), "Couldn't save the category.");
  }
});

test('names and acronyms keep their capitals', () => {
  assert.equal(reasonOf(new Error('OIDC provider refused the code')), 'OIDC provider refused the code');
  assert.equal(reasonOf(new Error('NutriTrace is not connected')), 'NutriTrace is not connected');
  assert.equal(reasonOf(new Error('I can only take JSON')), 'I can only take JSON');
  assert.equal(reasonOf(new Error("Don't know that unit")), "don't know that unit");
});

test('no connection says so', () => {
  assert.equal(failed('fail.save_recipe', new TypeError('Failed to fetch')), "Couldn't save the recipe: the server can't be reached.");
});

test('every fail string is an action with no period, in both languages', () => {
  for (const [lang, d] of [['en', en], ['es', es]]) {
    for (const [k, v] of Object.entries(d.fail)) {
      if (['because', 'plain', 'offline'].includes(k)) continue;
      assert.ok(!/[.!]$/.test(v), `${lang} fail.${k} ends in punctuation: ${v}`);
    }
  }
});
