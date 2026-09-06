/**
 * GET /api/v1/me
 *
 * Identity + token introspection. Always available regardless of the
 * token's scopes; used by NT (and any other client) to verify a token
 * is valid, discover which user + instance it belongs to, and see
 * what scopes were granted at mint time.
 */
import { Router } from 'express';
import { wrap } from '../../../logger.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const router = Router();

let _versionCache = null;
function _appVersion() {
  if (_versionCache) return _versionCache;
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(__dirname, '..', '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    _versionCache = String(pkg.version || 'unknown');
  } catch {
    _versionCache = 'unknown';
  }
  return _versionCache;
}

router.get('/', wrap((req, res) => {
  const u = req.apiUser;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host  = req.headers['x-forwarded-host'] || req.get('host') || '';
  res.json({
    user: {
      id: u.id,
      username: u.username,
      full_name: u.full_name || null,
      role: u.role || null,
    },
    instance: {
      url: host ? `${proto}://${host}` : null,
      version: _appVersion(),
    },
    scopes: req.apiToken.scopes,
  });
}));

export default router;
