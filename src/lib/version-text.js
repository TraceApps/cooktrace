/**
 * version-text.js: a recipe version's changes (recipe-content.js
 * changeSummary) in words, for History, a version's page and a cook's
 * "as you made it". `t` is svelte-i18n's $_.
 */
import { formatDuration } from './duration.js';
import { changeSummary } from './recipe-content.js';

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

/** A version as named in a list: "Version 3" or "Version 3: Less flour". */
export const versionName = (t, v) => (v?.label
  ? t('history.version_named', { values: { n: v.number, label: v.label } })
  : t('history.version', { values: { n: v?.number } }));

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

/**
 * A recipe's history for Trace: each version's changes in words, its cooks
 * and average rating, the best-rated version and what changed from it to
 * now, so the model reads the answer rather than working it out.
 */
export function historyForTrace(t, recipe, h) {
  const versions = h?.revisions || [];
  const avg = v => {
    const r = (v.cooks || []).map(c => Number(c.rating)).filter(n => n > 0);
    return r.length ? Math.round((r.reduce((a, b) => a + b, 0) / r.length) * 10) / 10 : null;
  };
  const lines = (a, b) => changeSummary(a, b).map(c => changeText(t, c));
  const rated = versions.filter(v => avg(v) != null);
  const best = rated.length ? rated.reduce((x, y) => (avg(y) >= avg(x) ? y : x)) : null;
  const current = versions.find(v => v.current) || versions[versions.length - 1] || null;
  return {
    recipe: recipe?.name || '',
    versions: versions.map((v, i) => ({
      version: v.number,
      name: v.label || null,
      saved: String(v.created_at || '').slice(0, 10),
      current: !!v.current,
      changes_from_previous: i > 0 ? lines(versions[i - 1].data, v.data) : [],
      cooks: (v.cooks || []).map(c => ({ date: c.date, rating: c.rating || null, notes: c.notes || null })),
      average_rating: avg(v),
    })),
    best_rated_version: best ? { version: best.number, name: best.label || null, average_rating: avg(best) } : null,
    changes_from_best_to_now: best && current && best.rev !== current.rev ? lines(best.data, current.data) : [],
    cooks_before_history: (h?.unversioned || []).length,
  };
}
