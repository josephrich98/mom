#!/usr/bin/env node
'use strict';
// Controlled lost-update demonstration of the Codex hook protocol, not an LLM evaluation.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const bin = path.resolve(__dirname, '../bin/mom.js');
function run(enforced) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-contention-'));
  try {
    fs.mkdirSync(path.join(dir, '.mom/agents'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.mom/claims'), { recursive: true });
    const file = path.join(dir, 'shared.json'); fs.writeFileSync(file, '{}');
    const read = () => JSON.parse(fs.readFileSync(file));
    const hook = (who, event) => cp.spawnSync(process.execPath, [bin, 'codex-hook'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOM_ROOT: dir, MOM_DISABLE: '', MOM_MODE: 'advisory' },
      input: JSON.stringify({ cwd: dir, session_id: who, transcript_path: path.join(dir, who), hook_event_name: event, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Delete File: shared.json\n*** Add File: shared.json\n+{}\n*** End Patch' } }) });
    const a = read(), b = read(); // Both workers read the same old version.
    if (enforced && hook('A', 'PreToolUse').status !== 0) throw new Error('A unexpectedly blocked');
    a.featureA = true; fs.writeFileSync(file, JSON.stringify(a));
    const denied = enforced && hook('B', 'PreToolUse').status === 2;
    let next = b;
    if (denied) {
      hook('A', 'Stop');
      if (hook('B', 'PreToolUse').status !== 0) throw new Error('B could not acquire after handoff');
      next = read(); // Mandatory re-read after acquiring a handed-off file.
    }
    next.featureB = true; fs.writeFileSync(file, JSON.stringify(next));
    const final = read();
    return { condition: enforced ? 'codex-hooks' : 'baseline', features_preserved: Object.keys(final).length, expected: 2, blocked_stale_rewrite: !!denied };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const results = [run(false), run(true)];
console.log(JSON.stringify({ kind: 'deterministic protocol demonstration; no model calls', results }, null, 2));
if (results[0].features_preserved !== 1 || results[1].features_preserved !== 2 || !results[1].blocked_stale_rewrite) process.exitCode = 1;
