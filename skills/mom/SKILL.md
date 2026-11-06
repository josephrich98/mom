---
name: mom
description: Coordinate with other AI agents editing the same repository at the same time. Use at the start of any coding task in a repo where another agent or session may be working (parallel sessions, worktree-less teams, CI bots), when you are about to commit in such a repo, and whenever mom warns or blocks an edit.
---

# mom: don't step on other agents' toes

Hooks already enforce the hard rules. Your job is four cheap habits.

1. **Lead with a plan.** Before your first edit:
   `mom plan "<one-line goal>" <files you expect to touch>`
   Others see it immediately and route around you. Update it if the scope changes.
2. **Announce interface changes.** If you rename, re-sign, or restructure anything another file depends on (function signature, schema, CLI flag, export, config key):
   `mom note "<what changed> -> <what callers must do>"`
3. **Commit only your own files, when the tests are green.** `git add $(mom mine) && git commit -m "..."`. Never `git add -A`, `git add .`, or `git commit -a`: the tree holds other agents' half-finished work. If mom warns that a staged file has edits in progress by someone else, make sure the suite is green before committing, or `git restore --staged <file>` and commit the rest.
4. **Respect warnings and blocks.**
   - *heads-up: X is also being edited by [a]* (advisory mode, the default): keep your edit small and local, don't reformat or rewrite the file, and Read it again before your next edit to it.
   - *BLOCKED*: you tried to rewrite a whole file someone else is editing, run a tree-wide git command, or the repo runs in strict mode. Do your other files first, or `mom wait <file>` (returns when it is free, or tells you to yield if you are in a circular wait), then **Read it again** before editing.

What the hooks do for you (no action needed):
- Every Edit/Write claims the file for you; claims are released when your turn ends or you exit.
- Rewriting a file another agent is editing (Write tool, `cat >`, `sed -i`, inline scripts) is blocked. So are `git stash`, `git checkout .`, `git reset`, `git add -A`, `git commit -a`, `git update-ref` while others are present.
- Updates from other agents (plans, notes, "I finished editing X, re-read it", "I also edited X") arrive after your tool calls.

Useful: `mom status` (who holds what), `mom who <file>`, `mom mine` (your files), `mom release <file>` (hand a file back early so a waiting agent can proceed).
