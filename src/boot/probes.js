/**
 * SPECTRE boot probes. Each turns one real readiness signal into a boot row
 * state for `boot.mark(id, state, detail)`: `ok`, `degraded`, `offline` or
 * `timeout`. A probe never throws and gives up after its own timeout.
 */
import { t, tn } from '../i18n/index.js';

export const PROBE_TIMEOUT_MS = 3000;

const TIMEOUT = Object.freeze({ state: 'timeout', detail: '' });
const ACTIVE_FEED_STATES = new Set(['ok', 'error', 'pending']);

/**
 * GET a JSON endpoint and classify its body. Non-2xx and network failures
 * are `offline` with `offlineDetail`; no answer within `timeoutMs` is
 * `timeout`.
 * @param {string} url
 * @param {(body: any) => {state: string, detail: string}} classify
 * @returns {Promise<{state: string, detail: string}>}
 */
export async function probeEndpoint(
  url,
  classify,
  {
    fetchImpl = (...args) => globalThis.fetch(...args),
    timeoutMs = PROBE_TIMEOUT_MS,
    offlineDetail = '',
  } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok)
      return {
        state: 'offline',
        detail: offlineDetail || `HTTP ${response.status}`,
      };
    const body = await response.json();
    try {
      return classify(body);
    } catch {
      return { state: 'degraded', detail: t('unexpected reply') };
    }
  } catch {
    return controller.signal.aborted
      ? TIMEOUT
      : { state: 'offline', detail: offlineDetail };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe an endpoint for one boot row: `timeout` after `timeoutMs`, then the
 * real answer if it still comes within `lateMs`. A page busy loading the app
 * can read a reply only after its timer has fired, so a late answer upgrades
 * the row instead of being lost.
 * @param {(state: string, detail: string) => void} report
 */
export function probeRow(
  report,
  url,
  classify,
  { timeoutMs = PROBE_TIMEOUT_MS, lateMs = 8000, ...options } = {},
) {
  let answered = false;
  const timer = setTimeout(() => {
    if (!answered) report(TIMEOUT.state, TIMEOUT.detail);
  }, timeoutMs);
  return probeEndpoint(url, classify, { ...options, timeoutMs: lateMs }).then(
    ({ state, detail }) => {
      answered = true;
      clearTimeout(timer);
      report(state, detail);
    },
  );
}

/**
 * `/api/intel/health`: every active feed polled recently is `ok`; any feed
 * failing or older than the service's stale threshold is `degraded`.
 */
export function classifyIntelHealth(health) {
  const feeds = (Array.isArray(health?.feeds) ? health.feeds : []).filter(
    (feed) => ACTIVE_FEED_STATES.has(feed?.state),
  );
  if (!feeds.length) return { state: 'degraded', detail: t('no active feeds') };
  const now = Date.parse(health.now) || Date.now();
  const staleMs = (Number(health.freshness?.stale_after_seconds) || 0) * 1000;
  let lagging = feeds.filter(
    (feed) =>
      feed.consecutive_errors > 0 ||
      (staleMs > 0 &&
        feed.last_success_at &&
        now - Date.parse(feed.last_success_at) > staleMs),
  ).length;
  const overall = health.freshness?.state;
  if (!lagging && (overall === 'stale' || overall === 'offline'))
    lagging = feeds.length;
  if (!lagging)
    return {
      state: 'ok',
      detail: tn(feeds.length, '{count} feed', '{count} feeds'),
    };
  return {
    state: 'degraded',
    detail: t('stale feeds {stale}/{total}', {
      stale: lagging,
      total: feeds.length,
    }),
  };
}

/**
 * `/api/intel/chat/status`: Ollama reachable with the configured model is
 * `ok`; a missing model or no native tool calls is `degraded`.
 */
export function classifyChatStatus(status) {
  if (!status?.ollama?.reachable)
    return { state: 'offline', detail: t('Ollama not reachable') };
  const model = String(status.model || '');
  if (status.model_present === false)
    return { state: 'degraded', detail: t('{model} not pulled', { model }) };
  if (status.model_present !== true)
    return { state: 'degraded', detail: t('model check failed') };
  if (status.tools === false)
    return {
      state: 'degraded',
      detail: t('{model}, JSON tool calls', { model }),
    };
  return { state: 'ok', detail: model };
}

/** The globe row from the map controller's settled state. */
export function classifyGlobe(mapState, version) {
  const engine = version ? `Cesium ${version}` : 'Cesium';
  const basemap = mapState?.activeStack?.label;
  const fellBack =
    Boolean(mapState?.lastError) || mapState?.switchOrigin === 'automatic';
  if (fellBack)
    return {
      state: 'degraded',
      detail: `${engine} · ${t('fell back to {basemap}', { basemap: basemap || '?' })}`,
    };
  return { state: 'ok', detail: basemap ? `${engine} · ${basemap}` : engine };
}

/**
 * Resolve the globe row on the viewer's first rendered frame, or `timeout`.
 * @param {{viewer: any, mapStackController?: any}} scene
 */
export function probeGlobe(
  scene,
  { version = '', timeoutMs = PROBE_TIMEOUT_MS } = {},
) {
  return new Promise((resolve) => {
    let removeListener = null;
    let timer = 0;
    const finish = (result) => {
      clearTimeout(timer);
      removeListener?.();
      removeListener = null;
      resolve(result);
    };
    timer = setTimeout(() => finish(TIMEOUT), timeoutMs);
    try {
      const sceneRef = scene.viewer.scene;
      removeListener = sceneRef.postRender.addEventListener(() =>
        finish(classifyGlobe(scene.mapStackController?.getState?.(), version)),
      );
      sceneRef.requestRender?.();
    } catch (error) {
      finish({ state: 'offline', detail: describe(error) });
    }
  });
}

/** The layers row: registered layers, and any whose data source is missing. */
export function classifyLayers(catalog) {
  const layers = Array.isArray(catalog?.layers) ? catalog.layers : [];
  const unavailable = layers.filter(
    (layer) => catalog.getSourceAvailability?.(layer.id)?.available === false,
  ).length;
  if (!unavailable)
    return {
      state: 'ok',
      detail: tn(layers.length, '{count} layer', '{count} layers'),
    };
  return {
    state: 'degraded',
    detail: t('{unavailable} of {count} layers unavailable', {
      unavailable,
      count: layers.length,
    }),
  };
}

/** A short, single-line reason for an offline row. */
export function describe(error) {
  return String(error?.message || error || '')
    .split('\n')[0]
    .slice(0, 60);
}
