/**
 * A Paprika archive imported into a real server, both ways the app sends
 * one (#97): the bulk import (scan, then commit) and the single-file
 * /import. Photos land as files under uploads, ratings and Paprika's
 * nutrition text come along, and the duplicate check inside one archive
 * goes by name only: Paprika's "[copy]" entries and different recipes from
 * one page import, a recipe that's in the archive twice imports once, and
 * a recipe already in the library is still left out.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let JSZip = null;
try { serverRequire('better-sqlite3'); JSZip = serverRequire('jszip'); } catch { /* server packages missing: skip */ }
const skip = JSZip ? false : 'server packages missing';

// A real 16x12 JPEG.
const PHOTO = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAMABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJACzr//2Q==';

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const recipe = (name, over = {}) => ({ name, ingredients: '1 cup lentils', directions: 'Boil.', photo: 'x.jpg', ...over });
const ENTRIES = [
  recipe('Lentil Soup', { photo_data: PHOTO, rating: 4, nutritional_info: 'Calories: 210\nProtein: 12 g', notes: 'Family favorite.', source_url: 'https://example.com/lentil' }),
  recipe('Lentil Soup [copy]', { photo_data: PHOTO, rating: 0, source_url: 'https://example.com/lentil' }),
  recipe('Pea Soup', { source_url: 'https://example.com/soups', photos: [{ data: PHOTO }] }),
  recipe('Bean Soup', { source_url: 'https://example.com/soups', image_url: 'https://example.com/bean.jpg' }),
  recipe('Twice Bread', { rating: 5 }),
  recipe('twice bread', { rating: 2 }),
  recipe('Old Favorite Remix', { source_url: 'https://example.com/old' }),
];

async function archive() {
  const z = new JSZip();
  ENTRIES.forEach((r, i) => z.file(`${i}-${r.name}.paprikarecipe`, gzipSync(Buffer.from(JSON.stringify(r)))));
  return z.generateAsync({ type: 'nodebuffer' });
}

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-paprika-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), DB_PATH: join(dir, 'ct.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'),
      JWT_SECRET: 'paprika-import-test-0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  try {
    let up = false;
    for (let i = 0; i < 600 && !up; i++) {
      if (proc.exitCode != null) throw new Error(`server exited: ${stderr.slice(-500)}`);
      try { up = (await fetch(base + '/api/auth/status')).ok; } catch { /* not up yet */ }
      if (!up) await sleep(200);
    }
    const PW = 'Str0ng-Pass-77!x';
    const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'cook', password: PW }) });
    const token = reg.headers.getSetCookie().map(c => c.split(';')[0].split('=')[1]).find(v => v?.startsWith('eyJ'));
    const call = async (method, p, body) => {
      const isForm = body instanceof FormData;
      const r = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + token, ...(isForm || !body ? {} : { 'Content-Type': 'application/json' }) }, body: isForm ? body : body ? JSON.stringify(body) : undefined });
      const t = await r.text();
      assert.ok(r.ok, `${method} ${p} -> ${r.status} ${t.slice(0, 300)}`);
      return t ? JSON.parse(t) : null;
    };
    // Already in the library: the remix shares its link, so it's left out.
    await call('POST', '/api/recipes', { name: 'Old Favorite', source_url: 'https://example.com/old', ingredients: [], steps: [] });
    await fn({ call, uploads: join(dir, 'uploads') });
  } finally {
    await new Promise((res) => { if (proc.exitCode != null || proc.signalCode != null) return res(); proc.once('exit', res); proc.kill('SIGKILL'); });
    rmSync(dir, { recursive: true, force: true });
  }
}

async function check({ call, uploads }, skippedNames) {
  const all = await call('GET', '/api/recipes');
  const list = Array.isArray(all) ? all : all.recipes || all.items;
  const by = Object.fromEntries(list.map(r => [r.name, r]));
  assert.deepEqual(Object.keys(by).sort(), ['Bean Soup', 'Lentil Soup', 'Lentil Soup [copy]', 'Old Favorite', 'Pea Soup', 'Twice Bread'].sort());
  assert.deepEqual(skippedNames.sort(), ['Old Favorite Remix', 'twice bread']);
  for (const n of ['Lentil Soup', 'Lentil Soup [copy]', 'Pea Soup']) {
    const url = by[n].img_url || '';
    assert.match(url, /^\/uploads\//, `${n}: photo stored as a file (${url.slice(0, 40)})`);
    const file = join(uploads, url.replace(/^\/uploads\//, ''));
    assert.ok(existsSync(file), `${n}: file on disk`);
    assert.equal(readFileSync(file).toString('base64'), PHOTO, `${n}: the same picture`);
  }
  assert.equal(by['Lentil Soup'].rating, 4);
  assert.equal(by['Lentil Soup [copy]'].rating, null, '0 stars is unrated');
  assert.equal(by['Twice Bread'].rating, 5, 'the first of the two');
  const lentil = await call('GET', `/api/recipes/${by['Lentil Soup'].id}`);
  assert.match(lentil.notes, /Family favorite\./);
  assert.match(lentil.notes, /Nutrition \(from Paprika\):\s*Calories: 210\s*Protein: 12 g/);
}

test('bulk import: photos, ratings, nutrition, and duplicates by name only inside the archive', { skip, timeout: 120000 }, async () => {
  await withServer(async (s) => {
    const fd = new FormData();
    fd.append('file', new Blob([await archive()]), 'export.paprikarecipes');
    const scan = await s.call('POST', '/api/recipes/import-zip/scan', fd);
    // The picker gets a small photo as its thumbnail, never as img_url.
    const lentil = scan.recipes.find(x => x.name === 'Lentil Soup');
    assert.equal(lentil.img_url, null);
    assert.equal(lentil.has_image_asset, true);
    assert.equal(lentil.thumb_data_url, `data:image/jpeg;base64,${PHOTO}`);
    assert.equal(scan.recipes.find(x => x.name === 'Bean Soup').img_url, 'https://example.com/bean.jpg');
    const commit = new FormData();
    commit.append('uploadId', scan.uploadId);
    commit.append('import_images', 'true');
    const done = await s.call('POST', '/api/recipes/import-zip/commit', commit);
    await check(s, (done.skipped || done.skippedDup || []).map(x => x.name));
  });
});

test('single-file import of the archive works the same way', { skip, timeout: 120000 }, async () => {
  await withServer(async (s) => {
    const fd = new FormData();
    fd.append('file', new Blob([await archive()]), 'export.paprikarecipes');
    const done = await s.call('POST', '/api/recipes/import', fd);
    await check(s, (done.skipped || []).map(x => x.name));
  });
});

test('Replace updates the recipe you have, keeping its cooks, favorite and stars', { skip, timeout: 120000 }, async () => {
  await withServer(async (s) => {
    // Yours, with stars, a favorite and a cook. Twice Bread is in the
    // archive twice (5 stars, then 2): both replace it in turn. Pea Soup is
    // unrated there, so your stars stay.
    const mine = await s.call('POST', '/api/recipes', { name: 'Twice Bread', notes: 'My old notes.', rating: 3, favorite: true, img_url: 'https://example.com/my-bread.jpg', ingredients: [], steps: [] });
    const pea = await s.call('POST', '/api/recipes', { name: 'Pea Soup', rating: 3, ingredients: [], steps: [] });
    await s.call('POST', `/api/recipes/${mine.id}/cooked`, {});
    const fd = new FormData();
    fd.append('file', new Blob([await archive()]), 'export.paprikarecipes');
    const scan = await s.call('POST', '/api/recipes/import-zip/scan', fd);
    const commit = new FormData();
    commit.append('uploadId', scan.uploadId);
    commit.append('import_images', 'true');
    commit.append('dedup', 'replace');
    await s.call('POST', '/api/recipes/import-zip/commit', commit);
    const all = await s.call('GET', '/api/recipes');
    const list = Array.isArray(all) ? all : all.recipes || all.items;
    assert.equal(list.filter(r => r.name.toLowerCase() === 'twice bread').length, 1, 'no second copy');
    const got = await s.call('GET', `/api/recipes/${mine.id}`);
    assert.deepEqual(got.ingredients.flatMap(g => g.items.map(i => i.name)), ['lentils'], 'the imported content');
    assert.equal(got.notes, null);
    assert.equal(got.rating, 2, "the archive's stars, from its last copy");
    assert.equal((await s.call('GET', `/api/recipes/${pea.id}`)).rating, 3, 'unrated in the archive: your stars stay');
    assert.equal(!!got.favorite, true, 'your favorite stays');
    assert.equal(got.img_url, 'https://example.com/my-bread.jpg', 'no picture in the archive: yours stays');
    const diary = await s.call('GET', '/api/cook-diary');
    const cooks = (Array.isArray(diary) ? diary : diary.entries || diary.items || []).filter(c => c.recipe_id === mine.id);
    assert.equal(cooks.length, 1, 'your cook stays with it');
    const revs = await s.call('GET', `/api/recipes/${mine.id}/revisions`);
    assert.ok(revs.revisions.length >= 2, 'the replace is a new version; the old one is kept');
  });
});
