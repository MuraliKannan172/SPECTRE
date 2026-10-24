# Third-party software notices

The project depends on third-party npm packages whose own licenses apply. This
file records the packages added for the browser-local SDR feature and the
Street Level viewer; the complete resolved dependency inventory remains in
`package-lock.json`.

## Web RTL-SDR

- Package: `@jtarrio/webrtlsdr` 3.0.6
- Author: Jacobo Tarrio Barreiro; portions copyright Google Inc.
- Source: <https://github.com/jtarrio/webrtlsdr>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

## Signals

- Package: `@jtarrio/signals` 0.10.1
- Author: Jacobo Tarrio Barreiro
- Source: <https://github.com/jtarrio/signals>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

## MapillaryJS

- Package: `mapillary-js` 4.1.2 (loaded on demand by the Street Level viewer,
  with its stylesheet `dist/mapillary.css`)
- Author: Copyright (c) Facebook, Inc. and its affiliates
- Source: <https://github.com/mapillary/mapillary-js>
- License: MIT
- License text: <https://github.com/mapillary/mapillary-js/blob/main/LICENSE>

## RxJS (MapillaryJS dependency)

- Package: `rxjs` 7.8.2
- Author: Google, Inc., Netflix, Inc., Microsoft Corp. and contributors
- Source: <https://github.com/ReactiveX/rxjs>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

## three.js (MapillaryJS dependency)

- Package: `three` 0.134.0
- Author: Copyright © 2010-2021 three.js authors
- Source: <https://github.com/mrdoob/three.js>
- License: MIT
- License text: <https://github.com/mrdoob/three.js/blob/dev/LICENSE>

## Fonts bundled by SKYNET

SKYNET serves these fonts from its own build instead of Google Fonts. Each
package ships its full licence text as `LICENSE`; a release build must carry
those texts with the font files.

- **JetBrains Mono** — `@fontsource/jetbrains-mono` 5.3.0. Copyright 2020 The
  JetBrains Mono Project Authors (<https://github.com/JetBrains/JetBrainsMono>).
  SIL Open Font License 1.1.
- **Inter** — `@fontsource/inter` 5.3.0. Copyright 2016 The Inter Project
  Authors (<https://github.com/rsms/inter>). SIL Open Font License 1.1.
- **Rajdhani** — `@fontsource/rajdhani` 5.3.0. Copyright (c) 2014 Indian Type
  Foundry (info@indiantypefoundry.com). SIL Open Font License 1.1.
- **Material Symbols Outlined** — `material-symbols` 0.48.1, packaging
  Google's Material Symbols. Apache License 2.0.

SIL Open Font License 1.1 text: <https://openfontlicense.org/open-font-license-official-text/>.
Apache License 2.0 text: <https://www.apache.org/licenses/LICENSE-2.0>.
