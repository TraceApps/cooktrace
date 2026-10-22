import { Router } from 'express';
import { logger } from '../logger.js';
import { fetchChecked, readBody } from '../lib/ssrf-guard.js';
import { makeRateLimiter } from '../middleware/rate-limit.js';

const router = Router();
const proxyLimit = makeRateLimiter({ max: 60, windowMs: 60_000, label: 'proxy' });
router.use(proxyLimit);

// Whitelist: hosts allowed for API proxy (JSON responses)
const API_ALLOWED = ['world.openfoodfacts.org', 'search.openfoodfacts.org', 'api.nal.usda.gov'];

// Image proxy: allowed hosts for image passthrough (binary responses)
const IMG_ALLOWED = ['external-content.duckduckgo.com', 'i5.walmartimages.com', 'images.openfoodfacts.org',
  'i.imgur.com', 'upload.wikimedia.org', 'www.kroger.com', 'target.scene7.com'];

// Strict host match: equal OR proper subdomain. Rejects 'i.imgur.com.evil.tld'.
function _hostMatches(hostname, allowed) {
  return hostname === allowed || hostname.endsWith('.' + allowed);
}

router.get('/', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return res.status(403).json({ error: 'Protocol not allowed' });
    }
    const isApiHost = API_ALLOWED.some(h => _hostMatches(parsed.hostname, h));
    const isImgHost = IMG_ALLOWED.some(h => _hostMatches(parsed.hostname, h));

    if (!isApiHost && !isImgHost) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    // Only the allowed public hosts, and a redirect may not lead into the
    // server's own network or to cloud metadata.
    const response = await fetchChecked(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CookTrace/1.0)' },
    }, { maxRedirects: 3 });

    if (!response.ok) {
      logger.warn(`[proxy] upstream ${response.status} for ${url}`);
      return res.status(response.status).json({ error: `Upstream ${response.status}` });
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    // Image response: only an image, sent so it can't act as a page. This
    // answers from the app's own origin, before sign-in, so an image host's
    // HTML or SVG passed through as-is could have run script as the app.
    // (An image host that names no type gets image/jpeg, as before.)
    if (contentType.startsWith('image/') || (isImgHost && !contentType)) {
      const buffer = await readBody(response, 10 * 1024 * 1024);
      clearTimeout(timer);
      res.set('Content-Type', contentType || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      return res.send(buffer);
    }
    if (isImgHost) {
      clearTimeout(timer);
      try { await response.body?.cancel(); } catch {}
      return res.status(502).json({ error: 'That address is not an image' });
    }

    // JSON API response
    const body = JSON.parse((await readBody(response, 5 * 1024 * 1024)).toString('utf8'));
    clearTimeout(timer);
    res.json(body);
  } catch(e) {
    logger.error('[proxy] fetch error:', e.message, 'url:', url);
    res.status(503).json({ error: 'Could not reach that service' });
  }
});

export default router;
