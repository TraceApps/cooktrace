/**
 * Uploaded pictures are shown through resolveAssetUrl() (found while fixing
 * the same bug in LiftTrace, lifttrace#141, reported by @rgpag1).
 *
 * A pantry photo or cookbook cover uploaded to the server is stored as a
 * server-relative path (/uploads/...). Put straight into <img src>, it
 * resolved against the Android app's own origin (https://app.cooktrace.local),
 * so it was blank in the pantry list and the cookbook grid, and on the web
 * when CookTrace is served from a subpath (BASE_URL). resolveAssetUrl() adds
 * the server address on Android and the subpath on the web, and leaves full
 * links and already resolved addresses as they are.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const SRC = new URL('../src/', import.meta.url).pathname;
const svelteFiles = (dir) => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? svelteFiles(p) : p.endsWith('.svelte') ? [p] : [];
});

test('every stored picture address reaches src through resolveAssetUrl', () => {
  const bad = [];
  for (const file of svelteFiles(SRC)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\b(src|poster)=\{([^}]*)\}/g)) {
        // Whatever is inside resolveAssetUrl(...) is fine; nothing else may
        // name the stored address.
        const rest = m[2].replace(/resolveAssetUrl\([^)]*\)/g, '');
        if (/\b(img_url|cover_image_url)\b/.test(rest)) bad.push(`${file.slice(SRC.length)}:${i + 1} ${m[0]}`);
      }
    });
  }
  assert.deepEqual(bad, [], `stored picture shown without resolveAssetUrl:\n${bad.join('\n')}`);
});

test('the image picker resolves what it is given', () => {
  // Pantry items, cookbook covers and recipe steps hand it the stored address.
  const picker = readFileSync(new URL('../src/components/ui/ImagePicker.svelte', import.meta.url), 'utf8');
  assert.match(picker, /<img class="preview-img" src=\{resolveAssetUrl\(value\)\}/);
});
