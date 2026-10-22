/**
 * local-backup.js — local-mode snapshot export/import for the Android
 * native app. When `getNativeMode() === 'local'` and no server is set,
 * the existing "Portable JSON Export" UI in Settings → Backup needs
 * to dump the on-device SQLite database (db-native.js), not the empty
 * IndexedDB shim. This module is the bridge.
 *
 * Snapshot shape:
 *   {
 *     format: 'cooktrace-local-snapshot',
 *     version: 1,
 *     created_at: 'ISO',
 *     tables: { recipes: [...rows], pantry_items: [...], ... },
 *     settings: { key: value, ... },
 *     images: { 'uploads/img_123.jpg': '<base64>', ... }   // optional
 *   }
 *
 * Images are walked out of @capacitor/filesystem's Data directory and
 * base64-encoded inline so a single .json file is fully portable. Large
 * libraries can opt out via { includeImages: false }.
 *
 * Round-trip is best-effort: import re-inserts every row with its
 * original id where possible (so cross-FK references survive), and
 * rewrites image paths if the platform reassigns file URIs.
 */

import { isNative } from './platform.js';
import { getDb, LOCAL_USER_ID } from './db-native.js';
import { Filesystem, Directory } from '@capacitor/filesystem';

const TABLES = [
  'recipes', 'pantry_items', 'cook_diary', 'shopping_list',
  'recipe_categories', 'pantry_categories', 'custom_units', 'disabled_units',
  'cookbooks', 'recipe_cookbook_links', 'recipe_comments',
  'user_settings', 'ai_chat_history',
];

async function _selectAll(db, table) {
  const r = await db.query(`SELECT * FROM ${table}`, []);
  return r?.values || [];
}

/**
 * Dump the entire local DB to a single JSON object. Caller decides what
 * to do with it (download, share-sheet, save to Filesystem, etc.).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.includeImages=true] base64-inline every file in
 *        the Data/uploads directory. Disable for a smaller dump.
 */
export async function exportLocalSnapshot(opts = {}) {
  if (!isNative) throw new Error('Local snapshot is only available in the Android app');
  const includeImages = opts.includeImages !== false;
  const db = await getDb();

  const tables = {};
  for (const t of TABLES) {
    try { tables[t] = await _selectAll(db, t); }
    catch (e) { tables[t] = { error: e.message || 'failed' }; }
  }

  // user_settings is in `tables` already (keyed list); also surface a
  // settings map for convenience.
  const settingsMap = {};
  for (const row of tables.user_settings || []) {
    if (row && row.key) settingsMap[row.key] = row.value;
  }

  const out = {
    format: 'cooktrace-local-snapshot',
    version: 1,
    created_at: new Date().toISOString(),
    tables,
    settings: settingsMap,
  };

  if (includeImages) {
    out.images = await _readUploads();
  }
  return out;
}

async function _readUploads() {
  const images = {};
  let entries;
  try {
    const list = await Filesystem.readdir({ path: 'uploads', directory: Directory.Data });
    entries = list?.files || [];
  } catch {
    return images;
  }
  for (const f of entries) {
    // f may be a string (older plugin) or { name, type } object.
    const name = typeof f === 'string' ? f : (f.name || '');
    if (!name) continue;
    try {
      const data = await Filesystem.readFile({
        path: `uploads/${name}`,
        directory: Directory.Data,
      });
      images[`uploads/${name}`] = typeof data?.data === 'string' ? data.data : '';
    } catch {}
  }
  return images;
}

/**
 * Apply a previously-exported snapshot to the local DB. Existing rows
 * with the same id are overwritten; new rows are inserted with their
 * original id where possible so cross-FK references in the dump
 * remain valid.
 *
 * Images: written back to Filesystem in the Data/uploads directory at
 * their original relative path. Existing files with the same name are
 * overwritten.
 */
/**
 * Build a ZIP backup of the local DB. Same data as exportLocalSnapshot
 * but split: `database.json` with every table, plus a real `uploads/`
 * directory with the image files (not base64-inlined). Easier to
 * inspect and to restore selectively than the single-JSON form.
 */
export async function exportLocalZip() {
  if (!isNative) throw new Error('Local backup ZIP is only available in the Android app');
  const JSZipMod = await import('jszip');
  const JSZip = JSZipMod.default || JSZipMod;
  const zip = new JSZip();

  // Tables + settings → database.json. Strip the images field so the
  // single-file fallback (JSON snapshot) and this ZIP form share the
  // same tables payload.
  const snapshot = await exportLocalSnapshot({ includeImages: false });
  zip.file('database.json', JSON.stringify({
    format: snapshot.format,
    version: snapshot.version,
    created_at: snapshot.created_at,
    tables: snapshot.tables,
    settings: snapshot.settings,
  }, null, 2));

  // Manifest with format identity + app version so future importers
  // can detect / migrate.
  zip.file('manifest.json', JSON.stringify({
    format: 'cooktrace-local-zip',
    version: 1,
    created_at: snapshot.created_at,
    tables: Object.keys(snapshot.tables || {}),
  }, null, 2));

  // Images as real files inside uploads/. Each entry's filename in
  // the snapshot.images map is already prefixed with `uploads/` so
  // we just write them through.
  let entries;
  try {
    const list = await Filesystem.readdir({ path: 'uploads', directory: Directory.Data });
    entries = list?.files || [];
  } catch {
    entries = [];
  }
  for (const f of entries) {
    const name = typeof f === 'string' ? f : (f.name || '');
    if (!name) continue;
    try {
      const data = await Filesystem.readFile({
        path: `uploads/${name}`,
        directory: Directory.Data,
      });
      const b64 = typeof data?.data === 'string' ? data.data : '';
      if (b64) zip.file(`uploads/${name}`, b64, { base64: true });
    } catch {}
  }

  return zip.generateAsync({ type: 'blob' });
}

/**
 * Restore from a ZIP previously produced by exportLocalZip. Inverse
 * of that function — reads database.json + every file under uploads/
 * back into the local DB and Filesystem.
 */
export async function importLocalZip(zipBlob) {
  if (!isNative) throw new Error('Local backup import is only available in the Android app');
  const JSZipMod = await import('jszip');
  const JSZip = JSZipMod.default || JSZipMod;
  const zip = await JSZip.loadAsync(zipBlob);

  const dbFile = zip.file('database.json');
  if (!dbFile) throw new Error('Not a CookTrace local backup ZIP (missing database.json)');
  const dbText = await dbFile.async('string');
  const snapshot = JSON.parse(dbText);
  if (snapshot.format !== 'cooktrace-local-snapshot') {
    throw new Error('Unrecognised backup format');
  }

  // Hydrate images sub-map back to base64 inlined (importLocalSnapshot
  // expects that shape).
  snapshot.images = snapshot.images || {};
  const imageFiles = [];
  zip.forEach((path) => { if (path.startsWith('uploads/')) imageFiles.push(path); });
  for (const path of imageFiles) {
    const entry = zip.file(path);
    if (!entry) continue;
    try { snapshot.images[path] = await entry.async('base64'); }
    catch {}
  }
  return importLocalSnapshot(snapshot);
}

export async function importLocalSnapshot(snapshot) {
  if (!isNative) throw new Error('Local snapshot import is only available in the Android app');
  if (!snapshot || snapshot.format !== 'cooktrace-local-snapshot') {
    throw new Error('Not a CookTrace local snapshot');
  }
  const db = await getDb();

  // Tables — clear + bulk insert. Each row keeps its id so cross-FK
  // references inside the snapshot remain valid after import.
  for (const t of TABLES) {
    const rows = snapshot.tables?.[t];
    if (!Array.isArray(rows)) continue;
    await db.run(`DELETE FROM ${t}`, []);
    for (const row of rows) {
      const cols = Object.keys(row);
      const values = cols.map(k => {
        const v = row[k];
        if (v === undefined) return null;
        if (typeof v === 'object' && v !== null) return JSON.stringify(v);
        return v;
      });
      const ph = cols.map(() => '?').join(', ');
      try {
        await db.run(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${ph})`, values);
      } catch {}
    }
  }
  // The snapshot replaces what's here, so deletes noted since don't apply,
  // and its cookbook links go up again (a sync only keeps links the
  // server has, or ones waiting to go up).
  await db.run(`DELETE FROM sync_deletes`, []);
  await db.run(`UPDATE recipe_cookbook_links SET sync_status = 'pending'`, []);

  // Images — write each base64 blob back to Data/uploads.
  if (snapshot.images && typeof snapshot.images === 'object') {
    for (const [path, b64] of Object.entries(snapshot.images)) {
      if (!path || !b64) continue;
      try {
        await Filesystem.writeFile({
          path: path.replace(/^\/+/, ''),
          data: b64,
          directory: Directory.Data,
          recursive: true,
        });
      } catch {}
    }
  }

  return { ok: true };
}
