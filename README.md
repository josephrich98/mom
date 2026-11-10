# mom

**Two agents. One checkout. Somebody has to make them share.**

mom keeps parallel AI coding agents (Claude Code sessions, Codex, Cursor, you) from destroying each other's work in the same repo. It is a zero-dependency CLI that installs as a Claude Code plugin. There is no supervising agent, no LLM call, and nothing written into your repo.

It is a safety net, not a speed-up. In the common case it stays out of the way: in our benchmark, coordinated Sonnet agents cost about the same as uncoordinated ones (34 vs 36 turns, $0.60 vs $0.64). It speaks up only when agents actually collide: a whole-file overwrite of something another agent just changed, or a tree-wide git command in a shared checkout.

![two Claude Code sessions in one checkout; the second one is told what the first holds, is stopped from rewriting a file mid-edit, and is told exactly which files to commit](assets/demo.svg)

## Install

```
/plugin marketplace add josephrich98/mom
/plugin install mom@mom
```

That's it. From the next session, every git checkout you open is covered. No `init`, no settings edits, no `.gitignore` entry: state lives in `~/.mom/`.

CLI for other agents and humans: `npm i -g mom-cli`. Per-repo opt-in without the plugin: `mom init` (see [docs/other-agents.md](docs/other-agents.md)).

## What breaks without it

From the benchmark transcripts (headless agents, one checkout, overlapping tasks, no coordination):

- **They rewrite each other's files.** An agent that read the code once runs `cat > src/store.js <<EOF` with its own version and wipes out another agent's feature. In one 2026-11-06 batch, uncoordinated Haiku 5.5 agents left a broken tree in 4 of 11 trials (worst: 44% of checks). That rate did not replicate on 2026-11-10 (0 of 10), so treat it as how bad it can get, not how often.
- **They sweep up each other's half-finished work.** Told to commit when done, every uncoordinated Sonnet trial ran `git add -A` at least once. One agent ran `git update-ref` and `git reset` in the shared tree. mom blocks these deterministically and prints the exact `git add <your files>` to run instead.
- **They give up and blame each other.** In an 8-agent run on a 17-file repo, a fifth of Sonnet agents stopped with the suite red: *"3 tests fail… All four failures come from another agent's shipping change."* The last agent standing cleaned up. (mom doesn't fix this one yet; see [Numbers](#numbers).)
- **They invent their own coordination.** Uncoordinated Haiku agents wrote `sleep 60; md5sum src/*.js` and `until grep -q priorityOption src/cli.js; do sleep 1; done` to wait for each other.

## What the second agent sees

Nothing, until it touches a file another agent is working on. If it edits a file the other agent is mid-edit on:

```
mom: heads-up — src/store.js is also being edited right now by [03f0]. Keep this edit small and local, don't reformat or rewrite the file, and re-Read it before further edits. If you change an interface other code calls (signature, field, flag, export), tell the others: `mom note "<what changed>"`.
```

If it tries to rewrite that file wholesale:

```
mom: BLOCKED — src/store.js is currently held by agent [03f0] (claimed 2m ago, 3 edits so far).
Rewriting the whole file would discard their edits; use the Edit tool for a surgical change instead.
```

If it tries `git add -A`:

```
mom: BLOCKED — 1 other agent is working in this tree; stage only your own files.
Your files this session: README.md src/format.js. Do: `git add README.md src/format.js && git commit -m "..."`
```

If its test run comes back red while another agent is mid-edit, it is told whose files those are, so it doesn't "fix" their half-done work. When another agent releases a file this one touched, it is told to re-read it. These warnings reduce accidental overwrites; advisory edits and arbitrary scripts still depend on cooperation.

## Codex

`mom init-codex` installs native hooks: `apply_patch` edits are claimed like Claude Code edits, and shell commands are screened. The benchmark runner can mix Codex and Claude agents in one checkout (`--codex half`). That measurement is still missing: the ChatGPT plan's usage limit stopped the mixed 8-agent run after one trial. The earlier [Codex pilot](bench/CODEX-RESULTS.md) ran with a host-detection bug, since fixed, that kept Codex claims from holding. See [benchmark methodology](bench/README.md#codex).

## Numbers

Headless agents started five seconds apart in one checkout. Two fixtures:
- **long:** a small todo CLI, three agents with two tasks each (ESM migration, async refactor, a field rename, due dates, priorities, `--json`/`edit`), 32 acceptance checks.
- **shop:** a 17-file order-processing CLI, eight agents with overlapping features and one cross-cutting rename, 45 checks.

n = 10 trials per cell, conditions interleaved, Sonnet 5.5 unless noted. A **bad run** is a final tree that fails any check. Full tables, the older n = 3 results and caveats: [bench/README.md](bench/README.md).

| Scenario | | without mom | with mom |
|---|---|---|---|
| **Fast suite**, 3 agents (the common case) | Bad runs | 0/10 | 0/10 |
| | Turns, cost | 36.0, $0.64 | 34.3, $0.60 |
| **15 s suite**, 3 agents | Bad runs | 1/10 | 1/10 |
| | Cost, wall-clock p90 | $0.55, 195 s | $0.67, 201 s |
| **Haiku 5.5**, 3 agents | Bad runs | 0/10 | 0/10 |
| | Turns, cost | 100, $0.10 | 117, $0.11 |
| **8 agents**, 17-file repo (v0.5, 2026-11-06) | Bad runs | 1/10 | 1/10 |
| | Cost | $1.08 | $1.18 |

v0.5.1, 2026-11-10, except the 8-agent row. Baselines and mom runs were measured hours apart on the same day.

What this says, honestly:

- **mom is close to free when nothing goes wrong.** In the common case it now matches no-mom on turns and cost. Getting here took three fixes in v0.5.1: the shell stale-write check had been blocking `sed -i` and read-then-write scripts, which work on the file's current text and can't lose anyone's change. That cost +55% turns (56 vs 36). On the slow suite and Haiku it still costs 15–20% more.
- **Strong models rarely need saving.** Bad-run rates are about 0–1 in 10 with or without mom, for Sonnet and, on 2026-11-10, for Haiku. mom's measurable value is in the rare run that goes wrong: one v0.5.1 trial lost a feature to a blind `cat >` overwrite, which mom now blocks.
- **Some earlier claims did not replicate.** "mom rescues Haiku" (4 of 11 bad without it, 2026-11-06) was 0 of 10 on 2026-11-10. At n = 3, mom seemed to stop agents abandoning a slow suite; at n = 10 it doesn't. Blocking `git add -A`/stash/reset is deterministic and doesn't depend on sampling.
- **Caveats.** Two small synthetic repos, tasks that finish in minutes. Mixed Claude + Codex runs are not measured: the Codex plan's quota ran out after one 8-agent trial pair, twice. Benchmark PRs on real repos are the most useful contribution.

## How it works

Every file an agent edits is **claimed** for that agent until its turn ends. Claims are one small JSON file each, created with `O_EXCL`, so *checking* whether a file is free and *taking* it is one atomic operation. A short-lived filesystem mutex also serializes stale replacement, renewal and cleanup; see [recovery](docs/other-agents.md#recovery).

| Failure mode | What mom does |
|---|---|
| Both agents see a file as free at the same moment | Check-and-claim is a single atomic `open(O_EXCL)`. |
| An agent rewrites a file someone else is mid-edit on | Whole-file overwrites of a held file (`Write`, `cat >`, `tee`, `cp`, scripts that write without reading) are blocked. In-place changes (`Edit`, `sed -i`, scripts that read the file and then write it) go through with a one-time heads-up to both sides, because they apply to the file's current text. |
| An agent overwrites a file with an old copy | A shell overwrite of a file another agent changed since this agent last read it (or since it started, if it never read it) is blocked until it re-reads. |
| An agent commits other agents' half-finished work | `git add -A`, `commit -a`, `stash`, `checkout .`, `reset`, `update-ref` are blocked while another agent has files in play, with the exact `git add <your files>` to run instead. A plain commit that includes a file someone is mid-edit on gets a heads-up naming them. |
| An agent crashes holding files | Claims die with their owner's process; reservations expire after 15 idle minutes. A state mutex serializes claim replacement and garbage collection. |
| Two files depend on a changing interface | `mom note "<what changed>"` reaches agents that share a file with the sender after their next tool call. |
| An agent read a file that another agent then changed | Releasing an edited file logs a handoff; others are told once to re-read it. |
| Idle agents hog files | The Stop hook releases everything at end of turn; the next edit re-claims. |
| Two waiters hold what the other wants | `mom wait` detects the cycle within seconds; the agent that joined later yields. |

Two modes. **Advisory** (default) blocks only the destructive moves above and warns on the rest. **Strict** (`MOM_MODE=strict` or `mom init --mode strict`) also blocks every edit to a held file and every commit that includes a file under edit; it is for agents that rewrite whole files or don't re-read.

**Silent unless files overlap.** An agent working alone, or alongside agents on different files, hears nothing from mom. It speaks only on a collision: an overlapping edit, a block, or a note or handoff that concerns a file the agent has touched. Tree-wide git commands count as overlap when another agent has files in play, because they sweep up those files too. `mom init --brief full` (or `MOM_BRIEF=full`) opts in to the opposite: the whole protocol at session start whenever others are present, and status with every prompt. It costs up to 2× the turns. It was meant for weaker models, but in the 2026-11-10 runs Haiku did as well without it.

A claim with edits blocks others only while its holder keeps editing the file: after 90 s without edits (`MOM_IDLE_SEC`) it goes cold, and the next taker is told to re-read. Without this, agents in a headless run (where one turn is the whole run) waited on each other until they timed out. Claims taken with `mom begin` (hookless agents) are held until released.

## Commands

```
mom status [--json]              who is here, who holds what, recent notes
mom plan "<goal>" [files...]     announce your work; reserve files
mom note "<text>"                broadcast an interface change
mom begin <files...> [--wait]    claim and register hookless edits
mom mine [--json|--null]          files registered for editing (not hunk ownership)
mom init-codex                   install project Codex hooks (trust via /hooks)
mom claim <files...> [--wait]    reserve files (hooks do this automatically for Edit/Write)
mom wait <file> [--timeout S]    block until a file is free and nobody is mid-edit on it
mom release <files...> | --all   hand files back early
mom who <file>                   who holds a file
mom inbox                        updates from others since you last looked
mom log                          raw event log
mom where                        where this checkout's state lives
mom init [--mode strict] [--brief full]  opt a repo in explicitly: .mom/ in the repo, hooks in .claude/settings.json
```

Environment: `MOM_AGENT` (identity; Claude Code sessions are detected automatically), `MOM_HOME` (state root, default `~/.mom`), `MOM_ROOT`, `MOM_MODE`, `MOM_BRIEF=full`, `MOM_IDLE_SEC` (default 90), `MOM_TTL_SEC` (default 900), `MOM_DISABLE=1`.

## Works with

- **Claude Code**: full enforcement via plugin hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionEnd`). Parallel subagents inside one session are tracked as separate agents.
- **Codex**: `mom init-codex` installs native patch, shell and lifecycle hooks. Review/trust with `/hooks`. See [setup and limits](docs/other-agents.md).
- **Cursor, Aider, humans**: cooperative, through the same CLI; claims taken from any tool are honoured by the Claude Code hooks. See [docs/other-agents.md](docs/other-agents.md).

## Design principles

- **Deterministic over clever.** Overlap detection is a string comparison; the participating agents, not a referee model, decide who yields.
- **Zero cost when alone, near-zero when nobody collides.** No agents present → hooks print nothing. Others present → two lines once, then silence until a collision.
- **Block the destructive, warn on the rest.** v0.1 blocked every overlapping edit and was slower for no gain; v0.4 tried blocking commits on files under edit and agents waited out their timeouts and gave up. Both are now advisory.
- **The board is derived, not edited.** A shared STATUS.md would be its own race. `mom status` renders from the claim files.
- **Plain files you can `cat`.** `mom where` shows the directory. Delete it to reset.

More in [docs/design.md](docs/design.md).

## FAQ

**Why not git worktrees?** Use them when tasks are independent. mom is for when they are not (two features touching the same modules), or when you don't want to plan ahead. Worktrees each get their own mom state, so the two compose.

**Does it touch my repo?** No. State is keyed by the checkout's path under `~/.mom/`. `mom init` is the opt-in alternative that puts `.mom/` (git-ignored) in the repo so non-Claude tools can share it.

**What if an agent needs a file someone else holds for a long time?** `mom wait <file>` blocks up to 3 minutes by default and returns early with instructions if it detects a circular wait. `mom claim --steal <file>` exists for when the holder is clearly gone but its process is still alive.

**Does this slow Claude Code down?** One Node process start (~40 ms) per hooked tool call. In the benchmark's common case, coordinated agents used the same number of turns as uncoordinated ones.

**Does it work on Windows?** Claims and hooks are plain Node; liveness falls back to heartbeats where `kill -0` isn't meaningful. Untested so far; issues welcome.

## License

MIT
