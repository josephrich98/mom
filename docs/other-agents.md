# Codex and other agents

## Codex native hooks

From the checkout run:

```sh
mom init-codex
```

This merges mom handlers into `.codex/hooks.json`, preserving unrelated hooks.
Trust the project, review and trust the hooks using Codex `/hooks`, then start new sessions. The installed
commands point to this installation of Node and mom; rerun after moving either.
Do not commit machine-specific hook paths for other users to run unchanged.

The adapter handles Codex's `tool_input.command` patch format, including every
file in a multi-file patch and both paths of a rename. Add/delete operations are
treated as destructive; updates use the configured advisory/strict policy.
`MOM_MODE=strict` blocks all patch edits to held files. Advisory permits overlapping
patch updates with warnings; it does not guarantee semantic compatibility.

Session/turn hooks deliver notes and release claims. Identity uses the worker's
transcript path when supplied, falling back to session/agent IDs. Start/prompt
context gives the exact `--as` identity for CLI commands; use it rather than an
inherited `MOM_AGENT` shared by multiple workers. Environments which omit both a
unique transcript path and worker ID cannot distinguish subagents; use separate
sessions or explicit identities there.

Shell detection is heuristic, not a security boundary. Before shell/script edits,
use `mom begin --as <identity> <files>` to register them. Arbitrary scripts, MCP
writers, symlink aliases and external editors can bypass detection. Supported
native patch edits are registered automatically, conservatively before execution;
a failed patch can therefore remain in `mom mine` until the session ends.

State defaults to `~/.mom`. For a sandbox that only permits checkout writes, first
run `mom init --no-hooks --no-skill` to keep state in the git-ignored `.mom/` folder.
The adapter requires a local Node runtime. Remote/cloud hook support varies.
See [Codex hook contracts and trust](https://learn.chatgpt.com/docs/hooks).

## Hookless Codex / Cursor / Aider / humans

Give each worker a unique persistent `MOM_AGENT` value, or pass `--as <id>` on every
command. Add this protocol to that worker's instructions:

```text
- Before reading for an edit, run mom begin <files>. Exit 3 means held: do other
  work or mom begin --wait <file>, then re-read before editing.
- begin conservatively records intended edits and holds them until release or
  owner death. claim is an expiring reservation and does not count as an edit.
- After interface changes: mom note "<what changed>".
- Poll mom inbox between work units; notes aren't pushed without hooks.
- Release promptly after a coherent change: mom release <files>.
- At completion: mom release --all; mom leave.
```

`mom mine --json` and `mom mine --null` safely represent unusual filenames.
It lists files registered for editing, not a verified diff or hunk authorship.
Never assume `git add $(mom mine)` commits only your work: filenames can contain
spaces, other workers can edit the same file, and the index is shared. Prefer one
designated committer after workers release files and the integrated tests pass.
Review the entire staged diff, including files staged by other sessions. Use
worktrees when independent commits are required.

## Recovery

Claims expire or disappear with their owner as before. Claim mutations now use a
short-lived `mutation.lock` directory to serialize replacement, renewal, release
and garbage collection. A crash inside that critical section deliberately fails
closed: commands time out after five seconds instead of stealing the mutex.
Stop all mom users before removing a stranded `mutation.lock` under `mom where`.
Do not mix old and new mom versions in one checkout: older versions ignore it.

When Codex runs through a persistent app-server daemon, process liveness alone cannot detect a vanished individual session. Stop/SessionEnd hooks are the normal cleanup path; inspect and release stale claims if a daemon-backed session disappears without those events.
