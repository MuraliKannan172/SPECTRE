import * as Cesium from 'cesium';
import {
  GNSS_LEVEL_COLORS,
  GNSS_MIN_AIRCRAFT,
  GNSS_NACP_THRESHOLD,
  GNSS_NIC_THRESHOLD,
  GNSS_WINDOW_MS,
  accumulateGnssObservations,
  binGnssCells,
  gnssProvenance,
  pruneGnssObservations,
} from './records.js';
export * from './records.js';
export { createAdsbGnssSource } from './source.js';

/** Low stays visible over land so coverage reads apart from no data. */
const FILL_ALPHA = Object.freeze({ low: 0.3, medium: 0.42, high: 0.55 });
const LEVEL_LABELS = Object.freeze({
  low: 'Under 2% low accuracy',
  medium: '2–10% low accuracy',
  high: 'Over 10% low accuracy',
});

/** Degrees at the centre of the current view, or null before the camera settles. */
export function defaultGnssViewAnchor(viewer) {
  const canvas = viewer?.scene?.canvas;
  const ellipsoid = viewer?.scene?.globe?.ellipsoid;
  // At globe scale the visible rectangle can be the whole world, whose
  // midpoint is unrelated to the place under the screen centre.
  const centre =
    canvas?.clientWidth > 0 &&
    canvas.clientHeight > 0 &&
    viewer.camera?.pickEllipsoid?.(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      ellipsoid,
    );
  const rectangle = viewer?.camera?.computeViewRectangle?.(ellipsoid);
  const carto = centre
    ? (ellipsoid || Cesium.Ellipsoid.WGS84).cartesianToCartographic(centre)
    : rectangle
      ? Cesium.Rectangle.center(rectangle)
      : viewer?.camera?.positionCartographic;
  if (!carto) return null;
  const latitude = Cesium.Math.toDegrees(carto.latitude);
  const longitude = Cesium.Math.toDegrees(carto.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
}

/**
 * Own one GNSS navigation-integrity display: rolling integrity observations
 * around the views the user visits, binned into cells coloured by the share
 * of aircraft reporting low navigation accuracy. The layer id keeps its
 * original `gnss-interference` spelling because share links depend on it.
 */
export function createGnssIntegrityLayer({
  source,
  viewAnchor = defaultGnssViewAnchor,
  now = () => Date.now(),
  windowMs = GNSS_WINDOW_MS,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('GNSS integrity layer requires a snapshot source');
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _cells = [];
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _manager = null;
  let _cameraTimer = null;
  let _backgroundRefresh = null;
  let _lastQueryKey = null;
  let _lastRequestAt = -Infinity;
  let _removeCameraEnd = null;
  let _removeCameraChanged = null;
  let _coverage = null;
  let _retryTimer = null;
  let _retryAt = 0;
  let _failureCount = 0;
  const _observations = new Map();
  const provenance = gnssProvenance({ windowMs });

  const queryKey = (anchor) =>
    anchor
      ? `${Math.round(anchor.latitude)},${Math.round(anchor.longitude)}`
      : null;

  function scheduleCameraRefresh() {
    if (!_enabled || !_dataSource) return;
    if (now() < _retryAt) return;
    const key = queryKey(viewAnchor(_viewer));
    if (!key || key === _lastQueryKey) return;
    clearTimeout(_cameraTimer);
    // Debounce drags and bound moving/follow cameras to at most 24 requests
    // per minute. Nearby views share the proxy's whole-degree cache key.
    _cameraTimer = setTimeout(
      async () => {
        _cameraTimer = null;
        if (!_enabled || _backgroundRefresh) return;
        const key = queryKey(viewAnchor(_viewer));
        if (!key || key === _lastQueryKey) return;
        await refreshInBackground();
      },
      Math.max(600, 2500 - (now() - _lastRequestAt)),
    );
  }

  async function refreshInBackground() {
    if (!_enabled || _backgroundRefresh) return;
    const controller = new AbortController();
    _backgroundRefresh = controller;
    try {
      if (_manager)
        await _manager.refreshLayer(layer.id, { signal: controller.signal });
      else await layer.update(undefined, { signal: controller.signal });
    } finally {
      if (_backgroundRefresh === controller) {
        _backgroundRefresh = null;
        scheduleCameraRefresh();
        scheduleRetry();
      }
    }
  }

  function scheduleRetry() {
    clearTimeout(_retryTimer);
    _retryTimer = null;
    if (!_enabled || !_retryAt) return;
    // Long provider cooldowns keep their full deadline. Browser timers cannot
    // exceed ~24 days, so wake in bounded chunks without fetching early.
    _retryTimer = setTimeout(
      () => {
        _retryTimer = null;
        void refreshInBackground();
      },
      Math.min(2147483647, Math.max(0, _retryAt - now())),
    );
    _retryTimer?.unref?.();
  }

  /** Age the store without new evidence, so expired cells leave the globe. */
  function expire() {
    pruneGnssObservations(_observations, now(), { windowMs });
    _cells = binGnssCells(_observations);
    render();
  }

  function render() {
    // Only the id and band change what is drawn; counts alone do not.
    const signature = JSON.stringify(
      _cells.map(({ id, level }) => [id, level]),
    );
    if (signature === _signature) return;
    _signature = signature;
    _dataSource.entities.removeAll();
    for (const cell of _cells) {
      const color = Cesium.Color.fromCssColorString(
        GNSS_LEVEL_COLORS[cell.level],
      );
      _dataSource.entities.add(
        new Cesium.Entity({
          id: `gnss-interference:${cell.id}`,
          rectangle: {
            coordinates: Cesium.Rectangle.fromDegrees(
              cell.west,
              cell.south,
              cell.east,
              cell.north,
            ),
            material: new Cesium.ColorMaterialProperty(
              color.withAlpha(FILL_ALPHA[cell.level]),
            ),
            classificationType: Cesium.ClassificationType.BOTH,
          },
        }),
      );
    }
    _viewer?.scene?.requestRender?.();
  }

  const layer = {
    id: 'gnss-interference',
    name: 'GNSS Integrity',
    icon: '📡',
    source: 'adsb.lol',
    /** Where each part of the method comes from; see records.js. */
    provenance,
    updateInterval: 60000,

    attachDataManager(manager) {
      _manager = manager;
    },

    init(viewer) {
      if (_viewer)
        throw new Error('GNSS integrity layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('gnss-interference');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _removeCameraEnd = viewer.camera?.moveEnd?.addEventListener(
        scheduleCameraRefresh,
      );
      _removeCameraChanged = viewer.camera?.changed?.addEventListener(
        scheduleCameraRefresh,
      );
    },

    enable() {
      _enabled = true;
      // Cells left from before a long disable must not reappear past the window.
      if (_dataSource) {
        expire();
        _dataSource.show = true;
      }
    },

    disable() {
      clearTimeout(_cameraTimer);
      _cameraTimer = null;
      clearTimeout(_retryTimer);
      _retryTimer = null;
      _backgroundRefresh?.abort();
      _backgroundRefresh = null;
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || !_dataSource || signal?.aborted) return false;
      if (now() < _retryAt) {
        expire();
        scheduleRetry();
        return true;
      }
      _retryAt = 0;
      clearTimeout(_retryTimer);
      _retryTimer = null;
      const anchor = viewAnchor(_viewer);
      // No anchor yet (camera still settling) is not a failure: returning
      // false would make the manager reject the enable. The next interval
      // retries; cells already drawn still age out of the window.
      if (!anchor) {
        expire();
        return true;
      }
      _request?.abort();
      const request = new AbortController();
      _request = request;
      const onAbort = () => request.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      _lastQueryKey = queryKey(anchor);
      _lastRequestAt = now();
      _coverage = {
        kind: 'regional',
        latitude: Math.round(anchor.latitude),
        longitude: Math.round(anchor.longitude),
        radiusNm: 250,
      };
      let received = false;
      try {
        const snapshot = await source.getSnapshot(anchor, {
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        received = true;
        // Date the rows by when the proxy observed them: a cached or stale
        // replay keeps its original age instead of restarting the window.
        // The proxy reports that age, so client and server clocks never mix.
        const at = now();
        accumulateGnssObservations(_observations, snapshot.rows, at, {
          windowMs,
          observedAt: at - snapshot.ageMs,
        });
        _cells = binGnssCells(_observations);
        render();
        _stale = snapshot.stale === true;
        _lastUpdate = now();
        _lastError = null;
        _retryAt = 0;
        _failureCount = 0;
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        // A renderer/programming failure remains a real lifecycle failure.
        // Only acquisition failures are kept enabled for recovery.
        if (received) throw e;
        console.warn('[Data:GNSS] Fetch error:', e);
        _lastError = e?.message || 'GNSS integrity source unavailable';
        // Keep the last cells only while their evidence is inside the window.
        expire();
        if (e?.retryable === false) return false;
        _failureCount = Math.min(3, _failureCount + 1);
        const delay =
          Number.isFinite(e?.retryAfterMs) && e.retryAfterMs > 0
            ? e.retryAfterMs
            : Math.min(120000, 30000 * 2 ** (_failureCount - 1));
        _retryAt = Math.max(
          _retryAt,
          Math.min(Number.MAX_VALUE, now() + delay),
        );
        // Enabling the display succeeded. Stats still report an unavailable
        // or degraded feed; the manager keeps its normal refresh failure lane.
        return true;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (_request === request) _request = null;
        scheduleCameraRefresh();
        scheduleRetry();
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _removeCameraEnd?.();
      _removeCameraChanged?.();
      _removeCameraEnd = null;
      _removeCameraChanged = null;
      _request?.abort();
      _request = null;
      _enabled = false;
      _observations.clear();
      _cells = [];
      _signature = null;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _coverage = null;
      _retryAt = 0;
      _failureCount = 0;
      _lastQueryKey = null;
      _manager = null;
    },

    getRowControls() {
      return {
        chips: [],
        info:
          'Regional sample · 250 nm radius · pan to sample another area' +
          (_lastError && _retryAt
            ? ` · ${_lastError} · Retrying automatically${
                _retryAt <= 8640000000000000
                  ? ` at ${new Date(_retryAt).toISOString().slice(11, 19)} UTC`
                  : ' after provider cooldown'
              }`
            : ''),
        infoTitle:
          'Updates automatically after pan or zoom and once a minute. The public feed covers a 250-nautical-mile circle around the view centre; zooming out does not make it a worldwide snapshot. Blank cells have insufficient observations.',
        legend: ['high', 'medium', 'low'].map((level, index) => ({
          label: LEVEL_LABELS[level],
          color: GNSS_LEVEL_COLORS[level],
          count: _cells.filter((cell) => cell.level === level).length,
          ...(index === 0
            ? {
                blurb: `Share of ADS-B aircraft reporting low navigation accuracy over the last ${provenance.window.minutes} minutes, around the views you visit. An aircraft counts when it reports NIC < ${GNSS_NIC_THRESHOLD} or NACp < ${GNSS_NACP_THRESHOLD} or GPS loss: a GEV threshold borrowed from US ADS-B Out minima, not a published interference test. Cells use gpsjam.org's formula and 2% / 10% bands. Cells with fewer than ${GNSS_MIN_AIRCRAFT} aircraft are not drawn, so blank areas mean no data, not clean GNSS. Medium and high cells are navigation-integrity anomalies. Suspected jamming or spoofing is one possible cause, not a detection: avionics faults also report low values.`,
              }
            : {}),
        })),
      };
    },

    getStats() {
      return {
        count: _cells.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        retryInSec: _retryAt
          ? Math.max(0, Math.ceil((_retryAt - now()) / 1000))
          : null,
        stale: _stale,
        provenance,
        coverage: _coverage,
        // Load-bearing: without an explicit boolean, layerFeedState reads the
        // adsb.lol source name as a flights fallback (src/data/feedState.js).
        fallback: false,
      };
    },
  };
  return layer;
}
