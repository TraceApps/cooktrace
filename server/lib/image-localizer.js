/**
 * image-localizer.js — Download external images to /uploads/ and return local path.
 *
 * Used by food/meal routes to self-host external images (DuckDuckGo, Walmart, etc.)
 * so they're always available and don't depend on third-party proxies.
 */
import fs from 'fs';
import { detectImageTypeFromBuffer } from './image-magic.js';
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

// ── Photos taken with no connection ───────────────────────────────────
// The web app can't upload a file when it can't reach the server, so a
// photo taken offline travels embedded in the row it belongs to, the same
// way NutriTrace has always carried food photos. Here it becomes a real
// file under /uploads/ so everything downstream (the apps, exports,
// backups) sees an ordinary image path.
const _DATA_URL = /^data:image\/(jpeg|jpg|png|webp|gif|avif);base64,/i;
const MAX_EMBEDDED_BYTES = 12 * 1024 * 1024;

/** A data: image becomes a file and its path; anything else is untouched. */
export function localizeDataUrl(img_url) {
  if (typeof img_url !== 'string' || !_DATA_URL.test(img_url)) return img_url;
  try {
    const [head, b64] = img_url.split(',', 2);
    const ext = head.match(/^data:image\/([a-z]+);/i)?.[1].toLowerCase().replace('jpeg', 'jpg') || 'jpg';
    const bytes = Buffer.from(b64, 'base64');
    if (!bytes.length || bytes.length > MAX_EMBEDDED_BYTES) {
      logger.warn(`[image-localizer] Refusing embedded image of ${bytes.length} bytes`);
      return null;
    }
    // The same magic-byte check the upload route runs, before anything is
    // written: a client-sent type is not evidence of anything, and this
    // tree is served to anyone holding the URL.
    if (!detectImageTypeFromBuffer(bytes)) {
      logger.warn('[image-localizer] Refusing an embedded file that is not an image');
      return null;
    }
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), bytes);
    return `/uploads/${filename}`;
  } catch (e) {
    logger.warn(`[image-localizer] Could not save an embedded image: ${e.message}`);
    return null;
  }
}

/** Every image on a row, embedded ones turned into files. */
export function localizeDataUrls(value) {
  if (Array.isArray(value)) return value.map(localizeDataUrl).filter(Boolean);
  return localizeDataUrl(value);
}

// ── An image an agent hands over (MCP set_recipe_image) ─────────────────
// Unlike localizeImage, these refuse rather than fall back: what's saved is
// checked to be an image by its bytes, at most MAX_EMBEDDED_BYTES, and a
// URL is fetched through the address guard on every redirect hop.
const _EXT = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', avif: 'avif', heic: 'heic', bmp: 'bmp' };

/** Save image bytes under /uploads; returns '/uploads/<file>'. Throws if they aren't an image. */
export function saveImageBytes(bytes) {
  if (!bytes?.length) throw new Error('the image is empty');
  if (bytes.length > MAX_EMBEDDED_BYTES) throw new Error(`the image is over ${MAX_EMBEDDED_BYTES / 1024 / 1024} MB`);
  const type = detectImageTypeFromBuffer(bytes);
  if (!type) throw new Error('that is not an image (JPEG, PNG, WebP, GIF, AVIF or HEIC)');
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${_EXT[type] || 'jpg'}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), bytes);
  return `/uploads/${filename}`;
}

/** Base64, with or without a data: prefix, saved as saveImageBytes does. */
export function saveImageBase64(data) {
  const b64 = String(data || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!b64 || /[^A-Za-z0-9+/=_-]/.test(b64)) throw new Error('image_data is not base64');
  return saveImageBytes(Buffer.from(b64, 'base64'));
}

/** Download an image from a public address and save it; throws with the reason. */
export async function downloadImage(url, { allowPrivate = false } = {}) {
  const { fetchChecked, readBody } = await import('./ssrf-guard.js');
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('only http and https addresses');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetchChecked(parsed.toString(), {
      signal: ctl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CookTrace/1.0)', Accept: 'image/*' },
    }, { allowPrivate, allowPrivateEnvHint: 'ALLOW_PRIVATE_RECIPE_URLS', maxRedirects: 3 });
    if (!res.ok) throw new Error(`the address answered ${res.status}`);
    return saveImageBytes(await readBody(res, MAX_EMBEDDED_BYTES));
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('the address took too long to answer');
    // As the URL import does (recipe-scraper.js): why an address on the
    // server's own network was refused is said only to whoever may reach
    // it, so a refusal can't be used to learn which names exist there.
    if (!allowPrivate && /addresses are|resolve host/.test(e?.message || '')) throw new Error('could not fetch the image');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
