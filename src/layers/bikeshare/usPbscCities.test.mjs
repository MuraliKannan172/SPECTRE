import assert from 'node:assert/strict';
import test from 'node:test';
import { CITY_BY_ID } from './registry.js';
import { isAllowedGbfsHost, isAllowedGbfsPath } from '../../data/gbfsSource.js';
import { CITY_RANGE_BASE_KM } from './policy.js';

// Each city's PBSC host, and its farthest station from the registered centre
// as measured against the live feed (km), so a camera over any part of the
// system activates it.
const CITIES = {
  'detroit-mogo': { host: 'detroit.publicbikesystem.net', provider: 'MoGo', farthestKm: 22.4 },
  'pittsburgh-pogoh': { host: 'pittsburgh.publicbikesystem.net', provider: 'POGOH', farthestKm: 9.1 },
  'aspen-we-cycle': { host: 'aspen.publicbikesystem.net', provider: 'WE-cycle', farthestKm: 42.6 },
  'hawaii-island-hibike': { host: 'kona.publicbikesystem.net', provider: 'HIBike', farthestKm: 53.8 },
};

test('the added US PBSC systems are registered and readable through the proxy', () => {
  for (const [id, expected] of Object.entries(CITIES)) {
    const city = CITY_BY_ID.get(id);
    assert.ok(city, `${id} is registered`);
    assert.equal(city.provider, expected.provider);
    assert.deepEqual(city.hosts, [expected.host]);
    for (const feed of [city.stationInformationUrl, city.stationStatusUrl]) {
      const url = new URL(feed);
      assert.ok(isAllowedGbfsHost(url.hostname), `${id} host ${url.hostname}`);
      assert.ok(isAllowedGbfsPath(url.pathname), `${id} path ${url.pathname}`);
    }
    const radius = Math.max(CITY_RANGE_BASE_KM, city.loadRadiusKm);
    assert.ok(radius > expected.farthestKm, `${id} radius ${radius} covers its farthest station`);
  }
});
