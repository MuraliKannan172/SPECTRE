import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PANO_FOV_MAX_DEG,
  PANO_FOV_MIN_DEG,
  PANO_PITCH_LIMIT_DEG,
  clampFov,
  clampPitch,
  rayToUv,
  wrapDegrees,
} from './panorama.js';

const close = (actual, expected) =>
  actual.forEach((value, i) =>
    assert.ok(Math.abs(value - expected[i]) < 1e-9, `${actual} ≉ ${expected}`),
  );

test('straight ahead samples the image centre; yaw turns right, pitch looks up', () => {
  close(rayToUv([0, 0, -1]), [0.5, 0.5]);
  close(rayToUv([0, 0, -1], { yaw: 90 }), [0.75, 0.5]);
  close(rayToUv([0, 0, -1], { yaw: -90 }), [0.25, 0.5]);
  close(rayToUv([0, 0, -1], { pitch: 45 }), [0.5, 0.25]);
  close(rayToUv([0, 0, -1], { pitch: -90 }), [0.5, 1]);
  // Pitch first, then yaw: looking up-right stays up.
  close(rayToUv([0, 0, -1], { yaw: 90, pitch: 45 }), [0.75, 0.25]);
  // A ray to the right of the screen is the same as turning right.
  close(rayToUv([1, 0, 0]), [0.75, 0.5]);
});

test('view limits: pitch stops short of the poles, field of view stays usable', () => {
  assert.equal(clampPitch(120), PANO_PITCH_LIMIT_DEG);
  assert.equal(clampPitch(-120), -PANO_PITCH_LIMIT_DEG);
  assert.equal(clampFov(5), PANO_FOV_MIN_DEG);
  assert.equal(clampFov(170), PANO_FOV_MAX_DEG);
  assert.equal(wrapDegrees(-30), 330);
  assert.equal(wrapDegrees(725), 5);
});
