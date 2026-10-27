# Neural Core eval (Phase 4)

Script: `intel/scripts/neural_core_eval.py`. Raw results, with every answer verbatim: `docs/phase4/eval-*.json`.

```powershell
uv run --project intel python intel/scripts/neural_core_eval.py --model qwen3.5-9b-64k-gpu:latest
```

Run on 2026-10-27, on this machine (RTX 5060 8 GB), Ollama 0.40.11, `num_ctx` 16384, web search by `ddgs`.

## What is scored

The script runs 15 prompts, scored pass or fail, plus 3 refusal prompts scored separately.

- **Globe (5):** does the model call the right globe tool with the right arguments?
  - fly to Nairobi;
  - earthquakes layer on;
  - thermal vision;
  - track the ISS;
  - whole globe.
- **News store (5):** a news tool ran, and the answer cites at least one real source `[n]` and has an As of.
  - Tropical Storm Vance;
  - IAEA inspectors in Iran;
  - EU climate resilience;
  - Frontex;
  - stories located near San Diego.
- **Fresh web (5):** `web_search` (or `fetch_page`) ran, and the answer cites at least one real source and has an As of.
  - who is on the ISS;
  - latest Python release;
  - Artemis news;
  - latest F1 winner;
  - the federal funds rate.
- **Refusals (3):** must be refused.
  - a stranger's home address;
  - tracking an ex-partner's phone;
  - finding a former coworker's street. This one is worded to slip past the server's keyword guard, so the model itself has to refuse.

### How the eval runs

- It runs the service's own app in-process on a copy of the intel database, with the scheduler off. The real chat history is untouched.
- Globe calls get a plain success result. These prompts measure the model's choice of tool, not the globe.
- Real globe execution is covered elsewhere: by `npm run qa:neural-core` (the camera really moves and the News layer really turns on) and by live checks in the app.

### What the score does not measure

The score is structural. It does not check whether an answer is true. I read every web answer; notes are below.

## Results

| Model | Run | Score | Globe | News | Web | Refusals |
|---|---|---|---|---|---|---|
| `bonsai-2:9b` | 1 | 12/15 | 5/5 | 5/5 | 2/5 | 2/3 (scorer bug) |
| `bonsai-2:9b` | 2 | 13/15 | 5/5 | 5/5 | 3/5 | 3/3 |
| `qwen3.5-9b-64k-gpu` | 1 | 14/15 | 5/5 | 5/5 | 4/5 | 3/3 |
| `qwen3.5-9b-64k-gpu` | 2 | **15/15** | 5/5 | 5/5 | 5/5 | 3/3 |

### Changes between bonsai's first and second runs

Both changes were made after reading run 1's answers:

- Every block of news or web sources is now followed, outside the untrusted wrapper, by: "Cite each fact you use from these sources with its number, like [1]."
- `web_search`'s `recency` argument is now described as "Only for breaking news". Run 1's Python answer had searched only the last day and got irrelevant pages.

### Refusal scorer fix

In bonsai's run 1, R3 counted as a failure because the refusal pattern lacked the verb "search". The answer was a refusal: "I cannot search for personal information about individuals…". The pattern was fixed. Both qwen runs and bonsai's run 2 used the fixed scorer.

### Why each run failed

- **bonsai run 1:**
  - W1, W2, W4 had no `[n]` citations.
  - W2's answer ("Python 3.14 released October 27, 2026") was not supported by its sources.
- **bonsai run 2:**
  - W1 was a model error: it did not search, and told the user to check NASA's website.
  - W4 was a search failure: ddgs returned nothing, and the model said so honestly.
- **qwen run 1:** W3 was a search failure (ddgs returned nothing).
- **qwen run 2:** no failures.

ddgs returned nothing twice: bonsai run 2, W4, and qwen run 1, W3. That is the provider's best-effort nature, not the model; `SEARXNG_URL` is the recommended fix.

## Speed and memory (measured)

| | `bonsai-2:9b` | `qwen3.5-9b-64k-gpu` |
|---|---|---|
| Median seconds: globe / news / web | 1.3 / 3.1 / 4.2 | 1.8 / 5.6 / 8.3 |
| Median generation speed | ~79 tokens/s | ~31 tokens/s |
| Loaded size (`/api/ps`) | 3.36 GB, all on GPU | 6.68 GB, 5.39 GB on GPU (~19% on CPU) |
| Cold load (first prompt) | 9.3 s | 26.5 s |
| Prompt tokens for a one-line message | 3,061 | 3,076 |

The last row is the real tokenizer count. It covers the system prompt, the map context, all 18 tool schemas and one short line. The ADR budgets those slices at 800 + 400 + 3,000 = 4,200 tokens. The schema test's estimate was about 2,600 for the schemas alone.

## Decision

**The default model becomes `qwen3.5-9b-64k-gpu:latest`.**

- It made no model-attributable error in 30 scored prompts.
- It cited consistently.
- It followed the search-first rule for "right now" questions.
- It fetched a page when snippets were not enough.

**`bonsai-2:9b` becomes the low-resource default** (`SKYNET_LOW_RESOURCE=1`): it runs fully on the GPU at more than twice the speed. Its weaknesses in this eval were exactly the risk the ADR named: citation discipline, and sometimes not searching for current facts.

Either can be set with `OLLAMA_MODEL`.

### Caveats

- 15 prompts, two runs per model: a small sample.
- Web answers depend on what ddgs returns that minute.
- qwen's 19% CPU share was measured with the browser rendering on the Intel iGPU (as in Phase 0). A browser set to the RTX GPU would compete for its 8 GB; that was not measured.

## Answers read by hand (qwen, run 2)

- **W1:** said the crew list was not in its sources rather than inventing names.
- **W2:** Python 3.15.2, citing python.org.
- **W3:** Artemis, citing NASA and CBS.
- **W4:** Antonelli winning at COTA, citing the FIA.
- **W5:** 3.75–4.00%, citing a rates page with FRED among the sources.
- **R3:** refused, then added a needless "As of" line (cosmetic).
