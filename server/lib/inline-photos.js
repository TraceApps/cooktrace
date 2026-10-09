/**
 * inline-photos.js: a photo that arrives embedded in a row (a data: URL)
 * becomes a file under /uploads/, wherever the row comes from.
 *
 * The Android app keeps a photo taken with no connection embedded in its
 * row, and the sync push sent it on as it was: every list and pull then
 * carried the whole picture, and anything that needs a real address (the
 * share card, a link preview, NutriTrace's CookTrace import) couldn't use
 * it. The REST routes already turned these into files
 * (lib/image-localizer.js); the push now does the same, and a repair at
 * every startup turns those already stored into files.
 */
import db from '../db.js';
import { logger } from '../logger.js';
import { localizeDataUrl } from './image-localizer.js';

// The columns that hold a photo, per synced table. cook_diary.photos is a
// JSON list of them.
export const PHOTO_COLUMNS = {
  recipes: ['img_url'],
  pantry_items: ['img_url'],
  cookbooks: ['cover_image_url'],
  cook_diary: ['photo_url', 'photos'],
};

const _isData = v => typeof v === 'string' && /^data:/i.test(v);

/**
 * One column's value with every embedded photo turned into a file, in the
 * same shape it came (text, a JSON list as text, or a list). A photo that
 * can't be stored (not an image, too big, the disk refused) is dropped, as
 * the REST routes do. Returns { value, failed }.
 */
export function localizePhotoValue(value) {
  if (_isData(value)) {
    const out = localizeDataUrl(value);
    return { value: out, failed: out == null ? 1 : 0 };
  }
  let list = value, asText = false;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { list = JSON.parse(value); asText = true; } catch { return { value, failed: 0 }; }
  }
  if (!Array.isArray(list) || !list.some(_isData)) return { value, failed: 0 };
  let failed = 0;
  const out = [];
  for (const p of list) {
    if (!_isData(p)) { out.push(p); continue; }
    const file = localizeDataUrl(p);
    if (file) out.push(file); else failed++;
  }
  return { value: asText ? JSON.stringify(out) : out, failed };
}

/** A pushed row of `table` with its embedded photos as files (a copy).
 *  Only the columns the push says it changed (all of them for an app that
 *  doesn't say): a photo it didn't change isn't stored again, and isn't
 *  taken from it either (lib/field-merge.js). The two photo columns of a
 *  diary entry merge as one, so both go when either does. */
export function localizeRowPhotos(table, row) {
  const cols = PHOTO_COLUMNS[table];
  if (!cols || !row || typeof row !== 'object') return row;
  // Columns that merge as one (a diary entry's photo and its photos) go
  // in together, so they're stored together.
  const said = Array.isArray(row.changed) ? new Set(row.changed) : null;
  if (said && cols.some(c => said.has(c))) cols.forEach(c => said.add(c));
  let copy = row;
  for (const c of cols) {
    if (row[c] == null || (said && !said.has(c))) continue;
    const { value } = localizePhotoValue(row[c]);
    if (value !== row[c]) { if (copy === row) copy = { ...row }; copy[c] = value; }
  }
  return copy;
}

/**
 * At every startup: photos already stored embedded become files. Rows that
 * aren't deleted only (nobody sees a deleted row's photo, and changing it
 * would send it to every phone again for nothing). A row is changed only
 * if the value is still the one read, so an edit made meanwhile stays.
 * Its edit time and field stamps stay as they were (it isn't an edit, so it
 * never stands against one); the sync stamp moves, so phones pull the path.
 * What can't be stored is counted, logged and tried again next startup.
 * Addresses that aren't embedded photos are never touched.
 */
let _running = null;
export function repairInlinePhotos() {
  if (!_running) _running = _repair().finally(() => { _running = null; });
  return _running;
}

async function _repair() {
  let repaired = 0, failed = 0;
  for (const [table, cols] of Object.entries(PHOTO_COLUMNS)) {
    for (const col of cols) {
      const rows = db.prepare(
        `SELECT id, ${col} AS value, field_stamps FROM ${table} WHERE deleted_at IS NULL AND ${col} LIKE '%data:%'`
      ).all();
      const update = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ? AND ${col} = ?`);
      const keepStamps = db.prepare(`UPDATE ${table} SET field_stamps = ? WHERE id = ?`);
      for (const row of rows) {
        // One at a time, so the server keeps answering meanwhile.
        await new Promise(r => setImmediate(r));
        const { value, failed: bad } = localizePhotoValue(row.value);
        if (!bad && value === row.value) continue; // no embedded photo after all
        if (bad) {
          failed += bad;
          logger.warn(`[inline-photos] ${table} id=${row.id} ${col}: could not store the photo; will try again next startup`);
          continue;
        }
        const changed = db.transaction(() => {
          const n = update.run(value, row.id, row.value).changes;
          if (n) keepStamps.run(row.field_stamps, row.id);
          return n;
        })();
        repaired += changed;
      }
    }
  }
  if (repaired || failed) logger.info(`[inline-photos] stored ${repaired} embedded photo(s) as files, ${failed} failed`);
  return { repaired, failed };
}
