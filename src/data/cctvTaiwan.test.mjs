import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTaiwanSources,
  parseTaiwanCctvXml,
  taiwanCameraToSource,
  taiwanFrame,
  TAIWAN_FREEWAY_CCTV_URL,
} from '../../server/providers/cctv/taiwan.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

function cctvXml(...blocks) {
  return `<?xml version='1.0' encoding='utf-8'?>
<CCTVList xmlns="http://traffic.transportdata.tw/standard/traffic/schema/">
  <AuthorityCode>NFB</AuthorityCode>
  <CCTVs>${blocks.join('')}</CCTVs>
</CCTVList>`;
}

function block({
  id = 'CCTV-N1-S-0.000-M',
  stream = 'https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=10000',
  lat = '25.1229931',
  lon = '121.735695',
} = {}) {
  return `<CCTV>
    <CCTVID>${id}</CCTVID>
    <VideoStreamURL>${stream}</VideoStreamURL>
    <PositionLon>${lon}</PositionLon>
    <PositionLat>${lat}</PositionLat>
    <RoadName>國道1號</RoadName>
    <RoadDirection>S</RoadDirection>
    <RoadSection><Start>基隆端</Start><End>基隆交流道</End></RoadSection>
    <LocationMile>0K+000</LocationMile>
  </CCTV>`;
}

test('parses the MOTC 2.0 table and registers the same camera still', () => {
  const [row] = parseTaiwanCctvXml(cctvXml(block()));
  const camera = taiwanCameraToSource(row);
  assert.equal(camera.id, 'tw-freeway-cctvn-10000');
  assert.equal(camera.lat, 25.1229931);
  assert.equal(camera.lon, 121.735695);
  assert.equal(camera.name, '國道1號 S 0K+000 基隆端→基隆交流道');
  assert.equal(camera.cityId, 'taiwan');
  assert.equal(camera.feedType, 'image');
  assert.equal(camera.headingConfidence, 'low');
  assert.equal(
    camera.url,
    'https://cctvn.freeway.gov.tw/abs2mjpg/jpg?camera=10000',
  );
  assert.equal(camera.snapshotUrl, camera.url);
  assert.match(camera.license, /Open Government Data License, Taiwan/);
});

test('each camera server maps its stream path to its own still path only', () => {
  assert.equal(
    taiwanFrame(
      'https://cctvs.freeway.gov.tw/live-view/mjpg/video.cgi?camera=373',
    ).frameUrl,
    'https://cctvs.freeway.gov.tw/live-view/jpg/image.cgi?camera=373',
  );
  assert.equal(
    taiwanFrame(
      'https://cctvn5.freeway.gov.tw/abs2mjpg/bmjpg?camera=c3a580c9-0232-46a1-bfc6-927590758ab4',
    ).frameUrl,
    'https://cctvn5.freeway.gov.tw/abs2mjpg/jpg?camera=c3a580c9-0232-46a1-bfc6-927590758ab4',
  );
  assert.equal(
    taiwanFrame(
      'https://cctvc.freeway.gov.tw/abs2mjpg/bmjpg?camera=495&extra=1',
    ).frameUrl,
    'https://cctvc.freeway.gov.tw/abs2mjpg/jpg?camera=495',
  );
});

test('off-host, downgraded or malformed stream URLs never enter the proxy registry', () => {
  for (const stream of [
    'http://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=10000',
    'https://cctvn.freeway.gov.tw.evil.test/abs2mjpg/bmjpg?camera=10000',
    'https://user:pass@cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=10000',
    'https://cctvn.freeway.gov.tw:8443/abs2mjpg/bmjpg?camera=10000',
    'https://cctvn.freeway.gov.tw/live-view/mjpg/video.cgi?camera=10000',
    'https://cctvs.freeway.gov.tw/abs2mjpg/bmjpg?camera=373',
    'https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=../../admin',
    'https://cctvs.freeway.gov.tw/live-view/mjpg/video.cgi?cacamera=373',
    'http://127.0.0.1/private',
    '',
  ]) {
    assert.equal(taiwanFrame(stream), null, stream);
    const [row] = parseTaiwanCctvXml(cctvXml(block({ stream })));
    assert.equal(taiwanCameraToSource(row), null, stream);
  }
});

test('coordinates outside Taiwan, swapped or missing are rejected', () => {
  for (const [lat, lon] of [
    ['121.735695', '25.1229931'],
    ['35.68', '139.76'],
    ['', '121.7'],
    ['NaN', '121.7'],
  ]) {
    const [row] = parseTaiwanCctvXml(cctvXml(block({ lat, lon })));
    assert.equal(taiwanCameraToSource(row), null, `${lat},${lon}`);
  }
  assert.equal(taiwanCameraToSource(null), null);
});

test('Chinese place names in CCTVID stay in the record without shaping the key', () => {
  const [row] = parseTaiwanCctvXml(
    cctvXml(block({ id: 'CCTV-N1-N-55-R-中壢服務區&amp;(北)' })),
  );
  const camera = taiwanCameraToSource(row);
  assert.equal(camera.id, 'tw-freeway-cctvn-10000');
  assert.equal(row.cctvId, 'CCTV-N1-N-55-R-中壢服務區&(北)');
});

function mockCatalog(t, xml) {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requested.push(String(url));
    if (String(url) === TAIWAN_FREEWAY_CCTV_URL) {
      assert.equal(options.redirect, 'manual');
      return new Response(xml, {
        headers: { 'content-type': 'application/xml' },
      });
    }
    return Response.json([]);
  });
  return requested;
}

test('loader deduplicates cameras that share a camera number', async (t) => {
  mockCatalog(
    t,
    cctvXml(
      block(),
      block({ id: 'CCTV-N1-S-0.000-M-dup' }),
      block({
        stream: 'https://cctvc.freeway.gov.tw/abs2mjpg/bmjpg?camera=495',
        lat: '24.1',
        lon: '120.6',
      }),
    ),
  );
  assert.deepEqual((await loadTaiwanSources()).map((c) => c.id).sort(), [
    'tw-freeway-cctvc-495',
    'tw-freeway-cctvn-10000',
  ]);
});

test('a redirected or failed catalog contributes an empty pack', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const status of [302, 503]) {
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response('', {
          status,
          headers: status === 302 ? { location: 'https://evil.test/' } : {},
        }),
    );
    assert.deepEqual(await loadTaiwanSources(), []);
  }
});

async function runCatalogWithTaiwanFlag(t, flag) {
  const requested = mockCatalog(t, cctvXml(block()));
  const saved = process.env.CCTV_TAIWAN_ENABLED;
  try {
    if (flag === undefined) delete process.env.CCTV_TAIWAN_ENABLED;
    else process.env.CCTV_TAIWAN_ENABLED = flag;
    const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
    return { requested, sources };
  } finally {
    if (saved === undefined) delete process.env.CCTV_TAIWAN_ENABLED;
    else process.env.CCTV_TAIWAN_ENABLED = saved;
  }
}

test('the Taiwan pack is in the catalog by default', async (t) => {
  const { sources } = await runCatalogWithTaiwanFlag(t, undefined);
  assert.equal(
    sources.find((c) => c.id === 'tw-freeway-cctvn-10000')?.cityId,
    'taiwan',
  );
});

test('CCTV_TAIWAN_ENABLED=0 makes no Freeway Bureau request', async (t) => {
  const { requested, sources } = await runCatalogWithTaiwanFlag(t, '0');
  assert.ok(requested.length > 0, 'the other packs still refreshed');
  assert.equal(
    requested.some((href) => href.includes('freeway.gov.tw')),
    false,
  );
  assert.ok(!sources.some((c) => c.cityId === 'taiwan'));
});
