import { createLineCoverage } from '../../lineCoverage.js';
import { createSequenceCones, thinImages } from '../../sequenceCones.js';
import { metresBetween } from '../../view.js';
import { decodeCoverageTile } from './decode.js';
import { createKartaViewSource } from './source.js';
import { createKartaViewViewer } from './viewer.js';
import {
  COLORS,
  COVERAGE_MAX_HEIGHT_M,
  COVERAGE_NOUN,
  COVERAGE_STREET_ZOOM_BELOW_M,
  COVERAGE_TUNING,
  KARTAVIEW_CREDIT_HTML,
  KARTAVIEW_LABEL,
  KARTAVIEW_NAME,
  KARTAVIEW_PROVIDER_ID,
  LINE_CLICK_HINT,
  NEAREST_RADIUS_M,
  PICK_PREFIX,
  RATE_LIMITED_MESSAGE,
  SEQUENCE_PAGE_SIZE,
  TOO_HIGH_HINT,
  normalizePhoto,
} from './policy.js';

/** Photos kept in memory by id (sequence pages fill it). */
const PHOTO_CACHE_SIZE = 4000;
/** Sequence pages kept in memory. */
const PAGE_CACHE_SIZE = 8;

/** z14 near the street, z13 a little higher, nothing above. */
export function kartaViewZoomFor(heightM) {
  if (!Number.isFinite(heightM) || heightM > COVERAGE_MAX_HEIGHT_M) return null;
  return {
    zoom: heightM > COVERAGE_STREET_ZOOM_BELOW_M ? 13 : 14,
    kind: 'sequence',
  };
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
    clear: () => map.clear(),
  };
}

/** The 1-based page of a sequence that holds `index`, if no photo is missing. */
function pageOf(index) {
  return Math.floor(Math.max(0, index) / SEQUENCE_PAGE_SIZE) + 1;
}

/**
 * KartaView Street Level provider: keyless coverage lines from KartaView's
 * tile API, the photos nearest a clicked line, cones along the photo's
 * sequence, and a flat or 360° viewer with ‹ › along the sequence.
 * @param {{source?: ReturnType<typeof createKartaViewSource>, viewerOptions?: object}} [options]
 * @returns {import('../../registry.js').StreetLevelProvider}
 */
export function createKartaViewProvider({
  source = createKartaViewSource(),
  viewerOptions = {},
} = {}) {
  return Object.freeze({
    id: KARTAVIEW_PROVIDER_ID,
    name: KARTAVIEW_NAME,
    label: KARTAVIEW_LABEL,
    requiresKeyId: null,
    pickPrefix: PICK_PREFIX.root,
    colors: COLORS,
    credit: Object.freeze({ html: KARTAVIEW_CREDIT_HTML }),
    defaultOn: false,
    // Coverage lines carry no date or projection: no filter could thin them.
    filters: [],
    coverageLabel: Object.freeze({
      noun: COVERAGE_NOUN,
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
      const pages = createLru(PAGE_CACHE_SIZE);
      /** The photo last opened in each sequence: its cones centre on it. */
      const anchors = new Map();
      /** The sequence page the cones were drawn from. */
      let drawnPage = null;

      function remember(record) {
        const photo = normalizePhoto(record);
        if (photo) photos.set(photo.id, photo);
        return photo;
      }

      async function getPhoto(photoId, { signal } = {}) {
        const cached = photos.get(photoId);
        if (cached) return cached;
        const photo = remember(await source.getPhoto(photoId, { signal }));
        if (!photo) throw new Error('KartaView has no position for this photo');
        return photo;
      }

      /** A page of a sequence's photos, in index order (shared while in flight). */
      function loadPage(sequenceId, page) {
        const key = `${sequenceId}:${page}`;
        let entry = pages.get(key);
        if (!entry) {
          entry = source
            .getSequencePhotos(sequenceId, {
              page,
              itemsPerPage: SEQUENCE_PAGE_SIZE,
            })
            .then(({ photos: records, hasMore }) => ({
              page,
              hasMore,
              photos: records
                .map(remember)
                .filter(Boolean)
                .sort(
                  (a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0),
                ),
            }));
          pages.set(key, entry);
          entry.catch(() => pages.delete(key));
        }
        return entry;
      }

      /** The page holding `photo` (an earlier one when photos are missing). */
      async function windowOf(photo) {
        let page = pageOf(photo.sequenceIndex ?? 0);
        for (let tries = 0; tries < 3; tries++) {
          const window = await loadPage(photo.sequenceId, page);
          const first = window.photos[0];
          if (
            window.photos.some((p) => p.id === photo.id) ||
            page === 1 ||
            !first ||
            (first.sequenceIndex ?? 0) <= (photo.sequenceIndex ?? 0)
          )
            return window;
          page--;
        }
        return loadPage(photo.sequenceId, page);
      }

      async function step(photo, delta) {
        if (!photo?.sequenceId) return null;
        const window = await windowOf(photo);
        const list = window.photos;
        let at = list.findIndex((p) => p.id === photo.id);
        if (at === -1)
          at = list.findIndex(
            (p) => (p.sequenceIndex ?? 0) >= (photo.sequenceIndex ?? 0),
          );
        const next = at === -1 ? -1 : at + delta;
        if (next >= 0 && next < list.length) return list[next].id;
        if (next < 0 && window.page > 1) {
          const before = await loadPage(photo.sequenceId, window.page - 1);
          return before.photos.at(-1)?.id ?? null;
        }
        if (next >= list.length && window.hasMore) {
          const after = await loadPage(photo.sequenceId, window.page + 1);
          return after.photos[0]?.id ?? null;
        }
        return null;
      }

      const coverage = createLineCoverage({
        state,
        fetchTile: async (tile, { signal }) =>
          decodeCoverageTile(await source.getTile(tile, { signal }), tile),
        zoomFor: kartaViewZoomFor,
        colors: COLORS,
        pickPrefix: PICK_PREFIX.line,
        renderKey: 'kartaview-coverage',
        tuning: COVERAGE_TUNING,
        messages: { rateLimited: RATE_LIMITED_MESSAGE, tooHigh: TOO_HIGH_HINT },
        passes: () => true,
      });

      const cones = createSequenceCones({
        state,
        async loadImages(sequenceId, { signal }) {
          const anchor = anchors.get(sequenceId);
          if (!anchor) return [];
          const window = await windowOf(anchor);
          signal?.throwIfAborted();
          drawnPage = { sequenceId, page: window.page };
          return thinImages(
            window.photos.map((photo) => ({
              id: photo.id,
              lon: photo.lon,
              lat: photo.lat,
              compassAngle: photo.heading ?? 0,
              capturedAt: photo.capturedAt ?? 0,
              isPano: photo.isPano,
            })),
          );
        },
        colors: COLORS,
        pickPrefix: PICK_PREFIX.image,
        spriteId: 'street-level:kartaview-cones',
        renderKey: 'kartaview-sequence',
      });

      /** Re-centre the cones when ‹ › walked off the page they show. */
      async function followStep(photoId) {
        const photo = photos.get(photoId);
        if (!photo?.sequenceId) return;
        anchors.set(photo.sequenceId, photo);
        if (drawnPage?.sequenceId !== photo.sequenceId) return;
        const window = await windowOf(photo).catch(() => null);
        if (window && window.page !== drawnPage.page)
          cones.select(photo.sequenceId, { force: true });
      }

      const viewer = createKartaViewViewer({
        getPhoto: async (photoId) => {
          const photo = await getPhoto(photoId);
          if (photo.sequenceId) anchors.set(photo.sequenceId, photo);
          return photo;
        },
        step,
        onStepped: followStep,
        render: context.services?.render,
        ...viewerOptions,
      });

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
          drawnPage = null;
        },

        destroy(cesiumViewer) {
          coverage.detach();
          coverage.clear();
          coverage.resetErrors();
          cones.destroy(cesiumViewer);
        },

        refreshCoverage: () => coverage.refresh(),

        /** No filter applies (see `filters`). */
        setFilter() {},

        setSurface() {
          coverage.setSurface();
          cones.rerender();
        },

        coverageStats() {
          const { hint } = state.coverage;
          const count = coverage.sequenceCount();
          return {
            count,
            zoom: state.coverage.zoom,
            kind: state.coverage.kind,
            loading: state.coverage.pending.size > 0,
            hint: hint || '',
            error: state.coverage.lastError,
            keyRequired: false,
            keyRejected: false,
          };
        },

        /** A line opens the photo nearest the click; a cone opens its photo. */
        handlePick(pickId, { groundPoint } = {}) {
          if (pickId.startsWith(PICK_PREFIX.image)) {
            context.actions.openImage(pickId.slice(PICK_PREFIX.image.length));
            return true;
          }
          if (pickId.startsWith(PICK_PREFIX.line)) {
            const point = groundPoint?.();
            if (point) context.actions.openNearest(point);
            return true;
          }
          return false;
        },

        selectSequence: (sequenceId) => cones.select(sequenceId),
        clearSequence: () => {
          cones.clearSelection();
          drawnPage = null;
        },
        sequenceStats: () => ({
          selectedId: state.sequence.selectedId,
          images: state.sequence.images.length,
          loading: state.sequence.loading,
        }),

        /** The nearest photo within the search radius, or null. */
        async nearestImage({ lat, lon }, { signal } = {}) {
          const records = await source.nearestPhotos({ lat, lon }, { signal });
          let best = null;
          for (const record of records) {
            const photo = remember(record);
            if (!photo) continue;
            const metres = metresBetween({ lat, lon }, photo);
            if (metres <= NEAREST_RADIUS_M && (!best || metres < best.metres))
              best = { photo, metres };
          }
          return best ? best.photo.id : null;
        },

        viewer,
      };
    },
  });
}
