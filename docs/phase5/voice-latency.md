# Local voice latency (Phase 5)

Measured on 2026-10-28 on this machine: Intel Core Ultra 9 275HX (24 cores), 16 GB RAM, RTX 5060 Laptop GPU (8 GB). Raw results: [`voice-latency.json`](voice-latency.json).

```powershell
node scripts/bench-local-voice.mjs --runs 3 --clear-history --out docs/phase5/voice-latency.json
```

## Setup

| | |
|---|---|
| Chat model | `qwen3.5-9b-64k-gpu:latest` through Ollama 0.40.11, already loaded (a typed warm-up turn ran first) |
| Speech to text | faster-whisper `base`, int8, CPU, 8 threads, voice activity filter on |
| Text to speech | Kokoro-82M int8 ONNX, CPU, 8 threads, voice `af_heart` |
| Browser | Chrome (Puppeteer), headless with hardware WebGL: ANGLE on the Intel iGPU (Direct3D 11), as in the Phase 4 eval |
| Microphone | Chrome's fake capture device, fed a WAV of each question in the service's own Kokoro voice, followed by 1.5 s of silence |
| Each run | The bench holds the mic button for the question's length plus 0.4 s, releases it, and waits until the answer has been spoken. Chat history is cleared before every run, on a copy of the intel database. |

## Results

Seconds from releasing the mic button. Median of 3 runs, range in brackets.

| Question | Heard (upload + speech to text) | First answer token | First sentence sent to speech | **First word heard** |
|---|---|---|---|---|
| Globe: "Fly to Nairobi and turn on the earthquakes layer." | 1.12 (0.97–1.18) | 5.20 (5.04–6.43) | 5.74 (5.59–7.26) | **6.53 (6.38–8.63)** |
| News store: "What are the top news stories right now?" | 1.02 (1.01–1.17) | 3.52 (3.41–3.85) | 3.90 (3.79–4.20) | **4.67 (4.47–4.82)** |
| Web: "Who won the most recent Formula One race?" | 1.08 (1.05–1.33) | 7.89 (7.23–8.20) | 8.88 (8.33–9.51) | **11.21 (10.45–11.96)** |

| Question | Speech to text in the service | Text to speech of the first sentence | Generation speed, spoken / typed turns (tokens/s) |
|---|---|---|---|
| Globe | 1.11 (0.95–1.17) | 0.92 (0.63–1.35) | 26.4 / 26.3 |
| News store | 1.01 (0.99–1.15) | 0.65 (0.60–0.74) | 24.7 / 27.9 |
| Web | 1.07 (1.04–1.32) | 2.43 (1.55–2.85) | 26.3 / 24.7 |

- **Recording stop** was 3–12 ms in every run.
- **Every run worked end to end.**
  - Globe: each run flew the camera and switched the layer.
  - News store: each run searched the news store.
  - Web: each run searched the web.
  - All 9 transcripts were right. The web question came back as "who won the most recent Formula 1 race."
- **Speech did not slow the chat model.** Spoken and typed turns generated at the same speed within run-to-run noise. Kokoro and Whisper run on CPU threads while qwen's offloaded layers also use the CPU.

## Where the time goes

- **Speech to text is about 1 s for a 2–3 s question.** That is almost all of "Heard"; upload and decoding are negligible. whisper `small` took 2.1 s for the same kind of clip in the design probe, with no accuracy gain on the test clips, so `base` is the default.
- **The model is most of the wait.**
  - Globe questions wait for the tool round trip, about 4 s from transcript to first token.
  - Web questions wait for the search, about 7 s.
  - News questions are quickest, about 2.5 s.
- **Speaking the first sentence costs 0.6–2.4 s.** It grows with the sentence's length, and web answers open with long sentences. A shorter first chunk (cut at the first comma) would start speech sooner. It is not done yet.

## Limits of this measurement

- **The questions are synthetic speech** (Kokoro reading the question), not a person at a microphone. Real speech, accents and room noise will be harder for whisper `base`.
- **Answers are English only.** Spoken replies are English only, so a question detected as another language is answered in text with a note.
- **Each phase was timed once per run, with 3 runs per question.** It is a small sample, and web timings depend on what the search returns that minute.
- **Cold start is not included.**
  - The voice engines load in 1.6–4 s when the service starts, in the background; requests get `503 voice_loading` until then.
  - qwen's cold load (26.5 s in Phase 4) was taken by the warm-up turn.
- **A browser on the RTX GPU was not measured.** The browser drew on the Intel iGPU; one on the RTX would compete with qwen for its 8 GB.
