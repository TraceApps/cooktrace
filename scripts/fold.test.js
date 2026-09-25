import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldFromFeatures, foldFromSegments, sizeClassFor, columnsAcrossFold, keepOffCrease } from '../src/lib/fold-core.js';

test('size classes', () => {
  assert.equal(sizeClassFor(344), 'compact');
  assert.equal(sizeClassFor(599), 'compact');
  assert.equal(sizeClassFor(600), 'medium');
  assert.equal(sizeClassFor(882), 'medium');
  assert.equal(sizeClassFor(1024), 'expanded');
});

test('a flat fold is ignored; half open gives book or tabletop', () => {
  const f = (state, orientation, extra = {}) => ({ features: [{ state, orientation, separating: false, left: 440, right: 442, top: 0, bottom: 1104, ...extra }] });
  assert.equal(foldFromFeatures(f('flat', 'vertical')), null);
  assert.deepEqual(foldFromFeatures(f('half_opened', 'vertical')), { posture: 'book', start: 440, end: 442 });
  assert.deepEqual(foldFromFeatures(f('half_opened', 'horizontal', { left: 0, right: 1104, top: 441, bottom: 441 })), { posture: 'tabletop', start: 441, end: 441 });
  assert.deepEqual(foldFromFeatures(f('flat', 'vertical', { separating: true })), { posture: 'book', start: 440, end: 442 });
  assert.equal(foldFromFeatures({ features: [] }), null);
  assert.equal(foldFromFeatures(null), null);
});

test('viewport segments', () => {
  assert.equal(foldFromSegments([{ x: 0, y: 0, width: 800, height: 600 }]), null);
  assert.deepEqual(foldFromSegments([{ x: 0, y: 0, width: 400, height: 900 }, { x: 420, y: 0, width: 400, height: 900 }]), { posture: 'book', start: 400, end: 420 });
  assert.deepEqual(foldFromSegments([{ x: 0, y: 0, width: 900, height: 400 }, { x: 0, y: 400, width: 900, height: 400 }]), { posture: 'tabletop', start: 400, end: 400 });
});

test('a book fold splits a grid into columns either side of the crease', () => {
  // A 1000px grid at the left edge, creased between 480 and 520.
  const fold = { posture: 'book', start: 480, end: 520 };
  const split = columnsAcrossFold({ width: 1000, left: 0, gap: 16, minCard: 236, fold });
  assert.deepEqual(split, { left: 1, right: 1, hinge: 40 });

  // Wider cards either side give more of them.
  const wide = columnsAcrossFold({ width: 2000, left: 0, gap: 16, minCard: 236, fold: { posture: 'book', start: 980, end: 1020 } });
  assert.deepEqual(wide, { left: 3, right: 3, hinge: 40 });
});

test('the grid keeps its own layout when the crease misses it', () => {
  const beside = { posture: 'book', start: 100, end: 140 };
  // The grid sits to the right of the fold, next to a sidebar.
  assert.equal(columnsAcrossFold({ width: 800, left: 300, gap: 16, minCard: 236, fold: beside }), null);
  // Flat, or tabletop, is not a vertical crease.
  assert.equal(columnsAcrossFold({ width: 800, left: 0, gap: 16, minCard: 236, fold: null }), null);
  assert.equal(columnsAcrossFold({ width: 800, left: 0, gap: 16, minCard: 236, fold: { posture: 'tabletop', start: 400, end: 440 } }), null);
});

test('a side with no room for a card is left unsplit', () => {
  // The crease sits 80px in: one column on the left would be unreadable.
  const tight = { posture: 'book', start: 80, end: 120 };
  assert.equal(columnsAcrossFold({ width: 900, left: 0, gap: 16, minCard: 236, fold: tight }), null);
});

test('a floating panel slides to the side of the crease it leans towards', () => {
  const crease = { start: 480, end: 520, min: 12, max: 1000 };
  // Mostly left of the crease: it goes fully left, ending where the crease starts.
  assert.equal(keepOffCrease({ pos: 380, size: 200, ...crease }), 280);
  // Mostly right: it starts where the crease ends.
  assert.equal(keepOffCrease({ pos: 460, size: 300, ...crease }), 520);
});

test('a panel already clear of the crease is left alone', () => {
  const crease = { start: 480, end: 520, min: 12, max: 1000 };
  assert.equal(keepOffCrease({ pos: 100, size: 200, ...crease }), 100);
  assert.equal(keepOffCrease({ pos: 600, size: 200, ...crease }), 600);
  // No crease at all.
  assert.equal(keepOffCrease({ pos: 300, size: 200, start: 0, end: 0, min: 0, max: 1000 }), 300);
});

test('a panel too big for either side stays where it was put', () => {
  // 900 wide with a crease at 480: neither side can hold it, and pushing it
  // off screen would be worse than leaving it across the fold.
  assert.equal(keepOffCrease({ pos: 50, size: 900, start: 480, end: 520, min: 12, max: 1000 }), 50);
});
