// Defensive empty-guards for the recipe write paths (Option E, 2026-08-11).
//
// NT and LT got a full per-uuid merge (Option C) for their diary/workout
// row nested collections. CT's shape is different: recipes are typically
// owned by one user and mutli-device concurrent editing is rare, so the
// blast radius is a stale mobile client wiping ingredients/steps on save
// rather than cross-device races. That justifies a lighter fix: a set of
// small guards that refuse to accept an incoming empty value on a field
// that already has content on the server. Genuine "clear this recipe's
// steps" is exceptionally rare in the UI (users delete the recipe or
// individual steps, they don't nuke the whole steps array), so the
// tradeoff is right: eliminate the wipe class at the cost of a
// deliberate-clear needing an explicit-empty signal we can add later
// if a real workflow needs it.
//
// See project_traceapps_diary_merge_port for the audit and the shared
// fix design. If we ever hit a legitimate reason to clear one of these
// fields from the API, promote CT to full Option C.

/**
 * Return true when `value` should count as "empty enough" to skip the
 * incoming write and preserve the server-side copy. Arrays: length 0
 * OR every element is a section-shaped object with an empty items[]
 * (the ingredients grouped shape uses `[{ name: '', items: [] }]` as
 * a "no content" placeholder that _toStorage sometimes emits).
 * Strings / objects: truthy check.
 */
export function isEmptyForGuard(value, kind) {
  if (value == null) return true;
  if (Array.isArray(value)) {
    if (value.length === 0) return true;
    if (kind === 'ingredients') {
      // Grouped ingredients: [{ name?, items: [...] }, ...]. Consider
      // empty if every group has no items.
      return value.every(g => !g || !Array.isArray(g.items) || g.items.length === 0);
    }
    return false;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length === 0;
  }
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/**
 * Given the parsed server row and the client's incoming (already-
 * serialized) values, return a value to write for each nested field
 * that:
 *   - matches the incoming value if the incoming is non-empty, OR
 *   - falls back to the server-serialized value if incoming is empty
 *     AND the server already has content there.
 *
 * `incoming` and the returned map hold JSON-string values (what the
 * UPDATE binds), matching the recipes.js call site's shape.
 */
export function guardNestedRecipeFields({ existing, incoming }) {
  const out = { ...incoming };
  const CHECKS = [
    { field: 'ingredients', kind: 'ingredients' },
    { field: 'steps',       kind: 'array'       },
    { field: 'tags',        kind: 'array'       },
    { field: 'tools',       kind: 'array'       },
    { field: 'nutrition',   kind: 'object'      },
  ];
  for (const { field, kind } of CHECKS) {
    let parsedIncoming;
    try { parsedIncoming = JSON.parse(incoming[field] ?? 'null'); } catch { parsedIncoming = null; }
    if (isEmptyForGuard(parsedIncoming, kind)) {
      // Incoming is empty; check server. If server has content, keep it.
      let parsedServer;
      try { parsedServer = JSON.parse(existing[field] ?? 'null'); } catch { parsedServer = null; }
      if (!isEmptyForGuard(parsedServer, kind)) {
        out[field] = existing[field];
      }
    }
  }
  return out;
}
