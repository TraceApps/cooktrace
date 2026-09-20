/**
 * /api/v1/shopping for sister apps (today NoteTrace): the token owner's
 * shopping list, to show it, add to it, tick it off, and clear what's been
 * bought. A token with the `shopping` scope gets these routes without any
 * server switch, the way NutriTrace's `read:recipes` federation works.
 *
 * Tokens without `shopping` skip this router and reach the general public
 * API (shopping.js), which keeps its PUBLIC_API_ENABLED gate and mcp:*
 * scopes, so existing scripts behave exactly as before.
 *
 * Endpoints:
 *   GET    /api/v1/shopping?include_checked=true|false   { items }, sorted like the Shopping page
 *   POST   /api/v1/shopping          { items: [{ name, quantity?, unit?, aisle? }] } or one item
 *                                    → 201 { added, skipped } (skipped: already on the list unchecked)
 *   PATCH  /api/v1/shopping/:id/check  { checked }        → { ok, item_id, name, checked }
 *   DELETE /api/v1/shopping/checked                        → { removed }
 */
import { Router } from 'express';
import { wrap } from '../../../logger.js';
import { checkShoppingItemCore } from '../../../lib/mcp/tools/check-shopping-item.js';
import {
  listShoppingItems, addShoppingItems, clearCheckedItems, cleanIncomingItem,
} from '../../../lib/shopping-items.js';

const MAX_ITEMS = 200;

const router = Router();

// Only tokens with the shopping scope; everyone else carries on to the public API router.
router.use((req, res, next) => {
  if (Array.isArray(req.apiToken?.scopes) && req.apiToken.scopes.includes('shopping')) return next();
  return next('router');
});

router.get('/', wrap((req, res) => {
  const includeChecked = req.query.include_checked !== 'false';
  const items = listShoppingItems(req.apiUser.id, { includeChecked });
  res.json({ count: items.length, items });
}));

router.post('/', wrap((req, res) => {
  const body = req.body || {};
  const raw = Array.isArray(body.items) ? body.items : [body];
  if (raw.length > MAX_ITEMS) return res.status(400).json({ error: `At most ${MAX_ITEMS} items at a time` });
  const items = raw.map(cleanIncomingItem).filter(Boolean);
  if (!items.length) return res.status(400).json({ error: 'Each item needs a name' });
  const result = addShoppingItems(req.apiUser.id, items);
  res.status(201).json(result);
}));

router.patch('/:id/check', wrap((req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    res.json(checkShoppingItemCore(req.apiUser.id, { item_id: id, checked: !!req.body?.checked }));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
}));

router.delete('/checked', wrap((req, res) => {
  res.json({ removed: clearCheckedItems(req.apiUser.id) });
}));

export default router;
