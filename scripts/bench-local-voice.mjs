#!/usr/bin/env node
/**
 * bench-local-voice.mjs — SPECTRE Phase 5: measured end-to-end latency of the
 * Neural Core's local voice on this machine (docs/ADR-001.md, phase 5).
 *
 * Needs the real stack: `npm run dev` (:4173), the intel service with local
 * voice ready (scripts\spectre.ps1 -Voice) and Ollama. Each question is first
 * spoken by the service's own Kokoro voice into a WAV file, padded with
 * silence, and fed to Chrome as its microphone; the bench then holds the mic
 * button for the clip's length and releases it, exactly as a person would.
 *
 * Timings come from the panel itself (data-voice-* on the answer), in
 * milliseconds from the button's release:
 *   recorded     the recording is ready to send
 *   heard        the transcript is back (upload + speech to text)
 *   firstToken   the first answer token arrives (after any tool rounds)
 *   firstSentence  the first whole sentence goes to text to speech
 *   firstAudio   the first sound of the answer starts playing
 *
 * --clear-history deletes the Neural Core chat history before every run so
 * runs start alike. Use it only with an intel service whose SPECTRE_INTEL_DB
 * is a copy: it deletes whatever conversation the service holds.
 *
 * Run:  node scripts/bench-local-voice.mjs [--runs 3] [--clear-history] [--headful]
 *         [--out docs/phase5/voice-latency.json]
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const APP_URL = option('--url', 'http://localhost:4173');
const RUNS = Number(option('--runs', '3'));
const OUT = option('--out', null);
const HEADFUL = argv.includes('--headful');
const CLEAR = argv.includes('--clear-history');
const TAIL_SILENCE_S = 1.5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROMPTS = [
  { id: 'globe', text: 'Fly to Nairobi and turn on the earthquakes layer.' },
  { id: 'news', text: 'What are the top news stories right now?' },
  { id: 'web', text: 'Who won the most recent Formula One race?' },
];
const STEPS = [
  'recorded',
  'heard',
  'firstToken',
  'firstSentence',
  'firstAudio',
];

async function api(pathname, init) {
  const response = await fetch(`${APP_URL}${pathname}`, init);
  if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status}`);
  return response;
}

/** The question in the service's own voice, with silence after it. */
async function questionClip(text, dir) {
  const response = await api('/api/intel/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const wav = Buffer.from(await response.arrayBuffer());
  const rate = wav.readUInt32LE(24);
  const blockAlign = wav.readUInt16LE(32);
  const pad = Buffer.alloc(Math.round(rate * TAIL_SILENCE_S) * blockAlign);
  const data = wav.subarray(44);
  const out = Buffer.concat([wav.subarray(0, 44), data, pad]);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(data.length + pad.length, 40);
  const file = path.join(
    dir,
    `${text.split(' ')[0].toLowerCase()}-${data.length}.wav`,
  );
  fs.writeFileSync(file, out);
  return {
    file,
    speechMs: Math.round((data.length / blockAlign / rate) * 1000),
  };
}

async function launch(clip) {
  const executablePath = await puppeteer.executablePath();
  return puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(executablePath && fs.existsSync(executablePath)
      ? { executablePath }
      : {}),
    args: [
      '--no-sandbox',
      '--window-size=1440,900',
      '--use-angle=d3d11',
      '--ignore-gpu-blocklist',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${clip}%noloop`,
    ],
  });
}

async function openPanel(page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.viewer &&
      document.querySelector('.spectre-nc-launcher'),
    { timeout: 120_000 },
  );
  await sleep(3000);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    if (document.getElementById('spectre-neural-core').hidden)
      document.querySelector('.spectre-nc-launcher').click();
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector('.spectre-nc-mic')
        ?.getAttribute('aria-disabled') === 'false',
    { timeout: 30_000 },
  );
}

function renderer(page) {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
}

async function clearHistory(page) {
  if (!CLEAR) return;
  await page.evaluate(() =>
    fetch('/api/intel/chat/history', { method: 'DELETE' }),
  );
  await page.evaluate(() =>
    document.querySelector('.spectre-nc-messages').replaceChildren(),
  );
}

/**
 * Wait until the last answer is finished and, for a spoken one, has started
 * speaking (or could not) and has stopped again.
 */
async function settle(page, { spoken = false, timeout = 150_000 } = {}) {
  await page.waitForFunction(
    (wantSpeech) => {
      const answer = document.querySelector('.is-assistant:last-child');
      const code =
        document.querySelector('.spectre-nc-voice')?.dataset.code || '';
      if (!answer || answer.querySelector('footer')?.hidden) return false;
      if (['speaking', 'transcribing', 'listening'].includes(code))
        return false;
      if (!wantSpeech) return true;
      const failed = answer.querySelector('.spectre-nc-error:not([hidden])');
      return Boolean(
        answer.dataset.voiceFirstAudioMs ||
        failed ||
        ['speech_failed', 'english_only', 'no_speech'].includes(code),
      );
    },
    { timeout, polling: 200 },
    spoken,
  );
}

async function spokenRun(page, clip) {
  const box = await (await page.$('.spectre-nc-mic')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // The fake microphone plays the clip from when it opens: hold from there.
  await page
    .waitForFunction(
      () =>
        document.querySelector('.spectre-nc-voice')?.dataset.code ===
        'listening',
      { timeout: 10_000 },
    )
    .catch(() => {});
  await sleep(clip.speechMs + 400);
  await page.mouse.up();
  await settle(page, { spoken: true });
  return page.evaluate(() => {
    const answer = document.querySelector('.is-assistant:last-child');
    const users = document.querySelectorAll('.is-user');
    const data = answer?.dataset || {};
    const number = (value) =>
      value === undefined || value === '' ? null : Number(value);
    return {
      transcript: users[users.length - 1]?.textContent || null,
      recorded: number(data.voiceRecordedMs),
      heard: number(data.voiceHeardMs),
      firstToken: number(data.voiceFirstTokenMs),
      firstSentence: number(data.voiceFirstSentenceMs),
      firstAudio: number(data.voiceFirstAudioMs),
      sttSeconds: number(data.voiceSttSeconds),
      ttsSeconds: number(data.voiceTtsSeconds),
      tools: [...(answer?.querySelectorAll('.spectre-nc-tool') || [])].map(
        (n) => n.textContent,
      ),
      error:
        answer?.querySelector('.spectre-nc-error:not([hidden])')?.textContent ||
        null,
      meta: answer?.querySelector('.spectre-nc-meta')?.textContent || '',
      answerChars:
        answer?.querySelector('.spectre-nc-text')?.textContent.length || 0,
    };
  });
}

async function typedRun(page, text) {
  await page.evaluate((question) => {
    const input = document.querySelector('.spectre-nc-input');
    input.value = question;
    document.querySelector('.spectre-nc-composer').requestSubmit();
  }, text);
  await sleep(500);
  await settle(page);
  return page.evaluate(
    () =>
      document.querySelector('.is-assistant:last-child .spectre-nc-meta')
        ?.textContent || '',
  );
}

const tokensPerSecond = (meta) =>
  Number(/([\d.]+) tokens\/s/.exec(meta)?.[1] ?? NaN);

function summary(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return {
    median: sorted[Math.floor((sorted.length - 1) / 2)],
    min: sorted[0],
    max: sorted.at(-1),
    n: sorted.length,
  };
}

async function main() {
  const voice = await (await api('/api/intel/voice/status')).json();
  if (voice.state !== 'ready')
    throw new Error(
      `local voice is ${voice.state} (${voice.reason || voice.error})`,
    );
  const chat = await (await api('/api/intel/chat/status')).json();
  if (!chat.ollama?.reachable) throw new Error('Ollama is not reachable');
  const dir = path.join(os.tmpdir(), 'spectre-voice-bench');
  if (/\s/.test(dir))
    throw new Error(
      `Chrome's fake microphone cannot read a path with spaces: ${dir}`,
    );
  fs.mkdirSync(dir, { recursive: true });

  const report = {
    when: new Date().toISOString(),
    host: {
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      ramGb: Math.round(os.totalmem() / 1e9),
    },
    model: chat.model,
    modelLoadedAtStart: Boolean(chat.loaded),
    voice: { stt: voice.stt, tts: voice.tts },
    headful: HEADFUL,
    prompts: [],
  };
  console.log(
    `model ${chat.model} (${chat.loaded ? 'loaded' : 'not loaded'}), ${RUNS} runs per question`,
  );

  for (const prompt of PROMPTS) {
    const clip = await questionClip(prompt.text, dir);
    const browser = await launch(clip.file);
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await openPanel(page);
      report.renderer ??= await renderer(page);
      await clearHistory(page);
      const warm = await typedRun(page, 'Say OK.'); // the model is loaded before timing
      const typed = [];
      const runs = [];
      for (let run = 0; run < RUNS; run += 1) {
        await clearHistory(page);
        const result = await spokenRun(page, clip);
        runs.push(result);
        console.log(
          `${prompt.id} #${run + 1}: first audio ${result.firstAudio} ms, heard ${result.heard} ms — "${result.transcript}"${result.error ? ` (${result.error})` : ''}`,
        );
        await clearHistory(page);
        typed.push(tokensPerSecond(await typedRun(page, prompt.text)));
      }
      report.prompts.push({
        ...prompt,
        clipSpeechMs: clip.speechMs,
        warmUp: warm,
        runs,
        typedTokensPerSecond: typed,
        summary: Object.fromEntries([
          ...STEPS.map((step) => [step, summary(runs.map((r) => r[step]))]),
          ['sttSeconds', summary(runs.map((r) => r.sttSeconds))],
          ['ttsSeconds', summary(runs.map((r) => r.ttsSeconds))],
          [
            'spokenTokensPerSecond',
            summary(runs.map((r) => tokensPerSecond(r.meta))),
          ],
          ['typedTokensPerSecond', summary(typed)],
        ]),
      });
    } finally {
      await browser.close();
    }
  }

  console.log(`\nrenderer: ${report.renderer}`);
  console.log(
    'question  first audio (median, min-max)  heard  first token  first sentence  STT s  TTS s  tok/s spoken/typed',
  );
  for (const p of report.prompts) {
    const s = p.summary;
    const ms = (x) => (x ? `${(x.median / 1000).toFixed(1)}` : '-');
    console.log(
      `${p.id.padEnd(8)}  ${ms(s.firstAudio)} s (${s.firstAudio ? `${(s.firstAudio.min / 1000).toFixed(1)}-${(s.firstAudio.max / 1000).toFixed(1)}` : '-'})` +
        `   ${ms(s.heard)}   ${ms(s.firstToken)}   ${ms(s.firstSentence)}   ${s.sttSeconds?.median ?? '-'}   ${s.ttsSeconds?.median ?? '-'}` +
        `   ${s.spokenTokensPerSecond?.median ?? '-'}/${s.typedTokensPerSecond?.median ?? '-'}`,
    );
  }
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${OUT}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
