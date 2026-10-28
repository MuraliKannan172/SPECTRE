/**
 * SPECTRE: the application's readiness signals for the boot overlay's GLOBE
 * ENGINE and DATA LAYERS rows. Reporting never changes what the application
 * does: a failing step is reported and its error rethrown unchanged.
 */
import { VERSION } from 'cesium';
import { classifyLayers, describe, probeGlobe } from './probes.js';
import { markBoot } from './session.js';

/** Run one start-up step; if it throws, mark row `id` offline and rethrow. */
export async function bootStep(id, run) {
  try {
    return await run();
  } catch (error) {
    markBoot(id, 'offline', describe(error));
    throw error;
  }
}

/** Mark the globe row once the viewer has drawn its first frame. */
export function reportGlobe(scene) {
  probeGlobe(scene, { version: VERSION }).then(({ state, detail }) =>
    markBoot('globe', state, detail),
  );
}

/** Mark the layers row from the registered layer catalog. */
export function reportLayers(catalog) {
  const { state, detail } = classifyLayers(catalog);
  markBoot('layers', state, detail);
}
