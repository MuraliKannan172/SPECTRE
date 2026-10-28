/**
 * SPECTRE services for `npm run doctor` (ADR-001 phase 6): the intel service,
 * Ollama and the chat model, web search, local voice, GPU memory, and whether
 * any local service listens on this machine's network address.
 *
 * Informational only: it never changes the setup report's `ready` or the exit
 * code, so CI, which runs none of these services, still passes. Every probe
 * has a short timeout.
 */
import net from 'node:net';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const DEFAULT_INTEL = 'http://127.0.0.1:8100';
const PROBE_MS = 2000;
const PORT_PROBE_MS = 800;
const LOCAL_PORTS = Object.freeze([
  { name: 'the web app (Vite)', port: 4173 },
  { name: 'the intel service', port: 8100 },
  { name: 'Ollama', port: 11434 },
]);

/** OLLAMA_HOST as Ollama accepts it (host:port, a bind address or a URL) as a URL to call. */
export function ollamaUrl(value = '') {
  let text = String(value || '')
    .trim()
    .replace(/\/+$/, '');
  if (!text) return 'http://127.0.0.1:11434';
  if (!text.includes('://')) text = `http://${text}`;
  const [scheme, rest] = text.split('://');
  let [host, port = ''] = rest.split(/:(?=\d+$)/);
  if (['0.0.0.0', '', '[::]'].includes(host)) host = '127.0.0.1';
  return `${scheme}://${host}:${port || '11434'}`;
}

async function getJson(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** GPU name and memory from nvidia-smi, or null where there is none. */
export function nvidiaGpus(run = spawnSync) {
  const result = run(
    'nvidia-smi',
    [
      '--query-gpu=name,memory.total,memory.used',
      '--format=csv,noheader,nounits',
    ],
    { encoding: 'utf8', timeout: 3000, windowsHide: true },
  );
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, total, used] = line.split(',').map((part) => part.trim());
      return { name, totalMib: Number(total), usedMib: Number(used) };
    });
}

/** This machine's non-loopback IPv4 addresses (at most three). */
export function networkAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const entries of Object.values(interfaces || {}))
    for (const entry of entries || [])
      if (
        entry.family === 'IPv4' &&
        !entry.internal &&
        !entry.address.startsWith('169.254.')
      )
        out.push(entry.address);
  return out.slice(0, 3);
}

function canConnect(host, port, timeoutMs = PORT_PROBE_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Local services that also answer on a network address, not only on loopback. */
export async function exposedServices({
  addresses = networkAddresses(),
  probe = canConnect,
} = {}) {
  const found = [];
  await Promise.all(
    LOCAL_PORTS.map(async ({ name, port }) => {
      for (const address of addresses) {
        if (await probe(address, port)) {
          found.push({ name, port, address });
          return;
        }
      }
    }),
  );
  return found.sort((a, b) => a.port - b.port);
}

/**
 * @param {{readEnv?: (name: string) => string, fetchImpl?: typeof fetch,
 *   gpus?: () => any, exposure?: () => Promise<any[]>, timeoutMs?: number}} [options]
 */
export async function inspectServices({
  readEnv = (name) => process.env[name] || '',
  fetchImpl = (...args) => globalThis.fetch(...args),
  gpus = nvidiaGpus,
  exposure = exposedServices,
  timeoutMs = PROBE_MS,
} = {}) {
  const intelUrl = String(
    readEnv('SPECTRE_INTEL_URL') || DEFAULT_INTEL,
  ).replace(/\/+$/, '');
  const services = {
    intel: { url: intelUrl, reachable: false, state: null, stories: null },
    chat: null,
    ollama: {
      url: ollamaUrl(readEnv('OLLAMA_HOST')),
      reachable: false,
      version: null,
    },
    voice: null,
    gpus: null,
    exposed: [],
  };
  const [health, chat, voice, version, exposed] = await Promise.allSettled([
    getJson(fetchImpl, `${intelUrl}/api/intel/health`, timeoutMs),
    getJson(fetchImpl, `${intelUrl}/api/intel/chat/status`, timeoutMs),
    getJson(fetchImpl, `${intelUrl}/api/intel/voice/status`, timeoutMs),
    getJson(fetchImpl, `${services.ollama.url}/api/version`, timeoutMs),
    exposure(),
  ]);
  if (health.status === 'fulfilled') {
    services.intel.reachable = true;
    services.intel.state = health.value?.freshness?.state ?? null;
    services.intel.stories = health.value?.stories ?? null;
  }
  if (chat.status === 'fulfilled') services.chat = chat.value;
  if (voice.status === 'fulfilled') services.voice = voice.value;
  if (version.status === 'fulfilled') {
    services.ollama.reachable = true;
    services.ollama.version = version.value?.version ?? null;
  }
  if (exposed.status === 'fulfilled') services.exposed = exposed.value;
  try {
    services.gpus = gpus();
  } catch {
    services.gpus = null;
  }
  return services;
}

const gb = (bytes) => (bytes / 1e9).toFixed(1);

/** The services as report lines; [OK], [WARN] or [--] like the setup report. */
export function formatServicesReport(services) {
  const lines = ['SPECTRE services (information only):'];
  const add = (level, text) => lines.push(`  [${level}] ${text}`);
  const { intel, chat, ollama, voice } = services;

  if (intel.reachable)
    add(
      intel.state === 'live' ? 'OK' : 'WARN',
      `Intel service at ${intel.url}: news ${intel.state ?? 'state unknown'}, ${intel.stories ?? '?'} stories`,
    );
  else
    add(
      'WARN',
      `Intel service not running at ${intel.url}: start it with .\\scripts\\spectre.ps1`,
    );

  const ollamaUp = chat ? chat.ollama?.reachable : ollama.reachable;
  const version = chat?.ollama?.version ?? ollama.version;
  if (!ollamaUp)
    add('WARN', `Ollama not reachable at ${ollama.url}: start the Ollama app`);
  else if (!chat)
    add(
      'OK',
      `Ollama ${version} reachable (start the intel service to check the model)`,
    );
  else if (chat.model_present === false)
    add(
      'WARN',
      `Ollama ${version}; model ${chat.model} is not installed: run ollama pull ${chat.model}`,
    );
  else
    add(
      chat.tools === false ? 'WARN' : 'OK',
      `Ollama ${version}; model ${chat.model}${chat.tools === false ? ' has no native tool calling (degraded)' : ' with tool calling'}`,
    );
  if (chat?.loaded) {
    const { size, size_vram: vram } = chat.loaded;
    add('OK', `Model loaded: ${gb(size)} GB, ${gb(vram)} GB of it on the GPU`);
  } else if (chat && ollamaUp)
    add('--', 'Model not loaded yet (the first answer loads it)');

  if (chat?.search) {
    const search = chat.search;
    if (!search.configured) add('WARN', `Web search off: ${search.problem}`);
    else
      add(
        'OK',
        `Web search: ${search.provider}${search.best_effort ? ' (keyless, best effort)' : ''}${search.last_error ? `; last error: ${search.last_error}` : ''}`,
      );
  }

  if (voice) {
    if (voice.state === 'ready')
      add(
        'OK',
        `Local voice ready (${voice.stt?.model}, Kokoro voice ${voice.tts?.voice})`,
      );
    else if (voice.state === 'unavailable')
      add(
        '--',
        voice.reason === 'disabled'
          ? 'Local voice turned off (SPECTRE_VOICE=0)'
          : 'Local voice not set up (optional): .\\scripts\\spectre.ps1 -Voice',
      );
    else if (voice.state === 'failed')
      add('WARN', `Local voice failed to load: ${voice.error}`);
    else add('--', `Local voice ${voice.state}`);
  }

  if (services.gpus?.length)
    for (const gpu of services.gpus)
      add(
        'OK',
        `GPU: ${gpu.name}, ${gpu.usedMib} of ${gpu.totalMib} MiB in use`,
      );
  else
    add(
      '--',
      'GPU memory: nvidia-smi not found (no NVIDIA GPU, or no driver tools)',
    );

  for (const item of services.exposed)
    add(
      'WARN',
      `${item.name} answers on your network address ${item.address}:${item.port}, not only on this computer; other machines may reach it unless a firewall blocks them`,
    );
  if (!services.exposed.length)
    add('OK', 'No SPECTRE or Ollama port answers on your network address');
  return lines.join('\n');
}
