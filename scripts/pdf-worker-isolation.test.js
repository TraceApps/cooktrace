/**
 * The PDF reader must never load in the server process.
 *
 * pdf-parse pulls in @napi-rs/canvas, whose prebuilt Skia binary uses CPU
 * instructions some virtual machines do not have. Loading it there raises
 * SIGILL, which kills the process and cannot be caught, so a static import
 * anywhere in the boot graph takes the whole server down at startup
 * (issue #59). PDFs are read in a child process instead.
 *
 * These are text checks plus a real walk of the import graph, so they run
 * without a compiled better-sqlite3 binding. The child-process behaviour
 * itself (a real PDF, a corrupt one, a worker killed by SIGILL, a timeout)
 * was verified by running the extractor directly.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, '../server');
const extractors = readFileSync(resolve(serverDir, 'lib/text-extractors.js'), 'utf8');

test('nothing in the server boot graph statically imports the PDF stack', () => {
  const seen = new Set();
  const offenders = [];
  const walk = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      if (spec === 'pdf-parse' || spec.startsWith('pdfjs') || spec.includes('napi-rs')) {
        offenders.push(`${relative(serverDir, file)} imports ${spec}`);
      }
      if (spec.startsWith('.')) walk(resolve(dirname(file), spec));
    }
  };
  walk(resolve(serverDir, 'index.js'));
  assert.ok(seen.size > 20, 'the walk should reach most of the server');
  assert.deepEqual(offenders, [], 'a static import here kills the server at boot on some CPUs');
});

test('PDF text extraction runs in a child process', () => {
  assert.match(extractors, /spawn\(process\.execPath, \[worker\]/);
  assert.match(extractors, /pdf-extract-worker\.js/);
  assert.doesNotMatch(extractors, /from 'pdf-parse'/, 'the parent must never import it');
  assert.ok(existsSync(resolve(serverDir, 'lib/pdf-extract-worker.js')), 'the worker ships');
});

test('a worker killed by a signal becomes a readable error, and a hung one is capped', () => {
  assert.match(extractors, /if \(signal\)/);
  assert.match(extractors, /SIGKILL.*PDF read timed out|PDF read timed out/s);
  assert.match(extractors, /PDF import is not available on this server/);
  assert.match(extractors, /PDF_TIMEOUT_MS/);
  assert.match(extractors, /child\.kill\('SIGKILL'\)/);
});

test('the worker answers with JSON and keeps the old error wording for a bad PDF', () => {
  const worker = readFileSync(resolve(serverDir, 'lib/pdf-extract-worker.js'), 'utf8');
  assert.match(worker, /await import\('pdf-parse'\)/);
  assert.match(worker, /JSON\.stringify\(\{ text/);
  assert.match(worker, /JSON\.stringify\(\{ error/);
  assert.match(extractors, /'PDF read failed: ' \+ parsed\.error/);
});
