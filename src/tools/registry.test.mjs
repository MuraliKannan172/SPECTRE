import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GEV_ACTION_SCHEMAS } from '../voice/actionSchemas.js';
import { coreTools } from './index.js';
import {
  NEURAL_CORE_CLIENT_TOOL_NAMES,
  neuralCoreClientTools,
} from './registry.js';
import { renderArtifact } from '../../scripts/export-neural-core-tools.mjs';

const ARTIFACT = new URL(
  '../../shared/tools/neural-core.tools.json',
  import.meta.url,
);
const artifact = () => JSON.parse(readFileSync(ARTIFACT, 'utf8'));

test('the committed artifact matches the registry (npm run tools:export)', () => {
  const text = readFileSync(ARTIFACT, 'utf8');
  assert.equal(text, renderArtifact(artifact().server));
});

test('every client tool is one the browser runner can run', () => {
  const actions = new Set(GEV_ACTION_SCHEMAS.map((schema) => schema.name));
  const catalog = new Set(coreTools.map((tool) => tool.name));
  const tools = neuralCoreClientTools();
  assert.deepEqual(
    tools.map((tool) => tool.function.name),
    [...NEURAL_CORE_CLIENT_TOOL_NAMES],
  );
  for (const tool of tools) {
    const { name, parameters, description } = tool.function;
    assert.ok(actions.has(name) || catalog.has(name), name);
    assert.equal(tool.type, 'function');
    assert.equal(parameters.type, 'object', name);
    assert.ok(description.length > 10 && description.length < 200, name);
    for (const combinator of ['anyOf', 'oneOf', 'allOf'])
      assert.ok(!(combinator in parameters), `${name} has ${combinator}`);
  }
});

test('chat-only arguments are pruned and the SPECTRE layers can be toggled', () => {
  const byName = Object.fromEntries(
    neuralCoreClientTools().map((tool) => [tool.function.name, tool.function]),
  );
  const fly = byName.fly_to_location.parameters.properties;
  assert.ok(!('referent' in fly) && !('waitForArrival' in fly));
  assert.deepEqual(byName.track_entity.parameters.required, ['query']);
  const layers = byName.set_layer_visibility.parameters.properties.layerId.enum;
  assert.ok(layers.includes('news') && layers.includes('natural-events'));
});

test('client and server tool schemas fit the 3,000-token budget', () => {
  const { client, server } = artifact();
  assert.equal(server.length, 6);
  // About 3.5 characters per token for JSON schemas; the eval measures the
  // real count through Ollama.
  const estimate = Math.ceil(
    JSON.stringify([...client, ...server]).length / 3.5,
  );
  assert.ok(estimate <= 3000, `about ${estimate} tokens`);
});
