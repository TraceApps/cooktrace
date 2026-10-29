/**
 * App icon shortcuts (from TraceApps/nutritrace#278): Shopping List and Scan
 * to Pantry, from Android's launcher (res/xml/shortcuts.xml, cooktrace://new/…)
 * and the installed web app (the manifest's shortcuts, ./#/?new=…).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseAppLink } from '../src/lib/app-link.js';
import { oidcReturnHash } from '../server/lib/oidc-return.js';
import {
  SHORTCUT_KINDS, shortcutFromQuery, shortcutFromAppLink, isShortcutHash,
  shortcutRoute, shortcutNav, shortcutTarget,
} from '../src/lib/app-shortcut.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the links and addresses are read as their kind, and nothing else is', () => {
  assert.deepEqual(SHORTCUT_KINDS, ['shopping', 'scan']);
  for (const k of SHORTCUT_KINDS) {
    assert.equal(shortcutFromAppLink(parseAppLink(`cooktrace://new/${k}`)), k);
    assert.equal(shortcutFromQuery(`?new=${k}`), k);
    assert.equal(shortcutFromQuery(`new=${k}`), k);
    assert.equal(isShortcutHash(`#/?new=${k}`), true);
  }
  assert.equal(shortcutFromAppLink(parseAppLink('CookTrace://New/Shopping/')), 'shopping');
  assert.equal(shortcutFromAppLink(parseAppLink('cooktrace://new/weight')), null);
  assert.equal(shortcutFromAppLink(parseAppLink('nutritrace://new/scan')), null, 'another app\'s link');
  assert.equal(shortcutFromAppLink(parseAppLink('cooktrace://oidc-callback?code=x')), null);
  assert.equal(shortcutFromAppLink(null), null);
  assert.equal(shortcutFromQuery('?new=food'), null);
  assert.equal(shortcutFromQuery(undefined), null);
  assert.equal(isShortcutHash('#/pantry?new=scan'), false, 'only the Diary\'s address');
  assert.equal(isShortcutHash('#/'), false);
});

test('a shortcut that starts the app is sent once, though Android reports it twice', () => {
  const t = 5_000_000;
  assert.equal(shortcutRoute('shopping', t), '/?new=shopping');
  assert.equal(shortcutRoute('shopping', t + 400), null);
  assert.equal(shortcutRoute('scan', t + 500), '/?new=scan');
  assert.equal(shortcutRoute('scan', t + 3600), '/?new=scan');
  assert.equal(shortcutRoute('nope', t + 9000), null);
});

test('each opens its page: the shopping list, or the Pantry with the scanner', () => {
  assert.equal(shortcutTarget('shopping'), '/shopping');
  assert.equal(shortcutTarget('scan'), '/pantry?scan=1');
  assert.equal(shortcutTarget('nope'), null);
});

test('the installed web app lists the two shortcuts, in order', () => {
  const vite = read('../vite.config.js');
  const start = vite.indexOf('shortcuts: [');
  const block = vite.slice(start, vite.indexOf('],', start));
  const items = [...block.matchAll(/\{ name: '([^']+)', short_name: '([^']+)', url: '([^']+)', icons: \[\{ src: '([^']+)'/g)];
  assert.deepEqual(items.map(m => [m[1], m[2], m[3]]), [
    ['Shopping List', 'Shopping List', './#/?new=shopping'],
    ['Scan to Pantry', 'Scan to Pantry', './#/?new=scan'],
  ]);
  for (const m of items) {
    assert.equal(shortcutFromQuery(m[3].split('?')[1]), m[3].split('=')[1]);
    assert.ok(existsSync(new URL('../public/' + m[4], import.meta.url)), m[4]);
  }
});

test('Android\'s shortcuts.xml: ids, labels, icons and explicit intents', () => {
  const xml = read('../android/app/src/main/res/xml/shortcuts.xml');
  const strings = read('../android/app/src/main/res/values/strings.xml');
  const blocks = [...xml.matchAll(/<shortcut\b([\s\S]*?)<\/shortcut>/g)].map(m => m[1]);
  const ids = [];
  const labels = [];
  for (const b of blocks) {
    const attr = n => (new RegExp(`android:${n}="([^"]*)"`).exec(b) || [])[1];
    ids.push(attr('shortcutId'));
    assert.equal(attr('enabled'), 'true');
    const label = /^@string\/(\w+)$/.exec(attr('shortcutShortLabel'))?.[1];
    const text = new RegExp(`<string name="${label}">([^<]+)</string>`).exec(strings)?.[1];
    assert.ok(text && text.length <= 25, `${label} exists and fits a launcher's short label`);
    labels.push(text);
    const icon = /^@drawable\/(\w+)$/.exec(attr('icon'))?.[1];
    assert.match(read(`../android/app/src/main/res/drawable/${icon}.xml`), /<vector[\s\S]*android:viewportWidth="24"[\s\S]*<path android:fillColor="@android:color\/white" android:pathData="M[^"]+" \/>/);
    assert.equal(attr('action'), 'android.intent.action.VIEW');
    assert.equal(attr('targetPackage'), 'com.cooktrace.app');
    assert.equal(attr('targetClass'), 'com.cooktrace.app.AppShortcutActivity', 'through the pass-through activity (app-shortcut-activity.test.js)');
    assert.equal(shortcutFromAppLink(parseAppLink(attr('data'))), attr('shortcutId'));
  }
  assert.deepEqual(ids, SHORTCUT_KINDS);
  assert.deepEqual(labels, ['Shopping List', 'Scan to Pantry']);
  const manifest = read('../android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /<category android:name="android.intent.category.LAUNCHER" \/>\s*<\/intent-filter>\s*<meta-data android:name="android.app.shortcuts" android:resource="@xml\/shortcuts" \/>/);
  const browsable = manifest.match(/<intent-filter[^>]*>(?:(?!<\/intent-filter>)[\s\S])*BROWSABLE(?:(?!<\/intent-filter>)[\s\S])*<\/intent-filter>/g) || [];
  assert.ok(browsable.length);
  for (const f of browsable) assert.doesNotMatch(f, /android:host="new"/);
});

test('the app routes a shortcut link to Recipes, which goes on to its page', () => {
  const app = read('../src/App.svelte');
  const handler = app.slice(app.indexOf("addListener('appUrlOpen'"));
  assert.match(handler, /if \(host === 'new'\) \{[\s\S]*?sc\.shortcutRoute\(sc\.shortcutFromAppLink\(link\)\)[\s\S]*?\[sc\.shortcutNav\(window\.location\.hash\)\]\(route\)[\s\S]*?return;/);
  assert.match(app, /App\.getLaunchUrl\?\.\(\)\.then\(async \(r\) => \{[\s\S]*?sc\.shortcutRoute\(sc\.shortcutFromAppLink\(parseAppLink\(r\.url\)\)\)/);
  assert.match(app, /'\/':\s+Recipes,/, 'Recipes is the first page');
  const recipes = read('../src/routes/Recipes.svelte');
  assert.match(recipes, /\$: _openShortcut\(shortcutFromQuery\(\$querystring\)\);\s*function _openShortcut\(kind\) \{\s*if \(!kind\) return;\s*replace\('\/'\);\s*push\(shortcutTarget\(kind\)\);/);
  const pantry = read('../src/routes/Pantry.svelte');
  assert.match(pantry, /if \(q\.get\('scan'\) === '1'\) \{\s*replace\('\/pantry'\);\s*scannerOpen = true;\s*return;\s*\}/, 'once, off the address');
  assert.match(pantry, /<BarcodeScanner bind:open=\{scannerOpen\} on:scan=\{onSearchScan\}/, 'the search bar\'s own scanner and flow');
});

test('signed out, the shortcut waits under the sign-in screen and opens after it', () => {
  const login = read('../src/routes/Login.svelte');
  assert.equal((login.match(/const shortcutWaiting = isShortcutHash\(window\.location\.hash\);/g) || []).length, 2);
  assert.equal((login.match(/if \(!shortcutWaiting\) push\('\/'\);/g) || []).length, 2);
  const app = read('../src/App.svelte');
  assert.match(app, /const shortcutWaiting = isShortcutHash\(window\.location\.hash\);\s*import\('\.\/stores\/toast\.js'\)[^\n]*\n\s*await loadAuthState\(\);/);
  assert.match(app, /if \(!shortcutWaiting\) window\.location\.hash = '#\/';/);
});

test('a web SSO sign-in comes back to the shortcut waiting under it', () => {
  // The sign-in page sends its address after the #.
  assert.equal(oidcReturnHash('#/?new=shopping', null, 'ok'), '/?new=shopping&oidc=ok');
  assert.equal(shortcutFromQuery(oidcReturnHash('#/?new=shopping', null, 'ok').split('?')[1]), 'shopping');
  assert.equal(oidcReturnHash('#/', null, 'ok'), '/?oidc=ok', 'no longer #/#/?oidc=ok');
  assert.equal(oidcReturnHash('', 'access_denied'), '/?oidc_error=access_denied');
  assert.equal(oidcReturnHash('/profile', null, 'linked'), '/profile?oidc=linked');
  assert.equal(oidcReturnHash('settings', null, null), '/settings');
  assert.equal(oidcReturnHash('#', null, 'ok'), '/?oidc=ok');
  assert.match(read('../server/routes/oidc.js'), /res\.redirect\(`\$\{basePath\}\/#\$\{oidcReturnHash\(returnPath, error, ok\)\}`\);/);
});

test('a shortcut replaces the first page when the app just started, else Back returns', () => {
  for (const h of ['', '#', '#/', '/']) assert.equal(shortcutNav(h), 'replace', JSON.stringify(h));
  for (const h of ['#/settings', '#/?note=1', '#/foods?pick=1', '#/shopping', '#/statistics']) assert.equal(shortcutNav(h), 'push', h);
  assert.equal(shortcutNav(undefined), 'replace');
  const app = read('../src/App.svelte');
  assert.equal((app.match(/\(await import\('svelte-spa-router'\)\)\[sc\.shortcutNav\(window\.location\.hash\)\]\(route\);/g) || []).length, 2, 'the launch URL and appUrlOpen');
});
