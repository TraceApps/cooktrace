/**
 * The pure half of the browser's offline mode: what gets queued, how the
 * queue collapses, and what a screen sees while work is waiting. No browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOfflineError, isMirroredGet, writeOp, collapseOps, sentSeqs, answerWithOps,
  describeOp, shouldRetryStatus, newTempId, isTempId, createdId, remapIds, remapPath, pathOf, mirrorKey,
} from '../src/lib/offline-edits.js';

const op = (seq, method, path, body, extra = {}) => {
  const w = writeOp(method, path, body);
  return { seq, method, path, body, at: seq, ...w, ...extra };
};
const made = (seq, kind, body, tempId) => ({ seq, kind, body, tempId, id: tempId, key: `${kind.replace('-create', '')}:${tempId}` });

test('a server being unreachable is told apart from a real answer', () => {
  assert.equal(isOfflineError(new TypeError('Failed to fetch')), true);
  assert.equal(isOfflineError(Object.assign(new Error('x'), { offline: true })), true);
  assert.equal(isOfflineError(new Error('API error 400')), false);
});

test('the reads a kitchen and a shop need are kept', () => {
  for (const path of ['/api/shopping', '/api/pantry', '/api/pantry/categories', '/api/recipes',
                      '/api/recipes/12', '/api/recipes/12/comments', '/api/cook-diary', '/api/units', '/api/settings']) {
    assert.equal(isMirroredGet(path), true, `${path} is kept`);
  }
  // Not kept: these need the server and say so.
  assert.equal(isMirroredGet('/api/ai/chat'), false);
  assert.equal(isMirroredGet('/api/kitchens'), false);
  assert.equal(mirrorKey('/api/cook-diary?from=a&to=b'), '/api/cook-diary?from=a&to=b');
  assert.equal(pathOf('/api/cook-diary?from=a'), '/api/cook-diary');
});

test('the writes this layer takes on are recognised, and sharing is not', () => {
  assert.equal(writeOp('POST', '/api/shopping', {}).kind, 'shopping-create');
  assert.equal(writeOp('PATCH', '/api/shopping/12/check', { checked: 1 }).kind, 'shopping-check');
  assert.equal(writeOp('DELETE', '/api/shopping/checked').kind, 'shopping-clear');
  assert.equal(writeOp('POST', '/api/shopping/reorder', {}).kind, 'shopping-reorder');
  assert.equal(writeOp('PATCH', '/api/pantry/3/stock', {}).kind, 'pantry-stock');
  assert.equal(writeOp('POST', '/api/cook-diary', {}).kind, 'diary-create');
  assert.equal(writeOp('PUT', '/api/recipes/4', {}).kind, 'recipe-update');
  assert.equal(writeOp('POST', '/api/recipes/4/comments', {}).kind, 'comment-create');
  assert.equal(writeOp('PUT', '/api/settings', { key: 'unit' }).key, 'setting:unit');
  // Who can see your food is never decided from a list pulled down hours ago.
  assert.equal(writeOp('POST', '/api/recipes/4/share', {}), null);
  assert.equal(writeOp('POST', '/api/kitchens', {}), null);
  assert.equal(writeOp('POST', '/api/kitchens/2/members', {}), null);
  // Nor are imports, uploads or AI.
  assert.equal(writeOp('POST', '/api/recipes/import', {}), null);
  assert.equal(writeOp('POST', '/api/ai/chat', {}), null);
});

test('ticking the same item twice in a shop goes up once', () => {
  const ops = [
    op(1, 'PATCH', '/api/shopping/12/check', { checked: 1 }),
    op(2, 'PATCH', '/api/shopping/12/check', { checked: 0 }),
    op(3, 'PATCH', '/api/shopping/13/check', { checked: 1 }),
  ];
  const sent = collapseOps(ops);
  assert.equal(sent.length, 2);
  assert.equal(sent.find(o => o.id === 12).body.checked, 0);
  assert.deepEqual(sentSeqs(ops, ['shopping-check:12', 'shopping-check:13']).sort(), [1, 2, 3]);
});

test('an item added and then removed in the shop never goes up', () => {
  const tempId = newTempId();
  const ops = [
    made(1, 'shopping-create', { name: 'Milk' }, tempId),
    { ...op(2, 'DELETE', `/api/shopping/${tempId}`), key: `shopping:${tempId}` },
  ];
  assert.deepEqual(collapseOps(ops), []);
  assert.deepEqual(sentSeqs(ops, []).sort(), [1, 2]);
});

test('an item added and then edited goes up as one item', () => {
  const tempId = newTempId();
  const ops = [
    made(1, 'shopping-create', { name: 'Milk', quantity: 1 }, tempId),
    { ...op(2, 'PUT', `/api/shopping/${tempId}`, { quantity: 2 }), key: `shopping:${tempId}` },
  ];
  const sent = collapseOps(ops);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.name, 'Milk');
  assert.equal(sent[0].body.quantity, 2);
});

test('the shopping list shows what you did to it while offline', () => {
  const tempId = newTempId();
  const mirrored = [{ id: 1, name: 'Eggs', checked: 0 }, { id: 2, name: 'Flour', checked: 0 }];
  const ops = [
    { seq: 1, kind: 'shopping-check', id: 1, key: 'shopping-check:1', body: { checked: 1 } },
    { seq: 2, kind: 'shopping-delete', id: 2, key: 'shopping:2' },
    made(3, 'shopping-create', { name: 'Butter' }, tempId),
  ];
  const shown = answerWithOps('/api/shopping', mirrored, ops);
  assert.deepEqual(shown.map(r => r.name), ['Eggs', 'Butter']);
  assert.equal(shown[0].checked, 1);
  assert.equal(shown[1].id, tempId);
});

test('clearing what you ticked empties those rows, not the rest', () => {
  const mirrored = [{ id: 1, name: 'Eggs', checked: 1 }, { id: 2, name: 'Flour', checked: 0 }];
  const shown = answerWithOps('/api/shopping', mirrored, [{ seq: 1, kind: 'shopping-clear', key: 'shopping:clear-checked' }]);
  assert.deepEqual(shown.map(r => r.name), ['Flour']);
});

test('a list written from nothing still shows, on a screen never opened online', () => {
  const tempId = newTempId();
  const shown = answerWithOps('/api/shopping', undefined, [made(1, 'shopping-create', { name: 'Milk' }, tempId)]);
  assert.deepEqual(shown.map(r => r.name), ['Milk']);
  // With nothing queued and nothing kept, there is genuinely no answer.
  assert.equal(answerWithOps('/api/shopping', undefined, []), undefined);
});

test('the pantry shows what you counted offline', () => {
  const mirrored = [{ id: 5, name: 'Rice', in_stock: 1 }];
  const shown = answerWithOps('/api/pantry', mirrored, [{ seq: 1, kind: 'pantry-stock', id: 5, key: 'pantry-stock:5', body: { in_stock: 0 } }]);
  assert.equal(shown[0].in_stock, 0);
  assert.equal(shown[0]._pending, true);
});

test('a recipe edited offline reads back edited, and a cook shows in the diary', () => {
  const recipe = answerWithOps('/api/recipes/4', { id: 4, title: 'Old', servings: 2 },
    [{ seq: 1, kind: 'recipe-update', id: 4, key: 'recipe:4', body: { title: 'New' } }]);
  assert.equal(recipe.title, 'New');
  assert.equal(recipe.servings, 2, 'what the edit did not mention is kept');
  const tempId = newTempId();
  const diary = answerWithOps('/api/cook-diary', [], [made(1, 'diary-create', { recipe_id: 4, date: '2026-09-20' }, tempId)]);
  assert.equal(diary.length, 1);
  assert.equal(diary[0].id, tempId);
});

test('a note left on a recipe offline shows on that recipe, not another', () => {
  const ops = [{ seq: 1, kind: 'comment-create', path: '/api/recipes/4/comments', body: { body: 'more salt' }, tempId: -1 }];
  assert.equal(answerWithOps('/api/recipes/4/comments', [], ops).length, 1);
  assert.deepEqual(answerWithOps('/api/recipes/9/comments', [], ops), []);
});

test('a temporary id cannot be mistaken for a server one, and references follow it', () => {
  const a = newTempId(), b = newTempId();
  assert.ok(isTempId(a) && isTempId(b) && a !== b);
  assert.equal(isTempId(42), false);
  assert.equal(createdId({ id: 77 }), 77);
  assert.equal(createdId({ item: { id: 88 } }), 88);
  assert.equal(createdId({ id: -3 }), null);
  assert.deepEqual(remapIds({ recipe_id: -7, pantry_id: 4 }, { '-7': 91 }), { recipe_id: 91, pantry_id: 4 });
  assert.equal(remapPath('/api/shopping/-7/check', { '-7': 91 }), '/api/shopping/91/check');
});

test('a hiccup is retried, a refusal is not, and an expired session never loses work', () => {
  assert.equal(shouldRetryStatus(503), true);
  assert.equal(shouldRetryStatus(429), true);
  assert.equal(shouldRetryStatus(401), true);
  assert.equal(shouldRetryStatus(403), true);
  assert.equal(shouldRetryStatus(undefined), true, 'an error with no status is not a considered refusal');
  assert.equal(shouldRetryStatus(400), false);
  assert.equal(shouldRetryStatus(404), false);
});

test('a refused change is described the way its author would describe it', () => {
  assert.match(describeOp({ kind: 'shopping-check' }), /ticked off/);
  assert.match(describeOp({ kind: 'shopping-create', body: { name: 'Milk' } }), /"Milk".*shopping list/);
  assert.match(describeOp({ kind: 'pantry-stock' }), /in or out of stock/);
  assert.match(describeOp({ kind: 'diary-create' }), /cook you logged/);
  assert.match(describeOp({ kind: 'recipe-update' }), /recipe you changed/);
  assert.ok(!describeOp({ kind: 'shopping-check' }).includes('/api/'));
});

test('"I cooked this" from a recipe queues like a diary entry', () => {
  assert.equal(writeOp('POST', '/api/recipes/4/cooked', { date: '2026-09-20' }).kind, 'diary-create');
  assert.equal(writeOp('PUT', '/api/recipes/4/cooks/9', {}).kind, 'diary-update');
  assert.equal(writeOp('DELETE', '/api/recipes/4/cooks/9').kind, 'diary-delete');
  assert.equal(writeOp('PUT', '/api/recipes/4/cooks/9', {}).key, 'diary:9');
});

test('a photo taken offline travels inside the row', () => {
  // The upload endpoint cannot be reached, so the photo is embedded and the
  // server turns it back into a file (server/lib/image-localizer.js).
  const body = { photos: ['data:image/jpeg;base64,abc'], date: '2026-09-20' };
  const queued = writeOp('POST', '/api/recipes/4/cooked', body);
  assert.equal(queued.kind, 'diary-create');
  // Uploading itself is never queued: there is nothing to upload to.
  assert.equal(writeOp('POST', '/api/upload', {}), null);
});

test('your own profile, picture included, is queued like everything else', () => {
  assert.equal(writeOp('PUT', '/api/auth/profile', { nickname: 'Alex' }).key, 'profile');
  const ops = [
    op(1, 'PUT', '/api/auth/profile', { nickname: 'Al' }),
    op(2, 'PUT', '/api/auth/profile', { nickname: 'Alex', avatar_url: 'data:image/jpeg;base64,x' }),
  ];
  assert.equal(collapseOps(ops).length, 1);
  assert.equal(collapseOps(ops)[0].body.nickname, 'Alex');
  assert.match(describeOp({ kind: 'profile' }), /your profile/);
});
