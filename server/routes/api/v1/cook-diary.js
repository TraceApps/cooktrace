/**
 * /api/v1/cook-diary, general-purpose cook-diary read/write for a
 * user's own scripts and automations, not a sister-app federation
 * contract like the other /api/v1 sub-routers.
 *
 * Reuses the exact same xCore() functions the matching MCP tools call
 * (server/lib/mcp/tools/*.js), so this file is not a second copy of the
 * cook-diary query/write logic. Responses are the bare data object as
 * JSON, not MCP's toolResult envelope.
 *
 * Auth: bearer token via the same api_tokens table and mcp:read/mcp:write
 * scopes MCP already uses. One token then works for both MCP and REST
 * access; a scope describes what class of access it grants, not which
 * protocol carries it. The write route additionally requires
 * PUBLIC_API_WRITE_ENABLED=1 on the server, mirrors MCP's own
 * MCP_ENABLED/MCP_WRITE_ENABLED split.
 */
import { Router } from 'express';
import { requireScope } from '../../../middleware/bearer-auth.js';
import { wrap } from '../../../logger.js';
import { listCookDiaryCore } from '../../../lib/mcp/tools/list-cook-diary.js';
import { logCookCore } from '../../../lib/mcp/tools/log-cook.js';

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
  listCookDiaryCore(req.apiUser.id, {
    date_from: req.query.date_from,
    date_to: req.query.date_to,
    kind: req.query.kind,
    limit: req.query.limit,
  })
));

router.post('/', requireWriteEnabled, requireScope('mcp:write'), core(req =>
  logCookCore(req.apiUser.id, req.body)
));

export default router;
