// N-05: plan steps for preset ids from the tool schema (sf, nyc, dc) read
// "Sf" / "Nyc" / "Dc" in every language; 'tokyo' translates.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../i18n/index.js';
import { CITY_POIS } from '../locations.js';
import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';
import { narrationLabel, planStepLabel } from './speech.js';

test.afterEach(() => setLocale('en'));

test('es: preset location ids show the city name', () => {
  setLocale('es');
  assert.equal(
    planStepLabel('fly_to_location', { locationId: 'tokyo' }),
    'Volar a Tokio',
  );
  for (const id of ['sf', 'nyc', 'dc']) {
    const label = planStepLabel('fly_to_location', { locationId: id });
    assert.doesNotMatch(label, /\b(Sf|Nyc|Dc)$/, label);
  }
  assert.equal(
    planStepLabel('fly_to_location', { locationId: 'nyc' }),
    'Volar a Nueva York',
  );
});

test('ru: a preset id in the nearest-aircraft step names the city', () => {
  setLocale('ru');
  assert.match(
    planStepLabel('select_nearest_aircraft', { locationId: 'dc' }),
    /Вашингтон/,
  );
});

test('en: every preset id reads as its CITY_POIS name', () => {
  setLocale('en');
  for (const [id, city] of Object.entries(CITY_POIS)) {
    assert.equal(
      planStepLabel('fly_to_location', { locationId: id }),
      `Fly to ${city.name}`,
      id,
    );
    assert.equal(
      narrationLabel('fly_to_location', { locationId: id }),
      city.name,
    );
  }
  // Other places are shown as given.
  assert.equal(
    planStepLabel('fly_to_location', { query: 'Ulaanbaatar' }),
    'Fly to Ulaanbaatar',
  );
});

test('every locationId the voice tools accept is a preset city', () => {
  const ids = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.locationId?.enum))
      node.locationId.enum.forEach((id) => ids.add(id));
    Object.values(node).forEach(visit);
  };
  visit(GEV_ACTION_SCHEMAS);
  assert.ok(ids.size > 0, 'found the locationId enums');
  for (const id of ids) assert.ok(Object.hasOwn(CITY_POIS, id), id);
});
