# Sky background

The space behind the globe (`src/sky/starrySky.js`): catalogue stars drawn as
sharp point sprites over a soft Milky Way cube map. It replaces Cesium's
default Tycho-2 sky box, whose six 1024² JPEGs stretch 3–6× around the
whole-globe view and show compression blocks.

| File | Content | Size |
| ---- | ------- | ---- |
| `bright_stars.json` | 9,096 stars: J2000 RA/Dec, V magnitude, B−V | 235 KB |
| `milkyway_{px,nx,py,ny,pz,nz}.webp` | Milky Way glow, six 1024² cube faces, no stars | 247 KB |

## Stars — Yale Bright Star Catalogue

**Source:** Yale Bright Star Catalogue, 5th Revised Edition (Hoffleit &
Warren 1991), CDS VizieR catalogue
[V/50](https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50), file
`https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz` (sha256
`3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed`, fetched
2026-10-19).

**License:** public domain (Yale University Observatory / NASA Astronomical
Data Center). CDS asks for an acknowledgement; the in-app "Data attribution"
popover carries it.

**Build:** `node scripts/build-bright-stars.mjs [catalog.gz]` — every record
with a J2000 position (14 novae and non-stellar entries dropped), RA/Dec
rounded to 0.001°, magnitudes to 0.01. The renderer maps magnitude to sprite
width and opacity and B−V to a desaturated black-body colour
(`src/sky/stars.js`).

## Milky Way — ESO/S. Brunier

**Source:** "The Milky Way panorama", ESO image
[eso0932a](https://www.eso.org/public/images/eso0932a/), full-size original
`https://cdn.eso.org/images/original/eso0932a.tif` (6000×3000 sRGB TIFF, sha256
`10f209ab83e1fd89e7fa1ed70277ffc6ed19c43549f04ec637c6806d98aff035`, fetched
2026-10-19). Plate carrée in galactic coordinates, centred on the Galactic
Centre.

**License:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
(<https://www.eso.org/public/outreach/copyright/>). **Credit: ESO/S. Brunier.**

**Changes made** (CC BY 4.0 asks for them to be stated): resampled to
4096×2048, two planets (Jupiter, by position) painted over with the surrounding sky,
stars removed with a 7×7 morphological opening, blurred (σ = 0.4°),
reprojected from galactic coordinates to ICRF cube faces, black level set at
the darkest 25 % of the sky, gamma-encoded and saved as WebP. Build:
`node scripts/build-milky-way.mjs <eso0932a.tif>`.

The panorama is a photographic mosaic, not an astrometric map: bright stars
sit up to ~2° from their catalogue positions. That is invisible in a glow
blurred this much, and every sharp star on screen comes from the catalogue.

The NASA SVS "Deep Star Maps 2020" Milky Way layer was considered and not
used: it is derived from Gaia DR2, which ESA distributes under CC BY-NC 3.0
IGO with prior authorization required for commercial use.

## Frame

Both layers are in ICRF/J2000. The cube faces use the standard WebGL face
layout with +X towards the March equinox and +Z towards the north celestial
pole, uploaded without `flipY`. At runtime one rotation —
`Transforms.computeIcrfToFixedMatrix` at the scene clock — turns both into
Earth-fixed coordinates.
