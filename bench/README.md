# Benchmark harness

`run.js` starts N headless agents five seconds apart in one fresh copy of a fixture repo: Claude Code (`claude -p`, `--permission-mode acceptEdits`, isolated `CLAUDE_CONFIG_DIR`, project settings only) and, optionally, Codex (`codex exec`, workspace-write sandbox, user config ignored). It waits for all of them, runs the scenario's acceptance checker, and parses each transcript for cost, tokens, turns, tool errors, mom blocks, whole-file writes, tree-wide git commands, how often an agent saw a failing test run, and whether its final message admits the suite is red.

```
node bench/run.js --conditions baseline,mom-advisory --trials 10 --parallel 2 \
  [--model claude-sonnet-5-5] [--max-turns 100] [--stagger 5] [--slow 15] [--timeout 1200] \
  [--fixture bench/fixture-shop --tasks bench/tasks-shop.json --check bench/check-shop.js] --tag shop \
  [--codex half|<agent names>] [--codex-model gpt-6-astra] [--mom-src <frozen copy with bin/ skills/>]
node bench/report.js bench/results-<tag>.jsonl                 # tail metrics first, then means ± sd per condition
node bench/rescore.js --tag <tag> [--check <checker>|--no-check] # re-score / re-parse saved trials
```

Conditions: `baseline` (no mom) · `mom-advisory` (the default install) · `mom-full` (advisory mode with `--brief full`) · `mom-strict`.

- **Counterbalanced:** trial *k* runs every condition, in an order that rotates with *k*; `--parallel` runs that many at once.
- **Frozen code:** mom's `bin/` and `skills/` are copied into each trial directory, from `--mom-src` if given, and the row records the hash. Editing the repo during a run cannot change what a trial executes.
- **Failures kept, not silently dropped:** a trial is marked `valid: false` (and excluded by `report.js`, which counts the exclusions) when an agent's run failed for reasons that aren't the agent's outcome: API credit exhausted, Codex usage limit, harness error, or a mom condition whose hooks never fired. Agent timeouts are valid outcomes and are reported.

## Scenarios

| tag | agents | tasks | extra | checker |
|---|---|---|---|---|
| `long` | 3 × 2 tasks | ESM→async; rename→due dates; priority→`--json`+`edit` | | `check-long.js` (32) |
| `commit` | 3 × 2 tasks | same, and **commit your work when done** | | `check-commit.js` (32 + commits made, every commit's own tree green, nothing left uncommitted, no stash) |
| `slow` | 3 × 2 tasks | same as `long` | `--slow 15`: a 15 s integration test | `check-long.js` |
| `six` | 6 × 1 task | the same six features as six agents | | `check-long.js` |
| `haiku` | 3 × 2 tasks | same as `long` | `--model claude-haiku-5-5` | `check-long.js` |
| `shop` | 8 × 1 task | eight overlapping features/refactors in a 17-file order-processing CLI (`fixture-shop/`): a cross-cutting rename, tiered pricing, coupons, loyalty, `--json`, reports, tax config, shipping by weight. 5 tasks touch `pricing.js`, all 8 touch `cli.js` | | `check-shop.js` (45) |
| `shop-mixed` | 4 Claude + 4 Codex | same as `shop` | `--codex half` | `check-shop.js` |
| `medium`, `hard` | 3 × 1 | earlier, smaller scenarios (see git history) | | `check.js`, `check-hard.js` (23) |

The long/commit/slow/haiku prompts are in `tasks-long.json` / `tasks-commit.json`; `tasks-six.json` splits the same work six ways. All agents are told that other agents are working in the checkout.

## Results v0.6 (2026-11-10): lost-update repair

**Why.** On v0.5.1 the "all at once" writing cell showed no benefit (97.1% vs 96.6%). The transcripts of every bad run, in both conditions, showed the same thing. An agent read `manuscript.md`, then ran a script such as `L=open(p).read().split('\n'); L[4]=<abstract rewritten from what it read earlier>; open(p,'w').write(...)`. The rewrite silently reverted another agent's `sed` (412 → 438, g C m-2 yr-1 → Mg C ha-1 yr-1, "intermittent" → "pulsed"). The script reads the file before writing it, so v0.5.1 treated it as an in-place edit and let it through.

**What changed** (`bin/merge3.js`, about 70 lines, plus about 45 in `bin/mom.js`). mom keeps the text of each file as each agent last viewed it in full: a `Read` without offset or limit, or a plain `cat f`. Before an agent's write it keeps the current text, and after the write it runs a word-level three-way merge (base = the agent's view, theirs = the text before the write, mine = the text after). Changes that someone else made since the agent's view, and that the write put back to the base text, are merged back into the file, and the writer is told what was restored. Where both sides changed the same words, the writer's version stands. In-place edits never trigger it, because their output already contains the other changes. A write that changes nothing in a file others changed since the agent read it (usually a script whose `assert` on the old text failed) gets one note that concurrent edits are expected and the agent should re-read and re-apply. That targets agents that otherwise stop with "someone else changed it while I was working".

Agents are not told others are present, and all start at once (`--stagger 0`). Baseline and mom ran counterbalanced in the same batches. `v8` is the first build; `v9` also records a view from `cat f` inside a longer command (`cat -A f | head; cat f`). The one v8 mom run that lost three tasks had viewed the file that way.

| | baseline | mom v0.6 |
|---|---|---|
| Writing, 6 at once (`v8-paper-c6` + `v9-paper-c6`, n = 20 + 20): checks passed | 81.0% | **97.9%** |
| fully correct runs | 7/20 | 16/20 |
| runs that lost a whole task | 11/20 | 1/20 (v8 only) |
| wall-clock, tokens (output + uncached input), cost | 45 s, 112k, $0.62 | 38 s, 112k, $0.60 |
| Code, 8 at once (`v8-code-c8` + `v9-code-c8` + `v9-code-c8b`, n = 11 + 11): checks passed | 76.0% (76.9% pooled with `hl-code-c8`, n = 16) | **99.2%** |
| fully correct runs | 2/11 | 8/11 |
| turns, cost, median wall-clock | 79, $1.78, 103 s | 113, $2.10, 115 s (v0.5.1 `hl3`: 100 turns, $2.07) |

v9 alone: 87.1% vs 99.7%, 4/10 vs 9/10 fully correct. On the shop, v8 never restored anything. v9, which also records views from `cat` inside longer commands, restored 1–9 word-level changes 2–4 times per run, with no failures attributable to it. `v9-code-c8` lost 8 of 10 trials to the plan's usage limit; they are marked invalid. One `v9-code-c8b` mom run took 560 s because an agent polled `npm test` in its own `sleep 20` loop for 8 minutes. The overhead is otherwise unchanged from v0.5.1: mom agents run about 70% more test runs, finishing work that uncoordinated runs lose. Every writing restore came from `abstract-limits` rewriting the abstract and undid 25–27 word-level changes from four other agents. The checker confirmed that its own trim (≤ 220 words) and its Limitations section survived. The remaining imperfect mom runs each left one "intermittent drought" in text that another agent added after `term` had finished: a semantic conflict, like the shop's leftover `priceCents` in new tier code, which no merge can catch.

## Results v0.5.1 (2026-11-10, n = 10 per cell)

Same fixtures, harness and definitions as v0.5 below, run on a Claude subscription login (`--login`) because the API key had no credit. Every row is 10 valid trials. Baselines (`v3-long`, `v4-haiku`, `v4-slow`) and the mom rows were measured hours apart on the same day, and baselines drift by day (fast-suite baseline: 30.7 turns on 11-06, 36.0 on 11-10).

| Scenario | Metric | baseline | v0.5 as committed (`v3`/`v4`) | v0.5.1 (`v6b`) |
|---|---|---|---|---|
| Fast suite | Bad runs | 0/10 | 0/10 | 0/10 |
| | Turns, cost | 36.0, $0.64 | **55.9**, $0.73 | 34.3, $0.60 |
| | mom blocks per trial | | 4.9 | 0.8 |
| 15 s suite | Bad runs | 1/10 | 2/10 | 1/10 (missed one README line) |
| | Quit red (of 30 agents) | 4 | 8 | 4 |
| | Turns, cost, p90 | 29.5, $0.55, 195 s | 44.7, $0.71, 201 s | 37.1, $0.67, 201 s |
| Haiku | Bad runs | 0/10 | 1/10 | 0/10 |
| | Turns, cost, timeouts | 100, $0.10, 0 | 117, $0.11, 0 | 117, $0.11, 0 |

`--brief full` on Haiku (`v4-haiku`): 0/10 bad, 102 turns, $0.09.

What changed between the columns (all in `bin/mom.js`, covered by unit tests):
1. **The stale-write check covers only whole-file overwrites.** v0.5 blocked any shell write to a file another agent had changed since this one read it. Most blocked commands were `sed -i` and `s=open(p).read(); ...; open(p,'w').write(s)` scripts, which apply to the current text and cannot lose the other agent's change. `=>` and `a > b` inside heredoc bodies were also read as redirects. Replayed against v3's 47 stale blocks, 43 would now pass, and the 4 left are real overwrites.
2. **In advisory mode, in-place shell edits to a held file get a heads-up, like an `Edit`.** Blocking them with "use the Edit tool" set off a cascade: agents switched to Edit (5–7 Edit calls per trial against ~0 in baseline), their Edits claimed files, and those claims blocked others. Fixes 1 and 2 together (`v5`) brought the fast suite to 34.5 turns and $0.61.
3. **A blind overwrite counts from the agent's start.** One `v5` trial lost a feature: an agent that had read `src/store.js` only through `cat src/*.js` (a glob, so no recorded read) later ran `cat > src/store.js` with its old version. With no recorded read, staleness now counts from when the agent started. `v6b` measures this version.

Not replicated: v0.5's Haiku result (4/11 bad without mom on 11-06) was 0/10 on 11-10. The idle-claim fix did remove the Haiku hangs (4 timeouts → 0, p90 1205 s → ~300 s).

Mixed Claude + Codex (`v3-shop-mixed`, 4 Codex agents per trial): 1 valid baseline trial (45/45). The mom trial was invalid when a Codex agent hit the ChatGPT plan's usage limit, the same as on 11-06.

### Concurrency re-runs on v0.5.1 (`hl3-*`, n = 5)

These are the "all at once" cells of the 11-09 concurrency experiment (`hl-*`, built by `report-conc.js`), re-run on v0.5.1 because the shell-write fixes loosened exactly the blocking that experiment relied on. Agents are not told others are present (`tasks-shop-blind.json`, `tasks-paper.json`), and every agent starts at once (`--stagger 0`).

| | without mom | mom, 11-09 build (`hl`) | mom, v0.5.1 (`hl3`) |
|---|---|---|---|
| Code, 8 agents at once: checks passed | 79.1% (0/5 fully correct; `hl`) | 99.6% (4/5), 300 s | 98.7% (2/5), 120 s |
| Code, 8 at once: wall-clock, tokens | 112 s, 314k | 300 s, 344k | 120 s, 335k |
| Writing, 6 at once: checks passed | 97.1% (3/5; `hl3`) | 79.4% (0/5) | 96.6% (3/5) |

v0.5.1 keeps most of the 8-agent protection at about 7% extra time rather than 2.7×. Its three imperfect runs each missed only `rename_no_old_names`, a leftover old identifier from the cross-cutting rename. The code baseline is from `hl-code-c8` (11-09/10), not re-run. On writing, mom made no difference at 6 at once, and the uncoordinated cell has ranged from 69% to 97% across three batches. All charts and the README table come from `node bench/charts.js`.

### Mixed Claude + Codex on the fast suite (`mixed-long`, v0.5.1, n = 5 / 4)

To fit within the Codex plan's quota: the 3-agent `long` fixture, with `rename-due` run by Codex (`--codex half`) and the other two by Claude Sonnet 5.5. The run was stopped automatically when Codex hit its usage limit on trial 10, which leaves 5 baseline and 4 mom trials.

| | baseline | mom (lean, default) |
|---|---|---|
| Bad runs | 0/5 | 0/4 |
| Quit red (of 2 Claude agents per trial) | 0 | 1 |
| Claude turns, Claude cost | 19.0, $0.35 | 20.8, $0.36 |
| Wall-clock mean, p90 | 166 s, 182 s | 179 s, 197 s |

mom saw all three agents in every mom trial. The Codex agent joined under its hook-supplied `--as` identity, and its 20 or so writes per trial were tracked like the Claude agents' writes, so cross-tool coordination works end to end. With 4–5 trials and no bad runs on either side, this shows mom works with Codex and adds little cost there. It does not show any benefit.

## Results v0.5 (2026-11-06, n = 10 per cell; superseded by v0.5.1 above)

mom at sha256 `652c5531…` (lean brief; before the idle-claim change below). Sonnet 5.5 unless noted. "Bad run" = the final shared tree fails any acceptance check (lost work, a broken build, or an unfinished feature). "Quit red" counts agents (3 per trial; 8 for `shop`) whose final message says the suite is failing. Raw rows: `results-n10-<tag>.jsonl`.

| Scenario | Metric | baseline | mom (lean, default) | mom (full v0.4 brief) |
|---|---|---|---|---|
| **long**: fast suite, 3 × 2 tasks | Bad runs | 1/10 | 0/10 | 0/10 |
| | Cost per trial | $0.47 | $0.48 | $0.58 |
| | Turns | 30.7 | 30.7 | 69.1 |
| | Wall-clock (mean / p90) | 89 s / 114 s | 101 s / 126 s | 120 s / 143 s |
| | mom commands run by agents | 0 | 0.6 | 11.2 |
| **slow**: 15 s suite, 3 × 2 tasks | Bad runs | 0/10 | 0/10 | 1/10 |
| | Agents that quit red | 4 of 30 | 2 of 30 | 0 of 30 |
| | Cost | $0.45 | $0.41 | $0.51 |
| | Turns | 28.6 | 25.6 | 53.9 |
| | Wall-clock (mean / p90) | 154 s / 200 s | 143 s / 169 s | 184 s / 227 s |
| **haiku**: Haiku 5.5, 3 × 2 tasks | Bad runs | **4/11** | 1/10 | **0/10** |
| | Worst acceptance | 44% | 72% | 100% |
| | Stale-read / edit-mismatch errors | 5.0 | 4.8 | 0.3 |
| | Agent timeouts (20 min) | 0 | 4 | 1 |
| | Wall-clock (mean / p90) | 192 s / 276 s | 575 s / 1205 s | 403 s / 698 s |
| | Cost | $0.09 | $0.09 | $0.09 |
| **shop**: 8 agents, 17-file repo | Bad runs | 1/10 | 1/10 | – |
| | Agents that quit red | 16 of 80 | 19 of 80 | – |
| | Cost | $1.08 | $1.18 | – |
| | Turns | 64 | 89 (one trial 191) | – |
| | Wall-clock (mean / p90) | 115 s / 125 s | 124 s / 148 s | – |

What this says:

- **The overhead is gone in the common case.** With the lean brief, Sonnet agents on a fast suite cost what uncoordinated agents cost: same turns, same tokens, +2% dollars, wall-clock within noise. The v0.4 brief cost +23% and 2.25× the turns there, for the same outcome.
- **Strong models mostly don't need it, even with 8 agents.** Sonnet's bad-run rate is about 1 in 10 with or without mom, on both repos. In `shop`, mom cost about 9% more for no measurable gain. A fifth of Sonnet agents stop with the suite red and blame another agent's half-done work, and mom's red-test attribution didn't change that. The last agent standing still cleans up, so every final suite was green.
- **The tail is real for weaker models.** Uncoordinated Haiku left a broken tree in 4 of 11 trials (worst: 44% of checks). The full brief prevented all of them, at about 2× wall-clock. The lean brief prevented most of them, but stale reads stayed at baseline levels, and 4 agents hung until the 20-minute timeout. They were polling `mom status` for each other's files, which stay claimed until a turn ends, and in a headless run the turn is the whole run.
- **n = 3 claims that did not replicate at n = 10.** The earlier "3 of 9 agents quit red without mom → 0 of 9" and "240 s → 173 s" in the slow scenario: at n = 10 it is 4 of 30 vs 2 of 30, and 154 s vs 143 s. The six-agent and commit scenarios were not re-run. `git add -A`, stash and reset are blocked deterministically, so the commit result doesn't depend on sampling.

### v0.5 idle claims (partial, n = 2–7)

The Haiku hangs led to one change: a hook-observed claim with edits goes cold after 90 s without edits by its holder (`MOM_IDLE_SEC`), and whoever takes it next is told to re-read. The lean brief also gained "re-read right before you edit". Unit tests cover the hang. The validation run (`results-v2-*.jsonl`) was cut short when the benchmark account's API credit ran out: 43 of 70 trials are marked invalid ("Credit balance is too low"). In the 27 valid trials, mom had no bad runs (0 of 14 trials); baseline had 1 of 13. On the fast suite (n = 6 vs 7) lean mom took 41 turns against baseline's 29, and cost $0.54 vs $0.47. That's noise-level n, so treat the cost of this change in the common case as unmeasured.

### shop-mixed (4 Claude + 4 Codex): not measured

Only 1 of 11 trials is valid. The Codex agents hit the ChatGPT plan's usage limit after the first trial, and were marked invalid rather than scored as failures. Before that, two smoke trials (2 Claude + 1 Codex, `long` tasks, mom on) scored 32/32 and showed the Codex adapter working. The first one also exposed a bug, now fixed: mom matched agent hosts by command-line text. A Codex process whose command line mentions `mom.js` (as its hook flags do), or a checkout path containing "mom", was never treated as the live host. Its record was dropped on nearly every hook call, so its claims never held. **The earlier Codex pilot (`CODEX-RESULTS.md`) ran with this bug.**

## Results v0.4 (2026-11-04, n = 3 per cell; superseded where re-run above)

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

n = 10 (v0.5) or 3 (v0.4), two small fixtures, synthetic tasks that finish in minutes, agents told up front that others are present. Per-trial transcripts are not committed (`runs/` is git-ignored) but `run.js` regenerates them; the `results-*.jsonl` rows are. Scenarios on bigger repos, with Codex/Cursor agents, or with a human editing alongside are the contributions that would move the conclusions most.

## Codex

```sh
npm run bench:codex -- --trials 3 --model <installed-model>
node bench/codex.js --conditions baseline,instructions,mom-advisory,mom-strict --trials 10
```

The separate runner uses real `codex exec` processes, the same task/checker files,
fresh checkouts per condition, five-second staggering, and counterbalanced order
across paired trials. `--tasks`, `--check`, `--stagger`, `--timeout` (seconds per
agent), and `--output` are configurable. The default model is Codex's default with
user config ignored; pin `--model` for comparisons. User-level hooks/configuration
can vary by CLI version; inspect transcripts and hook events before pooling runs.

Only generated mom hooks receive the CLI hook-trust bypass for the trial; this is
automation of locally reviewed code. Normal installations require `/hooks` review.
The runner uses workspace-write sandboxing and in-checkout mom state. The baseline
sets MOM_DISABLE=1. It does not alter your working checkout or user hook settings.

Results are JSONL with CLI version, task hash, acceptance checks, elapsed time,
per-agent exit status, timeout flags, token usage and mom event/block counts.
Transcripts remain under `bench/runs/codex/`. Errors/timeouts remain in results;
do not silently discard them or interpret authentication failures as task failures.
The instructions-only arm is an ablation of coordination advice, not enforcement.
Inspect that mom arms have hook events; zero events means integration was inactive.

A small run demonstrates integration and supplies exploratory observations, not
statistical proof. Compare final acceptance and lost work first, then elapsed time
and tokens. Report all trials. Use multiple repositories and overlapping and
independent tasks before claiming a general model-performance improvement.

### Controlled lost-update demonstration

`npm run bench:contention` reproduces two workers reading the same old file and
attempting destructive replacements. Without hooks, only the second feature
survives. With the Codex adapter, the stale replacement is blocked; release,
reacquisition and re-reading preserve both features. Results are recorded in
`results-contention.json`. This is a deterministic protocol demonstration with
no model calls; it must not be described as a Codex model-quality benchmark.

The first live integration pilot is reported in [CODEX-RESULTS.md](CODEX-RESULTS.md).
Both valid conditions passed 32/32; mom was slower in that one trial. The initial
inactive-hook attempt is retained and marked invalid. This is useful diagnostic
evidence, not a claimed Codex performance win.
