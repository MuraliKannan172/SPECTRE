// SPECTRE: free APIs whose terms allow only personal, non-commercial use stay
// off until the owner turns on "Non-commercial sources" in Provider Settings.
// These pin the default (off) for every gated route; liveProviders.test.mjs
// and localServices.test.mjs pin the opted-in paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NON_COMMERCIAL_SOURCES_ENV,
  NON_COMMERCIAL_SOURCES_OFF_REASON,
  nonCommercialSourcesEnabled,
} from '../../server/providers/common/non-commercial.js';
import {
  adsbdbProxy,
  openSkyProxy,
  trackBackfillProxies,
} from '../../server/providers/live.js';
import {
  regionalBriefProxy,
  weatherEffectsProxy,
} from '../../server/providers/regional.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (route, url = '/') => {
    assert.ok(routes.has(route), `registered route: ${route}`);
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
      },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [key, value] of Object.entries(headers))
          this.setHeader(key, value);
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get(route)(
      { url, method: 'GET', headers: {}, socket: {} },
      response,
    );
    return response;
  };
}

/** Run with the switch off, failing on any request to a gated host. */
function switchedOff(t, allowedHosts = []) {
  const before = process.env[NON_COMMERCIAL_SOURCES_ENV];
  delete process.env[NON_COMMERCIAL_SOURCES_ENV];
  t.after(() => {
    if (before !== undefined) process.env[NON_COMMERCIAL_SOURCES_ENV] = before;
  });
  const hosts = [];
  t.mock.method(globalThis, 'fetch', async (raw) => {
    const host = new URL(raw).hostname;
    hosts.push(host);
    assert.ok(allowedHosts.includes(host), `unexpected request to ${host}`);
    if (host === 'api.adsb.lol')
      return Response.json({ ac: [], now: Date.now(), total: 0 });
    if (host === 'api.gdeltproject.org')
      return Response.json({
        articles: [
          {
            title: 'Regional headline',
            url: 'https://example.org/story',
            domain: 'example.org',
            seendate: '20261022T120000Z',
          },
        ],
      });
    throw new Error(`no fixture for ${host}`);
  });
  return hosts;
}

test('the switch reads only explicit opt-in values', () => {
  for (const value of [undefined, '', '0', 'false', 'off', 'no'])
    assert.equal(
      nonCommercialSourcesEnabled({ [NON_COMMERCIAL_SOURCES_ENV]: value }),
      false,
      String(value),
    );
  for (const value of ['1', 'true', 'TRUE', ' on ', 'yes'])
    assert.equal(
      nonCommercialSourcesEnabled({ [NON_COMMERCIAL_SOURCES_ENV]: value }),
      true,
      value,
    );
});

test('flights default to adsb.lol around the view and never call OpenSky', async (t) => {
  const hosts = switchedOff(t, ['api.adsb.lol']);
  const get = install(openSkyProxy());
  const response = await get('/api/flights', '/?lat=30.27&lon=-97.74');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-feed-source'], 'adsb.lol');
  assert.deepEqual(hosts, ['api.adsb.lol']);
});

test('flights without a view anchor explain the switch instead of calling OpenSky', async (t) => {
  switchedOff(t);
  const get = install(openSkyProxy());
  const response = await get('/api/flights', '/');
  assert.equal(response.statusCode, 503);
  assert.equal(
    JSON.parse(response.body).reason,
    NON_COMMERCIAL_SOURCES_OFF_REASON,
  );
});

test('OpenSky track history is refused with the reason', async (t) => {
  switchedOff(t);
  const get = install(trackBackfillProxies());
  const response = await get('/api/flights/track', '/?icao24=a0b1c2');
  assert.equal(response.statusCode, 403);
  assert.equal(
    JSON.parse(response.body).reason,
    NON_COMMERCIAL_SOURCES_OFF_REASON,
  );
});

test('weather effects report disabled without calling Open-Meteo', async (t) => {
  switchedOff(t);
  const get = install(weatherEffectsProxy());
  const response = await get(
    '/api/weather-effects',
    '/?latitude=30.27&longitude=-97.74',
  );
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.status, 'disabled');
  assert.equal(body.weather, null);
  assert.equal(body.reason, NON_COMMERCIAL_SOURCES_OFF_REASON);
});

test('the regional brief uses GDELT and marks weather disabled', async (t) => {
  const hosts = switchedOff(t, ['api.gdeltproject.org']);
  const get = install(
    regionalBriefProxy({
      placeProvider: async () => ({ locality: 'Austin', country: 'US' }),
    }),
  );
  const response = await get(
    '/api/regional-brief',
    '/?latitude=30.27&longitude=-97.74',
  );
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.weatherStatus, 'disabled');
  assert.equal(body.weatherReason, NON_COMMERCIAL_SOURCES_OFF_REASON);
  assert.equal(body.newsSource, 'GDELT');
  assert.ok(!hosts.includes('news.google.com'));
  assert.ok(!hosts.includes('api.open-meteo.com'));
});

test('adsbdb route lookups are off and never leave the machine', async (t) => {
  switchedOff(t);
  const get = install(adsbdbProxy());
  const response = await get('/api/adsbdb', '/route/UAL123');
  assert.deepEqual(JSON.parse(response.body), {
    found: false,
    disabled: true,
    reason: NON_COMMERCIAL_SOURCES_OFF_REASON,
  });
});
