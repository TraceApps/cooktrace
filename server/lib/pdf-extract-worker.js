/**
 * server/lib/pdf-extract-worker.js
 *
 * Reads a PDF from stdin, writes {text, pages} as JSON to stdout, and is
 * meant to be run as a child process by text-extractors.js.
 *
 * It exists because pdf-parse loads @napi-rs/canvas, whose prebuilt Skia
 * binary uses CPU instructions some virtual machines do not have (QEMU's
 * default model, for one). Loading it there raises SIGILL, which kills
 * the process outright and cannot be caught in JavaScript. In a child,
 * that kills only the child, and the parent turns it into an error the
 * person importing the file can read. Issue #59.
 *
 * Protocol: raw PDF bytes on stdin, one JSON line on stdout, either
 * { text, pages } or { error }. Anything else, including dying on a
 * signal, is the parent's problem to report.
 */
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: Buffer.concat(chunks) });
    let result;
    try {
      result = await parser.getText();
    } finally {
      if (typeof parser.destroy === 'function') {
        try { await parser.destroy(); } catch { /* nothing useful to do */ }
      }
    }
    const pages = Array.isArray(result?.pages)
      ? result.pages.length
      : (result?.total || result?.numpages || null);
    process.stdout.write(JSON.stringify({ text: String(result?.text || ''), pages }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e?.message || 'unknown error' }));
  }
});
