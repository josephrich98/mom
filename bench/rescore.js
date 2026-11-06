#!/usr/bin/env node
'use strict';
// Re-run a scenario's checker over every saved trial (bench/runs/<tag>/<cond>/<trial>/work) and rebuild results-<tag>.jsonl.
// Use after fixing a checker, so all trials of a scenario are scored by the same code.
//   node bench/rescore.js --tag commit --check bench/check-commit.js
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { parseStream, summarize, oneLine } = require('./lib');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : null).filter(Boolean));
const TAG = args.tag || 'default';
const CHECK = path.resolve(args.check || path.join(__dirname, 'check.js'));
const RUNS = path.join(__dirname, 'runs', TAG);
const RESULTS = path.join(__dirname, TAG === 'default' ? 'results.jsonl' : `results-${TAG}.jsonl`);
const rows = [];
for (const cond of fs.readdirSync(RUNS).filter(c => !c.startsWith('_'))) {
  for (const trial of fs.readdirSync(path.join(RUNS, cond)).sort()) {
    const dir = path.join(RUNS, cond, trial), work = path.join(dir, 'work'), sf = path.join(dir, 'summary.json');
    if (!fs.existsSync(work) || !fs.existsSync(sf)) continue;
    let check; try { check = JSON.parse(cp.execFileSync('node', [CHECK, work], { encoding: 'utf8' })); } catch (e) { check = { score: 0, max: 0, error: String(e.stdout || e) }; }
    fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify(check, null, 2));
    const old = JSON.parse(fs.readFileSync(sf, 'utf8'));
    // re-parse the transcripts too, so metrics added to lib.js later apply to old trials
    const agents = {};
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && f !== 'mom-log.jsonl')) {
      const name = f.replace(/\.jsonl$/, '');
      agents[name] = { ...parseStream(path.join(dir, f)), exit: old.agents && old.agents[name] && old.agents[name].exit };
    }
    const s = summarize({ condition: old.condition, tag: old.tag, trial: old.trial, model: old.model, wall_ms: old.wall_ms }, agents, check);
    fs.writeFileSync(sf, JSON.stringify(s, null, 2));
    rows.push({ ...s, agents: undefined });
    console.log(`${cond}/${trial}: ${oneLine(s)}`);
  }
}
fs.writeFileSync(RESULTS, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`wrote ${rows.length} rows to ${path.relative(process.cwd(), RESULTS)}`);
