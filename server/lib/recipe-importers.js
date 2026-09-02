/**
 * recipe-importers.js — file / paste based recipe imports.
 *
 * Format auto-detection:
 *   1. JSON parses → look for schema.org/Recipe shape, Mealie export
 *      shape, or Tandoor export shape.
 *   2. Otherwise treat as HTML and pull schema.org/Recipe JSON-LD via
 *      the existing scraper.
 *   3. Plain-text fallback: a single recipe with the text body as steps.
 *
 * Paprika `.paprikarecipes` files are zip archives of one-or-more
 * `.paprikarecipe` files, each gzipped JSON. importPaprikaArchive()
 * unzips + ungzips + collects.
 */
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';

// Stable per-ingredient id — same shape the editor stamps client-side
// (crypto.randomUUID) so per-step refIds work end-to-end. Only used
// by importers that carry step→ingredient adjacency in the source
// (Tandoor today; more later if we add them). Fallback for hardened
// runtimes without crypto.randomUUID (should never fire on Node
// >=15 but keeps the code robust).
function _ingId() {
  try { return randomUUID(); }
  catch { return 'ing_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
}
import {
  extractRecipeFromHtml,
  normaliseSchemaOrgRecipe,
  parseIngredientLine,
} from './recipe-scraper.js';

const gunzip = promisify(zlib.gunzip);

/**
 * Import a single recipe from a string blob. Returns the normalised
 * recipe shape (same as the scrape endpoint emits) or throws.
 */
export function importRecipeFromText(text, hint = null) {
  if (!text || typeof text !== 'string') throw new Error('Empty input');
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Empty input');

  // 1. Try JSON first.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed;
    try { parsed = JSON.parse(trimmed); }
    catch (e) { throw new Error('Invalid JSON: ' + e.message); }
    return _importFromJson(parsed);
  }

  // 2. HTML — looks like one if it has <html or <script type=ld+json
  if (/<html|<script[^>]*ld\+json|<!doctype/i.test(trimmed)) {
    const r = extractRecipeFromHtml(trimmed, hint || null);
    if (!r) throw new Error('No schema.org/Recipe data found in the HTML');
    return r;
  }

  // 3. Plain text fallback — make a stub recipe with the text as a
  // single step, so the user can edit afterwards.
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

function _importFromJson(parsed) {
  // Mealie shapes are very loose across versions. Use a permissive
  // ingredient-presence check first, then defer to the importer.
  // (v1+ uses recipe_ingredient; older versions used recipeIngredient
  // or even ingredients[]; some exports omit instructions entirely.)
  const looksMealie = parsed && (
    parsed.recipe_ingredient || parsed.recipeIngredient ||
    parsed.recipe_instructions || parsed.recipeInstructions ||
    parsed.recipe_yield || parsed.recipeYield
  );
  if (looksMealie && parsed.name) {
    try { return _importMealie(parsed); } catch {}
  }
  // Tandoor export: has steps[].ingredients[] + name + working_time
  if (parsed && Array.isArray(parsed.steps) && parsed.steps[0] && Array.isArray(parsed.steps[0].ingredients)) {
    return _importTandoor(parsed);
  }
  // schema.org/Recipe — has @type or recipeIngredient
  if (parsed && (parsed['@type'] === 'Recipe' || parsed.recipeIngredient)) {
    const r = normaliseSchemaOrgRecipe(parsed, null);
    if (r) return r;
  }
  // CookTrace-shape passthrough
  if (parsed && parsed.name && (parsed.ingredients || parsed.steps)) {
    return _importCookTrace(parsed);
  }
  // Last-resort: anything with a name and SOMETHING resembling
  // ingredients (string or array) gets imported via a permissive
  // CookTrace shape so users with weird custom JSON can still get
  // recipes in. Better to import a partially-formed recipe than
  // silently drop it.
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

// Permissive fallback for unfamiliar JSON shapes that still have a
// recognisable recipe-ish skeleton (name + ingredients/directions).
// Treats string ingredients/directions as line-or-paragraph blobs and
// the array forms as plain string lists. Loses structured fields but
// preserves the recipe instead of dropping it.
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

// ── Mealie format ───────────────────────────────────────────────────────────
// https://docs.mealie.io/documentation/getting-started/api-usage/
function _importMealie(r) {
  const ingredients = (r.recipe_ingredient || r.recipeIngredient || []).map(rec => {
    if (typeof rec === 'string') return parseIngredientLine(rec);
    // Mealie ingredient: { quantity, unit: { name }, food: { name }, note, display, original_text }
    const qty = rec.quantity != null ? String(rec.quantity) : '';
    const unit = rec.unit?.abbreviation || rec.unit?.name || '';
    const name = rec.food?.name || rec.note || rec.display || rec.original_text || '';
    return {
      qty,
      unit,
      name: String(name).trim(),
      note: rec.note && rec.note !== name ? String(rec.note).trim() : '',
    };
  }).filter(i => i.name);

  const steps = (r.recipe_instructions || r.recipeInstructions || []).map(s => {
    if (typeof s === 'string') return { title: '', text: s.trim() };
    return { title: s.title || '', text: (s.text || '').trim() };
  }).filter(s => s.text);

  // Mealie has explicit categories (recipe_category) and tags. Lift the
  // first category into our single-category slot, keep the rest in tags
  // alongside Mealie's `tags` field so nothing is lost on import.
  const cats = (r.recipe_category || r.recipeCategory || [])
    .map(t => typeof t === 'string' ? t : (t?.name || ''))
    .filter(Boolean);
  const categoryName = cats[0] || null;
  const tags = []
    .concat(r.tags || [], cats.slice(1))
    .map(t => typeof t === 'string' ? t : (t?.name || ''))
    .filter(Boolean);

  return {
    name: r.name || 'Imported recipe',
    description: r.description || null,
    imgUrl: r.image_url || r.imgUrl || null,
    servings: _parseServings(r.recipe_yield || r.recipeYield),
    yield_text: r.recipe_yield || r.recipeYield || null,
    prep_minutes: _parseMinutes(r.prep_time || r.prepTime),
    cook_minutes: _parseMinutes(r.cook_time || r.cookTime || r.perform_time),
    ingredients: ingredients.length ? [{ name: '', items: ingredients }] : [],
    steps,
    tags: tags.slice(0, 12),
    tools: (r.tools || []).map(t => typeof t === 'string' ? t : t?.name || '').filter(Boolean),
    nutrition: _mealieNutrition(r.nutrition || {}),
    source_url: r.org_url || null,
    notes: r.notes ? (Array.isArray(r.notes) ? r.notes.map(n => n.text || n).join('\n\n') : String(r.notes)) : null,
    category_name: categoryName,
    // Mealie's recipe JSON carries created_at / date_added. Stash so
    // _saveImportedRecipe can backdate recipe.created_at to match the
    // original creation rather than the import moment.
    imported_created_at: parseImportedCreatedAt(r.date_added || r.dateAdded || r.created_at || r.createdAt),
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

// ── Tandoor format ──────────────────────────────────────────────────────────
function _importTandoor(r) {
  const groups = [];
  // source-step reference → array of ingredient ids created from it.
  // Used a WeakMap so the mapping doesn't outlive the source object.
  // Populated in the same loop that builds ingredient groups; consumed
  // when we build the steps array below so the CT step gains a refIds
  // pointing at the ingredients its source step listed. Preserves the
  // step→ingredient adjacency Tandoor carries in its export (issue
  // #40's whole point on the import side).
  const refsByStep = new WeakMap();
  for (const step of (r.steps || [])) {
    const items = (step.ingredients || []).map(rec => ({
      id: _ingId(),
      qty: rec.amount != null ? String(rec.amount) : '',
      unit: rec.unit?.name || '',
      name: rec.food?.name || rec.original_text || '',
      note: rec.note || '',
    })).filter(i => i.name);
    if (items.length) {
      groups.push({ name: step.name || '', items });
      refsByStep.set(step, items.map(i => i.id));
    }
  }
  // If only a single unnamed group, flatten
  const ingredients = groups.length === 1 && !groups[0].name
    ? [{ name: '', items: groups[0].items }]
    : groups;

  const steps = (r.steps || []).map(s => {
    const built = {
      title: s.name || '',
      text: (s.instruction || '').trim(),
    };
    const refIds = refsByStep.get(s);
    if (refIds && refIds.length > 0) built.refIds = refIds;
    return built;
  }).filter(s => s.text);

  return {
    name: r.name || 'Imported recipe',
    description: r.description || null,
    imgUrl: r.image || null,
    servings: r.servings != null ? Number(r.servings) : null,
    yield_text: r.servings_text || (r.servings != null ? String(r.servings) : null),
    prep_minutes: r.working_time != null ? Number(r.working_time) : null,
    cook_minutes: r.waiting_time != null ? Number(r.waiting_time) : null,
    ingredients,
    steps,
    tags: (r.keywords || []).map(k => k?.name || k).filter(Boolean).slice(0, 12),
    tools: [],
    nutrition: r.nutrition || {},
    source_url: r.source_url || null,
    notes: null,
    // Tandoor doesn't have first-class categories — it uses keywords
    // for both tags AND categorization. Those keywords already flow
    // into the tags array above, so promoting one to the category
    // slot would be guesswork. Left null intentionally; users can
    // tag a recipe in CookTrace post-import if they want.
    category_name: null,
  };
}

// ── CookTrace passthrough ──────────────────────────────────────────────────
function _importCookTrace(r) {
  return {
    name: r.name || 'Imported recipe',
    description: r.description ?? null,
    imgUrl: r.imgUrl || r.img_url || null,
    servings: r.servings ?? null,
    yield_text: r.yield_text ?? null,
    prep_minutes: r.prep_minutes ?? null,
    cook_minutes: r.cook_minutes ?? null,
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

// ── Paprika archive ────────────────────────────────────────────────────────
// .paprikarecipes is a zip containing one or more .paprikarecipe files,
// each of which is a gzipped JSON. Returns an array of normalised
// recipes — caller writes each as a row.
export async function importPaprikaArchive(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const recipes = [];
  const entries = Object.values(zip.files).filter(e => !e.dir && e.name.endsWith('.paprikarecipe'));
  if (entries.length === 0) throw new Error('No .paprikarecipe files found in archive');
  for (const entry of entries) {
    const compressed = await entry.async('nodebuffer');
    let json;
    try {
      const decompressed = await gunzip(compressed);
      json = JSON.parse(decompressed.toString('utf-8'));
    } catch (e) {
      // Some Paprika exports embed plain JSON instead of gzipped — try that.
      try { json = JSON.parse(compressed.toString('utf-8')); }
      catch { throw new Error(`Could not decode ${entry.name}`); }
    }
    recipes.push(_importPaprika(json));
  }
  return recipes;
}

// ── Generic zip walker ─────────────────────────────────────────────────────
// Handles three flavors of recipe-archive in one pass:
//   1. Paprika .paprikarecipes (zip of gzipped .paprikarecipe JSONs)
//   2. Mealie backup zip — `data/recipes/<slug>/recipe.json` per recipe
//      with optional image at `data/recipes/<slug>/images/original.<ext>`
//   3. Tandoor / generic — any *.json at any depth that matches one of
//      our existing recipe-shape detectors (schema.org / Mealie /
//      Tandoor / CookTrace), with a heuristic image-pair lookup.
//
// Returns:
//   [{ recipe, source, imageEntryName }]
// where `imageEntryName` is the path inside the zip the caller can use
// to extract the image bytes during commit. Caller is responsible for
// the actual image extraction + upload — keeping the walker pure JSON
// makes the scan call cheap and avoids materializing image bytes
// during the manifest step.
//
// scanRecipeZip(buffer) is the simple public entry point. For bulk
// imports where the same zip needs to be re-read many times (image
// extraction during commit), use loadRecipeZip(buffer) once + reuse
// the loaded JSZip instance across calls — see scanLoadedZip and
// readImageFromLoadedZip below. Avoids re-parsing the zip for every
// image, which on a 500 MB Mealie backup with 100 recipes was 100x
// the necessary work.
export async function loadRecipeZip(buffer) {
  return JSZip.loadAsync(buffer);
}
export async function readImageFromLoadedZip(zip, entryName) {
  if (!entryName) return null;
  try {
    const entry = zip.file(entryName);
    if (!entry) return null;
    const bytes = await entry.async('nodebuffer');
    const ext = (entryName.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || 'jpg';
    return { bytes, ext };
  } catch {
    return null;
  }
}
export async function scanRecipeZip(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  return scanLoadedZip(zip);
}
export async function scanLoadedZip(zip) {
  const out = [];

  // Paprika first — distinct extension makes this an unambiguous match.
  const paprikaEntries = Object.values(zip.files).filter(e => !e.dir && e.name.endsWith('.paprikarecipe'));
  if (paprikaEntries.length > 0) {
    for (const entry of paprikaEntries) {
      const compressed = await entry.async('nodebuffer');
      let json;
      try {
        const decompressed = await gunzip(compressed);
        json = JSON.parse(decompressed.toString('utf-8'));
      } catch {
        try { json = JSON.parse(compressed.toString('utf-8')); }
        catch { continue; }
      }
      const recipe = _importPaprika(json);
      out.push({ recipe, source: 'paprika', imageEntryName: null, thumbEntryName: null });
    }
    return out;
  }

  // Otherwise walk every JSON file in the zip and try the format
  // detectors. Skip `database.db` (Mealie / Tandoor SQLite dumps) — we
  // only read per-recipe JSON.
  const jsonEntries = Object.values(zip.files).filter(e =>
    !e.dir && /\.json$/i.test(e.name) && !/(^|\/)package(-lock)?\.json$/i.test(e.name)
  );

  // Track non-recipe JSONs we walked past so the "no recipes found"
  // error can surface diagnostic info instead of a dead-end string.
  const skipped = [];

  // Mealie timeline events live in the same database.json as the
  // recipes — collected here, stitched onto matching recipes below.
  const timelineEvents = [];

  for (const entry of jsonEntries) {
    let json;
    try {
      const text = await entry.async('text');
      json = JSON.parse(text);
    } catch (e) {
      skipped.push({ path: entry.name, reason: 'invalid JSON' });
      continue;
    }

    // Mealie full-backup `database.json` — relational dump where
    // recipes live in one table and ingredients/instructions/tags/
    // tools/categories/nutrition all live in their own tables joined
    // by recipe_id. Detect via the recipes + recipes_ingredients +
    // recipe_instructions trio (any of those alone could be a coincidence;
    // all three is unambiguously Mealie's backup shape) and expand
    // each recipe row into its own manifest entry.
    if (Array.isArray(json?.recipes) && Array.isArray(json?.recipes_ingredients) && Array.isArray(json?.recipe_instructions)) {
      const expanded = _expandMealieDatabaseDump(zip, json);
      for (const e of expanded) out.push(e);
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

    // Look for a sibling image. Mealie's layout:
    //   data/recipes/<slug>/recipe.json
    //   data/recipes/<slug>/images/original.webp
    // Tandoor and generic exports vary, so we fall back to "any image
    // in the same directory."
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
    // Build a diagnostic so users (and we) can see WHY nothing
    // matched. Most useful tells: were there ANY JSONs in the zip,
    // and what shape were they? Show the first 5 paths + reasons.
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

  // Stitch Mealie timeline events to their matching recipe entry by
  // Mealie recipe_id. Tolerate both recipe_id (current snake_case
  // shape) and recipeId (older camelCase variants).
  if (timelineEvents.length) {
    const byId = new Map();
    for (const item of out) {
      if (item._mealieId) byId.set(item._mealieId, item);
    }
    for (const ev of timelineEvents) {
      const rid = ev.recipe_id ?? ev.recipeId ?? null;
      if (!rid) continue;
      const item = byId.get(rid);
      if (!item) continue;
      item.timelineEvents = item.timelineEvents || [];
      item.timelineEvents.push(ev);
    }
  }
  return out;
}

// ── Mealie full-backup database.json expander ─────────────────────────────
// Mealie stores its backup as a relational JSON dump (one array per
// table). To turn each recipe row into a CookTrace-shaped recipe we
// have to JOIN: recipes_ingredients (with ingredient_foods + ingredient_units),
// recipe_instructions, recipe_nutrition, recipes_to_tags + tags,
// recipes_to_tools + tools, recipes_to_categories + categories, and notes.
// All joined keys are stored as un-hyphenated UUIDs in the JSON; the
// filesystem image path uses the hyphenated form, so we convert when
// resolving image entries.
function _expandMealieDatabaseDump(zip, db) {
  // Build lookup maps once. Indexed by the column we need to join on.
  const tagById       = new Map((db.tags || []).map(t => [t.id, t]));
  const toolById      = new Map((db.tools || []).map(t => [t.id, t]));
  const catById       = new Map((db.categories || []).map(c => [c.id, c]));
  const foodById      = new Map((db.ingredient_foods || []).map(f => [f.id, f]));
  const unitById      = new Map((db.ingredient_units || []).map(u => [u.id, u]));

  // Group child rows by recipe_id so each recipe lookup is O(1) +
  // already sorted. Bigger backups (this one has 1237 ingredients)
  // would otherwise scan the full list per recipe.
  const ingByRecipe   = _groupBy(db.recipes_ingredients || [],  'recipe_id');
  const instByRecipe  = _groupBy(db.recipe_instructions || [], 'recipe_id');
  const nutrByRecipe  = _groupBy(db.recipe_nutrition || [],    'recipe_id'); // 1:1 in practice
  const notesByRecipe = _groupBy(db.notes || [],               'recipe_id');
  const tagLinksByRecipe  = _groupBy(db.recipes_to_tags || [],       'recipe_id');
  const toolLinksByRecipe = _groupBy(db.recipes_to_tools || [],      'recipe_id');
  const catLinksByRecipe  = _groupBy(db.recipes_to_categories || [], 'recipe_id');

  const out = [];
  for (const r of db.recipes || []) {
    if (!r?.name) continue;

    // Ingredients — sort by position. Mealie stores either a parsed
    // {quantity, unit_id, food_id, note} OR a free-text `note` line.
    // We pass the parsed form when both food + unit are linked, the
    // raw note when it's a string-only entry.
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
        // Free-text ingredient line — push through our parser so the
        // qty/unit/name split is reasonable.
        items.push(parseIngredientLine(row.note));
      }
    }

    // Steps — sort by position.
    const instRows = (instByRecipe.get(r.id) || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
    const steps = instRows
      .map(s => ({ title: s.summary || s.title || '', text: (s.text || '').trim() }))
      .filter(s => s.text);

    // Nutrition — Mealie stores 1:1 but as strings; coerce numbers and
    // map to our nutriment ids.
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
    // Drop null entries (we only want fields the source actually had).
    for (const k of Object.keys(nutrition)) if (nutrition[k] == null) delete nutrition[k];

    // Tags / tools / categories — flatten link tables to names.
    const tagNames  = (tagLinksByRecipe.get(r.id)  || []).map(l => tagById.get(l.tag_id)?.name).filter(Boolean);
    const toolNames = (toolLinksByRecipe.get(r.id) || []).map(l => toolById.get(l.tool_id)?.name).filter(Boolean);
    const catNames  = (catLinksByRecipe.get(r.id)  || []).map(l => catById.get(l.category_id)?.name).filter(Boolean);

    // Notes — concatenate all per-recipe notes into one string.
    const noteRows = notesByRecipe.get(r.id) || [];
    const notes = noteRows.map(nt => (nt.title ? `${nt.title}\n` : '') + (nt.text || '')).filter(Boolean).join('\n\n') || null;

    // Image: stored at data/recipes/<hyphenated-id>/images/original.webp
    // when the recipe has an actual image. Mealie's image column is
    // either null, the literal string "no image", or a short hash —
    // none of which correspond to a filesystem path. We just probe
    // for the standard original.webp regardless.
    //
    // Mealie also ships a `tiny-original.webp` (~4 KB) and
    // `min-original.webp` alongside the full-size original. Surface
    // the smallest variant separately so the scan endpoint can inline
    // it as a base64 thumbnail without inflating the response with the
    // full-size webps.
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
      imgUrl:       null, // populated by image-extract step
      servings:     r.recipe_servings != null ? Math.round(r.recipe_servings) : (r.recipe_yield_quantity != null ? Math.round(r.recipe_yield_quantity) : null),
      yield_text:   r.recipe_yield || null,
      prep_minutes: _parseMinutes(r.prep_time),
      cook_minutes: _parseMinutes(r.cook_time || r.perform_time),
      ingredients:  items.length ? [{ name: '', items }] : [],
      steps,
      tags:         tagNames.slice(0, 12),
      tools:        toolNames,
      nutrition,
      source_url:   r.org_url || null,
      notes,
      // First category becomes our single category slot; remaining
      // ones spill into tags so nothing is lost.
      category_name: catNames[0] || null,
      // Backdate target. The Mealie timeline scan elsewhere already
      // catches a "Recipe Created" event, but not every Mealie install
      // has that event for every recipe — fall back to the recipe row's
      // own created_at / date_added.
      imported_created_at: parseImportedCreatedAt(r.created_at || r.date_added),
    };
    if (catNames.length > 1) recipe.tags = [...recipe.tags, ...catNames.slice(1)].slice(0, 16);

    // _mealieId stamp lets scanLoadedZip stitch recipe_timeline_events
    // back onto this manifest entry after the full walk completes.
    // _mealieRecipeUuid is the hyphenated form used to address per-event
    // photos inside the zip at data/recipes/<uuid>/images/timeline/...
    out.push({ recipe, source: 'mealie-backup', imageEntryName, thumbEntryName, _mealieId: r.id, _mealieRecipeUuid: hyphenatedId });
  }
  return out;
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
function _hyphenateUuid(id) {
  if (typeof id !== 'string' || id.length !== 32 || id.includes('-')) return id;
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

// Candidate in-zip paths for a Mealie timeline-event photo. Mealie
// stores cook-event images at
//   data/recipes/<recipe-uuid>/images/timeline/<event-uuid>/<size>.webp
// where size is original / min-original / tiny-original. Try the
// full-size first, falling back to the smaller variants on a miss.
export function mealieEventImagePaths(recipeUuid, eventId) {
  if (!recipeUuid || !eventId) return [];
  const rid = _hyphenateUuid(recipeUuid);
  const eid = _hyphenateUuid(eventId);
  const sizes = ['original.webp', 'min-original.webp', 'tiny-original.webp'];
  return sizes.map(s => `data/recipes/${rid}/images/timeline/${eid}/${s}`);
}

// Look for an image that lives next to the recipe JSON. Prefers a
// Mealie-style `images/original.*`, falls back to the first image file
// in the same directory tree.
function _findSiblingImage(zip, dir) {
  const exts = /\.(jpe?g|png|webp|gif)$/i;
  // Mealie convention: <dir>images/original.<ext>
  const mealiePath = Object.values(zip.files).find(e =>
    !e.dir && e.name.startsWith(dir + 'images/') && /\boriginal\./i.test(e.name) && exts.test(e.name)
  );
  if (mealiePath) return mealiePath;
  // Any image in the same directory subtree.
  return Object.values(zip.files).find(e =>
    !e.dir && e.name.startsWith(dir) && exts.test(e.name)
  ) || null;
}

// Pick the smallest viable thumbnail variant in the same directory
// tree. Mealie ships `tiny-original.webp` (~4 KB) and
// `min-original.webp` alongside the full-size original; other archives
// sometimes drop a `thumb*` or `*thumb*` variant. Returning null tells
// the caller to fall back to the full-size image (or skip the thumb
// inline entirely).
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

// Read raw image bytes for a given entry name. Returns null if not
// found or unreadable. Caller pipes this into the upload flow.
export async function readZipImageBytes(buffer, entryName) {
  if (!entryName) return null;
  try {
    const zip = await JSZip.loadAsync(buffer);
    const entry = zip.file(entryName);
    if (!entry) return null;
    const bytes = await entry.async('nodebuffer');
    const ext = (entryName.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || 'jpg';
    return { bytes, ext };
  } catch {
    return null;
  }
}

function _importPaprika(r) {
  // Ingredients: newline-separated string in `ingredients` field.
  const items = (r.ingredients || '').split(/\r?\n/)
    .map(s => parseIngredientLine(s.trim()))
    .filter(i => i.name);

  // Steps: blank-line-separated paragraphs in `directions`.
  const steps = (r.directions || '').split(/\n{2,}/)
    .map(s => ({ title: '', text: s.trim() }))
    .filter(s => s.text);

  // Paprika's `categories` is an array of strings. Lift the first into
  // our category slot; remaining entries become tags.
  const paprikaCats = (r.categories || []).filter(Boolean);
  const categoryName = paprikaCats[0] || null;

  return {
    name: r.name || 'Imported recipe',
    description: r.description || null,
    imgUrl: r.photo_url || (r.photo ? `data:image/jpeg;base64,${r.photo}` : null),
    servings: _parseServings(r.servings),
    yield_text: r.servings || null,
    prep_minutes: _parseMinutes(r.prep_time),
    cook_minutes: _parseMinutes(r.cook_time),
    ingredients: items.length ? [{ name: '', items }] : [],
    steps,
    tags: paprikaCats.slice(1, 13),
    tools: [],
    nutrition: {},
    source_url: r.source_url || r.source || null,
    notes: r.notes || null,
    category_name: categoryName,
    // Paprika stores the recipe creation timestamp in `created` (or
    // older `dateAdded` for legacy exports). Pull this so the imported
    // recipe keeps its original creation date instead of "today".
    imported_created_at: parseImportedCreatedAt(r.created || r.dateAdded),
  };
}

// Normalise a foreign date string into the SQLite-naive UTC format
// ("YYYY-MM-DD HH:MM:SS") that recipes.created_at uses. Accepts:
//   • ISO 8601 ("2023-04-15T12:34:56Z" / "...+00:00")
//   • SQLite-style with space ("2023-04-15 12:34:56")
//   • date-only ("2023-04-15")  → assumes 00:00:00 UTC
// Returns null on any parse failure so callers can short-circuit.
export function parseImportedCreatedAt(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Mealie's database.json frequently has dates with trailing space-noise;
  // tolerate them by parsing whatever leading datetime is present.
  const m = s.match(/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/);
  const candidate = m ? m[0] : s;
  // Plain date → treat as UTC midnight (SQLite-naive expects no offset).
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? `${candidate}T00:00:00Z` : candidate;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function _parseServings(s) {
  if (s == null) return null;
  const m = String(s).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function _parseMinutes(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const str = String(s).trim();
  // ISO 8601 PT*H*M*S
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
