import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPanoramaxProvider,
  panoramaxZoomFor,
  passesCoverage,
  pictureTilesAround,
} from './index.js';
import { NO_COVERAGE_HINT, OVERVIEW_HINT, PICK_PREFIX } from './policy.js';
import { validateProviders } from '../../registry.js';
import { tileBounds } from '../../tileMath.js';
import { fakeHost, until } from '../../../../testSupport/kartaViewFakes.mjs';
import {
  coverageViewer,
  tileCentre,
} from '../../../../testSupport/streetLevelFakes.mjs';
import {
  encodePanoramaxTile,
  stacItem,
} from '../../../../testSupport/panoramaxFixtures.mjs';

const ORIGIN = { lon: 2.3495, lat: 48.8874 };
/** A point `metres` east of ORIGIN. */
const east = (metres) => ({
  lon: ORIGIN.lon + metres / 73_300,
  lat: ORIGIN.lat,
});

/**
 * A sequence `seq` of `count` pictures 5 m apart heading east from ORIGIN
 * (`offset` m in), each linked to its neighbours.
 */
function sequence(seq, count, { offset = 0, pano = false } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const at = east(offset + i * 5);
    return stacItem({
      id: `${seq}-${i}`,
      sequenceId: seq,
      ...at,
      pano,
      prevId: i ? `${seq}-${i - 1}` : null,
      nextId: i < count - 1 ? `${seq}-${i + 1}` : null,
    });
  });
}

/** A source over `items`, answering nearest lookups by distance, recording calls. */
function fakeSource({ items = [], tiles = () => new Uint8Array(0) } = {}) {
  const calls = { nearest: [], items: [], tiles: [] };
  const metres = (a, b) =>
    Math.hypot((a.lon - b.lon) * 73_300, (a.lat - b.lat) * 111_200);
  return {
    calls,
    getTile: async (tile) => {
      calls.tiles.push(`${tile.z}/${tile.x}/${tile.y}`);
      return tiles(tile);
    },
    getItem: async (id) => {
      calls.items.push(id);
      return items.find((item) => item.id === id) ?? null;
    },
    nearestItems: async (query) => {
      calls.nearest.push(query);
      const at = { lon: query.lon, lat: query.lat };
      return items
        .filter(
          (item) => !query.collections || item.collection === query.collections,
        )
        .map((item) => ({
          item,
          d: metres(at, {
            lon: item.geometry.coordinates[0],
            lat: item.geometry.coordinates[1],
          }),
        }))
        .filter(({ d }) => d <= query.radius)
        .sort((a, b) => a.d - b.d)
        .slice(0, query.limit)
        .map(({ item }) => item);
    },
  };
}

function fakeContext({ filter = { pano: 'all', sinceMs: null } } = {}) {
  const actions = { opened: [], nearest: [], errors: [], instance: null };
  return {
    actions,
    context: {
      services: {},
      getFilter: () => filter,
      isActive: () => true,
      groundCaster: null,
      meshSampler: null,
      getSurface: () => 'draped',
      notify() {},
      actions: {
        openImage: async (id, options) => {
          actions.opened.push({ id, options });
          // As the core does, errors included (a test may not mount a viewer).
          await actions.instance?.viewer.open(id).catch((error) => {
            actions.errors.push(error.message);
          });
          return true;
        },
        openNearest: (point) => actions.nearest.push(point),
        reportError: (message) => actions.errors.push(message),
      },
    },
  };
}

function setup(sourceOptions, contextOptions) {
  const source = fakeSource(sourceOptions);
  const loads = [];
  const definition = createPanoramaxProvider({
    source,
    viewerOptions: {
      load: async (url) => {
        loads.push(url);
        return { src: url };
      },
      createRenderer: () => {
        throw new Error('no WebGL in Node');
      },
    },
  });
  const { context, actions } = fakeContext(contextOptions);
  const instance = definition.create(context);
  actions.instance = instance;
  return { definition, instance, source, actions, loads };
}

test('Panoramax registers keyless and off by default, with both filters and its own wording', () => {
  const { definition } = setup();
  assert.equal(definition.id, 'panoramax');
  assert.equal(definition.label, 'PANORAMAX');
  assert.equal(definition.requiresKeyId, null);
  assert.equal(definition.defaultOn, false);
  assert.equal(definition.filters, undefined, 'pano and since both apply');
  assert.notEqual(definition.highlightsSequence, false, 'lines are sequences');
  assert.match(definition.credit.html, /Panoramax<\/a> contributors/);
  assert.equal(
    definition.coverageLabel.action,
    'click a line for the photo there',
  );
  assert.doesNotThrow(() => validateProviders([definition]));
});

test('lines at z11–14 below 30 km; density points from z5 down to z0 above', () => {
  assert.deepEqual(panoramaxZoomFor(500), { zoom: 14, kind: 'sequence' });
  assert.deepEqual(panoramaxZoomFor(1_800), { zoom: 14, kind: 'sequence' });
  assert.deepEqual(panoramaxZoomFor(4_000), { zoom: 13, kind: 'sequence' });
  assert.deepEqual(panoramaxZoomFor(12_000), { zoom: 12, kind: 'sequence' });
  assert.deepEqual(panoramaxZoomFor(25_000), { zoom: 11, kind: 'sequence' });
  assert.deepEqual(panoramaxZoomFor(30_000), { zoom: 11, kind: 'sequence' });
  assert.deepEqual(panoramaxZoomFor(30_001), { zoom: 5, kind: 'overview' });
  assert.deepEqual(panoramaxZoomFor(100_000), { zoom: 5, kind: 'overview' });
  assert.deepEqual(panoramaxZoomFor(2_000_000), { zoom: 3, kind: 'overview' });
  assert.deepEqual(panoramaxZoomFor(20_000_000), { zoom: 0, kind: 'overview' });
  assert.equal(panoramaxZoomFor(NaN), null);
});

test('the imagery filter: lines by type and day, density cells by what they hold', () => {
  const old = Date.UTC(2020, 0, 1);
  const since = { pano: 'all', sinceMs: Date.UTC(2024, 0, 1) };
  assert.equal(
    passesCoverage({ isPano: false, capturedAt: old }, since),
    false,
  );
  assert.equal(
    passesCoverage(
      { isPano: true, capturedAt: Date.UTC(2025, 0, 1) },
      {
        pano: 'pano',
        sinceMs: null,
      },
    ),
    true,
  );
  const cell = { hasPano: false, hasFlat: true, capturedAt: null };
  assert.equal(passesCoverage(cell, { pano: 'pano', sinceMs: null }), false);
  assert.equal(passesCoverage(cell, { pano: 'flat', sinceMs: null }), true);
  assert.equal(passesCoverage(cell, since), true, 'cells are undated: kept');
  assert.equal(passesCoverage(cell, null), true);
});

test('cones read the z15 tile around a picture, and its neighbours near an edge', () => {
  const home = tileCentre(ORIGIN.lon, ORIGIN.lat, 15);
  assert.equal(pictureTilesAround(home).length, 1, 'mid-tile: one tile');
  const box = tileBounds(home.tile.x, home.tile.y, 15);
  const corner = { lon: box.west + 0.0002, lat: box.north - 0.0002 };
  const tiles = pictureTilesAround(corner).map((t) => `${t.x}/${t.y}`);
  const { x, y } = home.tile;
  assert.deepEqual(tiles, [
    `${x}/${y}`,
    `${x - 1}/${y}`,
    `${x}/${y - 1}`,
    `${x - 1}/${y - 1}`,
  ]);
  // Across the antimeridian the column wraps.
  const dateLine = pictureTilesAround({ lon: -179.9999, lat: 0.5 });
  assert.equal(dateLine[1].x, 2 ** 15 - 1);
});

test('the nearest picture within 50 m that passes the filter; filters go to the API', async () => {
  const items = [
    ...sequence('far', 1, { offset: 80 }),
    ...sequence('a', 3, { offset: 10 }),
  ];
  const { instance, source } = setup(
    { items },
    { filter: { pano: 'pano', sinceMs: 123 } },
  );
  const id = await instance.nearestImage(east(0));
  assert.equal(id, 'a-0');
  assert.equal(source.calls.nearest.length, 1);
  assert.equal(source.calls.nearest[0].pano, 'pano');
  assert.equal(source.calls.nearest[0].sinceMs, 123);
  assert.equal(source.calls.nearest[0].collections, null);
  assert.equal(await instance.nearestImage(east(300)), null, 'none near');
});

test('a click on a line opens that sequence’s picture nearest the click, not another’s', async () => {
  const items = [
    ...sequence('other', 2, { offset: 0 }),
    ...sequence('clicked', 4, { offset: 8 }),
  ];
  const { instance, actions, source } = setup({ items });
  assert.equal(
    instance.handlePick(`${PICK_PREFIX.sequence}clicked~1`, {
      groundPoint: () => east(1),
    }),
    true,
  );
  assert.deepEqual(actions.nearest, [east(1)]);
  // The core asks the provider for the nearest picture to that point.
  assert.equal(await instance.nearestImage(east(1)), 'clicked-0');
  assert.equal(source.calls.nearest[0].collections, 'clicked');
  // Only once: the next lookup (OPEN, another click) is any sequence's.
  assert.equal(await instance.nearestImage(east(1)), 'other-0');
});

test('a line click whose sequence has nothing near falls back to any picture there', async () => {
  const items = [
    ...sequence('near', 1),
    ...sequence('clicked', 1, { offset: 400 }),
  ];
  const { instance, source } = setup({ items });
  instance.handlePick(`${PICK_PREFIX.sequence}clicked`, {
    groundPoint: () => east(0),
  });
  assert.equal(await instance.nearestImage(east(0)), 'near-0');
  assert.deepEqual(
    source.calls.nearest.map((q) => q.collections),
    ['clicked', null],
  );
});

test('a cone opens its picture; foreign ids are not picked', () => {
  const { instance, actions } = setup();
  assert.equal(instance.handlePick(`${PICK_PREFIX.image}abc`), true);
  assert.equal(actions.opened[0].id, 'abc');
  assert.equal(instance.handlePick('kv:line:1'), false);
  assert.equal(instance.handlePick('pnx:other'), false);
});

/** A provider and its viewer mounted, opening pictures through the fake core. */
async function mounted(sourceOptions, contextOptions) {
  const env = setup(sourceOptions, contextOptions);
  const poses = [];
  env.instance.viewer.onPose((pose) => poses.push(pose.imageId));
  const host = fakeHost();
  await env.instance.viewer.mount(host);
  const [, , prev, next] = host.children[0].children;
  return { ...env, poses, prev, next };
}

test('› and ‹ step along the picture’s links without moving the camera, asking only for the next picture', async () => {
  const items = sequence('s', 3);
  const env = await mounted({ items });
  await env.instance.viewer.open('s-0');
  assert.ok(await until(() => env.prev.disabled), 'the first picture: no ‹');
  env.next.fire('click');
  assert.ok(await until(() => env.poses.at(-1) === 's-1'));
  assert.deepEqual(env.actions.opened.at(-1), {
    id: 's-1',
    options: { frame: false },
  });
  env.next.fire('click');
  assert.ok(await until(() => env.poses.at(-1) === 's-2'));
  assert.ok(await until(() => env.next.disabled), 'the last picture: no ›');
  assert.deepEqual(env.source.calls.items, ['s-0', 's-1', 's-2']);
  env.prev.fire('click');
  assert.ok(await until(() => env.poses.at(-1) === 's-1'));
  assert.equal(env.source.calls.items.length, 3, 's-1 came from the cache');
});

test('one lookup for a picture asked twice at once', async () => {
  const items = sequence('s', 1);
  const { instance, source } = setup({ items });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const getItem = source.getItem;
  source.getItem = async (id) => {
    await gate;
    return getItem(id);
  };
  const host = fakeHost();
  await instance.viewer.mount(host);
  const first = instance.viewer.open('s-0');
  const second = instance.viewer.open('s-0');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(source.calls.items, ['s-0']);
});

test('a picture Panoramax does not know fails the open with a reason', async () => {
  const env = await mounted({ items: [] });
  await assert.rejects(env.instance.viewer.open('ghost'), /no position/);
});

/** Cones on a stand-in Cesium viewer; `count()` reads how many are drawn. */
async function withCones(t, env) {
  const Cesium = await import('cesium');
  // The cone glyph draws on a canvas: any drawing call is fine.
  const drawing = new Proxy({}, { get: () => () => {}, set: () => true });
  const saved = globalThis.document;
  globalThis.document = {
    createElement: () => ({ getContext: () => drawing }),
  };
  t.after(() => (globalThis.document = saved));
  let collection = null;
  env.instance.init({
    scene: {
      frameState: { mode: Cesium.SceneMode.SCENE3D },
      updateHeight: () => () => {},
      getHeight: () => undefined,
      primitives: { add: (c) => (collection = c), remove() {} },
      preRender: { addEventListener: () => () => {} },
    },
    camera: { positionWC: new Cesium.Cartesian3(0, 0, 1e8) },
  });
  return { count: () => collection?.length ?? 0 };
}

/** z15 tiles holding every item of `items` as a picture. */
const pictureTiles = (items) => (tile) => {
  if (tile.z !== 15) return new Uint8Array(0);
  const box = tileBounds(tile.x, tile.y, tile.z);
  const inside = items.filter(
    ({
      geometry: {
        coordinates: [lon, lat],
      },
    }) =>
      lon >= box.west && lon < box.east && lat <= box.north && lat > box.south,
  );
  return encodePanoramaxTile(tile, {
    pictures: inside.map((item) => ({
      id: item.id,
      lon: item.geometry.coordinates[0],
      lat: item.geometry.coordinates[1],
      sequenceId: item.collection,
      ts: item.properties.datetime.replace('T', ' ').replace('+00:00', '+00'),
    })),
  });
};

test('once a picture is on screen its sequence’s cones load from the z15 tile around it', async (t) => {
  const items = [...sequence('s', 6), ...sequence('x', 3, { offset: 2 })];
  const env = await mounted({ items, tiles: pictureTiles(items) });
  const cones = await withCones(t, env);
  await env.instance.viewer.open('s-2');
  await env.instance.selectSequence('s');
  assert.ok(await until(() => !env.instance.sequenceStats().loading));
  assert.equal(env.instance.sequenceStats().selectedId, 's');
  assert.equal(env.instance.sequenceStats().images, 6, 'only sequence s');
  assert.equal(cones.count(), 6);
  assert.ok(env.source.calls.tiles.every((key) => key.startsWith('15/')));
});

test('a sequence selected with no picture or click to centre on draws no cones', async (t) => {
  const items = sequence('s', 3);
  const env = await mounted({ items, tiles: pictureTiles(items) });
  await withCones(t, env);
  env.instance.handlePick(`${PICK_PREFIX.sequence}s`, {
    groundPoint: () => null,
  });
  assert.ok(await until(() => !env.instance.sequenceStats().loading));
  assert.equal(env.instance.sequenceStats().selectedId, 's', 'highlighted');
  assert.equal(env.instance.sequenceStats().images, 0);
  assert.deepEqual(env.source.calls.tiles, []);
  assert.deepEqual(env.actions.nearest, []);
});

test('the cones re-centre when › walks into another z15 tile', async (t) => {
  // 400 pictures 5 m apart span 2 km: more than two z15 tiles (~800 m).
  const items = sequence('long', 400);
  const env = await mounted({ items, tiles: pictureTiles(items) });
  await withCones(t, env);
  await env.instance.viewer.open('long-0');
  await env.instance.selectSequence('long');
  assert.ok(await until(() => !env.instance.sequenceStats().loading));
  const firstTiles = new Set(env.source.calls.tiles);
  const first = env.instance.sequenceStats().images;
  assert.ok(first > 0 && first < 400, `part of the sequence: ${first}`);
  // Jump to the far end: the cones follow.
  await env.instance.viewer.open('long-399');
  assert.ok(
    await until(() =>
      env.source.calls.tiles.some((key) => !firstTiles.has(key)),
    ),
    'a new tile was read',
  );
  assert.ok(await until(() => !env.instance.sequenceStats().loading));
  assert.ok(env.instance.sequenceStats().images > 0);
});

/** The provider drawing coverage on a stand-in viewer above one z14 tile. */
function coverageSetup(
  t,
  { sequences = [], grid = [], filter, height = 900 } = {},
) {
  const centre = tileCentre(ORIGIN.lon, ORIGIN.lat);
  let hold = null;
  const env = setup(
    {
      tiles: (tile) => {
        const bytes = encodePanoramaxTile(tile, { sequences, grid });
        return hold ? hold.then(() => bytes) : bytes;
      },
    },
    { filter },
  );
  const viewer = coverageViewer({ ...centre, height }, t);
  env.instance.init(viewer);
  t.after(() => env.instance.destroy(viewer));
  return {
    ...env,
    viewer,
    centre,
    holdTiles() {
      let release;
      hold = new Promise((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

const line = (id, options = {}) => ({
  id,
  parts: [
    [
      [ORIGIN.lon - 0.001, ORIGIN.lat],
      [ORIGIN.lon + 0.001, ORIGIN.lat],
    ],
  ],
  ...options,
});

test('sequence lines draw near the ground, and the imagery filter thins them', async (t) => {
  const env = coverageSetup(t, {
    sequences: [
      line('new-pano', { type: 'equirectangular', date: '2025-06-01' }),
      line('old-flat', { date: '2019-06-01' }),
    ],
  });
  env.instance.activate(env.viewer);
  assert.ok(await until(() => env.instance.coverageStats().count === 2));
  assert.equal(env.instance.coverageStats().kind, 'sequence');
  assert.equal(env.instance.coverageStats().keyRequired, false);
  env.instance.deactivate();

  const filtered = coverageSetup(t, {
    filter: { pano: 'pano', sinceMs: null },
    sequences: [
      line('new-pano', { type: 'equirectangular' }),
      line('old-flat'),
    ],
  });
  filtered.instance.activate(filtered.viewer);
  assert.ok(await until(() => filtered.instance.coverageStats().count === 1));
});

test('coverage hints: nothing while loading, “no pictures” once an empty view has loaded', async (t) => {
  const env = coverageSetup(t);
  const release = env.holdTiles();
  env.instance.activate(env.viewer);
  assert.ok(await until(() => env.instance.coverageStats().loading));
  assert.equal(env.instance.coverageStats().hint, '');
  release();
  assert.ok(await until(() => !env.instance.coverageStats().loading));
  assert.equal(env.instance.coverageStats().hint, NO_COVERAGE_HINT);
});

test('from high up the density grid draws points, not counted as sequences, and the panel says to zoom in', async (t) => {
  const env = coverageSetup(t, {
    height: 200_000,
    grid: [{ lon: ORIGIN.lon, lat: ORIGIN.lat, pano: 2, flat: 3 }],
  });
  env.instance.activate(env.viewer);
  assert.ok(
    await until(() => env.instance.coverageStats().kind === 'overview'),
  );
  assert.ok(await until(() => !env.instance.coverageStats().loading));
  assert.equal(env.instance.coverageStats().zoom, 5);
  assert.equal(env.instance.coverageStats().count, 0, 'dots are not sequences');
  assert.equal(env.instance.coverageStats().hint, OVERVIEW_HINT);
});

test('switching off clears the cones and forgets a pending line click', async (t) => {
  const items = sequence('s', 3);
  const env = await mounted({ items, tiles: pictureTiles(items) });
  await withCones(t, env);
  env.instance.handlePick(`${PICK_PREFIX.sequence}s`, {
    groundPoint: () => east(0),
  });
  env.instance.deactivate();
  assert.equal(env.instance.sequenceStats().selectedId, null);
  // The click's preference is gone: a later lookup asks any sequence.
  await env.instance.nearestImage(east(0));
  assert.equal(env.source.calls.nearest.at(-1).collections, null);
});
