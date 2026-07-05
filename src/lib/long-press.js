/**
 * long-press.js — Svelte action for long-press / right-click menus.
 *
 * Usage:
 *   <button use:longpress={{ duration: 500 }} on:longpress={...}>
 *
 * Fires `longpress` event with `{ x, y, target }` so the consumer can
 * position a context menu where the press happened. Cancels on touch
 * move ≥ 8px so scrolling past a card doesn't trigger.
 *
 * Right-click (contextmenu) on desktop also fires the same event for
 * keyboard/mouse users.
 */
export function longpress(node, opts = {}) {
  const duration = opts.duration ?? 500;
  let timer = null;
  let startX = 0, startY = 0;
  let cancelled = false;

  let activePointer = null;

  function fire(x, y) {
    cancelled = true;
    node.dispatchEvent(new CustomEvent('longpress', { detail: { x, y, target: node } }));
    // Cancel the in-flight pointer stream so any drag-tracking lib
    // (svelte-dnd-action, scroll containers, etc.) releases the
    // touch. Without this, the finger stays "held" from Android's
    // POV after the menu opens and continued finger drift feeds
    // pointer-moves into a still-listening reorder gesture.
    if (activePointer) {
      try {
        node.dispatchEvent(new PointerEvent('pointercancel', {
          pointerId:   activePointer.pointerId,
          pointerType: activePointer.pointerType,
          bubbles:     true,
          cancelable:  true,
        }));
      } catch { /* PointerEvent unsupported */ }
    }
  }
  function clear() { if (timer) { clearTimeout(timer); timer = null; } }

  function onPointerDown(e) {
    cancelled = false;
    startX = e.clientX; startY = e.clientY;
    activePointer = { pointerId: e.pointerId, pointerType: e.pointerType };
    timer = setTimeout(() => fire(e.clientX, e.clientY), duration);
  }
  function onPointerMove(e) {
    if (!timer) return;
    if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) clear();
  }
  function onPointerEnd() { clear(); }
  function onContext(e) {
    e.preventDefault();
    fire(e.clientX, e.clientY);
  }
  function onClick(e) {
    // If a long-press fired, suppress the click that would otherwise
    // navigate.
    if (cancelled) { e.preventDefault(); e.stopPropagation(); cancelled = false; }
  }

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', onPointerEnd);
  node.addEventListener('pointercancel', onPointerEnd);
  node.addEventListener('pointerleave', onPointerEnd);
  node.addEventListener('contextmenu', onContext);
  node.addEventListener('click', onClick, true);
  return {
    destroy() {
      clear();
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerEnd);
      node.removeEventListener('pointercancel', onPointerEnd);
      node.removeEventListener('pointerleave', onPointerEnd);
      node.removeEventListener('contextmenu', onContext);
      node.removeEventListener('click', onClick, true);
    },
  };
}
