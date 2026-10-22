// Module hooks for register.mjs: the SQLite plugin, platform.js and the
// other Capacitor plugins resolve to the shims here.
const here = new URL('./', import.meta.url);
const src = new URL('../../src/', import.meta.url).href;
export async function resolve(spec, ctx, next) {
  if (spec === '@capacitor-community/sqlite') return { url: new URL('sqlite.mjs', here).href, shortCircuit: true };
  if (/(^|\/)platform\.js$/.test(spec) && ctx.parentURL?.startsWith(src)) return { url: new URL('platform.mjs', here).href, shortCircuit: true };
  if (spec.startsWith('@capacitor/')) return { url: new URL('capacitor.mjs', here).href, shortCircuit: true };
  return next(spec, ctx);
}
// Vite's import.meta.env, as a production build has it.
export async function load(url, ctx, next) {
  const r = await next(url, ctx);
  if (url.startsWith(src) && url.endsWith('.js') && r.source) {
    const text = String(r.source);
    if (text.includes('import.meta.env')) return { ...r, source: text.replace(/import\.meta\.env/g, "({ DEV: false, PROD: true, MODE: 'production' })") };
  }
  return r;
}
