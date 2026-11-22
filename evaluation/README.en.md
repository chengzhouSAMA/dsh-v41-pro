# Evaluations

> These are two independent engineering evaluations, not product benchmarks and not model leaderboards. Each has one task and one submission per subject, and the tasks, budgets, context, and review methods differ. They record what happened on these tasks, not the general ability of a model or plugin.

This directory publishes reviewable summaries, review figures, and machine-readable results. Raw submissions, hidden tests, and per-group logs stay local and are not distributed with the repository.

## The two evaluations

| Evaluation | Date | Task | Subjects |
|---|---|---|---|
| [Hardest bug fix](bugfix-2026-11-14.en.md) · [中文](bugfix-2026-11-14.zh.md) | 2026-11-14 | Fixing defects in the DurableKV persistent store | Flash without plugin / Flash + v4.1 Pro v1.2.0 / GPT-6 Astra |
| [AegisQueue](aegisqueue-2026-11-22.en.md) · [中文](aegisqueue-2026-11-22.zh.md) | 2026-11-22 | Implementing the AegisQueue persistent queue | dsv4.1 / dsv4.1 + plugin / gpt6 Astra / glm5.3flash |

- Review figure: [Hardest bug fix · three-way review](assets/bugfix-review-2026-11-14.jpg)
- Machine-readable summary: [results.json](data/results.json)
- Earlier writing comparison (non-blind, single run, subjective, not a benchmark): [novel/REPORT.md](novel/REPORT.md)

## Shared boundaries

- **Names are submission directory labels.** No independently verified full session transcript exists, so exact model versions, reasoning effort, tool budgets, and context contamination are partly unknown.
- **One task, one run.** A single submission's success or failure cannot be extrapolated to general ability, and the plugin-minus-baseline difference cannot be attributed directly to the plugin.
- **Different reviewers.** The multi-dimensional review of the bug-fix task was given by Claude Opus 5.5 and Kimi K3.1 Pro (provided by the user); the AegisQueue official scores come from a frozen automated grader, and the strict re-review is an after-the-fact tightening requested by the user.
- **A perfect score is not the absence of defects.** Boundaries not covered by the frozen tests can still be broken; the reports list them separately.
- **Decimals are accounting precision.** 0.001 is not statistical confidence.
