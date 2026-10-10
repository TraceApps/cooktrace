/**
 * week.js: weeks as the person's locale has them, and what a week's plan
 * needs from the pantry and the shop.
 */
import { ingredientKey } from './quantity.js';
import { parseSources } from './shopping-plan.js';

// Regions whose weeks start on Sunday, for browsers without Intl weekInfo.
const SUNDAY_REGIONS = new Set(['US', 'CA', 'MX', 'BR', 'JP', 'KR', 'TW', 'HK', 'IL', 'PH', 'ZA', 'IN', 'AU', 'SA', 'PE', 'CO', 'VE', 'GT', 'HN', 'PA', 'PR', 'DO', 'SV', 'NI', 'BO', 'PY', 'EC', 'KE', 'ET', 'ZW', 'BZ', 'JM', 'TH', 'KH', 'LA', 'MO', 'MT', 'ID', 'PK', 'BD', 'NP', 'BT', 'UM', 'VI', 'GU', 'AS', 'MH', 'WS']);

/** The first day of the week for a locale, as Date#getDay counts (0 Sunday, 1 Monday...). */
export function firstDayOfWeek(locale) {
  const tag = locale || (typeof navigator !== 'undefined' ? navigator.language : 'en-US') || 'en-US';
  try {
    const L = new Intl.Locale(tag);
    const info = typeof L.getWeekInfo === 'function' ? L.getWeekInfo() : L.weekInfo;
    if (info && Number.isInteger(info.firstDay)) return info.firstDay % 7;
    const region = (L.maximize?.().region) || L.region;
    if (region) return SUNDAY_REGIONS.has(region) ? 0 : 1;
  } catch { /* an odd tag: below */ }
  return /-US$/i.test(tag) || tag === 'en' ? 0 : 1;
}

/** A date as YYYY-MM-DD, by the local calendar. */
export function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A YYYY-MM-DD string as a local Date at midnight. */
export function fromIso(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** The first day of the week the date falls in. */
export function weekStartOf(date, firstDay = firstDayOfWeek()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() - firstDay + 7) % 7));
  return d;
}

/** The week's seven days from its first: [{ iso, date }]. */
export function weekDays(start) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { iso: isoDay(d), date: d };
  });
}

/** Short weekday names in week order ("Mon", "Tue"... or "Sun" first). */
export function weekdayNames(locale, firstDay = firstDayOfWeek(), style = 'short') {
  const fmt = new Intl.DateTimeFormat(locale || undefined, { weekday: style });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + ((firstDay + i) % 7))));
}

/** "Oct 5 – 11" or "Sep 28 – Oct 4": the week as a date range. */
export function weekRangeLabel(start, locale) {
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const fmt = new Intl.DateTimeFormat(locale || undefined, { month: 'short', day: 'numeric' });
  return typeof fmt.formatRange === 'function' ? fmt.formatRange(start, end) : `${fmt.format(start)} - ${fmt.format(end)}`;
}

/**
 * How far ahead "about to expire" looks for a week's plan: to the week's
 * end, and at least a week from today (late in a week, its end is close).
 */
export function planHorizon(weekEnd, today) {
  const t = fromIso(today); t.setDate(t.getDate() + 7);
  const h = isoDay(t);
  return weekEnd && weekEnd > h ? weekEnd : h;
}

/**
 * What a week's plan needs. planned: the week's planned cooks; recipes: by
 * id, with ingredients; pantry: the pantry rows; list: the shopping list.
 * Returns { meals, toBuy, inPantry, expiring, built }:
 *   toBuy: ingredients the plan needs that aren't in stock
 *   inPantry: ingredients the plan needs that are
 *   expiring: in-stock pantry items the plan uses that expire by the
 *     week's end (or within a week of today, whichever is later)
 *   built: whether the list already holds this week's plan
 */
export function weekNeeds({ planned, recipes, pantry, list, weekEnd, today }) {
  const byId = new Map((pantry || []).map(p => [p.id, p]));
  // In stock: itself, or a generic item with a variant in stock (as the server counts).
  const stocked = new Set();
  for (const p of pantry || []) {
    if (!p.in_stock) continue;
    stocked.add(p.id);
    if (p.generic_parent_id != null) stocked.add(p.generic_parent_id);
  }
  const horizon = planHorizon(weekEnd, today);
  const need = new Set(), have = new Set(), expiring = new Set();
  for (const e of planned || []) {
    const r = recipes?.get?.(e.recipe_id);
    let groups = r?.ingredients;
    if (typeof groups === 'string') { try { groups = JSON.parse(groups); } catch { groups = []; } }
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const it of g?.items || []) {
        if (!it?.name) continue;
        const linked = it.pantry_item_id != null && byId.has(it.pantry_item_id);
        const key = linked ? `p:${it.pantry_item_id}` : `n:${ingredientKey(it.name)}`;
        if (linked && stocked.has(it.pantry_item_id)) {
          have.add(key);
          const p = byId.get(it.pantry_item_id);
          if (p?.expires_on && p.in_stock && String(p.expires_on).slice(0, 10) <= horizon) expiring.add(p.id);
        } else {
          need.add(key);
        }
      }
    }
  }
  const ids = new Set((planned || []).map(e => e.id));
  const built = (list || []).some(row => parseSources(row.sources).some(s => s.diary_id != null && ids.has(s.diary_id)));
  return { meals: (planned || []).length, toBuy: need.size, inPantry: have.size, expiring: expiring.size, built };
}
