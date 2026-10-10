/**
 * version-text.js: a recipe version's changes (recipe-content.js
 * changeSummary) in words, for History, a version's page and a cook's
 * "as you made it". `t` is svelte-i18n's $_.
 */
import { formatDuration } from './duration.js';

const DETAIL_KEYS = {
  servings: 'history.detail_servings',
  yield_text: 'history.detail_yield',
  prep_minutes: 'history.detail_prep',
  cook_minutes: 'history.detail_cook',
  rest_minutes: 'history.detail_rest',
  total_minutes: 'history.detail_total',
};

function _detailValue(t, field, v) {
  if (v == null || v === '') return t('history.none');
  if (field.endsWith('_minutes')) return formatDuration(v) || String(v);
  return String(v);
}

/** The name of a detail field: "Servings", "Prep time". */
export const detailLabel = (t, field) => t(DETAIL_KEYS[field] || 'history.detail_servings');

/** One change, as a short line: "Flour: 300 g → 250 g", "Added sugar", "Step 2 edited". */
export function changeText(t, c) {
  switch (c.kind) {
    case 'ingredient_changed': return t('history.change_changed', { values: { name: c.name, from: c.from || t('history.none'), to: c.to || t('history.none') } });
    case 'ingredient_added': return t('history.change_added', { values: { name: c.name } });
    case 'ingredient_removed': return t('history.change_removed', { values: { name: c.name } });
    case 'step_changed': return t('history.change_step_changed', { values: { n: c.n } });
    case 'step_added': return t('history.change_step_added', { values: { n: c.n } });
    case 'step_removed': return t('history.change_step_removed', { values: { n: c.n } });
    case 'detail': return t('history.change_detail', {
      values: { what: t(DETAIL_KEYS[c.field] || 'history.detail_servings'), from: _detailValue(t, c.field, c.from), to: _detailValue(t, c.field, c.to) },
    });
    default: return '';
  }
}

/** The first `max` changes as lines, and how many more there are. */
export function changeLines(t, changes, max = 3) {
  const lines = (changes || []).slice(0, max).map(c => changeText(t, c));
  return { lines, more: Math.max(0, (changes || []).length - max) };
}

/** A version's servings, yield and times, as label and value pairs. */
export function detailRows(t, data) {
  return Object.keys(DETAIL_KEYS)
    .filter(f => data?.[f] != null && data[f] !== '')
    .map(f => ({ field: f, label: t(DETAIL_KEYS[f]), value: _detailValue(t, f, data[f]) }));
}
