/**
 * shopping-plan.js: what a recipe or a week's plan adds to the shopping
 * list, worked out the same way on the server and in the app.
 *
 * Two identical copies: src/lib/shopping-plan.js and
 * server/lib/shopping-plan.js. A test checks they match.
 *
 * Each list row keeps where its amount came from in `sources`, a JSON list:
 *   { recipe_id, diary_id, date, servings, ref, name, qty, unit }
 * one per ingredient line of a recipe (scaled to the planned servings).
 * A planned cook's share is replaced when the same week is built again,
 * and dropped once the cook is gone; anything typed into the row by hand
 * stays. recipe_id and diary_id are ids of this side (server or phone):
 * mapSourceIds() turns them into the other side's ids during a sync.
 */
import {
  parseQty, qtyToBuy, normalizeUnit, unitFamily, convertWithinFamily,
  amountKey, sumAmounts, roundForList, ingredientKey,
} from './quantity.js';

/** The JSON a row stores, as a list (bad or empty JSON is an empty list). */
export function parseSources(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter(s => s && typeof s === 'object') : [];
  } catch { return []; }
}

/** A recipe's servings as a number, or null. */
export function recipeServings(recipe) {
  const n = parseQty(recipe?.servings);
  return n && n > 0 ? n : null;
}

/** How much to scale a recipe for this many servings (1 when either is unknown). */
export function scaleFor(recipe, servings) {
  const base = recipeServings(recipe);
  const want = Number(servings);
  if (!base || !Number.isFinite(want) || want <= 0) return 1;
  return want / base;
}

function _flatItems(ingredients) {
  let groups = ingredients;
  if (typeof groups === 'string') {
    try { groups = JSON.parse(groups); } catch { groups = []; }
  }
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const it of (g?.items || [])) if (it && it.name && String(it.name).trim()) out.push(it);
  }
  return out;
}

/**
 * What one recipe adds: one entry per ingredient line, scaled.
 *   opts.diaryId, opts.date: the planned cook it's for (none for "add recipe")
 *   opts.servings: servings to shop for (defaults to the recipe's)
 *   opts.skip(it): true for a line to leave out (in stock, say)
 */
export function recipeContributions(recipe, opts = {}) {
  const factor = scaleFor(recipe, opts.servings);
  const servings = Number(opts.servings) > 0 ? Number(opts.servings) : recipeServings(recipe);
  const out = [];
  _flatItems(recipe.ingredients).forEach((it, i) => {
    if (opts.skip && opts.skip(it)) return;
    const base = qtyToBuy(it.qty);
    const unit = normalizeUnit(it.unit) || null;
    out.push({
      recipe_id: recipe.id ?? null,
      diary_id: opts.diaryId ?? null,
      date: opts.date ?? null,
      servings: servings ?? null,
      // The line within the recipe: its id where it has one, else its place.
      ref: it.id != null ? String(it.id) : `#${i}`,
      name: String(it.name).trim(),
      qty: base == null ? null : base * factor,
      unit,
      pantry_id: it.pantry_item_id ?? null,
    });
  });
  return out;
}

const _sourceKey = s => `${s.diary_id ?? ''}|${s.recipe_id ?? ''}|${s.ref ?? ''}`;
const _rowKey = (name, unit) => `${ingredientKey(name)}|${amountKey(unit)}`;

// The part of a row's amount that didn't come from its sources: what was
// typed by hand. Null when the row has no number at all.
function _manualPart(row, sources) {
  const q = Number(row.quantity);
  if (row.quantity == null || row.quantity === '' || !Number.isFinite(q)) return null;
  let fromSources = 0;
  for (const s of sources) {
    if (s.qty == null) continue;
    const v = convertWithinFamily(s.qty, s.unit, row.unit);
    if (v == null && amountKey(s.unit) !== amountKey(row.unit)) continue;
    fromSources += v ?? s.qty;
  }
  const rest = q - fromSources;
  // Rounding leaves crumbs; anything under 2% of the row is one.
  return rest > Math.max(1e-6, Math.abs(q) * 0.02) ? rest : 0;
}

function _total(manual, unit, sources) {
  const parts = sources.map(s => ({ qty: s.qty, unit: s.unit }));
  if (manual != null && manual > 0) parts.push({ qty: manual, unit });
  const sum = sumAmounts(parts.length ? parts : [{ qty: null, unit }]);
  return { quantity: roundForList(sum.qty, sum.unit), unit: sum.unit || null };
}

function _strip(c) {
  const { pantry_id, ...s } = c; // eslint-disable-line no-unused-vars
  return s;
}

/**
 * Fold contributions into the list.
 *   rows: the account's list rows that aren't deleted, checked or not
 *         ({ id, name, quantity, unit, checked, pantry_id, recipe_id, sources })
 *   contributions: from recipeContributions()
 *   opts.window: { from, to } for a plan build; the planned cooks in it
 *         replace what they added before, and a cook no longer planned
 *         takes its share out. Without it every contribution adds.
 * Returns { inserts, updates, deletes }:
 *   inserts: { name, quantity, unit, pantry_id, recipe_id, sources (JSON) }
 *   updates: { id, quantity, unit, sources (JSON), pantry_id? }
 *   deletes: ids of rows that only held a cancelled cook's share
 * A line already on a checked-off row (bought) isn't added again.
 */
export function mergeIntoList(rows, contributions, opts = {}) {
  const win = opts.window || null;
  const inWindow = s => win && s.diary_id != null && s.date && s.date >= win.from && s.date <= win.to;

  // Lines already bought: on a checked row.
  const bought = new Set();
  for (const r of rows) if (r.checked) for (const s of parseSources(r.sources)) bought.add(_sourceKey(s));

  // Group what's coming by ingredient and unit family.
  const groups = new Map();
  for (const c of contributions) {
    if (bought.has(_sourceKey(c))) continue;
    const k = _rowKey(c.name, c.unit);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }

  const inserts = [];
  const updates = [];
  const deletes = [];
  const open = rows.filter(r => !r.checked);
  const byKey = new Map();
  for (const r of open) {
    const k = _rowKey(r.name, r.unit);
    if (!byKey.has(k)) byKey.set(k, r);
  }

  // Rows with a planned share in the window that nothing replaces: the
  // share comes out (the cook was moved, cancelled or no longer uses it).
  if (win) {
    for (const r of open) {
      const k = _rowKey(r.name, r.unit);
      if (groups.has(k) && byKey.get(k) === r) continue;
      const sources = parseSources(r.sources);
      if (!sources.some(inWindow)) continue;
      const manual = _manualPart(r, sources);
      const kept = sources.filter(s => !inWindow(s));
      if (!kept.length && !manual) { deletes.push(r.id); continue; }
      const t = _total(manual, r.unit, kept);
      updates.push({ id: r.id, quantity: t.quantity, unit: t.unit, sources: JSON.stringify(kept) });
    }
  }

  for (const [k, list] of groups) {
    const row = byKey.get(k);
    const pantryId = list.find(c => c.pantry_id != null)?.pantry_id ?? null;
    if (!row) {
      const t = _total(null, list[0].unit, list);
      inserts.push({
        name: list[0].name,
        quantity: t.quantity,
        unit: t.unit,
        pantry_id: pantryId,
        recipe_id: list[0].recipe_id ?? null,
        sources: JSON.stringify(list.map(_strip)),
      });
      continue;
    }
    const sources = parseSources(row.sources);
    const manual = _manualPart(row, sources);
    // A plan build replaces the window's shares; the same line added again
    // outside a plan adds again (cooking it twice).
    const kept = win ? sources.filter(s => !inWindow(s)) : sources;
    const next = [...kept, ...list.map(_strip)];
    const t = _total(manual, row.unit || list[0].unit, next);
    const upd = { id: row.id, quantity: t.quantity, unit: t.unit, sources: JSON.stringify(next) };
    if (row.pantry_id == null && pantryId != null) upd.pantry_id = pantryId;
    updates.push(upd);
  }

  return { inserts, updates, deletes };
}

/**
 * A row's sources with their recipe and diary ids mapped to the other
 * side's: recipe(id) and diary(id) return the id there, null when it has
 * none (the id is taken out, the line stays), or undefined when it isn't
 * known yet (the row waits for the next sync). Returns { json, unknown }.
 */
export function mapSourceIds(json, recipe, diary) {
  const list = parseSources(json);
  if (!list.length) return { json: json ?? null, unknown: false };
  let unknown = false;
  const out = list.map(s => {
    const next = { ...s };
    if (s.recipe_id != null) {
      const v = recipe(s.recipe_id);
      if (v === undefined) unknown = true;
      next.recipe_id = v ?? null;
    }
    if (s.diary_id != null) {
      const v = diary(s.diary_id);
      if (v === undefined) unknown = true;
      next.diary_id = v ?? null;
    }
    return next;
  });
  return { json: JSON.stringify(out), unknown };
}

/** Ids-only check: keep the ids an account may point at, take out the rest. */
export function cleanSourceIds(json, recipeOk, diaryOk) {
  return mapSourceIds(json, id => (recipeOk(id) ? id : null), id => (diaryOk(id) ? id : null)).json;
}

export { unitFamily };
