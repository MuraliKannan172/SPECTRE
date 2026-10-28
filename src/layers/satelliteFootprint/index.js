import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import { FOOTPRINT_MIN_ELEVATION_DEG, footprintRing } from './footprint.js';

/**
 * SPECTRE: a FOOTPRINT option on the satellites layer. While it is on and the
 * camera tracks a satellite, a ring on the ground marks where that satellite
 * stands at least FOOTPRINT_MIN_ELEVATION_DEG above the horizon. It wraps the
 * upstream layer instead of editing it: every other method passes through,
 * and with the option off (the default) the layer behaves exactly as before.
 * The option is in memory only; share links do not carry it.
 */
export const FOOTPRINT_CHIP_ID = 'spectre-footprint';
export const FOOTPRINT_PARAM = 'visibilityFootprint';
const TRACKED_PREFIX = 'satellites:';
const UPDATE_MS = 250;
const FOOTPRINT_COLOR = '#FFD84D'; // the tracked satellite's own yellow

/**
 * @param {object} layer - The satellites layer.
 * @param {{readout?: {cachedTrackedDisplayPosition?: Function},
 *   now?: () => number}} [options]
 * @returns {object} The same layer contract, with the option added.
 */
export function withSatelliteFootprint(
  layer,
  { readout, now = () => performance.now() } = {},
) {
  let viewer = null;
  let dataSource = null;
  let entity = null;
  let removePreRender = null;
  let rowControlsListener = null;
  let enabled = false;
  let footprintOn = false;
  let lastUpdate = -Infinity;
  let ringPositions = [];

  function trackedSubSatellite() {
    const tracked = viewer?.trackedEntity;
    if (!String(tracked?.gevTrackedId ?? '').startsWith(TRACKED_PREFIX))
      return null;
    const cartesian = readout?.cachedTrackedDisplayPosition?.(tracked);
    if (!cartesian) return null;
    const place = Cesium.Cartographic.fromCartesian(cartesian);
    if (!place) return null;
    return {
      latitude: Cesium.Math.toDegrees(place.latitude),
      longitude: Cesium.Math.toDegrees(place.longitude),
      altitudeM: place.height,
    };
  }

  function refresh(force = false) {
    if (!entity) return;
    const subSatellite = enabled && footprintOn ? trackedSubSatellite() : null;
    if (!subSatellite) {
      entity.show = false;
      return;
    }
    const time = now();
    if (!force && entity.show && time - lastUpdate < UPDATE_MS) return;
    lastUpdate = time;
    const ring = footprintRing(subSatellite);
    ringPositions = ring.length
      ? Cesium.Cartesian3.fromDegreesArray(ring.flat())
      : [];
    entity.show = ring.length > 0;
  }

  function footprintChip() {
    return {
      id: FOOTPRINT_CHIP_ID,
      label: t('FOOTPRINT'),
      active: footprintOn,
      state: footprintOn ? 'active' : 'idle',
      title: t(
        'Ground visibility of the satellite you track: where it stands at least {degrees}° above the horizon. Line of sight only, not a sensor field of view.',
        { degrees: FOOTPRINT_MIN_ELEVATION_DEG },
      ),
      params: { [FOOTPRINT_PARAM]: !footprintOn },
    };
  }

  return {
    ...layer,

    async init(nextViewer, ...rest) {
      const result = await layer.init(nextViewer, ...rest);
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource('spectre-satellite-footprint');
      const color = Cesium.Color.fromCssColorString(FOOTPRINT_COLOR);
      entity = dataSource.entities.add({
        id: 'spectre-satellite-footprint',
        show: false,
        polyline: {
          // A callback makes this a dynamic polyline, drawn synchronously
          // each frame. Constant positions replaced every UPDATE_MS would
          // send the line back to the async geometry workers each time, and
          // it would never finish building.
          positions: new Cesium.CallbackProperty(() => ringPositions, false),
          width: 2,
          arcType: Cesium.ArcType.GEODESIC,
          material: color.withAlpha(0.9),
          // Still visible where terrain or 3D tiles rise above the ring.
          depthFailMaterial: color.withAlpha(0.45),
        },
      });
      viewer.dataSources.add(dataSource);
      removePreRender = viewer.scene.preRender.addEventListener(() =>
        refresh(),
      );
      return result;
    },

    enable(...args) {
      enabled = true;
      const result = layer.enable(...args);
      refresh(true);
      return result;
    },

    disable(...args) {
      enabled = false;
      refresh(true);
      return layer.disable(...args);
    },

    destroy(...args) {
      removePreRender?.();
      removePreRender = null;
      if (dataSource) viewer?.dataSources?.remove(dataSource, true);
      dataSource = null;
      entity = null;
      viewer = null;
      return layer.destroy(...args);
    },

    setParams(params = {}, options) {
      if (!params || !Object.hasOwn(params, FOOTPRINT_PARAM))
        return layer.setParams(params, options);
      const { [FOOTPRINT_PARAM]: requested, ...rest } = params;
      footprintOn = requested === true;
      refresh(true);
      rowControlsListener?.();
      // Pass nothing on for a footprint-only change: the layer treats any
      // explicit params write as a cue to drop a pending tracking restore.
      return Object.keys(rest).length ? layer.setParams(rest, options) : true;
    },

    getRowControls() {
      const controls = layer.getRowControls?.() ?? { chips: [], legend: [] };
      // The layer gives up its row while another owner borrows it without
      // points (Space Missions); the footprint follows.
      if (!controls.chips?.length && !controls.legend?.length) return controls;
      return {
        ...controls,
        chips: [...(controls.chips ?? []), footprintChip()],
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
      return layer.setRowControlsListener?.(listener);
    },
  };
}
