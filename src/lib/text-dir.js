/**
 * text-dir.js: which way a piece of text reads, decided the way dir="auto"
 * decides it: by its first letter. Arabic, Hebrew and the other
 * right-to-left scripts read right to left; any other letter left to right.
 * Text with no letters at all (numbers, symbols, nothing) has no direction of
 * its own and takes its surroundings' (undefined, so dir={...} is left off).
 *
 * dir="auto" on a text field reads the field itself, not the row around it.
 * A row (box, text, buttons) takes its direction from here, so an Arabic
 * checklist item has its box on the right (TraceApps/notetrace#21).
 */

// Scripts written right to left, by Unicode script. Only scripts from
// Unicode 9 or earlier: a script name an older WebView doesn't know is a
// syntax error, and this whole file would fail to load.
const RTL = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Mende_Kikakui}\p{Script=Old_South_Arabian}\p{Script=Old_North_Arabian}\p{Script=Imperial_Aramaic}\p{Script=Phoenician}]/u;
const LETTER = /\p{L}/u;

// The invisible direction marks count as letters, as they do for dir="auto":
// right-to-left mark and Arabic letter mark, left-to-right mark.
const RTL_MARK = /[\u200F\u061C]/;
const LTR_MARK = '\u200E';

/** 'rtl', 'ltr', or undefined when the text has no letter to go by. */
export function textDir(text) {
  for (const ch of String(text ?? '')) {
    if (RTL_MARK.test(ch)) return 'rtl';
    if (ch === LTR_MARK) return 'ltr';
    if (LETTER.test(ch)) return RTL.test(ch) ? 'rtl' : 'ltr';
  }
  return undefined;
}

/**
 * The directions of a list's lines, where a line with no letters yet (a new
 * empty item) reads like the one above it: Enter after an Arabic item leaves
 * the new one on the right.
 */
export function lineDirs(texts) {
  let last;
  return texts.map((text) => (last = textDir(text) || last));
}
