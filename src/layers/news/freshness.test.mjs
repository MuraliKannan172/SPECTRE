import test from 'node:test';
import assert from 'node:assert/strict';

import { NEWS_ERROR_TEXTS, newsFreshness } from './freshness.js';
import { INTEL_OFFLINE, NEWS_UNAVAILABLE } from './source.js';

test('a live feed says how long ago it updated, with no badge', () => {
  assert.deepEqual(
    newsFreshness({ freshness: { state: 'live', ageSeconds: 300 } }),
    { tone: 'live', badge: null, text: 'Updated 5m ago' },
  );
});

test('a stale feed carries the STALE badge and its age', () => {
  assert.deepEqual(
    newsFreshness({ freshness: { stale: true, ageSeconds: 7200 } }),
    { tone: 'stale', badge: 'STALE', text: 'Stale · updated 2h ago' },
  );
  assert.equal(newsFreshness({ freshness: { stale: true } }).text, 'STALE');
});

test('an offline service or an error shows OFFLINE', () => {
  assert.equal(newsFreshness({ freshness: { offline: true } }).tone, 'offline');
  assert.equal(
    newsFreshness({ freshness: { state: 'offline' } }).badge,
    'OFFLINE',
  );
  assert.deepEqual(newsFreshness({ error: INTEL_OFFLINE }), {
    tone: 'offline',
    badge: 'OFFLINE',
    text: INTEL_OFFLINE,
  });
  // Errors from elsewhere show as given.
  assert.equal(
    newsFreshness({ error: 'News unavailable (HTTP 502)' }).text,
    'News unavailable (HTTP 502)',
  );
});

test('loading and idle states have no badge', () => {
  assert.deepEqual(newsFreshness({ loading: true }), {
    tone: 'loading',
    badge: null,
    text: 'Loading news…',
  });
  assert.deepEqual(newsFreshness(), { tone: 'idle', badge: null, text: null });
});

test('the catalog marks the exact error texts the source raises', () => {
  assert.deepEqual(NEWS_ERROR_TEXTS, [INTEL_OFFLINE, NEWS_UNAVAILABLE]);
});
