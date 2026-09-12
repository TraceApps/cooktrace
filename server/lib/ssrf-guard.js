/**
 * server/lib/ssrf-guard.js
 *
 * Shared SSRF guard for any code path that fetches a user-supplied URL
 * server-side. Extracted from server/lib/image-localizer.js's
 * `_isPrivateIP`/`_hostnameResolvesPrivate` (the only such guard that
 * existed in this codebase; server/lib/recipe-scraper.js does its own
 * unguarded fetch of a user-supplied recipe URL with no equivalent
 * check at all, a pre-existing gap out of scope for this change, left
 * untouched rather than silently altering its already-shipped behavior).
 *
 * image-localizer.js keeps its own DNS-resolve-then-check flow (it
 * checks every resolved address, not just one, and silently falls back
 * to the original URL plus a log line on rejection rather than
 * throwing), but now delegates the actual IP-range classification to
 * the shared functions here instead of its own copy, so the range
 * logic has one place to fix if a bypass is ever found. Its observable
 * behavior is unchanged: everything image-localizer.js used to block
 * (including the CGNAT range and the full 0.0.0.0/8 block) is still
 * blocked, since isPrivateOrLoopback below is a superset covering both
 * its old ranges and LiftTrace's/NutriTrace's.
 *
 * `assertSafeUrl` is new: a throwing, single-resolution guard for
 * outgoing webhooks, parameterized so a self-hoster can opt a specific
 * feature into allowing private/loopback targets (a same-Docker-network
 * Home Assistant instance) without loosening image-localizer.js's own,
 * always-strict guard.
 *
 * Tiered defaults:
 *   - Link-local / IPv6 link-local / cloud-metadata (169.254.169.254):
 *     ALWAYS blocked. Never legitimate for any caller.
 *   - Loopback + RFC1918 + CGNAT + IPv6 ULA: blocked by default; a
 *     caller passes its own `allowPrivate` flag (webhooks:
 *     ALLOW_PRIVATE_WEBHOOK_URLS) to opt in independently per feature.
 */
import dns from 'dns/promises';
import net from 'net';

export function isLinkLocalOrCloudMeta(ip) {
  if (net.isIPv4(ip)) return ip.startsWith('169.254.');
  if (net.isIPv6(ip)) {
    const lo = ip.toLowerCase();
    // fe80::/10 = fe80..febf in the first hextet
    if (/^fe[89ab]/.test(lo)) return true;
    // IPv4-mapped link-local (e.g. ::ffff:169.254.169.254)
    if (lo.startsWith('::ffff:169.254.')) return true;
  }
  return false;
}

export function isPrivateOrLoopback(ip) {
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    if (o[0] === 0) return true;                                  // 0.0.0.0/8
    if (o[0] === 127) return true;                                 // 127.0.0.0/8 loopback
    if (o[0] === 10) return true;                                  // 10.0.0.0/8
    if (o[0] === 192 && o[1] === 168) return true;                 // 192.168.0.0/16
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;     // 172.16.0.0/12
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;    // 100.64.0.0/10 CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const lo = ip.toLowerCase();
    if (lo === '::1' || lo === '::' || lo === '0:0:0:0:0:0:0:1') return true;
    // Unique-local addresses fc00::/7 = fc00..fdff
    if (/^f[cd]/.test(lo)) return true;
    // IPv4-mapped private
    if (/^::ffff:(0|127|10|192\.168|172\.(1[6-9]|2[0-9]|3[01])|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7]))\./i.test(lo)) return true;
  }
  return false;
}

/**
 * Resolve the URL's hostname and reject anything that lands on a blocked
 * IP. Returns a parsed URL on success; throws Error with a friendly
 * message on failure. Caller should map to 400 / silent-skip as
 * appropriate.
 *
 * `allowPrivate` (default false) governs whether a loopback/RFC1918/ULA
 * address is permitted: pass the calling feature's own opt-in flag.
 * `allowPrivateEnvHint` is used only in the error message so a self-
 * hoster knows which env var to set: callers pass their own var name.
 *
 * Note on DNS rebinding: this function resolves once. A determined
 * attacker could DNS-rebind between this lookup and the fetch that
 * follows it. Accepted as residual risk here; webhook delivery
 * re-validates via this same function immediately before every send
 * attempt (not just once at creation time), which narrows but does
 * not eliminate the window.
 */
export async function assertSafeUrl(url, { allowPrivate = false, allowPrivateEnvHint = 'ALLOW_PRIVATE_URLS' } = {}) {
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are allowed');
  }
  let address;
  try {
    const r = await dns.lookup(parsed.hostname, { all: false });
    address = r.address;
  } catch {
    throw new Error('Could not resolve host');
  }
  if (isLinkLocalOrCloudMeta(address)) {
    throw new Error('Link-local / cloud-metadata addresses are not allowed');
  }
  if (!allowPrivate && isPrivateOrLoopback(address)) {
    throw new Error(`Private / loopback addresses are blocked. Set ${allowPrivateEnvHint}=1 to enable LAN targets.`);
  }
  return parsed;
}
