#!/usr/bin/env node
'use strict';
// Acceptance checker for bench/fixture-math + bench/tasks-math.json. Usage: node bench/check-math.js <workdir>
const fs = require('fs'), path = require('path');
const work = path.resolve(process.argv[2] || '.');
let t = ''; try { t = fs.readFileSync(path.join(work, 'problems.md'), 'utf8'); } catch {}
let ans = null; try { ans = JSON.parse(fs.readFileSync(path.join(work, 'answers.json'), 'utf8')); } catch {}
const checks = {}, note = {};
// text of "### <name>" up to the next ### or ## heading
const block = name => { const m = t.match(new RegExp(`^### ${name}\\s*\\n([\\s\\S]*?)(?=^##|$(?![\\s\\S]))`, 'm')); return m ? m[1] : ''; };
const sol = b => (b.split(/\*\*Solution\.?\*\*/)[1] || '');
const near = (v, x, tol = 1e-4) => typeof v === 'number' && Math.abs(v - x) <= tol * Math.max(1, Math.abs(x));
const arr = (v, xs) => Array.isArray(v) && v.length === xs.length && v.every((y, i) => near(y, xs[i]));
const P = ans && ans.problems || {}, E = ans && ans.examples || {};
checks.json_valid = !!ans && ans.course === 'MATH 221' && ans.set === 4;
// solvers: answer key + a written solution under each problem that reaches the answer
const probs = {
  1: [near(P.p1, Math.PI), /\\pi|3\.14159/],
  2: [arr(P.p2, [1, 2, 3]), /x\s*=\s*1\b[\s\S]*y\s*=\s*2\b[\s\S]*z\s*=\s*3\b|\(\s*1\s*,\s*2\s*,\s*3\s*\)/],
  3: [arr(P.p3, [2, 5]), /\b2\b[\s\S]*\b5\b|\b5\b[\s\S]*\b2\b/],
  4: [near(P.p4, 56), /\b56\b/],
  5: [near(P.p5, 2 / 11), /2\/11|\\frac\s*\{?2\}?\s*\{?11\}?|\\tfrac\{2\}\{11\}|0\.1818/],
  6: [near(P.p6, 500 * Math.exp(-1.2)), /150\.59|150\.6/],
};
for (const [i, [key, re]] of Object.entries(probs)) {
  const b = block(`Problem ${i}`), s = sol(b);
  checks[`p${i}_key`] = key;
  checks[`p${i}_written`] = !/_To be written\._/.test(b) && s.trim().length > 40 && re.test(s);
  checks[`p${i}_hint`] = /^\*Hint:?\*/m.test(b) && b.search(/^\*Hint/m) < b.search(/\*\*Solution/);
}
// examples: corrected derivations, wrong values gone, key recorded
const e1 = block('Example 1'), e2 = block('Example 2'), e3 = block('Example 3');
checks.e1_fixed = /4\s*e\^\{?2\}?|4e\^2|29\.55/.test(e1) && !/42\.25/.test(e1);
checks.e2_fixed = /=\s*10\b/.test(e2) && !/=\s*11\s*\$/.test(e2);
checks.e3_fixed = /=\s*1\b/.test(e3) && !/=\s*11\b/.test(e3);
checks.e_key = near(E.e1, 4 * Math.E ** 2) && near(E.e2, 10) && near(E.e3, 1);
// logistics
checks.due_old_gone = !/March 6\b/.test(t);
checks.due_new = (t.match(/Monday, March 9/g) || []).length >= 2;
const fs_ = (t.match(/^## Formula sheet\s*\n([\s\S]*?)(?=^## )/m) || [])[1] || '';
checks.formula_sheet = (fs_.match(/^\s*[-*] /gm) || []).length >= 6 && t.indexOf('## Formula sheet') < t.indexOf('## Submission');
// sentinels: text no task should touch; losing one means collateral damage or a lost update
const S = {
  sent_cover: 'Problem Set 4 covers integration, linear systems, eigenvalues, counting, conditional probability and first-order differential equations.',
  sent_conv: 'vectors and matrices are written in bold',
  sent_ta: 'A teaching assistant drafted these examples quickly',
  sent_late: 'Late work loses ten percent per day.',
  sent_collab: 'each student writes up their own solutions.',
  stmt_p1: 'Evaluate $\\int_0^\\pi x \\sin x \\, dx$.',
  stmt_p4: 'How many 5-element subsets of $\\{1, 2, \\ldots, 12\\}$ contain no two consecutive integers?',
  stmt_p5: 'Given that at least one die shows a 5, what is the probability that the sum is 8?',
};
for (const [k, v] of Object.entries(S)) checks[k] = t.includes(v);
checks.struct = ['Worked examples', 'Problems', 'Submission'].every(h => new RegExp(`^## ${h}\\s*$`, 'm').test(t)) && [1, 2, 3, 4, 5, 6].every(i => (t.match(new RegExp(`^### Problem ${i}\\s*$`, 'gm')) || []).length === 1);
note.answers = ans && ans.problems;
const score = Object.values(checks).filter(Boolean).length;
console.log(JSON.stringify({ score, max: Object.keys(checks).length, checks, note }));
