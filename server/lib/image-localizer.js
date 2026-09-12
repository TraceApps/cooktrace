/**
 * image-localizer.js — Download external images to /uploads/ and return local path.
 *
 * Used by food/meal routes to self-host external images (DuckDuckGo, Walmart, etc.)
 * so they're always available and don't depend on third-party proxies.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { logger } from '../logger.js';
import { isLinkLocalOrCloudMeta, isPrivateOrLoopback } from './ssrf-guard.js';

const UPLOADS_DIR = process.env.UPLOADS_PATH || './uploads';

/**
 * SSRF protection: block private/loopback/link-local IP ranges so an authed
 * user can't trick the server into fetching internal admin panels or cloud
 * metadata endpoints (169.254.169.254). Note: there's a TOCTOU window between
 * resolution and fetch, for higher-assurance environments, switch to a
 * pinned-IP HTTP agent.
 *
 * IP-range classification now lives in the shared server/lib/ssrf-guard.js
 * (also used by outgoing webhooks) so a bypass fix only needs to happen in
 * one place. This function's own flow (check every resolved address, treat
 * a DNS failure as unsafe) is unchanged, only the per-address classifier
 * call is delegated.
 */
function _isPrivateIP(ip) {
  if (!net.isIP(ip)) return false;
  return isLinkLocalOrCloudMeta(ip) || isPrivateOrLoopback(ip);
}

async function _hostnameResolvesPrivate(hostname) {
  // Literal IPs: check directly.
  if (net.isIP(hostname)) return _isPrivateIP(hostname);
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    return addrs.some(a => _isPrivateIP(a.address));
  } catch {
    return true;  // DNS failure, treat as unsafe
  }
}

/**
 * If img_url is an external URL, download it to /uploads/ and return the local path.
 * If it's already a local path (/uploads/...) or null/empty, returns as-is.
 * Returns the (possibly updated) img_url.
 */
export async function localizeImage(img_url) {
  if (!img_url) return img_url;
  if (!img_url.startsWith('http')) return img_url; // Already local

  // Check if it's already on our server
  let parsedUrl;
  try {
    parsedUrl = new URL(img_url);
    // If it's a proxy URL on our server, extract the original
    if (parsedUrl.pathname === '/api/proxy') {
      const originalUrl = parsedUrl.searchParams.get('url');
      if (originalUrl) return localizeImage(originalUrl);
    }
  } catch {
    return img_url;
  }
  // Reject non-http(s) protocols outright
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    logger.warn(`[image-localizer] Refusing non-http(s) URL: ${img_url.substring(0, 80)}`);
    return img_url;
  }
  // SSRF guard — refuse private/loopback/link-local hosts (incl. cloud metadata 169.254.169.254)
  if (await _hostnameResolvesPrivate(parsedUrl.hostname)) {
    logger.warn(`[image-localizer] Refusing private/loopback URL: ${img_url.substring(0, 80)}`);
    return img_url;
  }

  try {
    // Generate a unique filename from the URL
    const hash = crypto.createHash('md5').update(img_url).digest('hex').slice(0, 12);
    const ext = _guessExtension(img_url);
    const filename = `${Date.now()}-${hash}${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    // Download the image
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(img_url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CookTrace/1.0)' },
    });
    clearTimeout(timer);

    if (!response.ok) {
      logger.debug(`[image-localizer] Failed to download (${response.status}): ${img_url.substring(0, 80)}`);
      return img_url; // Keep original URL — might work sometimes
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 100) {
      logger.debug(`[image-localizer] Image too small (${buffer.length}b), skipping: ${img_url.substring(0, 80)}`);
      return img_url;
    }

    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(filePath, buffer);

    const localPath = `/uploads/${filename}`;
    logger.debug(`[image-localizer] Downloaded: ${img_url.substring(0, 60)} → ${localPath}`);
    return localPath;
  } catch (e) {
    logger.debug(`[image-localizer] Error: ${e.message} — ${img_url.substring(0, 80)}`);
    return img_url; // Keep original on failure
  }
}

/**
 * Guess file extension from URL or content-type.
 */
function _guessExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(jpe?g|png|webp|gif|svg)$/i);
    if (match) return '.' + match[1].toLowerCase();
  } catch {}
  return '.jpg'; // Default to jpg
}

/**
 * Check if a URL is external (not a local /uploads/ path).
 */
export function isExternalUrl(url) {
  return url && url.startsWith('http');
}
