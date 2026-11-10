#!/usr/bin/env node
'use strict';
// Per-trial diagnostics for the headless code runs: node bench/diagnose-conc.js [level]
const fs = require('fs'), path = require('path');
const levels = process.argv[2] ? [+process.argv[2]] : [1, 3, 8];
const sum = (a, f) => a.reduce((n, x) => n + f(x), 0);
for (const L of levels) {
  const rows = fs.readFileSync(path.join(__dirname, `results-hl-code-c${L}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.valid !== false);
  for (const c of ['baseline', 'mom-advisory']) {
    const g = rows.filter(r => r.condition === c).sort((a, b) => a.k - b.k);
    console.log(`\nc${L} ${c}`);
    for (const r of g) {
      console.log(`  k${r.k} ${r.score}/${r.max} wall ${(r.wall_ms / 1000).toFixed(0)}s writes ${r.whole_file_writes} ended_red ${r.ended_red} max_turns ${r.max_turns_hit} no_result ${r.no_result} tests ${JSON.stringify(r.tests)} red_seen ${r.test_failures_seen}/${r.test_runs} mom_cmds ${r.mom_cmds} blocks ${r.mom_blocks} errs ${JSON.stringify(r.error_kinds)}`);
    }
    console.log(`  totals: writes ${sum(g, r => r.whole_file_writes)} ended_red ${sum(g, r => r.ended_red)} max_turns ${sum(g, r => r.max_turns_hit)} no_result ${sum(g, r => r.no_result)}`);
  }
}
// What did baseline agents at 8 actually do, compared with the sequential run?
const runs = path.join(__dirname, 'runs/hl-code-c8/baseline');
const newest = {};
for (const d of fs.readdirSync(runs)) {
  const s = path.join(runs, d, 'summary.json');
  if (!fs.existsSync(s)) continue;
  const j = JSON.parse(fs.readFileSync(s, 'utf8'));
  if (j.valid !== false) newest[j.k] = j;
}
console.log('\nbaseline c8, final-message excerpts of agents that reported another writer or a broken suite:');
const RE = /someone|another (agent|process|session)|other (agent|session)s?|concurrent|at the same time|not mine|not from my/i;
for (const k of Object.keys(newest).sort()) {
  const j = newest[k];
  const tools = {};
  for (const a of Object.values(j.agents)) for (const [t, n] of Object.entries(a.tool_uses || {})) tools[t] = (tools[t] || 0) + n;
  console.log(`k${k} tools ${JSON.stringify(tools)}`);
}
