# Feed verification

Run 2026-10-24 18:26 UTC by `intel/scripts/verify_feeds.py` from this machine: 38 of 51 sources pass.
A source passes on HTTP 200, a parse, at least one item, and a newest item under 90 days old.

| Source | Terms | Result | HTTP | Items | Newest item | Reason |
|---|---|---|---|---|---|---|
| `usgs-quakes-significant` | open | pass | 200 | 18 | 2026-10-24 |  |
| `nhc-atlantic` | open | pass | 200 | 2 | 2026-10-24 |  |
| `nhc-east-pacific` | open | pass | 200 | 7 | 2026-10-24 |  |
| `tsunami-ptwc` | open | **fail** | 200 | 0 |  | no usable items |
| `gdacs` | personal | pass | 200 | 334 | 2026-10-24 |  |
| `reliefweb-disasters` | personal | **fail** | 202 | 0 |  | HTTP 202 |
| `reliefweb-updates` | personal | **fail** | 202 | 0 |  | HTTP 202 |
| `nasa-news` | open | pass | 200 | 10 | 2026-10-24 |  |
| `jpl-news` | open | **fail** | 403 | 0 |  | HTTP 403 |
| `nasa-earth-observatory` | open | **fail** | 200 | 0 |  | does not parse |
| `nsf-news` | open | pass | 200 | 15 | 2026-10-20 |  |
| `esa-top` | personal | pass | 200 | 9 | 2026-10-23 |  |
| `cisa-advisories` | open | **fail** | 403 | 0 |  | HTTP 403 |
| `cisa-news` | open | **fail** | 403 | 0 |  | HTTP 403 |
| `ncsc-news` | personal | pass | 200 | 20 | 2026-10-21 |  |
| `krebs` | personal | pass | 200 | 10 | 2026-10-21 |  |
| `bleepingcomputer` | personal | pass | 200 | 15 | 2026-10-24 |  |
| `nih-news` | open | **fail** | 403 | 0 |  | HTTP 403 |
| `who-news` | personal | pass | 200 | 108 | 2026-10-10 |  |
| `dod-news` | open | pass | 200 | 10 | 2026-10-23 |  |
| `state-dept-press` | open | **fail** | 403 | 0 |  | HTTP 403 |
| `govuk-mod` | open | pass | 200 | 20 | 2026-10-23 |  |
| `govuk-fcdo` | open | pass | 200 | 20 | 2026-10-24 |  |
| `ec-press` | open | pass | 200 | 10 | 2026-10-23 |  |
| `fed-press` | open | pass | 200 | 20 | 2026-10-16 |  |
| `bls-latest` | open | pass | 200 | 1 | 2026-10-20 |  |
| `un-news` | personal | pass | 200 | 30 | 2026-10-23 |  |
| `un-news-africa` | personal | pass | 200 | 30 | 2026-10-23 |  |
| `un-news-middle-east` | personal | pass | 200 | 30 | 2026-10-23 |  |
| `un-news-asia-pacific` | personal | pass | 200 | 30 | 2026-10-21 |  |
| `un-news-europe` | personal | pass | 200 | 30 | 2026-10-22 |  |
| `un-news-americas` | personal | pass | 200 | 30 | 2026-10-19 |  |
| `bbc-world` | personal | pass | 200 | 30 | 2026-10-24 |  |
| `bbc-africa` | personal | pass | 200 | 33 | 2026-10-24 |  |
| `bbc-asia` | personal | pass | 200 | 17 | 2026-10-24 |  |
| `bbc-europe` | personal | pass | 200 | 22 | 2026-10-24 |  |
| `bbc-middle-east` | personal | pass | 200 | 23 | 2026-10-24 |  |
| `bbc-latin-america` | personal | pass | 200 | 17 | 2026-10-24 |  |
| `aljazeera` | personal | pass | 200 | 25 | 2026-10-24 |  |
| `guardian-world` | personal | pass | 200 | 45 | 2026-10-24 |  |
| `npr-world` | personal | pass | 200 | 10 | 2026-10-24 |  |
| `dw-world` | personal | pass | 200 | 11 | 2026-10-24 |  |
| `france24` | personal | pass | 200 | 24 | 2026-10-24 |  |
| `cbc-world` | personal | pass | 200 | 20 | 2026-10-24 |  |
| `abc-au-world` | personal | pass | 200 | 25 | 2026-10-24 |  |
| `defense-news` | personal | pass | 200 | 10 | 2026-10-23 |  |
| `spacenews` | personal | pass | 200 | 12 | 2026-10-23 |  |
| `gdelt-disasters` | open | **fail** | 429 | 0 |  | HTTP 429 |
| `gdelt-conflict` | open | **fail** | 429 | 0 |  | HTTP 429 |
| `gdelt-cyber` | open | **fail** | 429 | 0 |  | HTTP 429 |
| `gdelt-health` | open | **fail** | 429 | 0 |  | HTTP 429 |
