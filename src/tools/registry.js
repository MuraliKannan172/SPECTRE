/**
 * SPECTRE Neural Core: the globe tools the local chat model may call (ADR-001
 * D5). They run in the browser through the voice runner, which handles both
 * app actions and catalog tools; this module only chooses the subset and
 * words it briefly so it fits a small model's context. Argument schemas are
 * upstream's, minus the arguments named in PRUNED (pointer and voice-session
 * details a chat turn cannot supply).
 *
 * Pure data, safe in the browser and in Node. `npm run tools:export` writes
 * it into shared/tools/neural-core.tools.json, which the intel service reads
 * to allowlist the client tools it relays.
 */
import { createActionTools } from '../voice/actionSchemas.js';
import { getEarthquakes } from './queries/hazards.js';

/** Model-facing wording for each action the Neural Core exposes, in order. */
const ACTION_WORDING = Object.freeze({
  fly_to_location: {
    description:
      'Fly the camera to a place by name (query) or to latitude/longitude. Omit rangeM for automatic framing.',
    parameters: {
      properties: {
        query: { description: 'Place name, e.g. "Tokyo" or "Suez Canal".' },
        viewMode: {
          description: 'close for a landmark, overview for a region.',
        },
        rangeM: { description: 'Camera distance in metres.' },
      },
    },
  },
  adjust_camera_zoom: { description: 'Zoom the camera in or out.' },
  zoom_to_globe: { description: 'Reset the view to the whole globe.' },
  set_layer_visibility: {
    description: 'Turn one map data layer on or off.',
  },
  set_map_stack: { description: 'Change the base map imagery.' },
  set_visual_style: {
    description:
      'Change the visual style or sensor look (e.g. thermal, surveillance, noir).',
  },
  track_entity: {
    description:
      'Find a flight, ship or satellite by name, callsign or ID and follow it with the camera.',
  },
  stop_tracking: { description: 'Stop following the tracked object.' },
  annotate_map: {
    description:
      'Draw pins, labels, areas, arrows or routes on the map at named places or coordinates.',
  },
  clear_annotations: { description: 'Remove all drawn annotations.' },
  next_satellite_pass: {
    description:
      'When a satellite (e.g. ISS) next passes over a point; defaults to the view centre.',
  },
});

/** Upstream arguments a chat turn cannot use: pointer referents, voice waits. */
const PRUNED = Object.freeze({
  fly_to_location: ['locationId', 'waitForArrival', 'referent'],
  track_entity: ['referent'],
});

/**
 * SPECTRE layers the Neural Core may toggle. They stay out of the upstream voice
 * enums (VOICE_OFF_LAYERS), whose prompt sits at its size budget; the runner
 * toggles any registered layer id, so only this copy of the enum names them.
 */
const NEURAL_CORE_EXTRA_LAYERS = Object.freeze(['news', 'natural-events']);

/** Catalog queries the Neural Core exposes, with their own wording. */
const CATALOG_TOOLS = Object.freeze([getEarthquakes]);

function prune(parameters, names = []) {
  const result = structuredClone(parameters);
  for (const name of names) delete result.properties?.[name];
  if (Array.isArray(result.required))
    result.required = result.required.filter((name) => !names.includes(name));
  return result;
}

/** One tool in Ollama's function format. */
function ollamaTool(name, description, parameters) {
  return { type: 'function', function: { name, description, parameters } };
}

/**
 * The client half of the Neural Core tool artifact, in a fixed order.
 * @returns {Array<{type: 'function', function: {name: string, description: string, parameters: object}}>}
 */
export function neuralCoreClientTools() {
  const actions = new Map(
    createActionTools(ACTION_WORDING).map((tool) => [tool.name, tool]),
  );
  const tools = Object.keys(ACTION_WORDING).map((name) => {
    const tool = actions.get(name);
    const parameters = prune(tool.parameters, PRUNED[name]);
    // track_entity's either-query-or-referent rule becomes "query required".
    if (name === 'track_entity') parameters.required = ['query'];
    if (name === 'set_layer_visibility') {
      const layerId = parameters.properties.layerId;
      layerId.enum = [...layerId.enum, ...NEURAL_CORE_EXTRA_LAYERS];
    }
    return ollamaTool(name, tool.description, parameters);
  });
  for (const tool of CATALOG_TOOLS)
    tools.push(
      ollamaTool(
        tool.name,
        tool.description,
        structuredClone(tool.inputSchema),
      ),
    );
  return tools;
}

/** Names the browser will run for the model; anything else is refused. */
export const NEURAL_CORE_CLIENT_TOOL_NAMES = Object.freeze([
  ...Object.keys(ACTION_WORDING),
  ...CATALOG_TOOLS.map((tool) => tool.name),
]);
