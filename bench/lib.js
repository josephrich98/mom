'use strict';
const fs = require('fs');
// an actual mom invocation (`mom status`, `node …/mom.js note …`), not a path that happens to contain "mom"
const MOM_CALL = /(^|[;&|(]\s*|\$\(\s*)(mom|node\s+\S*\/mom\.js|\S*\/mom\.js)\s+[a-z]/m;
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
          if (c.name === 'Bash' && MOM_CALL.test(command)) s.mom_cmds++;
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
      // the run itself failed (credit, auth, API error): not an agent outcome; the trial is invalid
      if (m.is_error && m.api_error_status) s.fatal = `${m.api_error_status}: ${String(m.result || '').slice(0, 160)}`;
      s.result = { cost_usd: m.total_cost_usd, duration_ms: m.duration_ms, duration_api_ms: m.duration_api_ms, num_turns: m.num_turns, usage: m.usage, subtype: m.subtype, is_error: m.is_error };
    }
  }
  return s;
}

const ENDED_RED = /not green|tests? (are |is |still )?(fail|red)|failing tests?|[1-9]\d* (of \d+ )?tests? fail/i;
// Parse one agent's `codex exec --json` transcript into the same counters (no cost: Codex doesn't report USD).
function parseCodex(file) {
  let lines = []; try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch {}
  const s = { turns: 0, tool_uses: {}, tool_errors: 0, error_kinds: {}, mom_blocks: 0, mom_cmds: 0, test_failures_seen: 0, result: null, text_chars: 0, whole_file_writes: 0, git_treewide: 0, test_runs: 0 };
  const TREEWIDE = /\bgit\s+(stash\b(?!\s+(list|show))|(checkout|restore)\s+(--\s+)?\.(\s|$)|reset\s+--hard|clean\b|add\s+(-A|--all|\.)(\s|$)|commit\s+(-[a-zA-Z]*a\b|--all))/;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  let last = '', fatal = null;
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    // the run itself failed (usage limit, auth, model error): not an agent outcome; the trial is invalid
    if (e.type === 'turn.failed') fatal = (e.error && e.error.message || 'turn.failed').slice(0, 200);
    if (e.type === 'turn.completed' && e.usage) {
      s.turns++;
      usage.input_tokens += (e.usage.input_tokens || 0) - (e.usage.cached_input_tokens || 0);
      usage.cache_read_input_tokens += e.usage.cached_input_tokens || 0;
      usage.output_tokens += (e.usage.output_tokens || 0);
    }
    const it = e.item; if (e.type !== 'item.completed' || !it) continue;
    s.tool_uses[it.type] = (s.tool_uses[it.type] || 0) + 1;
    if (it.type === 'command_execution') {
      const c = it.command || '', o = it.aggregated_output || '';
      if (MOM_CALL.test(c.replace(/^\/bin\/bash -lc /, ''))) s.mom_cmds++;
      if (TREEWIDE.test(c)) s.git_treewide++;
      if (/\b(npm|node)\s+(run\s+)?test\b|node\s+--test/.test(c)) { s.test_runs++; if (/ℹ fail [1-9]|# fail [1-9]/.test(o)) s.test_failures_seen++; }
      if (/mom: BLOCKED/.test(o)) s.mom_blocks++;
      if (it.exit_code && it.exit_code !== 0) { s.tool_errors++; s.error_kinds.command_failed = (s.error_kinds.command_failed || 0) + 1; }
    } else if (it.type === 'error') {
      s.tool_errors++;
      const kind = /mom: BLOCKED/.test(it.message || '') ? 'mom_blocked' : /verif|stale|context/i.test(it.message || '') ? 'stale_read' : 'other';
      s.error_kinds[kind] = (s.error_kinds[kind] || 0) + 1; if (kind === 'mom_blocked') s.mom_blocks++;
    } else if (it.type === 'agent_message') { last = it.text || ''; s.text_chars += last.length; }
  }
  s.ended_red = ENDED_RED.test(last) ? 1 : 0;
  s.result = { cost_usd: null, num_turns: s.turns, usage, subtype: fatal ? 'error' : 'success' };
  s.fatal = fatal;
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
    no_result: all.filter(a => !a.result).length,
    // a "bad run": the shared tree did not end fully correct (lost work, broken build, or an unfinished feature)
    bad_run: !(check.score === check.max && check.max > 0) ? 1 : 0,
    score: check.score, max: check.max, tests: check.note && check.note.tests, failed_checks: Object.entries(check.checks || {}).filter(([, v]) => !v).map(([k]) => k),
    agents,
  };
}
function oneLine(s) {
  return `${s.valid === false ? 'INVALID ' : ''}${s.timeouts ? `timeouts ${s.timeouts}  ` : ''}wall ${(s.wall_ms / 1000).toFixed(0)}s  cost $${s.cost_usd}  out_tokens ${s.output_tokens}  turns ${s.turns}  tool_errors ${s.tool_errors} ${JSON.stringify(s.error_kinds)}  red_tests_seen ${s.test_failures_seen}/${s.test_runs}  ended_red ${s.ended_red}  writes ${s.whole_file_writes}  git_treewide ${s.git_treewide}  blocks ${s.mom_blocks}  score ${s.score}/${s.max}  tests ${JSON.stringify(s.tests)}${s.broken_commits != null ? `  broken_commits ${s.broken_commits} mixed ${s.mixed_commits}` : ''}${s.failed_checks.length ? '  FAILED ' + s.failed_checks.join(',') : ''}`;
}
module.exports = { MOM_CALL, parseStream, parseCodex, summarize, oneLine };
