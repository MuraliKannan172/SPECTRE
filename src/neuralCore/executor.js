/**
 * SKYNET Neural Core: run one globe tool the model asked for, in the browser.
 *
 * Only tools in the shared registry run, and only with arguments that match
 * their schema (the intel service has already checked both; this is the second
 * check, on the side that acts). Calls go through the same runner voice uses,
 * so the model gets exactly the app's own behaviour.
 */
import {
  NEURAL_CORE_CLIENT_TOOL_NAMES,
  neuralCoreClientTools,
} from '../tools/registry.js';
import { validateValue } from '../tools/schema.js';

export const CLIENT_TOOL_TIMEOUT_MS = 14_000; // the service waits 15 s
const MAX_RESULT_CHARS = 8_000;

const SCHEMAS = new Map(
  neuralCoreClientTools().map((tool) => [
    tool.function.name,
    tool.function.parameters,
  ]),
);

/** A JSON-safe copy of a runner result, at most MAX_RESULT_CHARS long. */
export function plainResult(value) {
  const seen = new WeakSet();
  let text;
  try {
    text = JSON.stringify(value ?? null, (_key, item) => {
      if (typeof item === 'function' || typeof item === 'symbol')
        return undefined;
      if (typeof item === 'bigint') return String(item);
      if (item && typeof item === 'object') {
        if (seen.has(item)) return undefined;
        seen.add(item);
        const proto = Object.getPrototypeOf(item);
        if (proto && proto !== Object.prototype && !Array.isArray(item))
          return undefined; // class instances (Cesium, DOM) are not data
      }
      return item;
    });
  } catch {
    return { summary: 'done' };
  }
  if (text === undefined) return null;
  if (text.length <= MAX_RESULT_CHARS) return JSON.parse(text);
  return { truncated: true, text: text.slice(0, MAX_RESULT_CHARS) };
}

/**
 * @param {{runner: (name: string, args: object, options: {signal: AbortSignal}) => Promise<any>,
 *   timeoutMs?: number}} options
 * @returns {(name: string, args: object) => Promise<{ok: boolean, result?: any, error?: string}>}
 */
export function createClientToolExecutor({
  runner,
  timeoutMs = CLIENT_TOOL_TIMEOUT_MS,
}) {
  return async function execute(name, args) {
    if (!NEURAL_CORE_CLIENT_TOOL_NAMES.includes(name))
      return { ok: false, error: `not a globe tool: ${String(name)}` };
    const problems = validateValue(SCHEMAS.get(name), args);
    if (problems.length)
      return { ok: false, error: problems.slice(0, 3).join('; ') };
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('the globe did not finish in time'));
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([
        runner(name, args, { signal: controller.signal }),
        timeout,
      ]);
      return { ok: true, result: plainResult(result) };
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error).slice(0, 300),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
