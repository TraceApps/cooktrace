/**
 * recipe-importers-client.js — client-side recipe import for native
 * local mode. Ports the server-side server/lib/recipe-importers.js
 * to the browser: JSZip works in both, and Node's zlib.gunzip is
 * replaced by the browser's DecompressionStream.
 *
 * Same public API as the server version:
 *   importRecipeFromText(text, hint?)          → recipe object
 *   importPaprikaArchive(blob)                 → recipe[]
 *   loadRecipeZip(blob)                        → JSZip
 *   scanRecipeZip(blob)                        → [{ recipe, source, imageEntryName, thumbEntryName }]
 *   scanLoadedZip(zip)                         → same
 *   readImageFromLoadedZip(zip, entryName)     → { bytes: Uint8Array, ext } | null
 *
 * Designed to be drop-in replaced by re-exporting from a shared module
 * once Node has a stable browser-isomorphic zlib (DecompressionStream
 * is already universal in modern browsers — but the imports differ).
 */

import JSZip from 'jszip';
import {
  extractRecipeFromHtml,
  normaliseSchemaOrgRecipe,
  parseIngredientLine,
} from './recipe-scraper-client.js';

const _utf8 = new TextDecoder('utf-8');

// ── Public API ────────────────────────────────────────────────────────

export function importRecipeFromText(text, hint = null) {
  if (!text || typeof text !== 'string') throw new Error('Empty input');
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Empty input');

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed;
    try { parsed = JSON.parse(trimmed); }
    catch (e) { throw new Error('Invalid JSON: ' + e.message); }
    return _importFromJson(parsed);
  }
  if (/<html|<script[^>]*ld\+json|<!doctype/i.test(trimmed)) {
    const r = extractRecipeFromHtml(trimmed, hint || null);
    if (!r) throw new Error('No schema.org/Recipe data found in the HTML');
    return r;
  }
  return {
    name: 'Pasted recipe',
    description: null,
    imgUrl: null,
    servings: null,
    yield_text: null,
    prep_minutes:  null,
    cook_minutes:  null,
    rest_minutes:  null,
    total_minutes: null,
    ingredients: [],
    steps: trimmed.split(/\n{2,}/).map(p => ({ title: '', text: p.trim() })).filter(s => s.text),
    tags: [],
    tools: [],
    nutrition: {},
    source_url: hint || null,
    notes: null,
    category_name: null,
  };
}

export async function importPaprikaArchive(blob) {
  const zip = await JSZip.loadAsync(blob);
  const recipes = [];
  const entries = Object.values(zip.files).filter(e => !e.dir && e.name.endsWith('.paprikarecipe'));
  if (entries.length === 0) throw new Error('No .paprikarecipe files found in archive');
  for (const entry of entries) {
    const compressed = await entry.async('uint8array');
    let json;
    try {
      const decompressed = await _gunzip(compressed);
      json = JSON.parse(_utf8.decode(decompressed));
    } catch {
      try { json = JSON.parse(_utf8.decode(compressed)); }
      catch { throw new Error(`Could not decode ${entry.name}`); }
    }
    recipes.push(_importPaprika(json));
  }
  return recipes;
}

export async function loadRecipeZip(blob) {
  return JSZip.loadAsync(blob);
}

export async function readImageFromLoadedZip(zip, entryName) {
  if (!entryName) return null;
  try {
    const entry = zip.file(entryName);
    if (!entry) return null;
    const bytes = await entry.async('uint8array');
    const ext = (entryName.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || 'jpg';
    return { bytes, ext };
  } catch {
    return null;
  }
}

export async function scanRecipeZip(blob) {
  const zip = await JSZip.loadAsync(blob);
  return scanLoadedZip(zip);
}

export async function scanLoadedZip(zip) {
  const out = [];

  const paprikaEntries = Object.values(zip.files).filter(e => !e.dir && e.name.endsWith('.paprikarecipe'));
  if (paprikaEntries.length > 0) {
    for (const entry of paprikaEntries) {
      const compressed = await entry.async('uint8array');
      let json;
      try {
        const decompressed = await _gunzip(compressed);
        json = JSON.parse(_utf8.decode(decompressed));
      } catch {
        try { json = JSON.parse(_utf8.decode(compressed)); }
        catch { continue; }
      }
      const recipe = _importPaprika(json);
      out.push({ recipe, source: 'paprika', imageEntryName: null, thumbEntryName: null });
    }
    return out;
  }

  const jsonEntries = Object.values(zip.files).filter(e =>
    !e.dir && /\.json$/i.test(e.name) && !/(^|\/)package(-lock)?\.json$/i.test(e.name)
  );

  // Mealie full-backup timeline events — surface alongside recipes so
  // the importer UI can offer to bring them into the diary.
  const timelineEvents = [];

  const skipped = [];
  for (const entry of jsonEntries) {
    let json;
    try {
      const text = await entry.async('text');
      json = JSON.parse(text);
    } catch {
      skipped.push({ path: entry.name, reason: 'invalid JSON' });
      continue;
    }

    // Mealie full-backup database.json: relational dump.
    if (Array.isArray(json?.recipes) && Array.isArray(json?.recipes_ingredients) && Array.isArray(json?.recipe_instructions)) {
      const expanded = _expandMealieDatabaseDump(zip, json);
      for (const e of expanded) out.push(e);
      // Pull timeline events too — Mealie stores them in the same
      // database.json under recipe_timeline_events.
      if (Array.isArray(json.recipe_timeline_events)) {
        for (const ev of json.recipe_timeline_events) timelineEvents.push(ev);
      }
      continue;
    }

    let recipe;
    try { recipe = _importFromJson(json); }
    catch (e) {
      skipped.push({ path: entry.name, reason: e.message || 'unrecognised shape' });
      continue;
    }
    if (!recipe?.name) {
      skipped.push({ path: entry.name, reason: 'missing recipe name' });
      continue;
    }
    const dir = entry.name.replace(/[^/]+$/, '');
    const imageEntry = _findSiblingImage(zip, dir);
    const thumbEntry = _findSiblingThumbnail(zip, dir) || imageEntry;
    out.push({
      recipe,
      source: _detectSource(json),
      imageEntryName: imageEntry?.name || null,
      thumbEntryName: thumbEntry?.name || null,
    });
  }

  if (out.length === 0) {
    const total = jsonEntries.length;
    const sample = skipped.slice(0, 5).map(s => `  • ${s.path} — ${s.reason}`).join('\n');
    if (total === 0) {
      throw new Error('No JSON files found in this zip. Mealie / Tandoor / Paprika backups should contain per-recipe JSON files.');
    }
    throw new Error(
      `No recognisable recipes found in this zip. Walked ${total} JSON file${total === 1 ? '' : 's'}; none matched a known shape.` +
      (sample ? `\nFirst few:\n${sample}` : '')
    );
  }

  // Stitch timeline events onto the matching recipes. Mealie's
  // backup columns are snake_case but older / non-household variants
  // emit `recipeId` — accept either to stay tolerant of future
  // format drift.
  if (timelineEvents.length) {
    const byMealieId = new Map();
    for (const item of out) {
      if (item._mealieId) byMealieId.set(item._mealieId, item);
    }
    for (const ev of timelineEvents) {
      const rid = ev.recipe_id ?? ev.recipeId ?? null;
      if (!rid) continue;
      const item = byMealieId.get(rid);
      if (!item) continue;
      item.timelineEvents = item.timelineEvents || [];
      item.timelineEvents.push(ev);
    }
  }
  return out;
}

// ── JSON dispatchers ─────────────────────────────────────────────────

function _importFromJson(parsed) {
  const looksMealie = parsed && (
    parsed.recipe_ingredient || parsed.recipeIngredient ||
    parsed.recipe_instructions || parsed.recipeInstructions ||
    parsed.recipe_yield || parsed.recipeYield
  );
  if (looksMealie && parsed.name) {
    try { return _importMealie(parsed); } catch {}
  }
  if (parsed && Array.isArray(parsed.steps) && parsed.steps[0] && Array.isArray(parsed.steps[0].ingredients)) {
    return _importTandoor(parsed);
  }
  if (parsed && (parsed['@type'] === 'Recipe' || parsed.recipeIngredient)) {
    const r = normaliseSchemaOrgRecipe(parsed, null);
    if (r) return r;
  }
  if (parsed && parsed.name && (parsed.ingredients || parsed.steps)) {
    return _importCookTrace(parsed);
  }
  if (parsed && parsed.name && (
    Array.isArray(parsed.ingredients) ||
    typeof parsed.ingredients === 'string' ||
    Array.isArray(parsed.directions) ||
    typeof parsed.directions === 'string'
  )) {
    return _importPermissive(parsed);
  }
  throw new Error('Unrecognised JSON format. Supported: schema.org/Recipe, Mealie export, Tandoor export, CookTrace export.');
}

function _importPermissive(r) {
  const ingLines = Array.isArray(r.ingredients) ? r.ingredients :
                   typeof r.ingredients === 'string' ? r.ingredients.split(/\r?\n/) : [];
  const stepLines = Array.isArray(r.directions || r.instructions) ? (r.directions || r.instructions) :
                    typeof (r.directions || r.instructions) === 'string' ? (r.directions || r.instructions).split(/\n{2,}/) : [];
  const items = ingLines
    .map(s => typeof s === 'string' ? parseIngredientLine(s.trim()) : (s?.name ? { qty: s.qty || '', unit: s.unit || '', name: s.name, note: s.note || '' } : null))
    .filter(x => x && x.name);
  const steps = stepLines
    .map(s => typeof s === 'string' ? { title: '', text: s.trim() } : (s?.text ? { title: s.title || '', text: s.text } : null))
    .filter(x => x && x.text);
  return {
    name: String(r.name).trim(),
    description: r.description || null,
    imgUrl: r.image_url || r.imgUrl || r.image || r.photo_url || null,
    servings: _parseServings(r.servings || r.recipe_yield || r.yield),
    yield_text: r.recipe_yield || r.yield || (r.servings != null ? String(r.servings) : null),
    prep_minutes:  _parseMinutes(r.prep_time  || r.prepTime),
    cook_minutes:  _parseMinutes(r.cook_time  || r.cookTime),
    rest_minutes:  _parseMinutes(r.rest_time  || r.restTime),
    total_minutes: _parseMinutes(r.total_time || r.totalTime),
    ingredients: items.length ? [{ name: '', items }] : [],
    steps,
    tags: Array.isArray(r.tags) ? r.tags.map(t => typeof t === 'string' ? t : t?.name || '').filter(Boolean).slice(0, 12) : [],
    tools: [],
    nutrition: r.nutrition && typeof r.nutrition === 'object' ? r.nutrition : {},
    source_url: r.source_url || r.source || r.url || null,
    notes: r.notes || null,
    category_name: null,
  };
}

function _importMealie(r) {
  const ingredients = (r.recipe_ingredient || r.recipeIngredient || []).map(rec => {
    if (typeof rec === 'string') return parseIngredientLine(rec);
    const qty = rec.quantity != null ? String(rec.quantity) : '';
    const unit = rec.unit?.abbreviation || rec.unit?.name || '';
    const name = rec.food?.name || rec.note || rec.display || rec.original_text || '';
    return {
      qty, unit,
      name: String(name).trim(),
      note: rec.note && rec.note !== name ? String(rec.note).trim() : '',
    };
  }).filter(i => i.name);

  const steps = (r.recipe_instructions || r.recipeInstructions || []).map(s => {
    if (typeof s === 'string') return { title: '', text: s.trim() };
    return { title: s.title || '', text: (s.text || '').trim() };
  }).filter(s => s.text);

  const cats = (r.recipe_category || r.recipeCategory || [])
    .map(t => typeof t === 'string' ? t : (t?.name || ''))
    .filter(Boolean);
  const categoryName = cats[0] || null;
  const tags = [].concat(r.tags || [], cats.slice(1))
    .map(t => typeof t === 'string' ? t : (t?.name || ''))
    .filter(Boolean);

  return {
    name: r.name || 'Imported recipe',
    description: r.description || null,
    imgUrl: r.image_url || r.imgUrl || null,
    servings: _parseServings(r.recipe_yield || r.recipeYield),
    yield_text: r.recipe_yield || r.recipeYield || null,
    prep_minutes:  _parseMinutes(r.prep_time  || r.prepTime),
    cook_minutes:  _parseMinutes(r.cook_time  || r.cookTime || r.perform_time),
    rest_minutes:  _parseMinutes(r.rest_time  || r.restTime),
    total_minutes: _parseMinutes(r.total_time || r.totalTime),
    ingredients: ingredients.length ? [{ name: '', items: ingredients }] : [],
    steps,
    tags: tags.slice(0, 12),
    tools: (r.tools || []).map(t => typeof t === 'string' ? t : t?.name || '').filter(Boolean),
    nutrition: _mealieNutrition(r.nutrition || {}),
    source_url: r.org_url || null,
    notes: r.notes ? (Array.isArray(r.notes) ? r.notes.map(n => n.text || n).join('\n\n') : String(r.notes)) : null,
    category_name: categoryName,
    // Preserve Mealie's original recipe creation date.
    imported_created_at: _parseImportedCreatedAt(r.date_added || r.dateAdded || r.created_at || r.createdAt),
  };
}

function _mealieNutrition(n) {
  const out = {};
  const map = {
    calories: 'calories',
    fatContent: 'fat',
    saturatedFatContent: 'saturated-fat',
    carbohydrateContent: 'carbohydrates',
    fiberContent: 'fiber',
    sugarContent: 'sugars',
    proteinContent: 'proteins',
    sodiumContent: 'sodium',
    cholesterolContent: 'cholesterol',
  };
  for (const [from, to] of Object.entries(map)) {
    const v = _parseNumber(n[from]);
    if (v != null) out[to] = v;
  }
  return out;
}

function _importTandoor(r) {
  const groups = [];
  for (const step of (r.steps || [])) {
    const items = (step.ingredients || []).map(rec => ({
      qty: rec.amount != null ? String(rec.amount) : '',
      unit: rec.unit?.name || '',
      name: rec.food?.name || rec.original_text || '',
      note: rec.note || '',
    })).filter(i => i.name);
    if (items.length) groups.push({ name: step.name || '', items });
  }
  const ingredients = groups.length === 1 && !groups[0].name
    ? [{ name: '', items: groups[0].items }]
    : groups;

  const steps = (r.steps || []).map(s => ({
    title: s.name || '',
    text: (s.instruction || '').trim(),
  })).filter(s => s.text);

  return {
    name: r.name || 'Imported recipe',
    description: r.description || null,
    imgUrl: r.image || null,
    servings: r.servings != null ? Number(r.servings) : null,
    yield_text: r.servings_text || (r.servings != null ? String(r.servings) : null),
    // Tandoor treats working_time as active time and waiting_time as
    // hands-off (dough rise, marinate, oven-cook while you step
    // away). Map working→prep and waiting→rest so the concepts
    // align; cook_minutes stays null (Tandoor doesn't distinguish
    // active cook from prep). No distinct total in Tandoor — auto-
    // calc rolls prep + rest correctly.
    prep_minutes:  r.working_time != null ? Number(r.working_time) : null,
    cook_minutes:  null,
    rest_minutes:  r.waiting_time != null ? Number(r.waiting_time) : null,
    total_minutes: null,
    ingredients,
    steps,
    tags: (r.keywords || []).map(k => k?.name || k).filter(Boolean).slice(0, 12),
    tools: [],
    nutrition: r.nutrition || {},
    source_url: r.source_url || null,
    notes: null,
    category_name: null,
  };
}

function _importCookTrace(r) {
  return {
    name: r.name || 'Imported recipe',
    description: r.description ?? null,
    imgUrl: r.imgUrl || r.img_url || null,
    servings: r.servings ?? null,
    yield_text: r.yield_text ?? null,
    prep_minutes:  r.prep_minutes  ?? null,
    cook_minutes:  r.cook_minutes  ?? null,
    rest_minutes:  r.rest_minutes  ?? null,
    total_minutes: r.total_minutes ?? null,
    ingredients: Array.isArray(r.ingredients) ? r.ingredients : [],
    steps: Array.isArray(r.steps) ? r.steps : [],
    tags: Array.isArray(r.tags) ? r.tags : [],
    tools: Array.isArray(r.tools) ? r.tools : [],
    nutrition: r.nutrition && typeof r.nutrition === 'object' ? r.nutrition : {},
    source_url: r.source_url ?? null,
    notes: r.notes ?? null,
    category_name: typeof r.category_name === 'string' ? r.category_name : null,
    video_url: typeof r.video_url === 'string' ? r.video_url : null,
  };
}

function _importPaprika(r) {
  const items = (r.ingredients || '').split(/\r?\n/)
    .map(s => parseIngredientLine(s.trim()))
    .filter(i => i.name);
  const steps = (r.directions || '').split(/\n{2,}/)
    .map(s => ({ title: '', text: s.trim() }))
    .filter(s => s.text);
  const paprikaCats = (r.categories || []).filter(Boolean);
  const categoryName = paprikaCats[0] || null;
  return {
    name: r.name || 'Imported recipe',
    description: r.description || null,
    imgUrl: r.photo_url || (r.photo ? `data:image/jpeg;base64,${r.photo}` : null),
    servings: _parseServings(r.servings),
    yield_text: r.servings || null,
    prep_minutes:  _parseMinutes(r.prep_time),
    cook_minutes:  _parseMinutes(r.cook_time),
    rest_minutes:  _parseMinutes(r.rest_time),
    total_minutes: _parseMinutes(r.total_time),
    ingredients: items.length ? [{ name: '', items }] : [],
    steps,
    tags: paprikaCats.slice(1, 13),
    tools: [],
    nutrition: {},
    source_url: r.source_url || r.source || null,
    notes: r.notes || null,
    category_name: categoryName,
    // Paprika stores recipe creation timestamp in `created`; older
    // exports used `dateAdded`. Pulling this lets the save flow
    // backdate recipe.created_at instead of using "today".
    imported_created_at: _parseImportedCreatedAt(r.created || r.dateAdded),
  };
}

// ── Mealie full-backup database.json expander ────────────────────────

function _expandMealieDatabaseDump(zip, db) {
  const tagById       = new Map((db.tags || []).map(t => [t.id, t]));
  const toolById      = new Map((db.tools || []).map(t => [t.id, t]));
  const catById       = new Map((db.categories || []).map(c => [c.id, c]));
  const foodById      = new Map((db.ingredient_foods || []).map(f => [f.id, f]));
  const unitById      = new Map((db.ingredient_units || []).map(u => [u.id, u]));

  const ingByRecipe   = _groupBy(db.recipes_ingredients || [],  'recipe_id');
  const instByRecipe  = _groupBy(db.recipe_instructions || [], 'recipe_id');
  const nutrByRecipe  = _groupBy(db.recipe_nutrition || [],    'recipe_id');
  const notesByRecipe = _groupBy(db.notes || [],               'recipe_id');
  const tagLinksByRecipe  = _groupBy(db.recipes_to_tags || [],       'recipe_id');
  const toolLinksByRecipe = _groupBy(db.recipes_to_tools || [],      'recipe_id');
  const catLinksByRecipe  = _groupBy(db.recipes_to_categories || [], 'recipe_id');

  const out = [];
  for (const r of db.recipes || []) {
    if (!r?.name) continue;

    const ingredientRows = (ingByRecipe.get(r.id) || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
    const items = [];
    for (const row of ingredientRows) {
      const food = row.food_id ? foodById.get(row.food_id) : null;
      const unit = row.unit_id ? unitById.get(row.unit_id) : null;
      if (food?.name) {
        items.push({
          qty:  row.quantity != null && row.quantity !== 0 ? String(row.quantity) : '',
          unit: unit?.abbreviation || unit?.name || '',
          name: food.name,
          note: row.note && row.note !== food.name ? row.note : '',
        });
      } else if (row.note) {
        items.push(parseIngredientLine(row.note));
      }
    }

    const instRows = (instByRecipe.get(r.id) || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
    const steps = instRows
      .map(s => ({ title: s.summary || s.title || '', text: (s.text || '').trim() }))
      .filter(s => s.text);

    const n = (nutrByRecipe.get(r.id) || [])[0];
    const nutrition = n ? {
      calories:        _num(n.calories),
      fat:             _num(n.fat_content),
      'saturated-fat': _num(n.saturated_fat_content),
      'trans-fat':     _num(n.trans_fat_content),
      carbohydrates:   _num(n.carbohydrate_content),
      fiber:           _num(n.fiber_content),
      sugars:          _num(n.sugar_content),
      proteins:        _num(n.protein_content),
      sodium:          _num(n.sodium_content),
      cholesterol:     _num(n.cholesterol_content),
    } : {};
    for (const k of Object.keys(nutrition)) if (nutrition[k] == null) delete nutrition[k];

    const tagNames  = (tagLinksByRecipe.get(r.id)  || []).map(l => tagById.get(l.tag_id)?.name).filter(Boolean);
    const toolNames = (toolLinksByRecipe.get(r.id) || []).map(l => toolById.get(l.tool_id)?.name).filter(Boolean);
    const catNames  = (catLinksByRecipe.get(r.id)  || []).map(l => catById.get(l.category_id)?.name).filter(Boolean);

    const noteRows = notesByRecipe.get(r.id) || [];
    const notes = noteRows.map(nt => (nt.title ? `${nt.title}\n` : '') + (nt.text || '')).filter(Boolean).join('\n\n') || null;

    const hyphenatedId = _hyphenateUuid(r.id);
    const imageDir = `data/recipes/${hyphenatedId}/images`;
    const imagePath = `${imageDir}/original.webp`;
    const imageEntryName = zip.file(imagePath) ? imagePath : null;
    const thumbEntryName =
      (zip.file(`${imageDir}/tiny-original.webp`) ? `${imageDir}/tiny-original.webp` : null) ||
      (zip.file(`${imageDir}/min-original.webp`)  ? `${imageDir}/min-original.webp`  : null) ||
      imageEntryName;

    const recipe = {
      name:         String(r.name).trim(),
      description:  r.description || null,
      imgUrl:       null,
      servings:     r.recipe_servings != null ? Math.round(r.recipe_servings) : (r.recipe_yield_quantity != null ? Math.round(r.recipe_yield_quantity) : null),
      yield_text:   r.recipe_yield || null,
      prep_minutes:  _parseMinutes(r.prep_time),
      cook_minutes:  _parseMinutes(r.cook_time || r.perform_time),
      rest_minutes:  _parseMinutes(r.rest_time),
      total_minutes: _parseMinutes(r.total_time),
      ingredients:  items.length ? [{ name: '', items }] : [],
      steps,
      tags:         tagNames.slice(0, 12),
      tools:        toolNames,
      nutrition,
      source_url:   r.org_url || null,
      notes,
      category_name: catNames[0] || null,
      // Backdate target. The "Recipe Created" timeline scan elsewhere
      // catches most cases, but fall back to the recipe row's own
      // created_at/date_added in case the event isn't present.
      imported_created_at: _parseImportedCreatedAt(r.created_at || r.date_added),
    };
    if (catNames.length > 1) recipe.tags = [...recipe.tags, ...catNames.slice(1)].slice(0, 16);

    // Stamp Mealie's recipe_id so scanLoadedZip can stitch timeline
    // events back onto this entry. _mealieRecipeUuid is the hyphenated
    // form used to address per-event photos inside the zip.
    out.push({ recipe, source: 'mealie-backup', imageEntryName, thumbEntryName, _mealieId: r.id, _mealieRecipeUuid: hyphenatedId });
  }
  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────

function _findSiblingImage(zip, dir) {
  const exts = /\.(jpe?g|png|webp|gif)$/i;
  const mealiePath = Object.values(zip.files).find(e =>
    !e.dir && e.name.startsWith(dir + 'images/') && /\boriginal\./i.test(e.name) && exts.test(e.name)
  );
  if (mealiePath) return mealiePath;
  return Object.values(zip.files).find(e =>
    !e.dir && e.name.startsWith(dir) && exts.test(e.name)
  ) || null;
}

function _findSiblingThumbnail(zip, dir) {
  const exts = /\.(jpe?g|png|webp|gif)$/i;
  const subtree = Object.values(zip.files).filter(e =>
    !e.dir && e.name.startsWith(dir) && exts.test(e.name)
  );
  return (
    subtree.find(e => /\btiny[-_]/i.test(e.name)) ||
    subtree.find(e => /\bmin[-_]/i.test(e.name)) ||
    subtree.find(e => /thumb/i.test(e.name)) ||
    null
  );
}

function _detectSource(json) {
  if (!json) return 'unknown';
  if (json.recipe_ingredient || json.recipe_instructions) return 'mealie';
  if (Array.isArray(json.steps) && json.steps[0]?.ingredients) return 'tandoor';
  if (json['@type'] === 'Recipe' || json.recipeIngredient) return 'schema.org';
  if (json.name && (json.ingredients || json.steps)) return 'cooktrace';
  return 'unknown';
}

function _groupBy(rows, key) {
  const m = new Map();
  for (const row of rows) {
    const k = row?.[key];
    if (k == null) continue;
    let arr = m.get(k);
    if (!arr) { arr = []; m.set(k, arr); }
    arr.push(row);
  }
  return m;
}
function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// Candidate in-zip paths for a Mealie timeline-event photo. Mirrors
// the server helper of the same name. Mealie stores cook-event images
// at data/recipes/<recipe-uuid>/images/timeline/<event-uuid>/<size>.webp.
export function mealieEventImagePaths(recipeUuid, eventId) {
  if (!recipeUuid || !eventId) return [];
  const rid = _hyphenateUuid(recipeUuid);
  const eid = _hyphenateUuid(eventId);
  const sizes = ['original.webp', 'min-original.webp', 'tiny-original.webp'];
  return sizes.map(s => `data/recipes/${rid}/images/timeline/${eid}/${s}`);
}

function _hyphenateUuid(id) {
  if (typeof id !== 'string' || id.length !== 32 || id.includes('-')) return id;
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}
// Mirror of server's parseImportedCreatedAt: normalise a foreign date
// string to SQLite-naive UTC ("YYYY-MM-DD HH:MM:SS") or null. Accepts
// ISO 8601, "YYYY-MM-DD HH:MM:SS", or bare "YYYY-MM-DD" (assumed UTC).
function _parseImportedCreatedAt(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/);
  const candidate = m ? m[0] : s;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? `${candidate}T00:00:00Z` : candidate;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function _parseServings(s) {
  if (s == null) return null;
  const m = String(s).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function _parseMinutes(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const str = String(s).trim();
  const iso = str.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (iso) return (parseInt(iso[1] || '0', 10) * 60) + parseInt(iso[2] || '0', 10);
  const m = str.match(/(\d+)\s*(h|hr|hour)/i);
  const mm = str.match(/(\d+)\s*(m|min)/i);
  if (m || mm) return (m ? parseInt(m[1], 10) * 60 : 0) + (mm ? parseInt(mm[1], 10) : 0);
  const num = str.match(/(\d+)/);
  return num ? parseInt(num[1], 10) : null;
}
function _parseNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).match(/[\d.]+/);
  return m ? Number(m[0]) : null;
}

// Browser-side gunzip via DecompressionStream — works in every
// Chromium-based WebView. Decompresses a Uint8Array, returns
// Uint8Array.
async function _gunzip(input) {
  const stream = new Response(new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip')));
  const buf = await stream.arrayBuffer();
  return new Uint8Array(buf);
}
