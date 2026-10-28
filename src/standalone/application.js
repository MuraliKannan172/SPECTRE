import { createStandaloneCatalog } from './catalog.js';
import { createStandalonePlaceSearch } from './placeSearch.js';
import { CITY_POIS } from '../cityPois.js';
import { createApplication } from '../app/application.js';
import { createStandaloneScene } from './scene.js';
import { createStandaloneControls } from './controls.js';
import { createStandaloneData } from './data.js';
import { createStandaloneTools } from './tools.js';
import { resolveLocale, applyDocumentLanguage } from '../i18n/locale.js';
import { applyDocumentTranslations, setLocale } from '../i18n/index.js';
import { applyBranding } from '../ui/branding.js';
import { createGoogleTokenSource } from '../maps/googleTokens.js';
import { mountNewsPanel } from '../layers/news/panel.js';
import { createNeuralCoreClient } from '../neuralCore/client.js';
import { layerStateSnapshot, viewportSnapshot } from '../neuralCore/context.js';
import { createClientToolExecutor } from '../neuralCore/executor.js';
import { mountNeuralCorePanel } from '../neuralCore/panel.js';
import { bootStep, reportGlobe, reportLayers } from '../boot/appSignals.js';
import { mountBrandSettings } from '../boot/settings.js';

// The existing controls and layer catalog contain page-scoped state.
let constructed = false;

/** Compose the standalone application once per page. Reload to start again. */
export function createStandaloneApplication({
  googleApiKey,
  cesiumToken,
  geospatial = {},
  voice = {},
  sources = {},
  streetLevelProviders,
  allowQaRegistration = false,
}) {
  if (constructed)
    throw new Error('The standalone application already owns this page');
  constructed = true;
  // Locale is resolved before any UI initialization so <html lang>/<html dir>
  // and every catalog lookup agree from the first painted frame. Module
  // scripts execute after parsing, so the DOM is ready here and every
  // data-i18n* element honors the resolved locale without a reload.
  const activeLocale = resolveLocale();
  setLocale(activeLocale);
  applyDocumentLanguage(document, activeLocale);
  applyDocumentTranslations(document);
  applyBranding(document);
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');
  let placeSearch;
  let catalog;
  return createApplication({
    createScene: async (context) => {
      placeSearch = createStandalonePlaceSearch({
        // The bundled city and landmark data the offline name provider reads.
        // The search package takes it as plain data rather than importing it,
        // so it stays free of application state.
        presets: CITY_POIS,
        ...geospatial,
        resolveApiKey: () => googleApiKey,
        signal: context.signal,
      });
      // SPECTRE: the boot overlay's GLOBE ENGINE and DATA LAYERS rows.
      const scene = await bootStep('globe', () =>
        createStandaloneScene({
          ...context,
          googleApiKey,
          // Without a key, Google 3D can still load with tokens from the
          // app's server when it offers them.
          googleTokens: googleApiKey ? null : createGoogleTokenSource(),
          cesiumToken,
          loaderStatus,
        }),
      );
      reportGlobe(scene);
      catalog = await bootStep('layers', () =>
        createStandaloneCatalog({
          sources,
          streetLevelProviders,
          signal: context.signal,
          surface: scene.operations.surface,
        }),
      );
      return scene;
    },
    createControls: (context) =>
      createStandaloneControls({
        ...context,
        loaderStatus,
        placeSearch,
        catalog,
      }),
    createData: async (context) => {
      const data = await bootStep('layers', () =>
        createStandaloneData({ ...context, allowQaRegistration, catalog }),
      );
      reportLayers(catalog);
      return data;
    },
    createTools: async (context) => {
      const tools = await createStandaloneTools({
        ...context,
        loadingScreen,
        placeSearch,
        voice,
      });
      // SPECTRE: the News drawer and ticker, shown while the News layer is on,
      // and the Neural Core chat, whose globe tools run through the voice
      // runner. The two share the right edge, so opening one closes the other.
      let newsPanel = null;
      const neuralCore = mountNeuralCorePanel({
        document,
        client: createNeuralCoreClient(),
        execute: createClientToolExecutor({
          runner: (name, args, options) =>
            tools.voiceCommands.runner(name, args, options),
        }),
        viewport: () => viewportSnapshot(context.scene.viewer),
        layerState: () => layerStateSnapshot(context.data.dataManager),
        onOpen: () => newsPanel?.close(),
      });
      context.defer(() => neuralCore.destroy());
      const brandSettings = mountBrandSettings(document);
      if (brandSettings) context.defer(brandSettings);
      const news = catalog?.layers?.find((layer) => layer.id === 'news');
      if (news?.subscribe) {
        newsPanel = mountNewsPanel({
          document,
          layer: news,
          onOpen: () => neuralCore.close(),
        });
        context.defer(() => newsPanel.destroy());
      }
      return tools;
    },
  });
}
