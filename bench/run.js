#!/usr/bin/env node
'use strict';
/*
 * Benchmark: N headless agents (Claude Code, and optionally Codex) work concurrently in one checkout,
 * with and without mom.
 *
 *   node bench/run.js --conditions baseline,mom-advisory [--trials 10] [--parallel 3]
 *                     [--model claude-sonnet-5-5] [--max-turns 100] [--stagger 5] [--slow 15] [--timeout 1200]
 *                     [--fixture bench/fixture-shop] [--tasks bench/tasks-shop.json --check bench/check-shop.js] --tag shop
 *                     [--codex half|<agent names, comma-separated>] [--codex-model gpt-6-astra] [--mom-src <dir with bin/ skills/>]
 *
 * Conditions: baseline (no mom) | mom-advisory (default mom) | mom-strict (strict mode)
 * (older results also have mom-full: the v0.4 up-front brief, removed in v0.6)
 * --concurrency N caps agents running at once (default: all); --orders '[[1,0],[0,1]]' sets the task order per trial k; --login uses the CLI's own login instead of ANTHROPIC_API_KEY.
 * Trials are counterbalanced: trial k runs every condition, in an order that rotates with k. --parallel runs
 * that many condition-trials at once (each in its own fresh checkout). mom's bin/ and skills/ are snapshotted per
 * run so editing the repo during a benchmark cannot change what a running trial executes.
 * Results: bench/runs/<tag>/<condition>/<stamp>/ and bench/results-<tag>.jsonl (one row per trial, failures kept).
 */
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os'), crypto = require('crypto');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : null).filter(Boolean));
const CONDS = (args.conditions || args.condition || 'baseline').split(',');
const KNOWN = ['baseline', 'mom-advisory', 'mom-strict'];
for (const c of CONDS) if (!KNOWN.includes(c)) throw new Error(`unknown condition ${c}; use ${KNOWN.join('|')}`);
const TRIALS = +(args.trials || 1);
const PARALLEL = +(args.parallel || 1);
const MODEL = args.model || 'claude-sonnet-5-5';
const CODEX_MODEL = args['codex-model'] || 'gpt-6-astra';
const MAX_TURNS = +(args['max-turns'] || 100);
const STAGGER = +(args.stagger || 5) * 1000;
const TIMEOUT = +(args.timeout || 1200) * 1000; // per agent
const BUDGET = +(args.budget || 4); // USD per Claude agent
const ORDERS = args.orders ? JSON.parse(args.orders) : null;
const ROOT = path.resolve(__dirname, '..');
const MOM_SRC = path.resolve(args['mom-src'] || ROOT); // a frozen copy of mom (bin/ + skills/) to benchmark; default: this repo
const FIXTURE = path.resolve(args.fixture || path.join(__dirname, 'fixture'));
const TAG = args.tag || 'default';
const TASKS_FILE = path.resolve(args.tasks || path.join(__dirname, 'tasks.json'));
const CHECK = path.resolve(args.check || path.join(__dirname, 'check.js'));
const RESULTS = path.join(__dirname, TAG === 'default' ? 'results.jsonl' : `results-${TAG}.jsonl`);
const tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
const CONCURRENCY = +(args.concurrency || tasks.agents.length);
const codexNames = !args.codex ? [] : args.codex === 'half' ? tasks.agents.filter((_, i) => i % 2 === 1).map(a => a.name) : String(args.codex).split(',');
const cliOf = a => a.cli || (codexNames.includes(a.name) ? 'codex' : 'claude');
const CONFIG_DIR = path.join(os.tmpdir(), 'mom-bench-claude-config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const baseEnv = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR };
if (args.login) { delete baseEnv.ANTHROPIC_API_KEY; delete baseEnv.CLAUDE_CONFIG_DIR; }
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_MESSAGING_SOCKET', 'MOM_AGENT', 'MOM_ROOT', 'MOM_MODE', 'MOM_BRIEF', 'MOM_DISABLE']) delete baseEnv[k];

function git(argv, cwd) { return cp.execFileSync('git', ['-c', 'user.email=b@b', '-c', 'user.name=bench', ...argv], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
const isMom = c => c.startsWith('mom-');
const modeOf = c => c === 'mom-strict' ? 'strict' : 'advisory';

function setupWork(trialDir, cond) {
  const work = path.join(trialDir, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.cpSync(FIXTURE, work, { recursive: true });
  let bin = null, sha = null;
  if (isMom(cond)) {
    // snapshot mom so later edits to the repo can't change a running trial
    for (const d of ['bin', 'skills']) fs.cpSync(path.join(MOM_SRC, d), path.join(trialDir, 'mom', d), { recursive: true });
    bin = path.join(trialDir, 'mom', 'bin', 'mom.js');
    sha = crypto.createHash('sha256').update(fs.readFileSync(bin)).update(fs.readFileSync(path.join(trialDir, 'mom', 'bin', 'codex.js'))).digest('hex').slice(0, 12);
  }
  if (args.slow) {
    // A repo whose test suite takes a while: one test that sleeps N seconds, so thrash costs real wall-clock.
    const secs = +args.slow;
    fs.writeFileSync(path.join(work, 'test', 'integration.test.js'), `'use strict';\n// Integration smoke test. It is slow (~${secs}s) on purpose: do not remove, skip, or shorten it.\nconst { test } = require('node:test');\ntest('integration smoke (slow)', async () => { await new Promise(r => setTimeout(r, ${secs * 1000})); });\n`);
  }
  git(['init', '-q'], work);
  if (isMom(cond)) {
    cp.execFileSync(process.execPath, [bin, 'init', '--root', work, '--command', `node ${bin}`, '--mode', modeOf(cond)], { cwd: work, stdio: 'ignore' });
    if (tasks.agents.some(a => cliOf(a) === 'codex')) cp.execFileSync(process.execPath, [bin, 'init-codex'], { cwd: work, stdio: 'ignore' });
  }
  // one fixture commit (with mom's settings/.gitignore when present) so agents start from a clean tree
  git(['add', '-A'], work); git(['commit', '-qm', 'fixture'], work);
  return { work, bin, sha };
}

function spawnTimed(exe, argv, cwd, env, outFile) {
  const t0 = Date.now();
  const outFd = fs.openSync(outFile, 'w'), errFd = fs.openSync(outFile + '.stderr', 'w');
  const child = cp.spawn(exe, argv, { cwd, env, detached: true, stdio: ['ignore', outFd, errFd] });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000); }, TIMEOUT);
  return new Promise(resolve => {
    const done = (code, error) => { clearTimeout(timer); try { fs.closeSync(outFd); fs.closeSync(errFd); } catch {} resolve({ code, error, timedOut, wall_ms: Date.now() - t0 }); };
    child.on('error', e => done(null, String(e))); child.on('exit', code => done(code));
  });
}

function runClaude(work, agent, outFile) {
  const prompt = agent.prompt + tasks.shared_suffix;
  const argv = ['-p', prompt, '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--max-turns', String(MAX_TURNS),
    '--max-budget-usd', String(BUDGET), '--setting-sources', 'project', '--no-session-persistence',
    // acceptEdits (not bypass) so agents use the Edit/Write tools like interactive sessions do; Bash is allow-listed.
    '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'MultiEdit', 'Skill'];
  return spawnTimed('claude', argv, work, baseEnv, outFile);
}

function runCodex(work, agent, outFile, cond) {
  const common = '\nDo not launch subagents. Do not modify .codex or .mom. Work only in this checkout.';
  const hookFlags = [];
  if (isMom(cond)) {
    const hooks = JSON.parse(fs.readFileSync(path.join(work, '.codex/hooks.json'))).hooks;
    hookFlags.push('--dangerously-bypass-hook-trust', '-c', `projects.${JSON.stringify(work)}.trust_level="trusted"`);
    for (const [event, entries] of Object.entries(hooks)) {
      hookFlags.push('-c', `hooks.${event}=[${entries.map(e => `{${e.matcher ? 'matcher=' + JSON.stringify(e.matcher) + ',' : ''}hooks=[${e.hooks.map(h => `{type="command",command=${JSON.stringify(h.command)},timeout=10}`).join(',')}]}`).join(',')}]`);
    }
  }
  const argv = ['exec', '--json', '--ephemeral', '--ignore-user-config', '-s', 'workspace-write', '-C', work, ...hookFlags,
    '--model', CODEX_MODEL, '-c', 'model_reasoning_effort="medium"', agent.prompt + tasks.shared_suffix + common];
  const env = { ...baseEnv, MOM_DISABLE: isMom(cond) ? '' : '1' };
  return spawnTimed('codex', argv, work, env, outFile);
}

const { parseStream, parseCodex, summarize, oneLine } = require('./lib');

async function trial(cond, k) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + k;
  const trialDir = path.join(__dirname, 'runs', TAG, cond, stamp);
  const { work, sha } = setupWork(trialDir, cond);
  console.log(`[${cond}] trial ${k + 1}/${TRIALS} → ${path.relative(ROOT, trialDir)}`);
  const t0 = Date.now();
  const order = ORDERS ? ORDERS[k % ORDERS.length].map(i => tasks.agents[i]) : tasks.agents;
  const exits = [];
  let next = 0;
  const worker = async w => {
    if (w) await new Promise(res => setTimeout(res, w * STAGGER));
    while (next < order.length) {
      const a = order[next++], out = path.join(trialDir, `${a.name}.jsonl`);
      const r = await (cliOf(a) === 'codex' ? runCodex(work, a, out, cond) : runClaude(work, a, out));
      exits.push({ ...r, name: a.name, cli: cliOf(a) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, order.length) }, (_, w) => worker(w)));
  const wall_ms = Date.now() - t0;
  let check;
  const cr = cp.spawnSync(process.execPath, [CHECK, work], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  try { check = JSON.parse(cr.stdout); } catch { check = { score: 0, max: 0, error: (cr.stderr || cr.stdout || '').slice(0, 2000) }; }
  fs.writeFileSync(path.join(trialDir, 'check.json'), JSON.stringify(check, null, 2));
  const agents = {};
  for (const a of tasks.agents) {
    const f = path.join(trialDir, `${a.name}.jsonl`);
    agents[a.name] = { cli: cliOf(a), ...(cliOf(a) === 'codex' ? parseCodex(f) : parseStream(f)), exit: exits.find(e => e.name === a.name) };
  }
  let momEvents = 0;
  if (isMom(cond)) { try { fs.copyFileSync(path.join(work, '.mom', 'log.jsonl'), path.join(trialDir, 'mom-log.jsonl')); momEvents = fs.readFileSync(path.join(trialDir, 'mom-log.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch {} }
  const fatal = Object.entries(agents).filter(([, a]) => a.fatal).map(([n, a]) => `${n}: ${a.fatal}`);
  const valid = exits.every(e => !e.error) && !fatal.length && (!isMom(cond) || momEvents > 0);
  const meta = { condition: cond, tag: TAG, trial: stamp, k, model: MODEL, codex_model: codexNames.length ? CODEX_MODEL : undefined, clis: tasks.agents.map(cliOf).join(','),
    mom_sha: sha, fatal: fatal.length ? fatal : undefined, concurrency: CONCURRENCY, mom_events: momEvents, valid, timeouts: exits.filter(e => e.timedOut).length, wall_ms };
  const summary = summarize(meta, agents, check);
  fs.writeFileSync(path.join(trialDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.appendFileSync(RESULTS, JSON.stringify({ ...summary, agents: undefined }) + '\n');
  console.log(`  [${cond} #${k + 1}] ` + oneLine(summary));
}

(async () => {
  // counterbalanced schedule: trial k rotates the condition order by k
  const jobs = [];
  // --only-missing resumes an interrupted run: skip condition/trial pairs that already have a valid row.
  const done = new Set(args['only-missing'] && fs.existsSync(RESULTS) ? fs.readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(r => r.valid !== false).map(r => r.condition + '|' + r.k) : []);
  for (let k = 0; k < TRIALS; k++) for (let j = 0; j < CONDS.length; j++) { const c = CONDS[(j + k) % CONDS.length]; if (!done.has(c + '|' + k)) jobs.push([c, k]); }
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const [c, k] = jobs[next++]; try { await trial(c, k); } catch (e) {
    console.error(`[${c} #${k + 1}] harness error: ${e.stack || e}`);
    fs.appendFileSync(RESULTS, JSON.stringify({ condition: c, tag: TAG, k, trial: new Date().toISOString(), valid: false, harness_error: String(e).slice(0, 500) }) + '\n');
  } } };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
})();
