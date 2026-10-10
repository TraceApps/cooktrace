/**
 * ingredient-line.js: one ingredient line, as a recipe site or an export
 * writes it, split into { qty, unit, name, note }. The same on the server
 * and in the app.
 *
 * Two identical copies: src/lib/ingredient-line.js and
 * server/lib/ingredient-line.js. A test checks they match.
 *
 *   "1 1/2 cups flour, sifted"          → 1 1/2 | cup | flour        | sifted
 *   "4 - 5 roma tomatoes"               → 4-5   |     | roma tomatoes |
 *   "1 (15-ounce) can black beans"      → 1     | can | black beans  | 15-ounce
 *   "2 large eggs"                      → 2     |     | eggs         | large
 *   "1 onion, finely chopped"           → 1     |     | onion        | finely chopped
 *   "1 lb boneless, skinless chicken"   → 1     | lb  | boneless, skinless chicken
 *
 * The name is what the pantry links to, so what describes this one batch
 * (its size, its prep) goes in the note and the name stays the thing itself.
 */
import { normalizeUnit, isKnownUnit } from './quantity.js';

const VULGAR = {
  '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅕': '1/5', '⅖': '2/5',
  '⅗': '3/5', '⅘': '4/5', '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
};
const DASHES = String.fromCharCode(0x2013, 0x2014);

// One number: "1 1/2", "1/2", "0.25", "2".
const NUM = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?)';
// A quantity: a number, or a range of two ("4-5", "4 - 5", "1 to 2").
const QTY_RX = new RegExp(`^(${NUM})(?:\\s*(?:-|[${DASHES}]|to)\\s*(${NUM}))?\\s+`, 'i');

// Sizes that describe one batch, not the ingredient.
const SIZE_RX = /^(?:extra[- ]large|extra[- ]small|small|medium|large|jumbo|heaping|level|scant|generous|big)\b\s*/i;
// A package size written before its unit: "15-ounce", "14.5 oz", "400g".
const PACK_RX = /^(\d+(?:\.\d+)?\s*-?\s*(?:ounce|oz|gram|g|ml|milliliter|millilitre|pound|lb|liter|litre|l)s?)\s+/i;

// What can follow a comma and be prep, not part of the name.
const PREP_RX = new RegExp('^(?:' + [
  'diced', 'chopped', 'minced', 'sliced', 'grated', 'shredded', 'peeled', 'cubed', 'halved', 'quartered',
  'crushed', 'torn', 'trimmed', 'seeded', 'cored', 'pitted', 'julienned', 'zested', 'juiced', 'beaten',
  'whisked', 'melted', 'softened', 'cooled', 'chilled', 'drained', 'rinsed', 'washed', 'divided', 'sifted',
  'packed', 'toasted', 'cooked', 'thawed', 'mashed', 'cut', 'broken', 'separated', 'room temperature',
  'at room temperature', 'to taste', 'for serving', 'for garnish', 'for frying', 'as needed', 'optional',
  'plus more', 'or more', 'about', 'roughly', 'finely', 'coarsely', 'thinly', 'thickly', 'freshly', 'lightly',
  'well', 'very', 'cold', 'warm', 'hot', 'fresh', 'frozen', 'stems removed', 'skin on', 'skin off', 'bone in',
].map(w => w.replace(/ /g, '\\s+')).join('|') + ')\\b', 'i');

function _addNote(note, more) {
  more = String(more || '').trim().replace(/^[,;]\s*/, '');
  if (!more) return note;
  return note ? `${note}; ${more}` : more;
}

/** One ingredient line as { qty, unit, name, note } (all strings, '' when absent). */
export function parseIngredientLine(line) {
  if (!line || typeof line !== 'string') return { qty: '', unit: '', name: '', note: '' };
  let note = '';

  // Anything in parentheses is a note ("(divided)", "(15-ounce)").
  let working = line.trim().replace(/\s*\(([^)]+)\)/g, (_, n) => { note = _addNote(note, n); return ''; }).trim();

  // Vulgar fractions as text ("1½" → "1 1/2"), "1 and 1/2" → "1 1/2",
  // and a metric unit written onto its number ("320g" → "320 g").
  working = working
    .replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, ch => ' ' + VULGAR[ch] + ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(\d+)\s+and\s+(\d+\s*\/\s*\d+)\b/i, '$1 $2')
    .replace(/^(\d+(?:\.\d+)?)(kg|mg|ml|dl|cl|oz|lb|g|l)\b/i, '$1 $2');

  let qty = '';
  const qm = working.match(QTY_RX);
  if (qm) {
    qty = qm[2] ? `${qm[1].trim()}-${qm[2].trim()}` : qm[1].trim();
    working = working.slice(qm[0].length);
  }

  // A size or a package size before the unit: "2 large eggs", "1 15-ounce can".
  for (let i = 0; i < 2; i++) {
    const size = working.match(SIZE_RX) || working.match(PACK_RX);
    if (!size) break;
    note = _addNote(note, size[0]);
    working = working.slice(size[0].length);
  }

  // The unit: two words first ("fluid ounce" before "fluid"), then one.
  let unit = '';
  const two = working.match(/^([A-Za-z]+\.?\s+[A-Za-z]+)\b\.?/);
  if (two && isKnownUnit(two[1].replace(/\./g, ''))) {
    unit = normalizeUnit(two[1].replace(/\./g, ''));
    working = working.slice(two[0].length).trim();
  } else {
    const one = working.match(/^([A-Za-z]+)\b\.?/);
    if (one && isKnownUnit(one[1])) {
      unit = normalizeUnit(one[1]);
      working = working.slice(one[0].length).trim();
    }
  }
  // A size or packing after the unit: "1 cup packed brown sugar".
  const after = working.match(SIZE_RX) || working.match(/^(?:(?:firmly|lightly|loosely|tightly)\s+)?packed\b\s*/i);
  if (after && unit) { note = _addNote(note, after[0]); working = working.slice(after[0].length); }

  // A joining word between amount and name: "of" (and di, de, von, do, da).
  let name = working.replace(/^(?:of|di|de|von|do|da)\s+/i, '').replace(/^d['’]/i, '').trim();

  // Prep after a comma goes to the note ("onion, diced"); a comma between
  // words of the name stays ("boneless, skinless chicken").
  const comma = name.search(/,\s*/);
  if (comma > 0) {
    const rest = name.slice(comma).replace(/^,\s*/, '');
    if (PREP_RX.test(rest)) {
      note = _addNote(note, rest);
      name = name.slice(0, comma).trim();
    }
  }
  // Without a comma, a few endings are notes too: "salt to taste".
  const tail = name.match(/^(.+?)\s+(to taste|as needed|optional|divided|for serving|for garnish)$/i);
  if (tail && tail[1].trim()) { name = tail[1].trim(); note = _addNote(note, tail[2]); }

  return { qty, unit, name: name.replace(/[\s,;]+$/, ''), note };
}
