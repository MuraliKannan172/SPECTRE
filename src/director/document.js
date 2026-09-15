/** Bounded, renderer-independent validation for authored scene documents. */
export const SCENE_DOCUMENT_VERSION = 3;
export const SCENE_DOCUMENT_LIMITS = Object.freeze({
  bytes: 5 * 1024 * 1024,
  scenes: 256,
  shots: 10000,
  collection: 10000,
  depth: 24,
  nodes: 200000,
  string: 65536,
});

/** A project error identifies a field without echoing its supplied value. */
export class SceneDocumentError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.name = 'SceneDocumentError';
    this.path = path;
  }
}
const fail = (path, reason) => {
  throw new SceneDocumentError(path, reason);
};
const object = (value, path) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(path, 'expected an object');
};
function fields(value, path, allowed) {
  object(value, path);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'unsupported field');
  }
}
function string(value, path, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail(path, `expected nonempty text, at most ${max} characters`);
}
function number(value, path, min, max, legacy) {
  const numeric =
    legacy && typeof value === 'string' && value.trim() ? Number(value) : value;
  if (
    typeof numeric !== 'number' ||
    !Number.isFinite(numeric) ||
    numeric < min ||
    numeric > max
  )
    fail(path, `expected a number from ${min} to ${max}`);
}
function optional(value, key, path, check) {
  if (Object.hasOwn(value, key)) check(value[key], `${path}.${key}`);
}
function array(value, path, max = SCENE_DOCUMENT_LIMITS.collection) {
  if (!Array.isArray(value) || value.length > max)
    fail(path, `expected an array of at most ${max} entries`);
}
function ids(value, path) {
  array(value, path);
  value.forEach((id, index) => string(id, `${path}[${index}]`));
}
function uniqueId(value, path, seen) {
  if (!Object.hasOwn(value, 'id')) return; // Legacy omissions receive an ID once during migration.
  string(value.id, `${path}.id`);
  if (seen.has(value.id)) fail(`${path}.id`, 'duplicate ID');
  seen.add(value.id);
}
function jsonTree(value, path, budget, depth = 0) {
  if (
    ++budget.nodes > SCENE_DOCUMENT_LIMITS.nodes ||
    depth > SCENE_DOCUMENT_LIMITS.depth
  )
    fail(path, 'project complexity limit exceeded');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > SCENE_DOCUMENT_LIMITS.string)
      fail(path, 'text is too long');
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') fail(path, 'expected a JSON value');
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== null
  )
    fail(path, 'expected a JSON object');
  const entries = Object.entries(value);
  if (entries.length > SCENE_DOCUMENT_LIMITS.collection)
    fail(path, 'too many entries');
  for (const [key, child] of entries) {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      fail(path, 'unsafe object key');
    if (key.length > 256) fail(path, 'field name is too long');
    jsonTree(child, `${path}.${key}`, budget, depth + 1);
  }
}
function visual(value, path, legacy) {
  fields(value, path, [
    'style',
    'bloom',
    'sharpen',
    'hud',
    'detection',
    'scope',
    'mapStack',
    'styleParams',
  ]);
  for (const key of ['style', 'mapStack']) optional(value, key, path, string);
  optional(value, 'styleParams', path, object);
  const specs = {
    bloom: { enabled: 'boolean', intensity: [-100, 10000], version: [1, 100] },
    sharpen: { enabled: 'boolean', intensity: [0, 100] },
    hud: { visible: 'boolean', variant: 'string' },
    detection: {
      mode: 'string',
      density: [0, 100],
      allocation: 'string',
      fadePct: [0, 100],
      outsideOpacityPct: [0, 100],
    },
    scope: { enabled: 'boolean', featherPct: [0, 100] },
  };
  for (const [key, spec] of Object.entries(specs))
    optional(value, key, path, (entry, field) => {
      fields(entry, field, Object.keys(spec));
      for (const [name, type] of Object.entries(spec))
        optional(entry, name, field, (item, at) => {
          if (Array.isArray(type)) number(item, at, ...type, legacy);
          else if (type === 'string') string(item, at);
          else if (typeof item !== 'boolean') fail(at, 'expected a boolean');
        });
    });
}

/** Validate a parsed scene project without mutating it or applying any state. */
export function validateSceneDocument(project) {
  jsonTree(project, '$', { nodes: 0 });
  fields(project, '$', [
    'version',
    'createdAt',
    'updatedAt',
    'installedBuiltInSceneIds',
    'scenes',
  ]);
  const version = project.version ?? 1;
  if (![1, 2, 3].includes(version))
    fail('$.version', 'unsupported scene project version');
  const legacy = version < 3;
  for (const key of ['createdAt', 'updatedAt'])
    optional(project, key, '$', string);
  optional(project, 'installedBuiltInSceneIds', '$', ids);
  array(project.scenes, '$.scenes', SCENE_DOCUMENT_LIMITS.scenes);
  const sceneIds = new Set();
  let shotCount = 0;
  project.scenes.forEach((scene, index) => {
    const path = `$.scenes[${index}]`;
    fields(scene, path, [
      'id',
      'title',
      'releaseLayerIds',
      'appliedShotPacks',
      'shots',
    ]);
    uniqueId(scene, path, sceneIds);
    optional(scene, 'title', path, (v, p) => string(v, p, 4096));
    optional(scene, 'releaseLayerIds', path, ids);
    optional(scene, 'appliedShotPacks', path, (packs, field) => {
      array(packs, field);
      const packIds = new Set();
      packs.forEach((pack, i) => {
        const at = `${field}[${i}]`;
        fields(pack, at, ['id', 'version', 'shotBindings']);
        string(pack.id, `${at}.id`);
        uniqueId(pack, at, packIds);
        optional(pack, 'version', at, (v, p) =>
          number(v, p, 1, 1000000, legacy),
        );
        optional(pack, 'shotBindings', at, (bindings, p) => {
          object(bindings, p);
          for (const [title, id] of Object.entries(bindings))
            string(id, `${p}.${title}`);
        });
      });
    });
    array(scene.shots, `${path}.shots`);
    shotCount += scene.shots.length;
    if (shotCount > SCENE_DOCUMENT_LIMITS.shots)
      fail(`${path}.shots`, 'too many shots in project');
    const shotIds = new Set();
    scene.shots.forEach((shot, i) => {
      const at = `${path}.shots[${i}]`;
      fields(shot, at, [
        'id',
        'title',
        'durationSec',
        'holdSec',
        'camera',
        'visual',
        'layers',
        'sourcePackId',
        'sourcePackVersion',
      ]);
      uniqueId(shot, at, shotIds);
      optional(shot, 'title', at, (v, p) => string(v, p, 4096));
      optional(shot, 'sourcePackId', at, string);
      optional(shot, 'sourcePackVersion', at, (v, p) =>
        number(v, p, 1, 1000000, legacy),
      );
      optional(shot, 'durationSec', at, (v, p) =>
        number(v, p, 0, 86400, legacy),
      );
      optional(shot, 'holdSec', at, (v, p) => number(v, p, 0, 86400, legacy));
      optional(shot, 'camera', at, (camera, field) => {
        const bounds = {
          lat: [-90, 90],
          lon: [-180, 180],
          alt: [-12000, 1e9],
          heading: [-360, 360],
          pitch: [-90, 90],
          roll: [-360, 360],
        };
        fields(camera, field, Object.keys(bounds));
        for (const [key, range] of Object.entries(bounds))
          optional(camera, key, field, (v, p) =>
            number(v, p, ...range, legacy),
          );
      });
      optional(shot, 'visual', at, (v, p) => visual(v, p, legacy));
      optional(shot, 'layers', at, (layers, field) => {
        object(layers, field);
        for (const [id, entry] of Object.entries(layers)) {
          string(id, field);
          if (typeof entry === 'boolean') continue;
          const p = `${field}.${id}`;
          fields(entry, p, ['enabled', 'params']);
          if (typeof entry.enabled !== 'boolean')
            fail(`${p}.enabled`, 'expected a boolean');
          optional(entry, 'params', p, object);
        }
      });
    });
  });
  return project;
}

/** Read bounded JSON. No URLs, modules or actions are executed during import. */
export function parseSceneDocument(text) {
  if (
    typeof text !== 'string' ||
    text.length > SCENE_DOCUMENT_LIMITS.bytes ||
    new TextEncoder().encode(text).byteLength > SCENE_DOCUMENT_LIMITS.bytes
  )
    fail('$', 'file exceeds 5 MiB');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('$', 'invalid JSON');
  }
  return validateSceneDocument(parsed);
}

/** Export authored project fields only; callers pass the project, never run state. */
export function stringifySceneDocument(project) {
  // Round-trip drops optional undefined fields created by the editor.
  const text = JSON.stringify(project, null, 2);
  parseSceneDocument(text);
  return text;
}
