const here = new URL('./', import.meta.url).href;
const MAP = {
  '../db.js': 'db-shim.mjs',
  '../../db.js': 'db-shim.mjs',
  '../middleware/auth.js': 'stubs.mjs',
  '../lib/webhooks.js': 'stubs.mjs',
  './pantry.js': 'stubs.mjs',
  '../lib/recipe-scraper.js': 'stubs.mjs',
  '../lib/recipe-ai-fallback.js': 'stubs.mjs',
  '../lib/recipe-scrapers-bridge.js': 'stubs.mjs',
  '../lib/recipe-importers.js': 'stubs.mjs',
  '../lib/text-extractors.js': 'stubs.mjs',
  '../lib/image-localizer.js': 'stubs.mjs',
  '../lib/auto-share.js': 'stubs.mjs',
  '../lib/nutrition-derive.js': 'stubs.mjs',
  '../lib/push-notify.js': 'stubs.mjs',
  '../email.js': 'stubs.mjs',
  '../lib/heuristic-recipe-parser.js': 'stubs.mjs',
  '../lib/recipe-hydrate.js': 'stubs.mjs',
};
export async function resolve(spec, ctx, next) {
  const parent = ctx.parentURL || '';
  if (parent.includes('/server/routes/') && MAP[spec]) return { url: here + MAP[spec], shortCircuit: true };
  return next(spec, ctx);
}
