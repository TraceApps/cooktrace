/**
 * The Android app's first native call after it reloads itself can lose its
 * answer (Capacitor's bridge runs the call before it starts answering the
 * new page). The database's first call must never be that call: a harmless
 * one, given up on after a moment, goes first.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the app primes the native bridge before the database opens', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const prime = main.indexOf('await primeNativeBridge();');
  const db = main.indexOf("await import('./lib/db-native.js')");
  assert.ok(prime > -1 && db > prime, 'primed first');
  assert.match(main, /Promise\.race\(\[\s*CapacitorSQLite\.echo\(/, 'its answer may be lost, so it is given up on');
  assert.match(main, /setTimeout\(resolve, 1000\)/);
});
