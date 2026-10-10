/**
 * step-format.js — tiny markdown-ish formatter for recipe step text.
 *
 * Steps are stored as plain text so existing imports (Mealie, Tandoor,
 * Paprika, schema.org/Recipe) round-trip without a serialization
 * change. To let users emphasize key moments without forcing rich-text
 * markup into the storage layer, we accept three lightweight inline
 * markers in the text and render them to a small allowed-tag HTML
 * subset on display:
 *
 *     **bold**           → <strong>bold</strong>
 *     *italic*           → <em>italic</em>
 *     __underline__      → <u>underline</u>
 *
 * Anything else passes through as plain text. The output goes through
 * an HTML escape pass FIRST so user content can't smuggle script /
 * style / event handlers — only the three permitted tags survive.
 *
 * Time-chip detection (splitWithTimes) operates on the RAW text, so the
 * caller passes each plain-text segment through formatStepText() AFTER
 * splitting. This way "Bake **15 minutes**" still renders the time
 * chip on "15 minutes" and the bold on the surrounding word(s).
 */

import { displayQty, unitFamily, isKnownUnit } from './quantity.js';

function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a step-text fragment with bold / italic / underline markdown.
 * Returns an HTML string safe to inject via {@html ...}.
 */
export function formatStepText(text) {
  if (!text) return '';
  let out = _escapeHtml(text);
  // Bold: **...** — must come before italic so "**word**" isn't
  // mis-parsed as two italic *word*s.
  out = out.replace(/\*\*([^\*\n]+)\*\*/g, '<strong>$1</strong>');
  // Italic: *...*
  out = out.replace(/\*([^\*\n]+)\*/g, '<em>$1</em>');
  // Underline: __...__
  out = out.replace(/__([^_\n]+)__/g, '<u>$1</u>');
  return out;
}

// ── Amounts in step text follow the servings ───────────────────────────
// "Whisk in 2 cups of milk" doubled reads "4 cups". Only measures are
// scaled (cups, spoons, grams, millilitres, ounces, pounds, and ranges of
// them): times, temperatures, pan sizes and plain counts ("cut into 4
// pieces") stay as written.

const _VULG = '½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞';
const _QTY = `(?:\\d+\\s*[${_VULG}]|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:[.,]\\d+)?|[${_VULG}])`;
const _DASH = '-' + String.fromCharCode(0x2013, 0x2014);
const _AMOUNT_RX = new RegExp(
  `(^|[^\\w./°${_VULG}])(${_QTY}(?:\\s*(?:[${_DASH}]|to)\\s*${_QTY})?)(\\s?)([A-Za-z]+\\.?(?:\\s+oz\\b)?)(?![A-Za-z])`, 'g');
// One-letter spellings that are words too often to scale ("2 c", "1 t").
const _TOO_SHORT = new Set(['c', 't']);

function _isMeasure(word) {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (_TOO_SHORT.has(w) || !isKnownUnit(w)) return false;
  const fam = unitFamily(w);
  return fam === 'volume' || fam === 'weight';
}

// An amount for each of something ("2 tbsp of batter per pancake", "1/4
// cup at a time") is the same however many are made: it stays.
const _PER_RX = /^[^.,;:!?\n]{0,40}?\b(?:per|each|apiece|at a time)\b/i;

// Full unit words follow the number ("1 cup", "2 cups"); abbreviations
// (tbsp, g, ml) read the same either way and stay as written.
const _PLURALS = {
  cup: 'cups', teaspoon: 'teaspoons', tablespoon: 'tablespoons', pint: 'pints', quart: 'quarts',
  gallon: 'gallons', ounce: 'ounces', pound: 'pounds', gram: 'grams', kilogram: 'kilograms',
  liter: 'liters', litre: 'litres', milliliter: 'milliliters', millilitre: 'millilitres',
};
const _SINGULARS = Object.fromEntries(Object.entries(_PLURALS).map(([a, b]) => [b, a]));
function _unitFor(unit, shown) {
  const lower = unit.toLowerCase();
  const many = !/^(?:1|0?\.\d+|\d+\/\d+)$/.test(shown.trim());
  const swap = many ? _PLURALS[lower] : _SINGULARS[lower];
  if (!swap) return unit;
  return unit[0] === unit[0].toUpperCase() ? swap[0].toUpperCase() + swap.slice(1) : swap;
}

function _eachAmount(text, factor, emit) {
  let last = 0;
  String(text).replace(_AMOUNT_RX, (whole, lead, qty, gap, unit, at) => {
    if (!_isMeasure(unit)) return whole;
    if (_PER_RX.test(text.slice(at + whole.length))) return whole;
    const start = at + lead.length;
    if (start > last) emit('text', text.slice(last, start));
    const scaled = displayQty(qty.replace(/\s*to\s*/i, '-'), unit, factor);
    emit('amount', `${scaled}${gap}${_unitFor(unit, scaled)}`);
    last = start + qty.length + gap.length + unit.length;
    return whole;
  });
  if (last < String(text).length) emit('text', String(text).slice(last));
}

/**
 * Step text with its measures scaled, as plain parts for a page that
 * prints text: [{ type: 'text' | 'amount', value }]. factor 1: one part.
 */
export function scaledStepParts(text, factor) {
  if (!text || !factor || factor === 1) return [{ type: 'text', value: text || '' }];
  const parts = [];
  _eachAmount(text, factor, (type, value) => parts.push({ type, value }));
  return parts;
}

// Marks around a scaled amount that survive formatStepText's escaping.
const _OPEN = String.fromCharCode(0xE000), _CLOSE = String.fromCharCode(0xE001);

/** Step text with its measures scaled, marked for scaledAmountHtml(). */
export function scaleStepText(text, factor) {
  if (!text || !factor || factor === 1) return text;
  let out = '';
  _eachAmount(text, factor, (type, value) => { out += type === 'amount' ? _OPEN + value + _CLOSE : value; });
  return out;
}

/** After formatStepText(): each scaled amount in a span the page tints. */
export function scaledAmountHtml(html) {
  if (!html || html.indexOf(_OPEN) < 0) return html;
  return html.split(_OPEN).map((piece, i) => {
    if (i === 0) return piece;
    const end = piece.indexOf(_CLOSE);
    return end < 0 ? piece : `<span class="step-amount">${piece.slice(0, end)}</span>${piece.slice(end + 1)}`;
  }).join('');
}
