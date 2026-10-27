#!/usr/bin/env node
/**
 * Write the client half of shared/tools/neural-core.tools.json from
 * src/tools/registry.js, keeping the server half as it is (the intel service
 * writes that half: `uv run --project intel python intel/scripts/export_tools.py`).
 * Both halves live in one committed file so the intel service, the browser
 * and their tests read one source of truth.
 *
 * Usage: npm run tools:export            write the client half
 *        npm run tools:export -- --check  exit 1 if the file is out of date
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neuralCoreClientTools } from '../src/tools/registry.js';

export const ARTIFACT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'shared',
  'tools',
  'neural-core.tools.json',
);

/** The artifact text for the current registry and a given server half. */
export function renderArtifact(server = []) {
  const artifact = { version: 1, client: neuralCoreClientTools(), server };
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function readServerHalf() {
  try {
    const current = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
    return Array.isArray(current.server) ? current.server : [];
  } catch {
    return [];
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  const next = renderArtifact(readServerHalf());
  const current = fs.existsSync(ARTIFACT_PATH)
    ? fs.readFileSync(ARTIFACT_PATH, 'utf8')
    : '';
  if (process.argv.includes('--check')) {
    if (current !== next) {
      console.error(
        `${ARTIFACT_PATH} is out of date: run npm run tools:export`,
      );
      process.exitCode = 1;
    } else console.log('neural-core tool artifact is current');
  } else {
    fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
    fs.writeFileSync(ARTIFACT_PATH, next);
    console.log(`wrote ${path.relative(process.cwd(), ARTIFACT_PATH)}`);
  }
}
