import { createLineCoverage, sequenceIdFromPick } from '../../lineCoverage.js';
import { createSequenceCones, thinImages } from '../../sequenceCones.js';
import { passesImageryFilter } from '../../filter.js';
import {
  lonToTileX,
  latToTileY,
  overviewZoomForHeight,
  tileBounds,
} from '../../tileMath.js';
import { metresBetween } from '../../view.js';
import { decodeCoverageTile, decodePictures } from './decode.js';
import { createPanoramaxSource } from './source.js';
import { createPanoramaxViewer } from './viewer.js';
import {
  COLORS,
  COVERAGE_LINES_BELOW_M,
  COVERAGE_TUNING,
  COVERAGE_Z12_BELOW_M,
  COVERAGE_Z13_BELOW_M,
  COVERAGE_Z14_BELOW_M,
  LINE_CLICK_HINT,
  NEAREST_LIMIT,
  NEAREST_RADIUS_M,
  NO_COVERAGE_HINT,
  OVERVIEW_HINT,
  PANORAMAX_CREDIT_HTML,
  PANORAMAX_LABEL,
  PANORAMAX_NAME,
  PANORAMAX_PROVIDER_ID,
  PICK_PREFIX,
  PICTURE_TILE_EDGE_M,
  PICTURE_TILE_ZOOM,
  RATE_LIMITED_MESSAGE,
  normalizeItem,
} from './policy.js';

export { PANORAMAX_PROVIDER_ID } from './policy.js';

/** Pictures kept in memory by id (lookups and ‹ › fill it). */
const PHOTO_CACHE_SIZE = 2000;

/**
 * Sequence lines at z11–14 below 30 km; above, the density grid at z5 and
 * coarser.
 */
export function panoramaxZoomFor(heightM) {
  if (!Number.isFinite(heightM)) return null;
  if (heightM <= COVERAGE_LINES_BELOW_M) {
    const zoom =
      heightM <= COVERAGE_Z14_BELOW_M
        ? 14
        : heightM <= COVERAGE_Z13_BELOW_M
          ? 13
          : heightM <= COVERAGE_Z12_BELOW_M
            ? 12
            : 11;
    return { zoom, kind: 'sequence' };
  }
  return {
    zoom: Math.min(5, overviewZoomForHeight(heightM) ?? 5),
    kind: 'overview',
  };
}

/**
 * The imagery filter for lines (dated, typed) and grid cells (undated, with
 * 360° and flat counts): a cell stays while it holds pictures of the kind
 * asked for.
 */
export function passesCoverage(record, filter) {
  if ('hasPano' in record) {
    if (filter?.pano === 'pano') return record.hasPano;
    if (filter?.pano === 'flat') return record.hasFlat;
    return true;
  }
  return passesImageryFilter(record, filter);
}

/** Least-recently-used map: reading an entry renews it. */
function createLru(limit) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > limit) map.delete(map.keys().next().value);
    },
    delete: (key) => map.delete(key),
  };
}

/** The z15 tile holding a point. */
function pictureTileOf({ lon, lat }) {
  const z = PICTURE_TILE_ZOOM;
  return { x: lonToTileX(lon, z), y: latToTileY(lat, z), z };
}

/**
 * The z15 tiles whose pictures surround a point: its own, and the
 * neighbours it sits within PICTURE_TILE_EDGE_M of (at most four).
 */
export function pictureTilesAround(point) {
  const home = pictureTileOf(point);
  const box = tileBounds(home.x, home.y, home.z);
  const near = (lon, lat) =>
    metresBetween(point, { lon, lat }) <= PICTURE_TILE_EDGE_M;
  const dx = near(box.west, point.lat) ? -1 : near(box.east, point.lat) ? 1 : 0;
  const dy = near(point.lon, box.north)
    ? -1
    : near(point.lon, box.south)
      ? 1
      : 0;
  const max = 2 ** home.z;
  const tiles = [home];
  const add = (x, y) => {
    if (y < 0 || y >= max) return;
    tiles.push({ x: (x + max) % max, y, z: home.z });
  };
  if (dx) add(home.x + dx, home.y);
  if (dy) add(home.x, home.y + dy);
  if (dx && dy) add(home.x + dx, home.y + dy);
  return tiles;
}

const tileKey = ({ x, y, z }) => `${z}/${x}/${y}`;

/**
 * Panoramax Street Level provider: the federated, keyless, open
 * street-level commons. Coverage from its vector tiles (density points
 * from orbit, sequence lines near the ground); a click on a line opens that
 * sequence's picture nearest the click, with cones along the sequence
 * around it and ‹ › to step through it. Flat pictures show as photos, 360°
 * ones on the shared WebGL panorama.
 * @param {{source?: ReturnType<typeof createPanoramaxSource>, viewerOptions?: object}} [options]
 * @returns {import('../../registry.js').StreetLevelProvider}
 */
export function createPanoramaxProvider({
  source = createPanoramaxSource(),
  viewerOptions = {},
} = {}) {
  return Object.freeze({
    id: PANORAMAX_PROVIDER_ID,
    name: PANORAMAX_NAME,
    label: PANORAMAX_LABEL,
    requiresKeyId: null,
    pickPrefix: PICK_PREFIX.root,
    colors: COLORS,
    credit: Object.freeze({ html: PANORAMAX_CREDIT_HTML }),
    defaultOn: false,
    coverageLabel: Object.freeze({
      noun: 'sequences',
      action: LINE_CLICK_HINT,
    }),

    create(context) {
      const state = {
        context,
        services: context.services,
        viewer: null,
        keyRequired: false,
        keyRejected: false,
        statusKnown: true,
        coverage: {
          zoom: null,
          tiles: new Map(),
          stale: new Map(),
          staleTimer: null,
          pending: new Map(),
          lastError: null,
          holdUntil: 0,
          holdTimer: null,
          debounceTimer: null,
          removeCameraListener: null,
          terrainReady: null,
          hint: '',
          kind: null,
        },
        sequence: {
          selectedId: null,
          images: [],
          cache: new Map(),
          collection: null,
          loading: false,
          abort: null,
        },
      };
      const photos = createLru(PHOTO_CACHE_SIZE);
      /** Where each sequence's cones centre: the picture last opened in it, or a click. */
      const anchors = new Map();
      /** The z15 tiles the cones were drawn from. */
      let drawn = null;
      /** A line click: its sequence's pictures win the next nearest lookup there. */
      let preferred = null;

      function remember(item) {
        const photo = normalizeItem(item);
        if (photo) photos.set(photo.id, photo);
        return photo;
      }

      /** Lookups in flight, shared: ‹ › and the viewer ask for the same picture. */
      const inflight = new Map();
      function getPhoto(photoId) {
        const id = String(photoId);
        const cached = photos.get(id);
        if (cached) return Promise.resolve(cached);
        let lookup = inflight.get(id);
        if (!lookup) {
          lookup = source
            .getItem(id)
            .then((item) => {
              const photo = item && remember(item);
              if (!photo)
                throw new Error('Panoramax has no position for this picture');
              return photo;
            })
            .finally(() => inflight.delete(id));
          inflight.set(id, lookup);
        }
        return lookup;
      }

      /** The picture `delta` along its sequence, from its own links (null at an end). */
      async function step(photo, delta) {
        if (!photo?.sequenceId) return null;
        return (delta < 0 ? photo.prevId : photo.nextId) || null;
      }

      const coverage = createLineCoverage({
        state,
        fetchTile: async (tile, { signal }) =>
          decodeCoverageTile(await source.getTile(tile, { signal }), tile),
        zoomFor: panoramaxZoomFor,
        colors: COLORS,
        pickPrefix: PICK_PREFIX.sequence,
        renderKey: 'panoramax-coverage',
        tuning: COVERAGE_TUNING,
        messages: { rateLimited: RATE_LIMITED_MESSAGE },
        passes: passesCoverage,
      });

      const cones = createSequenceCones({
        state,
        async loadImages(sequenceId, { signal }) {
          const anchor = anchors.get(sequenceId);
          if (!anchor) return [];
          const tiles = pictureTilesAround(anchor);
          const lists = await Promise.all(
            tiles.map(async (tile) =>
              decodePictures(
                await source.getTile(tile, { signal }),
                tile,
                sequenceId,
              ),
            ),
          );
          signal?.throwIfAborted();
          drawn = { sequenceId, tiles: new Set(tiles.map(tileKey)) };
          const byId = new Map(lists.flat().map((image) => [image.id, image]));
          return thinImages(
            [...byId.values()].sort((a, b) => a.capturedAt - b.capturedAt),
          );
        },
        colors: COLORS,
        pickPrefix: PICK_PREFIX.image,
        spriteId: 'street-level:panoramax-cones',
        renderKey: 'panoramax-sequence',
        onHighlight: (sequenceId, selected) =>
          coverage.recolorSequence(sequenceId, selected),
      });

      /**
       * The cones show the z15 tiles around one picture: once a picture of
       * the selected sequence opens outside them (‹ ›, a cone), re-centre.
       */
      function recentreCones(photo) {
        if (!photo?.sequenceId) return;
        if (state.sequence.selectedId !== photo.sequenceId) return;
        if (drawn?.sequenceId !== photo.sequenceId) return;
        if (drawn.tiles.has(tileKey(pictureTileOf(photo)))) return;
        cones.select(photo.sequenceId, { force: true });
      }

      const viewer = createPanoramaxViewer({
        getPhoto: async (photoId) => {
          const photo = await getPhoto(photoId);
          if (photo.sequenceId) anchors.set(photo.sequenceId, photo);
          return photo;
        },
        step,
        onStep: (photoId) =>
          context.actions.openImage(photoId, { frame: false }),
        onShown: recentreCones,
        render: context.services?.render,
        ...viewerOptions,
      });

      /** Nearest of `items` within the search radius of a point, or null. */
      function nearestOf(items, point) {
        let best = null;
        for (const item of items) {
          const photo = remember(item);
          if (!photo) continue;
          const metres = metresBetween(point, photo);
          if (metres > NEAREST_RADIUS_M) continue;
          if (!best || metres < best.metres) best = { photo, metres };
        }
        return best?.photo ?? null;
      }

      return {
        async status() {
          return { configured: true };
        },

        init(cesiumViewer) {
          state.viewer = cesiumViewer;
          cones.ensureCollections(cesiumViewer);
          cones.setVisible(false);
        },

        activate(cesiumViewer) {
          state.viewer = cesiumViewer;
          cones.setVisible(true);
          coverage.attach(cesiumViewer);
        },

        deactivate() {
          coverage.detach();
          coverage.clear();
          coverage.resetErrors();
          cones.clearSelection();
          cones.setVisible(false);
          drawn = null;
          preferred = null;
        },

        destroy(cesiumViewer) {
          coverage.detach();
          coverage.clear();
          coverage.resetErrors();
          cones.destroy(cesiumViewer);
        },

        refreshCoverage: () => coverage.refresh(),

        /** The filter changed: redraw. Each draw reads it from the context. */
        setFilter() {
          coverage.rebuild();
          cones.rerender();
        },

        setSurface() {
          coverage.setSurface();
          cones.rerender();
        },

        coverageStats() {
          const lines = state.coverage.kind === 'sequence';
          // Density dots are not sequences: they are not counted as such.
          const count = lines ? coverage.sequenceCount() : 0;
          const loading = state.coverage.pending.size > 0;
          const empty =
            lines && !loading && count === 0 && !state.coverage.lastError;
          const fallback = empty
            ? NO_COVERAGE_HINT
            : state.coverage.kind === 'overview'
              ? OVERVIEW_HINT
              : '';
          return {
            count,
            zoom: state.coverage.zoom,
            kind: state.coverage.kind,
            loading,
            hint: state.coverage.hint || fallback,
            error: state.coverage.lastError,
            keyRequired: false,
            keyRejected: false,
          };
        },

        /**
         * A line opens its sequence's picture nearest the click (the cones
         * follow once it is on screen); a cone opens its picture.
         */
        handlePick(pickId, { groundPoint } = {}) {
          if (pickId.startsWith(PICK_PREFIX.image)) {
            context.actions.openImage(pickId.slice(PICK_PREFIX.image.length));
            return true;
          }
          const sequenceId = sequenceIdFromPick(pickId, PICK_PREFIX.sequence);
          if (!sequenceId) return false;
          const point = groundPoint?.();
          if (!point) {
            // No ground under the click: show the line selected, nothing more.
            cones.select(sequenceId);
            return true;
          }
          anchors.set(sequenceId, { ...point, sequenceId });
          preferred = { sequenceId, lon: point.lon, lat: point.lat };
          context.actions.openNearest(point);
          return true;
        },

        selectSequence: (sequenceId) =>
          cones.select(sequenceId, { force: true }),
        clearSequence: () => {
          cones.clearSelection();
          drawn = null;
        },
        sequenceStats: () => ({
          selectedId: state.sequence.selectedId,
          images: state.sequence.images.length,
          loading: state.sequence.loading,
        }),

        /**
         * The nearest picture within the search radius that passes the
         * imagery filter, or null. After a click on a line, that line's
         * sequence is asked first.
         */
        async nearestImage({ lat, lon }, { signal } = {}) {
          const point = { lat, lon };
          const filter = context.getFilter();
          const wanted =
            preferred && metresBetween(preferred, point) < 1
              ? preferred.sequenceId
              : null;
          preferred = null;
          const ask = (collections) =>
            source.nearestItems(
              {
                lat,
                lon,
                radius: NEAREST_RADIUS_M,
                limit: NEAREST_LIMIT,
                collections,
                pano: filter.pano,
                sinceMs: filter.sinceMs,
              },
              { signal },
            );
          if (wanted) {
            const hit = nearestOf(await ask(wanted), point);
            if (hit) return hit.id;
          }
          return nearestOf(await ask(null), point)?.id ?? null;
        },

        viewer,
      };
    },
  });
}
