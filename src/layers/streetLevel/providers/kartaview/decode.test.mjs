import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCoverageTile } from './decode.js';

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
  assert.deepEqual(decodeCoverageTile(null, TILE).sequences, []);
});
