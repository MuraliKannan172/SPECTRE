/** More than any real tile holds (a dense z13 tile has ~4,700 segments). */
export const MAX_TILE_SEGMENTS = 20_000;
/** A chained line stops growing here and the next one starts. */
export const MAX_LINE_POINTS = 5_000;

/**
 * Decode a KartaView coverage tile (`{lines: [{track: [{lat, lng}]}]}`) into
 * line records for the shared coverage. The tile's lines are OSM way
 * segments with photos; segments that meet end to start are chained, which
 * cuts the line count about fourfold. Lines carry no sequence, date or
 * projection, so nothing can filter them.
 * @param {object} payload
 * @param {{x: number, y: number, z: number}} address
 * @returns {{sequences: Array<{id: string, parts: Array<Array<[number, number]>>, capturedAt: number, isPano: boolean}>, overview: Array<never>}}
 */
export function decodeCoverageTile(payload, { x, y, z }) {
  // Not cached as empty: an unreadable tile is asked for again.
  if (!Array.isArray(payload?.lines))
    throw new Error('KartaView sent an unreadable coverage tile');
  const segments = [];
  for (const line of payload.lines) {
    if (segments.length >= MAX_TILE_SEGMENTS) break;
    const points = [];
    for (const point of Array.isArray(line?.track) ? line.track : []) {
      const lon = Number(point?.lng);
      const lat = Number(point?.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const last = points[points.length - 1];
      if (last && last[0] === lon && last[1] === lat) continue;
      points.push([lon, lat]);
    }
    if (points.length >= 2) segments.push(points);
  }
  const key = ([lon, lat]) => `${lon},${lat}`;
  const startingAt = new Map();
  segments.forEach((segment, index) => {
    const at = key(segment[0]);
    const list = startingAt.get(at);
    if (list) list.push(index);
    else startingAt.set(at, [index]);
  });
  const used = new Uint8Array(segments.length);
  // Per start point, how far its list has been used: each segment is looked
  // at once, so a tile of segments sharing one point stays linear.
  const cursor = new Map();
  const nextFrom = (point) => {
    const at = key(point);
    const list = startingAt.get(at);
    if (!list) return undefined;
    let i = cursor.get(at) ?? 0;
    while (i < list.length && used[list[i]]) i++;
    cursor.set(at, i);
    return list[i];
  };
  const sequences = [];
  segments.forEach((segment, index) => {
    if (used[index]) return;
    used[index] = 1;
    const chain = [...segment];
    for (;;) {
      const next = nextFrom(chain[chain.length - 1]);
      if (next === undefined) break;
      // Full: the segment starts the next line instead.
      if (chain.length + segments[next].length - 1 > MAX_LINE_POINTS) break;
      used[next] = 1;
      chain.push(...segments[next].slice(1));
    }
    sequences.push({
      id: `${z}/${x}/${y}/${sequences.length}`,
      parts: [chain],
      capturedAt: 0,
      isPano: false,
    });
  });
  return { sequences, overview: [] };
}
