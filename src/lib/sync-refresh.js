/**
 * sync-refresh.js: a page reads its data again when a sync brings changes
 * down (Android, server mode). Pages read the phone's copy once, when they
 * open; without this, the first sync after signing in filled the copy
 * while the page went on showing it empty ("No Recipes Yet") until it was
 * opened again. Changes are rows that came down or went (sync.js
 * `changed`), not the small sets sent whole every time.
 *
 * Returns the remover, so a page can hand it to onMount.
 */
export function onSyncChanges(fn) {
  if (typeof window === 'undefined') return () => {};
  const handler = e => {
    const d = e?.detail;
    if (d?.ok && Number(d.changed) > 0) fn(d);
  };
  window.addEventListener('ct:sync-complete', handler);
  return () => window.removeEventListener('ct:sync-complete', handler);
}
