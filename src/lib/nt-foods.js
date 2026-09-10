/**
 * src/lib/nt-foods.js
 *
 * Search a connected NutriTrace instance's food catalog, for use as a
 * Pantry search source alongside OFF and USDA. Proxies through
 * server/routes/nt-federation.js's GET /api/nt/foods, which already
 * normalizes NT's food shape (serving_size/serving_unit, absolute
 * img_url) to match what OFF.searchByName / USDA.searchByName return,
 * so no further field-mapping is needed here.
 *
 * Requires the user's NT federation connection to already be enabled
 * and configured (Settings -> Food Sources); the endpoint 503s
 * otherwise, which this treats the same as "no results" so a caller
 * doesn't need a separate enabled/disabled branch.
 */
import { apiUrl } from './platform.js';

/**
 * Search the connected NT instance by free-text food name. Returns an
 * array of pantry-shape objects (no auth token needed here beyond the
 * normal cookie/Bearer session, since /api/nt/foods itself is
 * cookie-authenticated and looks up the user's own stored federation
 * token server-side).
 */
export async function searchByName(query) {
  const q = (query || '').trim();
  if (!q) return [];
  try {
    const res = await fetch(apiUrl(`/api/nt/foods?q=${encodeURIComponent(q)}`), {
      credentials: 'include',
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[nt-foods] search failed:', e);
    return [];
  }
}
