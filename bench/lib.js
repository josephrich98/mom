'use strict';
const fs = require('fs');
// Parse one agent's `claude -p --output-format stream-json` transcript into counters.
function parseStream(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const s = { turns: 0, tool_uses: {}, tool_errors: 0, error_kinds: {}, mom_blocks: 0, mom_cmds: 0, test_failures_seen: 0, result: null, text_chars: 0, whole_file_writes: 0, git_treewide: 0, test_runs: 0 };
  const TREEWIDE = /\bgit\s+(stash\b(?!\s+(list|show))|(checkout|restore)\s+(--\s+)?\.(\s|$)|reset\s+--hard|clean\b|add\s+(-A|--all|\.)(\s|$)|commit\s+(-[a-zA-Z]*a\b|--all))/;
  const pending = {}; // tool_use_id -> name
  for (const l of lines) {
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
      s.turns++;
      for (const c of m.message.content) {
        if (c.type === 'tool_use') {
          s.tool_uses[c.name] = (s.tool_uses[c.name] || 0) + 1; pending[c.id] = c.name;
          const command = c.input && c.input.command || '';
          if (c.name === 'Bash' && /\bmom\b/.test(command)) s.mom_cmds++;
          if (c.name === 'Bash' && TREEWIDE.test(command)) s.git_treewide++;
          if (c.name === 'Bash' && /\b(npm|node)\s+(run\s+)?test\b|node\s+--test/.test(command)) s.test_runs++;
          if (c.name === 'Write') s.whole_file_writes++;
        } else if (c.type === 'text') s.text_chars += (c.text || '').length;
      }
    } else if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
      for (const c of m.message.content) {
        if (c.type !== 'tool_result') continue;
        const txt = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
        if (/ℹ fail [1-9]/.test(txt) || /# fail [1-9]/.test(txt)) s.test_failures_seen++;
        if (c.is_error) {
          s.tool_errors++;
          const kind = /mom: BLOCKED/.test(txt) ? 'mom_blocked'
            : /modified since read|has been modified/i.test(txt) ? 'stale_read'
            : /has not been read yet|must read|Read it first/i.test(txt) ? 'read_first'
            : /String to replace not found|old_string/i.test(txt) ? 'edit_mismatch'
            : /exit code|Error:|failed|✖/i.test(txt) ? 'command_failed' : 'other';
          s.error_kinds[kind] = (s.error_kinds[kind] || 0) + 1;
          if (kind === 'mom_blocked') s.mom_blocks++;
        } else if (/mom: BLOCKED/.test(txt)) { s.mom_blocks++; }
      }
    } else if (m.type === 'result') {
      // The agent's final message admits the suite is red (it gave up, or handed the breakage to "other agents").
      s.ended_red = /not green|tests? (are |is |still )?(fail|red)|failing tests?|[1-9]\d* (of \d+ )?tests? fail/i.test(m.result || '') ? 1 : 0;
      s.result = { cost_usd: m.total_cost_usd, duration_ms: m.duration_ms, duration_api_ms: m.duration_api_ms, num_turns: m.num_turns, usage: m.usage, subtype: m.subtype, is_error: m.is_error };
    }
  }
  return s;
}

/** Roll per-agent counters + the checker's verdict into one trial row. */
function summarize(meta, agents, check) {
  const all = Object.values(agents);
  const usage = all.map(a => a.result && a.result.usage || {});
  const sum = k => usage.reduce((n, u) => n + (u[k] || 0), 0);
  const tot = k => all.reduce((n, a) => n + (a[k] || 0), 0);
  return {
    ...meta,
    cost_usd: +all.reduce((n, a) => n + ((a.result && a.result.cost_usd) || 0), 0).toFixed(4),
    output_tokens: sum('output_tokens'), input_tokens: sum('input_tokens') + sum('cache_creation_input_tokens') + sum('cache_read_input_tokens'),
    cache_read_tokens: sum('cache_read_input_tokens'),
    turns: all.reduce((n, a) => n + ((a.result && a.result.num_turns) || 0), 0),
    tool_errors: tot('tool_errors'),
    error_kinds: all.reduce((acc, a) => { for (const [k, v] of Object.entries(a.error_kinds || {})) acc[k] = (acc[k] || 0) + v; return acc; }, {}),
    mom_blocks: tot('mom_blocks'), mom_cmds: tot('mom_cmds'),
    test_failures_seen: tot('test_failures_seen'), test_runs: tot('test_runs'),
    whole_file_writes: tot('whole_file_writes'), git_treewide: tot('git_treewide'), ended_red: tot('ended_red'),
    broken_commits: check.note && check.note.broken_commits, mixed_commits: check.note && check.note.mixed_commits,
    max_turns_hit: all.filter(a => a.result && a.result.subtype && a.result.subtype !== 'success').length,
    score: check.score, max: check.max, tests: check.note && check.note.tests, failed_checks: Object.entries(check.checks || {}).filter(([, v]) => !v).map(([k]) => k),
    agents,
  };
}
function oneLine(s) {
  return `wall ${(s.wall_ms / 1000).toFixed(0)}s  cost $${s.cost_usd}  out_tokens ${s.output_tokens}  turns ${s.turns}  tool_errors ${s.tool_errors} ${JSON.stringify(s.error_kinds)}  red_tests_seen ${s.test_failures_seen}/${s.test_runs}  ended_red ${s.ended_red}  writes ${s.whole_file_writes}  git_treewide ${s.git_treewide}  blocks ${s.mom_blocks}  score ${s.score}/${s.max}  tests ${JSON.stringify(s.tests)}${s.broken_commits != null ? `  broken_commits ${s.broken_commits} mixed ${s.mixed_commits}` : ''}${s.failed_checks.length ? '  FAILED ' + s.failed_checks.join(',') : ''}`;
}
module.exports = { parseStream, summarize, oneLine };
