/**
 * recipe-card.js — client-side share cards for a recipe.
 *
 * buildRecipeCardPages() returns an ARRAY of SVG pages — one for
 * short recipes, more for long ones. Each page is roughly phone-sized
 * (~1400px tall max) so the recipient sees full readable cards
 * instead of one super-tall image. Page 1 has the hero photo + title
 * block; later pages use a slim "Recipe (continued)" header.
 *
 * Pairs with buildRecipeShareText() which produces a plain-text
 * recipe for the share message body.
 *
 * Runs entirely client-side so it works in offline-only Android mode.
 * Hero image is pre-fetched and inlined as a base64 data URI to avoid
 * cross-origin canvas tainting at rasterisation time.
 */

import { brandFooter } from './brand-mark.js';
import { formatDuration } from './duration.js';

const W = 600;
const HERO_H = 380;
const TITLE_H = 140;
const CONT_HEADER_H = 70;       // continuation pages: small title strip
const SECTION_HEAD_H = 56;
const ING_ROW_H = 30;
const ING_GROUP_H = 36;
const STEP_LINE_H = 24;
const STEP_GAP = 22;            // padding around each step block
const FOOTER_H = 70;
const PAD_X = 40;

// Soft cap on each page's height. We aim for "fits comfortably on a
// phone screen" — anything taller starts to look like a wall of text.
const MAX_PAGE_H = 1500;

// Hard cap on the number of pages a single recipe can emit so a
// runaway recipe doesn't generate 20 attachments. Past this we drop
// a "+N more…" on the last page.
const MAX_PAGES = 6;

const STEP_CHARS_PER_LINE = 56;
const STEP_MAX_LINES = 5;       // generous; per-page budget still bounds it

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clip(s, chars) {
  if (!s) return '';
  const t = String(s);
  return t.length > chars ? t.slice(0, chars - 1).trimEnd() + '…' : t;
}

// Wrap free-form text to `maxLines` lines of about `perLine` chars.
function wrapText(text, perLine, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = cur ? cur + ' ' + w : w;
    if (next.length > perLine && cur) {
      lines.push(cur);
      if (lines.length === maxLines - 1) {
        // Last allowed line — pack remaining words then truncate.
        cur = words.slice(i).join(' ');
        break;
      }
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && lines[maxLines - 1].length > perLine) {
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, perLine - 1).trimEnd() + '…';
  }
  return lines;
}

// Recipe-name wrap for the title block (bigger font, narrower).
function _wrapName(text, perLine = 22) {
  const lines = wrapText(text, perLine, 3);
  return lines.map((l, i) => i === 0
    ? esc(l)
    : `<tspan x="${PAD_X}" dy="46">${esc(l)}</tspan>`
  ).join('');
}

async function _imageToDataUrl(src) {
  if (!src) return null;
  try {
    const res = await fetch(src, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function _flattenIngredients(recipe) {
  const out = [];
  const groups = Array.isArray(recipe?.ingredients) ? recipe.ingredients : [];
  for (const g of groups) {
    if (g.name && groups.length > 1) {
      out.push({ kind: 'group', name: g.name });
    }
    for (const it of (g.items || [])) {
      out.push({
        kind: 'item',
        name: it.name || '',
        qty: it.qty != null && it.qty !== '' ? String(it.qty) : '',
        unit: it.unit || '',
      });
    }
  }
  return out;
}

function _stepText(step) {
  if (typeof step === 'string') return step;
  return [step?.title, step?.text].filter(Boolean).join(': ');
}

// ── Block builders ──────────────────────────────────────────
// Each "block" has { kind, height, render(y) } where render returns
// the SVG fragment to paint at the given y-coordinate. Building once,
// rendering many times, lets the paginator pack without re-parsing.

function _ingredientBlocks(recipe) {
  const ings = _flattenIngredients(recipe);
  if (ings.length === 0) return [];
  const out = [{
    kind: 'sectionHead',
    height: SECTION_HEAD_H,
    render: (y) => `
      <text x="${PAD_X}" y="${y + 36}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        font-size="14" font-weight="800" letter-spacing="2" fill="#4FFFB0">INGREDIENTS</text>
      <line x1="${PAD_X}" y1="${y + 48}" x2="${W - PAD_X}" y2="${y + 48}" stroke="#1F2330" stroke-width="1" />
    `,
  }];
  for (const row of ings) {
    if (row.kind === 'group') {
      const name = clip(row.name, 40);
      out.push({
        kind: 'ingGroup',
        height: ING_GROUP_H,
        render: (y) => `<text x="${PAD_X}" y="${y + 24}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
          font-size="14" font-weight="700" letter-spacing="1" fill="#4FFFB0" font-style="italic">${esc(name)}</text>`,
      });
    } else {
      const qu = [row.qty, row.unit].filter(Boolean).join(' ');
      const name = clip(row.name, qu ? 36 : 50);
      out.push({
        kind: 'ingRow',
        height: ING_ROW_H,
        render: (y) => `
          <text x="${PAD_X}" y="${y + 22}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
            font-size="17" font-weight="500" fill="#FFFFFF">• ${esc(name)}</text>
          ${qu ? `<text x="${W - PAD_X}" y="${y + 22}" text-anchor="end"
            font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
            font-size="16" font-weight="600" fill="#4FFFB0">${esc(qu)}</text>` : ''}
        `,
      });
    }
  }
  return out;
}

function _stepBlocks(recipe) {
  const steps = Array.isArray(recipe?.steps) ? recipe.steps : [];
  if (steps.length === 0) return [];
  const out = [{
    kind: 'sectionHead',
    height: SECTION_HEAD_H,
    render: (y) => `
      <text x="${PAD_X}" y="${y + 36}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        font-size="14" font-weight="800" letter-spacing="2" fill="#4FFFB0">STEPS</text>
      <line x1="${PAD_X}" y1="${y + 48}" x2="${W - PAD_X}" y2="${y + 48}" stroke="#1F2330" stroke-width="1" />
    `,
  }];
  steps.forEach((s, idx) => {
    const lines = wrapText(_stepText(s), STEP_CHARS_PER_LINE, STEP_MAX_LINES);
    const blockH = STEP_GAP + lines.length * STEP_LINE_H + 8;
    out.push({
      kind: 'step',
      height: blockH,
      render: (y) => {
        const numY = y + 24;
        let svg = `
          <circle cx="${PAD_X + 14}" cy="${numY - 6}" r="14" fill="rgba(79,255,176,0.15)" stroke="#4FFFB0" stroke-width="1.5" />
          <text x="${PAD_X + 14}" y="${numY - 1}" text-anchor="middle"
            font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
            font-size="13" font-weight="700" fill="#4FFFB0">${idx + 1}</text>
        `;
        lines.forEach((line, li) => {
          svg += `<text x="${PAD_X + 40}" y="${numY + li * STEP_LINE_H}"
            font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
            font-size="16" font-weight="500" fill="#FFFFFF">${esc(line)}</text>`;
        });
        return svg;
      },
    });
  });
  return out;
}

// ── Paginator ───────────────────────────────────────────────
// Greedy pack: fit blocks into the current page until it would
// exceed its budget, then start a new page. Section headers don't
// strand themselves at the bottom of a page — if the first content
// block can't fit after a header, we move both to the next page.

function _paginate(blocks, firstPageBudget, restPageBudget) {
  const pages = [];
  let cur = [];
  let used = 0;
  let budget = firstPageBudget;

  const flush = () => {
    if (cur.length) pages.push(cur);
    cur = [];
    used = 0;
    budget = restPageBudget;
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // Look-ahead: don't strand a section header at the bottom of a page.
    if (b.kind === 'sectionHead') {
      const next = blocks[i + 1];
      const need = b.height + (next ? next.height : 0);
      if (used + need > budget && cur.length) flush();
    } else if (used + b.height > budget && cur.length) {
      flush();
    }
    cur.push(b);
    used += b.height;
    if (pages.length + 1 >= MAX_PAGES && i < blocks.length - 1) {
      // Last allowed page — append an overflow notice and stop.
      const remaining = blocks.length - i - 1;
      if (remaining > 0) {
        cur.push({
          kind: 'overflow',
          height: 36,
          render: (y) => `<text x="${W / 2}" y="${y + 22}" text-anchor="middle"
            font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
            font-size="14" font-style="italic" fill="#A1A8B8">+${remaining} more…</text>`,
        });
      }
      break;
    }
  }
  if (cur.length) pages.push(cur);
  return pages;
}

/**
 * Build the SVG pages. Async because the hero image is pre-fetched.
 *
 * @param {object} recipe  full recipe (ingredients + steps required for
 *                         the content sections).
 * @returns {Array<{ svg, width, height, pageNum, totalPages }>}
 */
export async function buildRecipeCardPages(recipe) {
  const r = recipe || {};
  const total = r.total_minutes != null ? r.total_minutes : (r.prep_minutes || 0) + (r.cook_minutes || 0) + (r.rest_minutes || 0);
  const subtitle = [
    total ? formatDuration(total) : null,
    r.servings ? `Serves ${r.servings}` : null,
    r.yield_text || null,
  ].filter(Boolean).join(' · ');

  // Hero — fetch + inline as data URL so canvas isn't tainted.
  let heroSrc = r.img_url || r.imgUrl || null;
  if (heroSrc && !/^https?:\/\//.test(heroSrc) && typeof window !== 'undefined') {
    heroSrc = (heroSrc.startsWith('/') ? '' : '/') + heroSrc;
    heroSrc = window.location.origin + heroSrc;
  }
  const heroDataUrl = heroSrc ? await _imageToDataUrl(heroSrc) : null;

  // Build all content blocks once.
  const blocks = [..._ingredientBlocks(r), ..._stepBlocks(r)];

  // Budgets — page 1 has hero + title eating into its space; rest
  // start with a slim continuation header instead.
  const firstBudget = MAX_PAGE_H - HERO_H - TITLE_H - FOOTER_H;
  const restBudget  = MAX_PAGE_H - CONT_HEADER_H - FOOTER_H;

  const pageBlocks = blocks.length === 0
    ? [[]]
    : _paginate(blocks, firstBudget, restBudget);

  const totalPages = Math.max(1, pageBlocks.length);
  const pages = [];

  for (let p = 0; p < pageBlocks.length; p++) {
    const isFirst = p === 0;
    const blocksOnPage = pageBlocks[p];
    const contentH = blocksOnPage.reduce((acc, b) => acc + b.height, 0);
    const headH = isFirst ? (HERO_H + TITLE_H) : CONT_HEADER_H;
    const pageH = headH + contentH + FOOTER_H;

    let head = '';
    if (isFirst) {
      const heroSection = heroDataUrl ? `
        <image href="${heroDataUrl}" x="0" y="0" width="${W}" height="${HERO_H}" preserveAspectRatio="xMidYMid slice" />
        <rect x="0" y="${HERO_H - 80}" width="${W}" height="80" fill="url(#heroGrad)" />
      ` : `
        <rect x="0" y="0" width="${W}" height="${HERO_H}" fill="#11141B" />
        <text x="${W / 2}" y="${HERO_H / 2 + 30}" font-size="80" fill="#4FFFB0" text-anchor="middle">🍳</text>
      `;
      head = `
        ${heroSection}
        <rect x="0" y="${HERO_H}" width="${W}" height="${TITLE_H}" fill="#0A0B0F" />
        <text x="${PAD_X}" y="${HERO_H + 56}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
          font-size="38" font-weight="800" fill="#FFFFFF">${_wrapName(r.name || 'Recipe')}</text>
        ${subtitle ? `<text x="${PAD_X}" y="${HERO_H + TITLE_H - 30}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
          font-size="18" fill="#A1A8B8">${esc(subtitle)}</text>` : ''}
      `;
    } else {
      // Continuation: slim header with the recipe name + "(continued)"
      head = `
        <text x="${PAD_X}" y="42" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
          font-size="22" font-weight="800" fill="#FFFFFF">${esc(clip(r.name || 'Recipe', 28))}
          <tspan font-weight="400" fill="#A1A8B8" font-size="16"> · continued</tspan>
        </text>
        <line x1="${PAD_X}" y1="${CONT_HEADER_H - 10}" x2="${W - PAD_X}" y2="${CONT_HEADER_H - 10}" stroke="#1F2330" stroke-width="1" />
      `;
    }

    let body = '';
    let cursor = headH;
    for (const b of blocksOnPage) {
      body += b.render(cursor);
      cursor += b.height;
    }

    // Footer — divider, optional page-of label (multi-page only), and
    // the brand mark + wordmark. Glyph paired with the wordmark gives
    // the share card a polished sign-off without the wordmark having
    // to do all the brand work alone.
    const dividerY = pageH - FOOTER_H + 14;
    const pageBaseline = pageH - FOOTER_H + 32;
    const brandBaseline = pageH - 20;
    const footer = `
      <line x1="${PAD_X}" y1="${dividerY}" x2="${W - PAD_X}" y2="${dividerY}" stroke="#1F2330" stroke-width="1" />
      ${totalPages > 1 ? `<text x="${W / 2}" y="${pageBaseline}" text-anchor="middle"
        font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        font-size="11" font-weight="700" letter-spacing="3" fill="#A1A8B8">PAGE ${p + 1} OF ${totalPages}</text>` : ''}
      ${brandFooter(W / 2, brandBaseline, 22)}
    `;

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${pageH}" viewBox="0 0 ${W} ${pageH}">
  <defs>
    <linearGradient id="heroGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0)" />
      <stop offset="100%" stop-color="rgba(10,11,15,1)" />
    </linearGradient>
  </defs>
  <rect width="${W}" height="${pageH}" fill="#0A0B0F" />
  ${head}
  ${body}
  ${footer}
</svg>`;

    pages.push({ svg, width: W, height: pageH, pageNum: p + 1, totalPages });
  }

  return pages;
}

/**
 * Convenience wrapper — returns just the first page, for callers that
 * only want a preview. The share path should call buildRecipeCardPages
 * directly and emit one PNG per page.
 */
export async function buildRecipeCardSvg(recipe) {
  const pages = await buildRecipeCardPages(recipe);
  return pages[0];
}

/**
 * Plain-text version of the recipe — for the share `text` body.
 */
export function buildRecipeShareText(recipe) {
  const r = recipe || {};
  const lines = [];
  lines.push(`🍳 ${r.name || 'Recipe'}`);
  const total = r.total_minutes != null ? r.total_minutes : (r.prep_minutes || 0) + (r.cook_minutes || 0) + (r.rest_minutes || 0);
  const meta = [
    total ? formatDuration(total) : null,
    r.servings ? `Serves ${r.servings}` : null,
    r.yield_text || null,
  ].filter(Boolean).join(' · ');
  if (meta) lines.push(meta);
  if (r.description) lines.push('', r.description);

  const ings = _flattenIngredients(r);
  if (ings.length) {
    lines.push('', 'INGREDIENTS');
    for (const it of ings) {
      if (it.kind === 'group') lines.push(`— ${it.name} —`);
      else {
        const qu = [it.qty, it.unit].filter(Boolean).join(' ');
        lines.push(`• ${it.name}${qu ? ` (${qu})` : ''}`);
      }
    }
  }
  const steps = Array.isArray(r.steps) ? r.steps : [];
  if (steps.length) {
    lines.push('', 'STEPS');
    steps.forEach((s, i) => {
      lines.push(`${i + 1}. ${_stepText(s)}`);
    });
  }
  lines.push('', '— CookTrace');
  return lines.join('\n');
}
