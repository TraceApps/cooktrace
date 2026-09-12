/**
 * /api/v1/shopping, general-purpose shopping-list read/write for a
 * user's own scripts and automations. See cook-diary.js in this same
 * directory for the full auth/flag contract this sub-router shares.
 */
import { Router } from 'express';
import { requireScope } from '../../../middleware/bearer-auth.js';
import { wrap } from '../../../logger.js';
import { listShoppingListCore } from '../../../lib/mcp/tools/list-shopping-list.js';
import { checkShoppingItemCore } from '../../../lib/mcp/tools/check-shopping-item.js';

const router = Router();

function _envFlag(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

const ENABLED       = _envFlag(process.env.PUBLIC_API_ENABLED);
const WRITE_ENABLED = _envFlag(process.env.PUBLIC_API_WRITE_ENABLED);

router.use((req, res, next) => {
  if (!ENABLED) return res.status(404).json({ error: 'Public API not enabled on this server' });
  next();
});

function requireWriteEnabled(req, res, next) {
  if (!WRITE_ENABLED) return res.status(404).json({ error: 'Public API writes not enabled on this server' });
  next();
}

function core(fn) {
  return wrap((req, res) => {
    try {
      res.json(fn(req));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

router.get('/', requireScope('mcp:read'), core(req =>
  listShoppingListCore(req.apiUser.id, { include_checked: req.query.include_checked === 'true' })
));

router.patch('/:id/check', requireWriteEnabled, requireScope('mcp:write'), core(req =>
  checkShoppingItemCore(req.apiUser.id, { item_id: Number(req.params.id), checked: !!req.body?.checked })
));

export default router;
