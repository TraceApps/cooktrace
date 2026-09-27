/**
 * #63: NtApi.uploadImage() returns the uploaded file's URL as a string, from
 * the web client, the native one and the offline wrapper alike. Two callers
 * read `.url` / `.path` off that string, always got '', and threw "Upload
 * failed" after the file had already reached the server: the cookbook cover
 * in Manage (the only way to give a smart cookbook a cover) and the recipe
 * video upload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../src/', import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(svelte|js)$/.test(name)) files.push(p);
  }
})(root);

test('uploadImage returns a string in every client', () => {
  const http = readFileSync(join(root, 'lib/api.js'), 'utf8');
  assert.match(http, /async uploadImage\(file\) \{[\s\S]*?return res\.url;/, 'the HTTP client returns the url string');
  const offline = readFileSync(join(root, 'lib/offline-api.js'), 'utf8');
  assert.match(offline, /return embeddableDataUrl\(file\);/, 'offline, a data URL string');
});

test('no caller treats the uploadImage result as an object', () => {
  const offenders = [];
  for (const f of files) {
    if (/\/lib\/(api|api-native|api-cached|offline-api)\.js$/.test(f)) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/const (\w+) = await NtApi\.uploadImage\([^)]*\);[^\n]*\n([^\n]*)/g)) {
      const [, name, next] = m;
      if (new RegExp(`\\b${name}\\?*\\.(url|path)\\b`).test(next)) offenders.push(`${f.replace(root, 'src/')}: ${next.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the cookbook cover and the recipe video take the returned string as the URL', () => {
  for (const p of ['components/manage/ManageCookbooks.svelte', 'routes/RecipeEditor.svelte']) {
    assert.match(readFileSync(join(root, p), 'utf8'), /const url = await NtApi\.uploadImage\(file\);/, p);
  }
});
