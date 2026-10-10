/**
 * shopping-card.js — client-side share-card generator for the shopping
 * list. Mirrors the recipe-card aesthetic (dark backdrop, mint accent,
 * COOKTRACE watermark) but laid out as a grocery list.
 *
 * Output is an SVG string. svgToPngBlob() rasterises to PNG so the
 * result embeds inline across email, iMessage / SMS, WhatsApp, etc.
 * (SVG is fine for browsers + Slack but inconsistent in mail clients
 * and messengers, so the share path uses PNG.)
 *
 * Works fully client-side — no server, no fetches. Safe to call in
 * offline-only Android mode.
 */

import { brandFooter } from './brand-mark.js';
import { displayQty } from './qty.js';

const W = 600;
const HEAD_H = 160;
const FOOT_H = 70;
const ROW_H = 44;
const PAD_X = 40;
const MAX_ROWS = 32; // beyond this, show a "+N more" line

// XML/HTML-escape a string for safe SVG embedding.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Truncate a string to fit roughly within `chars` characters of the
// system-ui font at the size we render. Cheap heuristic — keeps the
// card from blowing out width on huge item names.
function clip(s, chars) {
  if (!s) return '';
  return s.length > chars ? s.slice(0, chars - 1).trimEnd() + '…' : s;
}

function _formatDate(d) {
  try {
    return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Build the SVG card.
 *
 * @param {object[]} items   shopping_list rows. Only `checked === false`
 *                           are rendered; the share card is a "to buy"
 *                           snapshot.
 * @param {object}   opts
 * @param {string}   opts.title     header title (defaults to "Shopping List")
 * @param {Date}     opts.date      date to print under the title (defaults to now)
 * @returns {{ svg: string, width: number, height: number }}
 */
export function buildShoppingCardSvg(items, opts = {}) {
  const title = opts.title || 'Shopping List';
  const date = opts.date || new Date();

  // Only render unchecked items — the card is a snapshot of what's
  // still needed. If somehow no unchecked, fall back to showing all so
  // we never emit a totally blank card.
  let toBuy = (items || []).filter(it => !it.checked);
  if (toBuy.length === 0) toBuy = items || [];

  const total = toBuy.length;
  const overflow = total > MAX_ROWS;
  const shown = overflow ? toBuy.slice(0, MAX_ROWS - 1) : toBuy;
  const bodyRows = shown.length + (overflow ? 1 : 0);

  // Auto-grow the canvas so long lists don't get cropped, but cap so
  // a giant list still produces a sane image (we paginate via the
  // "+N more" line instead).
  const bodyH = Math.max(ROW_H, bodyRows * ROW_H + 20);
  const H = HEAD_H + bodyH + FOOT_H;

  // ── HEADER ────────────────────────────────────────────────
  // Mint clipboard icon (left), title + date + count (stacked).
  const header = `
    <g>
      <!-- Clipboard glyph, hand-drawn so we don't ship a font icon -->
      <g transform="translate(${PAD_X}, 44)" stroke="#4FFFB0" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <rect x="0" y="6" width="48" height="60" rx="6" />
        <rect x="14" y="-2" width="20" height="14" rx="3" fill="#4FFFB0" stroke="none" />
        <line x1="12" y1="28" x2="36" y2="28" />
        <line x1="12" y1="40" x2="36" y2="40" />
        <line x1="12" y1="52" x2="28" y2="52" />
      </g>
      <text x="${PAD_X + 70}" y="68" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        font-size="32" font-weight="800" fill="#FFFFFF">${esc(clip(title, 22))}</text>
      <text x="${PAD_X + 70}" y="98" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        font-size="16" fill="#A1A8B8">${esc(_formatDate(date))}</text>
      <!-- Count pill, top-right -->
      <g transform="translate(${W - PAD_X - 110}, 38)">
        <rect width="110" height="32" rx="16" fill="rgba(79,255,176,0.14)" stroke="#4FFFB0" stroke-width="1.5" />
        <text x="55" y="21" text-anchor="middle"
          font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
          font-size="14" font-weight="700" fill="#4FFFB0">${total} ${total === 1 ? 'ITEM' : 'ITEMS'}</text>
      </g>
      <!-- Divider under header -->
      <line x1="${PAD_X}" y1="${HEAD_H - 18}" x2="${W - PAD_X}" y2="${HEAD_H - 18}" stroke="#1F2330" stroke-width="1" />
    </g>
  `;

  // ── BODY ──────────────────────────────────────────────────
  // Each row: empty checkbox, item name (left), qty + unit (right).
  // Light divider between rows.
  let body = '';
  shown.forEach((it, i) => {
    const y = HEAD_H + 8 + i * ROW_H + ROW_H / 2;
    const baseline = y + 7;
    const qty = it.quantity != null && it.quantity !== '' ? displayQty(it.quantity, it.unit) : '';
    const unit = it.unit || '';
    const qtyUnit = [qty, unit].filter(Boolean).join(' ');
    const name = clip(it.name || '', qtyUnit ? 30 : 40);
    body += `
      <g>
        <!-- Checkbox -->
        <rect x="${PAD_X}" y="${y - 12}" width="22" height="22" rx="4" fill="none" stroke="#4FFFB0" stroke-width="2" />
        <!-- Name -->
        <text x="${PAD_X + 36}" y="${baseline}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
          font-size="20" font-weight="600" fill="#FFFFFF">${esc(name)}</text>
        ${qtyUnit ? `
        <text x="${W - PAD_X}" y="${baseline}" text-anchor="end"
          font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
          font-size="18" font-weight="600" fill="#4FFFB0">${esc(qtyUnit)}</text>` : ''}
        ${i < shown.length - 1 || overflow ? `<line x1="${PAD_X + 36}" y1="${y + ROW_H / 2 - 1}" x2="${W - PAD_X}" y2="${y + ROW_H / 2 - 1}" stroke="#1F2330" stroke-width="1" />` : ''}
      </g>
    `;
  });
  if (overflow) {
    const y = HEAD_H + 8 + shown.length * ROW_H + ROW_H / 2;
    body += `
      <text x="${W / 2}" y="${y + 7}" text-anchor="middle"
        font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        font-size="16" font-style="italic" fill="#A1A8B8">+${total - shown.length} more…</text>
    `;
  }

  // ── FOOTER ────────────────────────────────────────────────
  // Brand-glyph paired with the COOKTRACE wordmark, centred. Mirrors
  // the recipe-card footer so the two share types feel like siblings.
  const footer = `
    <line x1="${PAD_X}" y1="${H - FOOT_H + 12}" x2="${W - PAD_X}" y2="${H - FOOT_H + 12}" stroke="#1F2330" stroke-width="1" />
    ${brandFooter(W / 2, H - 20, 22)}
  `;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#0A0B0F" />
  ${header}
  ${body}
  ${footer}
</svg>`;

  return { svg, width: W, height: H };
}

/**
 * Plain-text shopping list. Used by the "Share as Text" path so users
 * can paste into SMS / email / Notes without an image attachment.
 */
export function buildShoppingText(items, opts = {}) {
  const title = opts.title || 'Shopping List';
  const date = opts.date || new Date();
  let toBuy = (items || []).filter(it => !it.checked);
  if (toBuy.length === 0) toBuy = items || [];
  const lines = [
    `🛒 ${title} (${toBuy.length} ${toBuy.length === 1 ? 'item' : 'items'})`,
    _formatDate(date),
    '',
  ];
  for (const it of toBuy) {
    const qty = it.quantity != null && it.quantity !== '' ? displayQty(it.quantity, it.unit) : '';
    const unit = it.unit || '';
    const qu = [qty, unit].filter(Boolean).join(' ');
    lines.push(`• ${it.name}${qu ? ` — ${qu}` : ''}`);
  }
  lines.push('', '— CookTrace');
  return lines.join('\n');
}

/**
 * Rasterise an SVG string to a PNG Blob. Renders at 2× density for
 * sharp output on retina screens / Android. Returns a Blob you can
 * wrap in a File for navigator.share().
 */
export async function svgToPngBlob(svg, width, height) {
  // base64-encode the SVG so it works as a data URL (handles non-ASCII
  // correctly via the unescape/encodeURI trick).
  const b64 = typeof window !== 'undefined' && window.btoa
    ? window.btoa(unescape(encodeURIComponent(svg)))
    : Buffer.from(svg, 'utf8').toString('base64');
  const url = 'data:image/svg+xml;base64,' + b64;
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('Could not load card image'));
    img.src = url;
  });
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);
  return await new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
  });
}

/**
 * Hand a Blob to the platform share sheet, with a download fallback.
 * Works on PWA (Web Share API), Capacitor WebView on Android (same),
 * desktop browsers (download fallback).
 *
 * @param {Blob}   blob     image data
 * @param {string} filename suggested filename
 * @param {string} title    share-sheet title
 * @param {string} [text]   accompanying text body
 */
export async function shareBlob(blob, filename, title, text) {
  // ── Capacitor native share path ───────────────────────────────────
  // The WebView's navigator.canShare reports false for files, so the
  // Web Share API path silently falls through to download. Proper
  // Android: write the PNG to Cache via Filesystem then call
  // @capacitor/share which opens the native share sheet (Messages,
  // Gmail, WhatsApp, Save to Drive, save to Photos, etc.).
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform && Capacitor.isNativePlatform()) {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');
      const b64 = await _blobToBase64(blob);
      await Filesystem.writeFile({
        path: `exports/${filename}`,
        data: b64,
        directory: Directory.Cache,
        recursive: true,
      });
      const { uri } = await Filesystem.getUri({
        path: `exports/${filename}`,
        directory: Directory.Cache,
      });
      // Pass only the title — the image is the content. Including the
      // full recipe text duplicates content in apps that show both
      // (Mail body, iMessage), and clutters the share sheet preview.
      // Users who want plain-text use "Share as Text" instead.
      await Share.share({
        title: title || filename,
        url: uri,
        dialogTitle: title || 'Share',
      });
      return { shared: true };
    }
  } catch (err) {
    const msg = (err && err.message) || '';
    if (/cancel/i.test(msg)) return { shared: false, canceled: true };
    // Fall through to web paths below.
  }

  // ── Web Share API (PWA, mobile browsers that support file sharing)
  const file = new File([blob], filename, { type: blob.type });
  if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
      return { shared: true };
    } catch (err) {
      if (err && err.name === 'AbortError') return { shared: false, canceled: true };
      // fall through to download
    }
  }
  // ── Download fallback (desktop browsers without file share) ───────
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { shared: false, downloaded: true };
}

function _blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const s = String(r.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/**
 * Hand multiple Blobs to the platform share sheet. Used by the
 * paginated recipe-card share (one PNG per page). On platforms whose
 * Web Share API doesn't accept multiple files we degrade gracefully:
 * try a single combined share with the first file (so the user at
 * least gets page 1), then offer downloads for the rest.
 *
 * @param {Array<{blob: Blob, filename: string}>} parts
 * @param {string} title share-sheet title
 * @param {string} [text] accompanying text body
 */
export async function shareBlobs(parts, title, text) {
  if (!parts || parts.length === 0) return { shared: false };
  if (parts.length === 1) {
    return shareBlob(parts[0].blob, parts[0].filename, title, text);
  }
  // ── Capacitor native multi-page: stitch into one tall PNG ─────────
  // Android's @capacitor/share only accepts a single URL (files[] is
  // iOS-only). Rather than ZIP the pages and force the recipient to
  // unpack, we stitch every page vertically onto a single canvas and
  // share the combined PNG. Recipient gets one image they can preview
  // inline in any messaging app and scroll through.
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform && Capacitor.isNativePlatform()) {
      const stitched = await _stitchPngBlobsVertically(parts.map(p => p.blob));
      const baseName = (title || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'recipe';
      return shareBlob(stitched, `${baseName}.png`, title, text);
    }
  } catch (err) {
    const msg = (err && err.message) || '';
    if (/cancel/i.test(msg)) return { shared: false, canceled: true };
    // Fall through to web paths below.
  }
  const files = parts.map(p => new File([p.blob], p.filename, { type: p.blob.type }));
  if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, title, text });
      return { shared: true };
    } catch (err) {
      if (err && err.name === 'AbortError') return { shared: false, canceled: true };
      // fall through to download
    }
  }
  // Fallback — download every page locally. Browsers throttle rapid
  // `<a download>` clicks from the same gesture (Chromium suppresses
  // everything after the first by default), so we stagger them. The
  // browser will typically prompt once to allow multiple downloads;
  // the user clicks Allow and the rest land. Without the stagger
  // pages 2+ disappear silently.
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const url = URL.createObjectURL(p.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = p.filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (i < parts.length - 1) await new Promise(r => setTimeout(r, 350));
  }
  return { shared: false, downloaded: true, count: parts.length };
}

/**
 * Share a plain-text shopping list via the platform share sheet or
 * clipboard fallback. navigator.share with no files routes to the
 * text-only share sheet (Messages, Mail, WhatsApp, etc.).
 */
/**
 * Stitch an array of PNG blobs vertically onto a single canvas and
 * export as one PNG. Used by the Android multi-page share path so
 * the recipient sees a single inline-previewable image instead of a
 * zip or multiple files.
 */
async function _stitchPngBlobsVertically(blobs) {
  if (!blobs || blobs.length === 0) throw new Error('No pages to stitch');
  // Load every PNG into an Image so we know its real dimensions.
  const images = await Promise.all(blobs.map(blob => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Page failed to load')); };
    img.src = url;
  })));
  const width = Math.max(...images.map(i => i.naturalWidth));
  const totalH = images.reduce((sum, i) => sum + i.naturalHeight, 0);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = totalH;
  const ctx = canvas.getContext('2d');
  let y = 0;
  for (const img of images) {
    ctx.drawImage(img, 0, y);
    y += img.naturalHeight;
  }
  return await new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
  });
}

export async function shareText(text, title) {
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({ title, text });
      return { shared: true };
    } catch (err) {
      if (err && err.name === 'AbortError') return { shared: false, canceled: true };
    }
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return { shared: false, copied: true };
    } catch {}
  }
  return { shared: false };
}
