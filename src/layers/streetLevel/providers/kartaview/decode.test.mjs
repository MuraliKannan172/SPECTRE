import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_LINE_POINTS,
  MAX_TILE_SEGMENTS,
  decodeCoverageTile,
} from './decode.js';

const at = (lng, lat) => ({ lat: String(lat), lng: String(lng) });
const TILE = { x: 4412, y: 6061, z: 14 };

test('segments that meet end to start chain into one line', () => {
  const { sequences, overview } = decodeCoverageTile(
    {
      lines: [
        { track: [at(1, 1), at(2, 1)], matched: '1' },
        { track: [at(5, 5), at(6, 6)], matched: '1' },
        { track: [at(2, 1), at(3, 1), at(4, 2)], matched: '1' },
      ],
    },
    TILE,
  );
  assert.deepEqual(overview, []);
  assert.equal(sequences.length, 2);
  assert.deepEqual(sequences[0].parts, [
    [
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
    ],
  ]);
  assert.equal(sequences[0].id, '14/4412/6061/0');
  assert.equal(sequences[1].id, '14/4412/6061/1');
  // Nothing to date or project: every line passes as flat and undated.
  assert.equal(sequences[0].capturedAt, 0);
  assert.equal(sequences[0].isPano, false);
});

test('a junction continues one way only, and every segment is drawn exactly once', () => {
  const { sequences } = decodeCoverageTile(
    {
      lines: [
        { track: [at(0, 0), at(1, 0)] },
        { track: [at(1, 0), at(2, 0)] },
        { track: [at(1, 0), at(1, 1)] },
        // A loop back to its own start must end, not spin.
        { track: [at(9, 9), at(9, 8)] },
        { track: [at(9, 8), at(9, 9)] },
      ],
    },
    TILE,
  );
  const points = sequences.reduce((sum, s) => sum + s.parts[0].length, 0);
  assert.equal(sequences.length, 3);
  // 5 segments of 2 points, 2 joins in chains: 10 - 2 = 8 points.
  assert.equal(points, 8);
});

test('bad points, repeats and one-point tracks are skipped; an empty tile has no lines', () => {
  const { sequences } = decodeCoverageTile(
    {
      lines: [
        { track: [at(1, 1), at(1, 1), { lat: 'x', lng: '2' }, at(2, 2)] },
        { track: [at(3, 3)] },
        { track: null },
        null,
      ],
    },
    TILE,
  );
  assert.equal(sequences.length, 1);
  assert.deepEqual(sequences[0].parts[0], [
    [1, 1],
    [2, 2],
  ]);
  assert.deepEqual(decodeCoverageTile({ lines: [] }, TILE).sequences, []);
});

test('a tile that is not a line list fails, so it is asked for again rather than kept empty', () => {
  for (const payload of [
    null,
    {},
    { lines: 'nope' },
    { status: { apiCode: 690 } },
  ])
    assert.throws(
      () => decodeCoverageTile(payload, TILE),
      /unreadable coverage tile/,
    );
});

test('a tile whose segments all share one point decodes in linear time', () => {
  // [P, Q_i, P]: every chain step looks at the same start point's list.
  // 60k: the old quadratic chaining took over a second; capped and linear
  // decoding takes tens of milliseconds.
  const lines = Array.from({ length: 60_000 }, (_, i) => ({
    track: [at(0, 0), at(1 + i * 1e-6, 1), at(0, 0)],
  }));
  const started = performance.now();
  const { sequences } = decodeCoverageTile({ lines }, TILE);
  const ms = performance.now() - started;
  assert.ok(
    ms < 1_000,
    `${Math.round(ms)} ms (quadratic chaining took ~200 ms per 20k and grows fourfold per doubling)`,
  );
  const points = sequences.reduce((sum, s) => sum + s.parts[0].length, 0);
  assert.ok(sequences.every((s) => s.parts[0].length <= MAX_LINE_POINTS));
  assert.equal(
    points,
    MAX_TILE_SEGMENTS * 2 + sequences.length,
    'every segment drawn once',
  );
});

test('a tile is capped in segments and in points per line', () => {
  const lines = Array.from({ length: MAX_TILE_SEGMENTS + 500 }, (_, i) => ({
    track: [at(i, 0), at(i + 1, 0)],
  }));
  const { sequences } = decodeCoverageTile({ lines }, TILE);
  const points = sequences.reduce((sum, s) => sum + s.parts[0].length, 0);
  // One long chain, cut into lines of at most MAX_LINE_POINTS.
  assert.ok(sequences.every((s) => s.parts[0].length <= MAX_LINE_POINTS));
  assert.ok(points <= MAX_TILE_SEGMENTS + sequences.length);
  assert.ok(
    sequences.length >= Math.floor(MAX_TILE_SEGMENTS / MAX_LINE_POINTS),
  );
});
