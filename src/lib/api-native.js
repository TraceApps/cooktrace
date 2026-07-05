/**
 * api-native.js — CookTrace API impl backed by local SQLite for native
 * standalone mode. Provides the same interface as NtApi in api.js, but
 * every read/write hits the on-device SQLite database created in
 * db-native.js instead of an HTTP server.
 *
 * Active when running on Capacitor AND no server URL is configured.
 * In server-connected native mode the cached impl (api-cached.js) wraps
 * the same local DB with a sync layer.
 *
 * Pattern lifted from /home/papa/Documents/claude_code/nutritrace/src/lib/api-native.js
 * and adapted to CookTrace's recipe domain. Single-user semantics
 * (LOCAL_USER_ID = 1) — multi-user / sharing / kitchens / federation
 * features are no-ops or throw "requires server" in local mode.
 */

import { getDb, LOCAL_USER_ID } from './db-native.js';
import { resolveAssetUrl } from './platform.js';
import { Filesystem, Directory } from '@capacitor/filesystem';

// ── Small utilities ──────────────────────────────────────────────────

const JSON_FIELDS_RECIPE = ['ingredients', 'steps', 'tags', 'tools', 'nutrition'];

function _slug(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'item';
}

function _parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function _stringify(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function _bool(v) { return v ? 1 : 0; }

// Title-case a shopping item name. Mirrors server/routes/shopping.js's
// _titleCaseName — Mealie food names arrive lowercase, and the shopping
// list should follow the project's caps rule regardless of source.
const _MINOR_WORDS = new Set([
  'a','an','and','as','at','but','by','for','if','in','nor','of','on','or','the','to','up','via',
]);
function _titleCaseName(raw) {
  if (raw == null) return raw;
  const s = String(raw).trim();
  if (!s) return s;
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s;
  return s.split(/(\s+)/).map((tok, i, arr) => {
    if (!tok.trim()) return tok;
    return tok.split('-').map((seg, segIdx) => {
      const lower = seg.toLowerCase();
      const isFirstToken = arr.slice(0, i).every(t => !t.trim());
      const isFirstSeg   = segIdx === 0;
      if (_MINOR_WORDS.has(lower) && !(isFirstToken && isFirstSeg)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join('-');
  }).join('');
}

async function _query(sql, params = []) {
  const db = await getDb();
  const r = await db.query(sql, params);
  return r?.values || [];
}
async function _run(sql, params = []) {
  const db = await getDb();
  return db.run(sql, params);
}
async function _runInsert(sql, params = []) {
  const db = await getDb();
  const r = await db.run(sql, params);
  return r?.changes?.lastId ?? r?.lastId ?? null;
}

// Convert a File / Blob to base64 (sans the data: URL prefix) so it
// can be handed to Filesystem.writeFile.
function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const r = String(reader.result || '');
      const i = r.indexOf(',');
      resolve(i >= 0 ? r.slice(i + 1) : r);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Row mappers (DB row → app object) ────────────────────────────────

function _recipeFromRow(row) {
  if (!row) return null;
  const out = { ...row };
  for (const f of JSON_FIELDS_RECIPE) {
    out[f] = _parseJson(out[f], f === 'nutrition' ? {} : []);
  }
  out.imgUrl = resolveAssetUrl(out.img_url) || '';
  out.favorite = !!out.favorite;
  return out;
}

async function _pantryCategoryMap() {
  const rows = await _query(
    `SELECT id, name, slug, icon, color FROM pantry_categories
      WHERE user_id = ? AND deleted_at IS NULL`,
    [LOCAL_USER_ID]
  );
  const m = new Map();
  for (const r of rows) m.set(r.id, r);
  return m;
}

function _pantryFromRow(row, catMap = null) {
  if (!row) return null;
  const out = { ...row };
  out.nutrition = _parseJson(out.nutrition, null);
  out.imgUrl = resolveAssetUrl(out.img_url) || '';
  out.in_stock = !!out.in_stock;
  // Mirror the server's _hydrate: when the row carries a category_id,
  // attach the joined category object so downstream callers (the
  // sheet's pill, the list view) see the same shape as on PWA. Without
  // this, `item.category` would be the slug string and the pill would
  // fall back to the hardcoded PANTRY_CATEGORIES list — which differs
  // in casing from the live pantry_categories rows.
  if (out.category_id != null && catMap) {
    out.category = catMap.get(out.category_id) || null;
  }
  return out;
}

function _diaryFromRow(row) {
  if (!row) return null;
  const out = { ...row };
  if (out.photos) out.photos = _parseJson(out.photos, null);
  return out;
}

function _shoppingFromRow(row) {
  if (!row) return null;
  const out = { ...row };
  out.checked = !!out.checked;
  return out;
}

// Aisle auto-lookup mirror of server/routes/shopping.js's helper: linked
// pantry item → its category default_aisle → the category name → null.
async function _aisleForPantry(pantryId) {
  if (!pantryId) return null;
  const rows = await _query(
    `SELECT c.default_aisle, c.name
       FROM pantry_items p
       LEFT JOIN pantry_categories c ON c.id = p.category_id
      WHERE p.id = ?`,
    [pantryId]
  );
  const cat = rows[0];
  if (!cat) return null;
  return (cat.default_aisle && String(cat.default_aisle).trim()) || cat.name || null;
}

function _cookbookFromRow(row) {
  if (!row) return null;
  const out = { ...row };
  out.is_smart = !!out.is_smart;
  out.smart_filter = _parseJson(out.smart_filter_json, null);
  out.coverImageUrl = resolveAssetUrl(out.cover_image_url) || '';
  return out;
}

// ── NtApi native implementation ──────────────────────────────────────

export const CtApiNative = {

  // ── Recipes ────────────────────────────────────────────────────────

  async getRecipes() {
    const rows = await _query(
      `SELECT * FROM recipes
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY name COLLATE NOCASE ASC`,
      [LOCAL_USER_ID]
    );
    return rows.map(_recipeFromRow);
  },

  async getRecipe(id) {
    const rows = await _query(
      `SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    return _recipeFromRow(rows[0]);
  },

  async createRecipe(data) {
    const d = data || {};
    const ingredients = _stringify(d.ingredients ?? []);
    const steps       = _stringify(d.steps ?? []);
    const tags        = _stringify(d.tags ?? []);
    const tools       = _stringify(d.tools ?? []);
    const nutrition   = _stringify(d.nutrition ?? {});
    const img         = d.img_url ?? d.imgUrl ?? null;

    const id = await _runInsert(
      `INSERT INTO recipes
         (user_id, name, description, img_url, servings, prep_minutes, cook_minutes, total_minutes, rest_minutes,
          ingredients, steps, tags, tools, source_url, video_url, notes, visibility,
          rating, yield_text, nutrition, favorite, category_id, sync_status)
       VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?, 'pending')`,
      [
        LOCAL_USER_ID,
        d.name || 'Untitled',
        d.description || null,
        img,
        d.servings ?? 2,
        d.prep_minutes  ?? null,
        d.cook_minutes  ?? null,
        d.total_minutes ?? null,
        d.rest_minutes  ?? null,
        ingredients, steps, tags, tools,
        d.source_url || null,
        d.video_url || null,
        d.notes || null,
        d.visibility || 'private',
        d.rating ?? null,
        d.yield_text || null,
        nutrition,
        _bool(d.favorite),
        d.category_id ?? null,
      ]
    );
    return this.getRecipe(id);
  },

  async updateRecipe(id, data) {
    const existing = (await _query(`SELECT * FROM recipes WHERE id = ?`, [id]))[0];
    if (!existing) throw new Error('Recipe not found');
    const d = { ...existing, ...data };
    const img = d.img_url ?? d.imgUrl ?? existing.img_url ?? null;
    await _run(
      `UPDATE recipes SET
         name = ?, description = ?, img_url = ?, servings = ?,
         prep_minutes = ?, cook_minutes = ?, total_minutes = ?, rest_minutes = ?,
         ingredients = ?, steps = ?, tags = ?, tools = ?,
         source_url = ?, video_url = ?, notes = ?, visibility = ?,
         rating = ?, yield_text = ?, nutrition = ?, favorite = ?,
         category_id = ?, updated_at = datetime('now'), sync_status = 'pending'
       WHERE id = ?`,
      [
        d.name,
        d.description ?? null,
        img,
        d.servings ?? 2,
        d.prep_minutes  ?? null,
        d.cook_minutes  ?? null,
        d.total_minutes ?? null,
        d.rest_minutes  ?? null,
        _stringify(d.ingredients ?? []),
        _stringify(d.steps ?? []),
        _stringify(d.tags ?? []),
        _stringify(d.tools ?? []),
        d.source_url || null,
        d.video_url || null,
        d.notes || null,
        d.visibility || 'private',
        d.rating ?? null,
        d.yield_text || null,
        _stringify(d.nutrition ?? {}),
        _bool(d.favorite),
        d.category_id ?? null,
        id,
      ]
    );
    return this.getRecipe(id);
  },

  async deleteRecipe(id) {
    await _run(
      `UPDATE recipes SET deleted_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
      [id]
    );
    return { ok: true };
  },

  async backdateRecipe(id, createdAt) {
    if (!createdAt) return false;
    const ts = new Date(createdAt);
    if (Number.isNaN(ts.getTime())) return false;
    const newIso = ts.toISOString().replace('T', ' ').slice(0, 19);
    const rows = await _query(`SELECT created_at FROM recipes WHERE id = ? AND deleted_at IS NULL`, [id]);
    if (rows.length === 0) return false;
    const cur = rows[0].created_at || '';
    if (cur && cur <= newIso) return false;
    await _run(
      `UPDATE recipes SET created_at = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
      [newIso, id]
    );
    return true;
  },

  async markCooked(id, payload = {}) {
    const date = payload.date || new Date().toISOString().slice(0, 10);
    const photos = payload.photos != null ? _stringify(payload.photos) : null;
    const photoUrl = photos && Array.isArray(payload.photos) && payload.photos.length
      ? payload.photos[0]
      : (payload.photo_url ?? null);
    await _runInsert(
      `INSERT INTO cook_diary
         (user_id, recipe_id, date, kind, servings, notes, photo_url, photos, meal_type, rating, sync_status)
       VALUES (?, ?, ?, 'cooked', ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        LOCAL_USER_ID, id, date,
        payload.servings ?? null,
        payload.notes || null,
        photoUrl,
        photos,
        payload.meal_type || null,
        payload.rating ?? null,
      ]
    );
    await _recomputeCookAggregates(id);
    return this.getRecipe(id);
  },

  async getCooks(id) {
    const rows = await _query(
      `SELECT * FROM cook_diary
        WHERE recipe_id = ? AND deleted_at IS NULL
        ORDER BY date DESC, created_at DESC`,
      [id]
    );
    return rows.map(r => {
      const out = _diaryFromRow(r);
      if (out && out.photos == null && out.photo_url) out.photos = [out.photo_url];
      else if (out && !out.photos) out.photos = [];
      // Local mode is single-user; stamp a synthetic byline so the
      // UI byline path renders consistently with server mode.
      if (out) out.cooked_by_username = 'You';
      return out;
    });
  },

  async updateCook(_recipeId, cookId, d) {
    const fields = [];
    const params = [];
    if (d.date != null)      { fields.push('date = ?');      params.push(d.date); }
    if (d.notes !== undefined){ fields.push('notes = ?');    params.push(d.notes || null); }
    if (d.servings !== undefined) { fields.push('servings = ?'); params.push(d.servings ?? null); }
    if (d.meal_type !== undefined){ fields.push('meal_type = ?');params.push(d.meal_type || null); }
    if (d.rating !== undefined){ fields.push('rating = ?');   params.push(d.rating ?? null); }
    if (d.kind != null)      { fields.push('kind = ?');      params.push(d.kind); }
    if (d.photos !== undefined) {
      fields.push('photos = ?'); params.push(_stringify(d.photos));
      fields.push('photo_url = ?'); params.push(Array.isArray(d.photos) && d.photos.length ? d.photos[0] : null);
    } else if (d.photo_url !== undefined) {
      fields.push('photo_url = ?'); params.push(d.photo_url || null);
    }
    fields.push(`updated_at = datetime('now')`);
    fields.push(`sync_status = 'pending'`);
    params.push(cookId);
    await _run(`UPDATE cook_diary SET ${fields.join(', ')} WHERE id = ?`, params);
    const recipeRow = (await _query(`SELECT recipe_id FROM cook_diary WHERE id = ?`, [cookId]))[0];
    if (recipeRow?.recipe_id) await _recomputeCookAggregates(recipeRow.recipe_id);
    return { ok: true };
  },

  async deleteCook(_recipeId, cookId) {
    const row = (await _query(`SELECT recipe_id FROM cook_diary WHERE id = ?`, [cookId]))[0];
    await _run(
      `UPDATE cook_diary SET deleted_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
      [cookId]
    );
    if (row?.recipe_id) await _recomputeCookAggregates(row.recipe_id);
    return { ok: true };
  },

  async scrapeRecipe(url) {
    // Local-mode URL import uses the full client-side scraper port
    // (src/lib/recipe-scraper-client.js) which mirrors the server's
    // recipe-scraper.js parsing logic: JSON-LD Recipe extraction,
    // @graph traversal, video sniffing from iframes/anchors/og tags,
    // ingredient line parser, step flattening. CapacitorHttp under
    // the hood bypasses WebView CORS so cross-origin recipe sites
    // return a 200 instead of being blocked.
    try {
      const { scrapeRecipeNative } = await import('./recipe-scraper-client.js');
      const recipe = await scrapeRecipeNative(url);
      return this.createRecipe(recipe);
    } catch (e) {
      throw new Error(e.message || String(e));
    }
  },

  // Local-mode recipe import — handles text paste (JSON / HTML) and
  // single-file paths. Bulk ZIP import goes through scanRecipeZip +
  // commitRecipeZip below.
  async importRecipe(opts = {}) {
    const { text, file, addToPantry = true, applyTags = false } = opts;
    const { importRecipeFromText } = await import('./recipe-importers-client.js');
    let recipe;
    if (text) {
      recipe = importRecipeFromText(text, opts.hint || null);
    } else if (file) {
      const blob = file;
      const name = file.name || '';
      // Paprika archives are zip-of-gzipped-json — distinct enough to
      // detect by extension and short-circuit the generic JSON parser.
      if (/\.paprikarecipes?$/i.test(name) || /\.zip$/i.test(name)) {
        const { importPaprikaArchive } = await import('./recipe-importers-client.js');
        try {
          const recipes = await importPaprikaArchive(blob);
          const created = [];
          for (const r of recipes) {
            const saved = await _saveImportedRecipeLocal(this, r, { addToPantry, applyTags });
            if (saved) created.push(saved);
          }
          return { recipes: created, count: created.length };
        } catch (e) {
          if (!/no \.paprikarecipe/i.test(e.message || '')) throw e;
          // Not a Paprika archive — fall through to generic ZIP scan.
          throw new Error('Use the Bulk Import flow (scan + commit) for non-Paprika ZIPs');
        }
      }
      const fileText = await blob.text();
      recipe = importRecipeFromText(fileText, name || null);
    } else {
      throw new Error('importRecipe requires `text` or `file`');
    }
    return _saveImportedRecipeLocal(this, recipe, { addToPantry, applyTags });
  },

  async scanRecipeZip(file) {
    const { scanRecipeZip } = await import('./recipe-importers-client.js');
    const entries = await scanRecipeZip(file);
    return {
      count: entries.length,
      recipes: entries.map((e, idx) => ({
        idx,
        name: e.recipe.name,
        source: e.source,
        ingredientCount: (e.recipe.ingredients?.[0]?.items || []).length,
        stepCount: e.recipe.steps?.length || 0,
        hasImage: !!e.imageEntryName,
        hasThumb: !!e.thumbEntryName,
        timelineEventCount: (e.timelineEvents || []).length,
        // Keep the full payload so commit can re-use it without
        // re-parsing the ZIP. Caller doesn't need to ship this back
        // — it lives on the same JS heap.
        _entry: e,
      })),
    };
  },

  async commitRecipeZip(file, opts = {}) {
    // Accept both `selected` (UI) and `idxs` (legacy) for the index
    // array. Same option shape as the server endpoint so the UI
    // doesn't need to branch on platform.
    const indices = Array.isArray(opts.selected) ? opts.selected
                  : Array.isArray(opts.idxs)     ? opts.idxs
                  : null;
    const addToPantry    = opts.addToPantry !== false;
    const applyTags      = opts.applyTags === true || opts.applyTags === 'true';
    const importImages   = opts.importImages !== false;
    const importTimeline = opts.importTimeline !== false;
    const dedup          = typeof opts.dedup === 'string' ? opts.dedup : 'skip';

    const { scanRecipeZip, readImageFromLoadedZip, loadRecipeZip, mealieEventImagePaths } = await import('./recipe-importers-client.js');
    const zip = await loadRecipeZip(file);
    const entries = await scanRecipeZip(file);
    const picked = indices
      ? indices.map(i => entries[parseInt(i, 10)]).filter(Boolean)
      : entries;

    const imported = [];
    const failed = [];
    const skipped = [];
    let timelineImported = 0;

    for (const entry of picked) {
      try {
        if (importImages && entry.imageEntryName && !entry.recipe.imgUrl) {
          const img = await readImageFromLoadedZip(zip, entry.imageEntryName);
          if (img) {
            const blob = new Blob([img.bytes], { type: `image/${img.ext === 'jpg' ? 'jpeg' : img.ext}` });
            const fileName = (entry.recipe.name || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'recipe';
            const uploaded = await this.uploadImage(new File([blob], `${fileName}.${img.ext}`, { type: blob.type }));
            entry.recipe.imgUrl = uploaded;
          }
        }
        // Save the recipe (or skip + look up the existing one). Either
        // way we end up with a target recipe_id to attach timeline
        // events to — re-imports should land cook history on the
        // existing recipe instead of being dropped alongside.
        const saved = await _saveImportedRecipeLocal(this, entry.recipe, { addToPantry, applyTags, dedup });
        let targetRecipeId = saved?.id;
        if (!saved) {
          skipped.push({ name: entry.recipe?.name || '?' });
          // Re-resolve the existing recipe so timeline events still
          // land on it. Match the same way _saveImportedRecipeLocal
          // does (case-insensitive name, then source_url).
          if (entry.recipe?.name) {
            const lower = entry.recipe.name.toLowerCase().trim();
            const existing = (await _query(
              `SELECT id FROM recipes
                WHERE user_id = ? AND deleted_at IS NULL AND LOWER(name) = ? LIMIT 1`,
              [LOCAL_USER_ID, lower]
            ))[0] || (entry.recipe.source_url ? (await _query(
              `SELECT id FROM recipes
                WHERE user_id = ? AND deleted_at IS NULL AND source_url = ? LIMIT 1`,
              [LOCAL_USER_ID, entry.recipe.source_url]
            ))[0] : null);
            targetRecipeId = existing?.id || null;
          }
        } else {
          imported.push(saved);
        }

        if (importTimeline && targetRecipeId && Array.isArray(entry.timelineEvents) && entry.timelineEvents.length) {
          // Pre-scan for "Recipe Created" event to backdate this
          // recipe's created_at. Subject-based to dodge event_type
          // enum-encoding variance.
          let oldestCreatedTs = null;
          for (const ev of entry.timelineEvents) {
            const subj = String(ev.subject || '').trim();
            if (/^recipe created/i.test(subj)) {
              const ts = ev.timestamp || ev.created_at || ev.createdAt;
              if (ts && (!oldestCreatedTs || ts < oldestCreatedTs)) oldestCreatedTs = ts;
            }
          }
          if (oldestCreatedTs) {
            try { await this.backdateRecipe(targetRecipeId, oldestCreatedTs); } catch {}
          }

          const SYSTEM_SUBJECTS = /^(recipe created|recipe updated)\b/i;
          for (const ev of entry.timelineEvents) {
            if (SYSTEM_SUBJECTS.test(String(ev.subject || '').trim())) continue;
            const ts = ev.timestamp || ev.created_at || ev.createdAt;
            if (!ts) continue;
            const date = String(ts).slice(0, 10);
            const msg = ev.event_message ?? ev.eventMessage ?? null;
            const noteBits = [];
            // Mealie auto-subject "<user> made this..." → drop; the
            // byline surfaces the cook via cook_diary.user_id.
            const _AUTO_MADE = /\bmade this( as a side| for \w+)?\.?$/i;
            if (ev.subject && ev.subject !== 'Recipe Made' && !_AUTO_MADE.test(ev.subject)) {
              noteBits.push(ev.subject);
            }
            if (msg) noteBits.push(msg);
            const notes = noteBits.join('\n').trim() || null;
            // Dedup: if a cook_diary row for this recipe on this date
            // with matching notes already exists, skip. Same-day +
            // same-notes is a safe heuristic for re-imports — distinct
            // same-day cooks would have different notes, and Mealie
            // events with empty notes still collapse cleanly since
            // re-imports produce the same empty notes value.
            const dupExists = (await _query(
              `SELECT 1 FROM cook_diary
                WHERE user_id = ? AND deleted_at IS NULL AND kind = 'cooked'
                  AND recipe_id = ? AND date = ?
                  AND IFNULL(notes, '') = IFNULL(?, '')
                LIMIT 1`,
              [LOCAL_USER_ID, targetRecipeId, date, notes]
            )).length > 0;
            if (dupExists) continue;

            // Cook-event photo. Mealie bundles each event image in the
            // same zip under data/recipes/<recipe-uuid>/images/timeline/
            // <event-uuid>/<size>.webp. Try the full-size first, falling
            // back to the smaller variants, then upload via the local
            // image pipeline (Capacitor Filesystem).
            let photoUrl = null;
            const hasImage = typeof ev.image === 'string' && /has image/i.test(ev.image);
            if (importImages && hasImage && entry._mealieRecipeUuid && ev.id) {
              for (const p of mealieEventImagePaths(entry._mealieRecipeUuid, ev.id)) {
                const img = await readImageFromLoadedZip(zip, p);
                if (img?.bytes?.length) {
                  try {
                    const blob = new Blob([img.bytes], { type: 'image/webp' });
                    const f = new File([blob], `mealie-${ev.id}.webp`, { type: 'image/webp' });
                    photoUrl = await this.uploadImage(f);
                  } catch {}
                  if (photoUrl) break;
                }
              }
            }

            try {
              await this.createDiaryEntry({ recipe_id: targetRecipeId, date, kind: 'cooked', notes, photo_url: photoUrl });
              timelineImported++;
            } catch {}
          }
        }
      } catch (e) {
        failed.push({ name: entry.recipe?.name || '?', error: e.message || String(e) });
      }
    }
    // Response shape mirrors the server endpoint so the SettingsImport
    // dialog reads `res.count` and `res.failed` uniformly.
    return {
      count: imported.length,
      recipes: imported,
      failed,
      skipped,
      timelineImported,
    };
  },

  // ── Pantry ─────────────────────────────────────────────────────────

  async getPantry(opts = {}) {
    const args = [LOCAL_USER_ID];
    let sql = `SELECT * FROM pantry_items WHERE user_id = ? AND deleted_at IS NULL`;
    if (opts.in_stock) sql += ` AND in_stock = 1`;
    if (opts.q) { sql += ` AND LOWER(name) LIKE ?`; args.push(`%${String(opts.q).toLowerCase()}%`); }
    sql += ` ORDER BY name COLLATE NOCASE ASC`;
    const rows = await _query(sql, args);

    // Also compute the recipe-usage count for each item (pull from the
    // ingredients JSON across every recipe — same one-pass scan the
    // server does).
    const recipeRows = await _query(
      `SELECT id, ingredients FROM recipes WHERE user_id = ? AND deleted_at IS NULL`,
      [LOCAL_USER_ID]
    );
    const usage = new Map();
    for (const r of recipeRows) {
      const groups = _parseJson(r.ingredients, []);
      const seen = new Set();
      for (const g of groups) for (const it of (g.items || [])) {
        const pid = it?.pantry_item_id;
        if (pid && !seen.has(pid)) {
          seen.add(pid);
          usage.set(pid, (usage.get(pid) || 0) + 1);
        }
      }
    }

    const catMap = await _pantryCategoryMap();
    return rows.map(r => ({ ..._pantryFromRow(r, catMap), recipe_count: usage.get(r.id) || 0 }));
  },

  async getPantryItem(id) {
    const rows = await _query(`SELECT * FROM pantry_items WHERE id = ? AND deleted_at IS NULL`, [id]);
    const catMap = await _pantryCategoryMap();
    return _pantryFromRow(rows[0], catMap);
  },

  async getPantryItemByBarcode(code) {
    if (!code) return null;
    const rows = await _query(
      `SELECT * FROM pantry_items WHERE user_id = ? AND barcode = ? AND deleted_at IS NULL LIMIT 1`,
      [LOCAL_USER_ID, code]
    );
    const catMap = await _pantryCategoryMap();
    return _pantryFromRow(rows[0], catMap) || null;
  },

  async getPantryItemRecipes(id) {
    const rows = await _query(
      `SELECT id, name, img_url, ingredients FROM recipes
        WHERE user_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE ASC`,
      [LOCAL_USER_ID]
    );
    const out = [];
    for (const r of rows) {
      const groups = _parseJson(r.ingredients, []);
      let used = false;
      for (const g of groups) for (const it of (g.items || [])) {
        if (it?.pantry_item_id === id) { used = true; break; }
      }
      if (used) out.push({ id: r.id, name: r.name, imgUrl: resolveAssetUrl(r.img_url) || '' });
    }
    return out;
  },

  async createPantryItem(data) {
    const d = data || {};
    const id = await _runInsert(
      `INSERT INTO pantry_items
         (user_id, name, brand, barcode, in_stock, quantity, unit, expires_on,
          img_url, notes, category, category_id, serving_size, serving_unit, serving_label,
          nutrition, g_per_cup, nt_food_id,
          generic_parent_id, nutrition_source_variant_id, sync_status)
       VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?, ?,?, 'pending')`,
      [
        LOCAL_USER_ID,
        d.name,
        d.brand || null,
        d.barcode || null,
        _bool(d.in_stock ?? true),
        d.quantity ?? null,
        d.unit || null,
        d.expires_on || null,
        d.img_url ?? d.imgUrl ?? null,
        d.notes || null,
        d.category || null,
        d.category_id ?? null,
        d.serving_size ?? null,
        d.serving_unit || null,
        d.serving_label || null,
        _stringify(d.nutrition ?? null),
        d.g_per_cup ?? null,
        d.nt_food_id ?? null,
        d.generic_parent_id ?? null,
        d.nutrition_source_variant_id ?? null,
      ]
    );
    return this.getPantryItem(id);
  },

  async updatePantryItem(id, d) {
    // Build the UPDATE from the keys ACTUALLY present in `d`. The prior
    // implementation wrote every column every time, using undefined
    // payload keys as NULL — which broke two things:
    //   1. Partial patches like quickToggle({quantity, in_stock})
    //      violated the NOT NULL constraint on `name` (d.name was
    //      undefined, coerced to NULL).
    //   2. Any partial update silently wiped generic_parent_id +
    //      nutrition_source_variant_id, which is why the variant
    //      relationship kept disappearing on mobile after any
    //      unrelated edit — the next sync push then propagated the
    //      NULLs up to the server.
    // The `img_url` payload key is accepted under either name for
    // backwards compat with call sites that used imgUrl.
    const fields = [];
    const params = [];
    const push = (col, val) => { fields.push(`${col} = ?`); params.push(val); };
    if ('name' in d)                        push('name', d.name);
    if ('brand' in d)                       push('brand', d.brand || null);
    if ('barcode' in d)                     push('barcode', d.barcode || null);
    if ('in_stock' in d)                    push('in_stock', _bool(d.in_stock));
    if ('quantity' in d)                    push('quantity', d.quantity ?? null);
    if ('unit' in d)                        push('unit', d.unit || null);
    if ('expires_on' in d)                  push('expires_on', d.expires_on || null);
    if ('img_url' in d || 'imgUrl' in d)    push('img_url', d.img_url ?? d.imgUrl ?? null);
    if ('notes' in d)                       push('notes', d.notes || null);
    if ('category' in d)                    push('category', d.category || null);
    if ('category_id' in d)                 push('category_id', d.category_id ?? null);
    if ('serving_size' in d)                push('serving_size', d.serving_size ?? null);
    if ('serving_unit' in d)                push('serving_unit', d.serving_unit || null);
    if ('serving_label' in d)               push('serving_label', d.serving_label || null);
    if ('nutrition' in d)                   push('nutrition', _stringify(d.nutrition ?? null));
    if ('g_per_cup' in d)                   push('g_per_cup', d.g_per_cup ?? null);
    if ('nt_food_id' in d)                  push('nt_food_id', d.nt_food_id ?? null);
    if ('generic_parent_id' in d)           push('generic_parent_id', d.generic_parent_id ?? null);
    if ('nutrition_source_variant_id' in d) push('nutrition_source_variant_id', d.nutrition_source_variant_id ?? null);
    if (fields.length === 0) return this.getPantryItem(id);
    fields.push(`updated_at = datetime('now')`);
    fields.push(`sync_status = 'pending'`);
    params.push(id);
    await _run(`UPDATE pantry_items SET ${fields.join(', ')} WHERE id = ?`, params);
    return this.getPantryItem(id);
  },

  async toggleStock(id, in_stock) {
    await _run(
      `UPDATE pantry_items SET in_stock = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
      [_bool(in_stock), id]
    );
    return { ok: true, in_stock: !!in_stock };
  },

  async deletePantryItem(id, opts = {}) {
    // Variant handling mirrors the server route. When deleting a generic
    // that has variants, either cascade (soft-delete every child) or
    // promote them to standalone flat items (clear generic_parent_id).
    // Without this the children would orphan: the parent is hidden by
    // deleted_at filter but the children still have generic_parent_id
    // set, so they're excluded from the top-level list.
    const cascade = !!opts.cascade;
    const variantRows = await _query(
      `SELECT id FROM pantry_items WHERE generic_parent_id = ? AND deleted_at IS NULL`,
      [id]
    );
    if (variantRows.length) {
      const ids = variantRows.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      if (cascade) {
        await _run(
          `UPDATE pantry_items SET deleted_at = datetime('now'), sync_status = 'pending' WHERE id IN (${placeholders})`,
          ids
        );
      } else {
        await _run(
          `UPDATE pantry_items SET generic_parent_id = NULL, sync_status = 'pending' WHERE id IN (${placeholders})`,
          ids
        );
      }
    }
    await _run(
      `UPDATE pantry_items SET deleted_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
      [id]
    );
    return { ok: true };
  },

  // ── Cook diary ─────────────────────────────────────────────────────

  async getCookDiary(opts = {}) {
    const args = [LOCAL_USER_ID];
    let sql = `
      SELECT cd.*, r.name AS recipe_name, r.img_url AS recipe_img_url
        FROM cook_diary cd
   LEFT JOIN recipes r ON r.id = cd.recipe_id
       WHERE cd.user_id = ? AND cd.deleted_at IS NULL`;
    if (opts.from) { sql += ' AND cd.date >= ?'; args.push(opts.from); }
    if (opts.to)   { sql += ' AND cd.date <= ?'; args.push(opts.to); }
    if (opts.kind) { sql += ' AND cd.kind = ?';  args.push(opts.kind); }
    sql += ` ORDER BY cd.date DESC, cd.created_at DESC`;
    const rows = await _query(sql, args);
    return rows.map(_diaryFromRow);
  },

  async createDiaryEntry(data) {
    const d = data || {};
    const id = await _runInsert(
      `INSERT INTO cook_diary
         (user_id, recipe_id, date, kind, servings, notes, photo_url, photos, meal_type, rating, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        LOCAL_USER_ID, d.recipe_id ?? null, d.date,
        d.kind === 'cooked' ? 'cooked' : 'planned',
        d.servings ?? null, d.notes || null,
        d.photo_url ?? null,
        d.photos != null ? _stringify(d.photos) : null,
        d.meal_type || null,
        d.rating ?? null,
      ]
    );
    if (d.kind === 'cooked' && d.recipe_id) await _recomputeCookAggregates(d.recipe_id);
    const rows = await _query(`SELECT * FROM cook_diary WHERE id = ?`, [id]);
    return _diaryFromRow(rows[0]);
  },

  async updateDiaryEntry(id, d) {
    // Mirror updateCook — same table, same field set.
    return this.updateCook(null, id, d);
  },

  async deleteDiaryEntry(id) {
    return this.deleteCook(null, id);
  },

  async getCookDiaryStats() {
    const where = `WHERE user_id = ? AND deleted_at IS NULL AND kind = 'cooked'`;
    const wk = await _query(`SELECT COUNT(*) AS n FROM cook_diary ${where} AND date >= date('now','-6 days')`, [LOCAL_USER_ID]);
    const mo = await _query(`SELECT COUNT(*) AS n FROM cook_diary ${where} AND date >= date('now','-29 days')`, [LOCAL_USER_ID]);
    const total = await _query(`SELECT COUNT(*) AS n FROM cook_diary ${where}`, [LOCAL_USER_ID]);

    const top = (await _query(
      `SELECT cd.recipe_id, r.name, COUNT(*) AS n
         FROM cook_diary cd LEFT JOIN recipes r ON r.id = cd.recipe_id
        ${where} AND date >= date('now','-29 days') AND cd.recipe_id IS NOT NULL
        GROUP BY cd.recipe_id ORDER BY n DESC, r.name COLLATE NOCASE ASC LIMIT 1`,
      [LOCAL_USER_ID]
    ))[0];
    const topRecipe = top ? { id: top.recipe_id, name: top.name || 'Recipe', count: top.n } : null;

    const dates = (await _query(
      `SELECT DISTINCT date AS d FROM cook_diary ${where} ORDER BY date DESC`,
      [LOCAL_USER_ID]
    )).map(r => r.d);
    const today = new Date().toISOString().slice(0, 10);
    const yest = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
    const set = new Set(dates);

    let cur = 0;
    let cursor = set.has(today) ? today : (set.has(yest) ? yest : null);
    while (cursor && set.has(cursor)) {
      cur++;
      const d = new Date(cursor + 'T00:00:00'); d.setDate(d.getDate() - 1);
      cursor = d.toISOString().slice(0, 10);
    }
    const asc = [...dates].reverse();
    let longest = 0, run = 0, prev = null;
    for (const d of asc) {
      if (prev) {
        const p = new Date(prev + 'T00:00:00'); p.setDate(p.getDate() + 1);
        run = d === p.toISOString().slice(0, 10) ? run + 1 : 1;
      } else run = 1;
      if (run > longest) longest = run;
      prev = d;
    }

    return {
      cooks_this_week: wk[0]?.n || 0,
      cooks_this_month: mo[0]?.n || 0,
      total_cooks: total[0]?.n || 0,
      top_recipe: topRecipe,
      current_streak: cur,
      longest_streak: longest,
    };
  },

  async getCookDiaryHeatmap(days = 365) {
    const cap = Math.min(Math.max(parseInt(days, 10) || 365, 30), 730);
    const since = new Date(); since.setDate(since.getDate() - (cap - 1));
    const sinceIso = since.toISOString().slice(0, 10);
    return _query(
      `SELECT date, COUNT(*) AS count FROM cook_diary
        WHERE user_id = ? AND deleted_at IS NULL AND kind = 'cooked' AND date >= ?
        GROUP BY date ORDER BY date ASC`,
      [LOCAL_USER_ID, sinceIso]
    );
  },

  // ── Shopping list ──────────────────────────────────────────────────

  async getShoppingList() {
    const rows = await _query(
      `SELECT s.*, p.name AS pantry_name, p.img_url AS pantry_img_url,
              r.name AS recipe_name
         FROM shopping_list s
    LEFT JOIN pantry_items p ON p.id = s.pantry_id
    LEFT JOIN recipes      r ON r.id = s.recipe_id AND r.deleted_at IS NULL
        WHERE s.user_id = ? AND s.deleted_at IS NULL
        ORDER BY s.checked ASC,
                 COALESCE(s.aisle, 'zzz') ASC,
                 CASE WHEN s.sort_order IS NULL THEN 1 ELSE 0 END,
                 s.sort_order ASC,
                 s.name COLLATE NOCASE ASC`,
      [LOCAL_USER_ID]
    );
    return rows.map(_shoppingFromRow);
  },

  async addShoppingItem(data) {
    const d = data || {};
    let aisle = d.aisle && String(d.aisle).trim() ? String(d.aisle).trim() : null;
    if (aisle == null && d.pantry_id) aisle = await _aisleForPantry(d.pantry_id);
    const id = await _runInsert(
      `INSERT INTO shopping_list
         (user_id, name, quantity, unit, aisle, checked, pantry_id, recipe_id, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        LOCAL_USER_ID, _titleCaseName(d.name), d.quantity ?? null, d.unit || null,
        aisle, _bool(d.checked), d.pantry_id ?? null, d.recipe_id ?? null,
      ]
    );
    const rows = await _query(`SELECT * FROM shopping_list WHERE id = ?`, [id]);
    return _shoppingFromRow(rows[0]);
  },

  async updateShoppingItem(id, d) {
    const existing = (await _query(`SELECT * FROM shopping_list WHERE id = ?`, [id]))[0];
    if (!existing) return { ok: false };
    const nextAisle = d.aisle !== undefined
      ? (d.aisle && String(d.aisle).trim() ? String(d.aisle).trim() : null)
      : existing.aisle;
    const nextSort = d.sort_order !== undefined
      ? (d.sort_order == null ? null : Number(d.sort_order))
      : existing.sort_order;
    await _run(
      `UPDATE shopping_list SET
         name = ?, quantity = ?, unit = ?, aisle = ?,
         checked = ?, pantry_id = ?, sort_order = ?,
         updated_at = datetime('now'), sync_status = 'pending'
       WHERE id = ?`,
      [
        d.name ?? existing.name,
        d.quantity !== undefined ? (d.quantity ?? null) : existing.quantity,
        d.unit !== undefined ? (d.unit || null) : existing.unit,
        nextAisle,
        d.checked !== undefined ? _bool(d.checked) : existing.checked,
        d.pantry_id !== undefined ? (d.pantry_id ?? null) : existing.pantry_id,
        nextSort,
        id,
      ]
    );
    return { ok: true };
  },

  async reorderShopping(items) {
    if (!Array.isArray(items) || !items.length) return { updated: 0 };
    let n = 0;
    for (const it of items) {
      const id = parseInt(it?.id, 10);
      if (!Number.isFinite(id)) continue;
      const existing = (await _query(`SELECT * FROM shopping_list WHERE id = ?`, [id]))[0];
      if (!existing) continue;
      const nextSort = it.sort_order == null ? null : Number(it.sort_order);
      const nextAisle = it.aisle !== undefined
        ? (it.aisle && String(it.aisle).trim() ? String(it.aisle).trim() : null)
        : existing.aisle;
      await _run(
        `UPDATE shopping_list
            SET sort_order = ?, aisle = ?,
                updated_at = datetime('now'), sync_status = 'pending'
          WHERE id = ?`,
        [nextSort, nextAisle, id]
      );
      n++;
    }
    return { updated: n };
  },

  async toggleShoppingChecked(id, checked) {
    await _run(
      `UPDATE shopping_list SET checked = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
      [_bool(checked), id]
    );
    return { ok: true, checked: !!checked };
  },

  async deleteShoppingItem(id) {
    await _run(
      `UPDATE shopping_list SET deleted_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
      [id]
    );
    return { ok: true };
  },

  async clearCheckedShopping() {
    await _run(
      `UPDATE shopping_list SET deleted_at = datetime('now'), sync_status = 'pending'
        WHERE user_id = ? AND checked = 1 AND deleted_at IS NULL`,
      [LOCAL_USER_ID]
    );
    return { ok: true };
  },

  async clearShoppingByRecipe(recipeId) {
    const before = (await _query(
      `SELECT COUNT(*) AS n FROM shopping_list
        WHERE user_id = ? AND recipe_id = ? AND deleted_at IS NULL`,
      [LOCAL_USER_ID, recipeId]
    ))[0]?.n || 0;
    await _run(
      `UPDATE shopping_list SET deleted_at = datetime('now'), sync_status = 'pending'
        WHERE user_id = ? AND recipe_id = ? AND deleted_at IS NULL`,
      [LOCAL_USER_ID, recipeId]
    );
    return { removed: before };
  },

  async shopFromRecipe(recipeId, opts = {}) {
    const recipe = (await _query(`SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL`, [recipeId]))[0];
    if (!recipe) return { added: 0 };
    const groups = _parseJson(recipe.ingredients, []);
    const flat = []; for (const g of groups) for (const it of (g.items || [])) flat.push(it);

    const onlyMissing = opts.only_missing !== false;
    const stockIds = new Set(
      (await _query(`SELECT id FROM pantry_items WHERE user_id = ? AND in_stock = 1 AND deleted_at IS NULL`, [LOCAL_USER_ID]))
        .map(r => r.id)
    );

    let added = 0;
    for (const it of flat) {
      if (!it?.name) continue;
      if (onlyMissing && it.pantry_item_id && stockIds.has(it.pantry_item_id)) continue;
      const aisle = await _aisleForPantry(it.pantry_item_id);
      await _runInsert(
        `INSERT INTO shopping_list (user_id, name, quantity, unit, aisle, pantry_id, recipe_id, checked, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
        [LOCAL_USER_ID, _titleCaseName(it.name), it.qty || null, it.unit || null, aisle, it.pantry_item_id || null, recipeId]
      );
      added++;
    }
    return { added };
  },

  async shopFromPlan(opts = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : today;
    let to = /^\d{4}-\d{2}-\d{2}$/.test(opts.to) ? opts.to : null;
    if (!to) { const d = new Date(); d.setDate(d.getDate() + 7); to = d.toISOString().slice(0, 10); }
    const onlyMissing = opts.only_missing !== false;

    const planned = await _query(
      `SELECT cd.id AS diary_id, cd.recipe_id, r.name AS recipe_name, r.ingredients
         FROM cook_diary cd JOIN recipes r ON r.id = cd.recipe_id AND r.deleted_at IS NULL
        WHERE cd.user_id = ? AND cd.deleted_at IS NULL AND cd.kind = 'planned'
          AND cd.date >= ? AND cd.date <= ?`,
      [LOCAL_USER_ID, from, to]
    );
    if (!planned.length) return { added: 0, planned_cooks: 0, from, to };

    const stockIds = new Set(
      (await _query(`SELECT id FROM pantry_items WHERE user_id = ? AND in_stock = 1 AND deleted_at IS NULL`, [LOCAL_USER_ID]))
        .map(r => r.id)
    );

    const merged = new Map();
    for (const row of planned) {
      const groups = _parseJson(row.ingredients, []);
      for (const g of groups) for (const it of (g.items || [])) {
        if (!it?.name) continue;
        if (onlyMissing && it.pantry_item_id && stockIds.has(it.pantry_item_id)) continue;
        const name = String(it.name).trim();
        const unit = it.unit ? String(it.unit).trim() : '';
        const key = `${name.toLowerCase()}|${unit.toLowerCase()}`;
        const qtyN = Number(it.qty);
        const hasQty = it.qty != null && it.qty !== '' && Number.isFinite(qtyN);
        const prev = merged.get(key);
        if (!prev) {
          merged.set(key, {
            name, unit: unit || null,
            qty: hasQty ? qtyN : null,
            qtyHadNull: !hasQty,
            pantry_id: it.pantry_item_id || null,
            recipe_id: row.recipe_id,
          });
        } else {
          if (prev.qtyHadNull || !hasQty) { prev.qty = null; prev.qtyHadNull = true; }
          else prev.qty = (prev.qty || 0) + qtyN;
          if (!prev.pantry_id && it.pantry_item_id) prev.pantry_id = it.pantry_item_id;
        }
      }
    }

    let added = 0;
    for (const row of merged.values()) {
      const aisle = await _aisleForPantry(row.pantry_id);
      await _runInsert(
        `INSERT INTO shopping_list (user_id, name, quantity, unit, aisle, pantry_id, recipe_id, checked, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
        [LOCAL_USER_ID, _titleCaseName(row.name), row.qty, row.unit, aisle, row.pantry_id, row.recipe_id]
      );
      added++;
    }
    return { added, planned_cooks: planned.length, from, to };
  },

  // ── Recipe categories ──────────────────────────────────────────────

  async getRecipeCategories() {
    const rows = await _query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM recipes r
                WHERE r.category_id = c.id AND r.deleted_at IS NULL AND r.user_id = c.user_id) AS recipe_count
         FROM recipe_categories c
        WHERE c.user_id = ? AND c.deleted_at IS NULL
        ORDER BY c.sort_order ASC, c.name COLLATE NOCASE ASC`,
      [LOCAL_USER_ID]
    );
    return rows;
  },
  async createRecipeCategory(d) {
    const max = (await _query(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM recipe_categories WHERE user_id = ?`, [LOCAL_USER_ID]))[0]?.m ?? -1;
    let slug = _slug(d.name); let n = 2;
    while ((await _query(`SELECT 1 FROM recipe_categories WHERE user_id = ? AND slug = ?`, [LOCAL_USER_ID, slug])).length) {
      slug = `${_slug(d.name)}-${n++}`;
    }
    const id = await _runInsert(
      `INSERT INTO recipe_categories (user_id, name, slug, color, sort_order, sync_status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [LOCAL_USER_ID, d.name, slug, d.color || null, max + 1]
    );
    return (await _query(`SELECT * FROM recipe_categories WHERE id = ?`, [id]))[0];
  },
  async updateRecipeCategory(id, d) {
    await _run(
      `UPDATE recipe_categories SET name = ?, color = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
      [d.name, d.color || null, id]
    );
    return (await _query(`SELECT * FROM recipe_categories WHERE id = ?`, [id]))[0];
  },
  async deleteRecipeCategory(id) {
    await _run(`UPDATE recipes SET category_id = NULL WHERE category_id = ?`, [id]);
    await _run(`DELETE FROM recipe_categories WHERE id = ?`, [id]);
    return { ok: true };
  },
  async reorderRecipeCategories(ids) {
    for (let i = 0; i < ids.length; i++) {
      await _run(
        `UPDATE recipe_categories SET sort_order = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND user_id = ?`,
        [i, ids[i], LOCAL_USER_ID]
      );
    }
    return { ok: true };
  },

  // ── Pantry categories ──────────────────────────────────────────────

  async getPantryCategories() {
    return _query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM pantry_items p
                WHERE p.category_id = c.id AND p.deleted_at IS NULL AND p.user_id = c.user_id) AS pantry_count
         FROM pantry_categories c
        WHERE c.user_id = ? AND c.deleted_at IS NULL
        ORDER BY c.sort_order ASC, c.name COLLATE NOCASE ASC`,
      [LOCAL_USER_ID]
    );
  },
  async createPantryCategory(d) {
    const max = (await _query(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM pantry_categories WHERE user_id = ?`, [LOCAL_USER_ID]))[0]?.m ?? -1;
    let slug = _slug(d.name); let n = 2;
    while ((await _query(`SELECT 1 FROM pantry_categories WHERE user_id = ? AND slug = ?`, [LOCAL_USER_ID, slug])).length) {
      slug = `${_slug(d.name)}-${n++}`;
    }
    const defaultAisle = d.default_aisle && String(d.default_aisle).trim()
      ? String(d.default_aisle).trim().slice(0, 40) : null;
    const id = await _runInsert(
      `INSERT INTO pantry_categories (user_id, name, slug, icon, color, sort_order, default_aisle, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [LOCAL_USER_ID, d.name, slug, d.icon || null, d.color || null, max + 1, defaultAisle]
    );
    return (await _query(`SELECT * FROM pantry_categories WHERE id = ?`, [id]))[0];
  },
  async updatePantryCategory(id, d) {
    const defaultAisle = d.default_aisle !== undefined
      ? (d.default_aisle && String(d.default_aisle).trim() ? String(d.default_aisle).trim().slice(0, 40) : null)
      : undefined;
    if (defaultAisle === undefined) {
      await _run(
        `UPDATE pantry_categories SET name = ?, icon = ?, color = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
        [d.name, d.icon || null, d.color || null, id]
      );
    } else {
      await _run(
        `UPDATE pantry_categories SET name = ?, icon = ?, color = ?, default_aisle = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
        [d.name, d.icon || null, d.color || null, defaultAisle, id]
      );
    }
    return (await _query(`SELECT * FROM pantry_categories WHERE id = ?`, [id]))[0];
  },
  async deletePantryCategory(id) {
    await _run(`UPDATE pantry_items SET category_id = NULL WHERE category_id = ?`, [id]);
    await _run(`DELETE FROM pantry_categories WHERE id = ?`, [id]);
    return { ok: true };
  },
  async reorderPantryCategories(ids) {
    for (let i = 0; i < ids.length; i++) {
      await _run(
        `UPDATE pantry_categories SET sort_order = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND user_id = ?`,
        [i, ids[i], LOCAL_USER_ID]
      );
    }
    return { ok: true };
  },

  // ── Units ──────────────────────────────────────────────────────────

  async getUnits() {
    const disabled = (await _query(`SELECT abbr FROM disabled_units WHERE user_id = ?`, [LOCAL_USER_ID])).map(r => r.abbr);
    const custom = await _query(
      `SELECT * FROM custom_units WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY sort_order ASC, abbr ASC`,
      [LOCAL_USER_ID]
    );
    // Usage from recipe ingredient units.
    const recipeRows = await _query(`SELECT ingredients FROM recipes WHERE user_id = ? AND deleted_at IS NULL`, [LOCAL_USER_ID]);
    const usage = {};
    for (const r of recipeRows) {
      const groups = _parseJson(r.ingredients, []);
      for (const g of groups) for (const it of (g.items || [])) {
        if (!it?.unit) continue;
        const k = String(it.unit).toLowerCase().trim();
        if (!k) continue;
        usage[k] = (usage[k] || 0) + 1;
      }
    }
    return { disabled, custom, usage };
  },
  async toggleBuiltinUnit(abbr, disabled) {
    if (disabled) {
      await _run(`INSERT OR IGNORE INTO disabled_units (user_id, abbr) VALUES (?, ?)`, [LOCAL_USER_ID, abbr]);
    } else {
      await _run(`DELETE FROM disabled_units WHERE user_id = ? AND abbr = ?`, [LOCAL_USER_ID, abbr]);
    }
    return { ok: true, abbr, disabled: !!disabled };
  },
  async createCustomUnit(d) {
    const max = (await _query(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM custom_units WHERE user_id = ?`, [LOCAL_USER_ID]))[0]?.m ?? -1;
    const id = await _runInsert(
      `INSERT INTO custom_units (user_id, abbr, full_name, category, sort_order, sync_status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [LOCAL_USER_ID, d.abbr, d.full_name || d.abbr, d.category || null, max + 1]
    );
    return (await _query(`SELECT * FROM custom_units WHERE id = ?`, [id]))[0];
  },
  async updateCustomUnit(id, d) {
    await _run(
      `UPDATE custom_units SET abbr = ?, full_name = ?, category = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
      [d.abbr, d.full_name || d.abbr, d.category || null, id]
    );
    return (await _query(`SELECT * FROM custom_units WHERE id = ?`, [id]))[0];
  },
  async deleteCustomUnit(id) {
    await _run(`DELETE FROM custom_units WHERE id = ?`, [id]);
    return { ok: true };
  },

  // ── Cookbooks ──────────────────────────────────────────────────────

  async getCookbooks() {
    const rows = await _query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM recipe_cookbook_links l WHERE l.cookbook_id = c.id) AS recipe_count
         FROM cookbooks c
        WHERE c.user_id = ? AND c.deleted_at IS NULL
        ORDER BY c.sort_order ASC, c.name COLLATE NOCASE ASC`,
      [LOCAL_USER_ID]
    );
    return rows.map(_cookbookFromRow);
  },
  async getCookbook(id) {
    const cb = (await _query(`SELECT * FROM cookbooks WHERE id = ? AND deleted_at IS NULL`, [id]))[0];
    if (!cb) return null;
    const out = _cookbookFromRow(cb);
    const recipes = await _query(
      `SELECT r.*, l.sort_order AS link_sort
         FROM recipe_cookbook_links l
         JOIN recipes r ON r.id = l.recipe_id AND r.deleted_at IS NULL
        WHERE l.cookbook_id = ?
        ORDER BY l.sort_order ASC, r.name COLLATE NOCASE ASC`,
      [id]
    );
    out.recipes = recipes.map(_recipeFromRow);
    return out;
  },
  async createCookbook(d) {
    let slug = _slug(d.name); let n = 2;
    while ((await _query(`SELECT 1 FROM cookbooks WHERE user_id = ? AND slug = ?`, [LOCAL_USER_ID, slug])).length) {
      slug = `${_slug(d.name)}-${n++}`;
    }
    const max = (await _query(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM cookbooks WHERE user_id = ?`, [LOCAL_USER_ID]))[0]?.m ?? -1;
    const id = await _runInsert(
      `INSERT INTO cookbooks (user_id, name, slug, description, cover_image_url, is_smart, smart_filter_json, sort_order, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [LOCAL_USER_ID, d.name, slug, d.description || null, d.cover_image_url || null, _bool(d.is_smart), _stringify(d.smart_filter), max + 1]
    );
    return _cookbookFromRow((await _query(`SELECT * FROM cookbooks WHERE id = ?`, [id]))[0]);
  },
  async updateCookbook(id, d) {
    await _run(
      `UPDATE cookbooks SET name = ?, description = ?, cover_image_url = ?, is_smart = ?, smart_filter_json = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
      [d.name, d.description || null, d.cover_image_url || null, _bool(d.is_smart), _stringify(d.smart_filter), id]
    );
    return _cookbookFromRow((await _query(`SELECT * FROM cookbooks WHERE id = ?`, [id]))[0]);
  },
  async deleteCookbook(id) {
    await _run(`UPDATE cookbooks SET deleted_at = datetime('now'), sync_status = 'pending' WHERE id = ?`, [id]);
    await _run(`DELETE FROM recipe_cookbook_links WHERE cookbook_id = ?`, [id]);
    return { ok: true };
  },
  async addRecipesToCookbook(id, recipeIds) {
    const max = (await _query(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM recipe_cookbook_links WHERE cookbook_id = ?`, [id]))[0]?.m ?? -1;
    let added = 0;
    for (let i = 0; i < recipeIds.length; i++) {
      const r = await _run(
        `INSERT OR IGNORE INTO recipe_cookbook_links (cookbook_id, recipe_id, sort_order, sync_status)
         VALUES (?, ?, ?, 'pending')`,
        [id, recipeIds[i], max + 1 + i]
      );
      if ((r?.changes?.changes ?? r?.changes ?? 0) > 0) added++;
    }
    return { ok: true, added };
  },
  async removeRecipeFromCookbook(id, recipeId) {
    await _run(`DELETE FROM recipe_cookbook_links WHERE cookbook_id = ? AND recipe_id = ?`, [id, recipeId]);
    return { ok: true };
  },
  async reorderCookbooks(ids) {
    for (let i = 0; i < ids.length; i++) {
      await _run(
        `UPDATE cookbooks SET sort_order = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ? AND user_id = ?`,
        [i, ids[i], LOCAL_USER_ID]
      );
    }
    return { ok: true };
  },
  async reorderCookbookRecipes(id, recipeIds) {
    for (let i = 0; i < recipeIds.length; i++) {
      await _run(
        `UPDATE recipe_cookbook_links SET sort_order = ? WHERE cookbook_id = ? AND recipe_id = ?`,
        [i, id, recipeIds[i]]
      );
    }
    return { ok: true };
  },
  async getCookbooksForRecipe(recipeId) {
    return _query(
      `SELECT c.* FROM cookbooks c
        JOIN recipe_cookbook_links l ON l.cookbook_id = c.id
       WHERE l.recipe_id = ? AND c.deleted_at IS NULL
       ORDER BY c.name COLLATE NOCASE ASC`,
      [recipeId]
    );
  },

  // ── Tags + Tools enumeration (live-scan recipes) ───────────────────
  // Names mirror the app's call sites — earlier versions used
  // shorter getTags/renameTag which the HTTP impl doesn't expose.

  async getRecipeTags()  { return _enumerateField('tags'); },
  async getRecipeTools() { return _enumerateField('tools'); },
  async renameRecipeTag(oldName, newName)  { return _renameField('tags', oldName, newName); },
  async deleteRecipeTag(name)              { return _deleteField('tags', name); },
  async renameRecipeTool(oldName, newName) { return _renameField('tools', oldName, newName); },
  async deleteRecipeTool(name)             { return _deleteField('tools', name); },

  // ── Comments ───────────────────────────────────────────────────────
  // Local single-user mode: comments still work (notes-to-self).
  // Method names mirror the app's call sites (getRecipeComments etc.)
  // — earlier versions used the shorter getComments/addComment naming
  // which the HTTP impl in api.js doesn't use.

  async getRecipeComments(recipeId) {
    const rows = await _query(
      `SELECT * FROM recipe_comments WHERE recipe_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
      [recipeId]
    );
    // Local mode is single-user; stamp a synthetic byline so the
    // comment list renders consistently with server mode.
    return rows.map(r => ({ ...r, created_by_full_name: 'You' }));
  },
  async postRecipeComment(recipeId, body, parentId = null) {
    const id = await _runInsert(
      `INSERT INTO recipe_comments (user_id, recipe_id, parent_id, body, sync_status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [LOCAL_USER_ID, recipeId, parentId, body]
    );
    const row = (await _query(`SELECT * FROM recipe_comments WHERE id = ?`, [id]))[0];
    if (row) row.created_by_full_name = 'You';
    return row;
  },
  async updateRecipeComment(_recipeId, cid, body) {
    await _run(
      `UPDATE recipe_comments SET body = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
      [body, cid]
    );
    return { ok: true };
  },
  async deleteRecipeComment(_recipeId, cid) {
    await _run(`UPDATE recipe_comments SET deleted_at = datetime('now'), sync_status = 'pending' WHERE id = ?`, [cid]);
    return { ok: true };
  },

  // ── AI chat history ────────────────────────────────────────────────

  async getAiChatHistory() {
    return _query(
      `SELECT * FROM ai_chat_history WHERE user_id = ? ORDER BY created_at ASC`,
      [LOCAL_USER_ID]
    );
  },
  async appendAiChat(role, content) {
    await _runInsert(
      `INSERT INTO ai_chat_history (user_id, role, content, sync_status) VALUES (?, ?, ?, 'pending')`,
      [LOCAL_USER_ID, role, content]
    );
    return { ok: true };
  },
  async clearAiChat() {
    await _run(`DELETE FROM ai_chat_history WHERE user_id = ?`, [LOCAL_USER_ID]);
    return { ok: true };
  },

  // ── Multi-user / federation / sharing / kitchens stubs ─────────────
  // Local mode is inherently single-user — these endpoints either
  // return empty results so the UI guards collapse cleanly, or throw
  // a "requires server" error so the user sees a meaningful message.

  async getUsersList()             { return [{ id: LOCAL_USER_ID, username: 'local', role: 'admin' }]; },
  async getAppConfig()             { return { sharing_enabled: false, user_mgmt_active: false }; },
  async getSharePeers()            { return []; },
  async getRecipeShares()          { return []; },
  async shareRecipeWithUsers()     { return { added: 0 }; },
  async unshareRecipeWithUser()    { return { ok: true }; },
  async mintRecipeShareToken()     { throw new Error('Public share links require a server connection.'); },
  async revokeRecipeShareToken()   { return { ok: true }; },
  async getRecipesSharedWithMe()   { return []; },

  // Kitchens (household / group sharing) — single-user local mode has
  // no concept of kitchens. Returns empty / no-op shapes that match
  // the HTTP impl so the Settings UI doesn't blow up.
  async getKitchens()              { return []; },
  async getKitchenMembers()        { return []; },
  async createKitchen()            { throw new Error('Kitchens require a server connection.'); },
  async deleteKitchen()            { return { ok: true }; },
  async addKitchenMember()         { throw new Error('Kitchens require a server connection.'); },
  async removeKitchenMember()      { return { ok: true }; },
  async shareRecipeWithKitchen()   { return { added: 0 }; },

  // Recipe importers — Mealie / Tandoor / Paprika ZIPs need the
  // server-side parser pipeline. UI guard suppresses the dialog in
  // local mode but throw a clear error if anything still calls in.
  async scanRecipeZip()            { throw new Error('Recipe ZIP import requires a server connection.'); },
  async commitRecipeZip()          { throw new Error('Recipe ZIP import requires a server connection.'); },

  // Low-level helpers used by Settings sub-components for endpoints
  // that don't have a dedicated wrapper (e.g. /api/health). In local
  // mode they refuse politely instead of bombing with "not a function".
  async get(path)   { throw new Error(`Local mode: ${path} is server-only`); },
  async post(path)  { throw new Error(`Local mode: ${path} is server-only`); },
  async del(path)   { throw new Error(`Local mode: ${path} is server-only`); },

  // ── Image upload via Filesystem ────────────────────────────────────

  async uploadImage(file) {
    const base64 = await _fileToBase64(file);
    const safe = String(file?.name || 'image').replace(/[^a-zA-Z0-9.]/g, '_');
    const fileName = `img_${Date.now()}_${safe}`;
    await Filesystem.writeFile({
      path: `uploads/${fileName}`,
      data: base64,
      directory: Directory.Data,
      recursive: true,
    });
    const { uri } = await Filesystem.getUri({
      path: `uploads/${fileName}`,
      directory: Directory.Data,
    });
    // Store the WebView-safe URL rather than the raw file:// URI. Android
    // WebView blocks file:// even after resolveAssetUrl's convertFileSrc
    // pass under some scheme configurations (previously-uploaded photos
    // stayed rendered because their URIs came from image-cache's
    // already-converted mapping; freshly uploaded ones hit an unconverted
    // path and 404'd). Converting at upload time means the stored value is
    // https://localhost/_capacitor_file_/... and every render site works
    // without depending on the runtime pass.
    const { Capacitor: CapCore } = await import('@capacitor/core');
    return (CapCore && typeof CapCore.convertFileSrc === 'function')
      ? CapCore.convertFileSrc(uri)
      : uri;
  },
};

// Alias for code that's already migrated to the CookTrace naming.
export const NtApiNative = CtApiNative;

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Persist an imported recipe to the local DB with dedup.
 *
 * @param {object} api      reference to CtApiNative (`this` inside the
 *                          import methods)
 * @param {object} r        normalised recipe shape (importers output)
 * @param {object} opts
 *   addToPantry  pull recipe ingredient names into pantry_items
 *   applyTags    keep r.tags (currently always true; placeholder)
 *   dedup        'skip' (default) | 'force' | 'replace'
 * @returns {object|null}   the saved recipe row, or null when skipped
 */
async function _saveImportedRecipeLocal(api, r, opts = {}) {
  const { addToPantry = true, dedup = 'skip' } = opts;
  if (!r?.name) return null;

  // Dedup pass — match by case-insensitive name first, then by
  // source_url. If a match exists and dedup === 'skip', leave the
  // existing recipe alone. 'replace' updates the existing row.
  // 'force' creates a duplicate (the pre-dedup behaviour).
  if (dedup !== 'force') {
    const lower = r.name.toLowerCase().trim();
    const existingByName = (await _query(
      `SELECT id, name, source_url FROM recipes
        WHERE user_id = ? AND deleted_at IS NULL AND LOWER(name) = ? LIMIT 1`,
      [LOCAL_USER_ID, lower]
    ))[0];
    let existing = existingByName;
    if (!existing && r.source_url) {
      existing = (await _query(
        `SELECT id, name, source_url FROM recipes
          WHERE user_id = ? AND deleted_at IS NULL AND source_url = ? LIMIT 1`,
        [LOCAL_USER_ID, r.source_url]
      ))[0];
    }
    if (existing) {
      if (dedup === 'skip') return null;
      if (dedup === 'replace') {
        return api.updateRecipe(existing.id, _importedToRecipePayload(r));
      }
    }
  }

  const saved = await api.createRecipe(_importedToRecipePayload(r));
  // Backdate to the source app's original creation timestamp if the
  // importer captured one. backdateRecipe only pulls the date back,
  // never forward, so this is safe to call unconditionally.
  if (saved?.id && r.imported_created_at) {
    try { await api.backdateRecipe(saved.id, r.imported_created_at); } catch {}
  }
  // Pantry auto-create — best-effort, mirrors what server's
  // ensurePantryItems does. Reads existing pantry rows (case-
  // insensitive) and only inserts the missing names.
  if (addToPantry && Array.isArray(saved.ingredients)) {
    const existing = await api.getPantry();
    const have = new Set((existing || []).map(p => (p.name || '').toLowerCase().trim()));
    for (const group of saved.ingredients) {
      for (const it of (group.items || [])) {
        const name = (it.name || '').trim();
        if (!name) continue;
        if (have.has(name.toLowerCase())) continue;
        try {
          await api.createPantryItem({ name, in_stock: true });
          have.add(name.toLowerCase());
        } catch {}
      }
    }
  }
  return saved;
}

function _importedToRecipePayload(r) {
  return {
    name: r.name,
    description: r.description ?? null,
    img_url: r.imgUrl ?? r.img_url ?? null,
    servings: r.servings ?? 2,
    yield_text: r.yield_text ?? null,
    prep_minutes:  r.prep_minutes  ?? null,
    cook_minutes:  r.cook_minutes  ?? null,
    total_minutes: r.total_minutes ?? null,
    rest_minutes:  r.rest_minutes  ?? null,
    ingredients: r.ingredients ?? [],
    steps: r.steps ?? [],
    tags: r.tags ?? [],
    tools: r.tools ?? [],
    nutrition: r.nutrition ?? {},
    source_url: r.source_url ?? null,
    video_url: r.video_url ?? null,
    notes: r.notes ?? null,
  };
}

async function _recomputeCookAggregates(recipeId) {
  if (!recipeId) return;
  // cook_diary.date is YYYY-MM-DD. MAX(date) is the latest cook day;
  // store as a date-only string. The earlier composite of date +
  // created_at produced malformed timestamps.
  const stats = (await _query(
    `SELECT COUNT(*) AS n, MAX(date) AS last
       FROM cook_diary
      WHERE recipe_id = ? AND deleted_at IS NULL AND kind = 'cooked'`,
    [recipeId]
  ))[0];
  await _run(
    `UPDATE recipes SET cook_count = ?, last_cooked_at = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
    [stats?.n || 0, stats?.last || null, recipeId]
  );
}

async function _enumerateField(field) {
  const rows = await _query(
    `SELECT ${field} AS j FROM recipes WHERE user_id = ? AND deleted_at IS NULL`,
    [LOCAL_USER_ID]
  );
  const counts = new Map();
  for (const r of rows) {
    const arr = _parseJson(r.j, []);
    for (const t of arr) {
      if (!t) continue;
      const key = String(t).toLowerCase();
      const display = String(t);
      const cur = counts.get(key);
      if (!cur) counts.set(key, { name: display, count: 1 });
      else cur.count++;
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

async function _renameField(field, oldName, newName) {
  const rows = await _query(
    `SELECT id, ${field} AS j FROM recipes WHERE user_id = ? AND deleted_at IS NULL`,
    [LOCAL_USER_ID]
  );
  const lower = String(oldName).toLowerCase();
  for (const r of rows) {
    const arr = _parseJson(r.j, []);
    let changed = false;
    const next = [];
    for (const t of arr) {
      if (String(t).toLowerCase() === lower) {
        if (newName) next.push(newName);
        changed = true;
      } else next.push(t);
    }
    if (changed) {
      await _run(
        `UPDATE recipes SET ${field} = ?, updated_at = datetime('now'), sync_status = 'pending' WHERE id = ?`,
        [JSON.stringify(next), r.id]
      );
    }
  }
  return { ok: true };
}
async function _deleteField(field, name) { return _renameField(field, name, null); }

// ── Minimal JSON-LD Recipe extractor for local-mode URL scrape ───────
// Walks <script type="application/ld+json"> blocks looking for a
// schema.org Recipe node. Picks the first match. Returns a shape the
// rest of CookTrace expects (name, ingredients, steps, etc.).
function _parseRecipeJsonLd(html, sourceUrl) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of blocks) {
    let data;
    try { data = JSON.parse(m[1].trim().replace(/^﻿/, '')); } catch { continue; }
    const recipe = _findRecipeNode(data);
    if (recipe) return _normalizeJsonLdRecipe(recipe, sourceUrl);
  }
  return null;
}
function _findRecipeNode(node) {
  if (!node) return null;
  if (Array.isArray(node)) { for (const x of node) { const r = _findRecipeNode(x); if (r) return r; } return null; }
  if (typeof node !== 'object') return null;
  const type = node['@type'];
  if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) return node;
  if (Array.isArray(node['@graph'])) return _findRecipeNode(node['@graph']);
  return null;
}
function _normalizeJsonLdRecipe(r, sourceUrl) {
  const name = r.name || 'Imported recipe';
  const description = r.description || null;
  const img = Array.isArray(r.image) ? (r.image[0]?.url || r.image[0]) : (r.image?.url || r.image || null);
  const servings = parseInt(String(r.recipeYield || r.yield || '').match(/\d+/)?.[0] || '0', 10) || 2;
  const ingredients = (r.recipeIngredient || []).map(s => ({ name: String(s).trim() }));
  const steps = (Array.isArray(r.recipeInstructions) ? r.recipeInstructions : (r.recipeInstructions ? [r.recipeInstructions] : [])).map(s => {
    if (typeof s === 'string') return { text: s };
    if (s.text) return { text: s.text };
    return { text: String(s) };
  });
  const prep = _parseDuration(r.prepTime);
  const cook = _parseDuration(r.cookTime);
  return {
    name,
    description,
    img_url: img,
    servings,
    prep_minutes: prep,
    cook_minutes: cook,
    ingredients: [{ name: '', items: ingredients }],
    steps,
    tags: Array.isArray(r.keywords) ? r.keywords : (typeof r.keywords === 'string' ? r.keywords.split(',').map(s => s.trim()).filter(Boolean) : []),
    source_url: sourceUrl,
  };
}
function _parseDuration(iso) {
  if (!iso) return null;
  const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  return (parseInt(m[1] || 0, 10) * 60) + parseInt(m[2] || 0, 10) || null;
}
