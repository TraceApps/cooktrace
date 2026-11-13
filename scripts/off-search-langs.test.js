/**
 * TraceApps/nutritrace#320, the same search in CookTrace: the Pantry's name
 * search sent the Search Language as `lc=`, which search-a-licious ignores,
 * so the setting never changed the results. It now sends `langs=` with
 * English alongside any other language, and offers Ukrainian and Ukraine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
const urls = [];
globalThis.fetch = async (url) => {
  urls.push(String(url));
  return new Response('{"hits":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
};

const { searchByName, offSearchLangs } = await import('../src/lib/off.js');
const { settingPrefix } = await import('../src/lib/setting-key.js');

// The search-a-licious address inside the app's /api/proxy?url= call.
async function searched(lang, country) {
  store.clear();
  if (lang) store.set(settingPrefix() + 'offSearchLanguage', JSON.stringify(lang));
  if (country) store.set(settingPrefix() + 'offSearchCountry', JSON.stringify(country));
  urls.length = 0;
  await searchByName('Огірки');
  assert.equal(urls.length, 1);
  return new URL(new URL(urls[0], 'http://app.test').searchParams.get('url'));
}

test('langs= follows the setting, with English alongside', () => {
  assert.equal(offSearchLangs('en'), 'en');
  assert.equal(offSearchLangs(undefined), 'en');
  assert.equal(offSearchLangs('uk'), 'uk,en');
});

test('the Pantry search sends langs=, not the ignored lc=', async () => {
  const def = await searched();
  assert.equal(def.searchParams.get('langs'), 'en');
  assert.equal(def.searchParams.get('lc'), null);
  const uk = await searched('uk', 'Ukraine');
  assert.equal(uk.host, 'search.openfoodfacts.org');
  assert.equal(uk.searchParams.get('langs'), 'uk,en');
  assert.equal(uk.searchParams.get('q'), 'Огірки +countries_tags:"en:ukraine"');
});

test('Settings offers Ukrainian and Ukraine, with labels', () => {
  const s = readFileSync(new URL('../src/components/settings/SettingsFoodSources.svelte', import.meta.url), 'utf8');
  assert.match(s, /\['uk','Ukrainian'\]/);
  assert.match(s, /'Ukraine'/);
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8')).settings_food_sources_ui;
  assert.equal(en.lang_uk, 'Ukrainian');
  assert.equal(en.country_ukraine, 'Ukraine');
});
