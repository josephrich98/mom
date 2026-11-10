#!/usr/bin/env node
'use strict';
// Concurrency figure: node bench/fig-conc.js  -> bench/figures/concurrency.svg
// Reads the matched headless runs in results-hl-<domain>-c<level>.jsonl (the latest valid row per condition and block).
const fs = require('fs'), path = require('path');
const load = (d, levels) => levels.flatMap(L => {
  const latest = {};
  for (const l of fs.readFileSync(path.join(__dirname, `results-hl-${d}-c${L}.jsonl`), 'utf8').trim().split('\n')) {
    const r = JSON.parse(l);
    if (r.valid !== false) latest[r.condition + '|' + r.k] = { L, k: r.k, mom: r.condition !== 'baseline', score: r.score, max: r.max, wall: r.wall_ms / 1000, tok: r.output_tokens + r.input_tokens - r.cache_read_tokens };
  }
  return Object.values(latest);
});
const COL = [{ key: 'paper', title: 'Writing', color: '#E0701A', rows: load('paper', [1, 3, 6]), w: 350 }, { key: 'code', title: 'Coding', color: '#2F6FB7', rows: load('code', [1, 3, 8]), w: 350 }, { key: 'math', title: 'Math', color: '#2E9A5B', rows: null, w: 150 }];
const ROWS = [
  { label: 'Score (% of checks passed)', get: r => 100 * r.score / r.max, fix: 100, fmt: v => v.toFixed(v > 99.95 ? 0 : 1) + '%' },
  { label: 'Time (wall-clock, s)', get: r => r.wall, fmt: v => v.toFixed(0) + ' s' },
  { label: 'Tokens (output + cache writes, k)', get: r => r.tok / 1000, fmt: v => v.toFixed(0) + 'k' },
];
const INK = '#23262b', SUB = '#5b616b', MUTE = '#8a9099', GRID = '#e6e7e9', BG = '#ffffff';
const FONT = 'font-family="Helvetica, Arial, sans-serif"';
const W = 1040, L = 78, TOP = 166, PH = 200, GAP = 66, COLGAP = 34;
const H = TOP + ROWS.length * (PH + GAP) + 44;
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const nice = m => { const p = 10 ** Math.floor(Math.log10(m)); const n = m / p; return [1, 1.2, 1.5, 2, 2.4, 3, 4, 5, 6, 8, 10].find(x => n <= x) * p; };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const text = (x, y, s, o = {}) => `<text x="${x}" y="${y}" ${FONT} font-size="${o.size || 12}" fill="${o.fill || SUB}" text-anchor="${o.anchor || 'middle'}"${o.weight ? ` font-weight="${o.weight}"` : ''}>${esc(s)}</text>`;
// bar with a 4px-rounded top anchored flat on the baseline
const barPath = (x, y, w, h) => { const r = Math.min(4, h); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}`; };
let o = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${BG}"/>`;
o += text(L, 34, 'mom protected coding at 8 agents; it did not protect writing', { anchor: 'start', size: 19, fill: INK, weight: 700 });
o += text(L, 56, 'Sonnet agents in separate headless sessions, same tasks at each concurrency level, 5 runs per bar. Time and token axes differ between columns.', { anchor: 'start', size: 13 });
// legend
const lx = L, ly = 80;
o += `<rect x="${lx}" y="${ly}" width="24" height="22" fill="#8a9099" fill-opacity="0.16" stroke="#5b616b" stroke-width="1.6" stroke-dasharray="4 3"/><circle cx="${lx + 12}" cy="${ly + 9}" r="4" fill="${BG}" stroke="#5b616b" stroke-width="1.6"/>`;
o += text(lx + 32, ly + 15, 'No mom: dashed bar = mean, open circles = individual runs', { anchor: 'start', size: 13, fill: INK });
const lx2 = lx + 430;
o += `<rect x="${lx2}" y="${ly}" width="24" height="22" fill="#8a9099"/><circle cx="${lx2 + 12}" cy="${ly + 9}" r="4" fill="${INK}"/>`;
o += text(lx2 + 32, ly + 15, 'With mom: solid bar = mean, closed circles = individual runs', { anchor: 'start', size: 13, fill: INK });
let x0 = L;
for (const C of COL) {
  o += text(x0 + C.w / 2, TOP - 34, C.title, { size: 15, fill: INK, weight: 700 });
  o += `<rect x="${x0 + C.w / 2 - (C.title.length * 4.5) - 16}" y="${TOP - 45}" width="10" height="10" rx="2" fill="${C.color}"/>`;
  ROWS.forEach((R, ri) => {
    const y0 = TOP + ri * (PH + GAP);
    if (!C.rows) {
      o += `<rect x="${x0 + 0.5}" y="${y0 + 0.5}" width="${C.w - 1}" height="${PH - 1}" fill="${C.color}" fill-opacity="0.05" stroke="${C.color}" stroke-opacity="0.45" stroke-dasharray="4 4"/>`;
      o += text(x0 + C.w / 2, y0 + PH / 2 + 4, 'to be done', { size: 13 });
      return;
    }
    const levels = [...new Set(C.rows.map(r => r.L))].sort((a, b) => a - b);
    const vals = C.rows.map(R.get);
    const ymax = R.fix || nice(Math.max(...vals) * 1.12);
    const yOf = v => y0 + PH - (v / ymax) * PH;
    for (let i = 0; i <= 4; i++) { const v = ymax * i / 4, y = yOf(v); o += `<line x1="${x0}" x2="${x0 + C.w}" y1="${y}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`; if (x0 === L || !R.fix) o += text(x0 - 8, y + 4, Math.round(v * 10) / 10, { anchor: 'end', size: 11 }); }
    if (x0 === L) o += `<text transform="translate(18 ${y0 + PH / 2}) rotate(-90)" ${FONT} font-size="12" fill="${SUB}" text-anchor="middle">${esc(R.label)}</text>`;
    const slot = C.w / levels.length, bw = 34;
    levels.forEach((lv, li) => {
      const cx = x0 + slot * (li + 0.5);
      for (const mom of [false, true]) {
        const g = C.rows.filter(r => r.L === lv && r.mom === mom).sort((a, b) => a.k - b.k), m = mean(g.map(R.get));
        const bx = mom ? cx + 3 : cx - bw - 3, top = yOf(m), d = barPath(bx, top, bw, y0 + PH - top);
        if (mom) o += `<path d="${d}Z" fill="${C.color}"/>`;
        else o += `<path d="${d}Z" fill="${C.color}" fill-opacity="0.16"/><path d="${d}" fill="none" stroke="${C.color}" stroke-width="1.8" stroke-dasharray="5 3.5"/>`;
        o += text(bx + bw / 2, Math.min(top, ...g.map(r => yOf(R.get(r)))) - 8, R.fmt(m), { size: 11, fill: INK, weight: 600 });
        g.forEach((r, i) => { const dx = (i - 2) * 6, cy = yOf(R.get(r)); o += mom ? `<circle cx="${bx + bw / 2 + dx}" cy="${cy}" r="4.2" fill="${INK}" stroke="${BG}" stroke-width="1.2"/>` : `<circle cx="${bx + bw / 2 + dx}" cy="${cy}" r="4" fill="${BG}" stroke="${C.color}" stroke-width="1.7"/>`; });
      }
      if (ri === ROWS.length - 1) o += text(cx, y0 + PH + 20, lv, { size: 13, fill: INK });
    });
    if (ri === ROWS.length - 1) o += text(x0 + C.w / 2, y0 + PH + 40, 'Number of agents running at once', { size: 12 });
    o += `<line x1="${x0}" x2="${x0 + C.w}" y1="${y0 + PH}" y2="${y0 + PH}" stroke="${MUTE}" stroke-width="1"/>`;
  });
  x0 += C.w + COLGAP + (C === COL[0] ? 22 : 18);
}
o += '</svg>\n';
fs.writeFileSync(path.join(__dirname, 'figures/concurrency.svg'), o);
