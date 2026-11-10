#!/usr/bin/env node
'use strict';
// Aggregate bench/results-<tag>.jsonl into a markdown table per condition: means ± sd, plus the tail
// (rate of bad runs, worst score, p90 wall-clock). Invalid trials (harness errors, inactive hooks) are counted and excluded.
//   node bench/report.js bench/results-<tag>.jsonl [--since <ISO date>] [--brief lean|full]
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--')) || path.join(__dirname, 'results.jsonl');
const opt = k => { const i = argv.indexOf('--' + k); return i < 0 ? null : argv[i + 1]; };
let rows = fs.readFileSync(path.resolve(file), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
if (opt('since')) rows = rows.filter(r => String(r.trial) >= opt('since'));
const invalid = {}; for (const r of rows) if (r.valid === false) invalid[r.condition] = (invalid[r.condition] || 0) + 1;
rows = rows.filter(r => r.valid !== false);
const by = {}; for (const r of rows) (by[r.condition] = by[r.condition] || []).push(r);
const order = ['baseline', 'mom-advisory', 'mom-full', 'mom-strict'];
const conds = Object.keys(by).sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
const stat = xs => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)); return { m, sd }; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const fmt = (xs, d = 0, unit = '') => { const { m, sd } = stat(xs); return `${m.toFixed(d)}${unit} ± ${sd.toFixed(d)}`; };
const count = (xs) => `${xs.reduce((a, b) => a + b, 0)}/${xs.length}`;
const metrics = [
  // tail first: this is what mom is for
  ['**Bad runs** (final tree not fully correct)', r => r.bad_run ?? (r.score === r.max ? 0 : 1), 'count'],
  ['Runs with the suite red at the end', r => r.tests && (r.tests.fail > 0 || r.tests.exit !== 0) ? 1 : 0, 'count'],
  ['Worst acceptance score', r => r.score / (r.max || 1) * 100, 'min'],
  ['Agents that quit with the suite red (total)', r => r.ended_red || 0, 'sum'],
  ['Agent timeouts (total)', r => r.timeouts || 0, 'sum'],
  ['Acceptance (% of checks)', r => r.score / (r.max || 1) * 100, 1, '%'],
  ['Wall-clock', r => r.wall_ms / 1000, 0, 's'],
  ['Wall-clock p90', r => r.wall_ms / 1000, 'p90'],
  ['Cost (USD, Claude agents)', r => r.cost_usd, 2, ''],
  ['Output tokens', r => r.output_tokens, 0, ''],
  ['Input tokens (incl. cache)', r => r.input_tokens / 1000, 0, 'k'],
  ['Assistant turns', r => r.turns, 1, ''],
  ['mom commands run by agents', r => r.mom_cmds || 0, 1, ''],
  ['Stale-read / edit-mismatch errors', r => (r.error_kinds.stale_read || 0) + (r.error_kinds.edit_mismatch || 0), 1, ''],
  ['mom BLOCKED', r => r.error_kinds.mom_blocked || r.mom_blocks || 0, 1, ''],
  ['Times an agent saw a red test run', r => r.test_failures_seen || 0, 1, ''],
  ['Test runs', r => r.test_runs || 0, 1, ''],
  ['Whole-file Write calls', r => r.whole_file_writes || 0, 1, ''],
  ['Tree-wide git commands', r => r.git_treewide || 0, 1, ''],
];
let md = `| Metric | ${conds.map(c => `${c} (n=${by[c].length})`).join(' | ')} |\n|---|${conds.map(() => '---').join('|')}|\n`;
for (const [name, f, d, unit] of metrics) {
  md += `| ${name} | ${conds.map(c => {
    const xs = by[c].map(f).filter(x => x != null && !Number.isNaN(x));
    if (!xs.length) return '–';
    if (d === 'count') return count(xs);
    if (d === 'sum') return String(xs.reduce((a, b) => a + b, 0));
    if (d === 'min') return `${Math.min(...xs).toFixed(0)}%`;
    if (d === 'p90') return `${pct(xs, 0.9).toFixed(0)}s`;
    return fmt(xs, d, unit);
  }).join(' | ')} |\n`;
}
if (Object.keys(invalid).length) md += `\nExcluded invalid trials: ${Object.entries(invalid).map(([c, n]) => `${c} ${n}`).join(', ')}\n`;
md += `\nFailed checks by condition:\n`;
for (const c of conds) { const counts = {}; for (const r of by[c]) for (const k of r.failed_checks || []) counts[k] = (counts[k] || 0) + 1; md += `- ${c}: ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}\n`; }
console.log(md);
