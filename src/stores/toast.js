import { writable } from 'svelte/store';

export const toasts = writable([]);

let _id = 0;

function _dismiss(id) {
  toasts.update(list => list.filter(t => t.id !== id));
}

// `action` is optional: { label, onClick }. Tapping it runs onClick and
// dismisses the toast right away.
export function showToast(message, duration = 3000, type = 'default', action = null) {
  const id = ++_id;
  const wrapped = action
    ? { label: action.label, run: () => { _dismiss(id); action.onClick(); } }
    : null;
  toasts.update(list => [...list, { id, message, type, action: wrapped }]);
  setTimeout(() => _dismiss(id), duration);
}

export function showSuccess(msg) { showToast(msg, 2500, 'success'); }
export function showError(msg)   { showToast(msg, 4000, 'error'); }
export function showInfo(msg)    { showToast(msg, 3000, 'info'); }
export function showUndo(msg, onUndo, label = 'Undo') {
  showToast(msg, 6000, 'success', { label, onClick: onUndo });
}
