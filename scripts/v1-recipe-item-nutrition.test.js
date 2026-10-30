/**
 * Each ingredient in GET /api/v1/recipes/:id carries nutrition for the
 * recipe's amount (TraceApps/nutritrace#296).
 *
 * It used to carry the pantry row's values as they are stored, for the
 * pantry serving (usually 100 g), so NutriTrace showed 250 g of flour as
 * 100 g. Each item is now scaled with the same ratio CookTrace's own recipe
 * totals use (servingRatio in lib/quantity.js), says which serving the
 * values were for (basis), and an amount that can't be converted ships
 * unscaled with scaled: false.
 *
 * The real server, a real recipe with grams, cups, ml, counts and a pinch.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { computeRecipeNutrition } from '../src/lib/recipe-nutrition.js';

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
let ready = false;
try { serverRequire('better-sqlite3'); ready = true; } catch { /* server packages missing: skip */ }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SystemRoot', 'NODE_OPTIONS'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

const PANTRY = [
  { name: 'Flour', serving_size: 100, serving_unit: 'g', nutrition: { calories: 364, proteins: 10, carbohydrates: 76, fat: 1 } },
  { name: 'Sugar', serving_size: 100, serving_unit: 'g', g_per_cup: 200, nutrition: { calories: 387, carbohydrates: 100 } },
  { name: 'Milk', serving_size: 100, serving_unit: 'ml', nutrition: { calories: 64, proteins: 3.3, fat: 3.6 } },
  { name: 'Egg', serving_size: 1, serving_unit: 'pc', nutrition: { calories: 72, proteins: 6.3, fat: 4.8 } },
  { name: 'Salt', serving_size: 100, serving_unit: 'g', nutrition: { sodium: 38.7 } },
];
const LINES = [
  { name: 'Flour', qty: '250', unit: 'g' },
  { name: 'Sugar', qty: '½', unit: 'cup' },
  { name: 'Milk', qty: '300', unit: 'ml' },
  { name: 'Egg', qty: '2', unit: 'pc' },
  { name: 'Salt', qty: '1', unit: 'pinch' },
];

test('v1 recipe items carry nutrition for the recipe amount', { skip: !ready && 'server packages missing' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-v1-item-nutr-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['index.js'], {
    cwd: fileURLToPath(new URL('../server/', import.meta.url)),
    env: { ...cleanEnv(), PORT: String(port), DB_PATH: join(dir, 'ct.db'), UPLOADS_PATH: join(dir, 'uploads'), BACKUPS_PATH: join(dir, 'backups'), JWT_SECRET: 'v1-item-nutrition-test-0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error', UPDATE_CHECK: 'off' },
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
    assert.ok(up, 'server did not start');
    let token = null;
    const call = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text();
      assert.ok(r.ok, `${method} ${p} -> ${r.status} ${t.slice(0, 200)}`);
      return t ? JSON.parse(t) : null;
    };
    const PW = 'Str0ng-Pass-77!x';
    await call('POST', '/api/auth/register', { username: 'cook', password: PW });
    token = (await call('POST', '/api/auth/login', { username: 'cook', password: PW })).token;
    const pantry = [];
    for (const p of PANTRY) pantry.push({ ...p, ...(await call('POST', '/api/pantry', p)) });
    const byName = new Map(pantry.map((p) => [p.name, p]));
    const items = LINES.map((l) => ({ ...l, pantry_item_id: byName.get(l.name).id }));
    const recipe = await call('POST', '/api/recipes', { name: 'Pancakes', servings: 1, ingredients: [{ group: '', items }] });
    const raw = (await call('POST', '/api/admin/api-tokens', { name: 'nt', scopes: ['read:recipes'], password: PW })).raw;
    token = raw;
    const got = await call('GET', `/api/v1/recipes/${recipe.id}`);
    const it = Object.fromEntries(got.items.map((x) => [x.name, x]));

    // Grams, cups through grams per cup, ml, counts: scaled.
    assert.equal(it.Flour.nutrition.calories, 910);
    assert.equal(it.Flour.scaled, true);
    assert.deepEqual(it.Flour.basis, { amount: 100, unit: 'g' });
    assert.equal(it.Sugar.nutrition.calories, 387);
    assert.equal(it.Sugar.portion, 0.5, 'the amount shown is the amount scaled to');
    assert.equal(it.Milk.nutrition.calories, 192);
    assert.deepEqual(it.Milk.basis, { amount: 100, unit: 'ml' });
    assert.equal(it.Egg.nutrition.calories, 144);
    assert.deepEqual(it.Egg.basis, { amount: 1, unit: 'pc' });
    // A pinch against 100 g: unscaled, and said so.
    assert.equal(it.Salt.scaled, false);
    assert.equal(it.Salt.nutrition.sodium, 38.7);
    assert.deepEqual(it.Salt.basis, { amount: 100, unit: 'g' });
    assert.equal(it.Salt.amount_text, '1 pinch');
    assert.equal(it.Flour.amount_text, undefined);

    // The scaled items add up to CookTrace's own recipe totals.
    const ct = computeRecipeNutrition([{ items }], new Map(pantry.map((p) => [p.id, p])));
    assert.equal(ct.used, 4);
    for (const k of ['calories', 'proteins', 'fat', 'carbohydrates']) {
      const sum = got.items.filter((x) => x.scaled).reduce((s, x) => s + (x.nutrition[k] || 0), 0);
      assert.ok(Math.abs(sum - ct.nutrition[k]) < 0.1, `${k}: items ${sum} vs CookTrace ${ct.nutrition[k]}`);
    }
  } finally {
    await new Promise((res) => { if (proc.exitCode != null || proc.signalCode != null) return res(); proc.once('exit', res); proc.kill('SIGKILL'); });
    rmSync(dir, { recursive: true, force: true });
  }
});
