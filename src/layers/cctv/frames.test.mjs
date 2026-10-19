// src/layers/cctv/frames.test.mjs
// Still-frame fit (#1201): stills draw at their source aspect, centered on the
// 1920x1080 projection canvas, instead of being stretched to fill it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitToProjection } from './frames.js';

const FULL_CANVAS = { x: 0, y: 0, w: 1920, h: 1080 };

test('a 4:3 still is pillarboxed at full height', () => {
  assert.deepEqual(fitToProjection(640, 480), {
    x: 240,
    y: 0,
    w: 1440,
    h: 1080,
  });
});

test('a source wider than 16:9 is letterboxed at full width', () => {
  assert.deepEqual(fitToProjection(3840, 1080), {
    x: 0,
    y: 270,
    w: 1920,
    h: 540,
  });
});

test('a 16:9 still fills the canvas', () => {
  assert.deepEqual(fitToProjection(1920, 1080), FULL_CANVAS);
});

test('a missing or zero dimension falls back to the full canvas', () => {
  assert.deepEqual(fitToProjection(0, 480), FULL_CANVAS);
  assert.deepEqual(fitToProjection(640, 0), FULL_CANVAS);
  assert.deepEqual(fitToProjection(640, undefined), FULL_CANVAS);
  assert.deepEqual(fitToProjection(undefined, undefined), FULL_CANVAS);
});
