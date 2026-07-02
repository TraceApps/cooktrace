/**
 * pantry-categories.js — canonical category list for pantry items.
 *
 * Stored value is the lowercase id ("spice", "dairy", etc.) so filters
 * survive locale changes; the label is what we show to the user.
 *
 * Category is optional on every pantry row — the user can leave it
 * unset (null) and the row sorts under "Uncategorized".
 */
export const PANTRY_CATEGORIES = [
  { id: 'produce',   label: 'Produce',          icon: 'eco' },
  { id: 'meat',      label: 'Meat',             icon: 'restaurant' },
  { id: 'poultry',   label: 'Poultry',          icon: 'egg_alt' },
  { id: 'seafood',   label: 'Seafood',          icon: 'set_meal' },
  { id: 'dairy',     label: 'Dairy & eggs',     icon: 'local_drink' },
  { id: 'grain',     label: 'Grains & pasta',   icon: 'grain' },
  { id: 'baking',    label: 'Baking',           icon: 'cake' },
  { id: 'spice',     label: 'Spices & herbs',   icon: 'local_florist' },
  { id: 'condiment', label: 'Condiments',       icon: 'lunch_dining' },
  { id: 'oil',       label: 'Oils & vinegar',   icon: 'opacity' },
  { id: 'canned',    label: 'Canned & jarred',  icon: 'inventory_2' },
  { id: 'frozen',    label: 'Frozen',           icon: 'ac_unit' },
  { id: 'beverage',  label: 'Beverages',        icon: 'local_cafe' },
  { id: 'snack',     label: 'Snacks',           icon: 'cookie' },
  { id: 'other',     label: 'Other',            icon: 'kitchen' },
];

const _byId = new Map(PANTRY_CATEGORIES.map(c => [c.id, c]));

export function categoryLabel(id) {
  if (!id) return 'Uncategorized';
  // Server hydrate now returns the joined category as an object
  // ({ id, name, slug, icon, color }) instead of a slug string. Be
  // defensive so callers passing either shape keep working. Without
  // this, an object id misses the Map lookup and the caller renders
  // `[object Object]` as the label.
  if (typeof id === 'object') return id.name || id.label || 'Uncategorized';
  return _byId.get(id)?.label || id;
}

export function categoryIcon(id) {
  if (!id) return 'help';
  if (typeof id === 'object') return id.icon || 'kitchen';
  return _byId.get(id)?.icon || 'kitchen';
}
