import * as Cesium from 'cesium';
import { msg, t, tn } from '../../i18n/index.js';
import {
  EONET_ATTRIBUTION,
  EONET_CATEGORIES,
  EONET_OVERLAY_SOURCE_ID,
  buildEonetCard,
  eonetCategory,
  eonetPrimaryLink,
} from './cards.js';
import { EONET_UNAVAILABLE } from './source.js';

export * from './cards.js';
export * from './source.js';

const PICK_PREFIX = 'eonet:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const STALE = msg('Cached natural events · EONET unavailable');

/**
 * SPECTRE: open NASA EONET natural events (last 30 days), one point each,
 * colored by category. Click a point for its card; click the card to open
 * the source EONET lists.
 */
export function createEonetLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
  now = () => Date.now(),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Natural events require a snapshot source');
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let request = null;
  let clickHandler = null;
  let rowControlsListener = null;
  let error = null;
  let stale = false;
  let lastUpdate = null;
  let selectedId = null;
  const events = new Map();
  const notify = () => rowControlsListener?.();
  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishCard() {
    if (!canSelect()) return;
    const record = selectedId === null ? null : events.get(selectedId);
    if (!record) {
      overlayHost.setEntries(EONET_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const card = {
      ...buildEonetCard(record, { canOpen: Boolean(openExternal) }),
      position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
    };
    const link = eonetPrimaryLink(record);
    if (link && openExternal)
      card.activate = () => {
        openExternal(link);
        return true;
      };
    overlayHost.setEntries(EONET_OVERLAY_SOURCE_ID, [card], CARD_HOST_OPTIONS);
  }

  function select(id) {
    selectedId = events.has(id) ? id : null;
    publishCard();
    notify();
  }

  function render() {
    if (!dataSource) return;
    dataSource.entities.suspendEvents();
    dataSource.entities.removeAll();
    for (const record of events.values()) {
      dataSource.entities.add(
        new Cesium.Entity({
          id: `${PICK_PREFIX}${record.id}`,
          position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
          point: {
            pixelSize: 9,
            color: Cesium.Color.fromCssColorString(
              eonetCategory(record.categoryId).color,
            ),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: 50_000,
          },
        }),
      );
    }
    dataSource.entities.resumeEvents();
    if (selectedId !== null && !events.has(selectedId)) selectedId = null;
    publishCard();
    viewer?.scene?.requestRender?.();
  }

  function installClickHandler() {
    if (!canSelect() || clickHandler || !viewer) return;
    picking.registerPickOwner?.(layer.id, (id) => id.startsWith(PICK_PREFIX));
    clickHandler = screenSpaceEventHandlerFactory(viewer);
    clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: EONET_OVERLAY_SOURCE_ID },
      );
      const selected = selectedId === null ? null : events.get(selectedId);
      if (cardHit && selected) {
        const link = eonetPrimaryLink(selected);
        if (link && openExternal) openExternal(link);
        return;
      }
      const picked = viewer.scene.pick(click.position);
      const id = picked ? picking.resolvePickId(picked) : null;
      if (typeof id === 'string' && id.startsWith(PICK_PREFIX)) {
        select(id.slice(PICK_PREFIX.length));
        return;
      }
      if (id && picking.isOwnedByOtherLayer?.(layer.id, id)) return;
      if (selectedId !== null) select(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    clickHandler?.destroy();
    clickHandler = null;
    picking?.unregisterPickOwner?.(layer.id);
  }

  const counts = () => {
    const byCategory = new Map();
    for (const record of events.values()) {
      const key = EONET_CATEGORIES[record.categoryId]
        ? record.categoryId
        : 'other';
      byCategory.set(key, (byCategory.get(key) || 0) + 1);
    }
    return byCategory;
  };

  const layer = {
    id: 'natural-events',
    name: 'Natural Events (EONET)',
    icon: '🌐',
    source: 'NASA EONET',
    updateInterval: 600_000,

    init(nextViewer) {
      if (viewer)
        throw new Error('Natural events layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource('natural-events');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost?.setVisible?.(EONET_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      notify();
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      removeClickHandler();
      selectedId = null;
      if (dataSource) dataSource.show = false;
      overlayHost?.clearSource?.(EONET_OVERLAY_SOURCE_ID);
      overlayHost?.setVisible?.(EONET_OVERLAY_SOURCE_ID, false);
      notify();
    },

    async update() {
      if (!enabled || !dataSource) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const snapshot = await source.getSnapshot({
          signal: controller.signal,
        });
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        if (snapshot.unavailable) {
          error = EONET_UNAVAILABLE;
          return false;
        }
        events.clear();
        for (const record of snapshot.events) events.set(record.id, record);
        stale = snapshot.stale;
        error = null;
        lastUpdate = snapshot.fetchedAt ?? now();
        render();
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        error = cause?.message || EONET_UNAVAILABLE;
        return false;
      } finally {
        if (request === controller) request = null;
        notify();
      }
    },

    setParams(params = {}) {
      if (params.eventId === null) select(null);
      else if (typeof params.eventId === 'string') select(params.eventId);
    },

    getRowControls() {
      const byCategory = counts();
      return {
        chips: [],
        legend: [...byCategory.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([id, count]) => ({
            label: t(EONET_CATEGORIES[id].label),
            color: EONET_CATEGORIES[id].color,
            count,
          })),
        info: [
          error ? t(error) : stale ? t(STALE) : null,
          tn(events.size, '{count} open event', '{count} open events', {
            count: events.size,
          }),
          t(EONET_ATTRIBUTION),
        ]
          .filter(Boolean)
          .join('\n'),
        infoTitle: t(
          'Open natural events from the last 30 days, as listed by NASA EONET. Each point is the event’s latest observation; select one for its card and click the card to open its source.',
        ),
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    destroy() {
      layer.disable();
      if (dataSource && viewer) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      viewer = null;
      rowControlsListener = null;
    },

    getAnalystRecords(maxCount = 500) {
      if (!enabled) return [];
      return [...events.values()]
        .slice(0, Math.max(1, Math.floor(maxCount) || 500))
        .map((record) => ({
          id: record.id,
          title: record.title,
          category: record.categoryTitle,
          lat: record.lat,
          lon: record.lon,
          observedAt: new Date(record.observedAt).toISOString(),
        }));
    },

    getStats() {
      return {
        count: events.size,
        lastUpdate,
        error,
        stale,
        source: 'NASA EONET',
      };
    },
  };
  return layer;
}
