import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import {
  cameraDisplayCode,
  fallbackHeadingFromId,
  prioritizeSources,
} from './normalize.js';
import { readResponseTextCapped } from '../common/http.js';

/** Freeway Bureau (MOTC) CCTV static table in the national MOTC 2.0 XML
 * standard, published keyless and refreshed daily (~1,800 cameras). */
export const TAIWAN_FREEWAY_CCTV_URL =
  'https://tisvcloud.freeway.gov.tw/history/motc20/CCTV.xml';
/** The whole network is ~1.2 MB. */
export const TAIWAN_MAX_CATALOG_BYTES = 6 * 1024 * 1024;
export const DEFAULT_TAIWAN_MAX_SOURCES = 600;

// The table publishes each camera's MJPEG stream. The same camera servers
// answer a single JPEG for the same camera ID on a sibling path, which is what
// the frame proxy can relay; only these exact pairs are ever registered.
const STREAM_TO_FRAME = new Map([
  ['cctvn.freeway.gov.tw', ['/abs2mjpg/bmjpg', '/abs2mjpg/jpg']],
  ['cctvn5.freeway.gov.tw', ['/abs2mjpg/bmjpg', '/abs2mjpg/jpg']],
  ['cctvc.freeway.gov.tw', ['/abs2mjpg/bmjpg', '/abs2mjpg/jpg']],
  [
    'cctvs.freeway.gov.tw',
    ['/live-view/mjpg/video.cgi', '/live-view/jpg/image.cgi'],
  ],
]);

const DIRECTIONS = { N: 'N', S: 'S', E: 'E', W: 'W' };

/** Prioritization anchors, north to south, so a cap keeps the whole island
 * rather than only greater Taipei. */
const ANCHORS = [
  { lat: 25.033, lon: 121.5654 }, // Taipei
  { lat: 24.9936, lon: 121.301 }, // Taoyuan
  { lat: 24.8138, lon: 120.9675 }, // Hsinchu
  { lat: 24.7021, lon: 121.7378 }, // Yilan
  { lat: 24.1477, lon: 120.6736 }, // Taichung
  { lat: 22.9999, lon: 120.227 }, // Tainan
  { lat: 22.6273, lon: 120.3014 }, // Kaohsiung
];

/** Taiwan main island with slack for the coast; the freeway network has no
 * offshore-island cameras. */
export function isLikelyTaiwanCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= 21.8 &&
    lat <= 25.4 &&
    lon >= 119.9 &&
    lon <= 122.1
  );
}

const XML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXml(text) {
  return String(text ?? '')
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES[name])
    .trim();
}

function tag(block, name) {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
  return match ? decodeXml(match[1]) : '';
}

/**
 * Parse the MOTC 2.0 `CCTVList` document into flat rows. Regex-based like the
 * Catalonia and Tarktee parsers: the schema is flat, and only the fields used
 * below are read.
 *
 * @param {string} xml
 * @returns {Array<object>}
 */
export function parseTaiwanCctvXml(xml) {
  const rows = [];
  const blockRe = /<CCTV>([\s\S]*?)<\/CCTV>/g;
  let match;
  while ((match = blockRe.exec(String(xml || ''))) !== null) {
    const block = match[1];
    rows.push({
      cctvId: tag(block, 'CCTVID'),
      streamUrl: tag(block, 'VideoStreamURL'),
      lat: Number(tag(block, 'PositionLat')),
      lon: Number(tag(block, 'PositionLon')),
      roadName: tag(block, 'RoadName'),
      direction: tag(block, 'RoadDirection'),
      sectionStart: tag(block, 'Start'),
      sectionEnd: tag(block, 'End'),
      mile: tag(block, 'LocationMile'),
    });
  }
  return rows;
}

/**
 * Published MJPEG stream URL -> the same camera's still, plus the host and
 * camera number that identify it, or null.
 *
 * @param {string} streamUrl
 * @returns {?{frameUrl: string, host: string, camera: string}}
 */
export function taiwanFrame(streamUrl) {
  let url;
  try {
    url = new URL(String(streamUrl ?? ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    return null;
  const paths = STREAM_TO_FRAME.get(url.hostname);
  if (!paths || url.pathname !== paths[0]) return null;
  const camera = url.searchParams.get('camera') || '';
  if (!/^[A-Za-z0-9-]{1,40}$/.test(camera)) return null;
  return {
    // Reconstruct so extra query parameters cannot alter the request.
    frameUrl: `https://${url.hostname}${paths[1]}?camera=${camera}`,
    host: url.hostname.split('.')[0],
    camera,
  };
}

/**
 * One parsed Freeway Bureau row -> one catalog source, or null.
 *
 * @param {object} row - Output of parseTaiwanCctvXml.
 * @returns {?object}
 */
export function taiwanCameraToSource(row) {
  if (!row || typeof row !== 'object') return null;
  const { lat, lon } = row;
  if (!isLikelyTaiwanCoordinate(lat, lon)) return null;
  const frame = taiwanFrame(row.streamUrl);
  if (!frame) return null;
  const imageUrl = frame.frameUrl;
  // CCTVID carries Chinese place names and a few IDs repeat across distinct
  // cameras, so the stable key is the camera server plus its camera number.
  const rawId = String(row.cctvId ?? '')
    .trim()
    .slice(0, 80);
  const cameraId = `tw-freeway-${frame.host}-${frame.camera.toLowerCase()}`;
  const road = String(row.roadName ?? '').trim();
  const direction = DIRECTIONS[String(row.direction ?? '').trim()] || '';
  const mile = String(row.mile ?? '').trim();
  const section = [row.sectionStart, row.sectionEnd]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('→');
  const name =
    [road, direction, mile].filter(Boolean).join(' ') +
      (section ? ` ${section}` : '') ||
    rawId ||
    `Freeway camera ${frame.camera}`;

  return {
    id: cameraId,
    name: name.slice(0, 160),
    // One island-wide category in the camera picker, like Finland and Norway.
    city: 'Taiwan / 臺灣',
    cityId: 'taiwan',
    provider: 'Freeway Bureau, MOTC',
    lat,
    lon,
    // The table gives the carriageway direction, not the camera's bearing,
    // so the pose uses the shared low-confidence prior.
    headingDeg: fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 8,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'tw-freeway-motc',
    license:
      'Freeway Bureau, MOTC open data, Open Government Data License, Taiwan (Version 1.0)',
    code: cameraDisplayCode(
      `${road} ${mile}`.trim().toUpperCase() || frame.camera,
    ),
  };
}

/**
 * Fetch Taiwan Freeway Bureau cameras from the keyless MOTC 2.0 XML table.
 * One bounded request per shared catalog refresh.
 *
 * @returns {Promise<Array<object>>}
 */
export async function loadTaiwanSources() {
  try {
    const signal = AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS);
    const response = await fetch(
      process.env.CCTV_TAIWAN_URL || TAIWAN_FREEWAY_CCTV_URL,
      {
        headers: { Accept: 'application/xml,text/xml' },
        redirect: 'manual',
        signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      console.warn(
        '[CCTV] Taiwan camera download failed:',
        response.status >= 300 && response.status < 400
          ? 'catalog redirected; redirects are not followed'
          : response.status,
      );
      return [];
    }
    const xml = await readResponseTextCapped(
      response,
      TAIWAN_MAX_CATALOG_BYTES,
      signal,
    );
    const cameras = new Map();
    for (const row of parseTaiwanCctvXml(xml)) {
      const camera = taiwanCameraToSource(row);
      if (camera && !cameras.has(camera.id)) cameras.set(camera.id, camera);
    }
    const rawCap = Number(
      process.env.CCTV_TAIWAN_MAX_SOURCES || DEFAULT_TAIWAN_MAX_SOURCES,
    );
    const cap = Number.isFinite(rawCap)
      ? Math.max(1, Math.min(2000, Math.floor(rawCap)))
      : DEFAULT_TAIWAN_MAX_SOURCES;
    const sources = prioritizeSources([...cameras.values()], cap, ANCHORS);
    console.log(
      `[CCTV] Loaded Taiwan camera sources: ${cameras.size} (using ${sources.length})`,
    );
    return sources;
  } catch (error) {
    console.warn(
      '[CCTV] Taiwan camera download error:',
      error?.message || error,
    );
    return [];
  }
}
