import path from 'node:path';
import { PANEL_BASE } from './panel.js';

/**
 * SPECTRE: production HTML for the boot overlay (src/boot/entry.js).
 *
 * In a build, Vite merges every module script of index.html into one entry
 * chunk, and vite-plugin-cesium puts a parser-blocking
 * `<script src="/cesium/Cesium.js">` (5.7 MB) at the top of <head>. Nothing
 * painted before about 700 ms, and the overlay arrived with the app. This
 * plugin, for builds only:
 *  - builds the boot entry as its own small chunk, loaded ahead of Cesium;
 *  - marks the Cesium script `defer`. Deferred classic and module scripts run
 *    in document order, so Cesium still runs before the app module.
 * The dev server and the MCP panel build (PANEL_BASE, one script by design)
 * are left alone. Removing the plugin from build/vite.js returns upstream's
 * loading.
 */
export const BOOT_ENTRY = 'src/boot/entry.js';
const BOOT_TAG = `<script type="module" src="/${BOOT_ENTRY}"></script>`;
const PLACEHOLDER = '<!-- spectre:boot-entry -->';
const CESIUM_SCRIPT = /<script src="([^"]*cesium\/Cesium\.js)"><\/script>/;

export function spectreBootHtmlPlugins() {
  let enabled = false;
  let base = '/';
  let entryPath = '';
  const isBootChunk = (item) =>
    item.type === 'chunk' &&
    item.facadeModuleId &&
    path.normalize(item.facadeModuleId) === entryPath;
  return [
    {
      name: 'spectre-boot-html:pre',
      apply: 'build',
      configResolved(config) {
        base = config.base;
        enabled = config.base !== PANEL_BASE;
        entryPath = path.normalize(path.resolve(config.root, BOOT_ENTRY));
      },
      buildStart() {
        if (enabled)
          this.emitFile({ type: 'chunk', id: entryPath, name: 'spectre-boot' });
      },
      transformIndexHtml: {
        order: 'pre',
        // Taken out of the page so Vite does not merge it into the app chunk.
        handler: (html) =>
          enabled && html.includes(BOOT_TAG)
            ? html.replace(BOOT_TAG, PLACEHOLDER)
            : html,
      },
    },
    {
      name: 'spectre-boot-html:post',
      apply: 'build',
      transformIndexHtml: {
        order: 'post',
        handler(html, ctx) {
          if (!enabled || !html.includes(PLACEHOLDER)) return html;
          const chunk = Object.values(ctx.bundle || {}).find(isBootChunk);
          if (!chunk)
            throw new Error(`spectre-boot-html: no chunk for ${BOOT_ENTRY}`);
          const tags = [
            ...chunk.imports.map(
              (file) =>
                `<link rel="modulepreload" crossorigin href="${base}${file}">`,
            ),
            `<script type="module" crossorigin src="${base}${chunk.fileName}"></script>`,
          ].join('\n  ');
          const page = html.replace(PLACEHOLDER, '');
          const cesium = page.match(CESIUM_SCRIPT);
          if (!cesium) return page.replace('</head>', `  ${tags}\n</head>`);
          return page.replace(
            cesium[0],
            `${tags}\n  <script defer src="${cesium[1]}"></script>`,
          );
        },
      },
    },
  ];
}
