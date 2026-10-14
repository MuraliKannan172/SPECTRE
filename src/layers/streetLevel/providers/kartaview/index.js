import { createLineCoverage } from '../../lineCoverage.js';
import { createSequenceCones, thinImages } from '../../sequenceCones.js';
import { metresBetween } from '../../view.js';
import { decodeCoverageTile } from './decode.js';
import { createKartaViewSource } from './source.js';
import { createKartaViewViewer } from './viewer.js';
import {
  ARCHIVED_MESSAGE,
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
  NEAREST_PROBES,
  NEAREST_RADIUS_M,
  NO_COVERAGE_HINT,
  PICK_PREFIX,
  RATE_LIMITED_MESSAGE,
  SEQUENCE_PAGE_EDGE,
  SEQUENCE_PAGE_SIZE,
  TOO_HIGH_HINT,
  normalizePhoto,
} from './policy.js';

/** Photos kept in memory by id (sequence pages fill it). */
const PHOTO_CACHE_SIZE = 4000;
/** Sequence pages kept in memory. */
const PAGE_CACHE_SIZE = 12;
/** Decoded coverage tiles kept, and for how long. */
const TILE_CACHE_SIZE = 24;
const TILE_CACHE_TTL_MS = 10 * 60_000;

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

/**
 * Loaded coverage tiles by `z/x/y`, at most `size`, each for `ttlMs`. KartaView
 * sends tiles uncompressed and uncacheable (hundreds of kB, seconds each), so
 * a pan back or a zoom across z13/z14 would fetch them all again.
 */
export function createTileCache({
  load,
  size = TILE_CACHE_SIZE,
  ttlMs = TILE_CACHE_TTL_MS,
  now = Date.now,
}) {
  const kept = createLru(size);
  return {
    async get(tile, options) {
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      const entry = kept.get(key);
      if (entry && now() - entry.at < ttlMs) return entry.tile;
      const loaded = await load(tile, options);
      kept.set(key, { at: now(), tile: loaded });
      return loaded;
    },
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
    // Its lines are streets, not sequences: a selected drive shows as cones.
    highlightsSequence: false,
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

      /**
       * The page holding `photo`. Pages follow photo ids, which only roughly
       * follow the index, and photos go missing, so the page the index
       * suggests is a first guess: step towards the photo until a page holds
       * it, or the pages straddle where it would be.
       */
      async function homePage(photo) {
        let number = pageOf(photo.sequenceIndex ?? 0);
        const index = photo.sequenceIndex ?? 0;
        let page = await loadPage(photo.sequenceId, number);
        if (!page.photos.length && number > 1) {
          // Past the end (many photos deleted): find the last page by halving.
          let low = 1;
          let high = number - 1;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if ((await loadPage(photo.sequenceId, middle)).photos.length)
              low = middle;
            else high = middle - 1;
          }
          number = low;
        }
        const seen = new Set();
        while (!seen.has(number) && seen.size < 8) {
          seen.add(number);
          page = await loadPage(photo.sequenceId, number);
          if (page.photos.some((p) => p.id === photo.id)) return page;
          const first = page.photos[0]?.sequenceIndex;
          const last = page.photos.at(-1)?.sequenceIndex;
          // Past the last page, or before this page's photos: go back.
          if ((first === undefined || index < first) && number > 1) number--;
          else if (last !== undefined && index > last && page.hasMore) number++;
          else break;
        }
        return page;
      }

      /**
       * The photos around `photo` in index order: its page, plus a
       * neighbour page when it sits near an edge (pages overlap in index).
       * @returns {Promise<{home: number, photos: Array<object>}>}
       */
      async function windowOf(photo) {
        const home = await homePage(photo);
        const list = home.photos;
        const found = list.findIndex((p) => p.id === photo.id);
        // A photo no page lists sits where its index would.
        const at =
          found !== -1
            ? found
            : list.filter(
                (p) => (p.sequenceIndex ?? 0) < (photo.sequenceIndex ?? 0),
              ).length;
        const parts = [list];
        if (at < SEQUENCE_PAGE_EDGE && home.page > 1)
          parts.push((await loadPage(photo.sequenceId, home.page - 1)).photos);
        if (at >= list.length - SEQUENCE_PAGE_EDGE && home.hasMore)
          parts.push((await loadPage(photo.sequenceId, home.page + 1)).photos);
        if (parts.length === 1) return { home: home.page, photos: list };
        const byId = new Map(parts.flat().map((p) => [p.id, p]));
        return {
          home: home.page,
          photos: [...byId.values()].sort(
            (a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0),
          ),
        };
      }

      /**
       * Photo id → whether its file is there (archived ones are not). Only
       * a definite answer is kept: a storage hiccup is asked again next
       * time, and meanwhile the photo is tried. A probe is shared, so it
       * runs to its own timeout rather than any one caller's abort.
       */
      const probes = createLru(PHOTO_CACHE_SIZE);
      function showable(photo) {
        if (!photo?.urls?.view) return Promise.resolve(false);
        let probe = probes.get(photo.id);
        if (!probe) {
          probe = source.probeImage(photo.urls.view).then(
            (answer) => {
              if (answer === null) probes.delete(photo.id);
              return answer !== false;
            },
            () => {
              probes.delete(photo.id);
              return true;
            },
          );
          probes.set(photo.id, probe);
        }
        return probe;
      }

      // Decoded coverage tiles, kept a while: panning back asks nothing.
      const tiles = createTileCache({
        load: async (tile, { signal }) =>
          decodeCoverageTile(await source.getTile(tile, { signal }), tile),
      });
      const fetchTile = (tile, options) => tiles.get(tile, options);

      /**
       * The next showable photo `delta` along the sequence, or null at its
       * end. Archived photos are skipped, a few at most.
       */
      async function step(photo, delta) {
        if (!photo?.sequenceId) return null;
        let from = photo;
        for (let skipped = 0; skipped <= NEAREST_PROBES; skipped++) {
          const { photos: list } = await windowOf(from);
          let at = list.findIndex((p) => p.id === from.id);
          if (at === -1) {
            // Not found anywhere: the nearest index on the right side.
            const index = from.sequenceIndex ?? 0;
            const later = list.findIndex((p) => (p.sequenceIndex ?? 0) > index);
            if (delta > 0 && later === -1) return null;
            at =
              delta > 0
                ? later - 1
                : later === -1
                  ? list.length
                  : list.findIndex((p) => (p.sequenceIndex ?? 0) >= index);
          }
          const next = list[at + delta];
          if (!next) return null;
          if (await showable(next)) return next.id;
          from = next;
        }
        return null;
      }

      const coverage = createLineCoverage({
        state,
        fetchTile,
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
          drawnPage = { sequenceId, page: window.home };
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
        // The filters are hidden for KartaView: one left set must not hide cones.
        passes: () => true,
      });

      /** ‹ › open through the core (loading, errors, cones), camera still. */
      function openStepped(photoId) {
        context.actions.openImage(photoId, { frame: false });
      }

      /**
       * The cones show one page of a sequence: once a photo of the selected
       * sequence opens on another page (‹ ›, a cone, a line), re-centre them.
       */
      async function recentreCones(photo) {
        if (!photo?.sequenceId) return;
        if (state.sequence.selectedId !== photo.sequenceId) return;
        const drawn = drawnPage;
        if (drawn?.sequenceId !== photo.sequenceId) return;
        const window = await windowOf(photo).catch(() => null);
        // Still the drawn page and the latest photo once the page is in.
        if (
          window &&
          drawnPage === drawn &&
          window.home !== drawn.page &&
          anchors.get(photo.sequenceId) === photo
        )
          cones.select(photo.sequenceId, { force: true });
      }

      const viewer = createKartaViewViewer({
        getPhoto: async (photoId) => {
          const photo = await getPhoto(photoId);
          if (photo.sequenceId) anchors.set(photo.sequenceId, photo);
          return photo;
        },
        step,
        onStep: openStepped,
        onShown: recentreCones,
        // Esc in the viewer clears the selected drive, as the panel says.
        onEscape: () => {
          if (!state.sequence.selectedId) return false;
          cones.clearSelection();
          drawnPage = null;
          return true;
        },
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
          const loading = state.coverage.pending.size > 0;
          const empty =
            state.coverage.zoom !== null &&
            !loading &&
            count === 0 &&
            !state.coverage.lastError;
          return {
            count,
            zoom: state.coverage.zoom,
            kind: state.coverage.kind,
            loading,
            hint: hint || (empty ? NO_COVERAGE_HINT : ''),
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

        // Never from the cache: it is keyed by sequence, the cones by page.
        selectSequence: (sequenceId) =>
          cones.select(sequenceId, { force: true }),
        clearSequence: () => {
          cones.clearSelection();
          drawnPage = null;
        },
        sequenceStats: () => ({
          selectedId: state.sequence.selectedId,
          images: state.sequence.images.length,
          loading: state.sequence.loading,
        }),

        /**
         * The nearest photo within the search radius that can be shown, or
         * null. Many photos are archived (their files answer 409) or have no
         * file at all, so the nearest few are tried in turn.
         */
        async nearestImage({ lat, lon }, { signal } = {}) {
          const records = await source.nearestPhotos({ lat, lon }, { signal });
          const near = [];
          for (const record of records) {
            const photo = remember(record);
            if (!photo?.urls.view) continue;
            const metres = metresBetween({ lat, lon }, photo);
            if (metres <= NEAREST_RADIUS_M) near.push({ photo, metres });
          }
          near.sort((a, b) => a.metres - b.metres);
          // Probed side by side (photo storage is not the API host): the
          // nearest one that answers wins.
          const candidates = near.slice(0, NEAREST_PROBES);
          const answers = await Promise.all(
            candidates.map(({ photo }) => showable(photo, { signal })),
          );
          const hit = candidates.find((_, i) => answers[i]);
          if (hit) return hit.photo.id;
          if (near.length) throw new Error(ARCHIVED_MESSAGE);
          return null;
        },

        viewer,
      };
    },
  });
}
