import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adoptLegacyBrandEnv,
  brandNameFor,
  legacyNameFor,
  withLegacyRetired,
} from './legacyBrandEnv.js';
import { upsertDotenvValues } from '../../../src/keySetupCore.mjs';

test('old SKYNET_ names are adopted under SPECTRE_ names, with one warning', () => {
  const warnings = [];
  const env = {
    SKYNET_INTEL_URL: 'http://127.0.0.1:8200',
    SKYNET_CHAT_ALLOW_LAN: '1',
    OLLAMA_HOST: '127.0.0.1:11434',
  };
  const adopted = adoptLegacyBrandEnv(env, { warn: (m) => warnings.push(m) });
  assert.deepEqual(adopted.sort(), [
    'SPECTRE_CHAT_ALLOW_LAN',
    'SPECTRE_INTEL_URL',
  ]);
  assert.equal(env.SPECTRE_INTEL_URL, 'http://127.0.0.1:8200');
  assert.equal(env.SKYNET_INTEL_URL, 'http://127.0.0.1:8200', 'kept as it was');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SKYNET_INTEL_URL/);
  assert.match(warnings[0], /SKYNET_CHAT_ALLOW_LAN/);
});

test('a SPECTRE_ name already set always wins, and nothing to adopt is silent', () => {
  const warnings = [];
  const env = {
    SPECTRE_NONCOMMERCIAL_SOURCES: '',
    SKYNET_NONCOMMERCIAL_SOURCES: '1',
  };
  assert.deepEqual(
    adoptLegacyBrandEnv(env, { warn: (m) => warnings.push(m) }),
    [],
  );
  assert.equal(env.SPECTRE_NONCOMMERCIAL_SOURCES, '');
  assert.deepEqual(
    adoptLegacyBrandEnv({}, { warn: (m) => warnings.push(m) }),
    [],
  );
  assert.deepEqual(warnings, []);
});

test('turning a switch off under the new name also retires the old line', () => {
  const dotenv = 'GOOGLE_MAPS_API_KEY=x\nSKYNET_NONCOMMERCIAL_SOURCES=1\n';
  const updates = withLegacyRetired({ SPECTRE_NONCOMMERCIAL_SOURCES: null });
  assert.deepEqual(updates, {
    SPECTRE_NONCOMMERCIAL_SOURCES: null,
    SKYNET_NONCOMMERCIAL_SOURCES: null,
  });
  const written = upsertDotenvValues(dotenv, updates);
  assert.equal(
    written,
    'GOOGLE_MAPS_API_KEY=x\n# SKYNET_NONCOMMERCIAL_SOURCES=\n',
  );
  const env = Object.fromEntries(
    written
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split('=')),
  );
  adoptLegacyBrandEnv(env, { warn() {} });
  assert.equal(env.SPECTRE_NONCOMMERCIAL_SOURCES, undefined, 'stays off');
});

test('turning it on writes the new name and comments out the old one', () => {
  const written = upsertDotenvValues(
    'SKYNET_NONCOMMERCIAL_SOURCES=1\n',
    withLegacyRetired({ SPECTRE_NONCOMMERCIAL_SOURCES: '1' }),
  );
  assert.match(written, /^# SKYNET_NONCOMMERCIAL_SOURCES=$/m);
  assert.match(written, /^SPECTRE_NONCOMMERCIAL_SOURCES=1$/m);
});

test('name mapping is exact and leaves other names alone', () => {
  assert.equal(brandNameFor('SKYNET_VOICE'), 'SPECTRE_VOICE');
  assert.equal(legacyNameFor('SPECTRE_VOICE'), 'SKYNET_VOICE');
  assert.equal(brandNameFor('GEV_ALLOWED_HOSTS'), null);
  assert.equal(legacyNameFor('OLLAMA_HOST'), null);
  assert.deepEqual(withLegacyRetired({ OLLAMA_HOST: 'x' }), {
    OLLAMA_HOST: 'x',
  });
});
