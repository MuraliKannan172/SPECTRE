/**
 * SPECTRE boot entry: index.html loads this module before src/main.js, so the
 * overlay is up while the application loads behind it. It never waits on the
 * application: the intel and Neural Core rows are probed here, the globe and
 * layer rows are reported by the application (src/boot/appSignals.js), and
 * maxMs releases any row nobody reported.
 */
import { resolveLocale } from '../i18n/locale.js';
import { setLocale, t } from '../i18n/index.js';
import { startBoot } from './spectre-boot.js';
import { classifyChatStatus, classifyIntelHealth, probeRow } from './probes.js';
import { bootModeFor, readBrandPrefs, setHeaderGlitch } from './settings.js';
import { setBootHandle } from './session.js';

/**
 * An embedded globe (an iframe or the MCP panel) never shows the overlay.
 * Mirrors isEmbedded() in src/app/embed.js, which imports Cesium and so
 * cannot load this early.
 */
function embedded() {
  try {
    return (
      globalThis.GEV_EMBED_INLINE === true ||
      new URLSearchParams(location.search).get('embed') === '1'
    );
  } catch {
    return false;
  }
}

setLocale(resolveLocale());
const prefs = readBrandPrefs();
const assetBase = import.meta.env?.BASE_URL || '/';
const boot = startBoot({
  assetUrl: (file) => `${assetBase}brand/${file}`,
  mode: embedded() ? 'off' : bootModeFor(prefs.animation),
  respectUrl: !embedded(),
  minMs: 1600,
  maxMs: 9000,
  translate: t,
});
setBootHandle(boot);
boot.whenDone.then(() => setBootHandle(null));
// The overlay (if any) is in the DOM now; drop index.html's first-paint cover.
document.getElementById('spectre-boot-cover')?.remove();

const intelOffline = t('intel service offline');
// The same root-relative paths the News layer and Neural Core client use.
probeRow(
  (state, detail) => boot.mark('intel', state, detail),
  '/api/intel/health',
  classifyIntelHealth,
  { offlineDetail: intelOffline },
);
probeRow(
  (state, detail) => boot.mark('core', state, detail),
  '/api/intel/chat/status',
  classifyChatStatus,
  { offlineDetail: intelOffline },
);

setHeaderGlitch(prefs.glitch === 'on');
