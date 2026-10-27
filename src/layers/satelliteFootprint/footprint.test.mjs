import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EARTH_MEAN_RADIUS_M,
  footprintCentralAngle,
  footprintRadiusMeters,
  footprintRing,
} from './footprint.js';

const KM = 1000;

function greatCircleMeters([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * EARTH_MEAN_RADIUS_M * Math.asin(Math.sqrt(a));
}

test('the ISS at 420 km is visible about 1,390 km out at 10° elevation', () => {
  const radius = footprintRadiusMeters(420 * KM, 10);
  assert.ok(Math.abs(radius - 1_391 * KM) < 5 * KM, `${radius}`);
  // Down to the horizon it reaches further.
  const horizon = footprintRadiusMeters(420 * KM, 0);
  assert.ok(Math.abs(horizon - 2_252 * KM) < 5 * KM, `${horizon}`);
});

test('a geostationary satellite sees about 71° of arc at 10° elevation', () => {
  const angle = (footprintCentralAngle(35_786 * KM, 10) * 180) / Math.PI;
  assert.ok(Math.abs(angle - 71.4) < 0.1, `${angle}`);
});

test('no footprint for a grounded or invalid satellite', () => {
  assert.equal(footprintCentralAngle(0), 0);
  assert.equal(footprintCentralAngle(-5), 0);
  assert.equal(footprintCentralAngle(Number.NaN), 0);
  assert.equal(footprintCentralAngle(420 * KM, 90), 0);
  assert.equal(footprintCentralAngle(420 * KM, -1), 0);
  assert.deepEqual(
    footprintRing({ latitude: 0, longitude: 0, altitudeM: 0 }),
    [],
  );
  assert.deepEqual(
    footprintRing({ latitude: Number.NaN, longitude: 0, altitudeM: 420 * KM }),
    [],
  );
});

test('the ring is closed and every point lies on the footprint edge', () => {
  const centre = { latitude: 51.5, longitude: -0.1, altitudeM: 550 * KM };
  const ring = footprintRing({ ...centre, segments: 72 });
  assert.equal(ring.length, 73);
  assert.deepEqual(ring[0], ring[72]);
  const radius = footprintRadiusMeters(centre.altitudeM, 10);
  for (const point of ring) {
    const distance = greatCircleMeters(
      [centre.longitude, centre.latitude],
      point,
    );
    assert.ok(Math.abs(distance - radius) < 1, `${distance} vs ${radius}`);
  }
});

test('ring longitudes stay within ±180° across the antimeridian', () => {
  const ring = footprintRing({
    latitude: 0,
    longitude: 179,
    altitudeM: 800 * KM,
  });
  assert.ok(ring.every(([lon]) => lon >= -180 && lon <= 180));
  assert.ok(ring.some(([lon]) => lon < 0));
  assert.ok(ring.some(([lon]) => lon > 0));
});
