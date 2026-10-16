// N-10: the Local ADS-B row's working texts ("3 heard · 5.8 msg/s",
// "2 feeds live · 14 heard", "listening", "USB error", feed problems) have no
// catalog entries and stay English in es/ru. Place: src/layers/localAdsb/statusLocale.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { LayerPanel } from '../../ui/layerPanel.js';
import { localAdsbStatus } from './status.js';

const receiver = {
  webUsbSupported: true,
  connected: true,
  mode: 'adsb',
  status: 'streaming',
  messagesPerSecond: 5.8,
};

function rowFor(status) {
  return LayerPanel.prototype._buildMetaText({
    id: 'local-adsb',
    enabled: true,
    stats: { count: 3, lastUpdate: Date.now(), ...status },
  });
}

for (const locale of ['es', 'ru']) {
  test(`${locale}: the streaming Local ADS-B row is translated`, () => {
    setLocale(locale);
    try {
      const row = rowFor(
        localAdsbStatus({ receiver, feedState: null, heard: 3 }),
      );
      assert.doesNotMatch(row, /\bheard\b/, row);
    } finally {
      setLocale('en');
    }
  });
}
