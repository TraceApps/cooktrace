/**
 * src/lib/search-text.js
 *
 * One definition of "does this text match what the user typed" for every
 * search box in the app.
 *
 * Names people give their own food carry accents: Orégano, Café, Limón,
 * Jalapeño, Plátano, Jamón. On a phone almost nobody types the accent, so
 * comparing raw lowercase text makes an item that is right there look
 * missing. Both sides are folded before comparing instead. Text without
 * accents is unchanged by folding, so English matches exactly as before.
 *
 * The server keeps its own copy at server/lib/search-text.js, since the
 * runtime image ships server/ and dist/ only. A test pins the two to the
 * same output.
 */

// Letters that carry no combining mark to strip, so NFD cannot fold them.
const SPECIALS = [
  [/ß/g, 'ss'], [/æ/g, 'ae'], [/œ/g, 'oe'],
  [/ø/g, 'o'], [/ł/g, 'l'], [/đ/g, 'd'], [/ð/g, 'd'], [/þ/g, 'th'],
];

/** Lowercase, expand the letters NFD cannot reach, then drop accents. */
export function foldText(s) {
  let out = String(s ?? '').toLowerCase();
  for (const [re, to] of SPECIALS) out = out.replace(re, to);
  return out.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * True when `haystack` contains `query`, accents aside. An empty query
 * matches everything, which is what a search box with nothing in it means.
 */
export function includesFolded(haystack, query) {
  return foldText(haystack).includes(foldText(query).trim());
}

/**
 * Every whitespace-separated token of the query has to appear somewhere in
 * the haystack, in any order, so "milk whole" finds "Whole milk".
 */
export function coversFolded(haystack, query) {
  const hay = foldText(haystack);
  const tokens = foldText(query).trim().split(/\s+/).filter(Boolean);
  return tokens.every(t => hay.includes(t));
}
