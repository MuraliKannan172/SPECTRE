import * as Cesium from 'cesium';
import { msg, t, tn } from '../../i18n/index.js';
import {
  GDELT_CITATION,
  NEWS_CATEGORY_LABELS,
  NEWS_OVERLAY_SOURCE_ID,
  buildNewsCard,
  formatNewsAge,
  primaryNewsLink,
} from './cards.js';
import { NEWS_CATEGORIES, normalizeNewsStory } from './records.js';
import {
  INTEL_OFFLINE,
  NEWS_DEFAULT_WINDOW_HOURS,
  NEWS_UNAVAILABLE,
  NEWS_WINDOW_HOURS,
} from './source.js';
import { createNewsStream } from './stream.js';
import { newsFreshness } from './freshness.js';
import {
  decodeNewsCategoryFilter,
  encodeNewsCategoryFilter,
} from './shareOptions.js';
import {
  NEWS_CLUSTER_COLOR,
  newsClusterSize,
  newsMarkerStyle,
} from './style.js';

export * from './cards.js';
export * from './records.js';
export * from './source.js';
export * from './style.js';
export * from './freshness.js';

const PICK_PREFIX = 'news:';
const LIST_LIMIT = 8;
// Stories closer than this share a place: zooming will not separate them.
const COLOCATED_METERS = 1_000;
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const WINDOW_LABELS = Object.freeze({
  6: msg('6h'),
  24: msg('24h'),
  72: msg('3d'),
  168: msg('7d'),
});
const reduceMotion = () =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

/** A circle with a count, for one cluster size; null outside a browser. */
function clusterImage(cache, count) {
  if (typeof document === 'undefined') return null;
  const size = newsClusterSize(count);
  const key = `${size}:${count > 99 ? '99+' : count}`;
  if (cache.has(key)) return cache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * 2;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = 'rgba(11, 11, 14, 0.85)';
  context.strokeStyle = NEWS_CLUSTER_COLOR;
  context.lineWidth = 3;
  context.beginPath();
  context.arc(size, size, size - 3, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.fillStyle = NEWS_CLUSTER_COLOR;
  context.font = `600 ${Math.round(size * 0.8)}px "JetBrains Mono", monospace`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(count > 99 ? '99+' : String(count), size, size + 1);
  cache.set(key, canvas);
  return canvas;
}

/**
 * SKYNET: news stories from the local intel service on the globe.
 * Markers are colored by category, sized by outlet count and faded by age;
 * nearby markers cluster. Click a marker for its card (the card opens the
 * article); the News drawer lists every outlet.
 */
export function createNewsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
  eventSourceFactory,
  now = () => Date.now(),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('News requires a snapshot source');
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let request = null;
  let clickHandler = null;
  let rowControlsListener = null;
  let error = null;
  let freshness = null;
  let lastUpdate = null;
  let loading = false;
  let selectedId = null;
  let selectedColocated = 0;
  let panelOpener = null;
  let windowHours = NEWS_DEFAULT_WINDOW_HOURS;
  let categories = new Set();
  const records = new Map();
  const subscribers = new Set();
  const clusterImages = new Map();
  let stream = null;

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function notify() {
    rowControlsListener?.();
    const model = layer.getModel();
    for (const listener of subscribers) {
      try {
        listener(model);
      } catch {
        // a broken subscriber must not stop the layer
      }
    }
  }

  function wanted(record) {
    if (!record?.location?.onGlobe) return false;
    if (categories.size && !categories.has(record.category)) return false;
    return now() - record.publishedAt <= windowHours * 3600_000;
  }

  function newest() {
    return [...records.values()].sort(
      (a, b) => b.publishedAt - a.publishedAt || b.id - a.id,
    );
  }

  function entityFor(record) {
    const style = newsMarkerStyle(record, now(), windowHours);
    return new Cesium.Entity({
      id: `${PICK_PREFIX}${record.id}`,
      position: Cesium.Cartesian3.fromDegrees(
        record.location.lon,
        record.location.lat,
      ),
      point: {
        pixelSize: style.pixelSize,
        color: Cesium.Color.fromCssColorString(style.color).withAlpha(
          style.opacity,
        ),
        outlineColor: Cesium.Color.fromCssColorString(style.outlineColor),
        outlineWidth: style.outlineWidth,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 50_000,
      },
    });
  }

  function render() {
    if (!dataSource) return;
    dataSource.entities.suspendEvents();
    dataSource.entities.removeAll();
    for (const record of records.values()) {
      if (wanted(record)) dataSource.entities.add(entityFor(record));
    }
    dataSource.entities.resumeEvents();
    if (selectedId !== null && !records.has(selectedId)) selectedId = null;
    publishCard();
    viewer?.scene?.requestRender?.();
  }

  function publishCard() {
    if (!canSelect()) return;
    const record = selectedId === null ? null : records.get(selectedId);
    if (!record?.location) {
      overlayHost.setEntries(NEWS_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    const card = {
      ...buildNewsCard(record, now(), {
        canOpen: Boolean(openExternal),
        colocated: selectedColocated,
      }),
      position: Cesium.Cartesian3.fromDegrees(
        record.location.lon,
        record.location.lat,
      ),
    };
    const link = primaryNewsLink(record);
    if (link && openExternal)
      card.activate = () => {
        openExternal(link);
        return true;
      };
    overlayHost.setEntries(NEWS_OVERLAY_SOURCE_ID, [card], CARD_HOST_OPTIONS);
  }

  function select(id, { focus = false, colocated = 0 } = {}) {
    selectedId = records.has(id) ? id : null;
    selectedColocated = selectedId === null ? 0 : colocated;
    publishCard();
    const record = selectedId === null ? null : records.get(selectedId);
    if (focus && record?.location && viewer?.camera) {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          record.location.lon,
          record.location.lat,
          900_000,
        ),
        duration: reduceMotion() ? 0 : 1.4,
      });
    }
    notify();
  }

  /**
   * A cluster click zooms in until the stories separate. Stories placed at
   * the very same point (a country's center, say) never separate, so for
   * those the newest is selected and its card says how many share the place.
   */
  function openCluster(entities) {
    const positions = entities
      .map((entity) => entity.position?.getValue?.(Cesium.JulianDate.now()))
      .filter(Boolean);
    if (!positions.length || !viewer?.camera) return;
    const sphere = Cesium.BoundingSphere.fromPoints(positions);
    if (sphere.radius < COLOCATED_METERS) {
      const ids = entities
        .map((entity) => Number(String(entity.id).slice(PICK_PREFIX.length)))
        .filter((id) => records.has(id))
        .sort(
          (a, b) =>
            records.get(b).publishedAt - records.get(a).publishedAt || b - a,
        );
      if (ids.length) select(ids[0], { colocated: ids.length - 1 });
      return;
    }
    sphere.radius = Math.max(sphere.radius, 50_000);
    viewer.camera.flyToBoundingSphere(sphere, {
      duration: reduceMotion() ? 0 : 1.2,
    });
  }

  function pickedStoryId(picked) {
    const id = picking.resolvePickId(picked);
    if (typeof id !== 'string' || !id.startsWith(PICK_PREFIX)) return null;
    const storyId = Number(id.slice(PICK_PREFIX.length));
    return records.has(storyId) ? storyId : null;
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
        { sourceId: NEWS_OVERLAY_SOURCE_ID },
      );
      const selected = selectedId === null ? null : records.get(selectedId);
      if (cardHit && selected) {
        const link = primaryNewsLink(selected);
        if (link && openExternal) openExternal(link);
        return;
      }
      const picked = viewer.scene.pick(click.position);
      // A cluster's pick id is the array of entities it stands for.
      if (Array.isArray(picked?.id)) {
        const mine = picked.id.filter((entity) =>
          String(entity?.id ?? '').startsWith(PICK_PREFIX),
        );
        if (mine.length) {
          openCluster(mine);
          return;
        }
      }
      const storyId = picked ? pickedStoryId(picked) : null;
      if (storyId !== null) {
        select(storyId);
        return;
      }
      if (picked) {
        const id = picking.resolvePickId(picked);
        if (id && picking.isOwnedByOtherLayer?.(layer.id, id)) return;
      }
      if (selectedId !== null) select(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    clickHandler?.destroy();
    clickHandler = null;
    picking?.unregisterPickOwner?.(layer.id);
  }

  function styleClusters() {
    const clustering = dataSource.clustering;
    clustering.enabled = true;
    clustering.pixelRange = 26;
    clustering.minimumClusterSize = 3;
    clustering.clusterBillboards = true;
    clustering.clusterLabels = true;
    clustering.clusterPoints = true;
    clustering.clusterEvent.addEventListener((clustered, cluster) => {
      const image = clusterImage(clusterImages, clustered.length);
      cluster.label.show = !image;
      cluster.label.text = String(clustered.length);
      cluster.billboard.show = Boolean(image);
      if (image) {
        cluster.billboard.image = image;
        cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER;
        cluster.billboard.disableDepthTestDistance = 50_000;
        // Cesium gives only the cluster's label the clustered entities as its
        // id; the billboard drawn in its place needs them too, or a click on
        // it picks nothing.
        cluster.billboard.id = clustered;
      }
    });
  }

  function acceptLive(raw) {
    const record = normalizeNewsStory(raw);
    if (!record) return;
    records.set(record.id, record);
    if (wanted(record) && dataSource) {
      dataSource.entities.removeById(`${PICK_PREFIX}${record.id}`);
      dataSource.entities.add(entityFor(record));
      viewer?.scene?.requestRender?.();
    }
    lastUpdate = now();
    for (const listener of subscribers) {
      try {
        listener(layer.getModel(), { live: record });
      } catch {
        // ignore subscriber failures
      }
    }
    rowControlsListener?.();
  }

  const layer = {
    id: 'news',
    name: 'News',
    icon: '📰',
    source: 'SKYNET intel',
    updateInterval: 120_000,

    init(nextViewer) {
      if (viewer) throw new Error('News layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource('news');
      dataSource.show = false;
      styleClusters();
      viewer.dataSources.add(dataSource);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost?.setVisible?.(NEWS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      stream ??= createNewsStream({
        url: source.streamUrl,
        eventSourceFactory,
        onStory: acceptLive,
        onStoryUpdate: acceptLive,
      });
      if (source.streamUrl && (eventSourceFactory || globalThis.EventSource))
        stream.start();
      notify();
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      stream?.stop();
      removeClickHandler();
      selectedId = null;
      if (dataSource) dataSource.show = false;
      overlayHost?.clearSource?.(NEWS_OVERLAY_SOURCE_ID);
      overlayHost?.setVisible?.(NEWS_OVERLAY_SOURCE_ID, false);
      notify();
    },

    async update() {
      if (!enabled || !dataSource) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      loading = true;
      notify();
      try {
        const snapshot = await source.getSnapshot({
          signal: controller.signal,
          windowHours,
          categories: [...categories],
        });
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        records.clear();
        for (const record of snapshot.records) records.set(record.id, record);
        freshness = snapshot.freshness;
        error = null;
        lastUpdate = now();
        render();
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        error =
          cause?.code === 'intel_offline'
            ? INTEL_OFFLINE
            : cause?.message || NEWS_UNAVAILABLE;
        return false;
      } finally {
        if (request === controller) {
          request = null;
          loading = false;
          notify();
        }
      }
    },

    setParams(params = {}) {
      let refetch = false;
      if (NEWS_WINDOW_HOURS.includes(params.windowHours)) {
        refetch ||= params.windowHours !== windowHours;
        windowHours = params.windowHours;
      }
      if (Array.isArray(params.categories)) {
        categories = new Set(
          params.categories.filter((c) => NEWS_CATEGORIES.includes(c)),
        );
        refetch = true;
      }
      // The share-link and stored-state form of the category filter.
      const fromFilter = decodeNewsCategoryFilter(params.categoryFilter);
      if (fromFilter) {
        refetch ||=
          encodeNewsCategoryFilter(fromFilter) !==
          encodeNewsCategoryFilter([...categories]);
        categories = new Set(fromFilter);
      }
      if (NEWS_CATEGORIES.includes(params.toggleCategory)) {
        const next = new Set(categories);
        if (next.has(params.toggleCategory)) next.delete(params.toggleCategory);
        else next.add(params.toggleCategory);
        categories = next;
        refetch = true;
      }
      if (params.storyId === null) select(null);
      else if (Number.isSafeInteger(params.storyId))
        select(params.storyId, { focus: params.focus === true });
      if (refetch && enabled) {
        render();
        void layer.update(viewer);
      }
      notify();
    },

    getParams() {
      return {
        windowHours,
        categories: [...categories].sort(),
        categoryFilter: encodeNewsCategoryFilter([...categories]),
      };
    },

    /** The state the drawer and ticker render; plain data. */
    getModel() {
      return {
        enabled,
        loading,
        error,
        freshness,
        lastUpdate,
        windowHours,
        categories: [...categories].sort(),
        selectedId,
        records: newest(),
      };
    },

    /** Drawer/ticker subscription; returns an unsubscribe function. */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },

    /** The drawer's own queries (any story, placed or not) through the source. */
    searchStories(params, options) {
      return source.search
        ? source.search(params, options)
        : Promise.resolve({ records: [], freshness: null });
    },

    /** The drawer registers how the row's "News panel" chip opens it. */
    setPanelOpener(open) {
      panelOpener = typeof open === 'function' ? open : null;
      rowControlsListener?.();
    },

    getRowControls() {
      const visible = newest().filter(wanted);
      const status = newsFreshness({ freshness, error, loading }).text;
      const gdelt = visible.some((record) => record.viaGdelt);
      return {
        chips: [
          ...(panelOpener
            ? [
                {
                  id: 'open-panel',
                  label: t('News panel'),
                  onClick: () => panelOpener?.(),
                  title: t(
                    'Search all stories, filter by region and source, and open every outlet',
                  ),
                },
              ]
            : []),
          ...NEWS_WINDOW_HOURS.map((hours) => ({
            id: `window-${hours}`,
            label: t(WINDOW_LABELS[hours]),
            active: windowHours === hours,
            params: { windowHours: hours },
            title: t('Show stories from the last {window}', {
              window: t(WINDOW_LABELS[hours]),
            }),
          })),
          ...NEWS_CATEGORIES.map((category) => ({
            id: `category-${category}`,
            label: t(NEWS_CATEGORY_LABELS[category]),
            active: categories.has(category),
            params: { toggleCategory: category },
            title: t('Show only the chosen categories; none chosen shows all'),
          })),
        ],
        list: {
          ariaLabel: t('Latest news on the globe'),
          items: visible.slice(0, LIST_LIMIT).map((record, index) => ({
            id: String(record.id),
            ordinal: index + 1,
            lead: formatNewsAge(now() - record.publishedAt),
            text: record.title,
            active: record.id === selectedId,
            params: { storyId: record.id, focus: true },
          })),
        },
        info: [
          status,
          tn(
            visible.length,
            '{count} story on the globe',
            '{count} stories on the globe',
            {
              count: visible.length,
            },
          ),
          gdelt ? t(GDELT_CITATION) : null,
        ]
          .filter(Boolean)
          .join('\n'),
        infoTitle: t(
          'Stories the intel service could place, colored by category, sized by how many outlets report them and faded by age. Select one to fly to it; click its card to open the article. The News panel lists every outlet.',
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
      subscribers.clear();
      rowControlsListener = null;
    },

    getAnalystRecords(maxCount = 200) {
      if (!enabled) return [];
      return newest()
        .filter(wanted)
        .slice(0, Math.max(1, Math.floor(maxCount) || 200))
        .map((record) => ({
          id: record.id,
          title: record.title,
          category: record.category,
          severity: record.severity,
          place: record.location?.placeName ?? null,
          lat: record.location?.lat ?? null,
          lon: record.location?.lon ?? null,
          publishedAt: new Date(record.publishedAt).toISOString(),
          outlets: record.sourceCount,
        }));
    },

    getStats() {
      return {
        count: newest().filter(wanted).length,
        lastUpdate,
        loading,
        error,
        stale: Boolean(freshness?.stale),
        source: 'SKYNET intel',
      };
    },
  };
  return layer;
}
