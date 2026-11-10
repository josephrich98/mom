#!/usr/bin/env node
'use strict';
// Compare no-mom and mom in the headless concurrency runs: node bench/report-conc.js [tag prefix, default hl]
const fs = require('fs'), path = require('path');
const PREFIX = process.argv[2] || 'hl';
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const tok = r => r.output_tokens + r.input_tokens - r.cache_read_tokens;
const DOMAINS = [['paper', [1, 3, 6]], ['code', [1, 3, 8]]];
for (const [domain, levels] of DOMAINS) {
  console.log('\n== ' + domain);
  for (const L of levels) {
    const file = path.join(__dirname, `results-${PREFIX}-${domain}-c${L}.jsonl`);
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.valid !== false);
    const byKey = {};
    for (const r of rows) byKey[r.condition + '|' + r.k] = r; // the latest valid row per condition and block
    const valid = Object.values(byKey);
    for (const c of ['baseline', 'mom-advisory']) {
      const g = valid.filter(r => r.condition === c).sort((a, b) => a.k - b.k);
      const parts = [
        `c${L} ${c.padEnd(13)} n=${g.length}`,
        `score ${mean(g.map(r => 100 * r.score / r.max)).toFixed(1)}%`,
        `perfect ${g.filter(r => r.score === r.max).length}/${g.length}`,
        `[${g.map(r => r.score).join(',')}]`,
        `wall ${mean(g.map(r => r.wall_ms / 1000)).toFixed(0)}s`,
        `tokens ${(mean(g.map(tok)) / 1000).toFixed(0)}k`,
        `cacheR ${(mean(g.map(r => r.cache_read_tokens)) / 1e6).toFixed(2)}M`,
        `cost $${mean(g.map(r => r.cost_usd)).toFixed(2)}`,
        `turns ${mean(g.map(r => r.turns)).toFixed(0)}`,
        `stale ${mean(g.map(r => (r.error_kinds || {}).stale_read || 0)).toFixed(1)}`,
        `blocks ${mean(g.map(r => r.mom_blocks)).toFixed(1)}`,
        `timeouts ${g.reduce((n, r) => n + (r.timeouts || 0), 0)}`,
      ];
      console.log(parts.join('  '));
    }
    const failing = valid.filter(r => r.score < r.max).map(r => `${r.condition}#k${r.k}:${r.failed_checks.join(' ')}`);
    if (failing.length) console.log('   failing: ' + failing.join(' | ').slice(0, 700));
  }
}
