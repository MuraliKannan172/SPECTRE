import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  FOOTPRINT_CHIP_ID,
  FOOTPRINT_PARAM,
  withSatelliteFootprint,
} from './index.js';

function fakeLayer() {
  const calls = [];
  return {
    calls,
    id: 'satellites',
    name: 'Satellites',
    async init(viewer) {
      calls.push(['init', viewer]);
      return 'ready';
    },
    enable: () => calls.push(['enable']),
    disable: () => calls.push(['disable']),
    destroy: () => calls.push(['destroy']),
    setParams(params, options) {
      calls.push(['setParams', params, options]);
      return true;
    },
    getParams: () => ({ catalog: 'core', selectedSatTrackingId: null }),
    getRowControls: () => ({
      chips: [{ id: 'catalog', label: 'DENSE' }],
      legend: [{ label: 'Station' }],
    }),
    setRowControlsListener: (listener) => calls.push(['listener', listener]),
    getNextIssPass: () => 'pass',
  };
}

function fakeViewer() {
  const preRender = new Set();
  const viewer = {
    trackedEntity: null,
    added: [],
    removed: [],
    preRender,
    dataSources: {
      add: (source) => viewer.added.push(source),
      remove: (source) => viewer.removed.push(source),
    },
    scene: {
      preRender: {
        addEventListener(listener) {
          preRender.add(listener);
          return () => preRender.delete(listener);
        },
      },
    },
    frame() {
      for (const listener of preRender) listener();
    },
  };
  return viewer;
}

const ISS = Cesium.Cartesian3.fromDegrees(20, 10, 420_000);
const readout = {
  cachedTrackedDisplayPosition: (entity) => entity.position,
};

async function build() {
  const inner = fakeLayer();
  let time = 0;
  const layer = withSatelliteFootprint(inner, {
    readout,
    now: () => (time += 1000),
  });
  const viewer = fakeViewer();
  assert.equal(await layer.init(viewer), 'ready');
  const footprint = viewer.added[0].entities.getById(
    'spectre-satellite-footprint',
  );
  return { inner, layer, viewer, footprint };
}

test('everything else passes straight through to the satellites layer', async () => {
  const { inner, layer } = await build();
  assert.equal(layer.id, 'satellites');
  assert.equal(layer.getNextIssPass(), 'pass');
  assert.deepEqual(layer.getParams(), {
    catalog: 'core',
    selectedSatTrackingId: null,
  });
  assert.equal(layer.setParams({ catalog: 'dense' }, { origin: 'user' }), true);
  assert.deepEqual(inner.calls.at(-1), [
    'setParams',
    { catalog: 'dense' },
    { origin: 'user' },
  ]);
});

test('the FOOTPRINT chip toggles without touching the layer params', async () => {
  const { inner, layer } = await build();
  const listener = () => {};
  layer.setRowControlsListener(listener);
  let chip = layer.getRowControls().chips.at(-1);
  assert.equal(chip.id, FOOTPRINT_CHIP_ID);
  assert.equal(chip.active, false);
  assert.deepEqual(chip.params, { [FOOTPRINT_PARAM]: true });
  assert.match(chip.title, /not a sensor field of view/);

  const before = inner.calls.length;
  assert.equal(layer.setParams(chip.params, { origin: 'user' }), true);
  // A footprint-only write must not reach the layer: it would cancel a
  // pending tracking restore.
  assert.equal(inner.calls.length, before);
  chip = layer.getRowControls().chips.at(-1);
  assert.equal(chip.active, true);
  assert.deepEqual(chip.params, { [FOOTPRINT_PARAM]: false });

  layer.setParams({ [FOOTPRINT_PARAM]: false, catalog: 'core' });
  assert.deepEqual(inner.calls.at(-1), [
    'setParams',
    { catalog: 'core' },
    undefined,
  ]);
});

test('no chip when the layer gives up its row', async () => {
  const inner = fakeLayer();
  inner.getRowControls = () => ({ chips: [], legend: [] });
  const layer = withSatelliteFootprint(inner, { readout });
  assert.deepEqual(layer.getRowControls(), { chips: [], legend: [] });
});

test('the ring shows only with the option on, the layer on and a tracked satellite', async () => {
  const { layer, viewer, footprint } = await build();
  layer.enable();
  viewer.trackedEntity = { gevTrackedId: 'satellites:25544', position: ISS };
  viewer.frame();
  assert.equal(footprint.show, false, 'option off');

  layer.setParams({ [FOOTPRINT_PARAM]: true });
  viewer.frame();
  assert.equal(footprint.show, true);
  const ring = footprint.polyline.positions.getValue(Cesium.JulianDate.now());
  assert.equal(ring.length, 121);
  const edge = Cesium.Cartographic.fromCartesian(ring[0]);
  assert.ok(Math.abs(edge.height) < 1);

  viewer.trackedEntity = { gevTrackedId: 'flights:abc', position: ISS };
  viewer.frame();
  assert.equal(footprint.show, false, 'a tracked aircraft gets no ring');

  viewer.trackedEntity = { gevTrackedId: 'satellites:25544', position: ISS };
  viewer.frame();
  assert.equal(footprint.show, true);
  layer.disable();
  assert.equal(footprint.show, false, 'layer off');
});

test('destroy removes the ring and its frame listener', async () => {
  const { inner, layer, viewer } = await build();
  layer.destroy();
  assert.equal(viewer.removed.length, 1);
  assert.equal(viewer.preRender.size, 0);
  assert.deepEqual(inner.calls.at(-1), ['destroy']);
});
