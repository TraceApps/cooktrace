/**
 * plan-ideas.js: what to cook to use up what's about to expire, and a
 * week of dinners picked from the recipes, the pantry and what's planned.
 *
 * Pure: the Week view and the Build My Week sheet pass in the recipes
 * (with ingredients), the pantry rows and the week's plan.
 *
 * Pantry items count by family: a generic item and its variants are one
 * thing to cook with ("Milk", "Oat Milk"). A recipe ingredient belongs to
 * a family through its pantry link, else by name (plural and case aside).
 */
import { ingredientKey } from './quantity.js';
import { fromIso, isoDay } from './week.js';

function _items(recipe) {
  let groups = recipe?.ingredients;
  if (typeof groups === 'string') { try { groups = JSON.parse(groups); } catch { groups = []; } }
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) for (const it of g?.items || []) if (it?.name) out.push(it);
  return out;
}

/** The pantry, indexed: families, what's in stock, and names to families. */
export function pantryIndex(pantry, { today, horizon } = {}) {
  const byId = new Map((pantry || []).map(p => [p.id, p]));
  const familyOf = id => { const p = byId.get(id); return p ? (p.generic_parent_id ?? p.id) : null; };
  const byKey = new Map();
  const stocked = new Set();
  const expiring = new Map(); // family -> { family, name, expires, quantity, unit }
  for (const p of pantry || []) {
    const fam = familyOf(p.id);
    const k = ingredientKey(p.name);
    if (k && !byKey.has(k)) byKey.set(k, fam);
    if (!p.in_stock) continue;
    stocked.add(fam);
    const exp = p.expires_on ? String(p.expires_on).slice(0, 10) : null;
    if (exp && (!horizon || exp <= horizon)) {
      const prev = expiring.get(fam);
      if (!prev || exp < prev.expires) {
        const top = byId.get(fam) || p;
        expiring.set(fam, { family: fam, name: top.name, expires: exp, quantity: p.quantity, unit: p.unit, daysLeft: today ? Math.round((fromIso(exp) - fromIso(today)) / 864e5) : null });
      }
    }
  }
  return { byId, familyOf, byKey, stocked, expiring };
}

/** A recipe's ingredients as families (pantry) and keys (not in the pantry). */
export function recipeNeeds(recipe, idx) {
  const families = new Set();
  const loose = new Set();
  for (const it of _items(recipe)) {
    const fam = it.pantry_item_id != null && idx.byId.has(it.pantry_item_id)
      ? idx.familyOf(it.pantry_item_id)
      : idx.byKey.get(ingredientKey(it.name));
    if (fam != null) families.add(fam); else loose.add(ingredientKey(it.name));
  }
  return { families, loose, count: families.size + loose.size };
}

const _dayNumber = iso => Math.round(fromIso(iso).getTime() / 864e5);

/**
 * Uses Up: in-stock items expiring by `horizon`, which of the week's
 * planned cooks use them, and recipes not planned that use the most of them,
 * then share the most with what's planned (one bag of spinach for two
 * dinners), then have the most on hand.
 * Returns { items: [{ family, name, expires, daysLeft, quantity, unit, plannedBy }], ideas: [{ recipe, uses }] }.
 */
export function usesUp({ recipes, pantry, planned, today, horizon, limit = 3 }) {
  const idx = pantryIndex(pantry, { today, horizon });
  if (!idx.expiring.size) return { items: [], ideas: [] };
  const byId = new Map((recipes || []).map(r => [r.id, r]));
  const plannedIds = new Set((planned || []).map(e => e.recipe_id));
  const items = [...idx.expiring.values()]
    .sort((a, b) => (a.expires < b.expires ? -1 : a.expires > b.expires ? 1 : 0))
    .map(x => ({
      ...x,
      plannedBy: [...plannedIds].map(id => byId.get(id)).filter(r => r && recipeNeeds(r, idx).families.has(x.family)).map(r => r.name),
    }));
  // What the planned cooks already need (in the pantry or to buy), for
  // ideas that share it.
  const plannedNeeds = new Set();
  for (const id of plannedIds) {
    const r = byId.get(id);
    if (!r) continue;
    const n = recipeNeeds(r, idx);
    for (const f of n.families) plannedNeeds.add(`f${f}`);
    for (const k of n.loose) plannedNeeds.add(`k${k}`);
  }
  const ideas = [];
  for (const r of recipes || []) {
    if (plannedIds.has(r.id)) continue;
    const need = recipeNeeds(r, idx);
    const uses = items.filter(x => need.families.has(x.family));
    if (!uses.length) continue;
    const have = [...need.families].filter(f => idx.stocked.has(f)).length;
    const shared = [...need.families].filter(f => plannedNeeds.has(`f${f}`)).length
      + [...need.loose].filter(k => plannedNeeds.has(`k${k}`)).length;
    ideas.push({ recipe: r, uses: uses.map(x => x.name), soonest: uses[0].expires, score: uses.length * 10 + Math.min(shared, 3) + (need.count ? have / need.count : 0) });
  }
  ideas.sort((a, b) => b.score - a.score || (a.soonest < b.soonest ? -1 : 1) || String(a.recipe.name).localeCompare(b.recipe.name));
  return { items, ideas: ideas.slice(0, limit).map(({ recipe, uses }) => ({ recipe, uses })) };
}

/**
 * Build My Week: `count` recipes for the week, best first, each with why.
 *   recipes: with ingredients, last_cooked_at, total time, category_id
 *   options: { useExpiring, notRecent, quick }
 *   exclude: recipe ids not to pick (already planned that week)
 *   skip: per-slot recipe ids passed over by Swap ({ [slot]: Set })
 *   fit: (recipe, slot) => false to leave it out of that slot (an allergy
 *     of someone home that day), or a number added to its score (a dislike)
 * Returns [{ recipe, reason }] where reason is
 *   { kind: 'uses', items } | { kind: 'shares', item, with } | { kind: 'have', have, need }
 *   | { kind: 'not_cooked', weeks } | { kind: 'new' }.
 */
export function buildWeek({ recipes, pantry, today, horizon, count, options = {}, exclude = new Set(), skip = {}, fit = null }) {
  const idx = pantryIndex(pantry, { today, horizon });
  const now = _dayNumber(today);
  const pool = (recipes || []).filter(r => {
    if (exclude.has(r.id) || !_items(r).length) return false;
    if (options.quick) {
      const mins = Number(r.total_minutes) || ((Number(r.prep_minutes) || 0) + (Number(r.cook_minutes) || 0)) || null;
      if (mins != null && mins > 30) return false;
    }
    return true;
  }).map(r => {
    const need = recipeNeeds(r, idx);
    const have = [...need.families].filter(f => idx.stocked.has(f)).length;
    const expiring = [...need.families].filter(f => idx.expiring.has(f)).map(f => idx.expiring.get(f).name);
    const last = r.last_cooked_at ? String(r.last_cooked_at).slice(0, 10) : null;
    const daysSince = last ? now - _dayNumber(last) : null;
    return { r, need, have, expiring, daysSince };
  });

  const chosen = [];
  const families = new Map(); // family -> name of the pick that uses it
  for (let slot = 0; slot < count; slot++) {
    let best = null;
    for (const c of pool) {
      if (chosen.some(x => x.c === c) || skip[slot]?.has(c.r.id)) continue;
      const f = fit ? fit(c.r, slot) : 0;
      if (f === false) continue;
      const ratio = c.need.count ? c.have / c.need.count : 0;
      let score = 2 * ratio + (Number(f) || 0);
      if (options.useExpiring !== false) score += 1.5 * c.expiring.length;
      const shared = [...c.need.families].filter(f => families.has(f));
      score += 0.5 * Math.min(shared.length, 3);
      if (options.notRecent !== false && c.daysSince != null) {
        if (c.daysSince < 7) score -= 3;
        else if (c.daysSince < 14) score -= 1;
        else score += Math.min(c.daysSince / 60, 0.5);
      }
      const prev = chosen[chosen.length - 1]?.c.r;
      if (prev && prev.category_id != null && prev.category_id === c.r.category_id) score -= 0.5;
      if (!best || score > best.score || (score === best.score && String(c.r.name).localeCompare(String(best.c.r.name)) < 0)) {
        best = { c, score, shared };
      }
    }
    if (!best) break;
    chosen.push(best);
    for (const f of best.c.need.families) if (!families.has(f)) families.set(f, best.c.r.name);
  }

  return chosen.map(({ c, shared }) => {
    let reason;
    if (options.useExpiring !== false && c.expiring.length) reason = { kind: 'uses', items: c.expiring.slice(0, 2) };
    else if (shared.length) {
      const f = shared[0];
      reason = { kind: 'shares', item: idx.byId.get(f)?.name || '', with: families.get(f) };
    } else if (c.need.count && c.have / c.need.count >= 0.5) reason = { kind: 'have', have: c.have, need: c.need.count };
    else if (c.daysSince != null && c.daysSince >= 14) reason = { kind: 'not_cooked', weeks: Math.floor(c.daysSince / 7) };
    else if (c.daysSince == null) reason = { kind: 'new' };
    else reason = { kind: 'have', have: c.have, need: c.need.count };
    return { recipe: c.r, reason };
  });
}

/**
 * The days a week's new dinners go on: from today (or the week's first
 * day, for a week ahead), the days with no planned cook first, in order.
 * More dinners than free days: the rest are for any day.
 */
export function freeDays(weekStartIso, plannedDates, today) {
  const start = fromIso(weekStartIso);
  const taken = new Set(plannedDates);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const iso = isoDay(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    if (iso < today || taken.has(iso)) continue;
    out.push(iso);
  }
  return out;
}

/** What the picked dinners need: { toBuy, expiring } (families and loose names, once each). */
export function picksNeeds(picks, pantry, { today, horizon } = {}) {
  const idx = pantryIndex(pantry, { today, horizon });
  const buy = new Set(), exp = new Set();
  for (const p of picks) {
    const need = recipeNeeds(p.recipe, idx);
    for (const f of need.families) { if (!idx.stocked.has(f)) buy.add(`f${f}`); if (idx.expiring.has(f)) exp.add(f); }
    for (const k of need.loose) buy.add(`k${k}`);
  }
  return { toBuy: buy.size, expiring: exp.size };
}
