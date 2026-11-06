#!/usr/bin/env node
'use strict';
/*
 * Benchmark: two headless Claude Code agents (Sonnet) edit overlapping files in one checkout,
 * with and without mom. Usage:
 *   node bench/run.js --condition baseline|mom-strict|mom-advisory [--trials 3] [--model claude-sonnet-5-5] [--max-turns 60] [--stagger 5]
 *                     [--tasks bench/tasks-hard.json --check bench/check-hard.js --tag hard]
 * Results: bench/runs/<condition>/<trial>/ (per-agent stream logs, check.json, summary.json) and bench/results.jsonl
 */
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : null).filter(Boolean));
const COND = args.condition || 'baseline';
const TRIALS = +(args.trials || 1);
const MODEL = args.model || 'claude-sonnet-5-5';
const MAX_TURNS = +(args['max-turns'] || 60);
const STAGGER = +(args.stagger || 5) * 1000;
const BUDGET = +(args.budget || 4); // USD per agent
const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'mom.js');
const FIXTURE = path.join(__dirname, 'fixture');
const TAG = args.tag || 'default';
const RUNS = path.join(__dirname, 'runs', TAG, COND);
const TASKS_FILE = path.resolve(args.tasks || path.join(__dirname, 'tasks.json'));
const CHECK = path.resolve(args.check || path.join(__dirname, 'check.js'));
const RESULTS = path.join(__dirname, TAG === 'default' ? 'results.jsonl' : `results-${TAG}.jsonl`);
const tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
const CONFIG_DIR = path.join(os.tmpdir(), 'mom-bench-claude-config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const env = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'MOM_AGENT', 'MOM_ROOT']) delete env[k];

function sh(cmd, cwd) { return cp.execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

function setupWork(trialDir) {
  const work = path.join(trialDir, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.cpSync(FIXTURE, work, { recursive: true });
  if (args.slow) {
    // Simulate a repo whose test suite takes a while: one test that sleeps N seconds. Thrash (running the tests into
    // someone else's half-finished breakage) then costs real wall-clock, as it does in any non-toy repo.
    const secs = +args.slow;
    fs.writeFileSync(path.join(work, 'test', 'integration.test.js'), `'use strict';\n// Integration smoke test. It is slow (~${secs}s) on purpose: do not remove, skip, or shorten it.\nconst { test } = require('node:test');\ntest('integration smoke (slow)', async () => { await new Promise(r => setTimeout(r, ${secs * 1000})); });\n`);
  }
  sh('git init -q', work);
  if (COND.startsWith('mom')) {
    const mode = COND.split('-')[1] || 'advisory'; // mom-strict | mom-advisory
    sh(`node ${JSON.stringify(BIN)} init --root ${JSON.stringify(work)} --command "node ${BIN}" --mode ${mode}`, work);
  }
  // one fixture commit, including mom's settings/.gitignore when present, so agents start from a clean tree
  sh('git -c user.email=b@b -c user.name=bench add -A && git -c user.email=b@b -c user.name=bench commit -qm fixture', work);
  return work;
}

function runAgent(work, agent, outFile) {
  const prompt = agent.prompt + tasks.shared_suffix;
  const argv = ['-p', prompt, '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--max-turns', String(MAX_TURNS),
    '--max-budget-usd', String(BUDGET), '--setting-sources', 'project', '--no-session-persistence',
    // acceptEdits (not bypass) so agents use the Edit/Write tools like interactive sessions do; Bash is allow-listed.
    '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'MultiEdit', 'Skill'];
  const t0 = Date.now();
  const outFd = fs.openSync(outFile, 'w');
  const child = cp.spawn('claude', argv, { cwd: work, env, stdio: ['ignore', outFd, fs.openSync(outFile + '.stderr', 'w')] });
  return new Promise(resolve => child.on('exit', code => { fs.closeSync(outFd); resolve({ code, wall_ms: Date.now() - t0 }); }));
}

const { parseStream, summarize, oneLine } = require('./lib');

(async () => {
  fs.mkdirSync(RUNS, { recursive: true });
  for (let t = 0; t < TRIALS; t++) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trialDir = path.join(RUNS, stamp);
    const work = setupWork(trialDir);
    console.log(`[${COND}] trial ${t + 1}/${TRIALS} → ${path.relative(ROOT, trialDir)}`);
    const t0 = Date.now();
    const runs = [];
    for (let i = 0; i < tasks.agents.length; i++) {
      if (i) await new Promise(r => setTimeout(r, STAGGER));
      runs.push(runAgent(work, tasks.agents[i], path.join(trialDir, `${tasks.agents[i].name}.jsonl`)).then(r => ({ ...r, name: tasks.agents[i].name })));
    }
    const exits = await Promise.all(runs);
    const wall_ms = Date.now() - t0;
    let check; try { check = JSON.parse(sh(`node ${JSON.stringify(CHECK)} ${JSON.stringify(work)}`, ROOT)); } catch (e) { check = { score: 0, max: 18, error: String(e.stdout || e) }; }
    fs.writeFileSync(path.join(trialDir, 'check.json'), JSON.stringify(check, null, 2));
    const agents = {};
    for (const a of tasks.agents) agents[a.name] = { ...parseStream(path.join(trialDir, `${a.name}.jsonl`)), exit: exits.find(e => e.name === a.name) };
    if (COND.startsWith('mom')) { try { fs.copyFileSync(path.join(work, '.mom', 'log.jsonl'), path.join(trialDir, 'mom-log.jsonl')); } catch {} }
    const summary = summarize({ condition: COND, tag: TAG, trial: stamp, model: MODEL, wall_ms }, agents, check);
    fs.writeFileSync(path.join(trialDir, 'summary.json'), JSON.stringify(summary, null, 2));
    fs.appendFileSync(RESULTS, JSON.stringify({ ...summary, agents: undefined }) + '\n');
    console.log('  ' + oneLine(summary));
  }
})();
