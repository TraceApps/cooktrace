/**
 * src/lib/pantry-variants.js
 *
 * Shared helpers for the pantry variant hierarchy (Issue #4).
 *
 * Data shape: a pantry_items row is one of three things, based on the
 * single nullable column `generic_parent_id`:
 *   - Flat:    no children, no parent. `generic_parent_id == null` AND
 *              no other row points at it.
 *   - Generic: at least one other row points at it via
 *              `generic_parent_id == this.id`. The generic's own
 *              `generic_parent_id` is always null (no 3-level nesting).
 *   - Variant: this.generic_parent_id is set to a generic's id.
 *
 * These helpers compute the display name with the right context and
 * derive aggregate stock state for a generic from its children, so the
 * pantry list, editor sheet, recipe-card pantry-match, and Trace AI
 * tool output all agree on what to render.
 */

/**
 * Display name with context awareness.
 *
 *   nested=true   The variant is rendered directly under its parent in
 *                 a list, so the parent's name is already on screen.
 *                 Show just the distinguishing brand (or override name)
 *                 to avoid repetition.
 *   nested=false  Used out of context (search, recipe link picker, AI
 *                 mentions, toasts, federation responses). Show the
 *                 self-describing 'Parent (Brand)' composition.
 *
 * If the variant has an explicit name override (its own name differs
 * from the parent's), that wins in both modes.
 */
export function displayVariantName(variant, parent, opts = {}) {
  const nested = !!opts.nested;
  if (!variant) return '';
  const parentName = parent?.name || '';
  const hasOverride = parentName && variant.name && variant.name !== parentName;
  if (hasOverride) {
    return variant.brand
      ? variant.name + ' (' + variant.brand + ')'
      : variant.name;
  }
  if (nested) {
    return variant.brand || variant.name || 'Variant';
  }
  if (parentName && variant.brand) return parentName + ' (' + variant.brand + ')';
  return variant.name || parentName || 'Variant';
}

/**
 * Group an items list into a parent-id-keyed Map of variant arrays.
 * Variants are sorted alphabetically by brand for stable rendering.
 */
export function buildVariantsByParent(items) {
  const map = new Map();
  if (!Array.isArray(items)) return map;
  for (const it of items) {
    const pid = it?.generic_parent_id;
    if (pid == null) continue;
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid).push(it);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.brand || a.name || '').localeCompare(b.brand || b.name || ''));
  }
  return map;
}

/**
 * Filter an items list down to "top-level" rows: flat items and
 * generics. Variants stay out of the top-level rendering and surface
 * under their parents instead.
 */
export function topLevelItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(i => i?.generic_parent_id == null);
}

/**
 * Aggregate stock for an item:
 *   - Flat item: { stocked, total, isGeneric: false } where stocked is
 *     0 or 1 based on the row's own in_stock flag.
 *   - Generic with children: { stocked, total, isGeneric: true } where
 *     stocked counts children with in_stock == true and total is the
 *     number of children.
 *
 * Callers can render the same pill component for both ("In Stock" /
 * "Out of Stock" for flat; "3 of 5 variants stocked" for generics).
 */
export function aggregateStock(item, variantsByParent) {
  if (!item) return { stocked: 0, total: 0, isGeneric: false };
  const children = variantsByParent?.get?.(item.id) || [];
  if (children.length === 0) {
    return { stocked: item.in_stock ? 1 : 0, total: 1, isGeneric: false };
  }
  const stocked = children.reduce((n, c) => n + (c.in_stock ? 1 : 0), 0);
  return { stocked, total: children.length, isGeneric: true };
}

function _tokens(q) {
  return String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}
function _hay(row) {
  return ((row?.name || '') + ' ' + (row?.brand || '')).toLowerCase();
}
function _covers(hay, tokens) {
  for (const t of tokens) if (!hay.includes(t)) return false;
  return true;
}

/**
 * Search predicate that includes variants. An item matches the query
 * when its own name or brand matches, OR when at least one of its
 * children's brand / name matches. Used to keep search hits sensible
 * after variants get hidden under their parents.
 *
 * Multi-token: the query is split on whitespace and every token must
 * hit somewhere in the item + children haystack, so "greenwise whole
 * milk" (brand from a variant, name from the parent) resolves as a
 * match on the parent.
 */
export function matchesSearch(item, variantsByParent, queryRaw) {
  const tokens = _tokens(queryRaw);
  if (!tokens.length) return true;
  if (!item) return false;
  const parentHay = _hay(item);
  if (_covers(parentHay, tokens)) return true;
  const children = variantsByParent?.get?.(item.id) || [];
  for (const c of children) {
    if (_covers(parentHay + ' ' + _hay(c), tokens)) return true;
  }
  return false;
}

/**
 * True when a query specifically matched one of this generic's
 * children (not the parent's own name/brand). Used to auto-expand the
 * parent in the list so the matched child is visible.
 */
export function queryHitVariant(item, variantsByParent, queryRaw) {
  const tokens = _tokens(queryRaw);
  if (!tokens.length) return false;
  if (!item) return false;
  const parentHay = _hay(item);
  if (_covers(parentHay, tokens)) return false; // parent matched on its own
  const children = variantsByParent?.get?.(item.id) || [];
  for (const c of children) {
    if (_covers(parentHay + ' ' + _hay(c), tokens)) return true;
  }
  return false;
}

/**
 * Which variant ids under this parent should surface in a search
 * result, given the tokens the parent's own haystack didn't cover.
 * If the parent's own haystack already covers every token, returns
 * an empty array (no variants to auto-expand — parent card alone
 * is enough).
 */
export function matchingVariants(item, variantsByParent, queryRaw) {
  const tokens = _tokens(queryRaw);
  if (!tokens.length) return [];
  if (!item) return [];
  const parentHay = _hay(item);
  const remaining = tokens.filter(t => !parentHay.includes(t));
  if (!remaining.length) return [];
  const children = variantsByParent?.get?.(item.id) || [];
  return children.filter(c => _covers(_hay(c), remaining));
}

/**
 * Classify how a top-level item should render for the given query.
 *   - 'parent'   : query is fully satisfied by the parent's own
 *                  name/brand. Render the parent card, no auto-expand,
 *                  variants stay hidden.
 *   - 'expanded' : query mentions the parent AND a specific variant.
 *                  Render the parent card, auto-expand, only the
 *                  matching variants visible underneath.
 *   - 'variants' : query mentions only variant-specific tokens (brand
 *                  a user typed). Render each matching variant as a
 *                  top-level card with the parent name in the subtitle;
 *                  the parent's own card is NOT shown (would be noise).
 *   - null       : no match, item drops out of results.
 * Empty query returns 'parent' — all items surface by default.
 */
export function classifySearchHit(item, variantsByParent, queryRaw) {
  const tokens = _tokens(queryRaw);
  if (!tokens.length) return 'parent';
  if (!item) return null;
  const parentHay = _hay(item);
  const parentCovers = _covers(parentHay, tokens);
  if (parentCovers) return 'parent';
  const children = variantsByParent?.get?.(item.id) || [];
  const anyChildCoversOwnHay = children.some(c => _covers(_hay(c), tokens));
  const parentTouches = tokens.some(t => parentHay.includes(t));
  if (anyChildCoversOwnHay && !parentTouches) return 'variants';
  const anyChildCoversWithParent = children.some(c => _covers(parentHay + ' ' + _hay(c), tokens));
  if (anyChildCoversWithParent) return 'expanded';
  return null;
}
