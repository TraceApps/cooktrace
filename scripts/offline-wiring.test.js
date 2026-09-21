/**
 * The browser's offline mode is wired where it should be. Text checks, so they
 * run without a browser; behaviour is covered by offline-edits.test.js and the
 * end-to-end runs in design/tools/offline-*.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const api = read('../src/lib/api.js');
const offline = read('../src/lib/offline-api.js');
const edits = read('../src/lib/offline-edits.js');
const app = read('../src/App.svelte');
const auth = read('../src/stores/auth.js');
const vite = read('../vite.config.js');
const en = JSON.parse(read('../src/i18n/en.json'));

test('the web app is the HTTP API wrapped for offline, and native is untouched', () => {
  assert.match(api, /import \{ createOfflineApi \} from '\.\/offline-api\.js'/);
  assert.match(api, /if \(!isNative\)\s+impl = _webApi\(\)/);
  // Native keeps its own SQLite paths and its own cached impl.
  assert.match(api, /impl = CtApiNative;/);
  assert.match(api, /impl = CtApiCached;/);
});

test('one wrapped method covers every screen', () => {
  // Every named method funnels through _fetch, so overriding it is enough.
  assert.match(offline, /impl\._fetch = \(method, path, body, isUpload\)/);
  assert.match(offline, /Object\.create\(http\)/);
  // An upload carries a file, which is not ours to hold.
  assert.match(offline, /isUpload \? _straight/);
});

test('the status survives the error, so a hiccup is told from a refusal', () => {
  assert.match(api, /err\.status = res\.status/);
  assert.match(offline, /shouldRetryStatus\(err\.status\)/);
});

test('the queue is replayed as the requests the app made', () => {
  assert.match(offline, /await _http\._fetch\(op\.method, path, body\)/);
  assert.ok(!/sync\/push/.test(offline), 'no second merge path');
});

test('sending is guarded across tabs and retries with a backoff', () => {
  assert.match(offline, /navigator\.locks\.request\('cooktrace-offline-flush'/);
  assert.match(offline, /navigator\.locks\?\.request/);
  assert.match(offline, /new BroadcastChannel\('cooktrace-offline'\)/);
  assert.match(offline, /RETRY_MIN_MS = 3_000/);
  // Safari has no Background Sync, and the iPhone is half the point.
  assert.ok(!/BackgroundSync|sync\.register/.test(offline));
  assert.match(offline, /addEventListener\('online'/);
  assert.match(offline, /visibilitychange/);
});

test('a change the server refuses is set aside and named, not left blocking', () => {
  assert.match(offline, /refused\.push\(\{ at: Date\.now\(\)/);
  assert.match(offline, /console\.error\(`\[offline\] your server refused/);
  assert.match(offline, /export async function forgetRefused/);
  assert.ok(en.sync.refused, 'the copy exists');
});

test('the queue and the copies keep their owner', () => {
  assert.match(offline, /const _USER_KEY = 'ct:offline-user'/);
  assert.match(offline, /else user = localStorage\.getItem\(_USER_KEY\)/);
  // What a page kept before sign-in follows the user rather than being stranded.
  assert.match(offline, /async function _absorb\(/);
  assert.match(offline, /indexedDB\.deleteDatabase\(oldName\)/);
});

test('the header badge reports the queue on the web', () => {
  assert.match(app, /import \{ offlineState \} from '\.\/lib\/offline-api\.js'/);
  assert.match(app, /_webOffline = !isNative &&/);
  assert.ok(en.sync.pending_web, 'sync.pending_web copy exists');
  assert.match(en.sync.pending_web, /plural/);
});

test('signing out sends what is waiting, and asks before discarding it', () => {
  const i = auth.indexOf('flushOutbox');
  assert.ok(i > 0, 'sign-out flushes the outbox');
  assert.ok(auth.indexOf('clearOffline') > i, 'and only then clears the copy');
  assert.match(auth, /if \(!ok\) return;/);
  assert.ok(en.sync.sign_out_waiting && en.sync.sign_out_anyway, 'the copy exists');
});

test('the app itself is precached, and photos are kept as they are shown', () => {
  assert.match(vite, /globPatterns: \['\*\*\/\*\.\{js,mjs,css,html,woff2,woff,ttf,png,svg,ico,webmanifest\}'\]/);
  assert.match(vite, /maximumFileSizeToCacheInBytes/);
  assert.match(vite, /uploads-cache/);
});

test('sharing, kitchens and imports are never decided offline', () => {
  for (const path of ['/api/recipes/4/share', '/api/kitchens', '/api/kitchens/2/members']) {
    assert.ok(!edits.includes(path), `${path} is not queued`);
  }
  assert.match(edits, /Sharing decides who can\s+\* see your food/);
});

test('an embedded photo becomes a file on every route that takes one', () => {
  const localizer = read('../server/lib/image-localizer.js');
  assert.match(localizer, /export function localizeDataUrl/);
  // Every screen that can hold a photo: recipes, cook photos, cookbook
  // covers, diary entries and pantry items, on create AND on edit.
  for (const [file, uses] of [['../server/routes/recipes.js', 3], ['../server/routes/cookbooks.js', 1],
                              ['../server/routes/cook-diary.js', 2], ['../server/routes/pantry.js', 2]]) {
    const src = read(file);
    const found = (src.match(/localizeDataUrls?\(/g) || []).length;
    assert.ok(found >= uses, `${file} localises its photos (${found} of ${uses})`);
  }
});

test('your profile and its picture work the same way here as in the sibling apps', () => {
  // One shape in all three: the picture goes through the API layer, which
  // embeds it when there is no connection; the save goes through the API
  // layer, so the queue sees it; the server turns the embedded picture into
  // a file at the route, through the shared localiser.
  assert.match(offline, /impl\.uploadImage = async \(file\)/);
  assert.match(offline, /embeddableDataUrl\(file\)/);
  assert.match(edits, /kind: 'profile', key: 'profile'/);
  const profile = read('../src/routes/Profile.svelte');
  assert.match(profile, /await NtApi\.put\('\/api\/auth\/profile'/);
  assert.ok(!/fetch\(apiUrl\('\/api\/auth\/profile'\)/.test(profile), 'no raw fetch around the API layer');
  const auth = read('../server/routes/auth.js');
  assert.match(auth, /localizeDataUrl\(req\.body\?\.avatar_url\)/);
});
