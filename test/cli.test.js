'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'mom.js');
function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-test-'));
  fs.mkdirSync(path.join(dir, '.mom', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.mom', 'claims'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.js'), '1'); fs.writeFileSync(path.join(dir, 'b.js'), '2');
  return dir;
}
function run(dir, args, { as, stdin, env = {} } = {}) {
  const r = cp.spawnSync('node', [BIN, ...args], { cwd: dir, input: stdin, encoding: 'utf8', env: { ...process.env, MOM_MODE: 'strict', MOM_AGENT: as || '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '', ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const hookIn = (sid, extra) => JSON.stringify({ session_id: sid, cwd: extra.cwd, hook_event_name: 'x', ...extra });

test('plan claims files; second agent is blocked on overlap, free elsewhere', () => {
  const d = mk();
  let r = run(d, ['plan', 'add priorities', 'a.js', 'b.js'], { as: 'A' });
  assert.equal(r.code, 0); assert.match(r.out, /claimed: a.js b.js/);
  r = run(d, ['claim', 'a.js'], { as: 'B' });
  assert.equal(r.code, 3); assert.match(r.out, /BLOCKED a.js/);
  r = run(d, ['claim', 'c.js'], { as: 'B' });
  assert.equal(r.code, 0); assert.match(r.out, /claimed c.js/);
  r = run(d, ['status'], { as: 'B' });
  assert.match(r.out, /2 agents active/); assert.match(r.out, /"add priorities"/);
});

test('release hands off; waiter sees stale-read warning only if modified', () => {
  const d = mk();
  run(d, ['claim', 'a.js'], { as: 'A' });
  run(d, ['status'], { as: 'B' }); run(d, ['claim', 'b.js'], { as: 'B' }); // B joins now, so it will see A's handoff
  // simulate an edit via hook (marks modified)
  let r = run(d, ['hook', 'pre-edit'], { stdin: hookIn('A', { cwd: d, tool_name: 'Edit', tool_input: { file_path: path.join(d, 'a.js') } }) });
  assert.equal(r.code, 0);
  r = run(d, ['release', 'a.js'], { as: 'A' });
  assert.match(r.out, /released a.js/);
  r = run(d, ['claim', 'a.js'], { as: 'B' });
  assert.equal(r.code, 0); assert.match(r.out, /re-read it before editing/);
  r = run(d, ['inbox'], { as: 'B' });
  assert.match(r.out, /released edited file: a.js/);
});

test('hook pre-edit blocks other agent with exit 2 and names the holder plan', () => {
  const d = mk();
  run(d, ['plan', 'rename Store.add', 'a.js'], { as: 'A' });
  const r = run(d, ['hook', 'pre-edit'], { stdin: hookIn('B', { cwd: d, tool_name: 'Write', tool_input: { file_path: 'a.js' } }) });
  assert.equal(r.code, 2);
  assert.match(r.err, /BLOCKED — a.js is currently held by agent \[A\] "rename Store.add"/);
  // B can edit b.js; it gets auto-claimed
  const r2 = run(d, ['hook', 'pre-edit'], { stdin: hookIn('B', { cwd: d, tool_name: 'Write', tool_input: { file_path: 'b.js' } }) });
  assert.equal(r2.code, 0);
  assert.match(run(d, ['who', 'b.js']).out, /held by \[B\]/);
});

test('pre-bash blocks tree-wide git ops and shell writes to held files only when others present', () => {
  const d = mk();
  // alone: allowed
  let r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'git stash' } }) });
  assert.equal(r.code, 0);
  run(d, ['plan', 'x', 'a.js'], { as: 'B' });
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'git stash' } }) });
  assert.equal(r.code, 2); assert.match(r.err, /git stash/);
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m x' } }) });
  assert.equal(r.code, 2);
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: "sed -i 's/x/y/' a.js" } }) });
  assert.equal(r.code, 2); assert.match(r.err, /writes a.js/);
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'cat a.js && node --test' } }) });
  assert.equal(r.code, 0);
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'git add b.js && git commit -m x' } }) });
  assert.equal(r.code, 0);
});

test('stop releases claims and post-tool delivers inbox once', () => {
  const d = mk();
  run(d, ['hook', 'pre-edit'], { stdin: hookIn('A', { cwd: d, tool_input: { file_path: 'a.js' } }) });
  run(d, ['hook', 'post-tool'], { stdin: hookIn('B', { cwd: d }) }); // registers B, sets cursor
  run(d, ['note', 'Store.add now takes an object'], { as: 'A' });
  run(d, ['hook', 'stop'], { stdin: hookIn('A', { cwd: d }) });
  assert.match(run(d, ['who', 'a.js']).out, /free/);
  let r = run(d, ['hook', 'post-tool'], { stdin: hookIn('B', { cwd: d }) });
  const j = JSON.parse(r.out);
  assert.equal(j.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(j.hookSpecificOutput.additionalContext, /note: Store.add now takes an object/);
  assert.match(j.hookSpecificOutput.additionalContext, /released edited file: a.js/);
  r = run(d, ['hook', 'post-tool'], { stdin: hookIn('B', { cwd: d }) });
  assert.equal(r.out, '', 'inbox delivered only once');
});

test('dead agent claims are reclaimable; concurrent claimers: exactly one wins', () => {
  const d = mk();
  // dead agent: fake pid that is not alive, old heartbeat
  fs.writeFileSync(path.join(d, '.mom', 'agents', 'DEAD.json'), JSON.stringify({ id: 'DEAD', host: os.hostname(), pid: 999999, heartbeat: 0, started: 0 }));
  fs.writeFileSync(path.join(d, '.mom', 'claims', 'a%2Ejs.json'), JSON.stringify({ path: 'a.js', agent: 'DEAD', since: 0, expires: Date.now() + 1e9, modified: true }));
  const r = run(d, ['claim', 'a.js'], { as: 'A' });
  assert.equal(r.code, 0);
  // race: 8 agents claim b.js simultaneously
  const procs = [];
  for (let i = 0; i < 8; i++) procs.push(cp.spawn('node', [BIN, 'claim', 'b.js'], { cwd: d, env: { ...process.env, MOM_AGENT: 'R' + i, CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '' } }));
  return Promise.all(procs.map(p => new Promise(res => p.on('exit', res)))).then(codes => {
    assert.equal(codes.filter(c => c === 0).length, 1, 'exactly one winner');
    assert.equal(codes.filter(c => c === 3).length, 7);
  });
});

test('wait detects a circular wait and tells the later agent to yield within seconds', () => {
  const d = mk();
  run(d, ['plan', 'first', 'a.js'], { as: 'A' });
  // A is waiting for b.js, which B holds; B then waits for a.js -> cycle. B joined later -> B yields.
  const aRec = JSON.parse(fs.readFileSync(path.join(d, '.mom', 'agents', 'A.json'), 'utf8'));
  aRec.started -= 5000; aRec.waiting_for = 'b.js'; fs.writeFileSync(path.join(d, '.mom', 'agents', 'A.json'), JSON.stringify(aRec));
  run(d, ['plan', 'second', 'b.js'], { as: 'B' });
  const t0 = Date.now();
  const r = run(d, ['wait', 'a.js', '--timeout', '60'], { as: 'B' });
  assert.ok(Date.now() - t0 < 10000, 'returned quickly, did not wait for timeout');
  assert.equal(r.code, 4);
  assert.match(r.out, /DEADLOCK on a.js/); assert.match(r.out, /release b.js/);
  // B's waiting_for was cleared
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, '.mom', 'agents', 'B.json'), 'utf8')).waiting_for, null);
});

test('advisory mode: surgical Edit on a held file is allowed with a one-time warning; whole-file Write is blocked; holder is told', () => {
  const d = mk();
  const env = { MOM_MODE: 'advisory' };
  run(d, ['hook', 'pre-edit'], { stdin: hookIn('A', { cwd: d, tool_name: 'Edit', tool_input: { file_path: 'a.js' } }), env });
  run(d, ['hook', 'post-tool'], { stdin: hookIn('A', { cwd: d }), env }); // A's inbox cursor
  let r = run(d, ['hook', 'pre-edit'], { stdin: hookIn('B', { cwd: d, tool_name: 'Edit', tool_input: { file_path: 'a.js' } }), env });
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /heads-up — a.js is also being edited/);
  r = run(d, ['hook', 'pre-edit'], { stdin: hookIn('B', { cwd: d, tool_name: 'Edit', tool_input: { file_path: 'a.js' } }), env });
  assert.equal(r.code, 0); assert.equal(r.out, '', 'warned only once');
  r = run(d, ['hook', 'pre-edit'], { stdin: hookIn('B', { cwd: d, tool_name: 'Write', tool_input: { file_path: 'a.js', content: 'x' } }), env });
  assert.equal(r.code, 2); assert.match(r.err, /Rewriting the whole file/);
  r = run(d, ['hook', 'pre-edit'], { stdin: hookIn('B', { cwd: d, tool_name: 'Write', tool_input: { file_path: 'new.js', content: 'x' } }), env });
  assert.equal(r.code, 0, 'Write of a new file is fine');
  r = run(d, ['hook', 'post-tool'], { stdin: hookIn('A', { cwd: d }), env });
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /\[B\] also edited a.js, which you hold/);
});

test('hook is a silent no-op when mom is not initialized', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-none-'));
  const r = run(d, ['hook', 'pre-edit'], { stdin: hookIn('A', { cwd: d, tool_input: { file_path: 'x.js' } }) });
  assert.equal(r.code, 0); assert.equal(r.out, '');
});

test('init installs hooks idempotently and gitignores state', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-init-'));
  cp.execSync('git init -q', { cwd: d });
  let r = run(d, ['init', '--no-skill']);
  assert.equal(r.code, 0);
  const s = JSON.parse(fs.readFileSync(path.join(d, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.hooks.PreToolUse.length, 2);
  r = run(d, ['init', '--no-skill']);
  const s2 = JSON.parse(fs.readFileSync(path.join(d, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s2.hooks.PreToolUse.length, 2, 'idempotent');
  assert.match(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), /\.mom\//);
});

test('zero-config: a git repo without .mom/ keeps state under MOM_HOME, never in the repo', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-global-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-home-'));
  cp.execSync('git init -q', { cwd: d }); fs.writeFileSync(path.join(d, 'a.js'), '1');
  const env = { MOM_HOME: home };
  let r = run(d, ['plan', 'x', 'a.js'], { as: 'A', env });
  assert.equal(r.code, 0); assert.match(r.out, /claimed: a.js/);
  assert.ok(!fs.existsSync(path.join(d, '.mom')), 'nothing written into the repo');
  assert.match(run(d, ['where'], { env }).out, new RegExp('^' + home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // hooks are live there too
  r = run(d, ['hook', 'pre-edit'], { stdin: hookIn('B', { cwd: d, tool_name: 'Write', tool_input: { file_path: 'a.js' } }), env });
  assert.equal(r.code, 2);
  // a subdirectory resolves to the same state
  fs.mkdirSync(path.join(d, 'sub'));
  assert.match(run(path.join(d, 'sub'), ['who', 'a.js'], { env }).out, /held by \[A\]/);
  // not a repo at all: hooks are silent, CLI explains
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-plain-'));
  r = run(plain, ['hook', 'pre-edit'], { stdin: hookIn('B', { cwd: plain, tool_input: { file_path: 'x.js' } }), env });
  assert.equal(r.code, 0); assert.equal(r.out, '');
  r = run(plain, ['status'], { env }); assert.equal(r.code, 1); assert.match(r.err, /not inside a git repository/);
});

test('commit hygiene: git add -A names your own files; committing a file someone is mid-edit on is blocked; released files only warn once', () => {
  const d = mk();
  cp.execSync('git init -q && git -c user.email=a@a -c user.name=a add -A && git -c user.email=a@a -c user.name=a commit -qm init', { cwd: d });
  const edit = (who, f) => run(d, ['hook', 'pre-edit'], { stdin: hookIn(who, { cwd: d, tool_name: 'Edit', tool_input: { file_path: f } }) });
  edit('A', 'a.js'); edit('B', 'b.js');
  assert.equal(run(d, ['mine'], { as: 'A' }).out, 'a.js');
  let r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m x' } }) });
  assert.equal(r.code, 2); assert.match(r.err, /Your files this session: a.js/); assert.match(r.err, /git add a.js && git commit/);
  // A stages b.js, which B holds with uncommitted edits -> blocked (this test runs in strict mode)
  fs.writeFileSync(path.join(d, 'b.js'), '3'); cp.execSync('git add b.js', { cwd: d });
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }) });
  assert.equal(r.code, 2); assert.match(r.err, /b.js has edits in progress by \[B\]/); assert.match(r.err, /git restore --staged b.js/);
  // B's turn ends -> release; now the commit is allowed with a one-time heads-up
  run(d, ['hook', 'stop'], { stdin: hookIn('B', { cwd: d }) });
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }) });
  assert.equal(r.code, 0); assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /b.js was also edited this session by \[B\]/);
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }) });
  assert.equal(r.code, 0); assert.equal(r.out, '', 'warned once');
  // reset without pathspec and ref surgery are blocked; reset of a path is fine
  for (const c of ['git reset -q', 'git reset HEAD~1', 'git update-ref refs/heads/main abc']) {
    r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: c } }) });
    assert.equal(r.code, 2, c);
  }
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'git restore --staged b.js' } }) });
  assert.equal(r.code, 0);
});

test('SubagentStop releases that subagent\'s claims only', () => {
  const d = mk();
  run(d, ['hook', 'pre-edit'], { stdin: hookIn('S', { cwd: d, tool_name: 'Edit', tool_input: { file_path: 'a.js' } }) });
  run(d, ['hook', 'pre-edit'], { stdin: hookIn('S', { cwd: d, agent_id: 'sub1', tool_name: 'Edit', tool_input: { file_path: 'b.js' } }) });
  assert.match(run(d, ['who', 'b.js']).out, /held by \[Ssub\]|held by \[S\.su/);
  run(d, ['hook', 'session-end'], { stdin: hookIn('S', { cwd: d, agent_id: 'sub1' }) });
  assert.match(run(d, ['who', 'b.js']).out, /free/);
  assert.match(run(d, ['who', 'a.js']).out, /held by \[S\]/);
});

test('commit gate sees through `git add $(mom mine) && git commit`, counts in-turn overlap edits, and `mom wait` waits them out', () => {
  const d = mk();
  cp.execSync('git init -q && git -c user.email=a@a -c user.name=a add -A && git -c user.email=a@a -c user.name=a commit -qm init', { cwd: d });
  const env = { MOM_MODE: 'advisory' };
  const edit = (who, f) => run(d, ['hook', 'pre-edit'], { stdin: hookIn(who, { cwd: d, tool_name: 'Edit', tool_input: { file_path: f } }), env });
  const bash = (who, command) => run(d, ['hook', 'pre-bash'], { stdin: hookIn(who, { cwd: d, tool_name: 'Bash', tool_input: { command } }), env });
  edit('A', 'a.js'); edit('B', 'a.js'); // B's edit is an advisory overlap: A keeps the claim
  fs.writeFileSync(path.join(d, 'a.js'), 'changed');
  // a bare mom call is never inspected; a git command with $(mom mine) inside is
  assert.equal(bash('A', 'mom status').out, '');
  let r = bash('A', 'git add $(mom mine) && git commit -m x');
  assert.equal(r.code, 0, 'advisory: commit goes through');
  assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /a.js has edits in progress by \[B\]/);
  r = bash('A', 'cd ' + d + ' && git add a.js && git commit -m x');
  assert.equal(r.code, 0); assert.equal(r.out, '', 'same warning not repeated');
  // B's turn ends -> its edit is no longer in progress -> no warning about in-progress edits
  run(d, ['hook', 'stop'], { stdin: hookIn('B', { cwd: d }), env });
  r = bash('A', 'git add a.js && git commit -m x');
  assert.equal(r.code, 0); assert.doesNotMatch(r.out, /in progress/);
  // wait: A holds a.js itself; B edits again in a new turn; A's wait returns once B's turn ends
  edit('B', 'a.js');
  const t0 = Date.now();
  // end B's turn in 2.5s from a detached shell (the wait below is synchronous and would block a setTimeout)
  cp.spawn('bash', ['-c', `sleep 2.5; printf '%s' '${hookIn('B', { cwd: d })}' | node "${BIN}" hook stop`], { cwd: d, env: { ...process.env, ...env, MOM_AGENT: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '' }, stdio: 'ignore', detached: true }).unref();
  r = run(d, ['wait', 'a.js', '--timeout', '20'], { as: 'A', env });
  assert.equal(r.code, 0); assert.ok(Date.now() - t0 >= 2000 && Date.now() - t0 < 15000, 'waited for B\'s turn, not the timeout');
  assert.match(r.err, /in-progress edits by \[B\]/);
});

test('locate: nearest .mom/.git wins and the global state home is never mistaken for in-repo state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-home2-'));
  // repo nested under the directory that holds MOM_HOME (the realistic case: ~/.mom above ~/code/repo)
  const repo = path.join(home, 'code', 'repo'); fs.mkdirSync(repo, { recursive: true });
  cp.execSync('git init -q', { cwd: repo }); fs.writeFileSync(path.join(repo, 'a.js'), '1');
  const env = { MOM_HOME: path.join(home, '.mom') };
  fs.mkdirSync(path.join(home, '.mom', 'repos'), { recursive: true });
  let r = run(repo, ['plan', 'x', 'a.js'], { as: 'A', env });
  assert.match(r.out, /claimed: a.js/);
  assert.match(run(repo, ['where'], { env }).out, /\.mom\/repos\/[0-9a-f]+$/);
  assert.ok(!fs.existsSync(path.join(repo, '.mom')));
  // an explicit in-repo .mom/ below a .git ancestor takes precedence for its subtree
  const sub = path.join(repo, 'pkg'); fs.mkdirSync(path.join(sub, '.mom', 'agents'), { recursive: true });
  assert.equal(run(sub, ['where'], { env }).out, path.join(sub, '.mom'));
});
