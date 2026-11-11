'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
function install(root, bin) {
  const dir = path.join(root, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hooks.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  cfg.hooks ||= {};
  const command = `${quote(process.execPath)} ${quote(bin)} codex-hook`;
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'SessionEnd', 'Interrupt']) {
    const entries = cfg.hooks[event] ||= [];
    if (!entries.some(e => e.hooks?.some(h => h.command === command))) {
      entries.push({ ...(event === 'PreToolUse' ? { matcher: 'Bash|apply_patch' } : {}), hooks: [{ type: 'command', command, timeout: 10 }] });
    }
  }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`Installed ${file}. Trust the project and review these hooks in Codex /hooks before relying on enforcement. Restart existing sessions. Shell write detection is heuristic; arbitrary scripts and other tools are not mediated.`);
}
function patchPaths(patch) {
  const files = [];
  for (const line of patch.split('\n')) {
    const m = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)\r?$/.exec(line);
    if (m) files.push({ path: m[2].trim(), destructive: m[1] !== 'Update File' });
  }
  return files;
}
function hook(bin) {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const event = input.hook_event_name;
  // Codex subagent tool hooks can share session_id with the parent. Transcript
  // paths distinguish workers even when agent_id isn't present on tool events.
  const transcript = input.agent_transcript_path || input.transcript_path;
  const id = transcript ? `codex-${crypto.createHash('sha256').update(transcript).digest('hex').slice(0, 24)}` :
    input.agent_id ? `${input.session_id}.${input.agent_id}` : input.session_id;
  if (!id) throw new Error('Codex hook lacks session identity');
  const base = { ...input, session_id: id };
  delete base.agent_id;
  const invoke = (sub, extra = {}) => cp.spawnSync(process.execPath, [bin, 'hook', sub], {
    input: JSON.stringify({ ...base, ...extra }), encoding: 'utf8', cwd: input.cwd,
    env: { ...process.env, MOM_AGENT: id },
  });
  const outputs = [];
  // Sent only alongside a collision: a worker with no overlap never hears from mom.
  const identity = `mom: your identity is ${id}; pass \`--as ${id}\` to any mom command (${quote(process.execPath)} ${quote(bin)} <cmd> --as ${id}). If you edit files with shell commands, first run \`begin --as ${id} <files>\` (exit 3 = another worker holds it: do other work first).`;

  const accept = r => {
    if (r.error || r.status !== 0) {
      process.stderr.write(`${r.stderr || r.error || 'mom hook failed'}\n${identity}\n`);
      process.exit(2);
    }
    if (r.stdout.trim()) {
      try { outputs.push(JSON.parse(r.stdout).hookSpecificOutput?.additionalContext || r.stdout.trim()); }
      catch { outputs.push(r.stdout.trim()); }
    }
  };
  if (event === 'PreToolUse' && input.tool_name === 'apply_patch') {
    const files = patchPaths(input.tool_input?.command || '');
    if (!files.length) throw new Error('Cannot identify paths in apply_patch input');
    for (const f of files) accept(invoke('pre-edit', {
      tool_name: f.destructive ? 'Write' : 'Edit',
      tool_input: { file_path: path.resolve(input.cwd, f.path) },
    }));
  } else {
    const sub = { SessionStart: 'session-start', UserPromptSubmit: 'prompt',
      PostToolUse: 'post-tool', Stop: 'stop', Interrupt: 'stop',
      SessionEnd: 'session-end', SubagentStop: 'session-end' }[event] ||
      (event === 'PreToolUse' && input.tool_name === 'Bash' ? 'pre-bash' : null);
    if (sub) accept(invoke(sub));
  }
  if (outputs.length) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: (full ? outputs : [identity, ...outputs]).join('\n') } }));
}
module.exports = { install, hook, patchPaths };
