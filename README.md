# V4.1 Pro

[中文](README.zh.md) | **English**

> The session gets compacted. Yesterday's verified conclusion becomes today's "should be fine."
> The model didn't get dumber — the engineering memory went first.

V4.1 Pro does not train a model, and it won't pretend to make one smarter. It pins down the goals that should be remembered, the evidence that should be checked, and the failures that should be questioned — then asks the next answer to hold up.

A plugin bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): 17 host modules, a client-side thinking menu, reasoning controls from divergent to thorough, and an engineering loop of **acceptance → calibration → retro → shrink**. It also ships language and fiction skills, a long-form novel workspace, and omnimodal media tools.

![version](https://img.shields.io/badge/version-1.11.0-4B5BD6)
![tests](https://img.shields.io/badge/tests-189%20passing-2EA043)
![license](https://img.shields.io/badge/license-MIT-2EA043)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.5-4B5BD6)

## What it solves

- **Evidence.** Verification reads process exit codes, real test summaries, and file facts — never the model's self-report. Failures, timeouts, zero-test runs, and "I ran it" are not written up as "passed."
- **Memory.** Goals, edits, command results, and failure causes go into a bounded, atomically written ledger. Sessions can be restored instead of reconstructed from a sentence left in the context.
- **Questioning.** Complex tasks diverge first, then focus. Thorough mode asks for root causes and counterexamples; Reasoning Max 3.0 searches multiple paths and cross-checks them.
- **Closure.** Define executable acceptance criteria before delivery, record a probability before the work and settle it afterwards, turn failures into rules, and check whether freshly written code can be shorter.

## Quick start

Requirements: DSH `0.2.2-rc.5` (the currently verified version), Node.js `>=20`; pnpm is needed for `install.mjs --install`.

```bash
git clone https://github.com/chengzhouSAMA/dsh-v41-pro.git
cd dsh-v41-pro
node install.mjs --dry-run     # see which profile would change
node install.mjs --install     # add the link: dependency and run pnpm install
```

You can also choose this directory through **Plugins → Add plugin** in DSH. Do not mix the two paths. `install.mjs` only edits the profile's `package.json`, and it is reversible:

```bash
node install.mjs --uninstall
```

If new patch rows were added, restart DSH (or reload the host) once. When only implementations of existing modules changed, DSH's hot reload is usually enough. If the client menu does not appear, refresh the existing DSH page; do not start a second server.

## Thinking modes

Select the bundle, open the model menu next to the composer, and find **Thinking mode**; or send a command:

| Command | Behavior |
|---|---|
| `/thinking auto` | Diverge to understand, then focus on execution; backtracks at most twice after two consecutive tool failures |
| `/thinking divergent` | Fixed divergent mode; requests use at least `low` |
| `/thinking focused` | Fixed focused mode; requests use at least `high` |
| `/thinking thorough` | Fixed thorough mode; strictly `max`; asks for root causes, hidden assumptions, counterexamples, and cross-verification |
| `/thinking off` | Disable mode control for this session and restore the effort this module changed |
| `/thinking status` | Show the current mode and phase |

Thorough mode requires the model to explicitly declare `max`. Otherwise it fails with a clear error and preserves the input rather than substituting `high`, `xhigh`, or a custom top tier. Modes are restored from the session command log; divergent, focused, and auto modes keep any higher effort the user already selected.

### Reasoning Max 3.0

A reasoning-orchestration layer inside `thinking`, ported from the single-file Python `DSH Reasoning Max 3.0`. It is invoked by the `reasoning_max` tool and the `/reasoning-max` command. It orchestrates multiple model calls; it does not change model weights or single-response ability.

- **Tiered compute.** `low / medium / high` selected from question length and keywords. Low uses one candidate plus a judge and returns when confidence is ≥ 0.7; medium and high add parallel candidates, a step tree, and synthesis.
- **Multiple paths.** Four perspectives are generated in parallel (independent solution, alternative path, counterexample and boundary, practical verification), then handed to an independent judge.
- **MCTS.** UCT selection, parallel expansion, step-level PRM scoring, path-value backpropagation, and pruning of low-scoring branches; confidence, plateau, budget, or the planned iteration cap ends the search.
- **PRM and judging.** LLM-as-judge samples are averaged with a standard deviation; the final review takes the strictest verdict, averages confidence, and deduplicates issues.
- **Budget and routing.** Token estimates and wall-clock budgets; multi-model routing with UCB1 + ε, with rewards written back to `router.json`.
- **RL logs.** Every solve appends `rl.jsonl` and `audit.jsonl`; `/reasoning-max export` writes `prm_steps.jsonl`, `preference_pairs.jsonl`, and `sft_best.jsonl`.
- **Relationship to DSH effort.** `low/medium/high` are orchestration budgets, not DSH reasoning tiers. Actual calls map to what the model declares (low→≥low, medium→≥high, high→max; otherwise the highest declared tier).
- **Honest boundaries.** The PRM is a noisy LLM-judge proxy; token counts are estimates; the RL layer only learns routing and exports data, it does not fine-tune the model; one solve costs several model calls, so do not use it for simple questions.

State lives in `$DSH_HOME/v41pro/reasoning-max/`.

## The engineering loop

| Module | Capability |
|---|---|
| `acceptance` | Executable acceptance criteria: `cmd` runs through the real shell for an exit code, `file` checks existence and non-emptiness, `manual` needs a human; a pending item at turn end triggers one steer |
| `calibration` | `forecast` records a probability and expected duration before the work; `settle` closes it afterwards; reports Brier score, overconfidence, and duration MAE |
| `retro` | Records what happened, a verifiable root cause, and a lesson; reusable rules are recalled by keyword in later tasks |
| `shrink` | After writing code, every file needs a remove / merge / keep decision with a reason; line counts are measured on disk |

Tools: `acceptance`, `forecast`, `settle`, `retro`, `rules`, `code_shrink`. Commands: `/accept`, `/calibration`, `/rules`, `/shrink`.

The gate's force comes from a single `agent.steer` at turn end — **it is not a permission lock**. A model can still answer with one dismissive sentence; `code_shrink` records the reasons it gave and the on-disk line counts, not a semantic guarantee of optimal brevity. Rule matching is keyword recall, not semantic understanding.

## All modules

| Module | Capability |
|---|---|
| `escalator` | Repeated calls, consecutive failures, the same failure across steps, repeated edits, and drift; advise only or switch models temporarily |
| `ledger` | Goals, edits, real command results, and failure summaries persisted; versioned, serialized, atomic writes |
| `verifier` | `pro_verify` and the turn-end gate; distinguishes failure, timeout, zero tests, and a valid pass |
| `acceptance` | Executable acceptance criteria and the turn-end gate |
| `tempo` | Step, wall-clock, and tool-failure budgets that bound automatic intervention |
| `forker` | Parallel independent proposals; the main agent picks exactly one |
| `critic` | Independent, read-only, fail-closed review; a review that did not run is never reported as a pass |
| `cartographer` | Rebuilds the file index and unverified-evidence state after compaction from real reads and writes |
| `calibration` | Prediction-calibration ledger |
| `retro` | Retrospectives and a reusable rule library |
| `shrink` | Code-shrink review |
| `language` | On-demand language-optimization skill: goal, deliverable, acceptance, proposition retention, evidence grading |
| `fiction` | On-demand fiction skill: scene goals, character motives, knowledge boundaries, costs of power, foreshadowing, and chapter hooks |
| `novel` | Long-form novel workspace: outline plus database, a per-turn state card, requirements that can be recorded and retired |
| `thinking` | Divergent / focused / thorough / automatic phases, plus Reasoning Max 3.0 |
| `ethical-conduct` | Always-on conduct baseline loaded in full on every model request, independent of thinking mode |
| `omni` | Omnimodal media: environment probe, video frame extraction and scanning, audio analysis/transcription/speech/cutting, video composition, audio extraction, image generation |

## Common tools

| Tool | Purpose |
|---|---|
| `pro_verify` | Actually runs a command and returns its exit code as evidence |
| `pro_fork` | Generates several proposal candidates in parallel (creates sub-sessions and incurs model cost) |
| `pro_critique` | Independent, read-only review that only finds problems; fail-closed |
| `pro_novel` | Manages a long-form novel workspace |
| `reasoning_max` | Multi-path reasoning orchestration (do not use for simple questions) |
| `omni_*` | Eleven media tools: probe, frames, scan, audio, composition, image generation, and more |

Subagent tools create real child sessions. Do not use them for mechanical edits or factual lookups.

## Configuration

Module config replaces whole rows; omitted fields use defaults. For example, temporary model escalation:

```yaml
- id: v41pro-escalator
  name: 'dsh-v41-pro/escalator'
  config:
    mode: escalate
    proModel: <a registered, authorized model ID on the current provider>
    proReasoningEffort: high
```

Disable a module:

```yaml
- id: v41pro-forker
  disabled: true
```

The bundle stays on the current provider and probes the target model and reasoning tiers through `llm.resolveModelInfo()`. If they are unsupported it falls back to advice; it does not hard-code cross-vendor tiers.

## Verification

```bash
npm test                        # 21 test files, 189 cases
npm run selfcheck               # exports, locales, patch rows, icon resources
npm run reliability             # six plugin-mechanism scenarios
powershell -File scripts/loop-runtime.ps1   # Windows: real DSH agent loop + fixture model
```

Latest verification in this repository:

| Check | Result |
|---|---|
| `node --test test/*.test.mjs` | 189 passed / 0 failed (530 ms) |
| `node scripts/selfcheck.mjs` | 18 exports, 18 patch rows |
| `scripts/loop-runtime.ps1` | PASS: acceptance gate, shrink gate, calibration settlement, rule injection |
| Live `reasoning_max` call | 4×4 grid shortest paths = 70, `stop=fast_path calls=2`; forced low = 1 candidate + 1 judge + 1 synthesis |

These checks prove plugin mechanics, not general model capability. `scripts/loop-runtime.ps1` drives the real DSH 0.2.2-rc.5 agent loop with a fixed fixture model; it makes no paid model calls. Comparing two models or plugin versions requires a fixed task set, provider, system prompt, tool permissions, budget, retries, and review rubric, reporting autonomous success, human assistance, failure, timeout, and invalid runs separately.

## Layout

```text
index.js              entry point wiring 17 host modules
client.js             client: thinking-mode menu + omnimodal settings page
src/                  host modules
  core/               persistence, state, messages, text, evidence, capability probing
  reasoning-max.js    Reasoning Max 3.0 engine (private to thinking)
cordis.patch.yml      18 bundle patch rows
skills/               bundled skill bodies
locale/               UI strings (Chinese / English)
omni/                 omnimodal media tools (derived from dsh-omni, MIT, trimmed)
test/                 21 node:test files
scripts/              selfcheck, real-loop, thinking-chain, ethics, reliability
docs/                 design notes and the team-loop contract
eval/novel/           one non-blind, subjective, single-run writing comparison (not a benchmark)
```

## Boundaries

- A plugin cannot add model parameters, context windows, vision ability, or training knowledge.
- No same-condition comparison against an unreleased DeepSeek V4.1 Pro exists, so no claim of "beating" it is made.
- The ledger is a private derived cache, not a replacement for DSH session logs, Git, or workspace backups.
- Without a `subagents` service, `forker` and `critic` stay dormant; without a `shell` service, `verifier` does not activate.
- Test-summary recognition covers common Node, pytest, Jest/Vitest, TAP, and Go formats; other frameworks can rely on the exit code, or extend the recognizer with real samples.
- Unverified improvement percentages from older docs were removed. The precise technical contract is in [`docs/design.zh.md`](docs/design.zh.md).

## Releases

- **1.11.0** — Reasoning Max 3.0: tiered compute, parallel candidates, MCTS, PRM, multi-model routing, and RL logs.
- **1.10.0** — Engineering loop: acceptance, calibration, retro, shrink.
- **1.9.2** — Thorough mode: strict `max`, root causes, and counterexamples.
- **1.9.1** — Always-on `ethical-conduct` baseline.
- **1.9.0** — Omnimodal media integration.

## License

MIT. See [LICENSE](LICENSE). The `omni/` directory keeps its upstream MIT license; see [omni/LICENSE](omni/LICENSE).
