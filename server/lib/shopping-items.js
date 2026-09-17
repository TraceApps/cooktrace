/**
 * shopping-items.js: shopping list rules shared by the app's own routes
 * (server/routes/shopping.js) and the sister-app API
 * (server/routes/api/v1/shopping-fed.js), so an item reads the same however
 * it was added.
 */
import db from '../db.js';

// Title-case a shopping item name. Mealie stores its canonical food
// names lowercase ("fresh lemon juice"), so anything copied from a
// recipe's stored ingredient JSON arrives that way. This normalises at
// the shopping-list write boundary so every row in the user's list
// follows the project's caps rule regardless of upstream source.
//
// Chicago-style minor-word exceptions: keep articles, short conjunctions,
// and short prepositions lowercase UNLESS they're the first word. Already
// uppercase words (acronyms, brand names) pass through.
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'if', 'in', 'nor', 'of', 'on', 'or', 'the', 'to', 'up', 'via',
]);
export function titleCaseName(raw) {
  if (raw == null) return raw;
  const s = String(raw).trim();
  if (!s) return s;
  // Don't touch strings already mixed-case (likely user-typed manual entry).
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s;
  // Split on whitespace but preserve internal punctuation (hyphens etc.)
  // by mapping word-by-word.
  return s.split(/(\s+)/).map((tok, i, arr) => {
    if (!tok.trim()) return tok;
    // Hyphenated word: title-case each segment ("all-purpose" → "All-Purpose").
    return tok.split('-').map((seg, segIdx) => {
      const lower = seg.toLowerCase();
      const isFirstToken = arr.slice(0, i).every(t => !t.trim());
      const isFirstSeg = segIdx === 0;
      // Lowercase minor words except when they start the whole string.
      if (MINOR_WORDS.has(lower) && !(isFirstToken && isFirstSeg)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join('-');
  }).join('');
}

// Aisle auto-lookup: linked pantry item → its category's default_aisle,
// falling back to the category name, then null. Used by every insert path
// (single-item POST, /from-recipe, /from-plan, the sister-app API) so the
// shopping list groups itself without the user having to tag each row.
export function aisleForPantry(pantryId) {
  if (!pantryId) return null;
  const cat = db.prepare(
    `SELECT c.default_aisle, c.name
       FROM pantry_items p
       LEFT JOIN pantry_categories c ON c.id = p.category_id
      WHERE p.id = ?`
  ).get(pantryId);
  if (!cat) return null;
  return (cat.default_aisle && cat.default_aisle.trim()) || cat.name || null;
}

const userClause = (u, col = 'user_id') => (u == null ? `${col} IS NULL` : `${col} = ?`);
const userArgs = (u) => (u == null ? [] : [u]);

/** A pantry item with exactly this name (any case), so a typed "milk" finds its aisle. */
export function pantryIdForName(userId, name) {
  const row = db.prepare(
    `SELECT id FROM pantry_items
      WHERE ${userClause(userId)} AND deleted_at IS NULL AND lower(trim(name)) = lower(trim(?))
      ORDER BY in_stock ASC, id ASC LIMIT 1`
  ).get(...userArgs(userId), name);
  return row?.id ?? null;
}

/** The list the way the Shopping page shows it: unchecked first, by aisle, then your order. */
export function listShoppingItems(userId, { includeChecked = true } = {}) {
  const rows = db.prepare(
    `SELECT s.id, s.name, s.quantity, s.unit, s.aisle, s.checked, s.pantry_id, s.recipe_id,
            r.name AS recipe_name, s.sort_order, s.updated_at
       FROM shopping_list s
       LEFT JOIN recipes r ON r.id = s.recipe_id AND r.deleted_at IS NULL
      WHERE ${userClause(userId, 's.user_id')} AND s.deleted_at IS NULL${includeChecked ? '' : ' AND s.checked = 0'}
      ORDER BY s.checked ASC,
               COALESCE(s.aisle, 'zzz') ASC,
               CASE WHEN s.sort_order IS NULL THEN 1 ELSE 0 END,
               s.sort_order ASC,
               s.name COLLATE NOCASE ASC`
  ).all(...userArgs(userId));
  return rows.map(r => ({ ...r, checked: !!r.checked }));
}

/**
 * Add items by name, as another app would: each finds its pantry item (and
 * so its aisle) by name, and one already on the list unchecked isn't added
 * twice. Returns { added, skipped }.
 */
export const addShoppingItems = db.transaction((userId, items) => {
  const added = [];
  const skipped = [];
  const findOpen = db.prepare(
    `SELECT id, name FROM shopping_list
      WHERE ${userClause(userId)} AND deleted_at IS NULL AND checked = 0 AND lower(trim(name)) = lower(trim(?))
      LIMIT 1`
  );
  const insert = db.prepare(
    `INSERT INTO shopping_list (user_id, name, quantity, unit, aisle, checked, pantry_id)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  );
  for (const raw of items) {
    const name = titleCaseName(raw.name);
    const open = findOpen.get(...userArgs(userId), name);
    if (open) { skipped.push({ name, existing_id: open.id }); continue; }
    const pantryId = pantryIdForName(userId, name);
    const aisle = raw.aisle || aisleForPantry(pantryId);
    const info = insert.run(userId, name, raw.quantity ?? null, raw.unit || null, aisle || null, pantryId);
    added.push({ id: Number(info.lastInsertRowid), name, quantity: raw.quantity ?? null, unit: raw.unit || null, aisle: aisle || null, pantry_id: pantryId });
  }
  return { added, skipped };
});

/** Clear checked items. Returns how many went. */
export function clearCheckedItems(userId) {
  return db.prepare(
    `UPDATE shopping_list SET deleted_at = datetime('now'), updated_at = datetime('now')
      WHERE ${userClause(userId)} AND checked = 1 AND deleted_at IS NULL`
  ).run(...userArgs(userId)).changes;
}

/** A sister app's item, checked: name required, quantity a positive number, unit and aisle short text. */
export function cleanIncomingItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '').trim().slice(0, 200);
  if (!name) return null;
  const q = raw.quantity == null || raw.quantity === '' ? null : Number(raw.quantity);
  const quantity = Number.isFinite(q) && q > 0 && q <= 100000 ? q : null;
  const unit = raw.unit ? String(raw.unit).trim().slice(0, 20) || null : null;
  const aisle = raw.aisle ? String(raw.aisle).trim().slice(0, 50) || null : null;
  return { name, quantity, unit, aisle };
}
