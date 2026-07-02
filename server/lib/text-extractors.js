/**
 * server/lib/text-extractors.js
 *
 * Multi-format text extraction for the file-import flow (Issue #2, Phase 1).
 * Dispatches by mime / extension to the right extractor and returns plain
 * text plus a hint about whether the source was empty or unrecoverable.
 *
 * Supported types:
 *   PDF   text-layer PDFs via pdf-parse 2.x
 *   RTF   inline stripper, no native dep
 *   TXT   passthrough (utf-8)
 *   MD    passthrough (utf-8)
 *
 * Image-only PDFs (scanned, no text layer) return { text: '', empty: true }
 * so callers can show a "use Photo Import per page" hint. Auto-rendering
 * those as images is a Phase 1.5+ enhancement.
 */
import { PDFParse } from 'pdf-parse';

/**
 * Decide which extractor to run.
 * mimeType is the multer-reported mime; filename is the original name.
 * Returns 'pdf' | 'rtf' | 'txt' | 'md' | null (unknown).
 */
export function detectFileType(mimeType, filename) {
  const m = String(mimeType || '').toLowerCase();
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m === 'application/rtf' || m === 'text/rtf' || ext === 'rtf') return 'rtf';
  if (m === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'md';
  if (m.startsWith('text/') || ext === 'txt') return 'txt';
  return null;
}

/**
 * Extract plain text from a buffer.
 *
 * Returns { text, type, empty, pages? } on success.
 * Throws on unsupported / malformed inputs.
 */
export async function extractText(buffer, mimeType, filename) {
  if (!buffer || buffer.length === 0) {
    throw new Error('Empty file');
  }
  const type = detectFileType(mimeType, filename);
  if (!type) {
    throw new Error('Unsupported file type. Use PDF, RTF, TXT, or MD.');
  }

  if (type === 'pdf')  return await _extractPdf(buffer);
  if (type === 'rtf')  return { type, ...stripRtf(buffer.toString('utf-8')) };
  // txt + md: passthrough utf-8.
  const text = buffer.toString('utf-8').replace(/\r\n/g, '\n').trim();
  return { type, text, empty: text.length === 0 };
}

/** PDF text extraction via pdf-parse 2.x. */
async function _extractPdf(buffer) {
  let parser;
  let result;
  try {
    parser = new PDFParse({ data: buffer });
    result = await parser.getText();
  } catch (e) {
    // pdf-parse throws on encrypted / corrupted PDFs.
    throw new Error('PDF read failed: ' + (e.message || 'unknown error'));
  } finally {
    if (parser && typeof parser.destroy === 'function') {
      try { await parser.destroy(); } catch {}
    }
  }
  // result.text is the concatenated text across all pages; result.pages is an
  // array of per-page strings. Older pdf-parse returns numpages; v2 uses total.
  const text = String(result?.text || '').trim();
  const pages = Array.isArray(result?.pages)
    ? result.pages.length
    : (result?.total || result?.numpages || null);
  return {
    type: 'pdf',
    text,
    empty: text.length === 0,
    pages,
  };
}

/**
 * Minimal RTF stripper. Handles the common case (plain-text recipes saved
 * as RTF from TextEdit / WordPad / Notes). Skips font tables, color tables,
 * embedded images; keeps body text.
 *
 * Returns { text, empty }.
 */
export function stripRtf(rtf) {
  if (typeof rtf !== 'string' || !rtf.startsWith('{\\rtf')) {
    // Not a real RTF stream; treat as plain text passthrough.
    const fallback = String(rtf || '').trim();
    return { text: fallback, empty: fallback.length === 0 };
  }
  let s = rtf;
  // Drop font + color tables wholesale (they wreck output if left in).
  s = s.replace(/\{\\fonttbl[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '');
  s = s.replace(/\{\\colortbl[^}]*\}/g, '');
  s = s.replace(/\{\\stylesheet[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '');
  s = s.replace(/\{\\\*\\[a-z]+[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '');
  // Hex escapes: \'XX
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => {
    try { return String.fromCharCode(parseInt(hex, 16)); } catch { return ''; }
  });
  // Unicode escapes: \uNNNN? (optionally followed by a "fallback char")
  s = s.replace(/\\u(-?\d+)\??/g, (_, n) => {
    const code = parseInt(n, 10);
    if (!Number.isFinite(code)) return '';
    // Negative numbers are 16-bit signed overflow; normalize.
    return String.fromCharCode(code < 0 ? code + 65536 : code);
  });
  // Line + paragraph breaks.
  s = s.replace(/\\par[d]?\s?/g, '\n');
  s = s.replace(/\\line\s?/g, '\n');
  s = s.replace(/\\tab\s?/g, '\t');
  // Remaining control words (e.g. \fs24, \b, \cf2).
  s = s.replace(/\\[a-z][a-z0-9]*-?\d*\s?/gi, '');
  // Remove backslash-escaped braces, then bare braces.
  s = s.replace(/\\([{}\\])/g, '$1');
  s = s.replace(/[{}]/g, '');
  // Collapse whitespace and trim.
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/[ \t]*\n[ \t]*/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();
  return { text: s, empty: s.length === 0 };
}
