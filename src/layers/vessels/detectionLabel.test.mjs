// C6: a vessel with an ambient card gets no detection callout under it (the
// card already shows name, speed and course); the speed unit of a callout
// follows the UI language.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import aisLiveVesselsLayer, {
  _setVesselOverlayHostForTest,
  _setVesselStateForTest,
  _updateVesselCardsForTest,
} from '../../data/aisLiveVessels.js';
import { setLocale } from '../../i18n/index.js';

const record = (mmsi, name, screen, z = 0) => ({
  name,
  mmsi,
  type: 'Cargo',
  destination: '',
  speed: 9.5,
  course: 80,
  heading: 80,
  lastPositionUtc: '',
  missedRefreshes: 0,
  position: { x: 0, y: 0, z, screen },
  billboard: null,
});

function detectable(cameraZ) {
  const carded = record('200', 'GOLDEN BEAR', { x: 40, y: 30 });
  const plain = record('300', 'BAY PILOT', { x: 41, y: 31 });
  const originalProjection = Cesium.SceneTransforms.worldToWindowCoordinates;
  Cesium.SceneTransforms.worldToWindowCoordinates = (_scene, position) =>
    position.screen;
  _setVesselOverlayHostForTest({
    setEntries() {},
    setVisible() {},
    clearSource() {},
  });
  _setVesselStateForTest({
    viewer: {
      scene: {
        canvas: { clientWidth: 1600, clientHeight: 900 },
        camera: { positionWC: new Cesium.Cartesian3(0, 0, cameraZ) },
      },
    },
    records: [carded, plain],
    billboardCollection: { show: true, remove() {} },
  });
  try {
    // Both share one 118 px grid cell, so only one of them gets a card.
    _updateVesselCardsForTest([carded, plain]);
    return Object.fromEntries(
      aisLiveVesselsLayer
        .getDetectableObjects()
        .map((object) => [object.id, object]),
    );
  } finally {
    Cesium.SceneTransforms.worldToWindowCoordinates = originalProjection;
    _setVesselStateForTest({ enabled: false });
    _setVesselOverlayHostForTest();
  }
}

test('a vessel with a card on screen draws no detection label', () => {
  const objects = detectable(2_500);
  const hidden = Object.values(objects).filter((object) => object.hideLabel);
  assert.equal(hidden.length, 1, 'exactly the carded vessel hides its label');
  const shown = Object.values(objects).filter((object) => !object.hideLabel);
  assert.equal(shown.length, 1, 'the vessel without a card keeps its label');
  assert.equal(hidden[0].skipLabel, false, 'not treated as the tracked vessel');
});

test('past the card fade the detection label comes back', () => {
  const objects = detectable(4_000_000);
  assert.ok(Object.values(objects).every((object) => !object.hideLabel));
});

test('ru: the callout speed unit is translated', () => {
  setLocale('ru');
  try {
    const objects = detectable(4_000_000);
    assert.equal(objects['GOLDEN BEAR'].metric, '10 уз');
  } finally {
    setLocale('en');
  }
  assert.equal(detectable(4_000_000)['GOLDEN BEAR'].metric, '10 kn');
});
