/**
 * Bright-star appearance: catalogue pack → GPU vertex data.
 *
 * Pure functions, no Cesium. The pack is `local_data/sky/bright_stars.json`
 * (Yale Bright Star Catalogue, built by scripts/build-bright-stars.mjs): a
 * flat `[raDeg, decDeg, vmag, bv, …]` array in ICRF/J2000.
 *
 * Every star is drawn as a point sprite holding a small Gaussian. Its width
 * is set in CSS pixels and scaled by the device pixel ratio in the shader, so
 * a star covers the same screen area at any DPR and stays a crisp dot rather
 * than a texel stretched across several pixels.
 *
 * @module sky/stars
 */

/** Faintest catalogue magnitude; also the reference for brightness. */
export const STAR_LIMIT_MAGNITUDE = 6.5;
/** Gaussian σ of the faintest star, CSS pixels. */
export const STAR_MIN_SIGMA_PX = 0.55;
/** Gaussian σ cap for the brightest star, CSS pixels. */
export const STAR_MAX_SIGMA_PX = 1.35;
/** Peak opacity of the faintest star. */
export const STAR_MIN_ALPHA = 0.22;
/** B−V for stars the catalogue gives no colour (a solar-type white). */
export const STAR_DEFAULT_BV = 0.6;
/** Floats per star in the vertex buffer: xyz, σ, rgb, alpha. */
export const STAR_VERTEX_FLOATS = 8;

const DEG = Math.PI / 180;
// Fraction of the colour kept: the eye sees all but the most extreme stars
// as nearly white, and saturated dots read as UI markers on the globe.
const COLOR_SATURATION = 0.55;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** ICRF unit vector for J2000 right ascension and declination in degrees. */
export function raDecToUnitVector(raDeg, decDeg) {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const cosDec = Math.cos(dec);
  return [cosDec * Math.cos(ra), cosDec * Math.sin(ra), Math.sin(dec)];
}

/**
 * Perceived brightness relative to the limit magnitude. Flux grows 2.512×
 * per magnitude; the square root compresses Sirius-to-6.5m (≈ 1600×) into a
 * range a display can show without the bright stars turning into discs.
 */
export function starBrightness(vmag) {
  const magnitude = Number.isFinite(vmag) ? vmag : STAR_LIMIT_MAGNITUDE;
  return (
    10 **
    (-0.2 * (Math.min(magnitude, STAR_LIMIT_MAGNITUDE) - STAR_LIMIT_MAGNITUDE))
  );
}

/**
 * Sprite parameters for a visual magnitude: `sigmaPx` is the Gaussian σ in
 * CSS pixels and `alpha` its peak opacity. Faint stars keep the minimum width
 * and fade; bright stars saturate and grow slowly.
 */
export function starAppearance(vmag) {
  const brightness = starBrightness(vmag);
  return {
    sigmaPx: clamp(
      STAR_MIN_SIGMA_PX * brightness ** 0.3,
      STAR_MIN_SIGMA_PX,
      STAR_MAX_SIGMA_PX,
    ),
    alpha: clamp(STAR_MIN_ALPHA * brightness, STAR_MIN_ALPHA, 1),
  };
}

/** Effective temperature from B−V (Ballesteros 2012). */
export function bvToTemperature(bv) {
  const index = clamp(Number.isFinite(bv) ? bv : STAR_DEFAULT_BV, -0.4, 2.0);
  return 4600 * (1 / (0.92 * index + 1.7) + 1 / (0.92 * index + 0.62));
}

/** Black-body colour of a temperature, sRGB 0..1 (Helland's fit). */
export function temperatureToRgb(kelvin) {
  const t = clamp(kelvin, 1000, 40000) / 100;
  const red = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const green =
    t <= 66
      ? 99.4708025861 * Math.log(t) - 161.1195681661
      : 288.1221695283 * (t - 60) ** -0.0755148492;
  const blue =
    t >= 66
      ? 255
      : t <= 19
        ? 0
        : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [red, green, blue].map((channel) => clamp(channel, 0, 255) / 255);
}

/**
 * Display colour for a B−V index: the black-body hue, desaturated towards
 * white and normalized so the brightest channel is 1 (brightness belongs to
 * the magnitude alone).
 */
export function bvToRgb(bv) {
  const rgb = temperatureToRgb(bvToTemperature(bv)).map(
    (channel) => 1 - COLOR_SATURATION + COLOR_SATURATION * channel,
  );
  const peak = Math.max(...rgb);
  return rgb.map((channel) => channel / peak);
}

/**
 * Decode a catalogue pack into interleaved vertex data, `STAR_VERTEX_FLOATS`
 * per star. Malformed rows are skipped, never thrown on: a damaged pack must
 * not take the globe down with it.
 */
export function buildStarVertices(pack) {
  const stars = Array.isArray(pack?.stars) ? pack.stars : [];
  const count = Math.floor(stars.length / 4);
  const vertices = new Float32Array(count * STAR_VERTEX_FLOATS);
  let written = 0;
  for (let i = 0; i < count; i++) {
    const [raDeg, decDeg, vmag, bv] = stars.slice(i * 4, i * 4 + 4);
    if (
      !Number.isFinite(raDeg) ||
      !Number.isFinite(decDeg) ||
      !Number.isFinite(vmag)
    )
      continue;
    const [x, y, z] = raDecToUnitVector(raDeg, decDeg);
    const { sigmaPx, alpha } = starAppearance(vmag);
    const [r, g, b] = bvToRgb(bv);
    vertices.set(
      [x, y, z, sigmaPx, r, g, b, alpha],
      written * STAR_VERTEX_FLOATS,
    );
    written += 1;
  }
  return {
    count: written,
    vertices:
      written === count
        ? vertices
        : vertices.slice(0, written * STAR_VERTEX_FLOATS),
  };
}
