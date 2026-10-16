// A Local ADS-B feed problem can be the whole error (nothing heard, WebUSB
// not producing); the row shows it in the UI language like any other piece.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { LayerPanel } from '../../ui/layerPanel.js';
import { localAdsbStatus } from './status.js';
const receiver = {
  webUsbSupported: true,
  connected: false,
  mode: 'adsb',
  status: 'idle',
};
function rowFor(status) {
  return LayerPanel.prototype._buildMetaText({
    id: 'local-adsb',
    enabled: true,
    stats: { count: 0, lastUpdate: Date.now(), ...status },
  });
}
for (const locale of ['es', 'ru']) {
  for (const status of ['unreachable', 'invalid']) {
    test(`${locale}: a lone ${status} decoder feed with nothing heard is translated`, () => {
      setLocale(locale);
      try {
        const st = localAdsbStatus({
          receiver,
          feedState: {
            configured: true,
            feeds: [{ id: 'a', label: '1090', band: '1090', status }],
          },
          heard: 0,
        });
        const row = rowFor(st);
        assert.doesNotMatch(row, /\b(unreachable|invalid)\b/, row);
      } finally {
        setLocale('en');
      }
    });
  }
}
