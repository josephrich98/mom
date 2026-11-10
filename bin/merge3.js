'use strict';
// Word-level three-way merge, used to undo lost updates: an agent writes a file from an out-of-date copy (a script that
// splices in text it read minutes ago, a whole-file Write) and silently puts back text another agent has since changed.
// base = the file as the writer last saw it, theirs = the file just before the write, mine = the file after it.
// A change base→theirs that the write put back to base (mine still has the base text there) was lost; merge3 restores
// it. Where both sides changed the same words differently, the writer's version stands.

const tokens = s => s.match(/\s+|\w+|[^\s\w]/g) || [];

/** Myers O(ND) diff of two token arrays → change hunks [aStart, aEnd, bStart, bEnd]. */
function diff(a, b) {
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length; while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - s, m = eb - s, max = n + m, off = max + 1, A = i => a[s + i], B = j => b[s + j];
  if (!max) return [];
  const v = new Int32Array(2 * max + 3), trace = [];
  let D = 0;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2)); // state after step d-1, for k in [-d-1, d+1]
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1, y = x - k;
      while (x < n && y < m && A(x) === B(y)) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { D = d; break outer; }
    }
  }
  const same = []; // matched token pairs, collected backwards
  let x = n, y = m;
  for (let d = D; d > 0; d--) {
    const t = trace[d], g = k => t[k + d + 1], k = x - y;
    const pk = (k === -d || (k !== d && g(k - 1) < g(k + 1))) ? k + 1 : k - 1, px = g(pk), py = px - pk;
    const sx = pk === k + 1 ? px : px + 1;
    while (x > sx) { x--; y--; same.push([x, y]); }
    x = px; y = py;
  }
  while (x > 0) { x--; y--; same.push([x, y]); }
  same.reverse();
  const hunks = []; let i = 0, j = 0;
  for (const [mx, my] of [...same, [n, m]]) {
    if (mx > i || my > j) hunks.push([s + i, s + mx, s + j, s + my]);
    i = mx + 1; j = my + 1;
  }
  return hunks;
}

/** Returns null when `mine` lost nothing; else { text, restored: [[baseText, theirText], ...] }. */
function merge3(base, theirs, mine) {
  if (theirs === base || theirs === mine) return null;
  const O = tokens(base), P = tokens(theirs), Q = tokens(mine);
  const hs = [...diff(O, P).map(h => [...h, 'P']), ...diff(O, Q).map(h => [...h, 'Q'])].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const span = (side, from, to, group) => { // the `side` version of O[from, to), applying that side's hunks in the group
    const T = side === 'P' ? P : Q, out = []; let at = from;
    for (const h of group.filter(h => h[4] === side)) { out.push(...O.slice(at, h[0]), ...T.slice(h[2], h[3])); at = h[1]; }
    return out.concat(O.slice(at, to)).join('');
  };
  const out = [], restored = []; let at = 0;
  for (let i = 0; i < hs.length;) {
    const group = [hs[i]]; let end = hs[i][1];
    // overlapping hunks, or insertions at the same point, belong to one group
    while (++i < hs.length && (hs[i][0] < end || (hs[i][0] === end && (hs[i][0] === hs[i][1] || group[group.length - 1][0] === end)))) { group.push(hs[i]); end = Math.max(end, hs[i][1]); }
    const from = group[0][0], sides = new Set(group.map(h => h[4]));
    out.push(O.slice(at, from).join(''));
    if (sides.size === 1 && sides.has('P')) { const p = span('P', from, end, group); out.push(p); restored.push([O.slice(from, end).join(''), p]); }
    else out.push(span('Q', from, end, group)); // only the writer changed it, or both did: the writer's version stands
    at = end;
  }
  out.push(O.slice(at).join(''));
  return restored.length ? { text: out.join(''), restored } : null;
}

module.exports = { merge3, diff, tokens };
