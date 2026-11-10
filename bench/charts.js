#!/usr/bin/env node
'use strict';
// README charts: node bench/charts.js  -> assets/charts/{correctness,tokens,time,versions}.svg
// Every number is read from bench/results-*.jsonl, so the charts regenerate after any new run.
// Invalid trials (quota/credit failures) are dropped; for the concurrency runs, the latest valid row per
// condition and block k is used, as in report-conc.js.
const fs = require('fs'), path = require('path');
const OUT = path.join(__dirname, '..', 'assets', 'charts');
fs.mkdirSync(OUT, { recursive: true });

function rows(tag, cond, opts = {}) {
  if (Array.isArray(tag)) return tag.flatMap(t => rows(t, cond, opts)); // pool several batches
  const { latestPerK = false } = opts;
  const f = path.join(__dirname, `results-${tag}.jsonl`);
  if (!fs.existsSync(f)) return [];
  const all = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(r => r.condition === cond && r.valid !== false && r.max);
  if (!latestPerK) return all;
  const by = {};
  for (const r of all) by[r.k] = r;
  return Object.values(by);
}

// One group per scenario: [without mom, with mom]. `build` marks rows not run on the current release.
const SECTIONS = [
  { title: 'Code: todo CLI, 3 agents, 2 tasks each', groups: [
    { label: 'Sonnet 5.5', base: ['v3-long', 'baseline'], mom: ['v6b-long', 'mom-advisory'] },
    { label: 'Sonnet 5.5, 15 s test suite', base: ['v4-slow', 'baseline'], mom: ['v6b-slow', 'mom-advisory'] },
    { label: 'Haiku 5.5', base: ['v4-haiku', 'baseline'], mom: ['v6b-haiku', 'mom-advisory'] },
    { label: 'Sonnet 5.5 + Codex', base: ['mixed-long', 'baseline'], mom: ['mixed-long', 'mom-advisory'] },
  ] },
  { title: 'Code: 17-file shop CLI, 8 agents, 1 task each', groups: [
    { label: '1 agent at a time', base: ['hl-code-c1', 'baseline'], mom: ['hl-code-c1', 'mom-advisory'], k: true, build: true },
    { label: '3 at a time', base: ['hl-code-c3', 'baseline'], mom: ['hl-code-c3', 'mom-advisory'], k: true, build: true },
    { label: 'All 8 at once', base: [['hl-code-c8', 'v8-code-c8'], 'baseline'], mom: ['v8-code-c8', 'mom-advisory'], k: true },
  ] },
  { title: 'Writing: one manuscript, 6 agents, 1 edit each', groups: [
    { label: '1 agent at a time', base: ['hl-paper-c1', 'baseline'], mom: ['hl-paper-c1', 'mom-advisory'], k: true, build: true },
    { label: '3 at a time', base: ['hl-paper-c3', 'baseline'], mom: ['hl-paper-c3', 'mom-advisory'], k: true, build: true },
    { label: 'All 6 at once', base: [['v8-paper-c6', 'v9-paper-c6'], 'baseline'], mom: [['v8-paper-c6', 'v9-paper-c6'], 'mom-advisory'], k: true },
  ] },
];

const METRICS = {
  correctness: { title: 'Correctness: share of acceptance checks the final shared tree passes', unit: '% of checks', get: r => 100 * r.score / r.max, fmt: v => (v > 99.95 ? '100' : v.toFixed(1)) + '%', max: () => 100, ticks: [0, 25, 50, 75, 100], tick: v => v + '%' },
  tokens: { title: 'Tokens per run, all agents (output + uncached input; cache reads excluded)', unit: 'tokens', get: r => (r.output_tokens + r.input_tokens - r.cache_read_tokens) / 1000, fmt: v => v.toFixed(0) + 'k', tick: v => v + 'k' },
  time: { title: 'Wall-clock per run, first agent start to last agent finish', unit: 'seconds', get: r => r.wall_ms / 1000, fmt: v => v.toFixed(0) + ' s', tick: v => v + ' s' },
};

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const nice = m => { const p = 10 ** Math.floor(Math.log10(m)); return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(x => m / p <= x) * p; };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const STYLE = `<style>
  .surface{fill:#fcfcfb} .t1{fill:#0b0b0b} .t2{fill:#52514e} .t3{fill:#7a7974} .grid{stroke:#e8e7e3} .axis{stroke:#b9b8b2}
  .s1{fill:#2a78d6} .s2{fill:#eb6834} .dot{stroke:#fcfcfb;stroke-width:1.5} .d1{fill:#184f95} .d2{fill:#a8401a}
  text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  @media (prefers-color-scheme: dark){
    .surface{fill:#1a1a19} .t1{fill:#f0efec} .t2{fill:#c3c2b7} .t3{fill:#97968f} .grid{stroke:#2e2e2c} .axis{stroke:#55544f}
    .s1{fill:#3987e5} .s2{fill:#d95926} .dot{stroke:#1a1a19} .d1{fill:#b7d3f6} .d2{fill:#f6c2a8}
  }
</style>`;

// horizontal bar, 4px rounded at the data end, flat on the baseline
const hbar = (x, y, w, h, cls) => { const r = Math.min(4, w, h / 2); return `<path class="${cls}" d="M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z"/>`; };

function chart(key) {
  const M = METRICS[key];
  const data = SECTIONS.map(s => ({ ...s, groups: s.groups.map(g => {
    const b = rows(...g.base, { latestPerK: g.k }).map(M.get), m = rows(...g.mom, { latestPerK: g.k }).map(M.get);
    return { ...g, b, m };
  }) }));
  const all = data.flatMap(s => s.groups.flatMap(g => [...g.b, ...g.m]));
  const xmax = M.max ? M.max() : nice(Math.max(...all) * 1.05);
  const ticks = M.ticks || [0, 1, 2, 3, 4].map(i => +(xmax * i / 4).toPrecision(3));
  const W = 880, LX = 236, RX = W - 76, PW = RX - LX, BH = 13, GAPB = 3, GROUP = 2 * BH + GAPB + 15, SEC = 30;
  const sx = v => LX + PW * Math.min(v, xmax) / xmax;
  let y = 96, body = '';
  for (const s of data) {
    body += `<text class="t1" x="16" y="${y + 14}" font-size="13" font-weight="600">${esc(s.title)}</text>`;
    y += SEC;
    for (const g of s.groups) {
      body += `<text class="t1" x="${LX - 12}" y="${y + BH + 3}" font-size="12.5" text-anchor="end">${esc(g.label)}${g.build ? ' †' : ''}</text>`;
      body += `<text class="t3" x="${LX - 12}" y="${y + BH + 17}" font-size="11" text-anchor="end">n = ${g.b.length} / ${g.m.length}</text>`;
      [[g.b, 's1', 'd1'], [g.m, 's2', 'd2']].forEach(([vals, cls, dcls], i) => {
        const by = y + i * (BH + GAPB);
        if (!vals.length) { body += `<text class="t3" x="${LX + 6}" y="${by + BH - 2}" font-size="11">not run</text>`; return; }
        const mu = mean(vals);
        body += hbar(LX, by, Math.max(1, sx(mu) - LX), BH, cls);
        for (const v of vals) body += `<circle class="dot ${dcls}" cx="${sx(v).toFixed(1)}" cy="${by + BH / 2}" r="3.2"/>`;
        body += `<text class="t1" x="${RX + 12}" y="${by + BH - 2}" font-size="11.5" font-weight="${i ? 600 : 400}">${M.fmt(mu)}</text>`;
      });
      y += GROUP;
    }
    y += 6;
  }
  const top = 96, bottom = y - 6;
  let grid = '';
  for (const t of ticks) grid += `<line class="grid" x1="${sx(t)}" x2="${sx(t)}" y1="${top}" y2="${bottom}"/><text class="t3" x="${sx(t)}" y="${bottom + 16}" font-size="11" text-anchor="middle">${M.tick(t)}</text>`;
  grid += `<line class="axis" x1="${LX}" x2="${LX}" y1="${top}" y2="${bottom}"/>`;
  const H = bottom + 54;
  const legend = `<rect class="s1" x="16" y="58" width="12" height="12" rx="2"/><text class="t2" x="34" y="68.5" font-size="12">Without mom</text>`
    + `<rect class="s2" x="130" y="58" width="12" height="12" rx="2"/><text class="t2" x="148" y="68.5" font-size="12">With mom (v0.5.1 default)</text>`
    + `<text class="t3" x="340" y="68.5" font-size="12">Bar = mean, dots = individual runs</text>`;
  const foot = `<text class="t3" x="16" y="${H - 14}" font-size="11">† ran an earlier build of mom (2026-11-09). n = runs without / with mom. All agents are headless and share one git checkout.</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(M.title)}">${STYLE}`
    + `<rect class="surface" width="${W}" height="${H}" rx="8"/>`
    + `<text class="t1" x="16" y="34" font-size="16" font-weight="600">${esc(M.title)}</text>`
    + legend + grid + body + foot + '</svg>';
}

// Version history in the common case (Sonnet, 3 agents): what the fixes did to cost.
function versions() {
  const series = [
    ['Without mom', 'v3-long', 'baseline', 's1'],
    ['v0.5 as first committed', 'v3-long', 'mom-advisory', 's2'],
    ['v0.5 + in-place-edit fixes', 'v5-long', 'mom-advisory', 's2'],
    ['v0.5.1 (+ blind-overwrite check)', 'v6b-long', 'mom-advisory', 's2'],
  ].map(([label, tag, cond, cls]) => { const rs = rows(tag, cond); return { label, cls, vals: rs.map(r => r.turns), bad: rs.filter(r => r.score < r.max).map(r => Math.round(100 * r.score / r.max)) }; });
  const W = 880, LX = 236, RX = W - 76, PW = RX - LX, BH = 18, STEP = 34;
  const xmax = nice(Math.max(...series.flatMap(s => s.vals)) * 1.05), sx = v => LX + PW * v / xmax;
  let body = '', y = 84;
  for (const s of series) {
    const mu = mean(s.vals);
    body += `<text class="t1" x="${LX - 12}" y="${y + 13}" font-size="12.5" text-anchor="end">${esc(s.label)}</text>`;
    body += hbar(LX, y, sx(mu) - LX, BH, s.cls);
    for (const v of s.vals) body += `<circle class="dot ${s.cls === 's1' ? 'd1' : 'd2'}" cx="${sx(v).toFixed(1)}" cy="${y + BH / 2}" r="3.2"/>`;
    body += `<text class="t1" x="${RX + 12}" y="${y + 13}" font-size="11.5" font-weight="600">${mu.toFixed(1)}</text>`;
    y += STEP;
  }
  const top = 80, bottom = y - 8;
  let grid = '';
  for (let i = 0; i <= 4; i++) { const t = xmax * i / 4; grid += `<line class="grid" x1="${sx(t)}" x2="${sx(t)}" y1="${top}" y2="${bottom}"/><text class="t3" x="${sx(t)}" y="${bottom + 16}" font-size="11" text-anchor="middle">${t}</text>`; }
  grid += `<line class="axis" x1="${LX}" x2="${LX}" y1="${top}" y2="${bottom}"/>`;
  const H = bottom + 48;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Turns per run across mom versions">${STYLE}`
    + `<rect class="surface" width="${W}" height="${H}" rx="8"/>`
    + `<text class="t1" x="16" y="34" font-size="16" font-weight="600">Overhead in the common case: turns per run, Sonnet 5.5, 3 agents, n = 10 each</text>`
    + `<text class="t2" x="16" y="56" font-size="12">${esc(series.some(s => s.bad.length) ? 'Every run passed all 32 checks except: ' + series.filter(s => s.bad.length).map(s => `${s.label.replace(/^\+ /, '')} (one run at ${s.bad.join('%, ')}%)`).join('; ') + '.' : 'Every run passed all 32 checks.')} Bar = mean, dots = individual runs.</text>`
    + grid + body
    + `<text class="t3" x="16" y="${H - 12}" font-size="11">Turns = agent turns summed over the 3 agents. Measured 2026-11-10.</text></svg>`;
}

for (const k of Object.keys(METRICS)) fs.writeFileSync(path.join(OUT, `${k}.svg`), chart(k));
fs.writeFileSync(path.join(OUT, 'versions.svg'), versions());
// a plain-text table of the same numbers, for the README and for anyone who can't read the charts
const lines = ['| Scenario | Runs (without / with) | Fully correct runs | Checks passed | Tokens | Wall-clock |', '|---|---|---|---|---|---|'];
for (const s of SECTIONS) for (const g of s.groups) {
  const b = rows(...g.base, { latestPerK: g.k }), m = rows(...g.mom, { latestPerK: g.k });
  const f = (k, rs) => rs.length ? METRICS[k].fmt(mean(rs.map(METRICS[k].get))) : '–';
  lines.push(`| ${s.title.split(':')[0]}: ${s.title.split(': ')[1].split(',')[0]}, ${g.label}${g.build ? ' †' : ''} | ${b.length} / ${m.length} | ${b.filter(r => r.score === r.max).length}/${b.length} → ${m.filter(r => r.score === r.max).length}/${m.length} | ${f('correctness', b)} → **${f('correctness', m)}** | ${f('tokens', b)} → ${f('tokens', m)} | ${f('time', b)} → ${f('time', m)} |`);
}
fs.writeFileSync(path.join(OUT, 'table.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
