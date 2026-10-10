/**
 * recipe-content.js: a recipe as you cook it, its versions, and what
 * changed between two of them. The same on the server and in the app.
 *
 * Two identical copies: src/lib/recipe-content.js (web and Android) and
 * server/lib/recipe-content.js (the server image has no src/). A test checks
 * they match, so edit one and copy it over.
 *
 * A version is what you cook: the ingredients, the steps, the servings and
 * yield, and the times. A new photo, title, notes, tags, category, nutrition
 * or pantry link isn't a new version. Versions are known by their content
 * (`rev`, a hash), so a phone on its own, a phone offline and the server all
 * arrive at the same version for the same recipe, and going back to an
 * earlier one makes that version current again rather than adding a copy.
 */
import { ingredientKey, parseQty, normalizeUnit, formatQty } from './quantity.js';

/** The recipe fields a version holds. */
export const COOK_FIELDS = ['ingredients', 'steps', 'servings', 'yield_text', 'prep_minutes', 'cook_minutes', 'rest_minutes', 'total_minutes'];
const DETAIL_FIELDS = ['servings', 'yield_text', 'prep_minutes', 'cook_minutes', 'rest_minutes', 'total_minutes'];

function _json(v, fallback) {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
  return v ?? fallback;
}
const _text = v => (v == null ? '' : String(v)).normalize('NFC').trim();
const _num = v => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Grouped ingredients, or the older flat list as one unnamed group.
function _groups(raw) {
  const v = _json(raw, []);
  if (!Array.isArray(v) || !v.length) return [];
  if (v.every(x => x && typeof x === 'object' && !Array.isArray(x.items))) return [{ name: '', items: v }];
  return v.map(g => ({ name: g?.name || '', items: Array.isArray(g?.items) ? g.items : [] }));
}

/**
 * The cooking content of a recipe (a row or an API recipe): what a version
 * stores. Ingredient ids and the steps' linked ingredients and photos are
 * kept, for showing and comparing; pantry links are not (their ids differ
 * between a phone and the server, and linking one isn't a change to cook).
 */
export function cookContent(recipe) {
  const ingredients = _groups(recipe?.ingredients).map(g => ({
    name: _text(g.name),
    items: g.items.map(i => {
      const out = { qty: _text(i?.qty), unit: _text(i?.unit), name: _text(i?.name), note: _text(i?.note) };
      if (i?.id != null && i.id !== '') out.id = String(i.id);
      return out;
    }).filter(i => i.qty || i.unit || i.name || i.note),
  })).filter(g => g.name || g.items.length);
  const steps = (_json(recipe?.steps, []) || []).map(st => {
    if (typeof st === 'string') return { title: '', text: _text(st) };
    const out = { title: _text(st?.title), text: _text(st?.text) };
    if (Array.isArray(st?.refIds) && st.refIds.length) out.refIds = st.refIds.map(String);
    if (st?.imgUrl) out.imgUrl = String(st.imgUrl);
    return out;
  }).filter(st => st.title || st.text || st.imgUrl);
  const out = { ingredients, steps };
  for (const f of DETAIL_FIELDS) out[f] = f === 'yield_text' ? (_text(recipe?.[f]) || null) : _num(recipe?.[f]);
  return out;
}

// What makes two versions the same: amounts compared as amounts ("1/2" and
// "0.5", "cups" and "cup"), words without case or extra spaces. Ids, linked
// ingredients and step photos aside.
const _words = s => _text(s).replace(/\s+/g, ' ').toLowerCase();
function _amount(qty) {
  const n = parseQty(qty);
  return n != null ? formatQty(n) : _words(qty);
}
function _hashable(c) {
  return {
    i: c.ingredients.map(g => [_words(g.name), g.items.map(i => [_amount(i.qty), normalizeUnit(i.unit) || _words(i.unit), _words(i.name), _words(i.note)])]),
    s: c.steps.map(st => [_words(st.title), _words(st.text)]),
    d: DETAIL_FIELDS.map(f => (f === 'yield_text' ? _words(c[f]) : c[f])),
  };
}

// A 53-bit hash (cyrb53): the same on every engine, fast, and with a few
// hundred versions per recipe, no two will meet.
function _hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** A version's key: the same content gives the same key, anywhere. */
export function revOf(content) {
  return 'v' + _hash(JSON.stringify(_hashable(content)));
}

/** A recipe's current version: { rev, data } (data is cookContent()). */
export function revisionOf(recipe) {
  const data = cookContent(recipe);
  return { rev: revOf(data), data };
}

/** A stored version's data (JSON text or an object), as cookContent(). */
export function parseRevision(data) {
  return cookContent(_json(data, {}) || {});
}

// ── What changed ────────────────────────────────────────────────────────

const _flat = c => c.ingredients.flatMap((g, gi) => g.items.map(i => ({ ...i, group: g.name, gi })));
const _amountText = i => [i.qty, i.unit].filter(Boolean).join(' ');
/** An ingredient as one line: "2 tbsp butter, cold". */
export const lineText = i => [[i.qty, i.unit, i.name].filter(Boolean).join(' '), i.note].filter(Boolean).join(', ');
const _sameItem = (a, b) => _amount(a.qty) === _amount(b.qty)
  && (normalizeUnit(a.unit) || _words(a.unit)) === (normalizeUnit(b.unit) || _words(b.unit))
  && _words(a.name) === _words(b.name) && _words(a.note) === _words(b.note);

// Line up two step lists by their text (longest common run), then pair
// what's left between matches as edits.
function _alignSteps(a, b) {
  const ka = a.map(st => `${_words(st.title)}\n${_words(st.text)}`);
  const kb = b.map(st => `${_words(st.title)}\n${_words(st.text)}`);
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i][j] = ka[i] === kb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  const gapA = [], gapB = [];
  const flush = () => {
    const k = Math.min(gapA.length, gapB.length);
    for (let x = 0; x < k; x++) out.push({ kind: 'changed', from: gapA[x], to: gapB[x] });
    for (let x = k; x < gapA.length; x++) out.push({ kind: 'removed', from: gapA[x], to: null });
    for (let x = k; x < gapB.length; x++) out.push({ kind: 'added', from: null, to: gapB[x] });
    gapA.length = 0; gapB.length = 0;
  };
  while (i < n || j < m) {
    if (i < n && j < m && ka[i] === kb[j]) { flush(); out.push({ kind: 'same', from: { ...a[i], n: i + 1 }, to: { ...b[j], n: j + 1 } }); i++; j++; }
    else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) { gapA.push({ ...a[i], n: i + 1 }); i++; }
    else { gapB.push({ ...b[j], n: j + 1 }); j++; }
  }
  flush();
  return out;
}

/**
 * What changed from version `a` to version `b` (cookContent() of each):
 *   ingredients: [{ kind: 'same'|'changed'|'added'|'removed', from, to }]
 *     lined up by id, then by name ("tomato" and "Tomatoes" are one), in b's order
 *     with what was removed where it was
 *   steps: [{ kind, from, to }] with each step's number (n) on its side
 *   details: [{ field, from, to }] for servings, yield and times that differ
 */
export function compareContent(a, b) {
  const A = _flat(a), B = _flat(b);
  const pairOf = new Map(); // index in B -> index in A
  const usedA = new Set();
  B.forEach((item, bi) => {
    if (!item.id) return;
    const ai = A.findIndex((x, k) => !usedA.has(k) && x.id && x.id === item.id);
    if (ai > -1) { pairOf.set(bi, ai); usedA.add(ai); }
  });
  B.forEach((item, bi) => {
    if (pairOf.has(bi)) return;
    const key = ingredientKey(item.name);
    const ai = A.findIndex((x, k) => !usedA.has(k) && key && ingredientKey(x.name) === key);
    if (ai > -1) { pairOf.set(bi, ai); usedA.add(ai); }
  });
  const ingredients = [];
  // A removed one goes where it was: after the kept one it followed in a.
  const removedAfter = new Map(); // a index of the kept one before (-1: the start) -> [removed]
  let lastKept = -1;
  A.forEach((item, ai) => {
    if (usedA.has(ai)) { lastKept = ai; return; }
    if (!removedAfter.has(lastKept)) removedAfter.set(lastKept, []);
    removedAfter.get(lastKept).push(item);
  });
  const removed = ai => { for (const r of removedAfter.get(ai) || []) ingredients.push({ kind: 'removed', from: r, to: null }); };
  removed(-1);
  B.forEach((item, bi) => {
    const ai = pairOf.get(bi);
    if (ai == null) { ingredients.push({ kind: 'added', from: null, to: item }); return; }
    ingredients.push({ kind: _sameItem(A[ai], item) ? 'same' : 'changed', from: A[ai], to: item });
    removed(ai);
  });

  const details = DETAIL_FIELDS
    .filter(f => (f === 'yield_text' ? _words(a[f]) !== _words(b[f]) : (a[f] ?? null) !== (b[f] ?? null)))
    .map(f => ({ field: f, from: a[f] ?? null, to: b[f] ?? null }));

  return { ingredients, steps: _alignSteps(a.steps, b.steps), details };
}

/**
 * What changed, briefly, for a list: [{ kind, name?, from?, to?, n?, field? }]
 *   ingredient_changed (name, from, to as amounts; or the name when that changed)
 *   ingredient_added / ingredient_removed (name), step_changed / step_added /
 *   step_removed (n), detail (field, from, to). Empty when nothing changed.
 */
export function changeSummary(a, b) {
  if (!a) return [];
  const d = compareContent(a, b);
  const out = [];
  for (const x of d.ingredients) {
    if (x.kind === 'changed') {
      // Only the amount: the amounts. Anything else (a renamed ingredient,
      // a note): the whole line.
      const onlyAmount = ingredientKey(x.from.name) === ingredientKey(x.to.name) && _words(x.from.note) === _words(x.to.note);
      out.push(onlyAmount
        ? { kind: 'ingredient_changed', name: x.to.name, from: _amountText(x.from), to: _amountText(x.to) }
        : { kind: 'ingredient_changed', name: x.to.name, from: lineText(x.from), to: lineText(x.to) });
    } else if (x.kind === 'added') out.push({ kind: 'ingredient_added', name: x.to.name });
    else if (x.kind === 'removed') out.push({ kind: 'ingredient_removed', name: x.from.name });
  }
  for (const x of d.details) out.push({ kind: 'detail', field: x.field, from: x.from, to: x.to });
  for (const x of d.steps) {
    if (x.kind === 'changed') out.push({ kind: 'step_changed', n: x.to.n });
    else if (x.kind === 'added') out.push({ kind: 'step_added', n: x.to.n });
    else if (x.kind === 'removed') out.push({ kind: 'step_removed', n: x.from.n });
  }
  return out;
}

/**
 * Word-level changes between two texts, for showing an edited step:
 * [{ kind: 'same'|'added'|'removed', text }].
 */
export function diffWords(from, to) {
  const a = String(from || '').split(/(\s+)/).filter(Boolean);
  const b = String(to || '').split(/(\s+)/).filter(Boolean);
  const n = a.length, m = b.length;
  if (n * m > 250000) return [{ kind: 'removed', text: String(from || '') }, { kind: 'added', text: String(to || '') }];
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = [];
  const push = (kind, text) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text; else out.push({ kind, text });
  };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { push('same', a[i]); i++; j++; }
    else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) { push('removed', a[i]); i++; }
    else { push('added', b[j]); j++; }
  }
  return out;
}

/**
 * A version's ingredients, put back on a recipe: each keeps the pantry link
 * the recipe has now for it (by ingredient id, else by name: "tomato" and
 * "Tomatoes"), since a version doesn't hold links. `currentIngredients` is
 * the recipe's as stored (JSON text or groups). Returns groups.
 */
export function withPantryLinks(currentIngredients, data) {
  const byId = new Map(), byKey = new Map();
  for (const g of _groups(currentIngredients)) for (const it of g.items) {
    if (it?.pantry_item_id == null) continue;
    if (it.id != null) byId.set(String(it.id), it.pantry_item_id);
    const k = ingredientKey(it.name);
    if (k && !byKey.has(k)) byKey.set(k, it.pantry_item_id);
  }
  return (data?.ingredients || []).map(g => ({
    name: g.name || '',
    items: (g.items || []).map(it => {
      const link = (it.id != null ? byId.get(String(it.id)) : undefined) ?? byKey.get(ingredientKey(it.name));
      return link != null ? { ...it, pantry_item_id: link } : { ...it };
    }),
  }));
}

/**
 * The recipe columns that put a version back: what you cook, with
 * ingredients and steps as JSON text, as stored.
 */
export function restoreValues(recipe, data) {
  const vals = {
    ingredients: JSON.stringify(withPantryLinks(recipe?.ingredients, data)),
    steps: JSON.stringify(data?.steps || []),
  };
  for (const f of COOK_FIELDS) if (!(f in vals)) vals[f] = data?.[f] ?? null;
  return vals;
}

/**
 * Versions in order, numbered: [{ ...revision, number }] oldest first by
 * when each first appeared. `revisions` rows carry created_at and id.
 */
export function numberRevisions(revisions) {
  return [...(revisions || [])]
    .sort((x, y) => String(x.created_at || '').localeCompare(String(y.created_at || '')) || (Number(x.id) - Number(y.id)))
    .map((r, i) => ({ ...r, number: i + 1 }));
}
