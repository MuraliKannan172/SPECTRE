import { createPhotoViewer, loadImage } from '../../photoViewer.js';
import {
  HD_TIMEOUT_MS,
  PANORAMAX_NAME,
  PANORAMAX_PROVIDER_ID,
  PANO_HD_MAX_WIDTH,
  SD_WIDTH,
  panoramaxPictureUrl,
} from './policy.js';

/**
 * Where Panoramax pictures come from: the instance holding each one serves
 * a 2,048 px SD derivative (equirectangular for a 360° picture) and the HD
 * original. SD shows first; HD only once the viewer is wide enough to use
 * it. A 360° original is shrunk to the texture size while it decodes.
 * @type {import('../../photoViewer.js').PhotoSources}
 */
export const PANORAMAX_SOURCES = Object.freeze({
  hasPano: (photo) => Boolean(photo.isPano && (photo.urls.sd || photo.urls.hd)),
  panoFirst: (photo) =>
    photo.urls.sd
      ? { url: photo.urls.sd, width: SD_WIDTH }
      : { url: photo.urls.hd, width: photo.width || SD_WIDTH },
  panoSharp: (photo, size) => {
    const width = photo.width || 0;
    if (!photo.urls.hd || !photo.urls.sd) return null;
    // An original no wider than the SD one adds nothing; a huge one would
    // take hundreds of megabytes to decode.
    if (width <= SD_WIDTH || width > PANO_HD_MAX_WIDTH) return null;
    const target = Math.min(size[0], width);
    return {
      url: photo.urls.hd,
      resize: [target, target / 2],
      timeoutMs: HD_TIMEOUT_MS,
    };
  },
  // A 360° picture shown flat (no WebGL) is its whole equirectangular image.
  flatFirst: (photo) => [photo.urls.sd, photo.urls.hd, photo.urls.thumb],
  flatSharp: (photo, pixels) =>
    photo.urls.sd && photo.urls.hd && pixels > SD_WIDTH ? photo.urls.hd : null,
  describe: (photo) => ({
    title: null,
    creator: photo.creator,
    license: photo.license,
    externalUrl: panoramaxPictureUrl(photo.id),
  }),
});

/**
 * Viewer adapter for Panoramax pictures: flat in an <img>, 360° on the
 * shared WebGL panorama, ‹ › along the sequence (photoViewer.js).
 * @param {object} options   See photoViewer.js `createPhotoViewer`.
 * @returns {import('../../registry.js').ViewerAdapter}
 */
export function createPanoramaxViewer({ load = loadImage, ...options }) {
  return createPhotoViewer({
    providerId: PANORAMAX_PROVIDER_ID,
    name: PANORAMAX_NAME,
    sources: PANORAMAX_SOURCES,
    load,
    ...options,
  });
}
