# Design notes

## The problem

Two agents (two Claude Code sessions, a Codex run plus a Cursor tab, a human and a bot…) edit the same checkout. Each one reads a file, thinks, and writes back the whole thing. The second write silently drops the first agent's changes. Worse, agent A runs the tests, sees agent B's half-finished work fail, and "fixes" it. Both burn tokens undoing each other, and the final tree is a coin flip.

Git worktrees avoid this but force a merge later and don't help when the tasks genuinely need the same files.

## The constraint

No heavy prompting. No supervising LLM. An agent working alone must pay nothing. An agent working with others should pay a few hundred tokens total, and only when something relevant happens.

## The design

| Failure mode | Mechanism |
|---|---|
| Both agents check a file and both see it as free | Check-and-claim is one atomic filesystem op: `open(O_EXCL)` on `.mom/claims/<path>.json`. Claim mutation is serialized by a short-lived state mutex; no daemon. |
| An agent crashes while holding files | Each agent record stores the host process pid; a claim is dead the moment its owner's process is gone. Reservations also expire by TTL (15 min, renewed by every hook call). Claims with uncommitted edits never expire while the owner lives. Replacement, renewal, release and garbage collection hold the same state mutex so stale snapshots cannot delete a successor claim. A crashed mutex fails closed; see recovery in other-agents.md. |
| The up-front file list is wrong | Every Edit/Write passes through a PreToolUse hook that claims the file on the spot (or blocks). |
| Two files depend on a changing interface | `mom note "<what changed>"` reaches agents sharing a file with the sender, which receive it as `additionalContext` after their next tool call. |
| An agent read a file that another agent then changed | Releasing an edited file logs a *handoff*. Everyone else is told "re-read X before editing" exactly once. `mom wait` says the same thing when it acquires a file that was handed off. |
| Shell commands bypass the Edit tool | PreToolUse on Bash blocks `sed -i`/`>`/`mv`… aimed at a file someone else holds, and blocks tree-wide git operations (`stash`, `checkout .`, `reset`, `add -A`, `commit -a`, `update-ref`) while another agent has files in play. Reads are never blocked. |
| A commit sweeps up someone else's half-finished edits | Every file an agent edits is remembered for the session (`mom mine`). `git add -A` / `commit -a` are blocked with the exact `git add <your files>` to run instead. A plain `git commit` whose index holds a file another agent is mid-edit on (claimed with edits, or edited during their current turn) gets a one-time heads-up naming the file and the agent; strict mode blocks it. We tried blocking in advisory mode too: agents did the right thing (`mom wait`, twice), timed out because in a shared tree "their turn" can be their whole run, and gave up without committing, for no fewer broken commits than baseline. So: warn, don't block. |
| Idle agents hog files | The Stop hook releases everything at the end of a turn. Claims come back automatically on the next edit. |

## Advisory vs strict (what the benchmark taught us)

v0.1 blocked every edit to a file another agent held. Three Sonnet 5.5 agents on overlapping tasks then took 2–3× longer than uncoordinated agents for identical results, and once deadlocked (A waiting for B's test file, B waiting for A's `store.js`; both timed out and re-waited). Uncoordinated agents were fine because they re-read before every surgical edit and Claude Code's `Edit` tool refuses edits against a stale read.

So the default became **advisory**: a surgical `Edit` to a held file is allowed, both agents get a one-line heads-up (once per file), and the holder is told to re-read. What stays blocked is what actually destroys work: whole-file `Write`, shell rewrites (`cat >`, `sed -i`, inline python/node), and tree-wide git operations. `wait` detects wait-for cycles and makes the later agent yield. Strict mode remains for whole-file writers.

## Silent unless files overlap

v0.4 briefed the whole protocol up front whenever another agent was present and showed a status block with every prompt. With strong models that was pure overhead: about 10–24 `mom` commands and 50–70% more turns per trial, for identical acceptance. A later lean brief still announced other agents at session start.

mom now says nothing at session start or on prompts. An agent alone, or alongside agents on different files, gets no output from any hook. Presence and file records are still written, because that is how a later overlap gets detected.

| Event | What the agent hears |
|---|---|
| its edit overlaps a file another agent is mid-edit on | one heads-up per file; the first one also says how to `mom note` an interface change |
| it tries to destroy someone's work (whole-file Write over a held file, `sed -i`/`cat >` on it) | BLOCKED, with the exact alternative |
| it runs a tree-wide git command while another agent has files in play | BLOCKED, with the exact alternative |
| it stages a file another agent is mid-edit on | one heads-up |
| an agent sharing a file posts a `mom note`, or releases a file this agent has touched | one line |

`--brief full` (`MOM_BRIEF=full`) is the opt-in exception: it keeps the v0.4 up-front protocol, status on every prompt, and delivery of every plan, note and handoff. It doubles the turns, but it was the only setting with no bad Haiku runs (0/10, against 4/11 without mom).

## Idle claims

v0.4 held a claim with edits until the holder's turn ended. In a headless run (`claude -p`, `codex exec`), or any long interactive turn, the turn is the whole run. Haiku agents in lean mode then polled `mom status` for each other's files until 4 of them hit the 20-minute benchmark timeout. Now a claim observed through a hook (Edit/Write/patch) stays hot only while its holder keeps editing that file. After `MOM_IDLE_SEC` (default 90) without edits, it stops blocking and stops showing as mid-edit, and the release is logged as a handoff, so the next taker re-reads. Claims taken with `mom begin` (hookless agents, shell edits) carry no edit timestamps and are held until released or until the owner dies. `mom init --brief full` (or `MOM_BRIEF=full`) restores the v0.4 brief; the benchmark compares both.

## What it costs

- Claude alone: SessionStart prints nothing. Codex gets one identity line.
- With others, no collisions: ~80 tokens once at session start; nothing per prompt.
- With collisions: one line per relevant event; a 2-line BLOCKED message per blocked operation.
- Latency: one Node process start (~40 ms) per hooked tool call.

## Why not a shared Markdown "status board"?

Because two agents editing the same board is the exact race we're trying to fix. The board is derived (`mom status`) rather than edited.

## Why not an MCP server?

A CLI is callable from any agent's shell tool without configuration, and hooks are shell commands anyway. An MCP wrapper is easy to add later if a client can't run shell commands.

## Why no supervising agent?

Overlap detection is a string comparison. The participating agents already have the context to decide who yields. If real traces show negotiation getting stuck, a mom agent can be bolted on; the event log already has everything it would need.

## State layout

```
~/.mom/repos/<sha1 of checkout path>/    default: nothing is written into your repo
  (or <repo>/.mom/ after `mom init`:    shared with non-Claude tools, git-ignored)
  agents/<id>.json     plan, pid, host, heartbeat, inbox cursor, files edited this session
  claims/<path>.json   owner, since, expires, modified, edits
  log.jsonl            join / plan / note / blocked / handoff / leave
  mutation.lock/       short-lived claim mutation mutex
  config.json          cmd (how agents invoke mom here), mode
```

Everything is plain JSON so you can `cat` it when something looks off (`mom where` prints the directory). Each git worktree is its own checkout and gets its own state, which is what you want: worktrees don't collide.

## Why state lives outside the repo by default

The v0.3 `mom init` wrote `.mom/` and `.claude/settings.json` into the repo. The settings file ends up committed, which forces mom on every teammate who clones the repo; and a tool that modifies the repo it is supposed to protect is a hard sell. As a Claude Code plugin, mom's hooks are installed once per user, state is keyed by the checkout's path under `~/.mom/`, and the repo is untouched. `mom init` remains for opting a checkout in explicitly (Codex and Cursor can share the in-repo `.mom/`).

File lists are not hunk ownership. Coordinate one committer for shared-checkout work; review the whole index. Codex adapter coverage and hookless edit registration are described in [other-agents.md](other-agents.md).
