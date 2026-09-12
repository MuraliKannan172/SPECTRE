# Formatting and component boundaries

Run `npm run format` to format the files in `scripts/format-scope.json` and
`npm run format:check` to check that same list without writing. CI checks the
entire adopted list on Linux and Windows. Prettier is pinned in the development
dependencies; use the installed version so local and CI output agree. The shared
configuration specifies two spaces, single quotes, semicolons and LF endings.

Add new reusable modules and their tests to the list as they are extracted.
Keep mechanical formatting in its own commit after behavior is stable. Existing
source-text regression assertions still apply; investigate failures and preserve
their behavioral coverage when a move or line wrap changes a tested shape.
Files outside the list retain their surrounding style until deliberately adopted.
Generated output, local configuration, browser evidence and bundled datasets are
excluded. The formatter validates every entry before writing any file.

## Current component ownership

| Surface                                                   | Owns                                                                   | Receives from its caller                            |
| --------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| `gods-eye-view/infrastructure`                            | Datacenter/dam definitions and fresh layer construction                | Context, overlay and render operations              |
| `gods-eye-view/infrastructure/geojson`                    | Data loading, Cesium entities, selection handling and resource cleanup | A viewer and those same operations                  |
| `gods-eye-view/infrastructure/lod`                        | Pure visibility budgets and selection policy                           | Position/visibility records and camera measurements |
| `src/data/localGeojson.js`                                | Standalone compatibility wiring                                        | The application's existing shared services          |
| `src/main.js`, `src/editions/local/` and `vite.config.js` | Standalone startup and local Node services                             | Local configuration                                 |

The scoped package exports are browser source modules. Use their documented
exports instead of importing standalone startup or reaching into internal files.
The application owns the viewer, context store, overlay host and render scheduler;
layers use the supplied callbacks. See [the infrastructure contract](INFRASTRUCTURE-LAYERS.md).

`npm run check:boundaries` builds every declared package export, with app Vite
configuration disabled. `scripts/package-boundaries.json` lists each export's
component, owned modules and external runtime dependencies. A new export must be
classified. Imports outside the declared modules fail, including unused and
literal dynamic imports. Cesium stays external so the consuming application
supplies the same compatible instance as its viewer. Existing consumer tests
also check import-time inactivity and asset URLs under a non-root base.

These checks cover the declared exports, not every import in the application.
They check build-time imports, not arbitrary runtime-generated module URLs.
Keep runtime module discovery out of these exports. When extracting another
component, add its ownership and consumer tests together. Node services must use
separate entry points and their own checks when they become reusable; importing
them into a browser component is not supported. No Node service is exported yet.

`gods-eye-view/application` owns construction order, startup state, cancellation
and disposal of caller-supplied components. Its only owned module is
`src/app/application.js`. `gods-eye-view/application/viewer` separately owns the
standard Cesium viewer configuration in `src/app/viewer.js`; Cesium stays external.
Neither export imports standalone UI, layers, tools or configuration. See
[application construction](APPLICATION.md) for the contracts and current limits.

UI panels and individual source adapters remain future extractions. They should
become smaller modules with explicit lifecycle owners as their callers migrate.
