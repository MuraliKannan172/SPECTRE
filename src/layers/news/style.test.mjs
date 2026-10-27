import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NEWS_ALERT_RING,
  NEWS_CATEGORY_COLORS,
  newsClusterSize,
  newsMarkerOpacity,
  newsMarkerSize,
  newsMarkerStyle,
} from './style.js';
import { NEWS_CATEGORIES } from './records.js';
import { BRANDING } from '../../branding.js';

const HOUR = 3600_000;
const NOW = Date.parse('2026-10-25T12:00:00Z');

test('every category has its own color, and none of them is the brand red', () => {
  const colors = NEWS_CATEGORIES.map(
    (category) => NEWS_CATEGORY_COLORS[category],
  );
  assert.ok(colors.every(Boolean));
  assert.equal(new Set(colors).size, colors.length);
  for (const red of [BRANDING.colors.accent, BRANDING.colors.accentDeep]) {
    assert.ok(!colors.includes(red.toUpperCase()));
  }
  assert.equal(NEWS_ALERT_RING, BRANDING.colors.accent.toUpperCase());
});

test('size follows the number of outlets, capped', () => {
  assert.equal(newsMarkerSize({ sourceCount: 1 }), 8);
  assert.equal(newsMarkerSize({ sourceCount: 3 }), 12);
  assert.equal(newsMarkerSize({ sourceCount: 40 }), 16);
  assert.equal(newsMarkerSize({}), 8);
});

test('opacity fades with age across the window', () => {
  const at = (hoursAgo) =>
    newsMarkerOpacity({ publishedAt: NOW - hoursAgo * HOUR }, NOW, 24);
  assert.equal(at(0.5), 1);
  assert.equal(at(24), 0.35);
  assert.equal(at(100), 0.35);
  assert.ok(at(12) < 1 && at(12) > 0.35);
  assert.equal(
    newsMarkerOpacity({ publishedAt: NOW + HOUR }, NOW, 24),
    1,
    'a future timestamp is treated as fresh',
  );
});

test('only true alerts get the red ring', () => {
  const routine = newsMarkerStyle(
    { category: 'conflict', severity: 3, sourceCount: 1, publishedAt: NOW },
    NOW,
    24,
  );
  assert.equal(routine.alert, false);
  assert.notEqual(routine.outlineColor, NEWS_ALERT_RING);
  const alert = newsMarkerStyle(
    { category: 'disaster', severity: 4, sourceCount: 1, publishedAt: NOW },
    NOW,
    24,
  );
  assert.equal(alert.alert, true);
  assert.equal(alert.outlineColor, NEWS_ALERT_RING);
  assert.ok(alert.outlineWidth > routine.outlineWidth);
});

test('clusters grow slowly with their count', () => {
  assert.equal(newsClusterSize(1), 14);
  assert.ok(newsClusterSize(8) > newsClusterSize(2));
  assert.equal(newsClusterSize(100000), 34);
});
