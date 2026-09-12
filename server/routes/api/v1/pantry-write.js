/**
 * /api/v1/pantry write-parity routes, mounted alongside the existing
 * read-only federation pantry.js at the same '/pantry' prefix. Kept in
 * a separate file rather than added to pantry.js because that file's
 * own docstring frames it specifically as "read-only pantry access for
 * authorized federation clients", mixing in a general-purpose write
 * route there would misdescribe its purpose. See cook-diary.js in this
 * same directory for the full auth/flag contract this sub-router shares.
 */
import { Router } from 'express';
import { requireScope } from '../../../middleware/bearer-auth.js';
import { wrap } from '../../../logger.js';
import { updatePantryStockCore } from '../../../lib/mcp/tools/update-pantry-stock.js';

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

// A hand-written curl/automation call is a natural place to accidentally
// send the STRING "false" instead of a real JSON boolean; any non-empty
// string is truthy in JS, so passing it straight to updatePantryStockCore's
// `in_stock ? 1 : 0` would silently set stock to in-stock, the opposite of
// intent. Normalize explicitly instead of trusting truthiness.
function _toBool(v) {
  if (v === undefined) return undefined;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
    return true;
  }
  return !!v;
}

router.patch('/:id/stock', requireWriteEnabled, requireScope('mcp:write'), wrap((req, res) => {
  const rawQuantity = req.body?.quantity;
  const quantity = rawQuantity === undefined ? undefined : Number(rawQuantity);
  if (quantity !== undefined && !Number.isFinite(quantity)) {
    return res.status(400).json({ error: 'quantity must be a number' });
  }
  try {
    res.json(updatePantryStockCore(req.apiUser.id, {
      item_id: Number(req.params.id),
      in_stock: _toBool(req.body?.in_stock),
      quantity,
    }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

export default router;
