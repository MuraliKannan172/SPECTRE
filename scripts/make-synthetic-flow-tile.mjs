// Generate a synthetic TomTom-schema traffic-flow vector tile for tests.
//
// SPECTRE replaced the recorded TomTom tile (proprietary, © TomTom) with this
// deterministic street grid. It uses TomTom's Mapbox Vector Tile layout (layer
// "Traffic flow", traffic_level / road_type / road_closure properties) so
// src/layers/traffic/flowDecode.js is exercised exactly as live tiles exercise
// it, but every geometry and value here is made up.
//
//   node scripts/make-synthetic-flow-tile.mjs
//
// writes src/data/fixtures/synthetic-flow-austin-12-935-1686.pbf.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PbfWriter } from 'pbf';

const EXTENT = 4096;
const OUTPUT = new URL(
  '../src/data/fixtures/synthetic-flow-austin-12-935-1686.pbf',
  import.meta.url,
);
// TomTom road_type values that src/layers/traffic/roadModes.js treats as drivable.
const ROAD_TYPES = ['Motorway', 'Major road', 'Secondary road', 'Local road'];
// Dense enough that any downtown viewport the tests use crosses 50+ links.
const STREETS_PER_AXIS = 40;
const LINKS_PER_STREET = 8;

// Deterministic so the fixture bytes never change between runs.
let seed = 0x5eed;
function random() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

/** A street crossing the tile with a little jitter, in tile coordinates. */
function street(index, horizontal) {
  const offset = 48 + index * 100;
  const points = [];
  for (let step = 0; step <= LINKS_PER_STREET; step++) {
    // Start and end inside the tile buffer, as real tiles do, so clipping to
    // the tile edge is exercised.
    const along = -64 + step * 528;
    const across = offset + Math.round((random() - 0.5) * 40);
    points.push(horizontal ? [along, across] : [across, along]);
  }
  return points;
}

function features() {
  const list = [];
  for (let index = 0; index < STREETS_PER_AXIS; index++) {
    for (const horizontal of [true, false]) {
      const points = street(index, horizontal);
      // Split each street into two-vertex links, like TomTom's per-link
      // features.
      for (let part = 0; part < LINKS_PER_STREET; part++) {
        list.push({
          points: points.slice(part, part + 2),
          properties: {
            traffic_level: Math.round((0.2 + random() * 0.8) * 100) / 100,
            road_type: ROAD_TYPES[(index + part) % ROAD_TYPES.length],
            road_category: horizontal ? 'primary' : 'secondary',
            traffic_road_coverage: 'full',
            left_hand_traffic: false,
          },
        });
      }
    }
  }
  // Free-flowing, closed (no level: decodes to level 0) and unusable features.
  list[0].properties.traffic_level = 1;
  list[1].properties = { road_type: 'Major road', road_closure: true };
  list[2].properties = { ...list[2].properties, road_closure: true };
  list[3].properties = { road_type: 'Local road' };
  return list;
}

const zigzag = (value) => (value << 1) ^ (value >> 31);

function geometry(points) {
  const [[x0, y0], ...rest] = points;
  const commands = [(1 & 7) | (1 << 3), zigzag(x0), zigzag(y0)];
  commands.push((2 & 7) | (rest.length << 3));
  let [x, y] = [x0, y0];
  for (const [nx, ny] of rest) {
    commands.push(zigzag(nx - x), zigzag(ny - y));
    [x, y] = [nx, ny];
  }
  return commands;
}

function encodeLayer(list) {
  const keys = [];
  const values = [];
  const keyIndex = new Map();
  const valueIndex = new Map();
  const indexOf = (map, array, item, id) => {
    if (!map.has(id)) {
      map.set(id, array.length);
      array.push(item);
    }
    return map.get(id);
  };
  const encoded = list.map(({ points, properties }) => ({
    tags: Object.entries(properties).flatMap(([key, value]) => [
      indexOf(keyIndex, keys, key, key),
      indexOf(valueIndex, values, value, `${typeof value}:${value}`),
    ]),
    geometry: geometry(points),
  }));
  return { keys, values, features: encoded };
}

function writeValue(value, pbf) {
  if (typeof value === 'string') pbf.writeStringField(1, value);
  else if (typeof value === 'boolean') pbf.writeBooleanField(7, value);
  else pbf.writeDoubleField(3, value);
}

function writeFeature(feature, pbf) {
  pbf.writePackedVarint(2, feature.tags);
  pbf.writeVarintField(3, 2); // LINESTRING
  pbf.writePackedVarint(4, feature.geometry);
}

function writeLayer(layer, pbf) {
  pbf.writeVarintField(15, 2);
  pbf.writeStringField(1, 'Traffic flow');
  for (const feature of layer.features)
    pbf.writeMessage(2, writeFeature, feature);
  for (const key of layer.keys) pbf.writeStringField(3, key);
  for (const value of layer.values) pbf.writeMessage(4, writeValue, value);
  pbf.writeVarintField(5, EXTENT);
}

const pbf = new PbfWriter();
pbf.writeMessage(3, writeLayer, encodeLayer(features()));
const bytes = pbf.finish();
writeFileSync(OUTPUT, bytes);
console.log(`wrote ${bytes.length} bytes to ${fileURLToPath(OUTPUT)}`);
