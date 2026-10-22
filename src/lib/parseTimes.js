/**
 * parseTimes: the times a step mentions, so each becomes a timer one tap
 * starts (#77).
 *
 * In every language in time-words/time-words.json at once, since a recipe is
 * written in its cook's language, whatever language the app is in:
 *   "30 min", "30 minutes", "30 minutos", "30 Minuten", "30 минут"
 *   "2 hours", "2 h", "2 horas", "2 Std.", "2 timmar"
 *   "1 hour 30 min", "1 hora y 30 minutos", "1 Stunde und 30 Minuten", "1h30"
 *   "30 to 45 min", "30-45 min", "20 a 25 minutos", "20 bis 25 Minuten":
 *     the lower bound (a cook would rather check early)
 *   "1.5 hours", "1,5 horas", "1 1/2 hours"
 *   "an hour", "una hora", "half an hour", "media hora", "полчаса"
 *   "1 hour and a half", "una hora y media", "1 heure et demie"
 *
 * The watch finds the same times its own way (android/wear Kitchen.kt), from
 * the same words; scripts/step-times.json holds what both must find.
 */
import WORDS from './time-words/time-words.json' with { type: 'json' };

const LANGS = Object.entries(WORDS).filter(([k]) => !k.startsWith('_')).map(([, v]) => v);
const _esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Every language's words of a kind, longest first, as one alternation.
const _any = (kind) => {
  const all = [...new Set(LANGS.flatMap(l => l[kind] || []).map(w => w.toLowerCase()))];
  return all.length ? `(?:${all.sort((a, b) => b.length - a.length).map(_esc).join('|')})` : '(?!)';
};
const PHRASES = new Map(LANGS.flatMap(l => Object.entries(l.phrases || {})).map(([p, s]) => [p.toLowerCase(), s]));

// A number: "1 1/2", "1/2", "1.5", "1,5", "20".
const NUM = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:[.,]\\d+)?)';
const HOUR = _any('hour');
// "Std", "hr": an hour word that is an abbreviation, which can take a dot
// before its minutes ("1 Std. 30 Min.") where a whole word's dot ends the
// sentence ("Simmer 1 hour. 10 minutes before serving...").
const HOUR_ABBR = _any('hour_abbr');
const MIN = _any('minute');
const SEC = _any('second');
const ONE = _any('one');
// A unit ends where its word does. An abbreviation's dot ("Std.") stays
// with the sentence, which it may also be ending.
const END = '(?!\\p{L})';
// Joining an hour and its minutes: "1 hour 30 min", "1 hora y 30 minutos",
// "1h30min".
const AND = `(?:\\s*(?:,|${_any('and')}(?!\\p{L}))\\s*|\\s*)`;
// The hour of an hour and its minutes.
const HOUR_OF = `(?:${HOUR}${END}|${HOUR_ABBR}\\.)`;
const TO = `\\s*(?:-|\\u2013|\\u2014|${_any('to')}(?!\\p{L}))\\s*`;
const AND_HALF = `\\s*${_any('and_half')}(?!\\p{L})`;
const PHRASE = PHRASES.size
  ? `(?:${[...PHRASES.keys()].sort((a, b) => b.length - a.length).map(_esc).join('|')})(?!\\p{L})`
  : '(?!)';

const PATTERN = new RegExp(
  '(' +
    PHRASE + '|' +
    `(?:${NUM}\\s*|${ONE}\\s+)${HOUR}${END}${AND_HALF}` + '|' +
    `${NUM}\\s*${HOUR_OF}${AND}${NUM}\\s*${MIN}${END}` + '|' +
    // French "1h30", "2 h 15": an hour and bare minutes, two of them when
    // spaced so "1 h 3 eggs" is not three minutes past. A sentence may end
    // right after ("1h30."), a decimal may not ("1h30.5").
    `\\d+\\s*h(?:\\d{1,2}|\\s+\\d{2})(?![\\d\\p{L}]|[.,]\\d)` + '|' +
    `${NUM}${TO}${NUM}\\s*(?:${HOUR}|${MIN}|${SEC})${END}` + '|' +
    `${NUM}\\s*(?:${HOUR}|${MIN}|${SEC})${END}` + '|' +
    // "an hour", "una hora": one, said as a word, of hours only.
    `${ONE}\\s+${HOUR}${END}` +
  ')',
  'giu'
);

function _num(s) {
  const t = String(s || '').trim();
  const mixed = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed && +mixed[3] > 0) return +mixed[1] + +mixed[2] / +mixed[3];
  const frac = t.match(/^(\d+)\/(\d+)$/);
  if (frac && +frac[2] > 0) return +frac[1] / +frac[2];
  if (new RegExp(`^${ONE}$`, 'iu').test(t)) return 1;
  const f = parseFloat(t.replace(',', '.'));
  return Number.isFinite(f) ? f : NaN;
}

function _unitSeconds(u) {
  const s = String(u || '').toLowerCase().replace(/\.$/, '');
  if (new RegExp(`^${HOUR}$`, 'u').test(s)) return 3600;
  if (new RegExp(`^${MIN}$`, 'u').test(s)) return 60;
  return 1;
}

function _seconds(matched) {
  const text = matched.toLowerCase();
  if (PHRASES.has(text)) return PHRASES.get(text);
  let m = text.match(new RegExp(`^(${NUM}|${ONE})\\s*${HOUR}${END}${AND_HALF}$`, 'u'));
  if (m) return Math.round((_num(m[1]) + 0.5) * 3600);
  m = text.match(new RegExp(`^(${NUM})\\s*${HOUR_OF}${AND}(${NUM})\\s*${MIN}$`, 'u'));
  if (m) return Math.round(_num(m[1]) * 3600 + _num(m[2]) * 60);
  m = text.match(/^(\d+)\s*h\s*(\d{1,2})$/);
  if (m) return +m[1] * 3600 + +m[2] * 60;
  m = text.match(new RegExp(`^(${NUM})${TO}(${NUM})\\s*(\\p{L}+)$`, 'u'));
  if (m) return Math.round(Math.min(_num(m[1]), _num(m[2])) * _unitSeconds(m[3]));
  m = text.match(new RegExp(`^(${NUM}|${ONE})\\s*(\\p{L}+)$`, 'u'));
  if (m) return Math.round(_num(m[1]) * _unitSeconds(m[2]));
  return 0;
}

/**
 * Every time a text mentions: `[{ start, end, text, durationSec }]` in text
 * order, for splicing a timer button in at each.
 */
export function findTimes(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  PATTERN.lastIndex = 0;
  let m;
  while ((m = PATTERN.exec(text)) !== null) {
    // A time starts its own word: not the "0 min" inside "20 min", nor the
    // "en h" at the end of a longer word.
    if (m.index > 0 && /[\p{L}\p{N}.,/]/u.test(text[m.index - 1])) {
      PATTERN.lastIndex = m.index + 1;
      continue;
    }
    const sec = _seconds(m[0]);
    if (sec > 0 && sec <= 24 * 3600) out.push({ start: m.index, end: m.index + m[0].length, text: m[0], durationSec: sec });
  }
  return out;
}

/**
 * Text as `{ type: 'text' | 'time', value }` parts, each time with its
 * `durationSec`, for rendering a play button at each.
 */
export function splitWithTimes(text) {
  if (!text || typeof text !== 'string') return [{ type: 'text', value: text || '' }];
  const matches = findTimes(text);
  if (matches.length === 0) return [{ type: 'text', value: text }];
  const parts = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) parts.push({ type: 'text', value: text.slice(cursor, m.start) });
    parts.push({ type: 'time', value: m.text, durationSec: m.durationSec });
    cursor = m.end;
  }
  if (cursor < text.length) parts.push({ type: 'text', value: text.slice(cursor) });
  return parts;
}
