#!/usr/bin/env node
'use strict';
// Re-score saved trials (bench/runs/<tag>/<cond>/<trial>/) and rebuild results-<tag>.jsonl.
// Use after fixing a checker or a transcript metric, so every trial of a scenario is scored by the same code.
//   node bench/rescore.js --tag commit --check bench/check-commit.js     re-run the checker and re-parse transcripts
//   node bench/rescore.js --tag n10-long --no-check                      re-parse transcripts only (keep check.json)
// Trial metadata (validity, mom hash, timeouts, …) is kept from summary.json; trials without one (harness errors)
// keep their original row.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { parseStream, parseCodex, summarize, oneLine } = require('./lib');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : null).filter(Boolean));
const TAG = args.tag || 'default';
const CHECK = args.check && path.resolve(args.check);
const RUNS = path.join(__dirname, 'runs', TAG);
const RESULTS = path.join(__dirname, TAG === 'default' ? 'results.jsonl' : `results-${TAG}.jsonl`);
const old = fs.existsSync(RESULTS) ? fs.readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const rows = [], seen = new Set();
for (const cond of fs.readdirSync(RUNS).filter(c => !c.startsWith('_'))) {
  for (const trial of fs.readdirSync(path.join(RUNS, cond)).sort()) {
    const dir = path.join(RUNS, cond, trial), work = path.join(dir, 'work'), sf = path.join(dir, 'summary.json');
    if (!fs.existsSync(sf)) continue;
    const prev = JSON.parse(fs.readFileSync(sf, 'utf8'));
    let check;
    if (CHECK && !args['no-check']) {
      try { check = JSON.parse(cp.execFileSync('node', [CHECK, work], { encoding: 'utf8' })); } catch (e) { check = { score: 0, max: 0, error: String(e.stdout || e) }; }
      fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify(check, null, 2));
    } else check = JSON.parse(fs.readFileSync(path.join(dir, 'check.json'), 'utf8'));
    const agents = {};
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && f !== 'mom-log.jsonl')) {
      const name = f.replace(/\.jsonl$/, '');
      const was = prev.agents && prev.agents[name] || {};
      const cli = was.cli || 'claude';
      agents[name] = { cli, ...(cli === 'codex' ? parseCodex(path.join(dir, f)) : parseStream(path.join(dir, f))), exit: was.exit };
    }
    const meta = { ...prev }; delete meta.agents;
    const fatal = Object.entries(agents).filter(([, a]) => a.fatal).map(([n, a]) => `${n}: ${a.fatal}`);
    if (fatal.length) { meta.valid = false; meta.fatal = fatal; }
    const s = summarize(meta, agents, check);
    fs.writeFileSync(sf, JSON.stringify(s, null, 2));
    rows.push({ ...s, agents: undefined }); seen.add(s.trial);
    console.log(`${cond}/${trial}: ${oneLine(s)}`);
  }
}
for (const r of old) if (!seen.has(r.trial)) rows.push(r); // harness-error rows have no trial directory
fs.writeFileSync(RESULTS, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`wrote ${rows.length} rows to ${path.relative(process.cwd(), RESULTS)}`);
