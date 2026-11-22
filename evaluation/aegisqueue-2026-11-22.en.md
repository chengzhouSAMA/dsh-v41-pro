# AegisQueue: Official Scores and Strict Re-Review for Four Submissions

**Date**: 2026-11-22 路 [Index](README.en.md) 路 [涓枃](aegisqueue-2026-11-22.zh.md)

## The task pack

AegisQueue: a persistent queue with leases, idempotent receipts, durable replay, replica sync and streaming-decode boundaries.

- **v1**: 120 hidden behaviour groups, 100 points; reference implementation 120/120.
- **v2**: keeps the same 120 core groups (40 points) and adds 60 extension groups (60 points); reference 180/180.
- The starting project scores 34.147; pack acceptance passed 27/27; fingerprints and reference results are archived.

## Official scores (frozen grader)

| Submission label | Pack | Official /100 | Hidden groups | Public tests | New tests |
|---|---|---:|---:|---:|---:|
| dsv4.1 | v1 | **100.000** | 120/120 | 10/10 | 28/28 |
| dsv4.1 + plugin | v2 | **100.000** | 180/180 | 15/15 | 41/41 |
| gpt6 Astra | v1 | **100.000** | 120/120 | 10/10 | 44/44 |
| glm5.3flash | v2 | **96.952** | 177/180 | 15/15 | 31/31 |

The v1 and v2 percentage totals cannot be placed in one ranking: the two v1 submissions had no extension material, so extension is 鈥渘ot evaluated鈥? not zero.

Recomputed on the 120 core groups with v1 weights, the comparable core scores are **100.000 / 100.000 / 100.000 / 98.880**; GLM fails only K10, losing 1.120 at the original weight.

### Where GLM lost points

| Group | Deduction | Cause |
|---|---:|---|
| K10 | 0.448 | An earlier I/O failure poisons the instance, but an already queued append still executes |
| P07 | 0.900 | The second line in a chunk counts the previous, already completed line's bytes toward its line budget |
| P15 | 1.700 | Any split-chunk scenario triggers the same wrong line-length calculation |

**100.000 鈭?0.448 鈭?0.900 鈭?1.700 = 96.952.** The three failing groups trace to two code causes: queued callbacks do not re-check poison when they start, and line length uses `idx + 1` without subtracting the starting offset for later lines.

### A perfect score is not the absence of defects

An independent read-only diagnostic reproduced two contract gaps in the plugin submission that are **not part of the frozen 180 groups**. They do not change the official score, but they must be stated:

| Scenario | Contract | Plugin as measured |
|---|---|---|
| Producer `next` throws an Error carrying `E_LIMIT` | Normalise to `E_IO`, then await one `return` | Returns `E_LIMIT` |
| `readHead` is given bytes over the line budget; the next call should recover | First `E_LIMIT`, no poison; next snapshot succeeds | First `E_CORRUPT` and poisoned; later calls stay `E_CORRUPT` |

So 100.000 means every frozen test group passed.

## Strict re-review S1 (added after the fact)

At the user's request, the four frozen submissions were scored again under stricter engineering rules. This is not the official score, and not an independent third-party evaluation: it uses the original submissions, hash-matched frozen copies, 36 new contract groups, 12 mutations and one efficiency load.

| Rank | Submission | Base /20 | New contract /45 | Self-test detection /25 | Core excl. efficiency /90 | Efficiency /10 | Strict core /100 |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | gpt6 Astra | 20.000 | 45.000 | 25.000 | 90.000 | 7.745 | **97.745** |
| 2 | dsv4.1 + plugin | 20.000 | 45.000 | 20.834 | 85.834 | 7.512 | **93.346** |
| 3 | dsv4.1 | 20.000 | 45.000 | 14.584 | 79.584 | 10.000 | **89.584** |
| 4 | glm5.3flash | 19.776 | 41.250 | 12.500 | 73.526 | 8.081 | **81.607** |

Comparing only the two v2 submissions on the full pack (40% core + 60% extension):

| Submission | New extension passed | Extension strict /100 | Full v2 strict /100 |
|---|---:|---:|---:|
| dsv4.1 + plugin | 26/32 | 85.000 | **88.338** |
| glm5.3flash | 22/32 | 74.133 | **77.123** |

### Self-test detection (mutation testing)

Each author's own new tests were run against 12 injected faults; K = killed, S = survived. A survivor only means the tests did not cover that fault; it does not prove the original implementation had the bug.

| Submission | Detected |
|---|---:|
| gpt6 Astra | 12/12 |
| dsv4.1 + plugin | 10/12 |
| dsv4.1 | 7/12 |
| glm5.3flash | 6/12 |

### Efficiency (same machine, fixed load)

| Submission | CPU median ms | Peak RSS median KiB | CPU /5 | RSS /5 |
|---|---:|---:|---:|---:|
| dsv4.1 | 172 | 96,448 | 5.000 | 5.000 |
| dsv4.1 + plugin | 437 | 125,436 | 3.137 | 4.375 |
| gpt6 Astra | 374 | 126,616 | 3.391 | 4.354 |
| glm5.3flash | 453 | 96,016 | 3.081 | 5.000 |

The load: 128 jobs of about 3 KiB, 2,048 receipts, periodic snapshots, replay after compact/reopen, no real disk I/O. These numbers describe this machine and this load only.

### Failure causes (strict re-review)

- **Plugin**: six failing extension scenarios, two causes 鈥?error codes such as `E_LIMIT` from the iteration source are passed through instead of normalised to `E_IO`; decode-budget `E_LIMIT` is rewritten as `E_CORRUPT` and poisons the instance. X25 combines both.
- **GLM**: three failing core scenarios, two causes; ten failing extension scenarios, five causes, mainly getter exceptions bypassing normalisation, cumulative chunk offsets used as line lengths, and replica queue tasks not re-checking poison.

276 independent contract processes ran (reference 68/68); all 48 mutations had clean controls and failure witnesses; all 25 efficiency rounds completed correctly; original submissions, frozen copies and author tests are hash-matched.

## How to read this

- The official score asks 鈥渄id it pass the frozen contracts鈥? the strict re-review asks 鈥渂eyond passing, can its own tests detect faults, and at what cost鈥? Different questions.
- The strict re-review is an after-the-fact tightening, not a pre-registered experiment; its ordering is not a model leaderboard.
- The strict gap between the plugin and dsv4.1 comes mainly from self-test detection and efficiency, and cannot be attributed directly to the plugin; they also ran different packs (v2 vs v1).
- Model labels come from directory names; full sessions, exact versions, effort and budget were not independently verified.

## Evidence

- In this repository: [results.json](data/results.json)
- Kept locally: `鍥涙ā鍨嬭瘎鍒嗘姤鍛?md`, `鍥涗唤绛斿嵎涓ユ牸澶嶈瘎鎶ュ憡.md`, `涓ユ牸璇勫垎鏍囧噯_S1.md`, per-group JSON, TAP, frozen hashes and recomputation scripts.
