/**
 * SKYNET: the ground area from which a satellite is in line of sight at or
 * above a minimum elevation angle. Geometry only: it says nothing about what
 * the satellite's instruments can see, which is not public for most of them.
 * Spherical Earth (mean radius); at globe scale the error is far below the
 * width of the drawn line.
 */
export const EARTH_MEAN_RADIUS_M = 6_371_000;
export const FOOTPRINT_MIN_ELEVATION_DEG = 10;
export const FOOTPRINT_SEGMENTS = 120;
const DEG = Math.PI / 180;

/**
 * Earth central angle from the sub-satellite point to the footprint edge.
 * @param {number} altitudeM - Satellite height above the surface, metres.
 * @param {number} [minElevationDeg] - Lowest elevation counted as visible.
 * @returns {number} Radians; 0 when there is no footprint.
 */
export function footprintCentralAngle(
  altitudeM,
  minElevationDeg = FOOTPRINT_MIN_ELEVATION_DEG,
) {
  if (!Number.isFinite(altitudeM) || altitudeM <= 0) return 0;
  if (
    !Number.isFinite(minElevationDeg) ||
    minElevationDeg < 0 ||
    minElevationDeg >= 90
  )
    return 0;
  const elevation = minElevationDeg * DEG;
  const ratio =
    (EARTH_MEAN_RADIUS_M * Math.cos(elevation)) /
    (EARTH_MEAN_RADIUS_M + altitudeM);
  return Math.max(0, Math.acos(Math.min(1, ratio)) - elevation);
}

/** Footprint radius measured along the ground, in metres. */
export function footprintRadiusMeters(altitudeM, minElevationDeg) {
  return (
    EARTH_MEAN_RADIUS_M * footprintCentralAngle(altitudeM, minElevationDeg)
  );
}

function wrapLongitude(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/**
 * The footprint edge as a closed ring of [longitude, latitude] degree pairs
 * (the first point repeated last), or [] when there is no footprint.
 * @param {{latitude: number, longitude: number, altitudeM: number,
 *   minElevationDeg?: number, segments?: number}} subSatellite
 * @returns {number[][]}
 */
export function footprintRing({
  latitude,
  longitude,
  altitudeM,
  minElevationDeg = FOOTPRINT_MIN_ELEVATION_DEG,
  segments = FOOTPRINT_SEGMENTS,
}) {
  const angle = footprintCentralAngle(altitudeM, minElevationDeg);
  if (!(angle > 0) || !Number.isFinite(latitude) || !Number.isFinite(longitude))
    return [];
  const lat1 = latitude * DEG;
  const lon1 = longitude * DEG;
  const ring = [];
  for (let index = 0; index <= segments; index += 1) {
    const bearing = (2 * Math.PI * (index % segments)) / segments;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angle) +
        Math.cos(lat1) * Math.sin(angle) * Math.cos(bearing),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angle) * Math.cos(lat1),
        Math.cos(angle) - Math.sin(lat1) * Math.sin(lat2),
      );
    ring.push([wrapLongitude(lon2 / DEG), lat2 / DEG]);
  }
  return ring;
}
