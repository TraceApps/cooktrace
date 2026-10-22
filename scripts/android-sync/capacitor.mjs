// The Capacitor plugins the sync code touches.
export const Filesystem = { readdir: async () => ({ files: [] }), stat: async () => { throw new Error('none'); }, readFile: async () => { throw new Error('none'); }, writeFile: async () => ({}), mkdir: async () => ({}), deleteFile: async () => ({}) };
export const Directory = { Data: 'DATA', Cache: 'CACHE', Documents: 'DOCUMENTS' };
export const Capacitor = { isNativePlatform: () => true, convertFileSrc: x => x, getPlatform: () => 'android', isPluginAvailable: () => false };
export const Network = { getStatus: async () => ({ connected: true, connectionType: 'wifi' }), addListener: async () => ({ remove() {} }) };
import { readFileSync, writeFileSync } from 'node:fs';
// InstallMarkerPlugin: kept in PHONE_MARKER, a file a backup never copies
// (a copied phone starts without one); in memory when none is given.
let _marker = null;
const InstallMarker = {
  async get() { if (process.env.PHONE_MARKER) { try { return { value: readFileSync(process.env.PHONE_MARKER, 'utf8') || null }; } catch { return { value: null }; } } return { value: _marker }; },
  async set({ value }) { if (process.env.PHONE_MARKER) writeFileSync(process.env.PHONE_MARKER, String(value)); else _marker = value; },
};
export const registerPlugin = name => (name === 'InstallMarker' ? InstallMarker : new Proxy({}, { get: () => async () => ({}) }));
export const App = { addListener: async () => ({ remove() {} }) };
export const Preferences = { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} };
// CapacitorHttp (lib/migrate.js uploads with it): the same request, by fetch.
export const CapacitorHttp = {
  async request({ method = 'GET', url, headers = {}, data }) {
    const r = await fetch(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(data ?? {}) });
    const t = await r.text();
    let body = t; try { body = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, data: body };
  },
  get(o) { return this.request({ ...o, method: 'GET' }); },
  post(o) { return this.request({ ...o, method: 'POST' }); },
};
// The phone's cookie jar (phone.mjs keeps it: every request sends it, as
// CapacitorHttp does on Android, and every answer's cookies go in it).
// Kept per host ({ host: Map(name -> value) }), as Android keeps them.
globalThis.__cookieJar ??= new Map();
const _host = url => { try { return new URL(url).host; } catch { return ''; } };
const _at = host => { const j = globalThis.__cookieJar; if (!j.has(host)) j.set(host, new Map()); return j.get(host); };
export const CapacitorCookies = {
  clearAllCookies: async () => { globalThis.__cookieJar.clear(); },
  getCookies: async ({ url } = {}) => Object.fromEntries(globalThis.__cookieJar.get(_host(url)) || []),
  setCookie: async ({ url, key, value }) => { _at(_host(url)).set(key, value); },
  deleteCookie: async ({ url, key }) => { globalThis.__cookieJar.get(_host(url))?.delete(key); },
  // Every host's cookies (a test's view of the whole jar).
  _all: async () => Object.fromEntries([...globalThis.__cookieJar].map(([h, m]) => [h, Object.fromEntries(m)])),
};
export default {};
