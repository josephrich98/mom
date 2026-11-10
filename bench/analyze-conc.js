#!/usr/bin/env node
'use strict';
// Analyze the concurrency experiment: node bench/analyze-conc.js <workflow transcript dir> <runs root> [checker]
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [tdir, root, checker = path.join(__dirname, 'check-paper.js')] = process.argv.slice(2);
const OTHER = /(someone|something|another (agent|writer|process|editor|session|person)|other (agent|writer|process|editor)s?|concurrent|simultaneous|at the same time|while I was|under me|since (my|I) (first )?read|changed (between|during)|changed since|file (was|had been|has been) (changed|modified|edited)|in parallel)/i;
const trials = {};
for (const f of fs.readdirSync(tdir).filter(x => /^agent-.*\.jsonl$/.test(x))) {
  const lines = fs.readFileSync(path.join(tdir, f), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const userText = m => typeof m.message.content === 'string' ? m.message.content : m.message.content.map(c => c.text || '').join('');
  const first = lines.find(m => m.type === 'user' && /Your project directory is/.test(userText(m)));
  const p = first && userText(first);
  const m = p && p.match(new RegExp('conc/' + path.basename(path.resolve(root)) + '/(c\\d+-k\\d+)/work')); if (!m) continue;
  const task = p.slice(p.indexOf('Your project directory'), p.indexOf('Your project directory') + 30);
  const a = { task, msgs: 0, out: 0, cw: 0, cr: 0, input: 0, tools: {}, errors: 0, errTxt: [], first: null, last: null, reply: '', failedScripts: 0 };
  const pend = {};
  for (const x of lines) {
    if (x.timestamp) { const t = Date.parse(x.timestamp); if (!a.first || t < a.first) a.first = t; if (!a.last || t > a.last) a.last = t; }
    if (x.type === 'assistant' && x.message) {
      a.msgs++; const u = x.message.usage || {}; a.out += u.output_tokens || 0; a.cw += u.cache_creation_input_tokens || 0; a.cr += u.cache_read_input_tokens || 0; a.input += u.input_tokens || 0;
      for (const c of x.message.content || []) { if (c.type === 'tool_use') { a.tools[c.name] = (a.tools[c.name] || 0) + 1; pend[c.id] = c; } if (c.type === 'text') a.reply = c.text; }
    }
    if (x.type === 'user' && x.message && Array.isArray(x.message.content)) for (const c of x.message.content) if (c.type === 'tool_result') {
      const txt = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
      if (c.is_error) { a.errors++; a.errTxt.push(txt.slice(0, 200)); }
      if (/AssertionError|Traceback|not found|No match|0 replacements/i.test(txt) && !c.is_error) a.failedScripts++;
    }
  }
  (trials[m[1]] = trials[m[1]] || []).push(a);
}
const rows = [];
for (const [id, agents] of Object.entries(trials)) {
  const [, L, k] = id.match(/c(\d+)-k(\d+)/);
  const r = JSON.parse(cp.execFileSync(process.execPath, [checker, path.join(root, id, 'work')], { encoding: 'utf8' }));
  const sum = key => agents.reduce((n, a) => n + a[key], 0);
  const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([x]) => x);
  rows.push({ id, L: +L, k: +k, n: agents.length, score: r.score, max: r.max, failed, out: sum('out'), cw: sum('cw'), cr: sum('cr'), msgs: sum('msgs'), errors: sum('errors'), failedScripts: sum('failedScripts'),
    wall: (Math.max(...agents.map(a => a.last)) - Math.min(...agents.map(a => a.first))) / 1000, agentSec: agents.reduce((n, a) => n + (a.last - a.first) / 1000, 0), mentions: agents.filter(a => OTHER.test(a.reply)).length, tools: agents.reduce((o, a) => { for (const [t, v] of Object.entries(a.tools)) o[t] = (o[t] || 0) + v; return o; }, {}), absw: r.note.abstract_words, agents });
}
rows.sort((a, b) => a.k - b.k || a.L - b.L);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log('id        agents score failed-checks');
for (const r of rows) console.log(r.id.padEnd(9), r.n, `${r.score}/${r.max}`.padEnd(6), `wall ${r.wall.toFixed(0)}s`.padEnd(10), `agent-s ${r.agentSec.toFixed(0)}`.padEnd(13), `out ${r.out}`.padEnd(11), `cw ${r.cw}`.padEnd(11), `msgs ${r.msgs}`.padEnd(8), `err ${r.errors}`.padEnd(6), `scriptfail ${r.failedScripts}`.padEnd(13), `mention ${r.mentions}`.padEnd(10), r.failed.join(' '));
console.log();
const LEVELS = [...new Set(rows.map(r => r.L))].sort((a, b) => a - b);
for (const L of LEVELS) { const g = rows.filter(r => r.L === L);
  console.log(`c${L} n=${g.length}  score ${mean(g.map(r => r.score)).toFixed(1)}  perfect ${g.filter(r => !r.failed.length).length}/${g.length}  wall ${mean(g.map(r => r.wall)).toFixed(0)}s  agent-s ${mean(g.map(r => r.agentSec)).toFixed(0)}  out ${mean(g.map(r => r.out)).toFixed(0)}  cw ${mean(g.map(r => r.cw)).toFixed(0)}  cr ${mean(g.map(r => r.cr)).toFixed(0)}  msgs ${mean(g.map(r => r.msgs)).toFixed(1)}  errors ${mean(g.map(r => r.errors)).toFixed(1)}  scriptfail ${mean(g.map(r => r.failedScripts)).toFixed(1)}  mentions ${mean(g.map(r => r.mentions)).toFixed(1)}  tools ${JSON.stringify(g.reduce((o, r) => { for (const [t, v] of Object.entries(r.tools)) o[t] = (o[t] || 0) + v; return o; }, {}))}`);
}
console.log('\nPaired against c1 by block (Δ = cL - c1):');
for (const L of LEVELS.slice(1)) for (const key of ['score', 'wall', 'agentSec', 'out', 'cw', 'msgs']) {
  const d = [0, 1, 2, 3, 4].map(k => rows.find(r => r.L === L && r.k === k)[key] - rows.find(r => r.L === 1 && r.k === k)[key]);
  console.log(`c${L} ${key.padEnd(9)} mean ${mean(d).toFixed(1).padStart(9)}   per-block ${d.map(x => x.toFixed(0)).join(', ')}`);
}
fs.writeFileSync(path.join(root, 'analysis.json'), JSON.stringify(rows, null, 1));
