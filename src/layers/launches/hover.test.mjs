import test from 'node:test';
import assert from 'node:assert/strict';
import { Event } from 'cesium';
import { createLaunchHover } from './lifecycle.js';

test('mission hover throttles, clears on motion/hidden, and releases listeners', () => {
  let at = 0,
    picks = 0,
    enabled = true;
  const listeners = new Set();
  const doc = {
    hidden: false,
    addEventListener: (_n, fn) => listeners.add(fn),
    removeEventListener: (_n, fn) => listeners.delete(fn),
  };
  const viewer = {
    camera: { moveStart: new Event(), moveEnd: new Event() },
    scene: {
      canvas: { style: {} },
      drillPick() {
        picks++;
        return [{ id: 'launch' }];
      },
    },
  };
  const hover = createLaunchHover({
    viewer,
    enabled: () => enabled,
    entityLaunchId: (id) => id === 'launch',
    now: () => at,
    documentRef: doc,
    pointerFree: () => true,
  });
  for (at = 0; at < 120; at++) hover.move({ endPosition: {} });
  assert.equal(picks, 1);
  assert.equal(viewer.scene.canvas.style.cursor, 'pointer');
  hover.move({ endPosition: {} });
  assert.equal(picks, 2);
  viewer.camera.moveStart.raiseEvent();
  at = 500;
  hover.move({ endPosition: {} });
  assert.equal(picks, 2);
  assert.equal(viewer.scene.canvas.style.cursor, '');
  viewer.camera.moveEnd.raiseEvent();
  hover.move({ endPosition: {} });
  assert.equal(picks, 3);
  doc.hidden = true;
  for (const fn of listeners) fn();
  hover.move({ endPosition: {} });
  assert.equal(picks, 3);
  assert.equal(viewer.scene.canvas.style.cursor, '');
  doc.hidden = false;
  enabled = false;
  hover.move({ endPosition: {} });
  assert.equal(picks, 3);
  hover.destroy();
  assert.equal(listeners.size, 0);
  assert.equal(viewer.camera.moveStart.numberOfListeners, 0);
  assert.equal(viewer.camera.moveEnd.numberOfListeners, 0);
});

test('mission hover preserves the cursor of a pointer-owning tool', () => {
  let free = true,
    picks = 0;
  const viewer = {
    camera: { moveStart: new Event(), moveEnd: new Event() },
    scene: {
      canvas: { style: { cursor: '' } },
      drillPick() {
        picks++;
        return [{ id: 'launch' }];
      },
    },
  };
  const hover = createLaunchHover({
    viewer,
    enabled: () => true,
    entityLaunchId: () => true,
    documentRef: null,
    pointerFree: () => free,
  });
  hover.move({ endPosition: {} });
  assert.equal(viewer.scene.canvas.style.cursor, 'pointer');
  free = false;
  viewer.scene.canvas.style.cursor = 'crosshair';
  hover.move({ endPosition: {} });
  viewer.camera.moveStart.raiseEvent();
  hover.destroy();
  assert.equal(picks, 1);
  assert.equal(viewer.scene.canvas.style.cursor, 'crosshair');
});
