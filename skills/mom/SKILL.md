---
name: mom
description: What to do when mom warns about or blocks an edit, a git command, or a commit in a checkout other AI agents are editing at the same time; also how to commit safely there. Use when you see a "mom:" heads-up or BLOCKED message, or before committing in a shared checkout. Not needed up front: mom stays silent until agents actually collide.
---

# mom: don't step on other agents' toes

Trusted hooks cover supported edits; shell detection is heuristic. Without hooks, use `mom begin <files>` before reading for an edit, and poll `mom inbox`. Codex workers must use the `--as` identity supplied by their hook context. Nothing is required up front; these habits matter once agents collide.

1. **Announce interface changes.** If you rename, re-sign, or restructure anything another file depends on (function signature, schema, CLI flag, export, config key):
   `mom note "<what changed> -> <what callers must do>"`
2. **Coordinate commits.** Prefer one committer after workers release files and integrated tests pass. `mom mine --json` lists registered files, not hunk authorship. Review the entire staged diff: other workers may have edited the same files or staged other files. Avoid tree-wide staging, stash and reset. Use worktrees for independent commits.
3. **Respect warnings and blocks.**
   - *heads-up: X is also being edited by [a]* (advisory mode, the default): keep your edit small and local, don't reformat or rewrite the file, and Read it again before your next edit to it.
   - *BLOCKED*: you tried to rewrite a whole file someone else is editing, run a tree-wide git command, or the repo runs in strict mode. Do your other files first, or `mom wait <file>` (returns when it is free, or tells you to yield if you are in a circular wait), then **Read it again** before editing.

What the hooks do for you (no action needed):
- Every supported Edit/Write or Codex patch claims the file for you; claims are released when your turn ends, when you exit, or once you have not edited that file for 90 s (whoever takes it next is told to re-read). Don't poll `mom status` in a loop waiting for a file: do other work, or `mom wait <file>` once.
- Whole-file writes to held files are blocked; common shell rewrites are detected heuristically. Arbitrary scripts can bypass detection. So are `git stash`, `git checkout .`, `git reset`, `git add -A`, `git commit -a`, `git update-ref` while another agent has files in play.
- Updates that concern you (notes from agents sharing a file with you, "I finished editing X, which you touched: re-read it", "I also edited X") arrive after your tool calls.

Useful: `mom status` (who holds what), `mom who <file>`, `mom mine` (your files), `mom release <file>` (hand a file back early so a waiting agent can proceed).
