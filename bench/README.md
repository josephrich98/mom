# Benchmark harness

`run.js` starts N headless Claude Code agents (`claude -p`, `--permission-mode acceptEdits`, isolated `CLAUDE_CONFIG_DIR`, project settings only) five seconds apart in one fresh copy of `fixture/` (a 3-file todo CLI with tests), waits for all of them, runs the scenario's acceptance checker, and parses each agent's `stream-json` transcript for cost, tokens, turns, tool errors, mom blocks, whole-file writes, tree-wide git commands, how often an agent saw a failing `npm test`, and whether its final message admits the suite is red.

```
node bench/run.js --condition baseline|mom-advisory|mom-strict \
  [--trials 3] [--model claude-sonnet-5-5] [--max-turns 100] [--stagger 5] [--slow 15] \
  [--tasks bench/tasks-long.json --check bench/check-long.js --tag long]
node bench/report.js bench/results-<tag>.jsonl        # mean ± sd table per condition
node bench/rescore.js --tag <tag> --check <checker>   # re-score saved trials after changing a checker or metric
```

## Scenarios

| tag | agents | tasks | extra | checker |
|---|---|---|---|---|
| `long` | 3 × 2 tasks | ESM→async; rename→due dates; priority→`--json`+`edit` | | `check-long.js` (32) |
| `commit` | 3 × 2 tasks | same, and **commit your work when done** | | `check-commit.js` (32 + commits made, every commit's own tree green, nothing left uncommitted, no stash) |
| `slow` | 3 × 2 tasks | same as `long` | `--slow 15`: a 15 s integration test | `check-long.js` |
| `six` | 6 × 1 task | the same six features as six agents | | `check-long.js` |
| `haiku` | 3 × 2 tasks | same as `long` | `--model claude-haiku-5-5` | `check-long.js` |
| `medium`, `hard` | 3 × 1 | earlier, smaller scenarios (see git history) | | `check.js`, `check-hard.js` (23) |

The long/commit/slow/haiku prompts are in `tasks-long.json` / `tasks-commit.json`; `tasks-six.json` splits the same work six ways. All agents are told that other agents are working in the checkout.

## Results (2026-11-04, n = 3 per cell)

Sonnet 5.5 unless noted. "Thrash" = times any agent saw a red `npm test`. "Quit red" = agents whose final message says the suite is failing. Means ± sd across trials.

### haiku — Haiku 5.5, 3 agents × 2 tasks

| Metric | baseline | mom-advisory |
|---|---|---|
| Acceptance (of 32) | 24.7 ± 12.7 (one trial 10/32) | 32.0 ± 0.0 |
| Trials with all tests passing | 2/3 | 3/3 |
| Stale-read / edit-mismatch errors | 7.0 ± 3.6 | 0.3 ± 0.6 |
| Whole-file `Write` calls | 15.3 ± 4.6 | 7.0 ± 2.6 |
| Thrash | 3.0 | 1.0 |
| Wall-clock | 303 s ± 210 | 260 s ± 40 |
| Cost | $0.08 | $0.07 |

The 10/32 trial: `esm-async` wrote `src/store.js` whole three times and `rename-due` rewrote every source and test file once; the final CLI could not `add` a todo and 5 of 30 tests failed. Uncoordinated Haiku agents also hand-rolled coordination (`sleep 60; md5sum src/*.js`, `until grep -q … src/cli.js; do sleep 1; done`); one trial's wall-clock includes ~2 minutes in which a finished agent's process hung on such a loop before the harness killed it.

### slow — 15 s test suite, 3 agents × 2 tasks

| Metric | baseline | mom-advisory |
|---|---|---|
| Wall-clock | 240 s ± 170 (74, 134, 435) | 173 s ± 15 |
| Agents that quit with the suite red | 1.0 ± 1.0 (3 of 9) | 0 of 9 |
| Thrash | 5.3 ± 3.5 | 1.3 ± 0.6 |
| Test runs | 12.3 | 7.7 |
| Cost | $0.46 | $0.49 |
| Turns | 31 | 54 |
| Acceptance | 32/32 | 32/32 |

In the 435 s trial, two agents finished in about 70 s with the suite red ("All 10 fail because of other agents' edits… I left that work alone") and the third spent 424 s making everything pass.

### six — six agents, one task each

| Metric | baseline | mom-advisory |
|---|---|---|
| Thrash | 14.0 ± 7.0 | 3.0 ± 1.7 |
| Test runs | 33.0 | 17.0 |
| Quit red | 1.7 ± 1.5 (5 of 18) | 1.0 ± 1.0 (3 of 18) |
| Wall-clock | 108 s ± 44 | 118 s ± 13 |
| Cost | $0.67 | $0.75 |
| Turns | 64 | 99 |
| mom BLOCKED | 0 | 2.0 |
| Acceptance | 32/32 | 32/32 |

### commit — 3 agents × 2 tasks, commit when done

| Metric | baseline | mom-advisory |
|---|---|---|
| Tree-wide git commands (`add -A`, `commit -a`, stash, `checkout .`, reset) | 2.0 ± 1.0 | 0 |
| Thrash | 5.0 ± 5.0 | 1.3 ± 2.3 |
| Test runs | 21.3 | 11.0 |
| Wall-clock | 136 s ± 49 | 105 s ± 13 |
| Cost | $0.60 | $0.59 |
| Turns | 44 | 76 |
| mom BLOCKED | 0 | 2.7 |
| Commits whose own tree fails tests | 0.3 | 0.3 |
| Acceptance (of 36) | 35.7 | 35.7 |

The one red commit in each condition is the same agent (`esm-async`) committing before its own tests were green; in the mom trial it is that agent's first commit, before any other agent had edited the tree, so neither is a coordination failure. One baseline agent created a worktree in `/tmp`, committed there, then ran `git update-ref` and `git reset -q` in the shared checkout and re-applied its patch; mom blocks all three.

### long (fast suite), 2026-10-30, v0.3

| Metric | baseline | mom-advisory | mom-strict |
|---|---|---|---|
| Wall-clock | 81 s ± 6 | 114 s ± 14 | 125 s ± 13 |
| Cost | $0.54 | $0.47 | $0.45 |
| Thrash | 7.0 ± 6.2 | 1.0 ± 1.0 | 2.7 ± 2.9 |
| Acceptance | 32/32 | 32/32 | 32/32 |

## What we tried and dropped

- **Strict mode as default (v0.1).** Blocking every edit to a held file made Sonnet 5.5 agents 2–3× slower for identical results and produced a circular wait. Advisory became the default in v0.3; strict remains for whole-file writers.
- **Blocking commits that include a file under edit (v0.4 pre-release).** Agents did the right thing (`mom wait`, twice, 100 s and 120 s) and still timed out, because in a shared tree another agent's "turn" can be its whole run; one agent gave up without committing and its staged work went out under someone else's commit message. Broken commits were no fewer than baseline. It is now a one-time heads-up (strict mode still blocks).

## Caveats

n = 3, one small fixture, synthetic tasks that finish in minutes, agents told up front that others are present. Per-trial transcripts are not committed (`runs/` is git-ignored) but `run.js` regenerates them; the `results-*.jsonl` rows are. Scenarios on bigger repos, with Codex/Cursor agents, or with a human editing alongside are the contributions that would move the conclusions most.
