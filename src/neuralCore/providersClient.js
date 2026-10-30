/**
 * SPECTRE Neural Core: the browser side of /api/intel/providers (ADR-002 D5).
 * Transport only, no DOM.
 *
 * Every write carries the session token the intel service issued at start-up.
 * It is kept in memory only, never in browser storage; a restarted service
 * issues a new one, so a write refused with `session_required` fetches it
 * again and retries once. Keys go out in a request body and never come back.
 */
import { failure } from './client.js';

const BASE = '/api/intel/providers';

/** @param {{fetchImpl?: typeof fetch}} [options] */
export function createProvidersClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  let token = null;

  async function read(path) {
    const response = await fetchImpl(`${BASE}${path}`, { cache: 'no-store' });
    if (!response.ok) throw await failure(response);
    return response.json();
  }

  async function write(path, method, body) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!token) token = (await read('/session')).token;
      const headers = { 'X-Spectre-Session': token };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetchImpl(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.ok) return response.status === 204 ? null : response.json();
      const error = await failure(response);
      if (error.code !== 'session_required' || attempt > 0) throw error;
      token = null; // the service restarted: ask for the new token once
    }
    return null;
  }

  return {
    list: () => read(''),
    models: (id) => read(`/${encodeURIComponent(id)}/models`),
    gpu: () => read('/ollama/gpu'),
    setKey: (id, key) =>
      write(`/${encodeURIComponent(id)}/key`, 'PUT', { key }),
    removeKey: (id) => write(`/${encodeURIComponent(id)}/key`, 'DELETE'),
    saveSettings: (id, settings) =>
      write(`/${encodeURIComponent(id)}/settings`, 'PUT', settings),
    setConsent: (id, granted) =>
      write(`/${encodeURIComponent(id)}/consent`, 'PUT', { granted }),
    setPolicy: (policy) => write('/policy', 'PUT', policy),
    select: (provider, model) =>
      write('/selection', 'PUT', { provider, model }),
    test: (id) => write(`/${encodeURIComponent(id)}/test`, 'POST', {}),
    probe: (id, model) =>
      write(`/${encodeURIComponent(id)}/probe`, 'POST', { model }),
    continueBudget: () => write('/budget/continue', 'POST', {}),
  };
}
