/**
 * pantry-usage.js: which recipes use a pantry item. The "Used in N" pill on
 * a pantry card and the Used In list in its sheet both come from here, on
 * the server and on the phone, so the number and the list always agree.
 *
 * The same file lives at server/lib/pantry-usage.js and src/lib/pantry-usage.js;
 * scripts/pantry-usage.test.js checks the two stay identical.
 */

// A link may have been saved as "12" by an older client; it is still item 12.
function _id(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Every pantry item a recipe's ingredients link to, as a Set of numbers. */
export function linkedPantryIds(ingredients) {
  let groups = ingredients;
  if (typeof groups === 'string') {
    try { groups = JSON.parse(groups); } catch { return new Set(); }
  }
  const out = new Set();
  if (!Array.isArray(groups)) return out;
  const add = (it) => {
    const id = it && typeof it === 'object' ? _id(it.pantry_item_id) : null;
    if (id != null) out.add(id);
  };
  for (const g of groups) {
    if (g && Array.isArray(g.items)) g.items.forEach(add);
    else add(g);
  }
  return out;
}

/** How many recipes link to each pantry item: Map(id -> count). */
export function usageCounts(recipes) {
  const counts = new Map();
  for (const r of recipes || []) {
    for (const id of linkedPantryIds(r.ingredients)) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

/**
 * The recipes that use a pantry item, for its Used In list.
 *
 * `direct` are the recipes linked to the item itself: the card's count.
 * `through` are the ones that reach it through its family, each with
 * `via: { id, name }`. A variant is reached through its generic (a recipe
 * that asks for "Whole Milk" takes any brand of it); a generic is reached
 * through any of its variants. Give `generic` ({ id, name }) for a variant,
 * `variants` ([{ id, name }]) for a generic. Recipes keep the order given.
 */
export function recipesUsing(recipes, itemId, { generic = null, variants = [] } = {}) {
  const id = _id(itemId);
  const genericId = generic ? _id(generic.id) : null;
  const variantById = new Map();
  for (const v of variants || []) {
    const vid = _id(v?.id);
    if (vid != null && vid !== id) variantById.set(vid, v);
  }
  const direct = [];
  const through = [];
  for (const r of recipes || []) {
    const links = linkedPantryIds(r.ingredients);
    if (!links.size) continue;
    const row = { id: r.id, name: r.name, img_url: r.img_url ?? null };
    if (id != null && links.has(id)) { direct.push(row); continue; }
    if (genericId != null && genericId !== id && links.has(genericId)) {
      through.push({ ...row, via: { id: genericId, name: generic.name } });
      continue;
    }
    for (const l of links) {
      const v = variantById.get(l);
      if (v) { through.push({ ...row, via: { id: l, name: v.name } }); break; }
    }
  }
  return { direct, through };
}
