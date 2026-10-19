import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  STARRY_SKY_CESIUM_VERSION,
  SKY_ROTATION_EPSILON_SECONDS,
  StarrySky,
  computeSkyRotation,
  isSkyRotationCurrent,
} from './starrySky.js';

test('the sky-box adapter was validated against this engine version', () => {
  assert.equal(
    Cesium.VERSION,
    STARRY_SKY_CESIUM_VERSION,
    'engine upgrades require revalidating the Scene#skyBox contract',
  );
});

test('the ICRF rotation is preferred and TEME fills in while tables load', () => {
  const time = Cesium.JulianDate.fromIso8601('2026-10-19T00:00:00Z');
  const icrf = Cesium.Matrix3.fromRotationZ(0.3);
  const teme = Cesium.Matrix3.fromRotationZ(0.2);
  const precise = computeSkyRotation(time, new Cesium.Matrix3(), {
    computeIcrfToFixedMatrix: (_, result) => Cesium.Matrix3.clone(icrf, result),
    computeTemeToPseudoFixedMatrix: () => assert.fail('TEME not needed'),
  });
  assert.equal(precise.precise, true);
  assert.ok(Cesium.Matrix3.equals(precise.matrix, icrf));
  const approximate = computeSkyRotation(time, new Cesium.Matrix3(), {
    computeIcrfToFixedMatrix: () => undefined,
    computeTemeToPseudoFixedMatrix: (_, result) =>
      Cesium.Matrix3.clone(teme, result),
  });
  assert.equal(approximate.precise, false);
  assert.ok(Cesium.Matrix3.equals(approximate.matrix, teme));
});

test('the TEME fallback keeps the celestial pole on the Earth axis', () => {
  // TEME only spins about Z; ICRF differs from it by precession (~0.36° by
  // 2026), so the fallback sky is right up to a fraction of a degree.
  const time = Cesium.JulianDate.fromIso8601('2026-10-19T00:00:00Z');
  const teme = Cesium.Transforms.computeTemeToPseudoFixedMatrix(time);
  const pole = Cesium.Matrix3.multiplyByVector(
    teme,
    Cesium.Cartesian3.UNIT_Z,
    new Cesium.Cartesian3(),
  );
  assert.ok(Math.abs(pole.z - 1) < 1e-9);
});

test('the rotation is reused only within the clock epsilon', () => {
  const time = Cesium.JulianDate.fromIso8601('2026-10-19T00:00:00Z');
  const later = (seconds) =>
    Cesium.JulianDate.addSeconds(time, seconds, new Cesium.JulianDate());
  assert.equal(isSkyRotationCurrent(undefined, time), false);
  assert.equal(isSkyRotationCurrent(time, later(0.5)), true);
  assert.equal(isSkyRotationCurrent(time, later(-0.5)), true);
  assert.equal(
    isSkyRotationCurrent(time, later(SKY_ROTATION_EPSILON_SECONDS)),
    false,
  );
});

test('the sky draws nothing when hidden, outside 3D, or in a pick pass', () => {
  const sky = new StarrySky({ requestRender: () => {} });
  const frameState = (overrides) => ({
    mode: Cesium.SceneMode.SCENE3D,
    passes: { render: true },
    ...overrides,
  });
  sky._loading = true; // keep the test off the network
  sky.show = false;
  assert.equal(sky.update(frameState()), undefined);
  sky.show = true;
  assert.equal(
    sky.update(frameState({ mode: Cesium.SceneMode.SCENE2D })),
    undefined,
  );
  assert.equal(
    sky.update(frameState({ passes: { render: false, pick: true } })),
    undefined,
  );
  // Nothing has loaded yet, so even a render pass has no command.
  assert.equal(sky.update(frameState()), undefined);
  assert.equal(sky.isDestroyed(), false);
  assert.equal(sky.destroy(), undefined);
  assert.equal(sky.isDestroyed(), true);
});

const frame = () => new Promise((resolve) => setImmediate(resolve));

for (const iso of ['1970-01-01T00:00:00Z', '2060-01-01T00:00:00Z']) {
  test(`a clock outside the IAU 2006 tables (${iso}) settles on TEME instead of re-rendering every frame`, async () => {
    const time = Cesium.JulianDate.fromIso8601(iso);
    let renders = 0;
    let preloads = 0;
    const original = Cesium.Transforms.preloadIcrfFixed;
    Cesium.Transforms.preloadIcrfFixed = (interval) => {
      preloads += 1;
      return original(interval);
    };
    try {
      const sky = new StarrySky({ requestRender: () => (renders += 1) });
      for (let i = 0; i < 20; i += 1) {
        sky._updateRotation(time); // what update() does once per frame
        await frame();
      }
      assert.ok(
        renders <= 1 && preloads <= 1,
        `20 frames at a frozen clock -> ${preloads} preloads, ${renders} render requests (expected <= 1 each)`,
      );
    } finally {
      Cesium.Transforms.preloadIcrfFixed = original;
    }
  });
}
