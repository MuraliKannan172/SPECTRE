import * as Cesium from 'cesium';

// SPECTRE: the keyless default is NASA Blue Marble from GIBS. Esri's terms
// license its basemaps for use with Esri software or an ArcGIS Online
// subscription (docs/ADR-001.md D12), so Esri stays a choice, not the default.
export const KEYLESS_DEFAULT_STACK_ID = 'nasa-gibs';

export const MAP_STACKS = [
  {
    id: 'photoreal',
    label: 'Google 3D', // i18n-ignore: imagery product name
    shortLabel: '3D',
    kind: 'photoreal',
    requiresIon: false,
  },
  {
    id: 'bing-aerial',
    label: 'Bing Aerial', // i18n-ignore: imagery product name
    shortLabel: 'Aerial',
    kind: 'ion',
    style: Cesium.IonWorldImageryStyle.AERIAL,
    requiresIon: true,
  },
  {
    id: 'bing-labels',
    label: 'Bing Labels', // i18n-ignore: imagery product name
    shortLabel: 'Labels',
    kind: 'ion',
    style: Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS,
    requiresIon: true,
  },
  // SPECTRE: NASA Blue Marble (public domain) through GIBS, keyless.
  {
    id: 'nasa-gibs',
    label: 'NASA Blue Marble', // i18n-ignore: imagery product name
    shortLabel: 'NASA',
    kind: 'gibs',
    requiresIon: false,
  },
  {
    id: 'esri-imagery',
    label: 'Esri Satellite', // i18n-ignore: imagery product name
    shortLabel: 'SAT',
    kind: 'esri-imagery',
    requiresIon: false,
  },
  {
    id: 'osm',
    label: 'OSM', // i18n-ignore: imagery product name
    shortLabel: 'OSM',
    kind: 'osm',
    requiresIon: false,
  },
];
