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
const runRaw = run;
const hookIn = (sid, extra) => JSON.stringify({ session_id: sid, cwd: extra.cwd, hook_event_name: 'x', ...extra });

test('claim reserves files; second agent is blocked on overlap, free elsewhere', () => {
  const d = mk();
  let r = run(d, ['claim', 'a.js', 'b.js'], { as: 'A' });
  assert.equal(r.code, 0); assert.match(r.out, /claimed a.js/); assert.match(r.out, /claimed b.js/);
  r = run(d, ['claim', 'a.js'], { as: 'B' });
  assert.equal(r.code, 3); assert.match(r.out, /BLOCKED a.js/);
  r = run(d, ['claim', 'c.js'], { as: 'B' });
  assert.equal(r.code, 0); assert.match(r.out, /claimed c.js/);
  r = run(d, ['status'], { as: 'B' });
  assert.match(r.out, /2 agents active/);
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

test('hook pre-edit blocks other agent with exit 2 and names the holder', () => {
  const d = mk();
  run(d, ['claim', 'a.js'], { as: 'A' });
  const r = run(d, ['hook', 'pre-edit'], { stdin: hookIn('B', { cwd: d, tool_name: 'Write', tool_input: { file_path: 'a.js' } }) });
  assert.equal(r.code, 2);
  assert.match(r.err, /BLOCKED — a.js is currently held by agent \[A\]/);
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
  run(d, ['claim', 'a.js'], { as: 'B' });
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
  const run = (dir, args, o = {}) => runRaw(dir, args, { ...o, env: { MOM_MODE: 'advisory', ...(o.env || {}) } });
  run(d, ['hook', 'pre-edit'], { stdin: hookIn('A', { cwd: d, tool_name: 'Edit', tool_input: { file_path: 'a.js' } }) });
  run(d, ['hook', 'pre-edit'], { stdin: hookIn('B', { cwd: d, tool_name: 'Edit', tool_input: { file_path: 'a.js' } }) }); // B shares a.js
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
  run(d, ['claim', 'a.js'], { as: 'A' });
  // A is waiting for b.js, which B holds; B then waits for a.js -> cycle. B joined later -> B yields.
  const aRec = JSON.parse(fs.readFileSync(path.join(d, '.mom', 'agents', 'A.json'), 'utf8'));
  aRec.started -= 5000; aRec.waiting_for = 'b.js'; fs.writeFileSync(path.join(d, '.mom', 'agents', 'A.json'), JSON.stringify(aRec));
  run(d, ['claim', 'b.js'], { as: 'B' });
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
  assert.equal(s.hooks.PreToolUse.length, 3);
  r = run(d, ['init', '--no-skill']);
  const s2 = JSON.parse(fs.readFileSync(path.join(d, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s2.hooks.PreToolUse.length, 3, 'idempotent');
  assert.match(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), /\.mom\//);
});

test('zero-config: a git repo without .mom/ keeps state under MOM_HOME, never in the repo', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-global-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-home-'));
  cp.execSync('git init -q', { cwd: d }); fs.writeFileSync(path.join(d, 'a.js'), '1');
  const env = { MOM_HOME: home };
  let r = run(d, ['claim', 'a.js'], { as: 'A', env });
  assert.equal(r.code, 0); assert.match(r.out, /claimed a.js/);
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

test('commit hygiene: git add -A names your own files; committing a file someone is mid-edit on is blocked; released files are silent', () => {
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
  // B's turn ends -> release; now the commit is allowed, silently
  run(d, ['hook', 'stop'], { stdin: hookIn('B', { cwd: d }) });
  r = run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }) });
  assert.equal(r.code, 0); assert.equal(r.out, '');
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
  let r = run(repo, ['claim', 'a.js'], { as: 'A', env });
  assert.match(r.out, /claimed a.js/);
  assert.match(run(repo, ['where'], { env }).out, /\.mom\/repos\/[0-9a-f]+$/);
  assert.ok(!fs.existsSync(path.join(repo, '.mom')));
  // an explicit in-repo .mom/ below a .git ancestor takes precedence for its subtree
  const sub = path.join(repo, 'pkg'); fs.mkdirSync(path.join(sub, '.mom', 'agents'), { recursive: true });
  assert.equal(run(sub, ['where'], { env }).out, path.join(sub, '.mom'));
});

test('hookless begin tracks edits, retains dirty claims past TTL, and releases a modified handoff', () => {
  const d = mk();
  assert.equal(run(d, ['begin', 'a.js'], { as: 'A' }).code, 0);
  assert.deepEqual(JSON.parse(run(d, ['mine', '--json'], { as: 'A' }).out), ['a.js']);
  const f = path.join(d, '.mom/claims/a%2Ejs.json');
  const c = JSON.parse(fs.readFileSync(f)); c.expires = 0; fs.writeFileSync(f, JSON.stringify(c));
  assert.equal(run(d, ['begin', 'a.js'], { as: 'B' }).code, 3);
  assert.equal(run(d, ['release', '--all'], { as: 'A' }).code, 0);
  assert.equal(run(d, ['release', '--all'], { as: 'A' }).code, 0);
  assert.match(run(d, ['begin', 'a.js'], { as: 'B' }).out, /re-read/);
});

test('Codex adapter handles multi-file patches, deletes, moves and worker identities', () => {
  const d = mk();
  const invoke = (transcript, event, extra = {}) => run(d, ['codex-hook'], { stdin: JSON.stringify({
    cwd: d, session_id: 'parent', transcript_path: transcript, hook_event_name: event, ...extra,
  }) });
  const patch = command => ({ tool_name: 'apply_patch', tool_input: { command } });
  assert.equal(invoke('/a', 'PreToolUse', patch('*** Begin Patch\n*** Update File: a.js\n*** Move to: moved.js\n*** End Patch')).code, 0);
  assert.equal(invoke('/b', 'PreToolUse', patch('*** Begin Patch\n*** Delete File: moved.js\n*** End Patch')).code, 2);
  const state = JSON.parse(run(d, ['status', '--json'], { as: 'observer' }).out);
  assert.equal(new Set(state.claims.map(c => c.agent)).size, 1);
  assert.deepEqual(state.claims.map(c => c.path).sort(), ['a.js', 'moved.js']);
  assert.equal(invoke('/parent', 'SubagentStop', { agent_id: 'child', agent_transcript_path: '/a' }).code, 0);
  assert.equal(invoke('/b', 'PreToolUse', patch('*** Begin Patch\n*** Update File: a.js\n*** End Patch')).code, 0);
});

test('Codex installation preserves other hooks and is idempotent', () => {
  const d = mk(); fs.mkdirSync(path.join(d, '.codex'));
  fs.writeFileSync(path.join(d, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } }));
  assert.equal(run(d, ['init-codex']).code, 0);
  assert.equal(run(d, ['init-codex']).code, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(d, '.codex/hooks.json')));
  assert.equal(cfg.hooks.Stop.length, 2);
  assert.equal(cfg.hooks.PreToolUse[0].matcher, 'Bash|apply_patch');
});

test('concurrent expired-claim replacement has exactly one winner', async () => {
  const d = mk();
  run(d, ['claim', 'a.js'], { as: 'old' });
  const f = path.join(d, '.mom/claims/a%2Ejs.json');
  const c = JSON.parse(fs.readFileSync(f)); c.expires = 0; fs.writeFileSync(f, JSON.stringify(c));
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => new Promise(resolve => {
    const child = cp.spawn(process.execPath, [BIN, 'begin', 'a.js', '--as', `worker${i}`], { cwd: d });
    child.on('exit', code => resolve(code));
  })));
  assert.equal(results.filter(c => c === 0).length, 1);
  assert.equal(results.filter(c => c === 3).length, 15);
});

test('early release ends active editing but preserves mine history', () => {
  const d = mk();
  run(d, ['begin', 'a.js'], { as: 'A' });
  run(d, ['release', 'a.js'], { as: 'A' });
  const r = run(d, ['wait', 'a.js', '--timeout', '1'], { as: 'B' });
  assert.equal(r.code, 0); assert.doesNotMatch(r.err, /in-progress/);
  assert.deepEqual(JSON.parse(run(d, ['mine', '--json'], { as: 'A' }).out), ['a.js']);
});

test('malformed Codex hook input blocks instead of failing open', () => {
  const d = mk();
  assert.equal(run(d, ['codex-hook'], { stdin: '{broken' }).code, 2);
  assert.equal(run(d, ['codex-hook'], { stdin: JSON.stringify({ cwd: d, session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: 'unknown' } }) }).code, 2);
});

test('read-only inline diagnostics are allowed while explicit script writes are blocked', () => {
  const d = mk(); run(d, ['begin', 'a.js'], { as: 'A' });
  const bash = command => run(d, ['hook', 'pre-bash'], { stdin: hookIn('B', { cwd: d, tool_name: 'Bash', tool_input: { command } }) });
  assert.equal(bash(`node -e "console.log(require('fs').readFileSync('a.js','utf8'))"`).code, 0);
  assert.equal(bash(`node -e "require('fs').writeFileSync('a.js','changed')"`).code, 2);
});

test('wait timeout does not authorize editing over an active advisory editor', () => {
  const d = mk(), env = { MOM_MODE: 'advisory' };
  for (const who of ['A', 'B']) run(d, ['hook', 'pre-edit'], { stdin: hookIn(who, { cwd: d, tool_name: 'Edit', tool_input: { file_path: 'a.js' } }), env });
  const r = run(d, ['wait', 'a.js', '--timeout', '1'], { as: 'A', env });
  assert.equal(r.code, 3); assert.match(r.out, /BLOCKED/);
});

test('Codex benchmark retains failed runs, source hashes and inactive-hook validity', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-runner-'));
  fs.writeFileSync(path.join(d, 'codex'), '#!/usr/bin/env node\nif(process.argv.includes("--version")) console.log("fake-test-cli"); else process.exit(17);\n', { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'tasks.json'), JSON.stringify({ agents: [{ name: 'worker', prompt: 'test' }], shared_suffix: '' }));
  fs.writeFileSync(path.join(d, 'check.js'), 'console.log(JSON.stringify({score:0,max:1}))');
  const output = path.join(d, 'results.jsonl');
  const r = cp.spawnSync(process.execPath, [path.resolve(__dirname, '../bench/codex.js'), '--tasks', path.join(d, 'tasks.json'), '--check', path.join(d, 'check.js'), '--output', output, '--stagger', '0'], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: d + path.delimiter + process.env.PATH },
  });
  assert.equal(r.status, 0, r.stderr);
  const rows = fs.readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.valid, false); assert.equal(row.agents[0].code, 17);
    assert.match(row.source_sha256, /^[a-f0-9]{64}$/);
    fs.rmSync(path.dirname(path.dirname(row.agents[0].log)), { recursive: true, force: true });
  }
});

test('silent unless agents share a file: alone or on different files, no hook says anything', () => {
  const d = mk();
  cp.execSync('git init -q', { cwd: d });
  const env = { MOM_MODE: 'advisory' };
  const hook = (who, ev, extra = {}) => run(d, ['hook', ev], { stdin: hookIn(who, { cwd: d, ...extra }), env });
  const edit = (who, f) => hook(who, 'pre-edit', { tool_name: 'Edit', tool_input: { file_path: f } });
  const red = { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ℹ tests 5\nℹ pass 3\nℹ fail 2' } };
  // alone
  for (const r of [hook('A', 'session-start'), hook('A', 'prompt'), edit('A', 'a.js'), hook('A', 'post-tool', red)]) { assert.equal(r.code, 0); assert.equal(r.out, ''); assert.equal(r.err, ''); }
  assert.equal(hook('A', 'pre-bash', { tool_name: 'Bash', tool_input: { command: 'git add -A' } }).code, 0, 'no one else has files in play');
  // a second agent arrives and works on a different file
  for (const r of [hook('B', 'session-start'), hook('B', 'prompt'), edit('B', 'b.js'), hook('B', 'post-tool', red), hook('A', 'post-tool', red), hook('A', 'prompt')]) { assert.equal(r.code, 0); assert.equal(r.out, ''); assert.equal(r.err, ''); }
  // notes stay between agents that share a file
  run(d, ['note', 'format() now returns an array'], { as: 'A', env });
  assert.equal(hook('B', 'post-tool').out, '', 'B shares no file with A');
  // a tree-wide git command does touch the other agent's file
  assert.equal(hook('A', 'pre-bash', { tool_name: 'Bash', tool_input: { command: 'git add -A' } }).code, 2);
  assert.equal(hook('A', 'pre-bash', { tool_name: 'Bash', tool_input: { command: 'git add a.js' } }).code, 0);
});

test('a first same-file overlap warns and carries the note tip; notes then reach that agent', () => {
  const d = mk();
  const env = { MOM_MODE: 'advisory' };
  const edit = (who, f) => run(d, ['hook', 'pre-edit'], { stdin: hookIn(who, { cwd: d, tool_name: 'Edit', tool_input: { file_path: f } }), env });
  edit('A', 'a.js');
  const r = edit('B', 'a.js');
  assert.equal(r.code, 0); assert.match(r.out, /heads-up/); assert.match(r.out, /mom note/);
  run(d, ['note', 'format() now returns an array'], { as: 'A', env });
  assert.match(run(d, ['hook', 'post-tool'], { stdin: hookIn('B', { cwd: d }), env }).out, /note: format\(\) now returns an array/);
});

test('--brief full is opt-in: protocol at session start, status on prompts, every note and plan delivered', () => {
  const d = mk();
  const env = { MOM_BRIEF: 'full', MOM_MODE: 'advisory' };
  run(d, ['hook', 'session-start'], { stdin: hookIn('A', { cwd: d }), env });
  let r = run(d, ['hook', 'session-start'], { stdin: hookIn('B', { cwd: d }), env });
  assert.match(r.out, /Protocol/); assert.match(r.out, /plan "<one-line goal>"/);
  assert.match(run(d, ['hook', 'prompt'], { stdin: hookIn('B', { cwd: d }), env }).out, /2 agents active/);
  run(d, ['plan', 'rename Store.add', 'a.js'], { as: 'A', env });
  run(d, ['note', 'format() now returns an array'], { as: 'A', env });
  r = run(d, ['hook', 'post-tool'], { stdin: hookIn('B', { cwd: d }), env });
  assert.match(r.out, /plan: .{0,2}rename Store.add/); assert.match(r.out, /note: format/, 'delivered without a shared file');
  const init = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-brief-'));
  cp.execSync('git init -q', { cwd: init });
  run(init, ['init', '--no-skill', '--brief', 'full']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(init, '.mom/config.json'))).brief, 'full');
});

test('stale-write guard: a shell write is blocked only if another agent changed that file after you read it', () => {
  const d = mk();
  const env = { MOM_MODE: 'advisory' };
  const read = (who, f) => run(d, ['hook', 'pre-read'], { stdin: hookIn(who, { cwd: d, tool_name: 'Read', tool_input: { file_path: path.join(d, f) } }), env });
  const bash = (who, command) => run(d, ['hook', 'pre-bash'], { stdin: hookIn(who, { cwd: d, tool_name: 'Bash', tool_input: { command } }), env });
  const py = "python3 - <<E\nopen('a.js','w').write('x')\nE";
  // alone: reading then writing, repeatedly, is silent
  read('A', 'a.js');
  let r = bash('A', py); assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  r = bash('A', "sed -i 's/1/2/' a.js"); assert.equal(r.code, 0); assert.equal(r.out + r.err, '');
  // B writes a.js after A's last look, then finishes: A is stopped even though nobody holds the file any more
  r = bash('B', "sed -i 's/2/3/' a.js"); assert.equal(r.code, 0);
  run(d, ['hook', 'session-end'], { stdin: hookIn('B', { cwd: d }), env });
  r = bash('A', py);
  assert.equal(r.code, 2); assert.match(r.err, /a\.js was changed by another agent/); assert.match(r.err, /Read the file again/);
  assert.equal(bash('A', py).code, 2, 'retrying without reading stays blocked');
  // another file is unaffected, a read-only heredoc is not a write, and reading clears the block
  read('A', 'b.js');
  assert.equal(bash('A', "sed -i 's/2/4/' b.js").code, 0);
  assert.equal(bash('A', "python3 - <<E\nprint(open('a.js').read())\nE").code, 0, 'reading via a script counts as a read');
  assert.equal(bash('A', py).code, 0, 'allowed after re-reading');
});

test('stale-write guard: an agent that never read the file is not blocked, and Edit-tool writes count as changes', () => {
  const d = mk();
  const env = { MOM_MODE: 'advisory' };
  const bash = (who, command) => run(d, ['hook', 'pre-bash'], { stdin: hookIn(who, { cwd: d, tool_name: 'Bash', tool_input: { command } }), env });
  run(d, ['hook', 'pre-edit'], { stdin: hookIn('B', { cwd: d, tool_name: 'Edit', tool_input: { file_path: 'b.js' } }), env });
  assert.equal(bash('A', "cat a.js").code, 0);
  run(d, ['hook', 'pre-edit'], { stdin: hookIn('B', { cwd: d, tool_name: 'Edit', tool_input: { file_path: 'a.js' } }), env });
  run(d, ['hook', 'stop'], { stdin: hookIn('B', { cwd: d }), env });
  assert.equal(bash('C', "sed -i 's/1/2/' a.js").code, 0, 'C never read a.js');
  const r = bash('A', "sed -i 's/1/2/' a.js");
  assert.equal(r.code, 2); assert.match(r.err, /changed by another agent/);
});

test('agent host detection judges the executable, not mentions of mom elsewhere on the command line', () => {
  const src = fs.readFileSync(BIN, 'utf8');
  const m = src.match(/const AGENT_EXE[\s\S]*?\n}\n/)[0];
  const isAgentHost = new Function('path', m + 'return isAgentHost;')(path);
  assert.ok(isAgentHost('/home/u/.local/bin/claude -p x'));
  assert.ok(isAgentHost('/opt/codex/vendor/x86_64/codex/codex exec -C /home/u/mom/work -c hooks.PreToolUse=[{command="node mom.js codex-hook"}]'));
  assert.ok(isAgentHost('node /usr/lib/node_modules/@openai/codex/bin/codex.js exec'));
  assert.ok(!isAgentHost('node /home/u/mom/bin/mom.js codex-hook'));
  assert.ok(!isAgentHost('node bench/run.js --tag codex'));
  assert.ok(!isAgentHost('/bin/sh -c claude'));
});

test('shell-write detection compares resolved paths, not basenames', () => {
  const d = mk();
  fs.mkdirSync(path.join(d, 'fixture'));
  run(d, ['claim', 'fixture/a.js'], { as: 'B' });
  const bash = command => run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command } }) });
  assert.equal(bash('cat >> a.js <<EOF\nx\nEOF').code, 0, 'a.js is not fixture/a.js');
  assert.equal(bash("sed -i 's/x/y/' fixture/a.js").code, 2);
  assert.equal(bash("cd fixture && sed -i 's/x/y/' ./a.js").code, 2, 'a leading cd is followed');
});

test('tree-wide git aimed at another repository is not blocked', () => {
  const d = mk();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mom-other-'));
  run(d, ['claim', 'b.js'], { as: 'B' });
  const bash = command => run(d, ['hook', 'pre-bash'], { stdin: hookIn('A', { cwd: d, tool_name: 'Bash', tool_input: { command } }) });
  assert.equal(bash(`cd ${other} && git add -A && git commit -qm x`).code, 0);
  assert.equal(bash(`git -C ${other} add -A`).code, 0);
  assert.equal(bash('git add -A').code, 2);
  assert.equal(bash(`cd ${other} && git add -A; cd ${d} && git stash`).code, 2, 'any git in this tree still counts');
  assert.equal(bash(`git -C ${d} stash`).code, 2);
});

test('an observed edit claim goes cold after MOM_IDLE_SEC without edits; a begin claim does not', async () => {
  const d = mk();
  const env = { MOM_IDLE_SEC: '1', MOM_MODE: 'strict' };
  const edit = (who, f, tool = 'Write') => run(d, ['hook', 'pre-edit'], { stdin: hookIn(who, { cwd: d, tool_name: tool, tool_input: { file_path: f } }), env });
  assert.equal(edit('A', 'a.js').code, 0);
  run(d, ['begin', 'b.js'], { as: 'A', env });
  assert.equal(edit('B', 'a.js').code, 2, 'hot while A is editing');
  await new Promise(r => setTimeout(r, 1300));
  assert.equal(edit('B', 'a.js').code, 0, 'cold after the idle window: B may take it');
  assert.match(run(d, ['inbox'], { as: 'B', env }).out, /released edited file: a\.js/, 'the idle handoff tells B to re-read');
  assert.equal(edit('B', 'b.js').code, 2, 'a hookless begin claim is held until release');
});
