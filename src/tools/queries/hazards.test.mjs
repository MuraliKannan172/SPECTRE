import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog } from '../catalog.js';
import { getActiveFires } from './hazards.js';

const catalogWith = (fires) =>
  composeCatalog({
    tools: [getActiveFires],
    services: { fires: { getSnapshot: async () => ({ fires }) } },
  });

test('a fire acquired at 00:45 UTC reads as 00:45, not "45"', async () => {
  const result = await catalogWith([
    { lat: 24, lon: 121, frp: 5, acqDate: '2026-01-01', acqTime: '45' },
  ]).call('get_active_fires', { area: { bbox: [120, 23, 122, 25] } });
  assert.equal(result.data.rows[0].acquired, '2026-01-01T00:45:00.000Z');
});
