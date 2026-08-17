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
      // Ingredients can arrive in either shape:
      //   - grouped: [{ name?, items: [...] }, ...] — element with an
      //     explicit `items` field is a section; empty when its items
      //     array is empty (this is the "no content" placeholder
      //     _toStorage sometimes emits).
      //   - flat legacy: [{ name, quantity, unit }, ...] — no `items`
      //     field; the element itself IS an ingredient. It's empty
      //     only when none of its content fields are populated.
      // Distinguish by whether `items` is an own property, not by
      // presence-of-name — a group heading with an empty items array
      // is still empty, and prior versions of this guard silently
      // classified the flat shape as empty, dropping non-empty updates
      // from clients that used it (older builds, AI generators).
      return value.every(g => {
        if (!g) return true;
        if ('items' in g) {
          return !Array.isArray(g.items) || g.items.length === 0;
        }
        return !['name', 'quantity', 'qty', 'unit', 'notes'].some(
          k => g[k] != null && String(g[k]).trim() !== ''
        );
      });
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
  // Tags intentionally NOT guarded: "remove all tags" is a common,
  // cheap edit via the chip UI and the guard would silently revert it
  // (client sends `tags: []`, guard sees non-empty server tags,
  // preserves server → user's clear looks like a bug on next refresh).
  // Tags are also a small flat string array, so the wipe-by-stale-
  // client risk that motivates guarding ingredients/steps/tools/
  // nutrition doesn't apply here — losing tags is annoying, not
  // destructive.
  const CHECKS = [
    { field: 'ingredients', kind: 'ingredients' },
    { field: 'steps',       kind: 'array'       },
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
