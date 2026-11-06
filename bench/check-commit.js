#!/usr/bin/env node
'use strict';
// Acceptance for the "commit" scenario: the 32 long-scenario checks on the final tree, plus an audit of git history.
// A commit is "broken" if its own tree fails `npm test`; "mixed" if its diff touches more than one agent's feature.
const cp = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const work = path.resolve(process.argv[2] || '.');
const base = JSON.parse(cp.execFileSync('node', [path.join(__dirname, 'check-long.js'), work], { encoding: 'utf8' }));
const git = (args, cwd = work) => cp.spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout || '';
const commits = git(['log', '--format=%H%x09%s', '--reverse']).trim().split('\n').filter(Boolean).map(l => { const [h, ...s] = l.split('\t'); return { h, subject: s.join('\t') }; }).slice(1); // drop fixture commit
const FEATURES = {
  esm_async: /\bimport\s|\bexport\s|import\.meta|fs\.promises|async open|static async/,
  rename_due: /\btitle\b|--due|overdue|\bdue\b/,
  priority_json: /priority|--json|\bedit\b/,
};
const audit = [];
for (const c of commits) {
  const diff = git(['show', '--format=', '--unified=0', c.h]).split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).join('\n');
  const files = git(['show', '--format=', '--name-only', c.h]).trim().split('\n').filter(Boolean);
  const feats = Object.entries(FEATURES).filter(([, re]) => re.test(diff)).map(([k]) => k);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-check-'));
  cp.execSync(`git archive ${c.h} | tar -x -C ${JSON.stringify(tmp)}`, { cwd: work, stdio: 'ignore' });
  const t = cp.spawnSync('npm', ['test', '--silent'], { cwd: tmp, encoding: 'utf8', timeout: 120000 });
  audit.push({ sha: c.h.slice(0, 7), subject: c.subject, files, features: feats, tests_green: t.status === 0 });
}
const checks = { ...base.checks };
checks.commits_made = commits.length >= 3;
checks.all_commits_green = commits.length > 0 && audit.every(a => a.tests_green);
// (feature-mixing per commit is reported in `note` only: the keyword heuristic is too loose to score)
const porcelain = git(['status', '--porcelain']).trim().split('\n').filter(Boolean).filter(l => !/todos\.json|node_modules|\.claude\/|\.gitignore|\.mom\//.test(l));
checks.everything_committed = porcelain.length === 0;
const stashes = git(['stash', 'list']).trim().split('\n').filter(Boolean);
checks.no_stash_left = stashes.length === 0;
const keys = Object.keys(checks); const passed = keys.filter(k => checks[k]).length;
console.log(JSON.stringify({ score: passed, max: keys.length, checks, note: { ...base.note, commits: audit, broken_commits: audit.filter(a => !a.tests_green).length, mixed_commits: audit.filter(a => a.features.length > 1).length, uncommitted: porcelain, stashes } }, null, 2));
