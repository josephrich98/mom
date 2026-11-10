# Codex integration pilot — 2026-11-06

> **Correction (later the same day):** this pilot ran with a host-detection bug. mom decided which process was the
> agent by searching command-line text, and skipped any process whose command line mentioned "mom". A Codex process
> started with mom's hook flags, or in a checkout whose path contains "mom", was never recognized. Each worker's
> record was dropped on nearly every hook call, so its claims barely held. The coordination measured below is
> therefore weaker than what the adapter does now. The fix judges the executable name only and has a regression
> test. A re-run in a mixed Claude + Codex 8-agent scenario was blocked by the ChatGPT plan's usage limit (see
> [bench/README.md](README.md#shop-mixed-4-claude--4-codex-not-measured)).

This is an exploratory development run, not evidence of a general performance
improvement. Three Codex CLI 0.163.0 agents worked on the existing six-feature todo
fixture, five seconds apart, using the CLI default model with user config ignored.
The exact model was not pinned. Implementation fixes were made during development;
these timings are diagnostic. The runner now snapshots the source per condition
and records its hash so subsequent experiments cannot drift during execution.

| Metric | Baseline | mom advisory |
|---|---:|---:|
| Final acceptance | 32/32 | 32/32 |
| Elapsed, including acceptance checker | 207.5 s | 235.6 s |
| Output tokens, sum across workers | 15,050 | 20,058 |
| Stale patch verification errors in stderr | 2 | 3 |
| Shell calls denied by PreToolUse, from stderr | 0 | 2 |
| mom event records | 0 | 79 |

The treatment was about 14% slower and used about 33% more output tokens. This
single trial does not demonstrate improved aggregate Codex performance. It does
establish that the native adapter runs under Codex, workers exchange interface
notes, and shell operations can be stopped. Advisory mode permits overlapping
patch updates, so it cannot eliminate stale patches.

One shell denial was a read-only inline Node diagnostic. Detection has since been
narrowed: launching an inline interpreter alone no longer counts as a write;
explicit write APIs and shell rewrite patterns still do. Regression tests cover
both cases. These revised heuristics have not been subjected to another full
model benchmark. The event log originally omitted shell denials; the table uses
stderr for those counts, and future runs log them explicitly.

An initial treatment attempt loaded no hooks. It was stopped, retained in
`results-codex.jsonl` with `valid: false`, and excluded from the comparison.
The runner now supplies explicit hook configuration and marks runs without hook
activity invalid. Project trust and hook trust are distinct requirements.

`results-contention.json` records a separate deterministic lost-update experiment:
without coordination only one of two features survives; with a blocked stale
rewrite, release, reacquisition and re-reading, both survive. It uses the Codex
hook adapter but makes **no model calls**. This demonstrates the protective
mechanism without pretending it proves model performance.

Next evidence needed: pin a model and source version, run repeated counterbalanced
trials across advisory, strict, instructions-only and baseline conditions, and
include larger repositories and independent tasks. Keep errors and timeouts in
the report. Compare correctness, lost work, latency and tokens together.
