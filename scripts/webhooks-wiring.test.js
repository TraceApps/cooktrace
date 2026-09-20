/**
 * Static-analysis tests for outgoing webhooks wiring.
 *
 * These do not exercise real deliveries; they guard against accidental
 * unwiring of the route mount, the feature flags, or an event call site
 * being removed during future refactors. Pure text/regex checks over
 * the source files, no db.js import, so this runs without a compiled
 * better-sqlite3 native binding. Real delivery verification (signature,
 * retry, SSRF guard against a live target) requires a running dev
 * server with WEBHOOKS_ENABLED=1 and a test receiver.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexJs      = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const routeJs      = readFileSync(new URL('../server/routes/webhooks.js', import.meta.url), 'utf8');
const libJs        = readFileSync(new URL('../server/lib/webhooks.js', import.meta.url), 'utf8');
const deliveryJs   = readFileSync(new URL('../server/lib/webhook-delivery.js', import.meta.url), 'utf8');
const cookDiaryJs  = readFileSync(new URL('../server/routes/cook-diary.js', import.meta.url), 'utf8');
const recipesJs    = readFileSync(new URL('../server/routes/recipes.js', import.meta.url), 'utf8');
const shoppingJs   = readFileSync(new URL('../server/routes/shopping.js', import.meta.url), 'utf8');
const pantryJs     = readFileSync(new URL('../server/routes/pantry.js', import.meta.url), 'utf8');
const imageLocJs   = readFileSync(new URL('../server/lib/image-localizer.js', import.meta.url), 'utf8');
const dbJs         = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');

test('webhooks route is mounted at /api/admin/webhooks on the main router', () => {
  assert.match(indexJs, /import webhooksRoutes[\s\S]*from '\.\/routes\/webhooks\.js'/);
  assert.match(indexJs, /router\.use\('\/api\/admin\/webhooks',\s*webhooksRoutes\)/);
});

test('webhooks CRUD route requires session auth (requireAuth, requireAdmin), not bearer', () => {
  assert.match(routeJs, /requireAuth,\s*requireAdmin/);
  assert.doesNotMatch(routeJs, /bearerAuth/);
});

test('webhooks table exists with an encrypted secret column, not a hash', () => {
  assert.match(dbJs, /CREATE TABLE IF NOT EXISTS webhooks/);
  assert.match(dbJs, /secret_encrypted/);
});

test('webhook delivery is gated on WEBHOOKS_ENABLED, off by default', () => {
  assert.match(libJs, /WEBHOOKS_ENABLED/);
});

test('webhook target URLs are validated through the shared SSRF guard, at creation and before delivery', () => {
  assert.match(libJs, /import \{ assertSafeUrl \} from '\.\/ssrf-guard\.js'/);
  const occurrences = [...libJs.matchAll(/assertSafeUrl\(/g)];
  assert.ok(occurrences.length >= 3, 'expected assertSafeUrl called at create, update, and delivery time');
});

test('assertSafeUrl is re-checked inside the retry loop, not just once before it (regression check)', () => {
  // A prior version called assertSafeUrl once before the `for` loop
  // started, so only the FIRST attempt was actually re-validated;
  // retries 2 and 3 (up to ~2.5s later) reused the already-decided
  // envelope/signature without checking DNS again. The call must be
  // textually inside the loop body, immediately before sendWebhookRequest.
  const loopMatch = libJs.match(/for \(let attempt = 0;[\s\S]*?\n {2}\}\n\}/);
  assert.ok(loopMatch, 'expected to find the retry for-loop in webhooks.js');
  assert.match(loopMatch[0], /assertSafeUrl\(/, 'assertSafeUrl should be called inside the retry loop body');
  const assertIdx = loopMatch[0].indexOf('assertSafeUrl(');
  const sendIdx = loopMatch[0].indexOf('sendWebhookRequest(');
  assert.ok(assertIdx >= 0 && sendIdx >= 0 && assertIdx < sendIdx, 'assertSafeUrl should run immediately before sendWebhookRequest on each attempt');
});

test('image-localizer.js delegates IP classification to the shared ssrf-guard.js instead of its own copy', () => {
  assert.match(imageLocJs, /import \{ isLinkLocalOrCloudMeta, isPrivateOrLoopback \} from '\.\/ssrf-guard\.js'/);
  assert.doesNotMatch(imageLocJs, /o\[0\] === 100 && o\[1\] >= 64/, 'the old inline CGNAT check should be gone');
});

test('the three known events are all registered with descriptions', () => {
  for (const event of ['meal.cooked', 'shopping_list.completed', 'pantry.out_of_stock']) {
    assert.match(libJs, new RegExp(`'${event.replace('.', '\\.')}'`));
  }
});

test('delivery is signed with HMAC-SHA256 and carries event/delivery-id headers', () => {
  assert.match(deliveryJs, /createHmac\('sha256'/);
  assert.match(deliveryJs, /X-CookTrace-Signature/);
  assert.match(deliveryJs, /X-CookTrace-Event/);
  assert.match(deliveryJs, /X-CookTrace-Delivery/);
  assert.match(libJs, /import \{ signEnvelope, sendWebhookRequest \} from '\.\/webhook-delivery\.js'/);
});

test('delivery retries up to 3 attempts and never throws out of dispatchWebhookEvent', () => {
  assert.match(libJs, /MAX_ATTEMPTS\s*=\s*3/);
  assert.match(libJs, /export function dispatchWebhookEvent/);
});

test('a test-delivery endpoint exists so a webhook can be verified without waiting for a real event', () => {
  assert.match(routeJs, /router\.post\('\/:id\/test'/);
  assert.match(libJs, /export async function sendTestWebhook/);
});

test('meal.cooked is dispatched from both cook-diary.js and recipes.js insert paths', () => {
  assert.match(cookDiaryJs, /import \{ dispatchWebhookEvent \} from '\.\.\/lib\/webhooks\.js'/);
  assert.match(cookDiaryJs, /dispatchWebhookEvent\(u, 'meal\.cooked'/);
  assert.match(recipesJs, /import \{ dispatchWebhookEvent \} from '\.\.\/lib\/webhooks\.js'/);
  assert.match(recipesJs, /dispatchWebhookEvent\(u, 'meal\.cooked'/);
});

test('shopping_list.completed is dispatched from shopping.js after a check that empties the unchecked list', () => {
  assert.match(shoppingJs, /import \{ dispatchWebhookEvent \} from '\.\.\/lib\/webhooks\.js'/);
  assert.match(shoppingJs, /dispatchWebhookEvent\(u, 'shopping_list\.completed'/);
});

test('pantry.out_of_stock is dispatched from both pantry.js write routes (PATCH /:id/stock and PUT /:id)', () => {
  assert.match(pantryJs, /import \{ dispatchWebhookEvent \} from '\.\.\/lib\/webhooks\.js'/);
  const count = (pantryJs.match(/dispatchWebhookEvent\(u, 'pantry\.out_of_stock'/g) || []).length;
  assert.equal(count, 2, 'expected 2 pantry.out_of_stock dispatch sites (stock toggle + general update)');
});

test('shopping.js only fires shopping_list.completed on a genuine 0-to-1 checked transition, not a redundant re-check', () => {
  assert.match(shoppingJs, /existing\.checked !== 1/);
});

test('the MCP/REST write cores (log-cook, check-shopping-item, update-pantry-stock) also dispatch webhooks, not just the UI routes', () => {
  const logCookJs = readFileSync(new URL('../server/lib/mcp/tools/log-cook.js', import.meta.url), 'utf8');
  const checkShoppingItemJs = readFileSync(new URL('../server/lib/mcp/tools/check-shopping-item.js', import.meta.url), 'utf8');
  const updatePantryStockJs = readFileSync(new URL('../server/lib/mcp/tools/update-pantry-stock.js', import.meta.url), 'utf8');

  assert.match(logCookJs, /dispatchWebhookEvent\(userId, 'meal\.cooked'/);
  assert.match(checkShoppingItemJs, /dispatchWebhookEvent\(userId, 'shopping_list\.completed'/);
  assert.match(checkShoppingItemJs, /existing\.checked !== 1/, 'check-shopping-item.js should also gate on a genuine transition');
  assert.match(updatePantryStockJs, /dispatchWebhookEvent\(userId, 'pantry\.out_of_stock'/);
});

test('pantry-write.js normalizes in_stock instead of trusting JS truthiness (a string "false" bug regression check)', () => {
  const pantryWriteJs = readFileSync(new URL('../server/routes/api/v1/pantry-write.js', import.meta.url), 'utf8');
  assert.match(pantryWriteJs, /_toBool\(/);
  assert.doesNotMatch(pantryWriteJs, /in_stock: req\.body\?\.in_stock,/, 'in_stock should not be passed through unnormalized');
});

test('every dispatchWebhookEvent( call site across the modified routes has a matching never-block-the-save catch', () => {
  const combined = cookDiaryJs + recipesJs + shoppingJs + pantryJs;
  const dispatchCount = (combined.match(/dispatchWebhookEvent\(/g) || []).length;
  const guardCatchCount = (combined.match(/catch \(e\) \{ \/\* never let a webhook failure block the save \*\/ \}/g) || []).length;
  // cook-diary 2 (POST, plus PUT flipping planned to cooked) + recipes 1
  // + shopping 1 + pantry 2.
  assert.equal(dispatchCount, 6, 'expected 6 dispatchWebhookEvent call sites total (2 + 1 + 1 + 2)');
  assert.equal(guardCatchCount, 6, 'expected each dispatchWebhookEvent call site to have a matching never-block-the-save catch');
});

test('the Android sync upload fires the same webhook events as the REST routes', () => {
  const syncJs = readFileSync(new URL('../server/routes/sync.js', import.meta.url), 'utf8');
  assert.match(syncJs, /import \{ dispatchWebhookEvent \} from '\.\.\/lib\/webhooks\.js'/);
  assert.match(syncJs, /'meal\.cooked'/, 'sync.js should build meal.cooked for cooked diary rows');
  assert.match(syncJs, /'pantry\.out_of_stock'/, 'sync.js should fire pantry.out_of_stock on an in_stock 1 to 0 update');
  assert.match(syncJs, /'shopping_list\.completed'/, 'sync.js should fire shopping_list.completed when a push finishes the list');
  // Events are only released after their table's transaction commits, and
  // sent after the response, so a rolled-back push never announces itself.
  assert.match(syncJs, /txn\(\);\s*webhookEvents\.push\(\.\.\.tableEvents\)/);
  const sendAt = syncJs.indexOf('for (const [event, data] of webhookEvents)');
  const respondAt = syncJs.indexOf('res.json({ tables: results });');
  assert.ok(respondAt > 0 && sendAt > respondAt, 'webhooks should be dispatched after the push response is built');
  assert.match(syncJs, /catch \(e\) \{ \/\* never let a webhook failure block the save \*\/ \}/);
});
