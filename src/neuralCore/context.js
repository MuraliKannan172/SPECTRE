/**
 * SPECTRE Neural Core: what the model is told about the map each turn
 * (ADR-001 D5, "Map context, no round trip"). Plain data, bounded in size;
 * duck-typed against Cesium so it runs without importing it.
 */

const DEG = 180 / Math.PI;
const MAX_LAYERS = 40;
const MAX_OPTION_CHARS = 300;

const round = (value, places = 4) =>
  Number.isFinite(value) ? Number(value.toFixed(places)) : null;

/** Camera, visible area and time. */
export function viewportSnapshot(viewer, now = new Date()) {
  const camera = viewer?.camera;
  const place = camera?.positionCartographic;
  const snapshot = {
    time_utc: now.toISOString(),
    local_time: now.toString().slice(0, 33),
  };
  if (!place) return snapshot;
  snapshot.center = {
    lat: round(place.latitude * DEG),
    lon: round(place.longitude * DEG),
  };
  snapshot.altitude_m = Math.round(place.height);
  snapshot.heading_deg = Math.round((camera.heading ?? 0) * DEG);
  snapshot.pitch_deg = Math.round((camera.pitch ?? 0) * DEG);
  try {
    const rect = camera.computeViewRectangle?.(viewer.scene?.globe?.ellipsoid);
    if (rect)
      snapshot.bbox = [rect.west, rect.south, rect.east, rect.north].map(
        (value) => round(value * DEG, 3),
      );
  } catch {
    /* looking at the sky: no ground rectangle */
  }
  const tracked = viewer.trackedEntity?.gevTrackedId;
  if (typeof tracked === 'string') snapshot.tracking = tracked.slice(0, 80);
  return snapshot;
}

/** Layers that are on, with their options where a layer reports them. */
export function layerStateSnapshot(dataManager) {
  // getEnabledLayerIds may return any iterable (a Set, for example).
  const ids = [...(dataManager?.getEnabledLayerIds?.() ?? [])].slice(
    0,
    MAX_LAYERS,
  );
  const options = {};
  for (const id of ids) {
    let params;
    try {
      params = dataManager.layers?.get(id)?.module?.getParams?.();
    } catch {
      continue;
    }
    if (!params || typeof params !== 'object') continue;
    const text = JSON.stringify(params);
    if (text && text.length <= MAX_OPTION_CHARS) options[id] = params;
  }
  return { on: ids, options };
}
