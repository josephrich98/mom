#!/usr/bin/env node
'use strict';
// Paired Codex trials. No shell interpolation, model calls isolated to fresh fixtures.
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (k, fallback) => { const i = args.indexOf('--' + k); return i < 0 ? fallback : args[i + 1]; };
const trials = Number(opt('trials', 1)), timeout = Number(opt('timeout', 600));
const conditions = opt('conditions', 'baseline,mom-advisory').split(',');
if (!conditions.every(c => ['baseline', 'instructions', 'mom-advisory', 'mom-strict'].includes(c))) throw new Error('Unknown condition');
const model = opt('model', null);
const tasks = JSON.parse(fs.readFileSync(path.resolve(opt('tasks', path.join(__dirname, 'tasks-long.json')))));
const checker = path.resolve(opt('check', path.join(__dirname, 'check-long.js')));
const output = path.resolve(opt('output', path.join(__dirname, 'results-codex.jsonl')));
const runRoot = path.join(__dirname, 'runs', 'codex', new Date().toISOString().replace(/[:.]/g, '-'));
const command = (exe, argv, cwd) => {
  const r = cp.spawnSync(exe, argv, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || `${exe} exited ${r.status}`);
  return r.stdout;
};
async function run(condition, trial) {
  const dir = path.join(runRoot, `${trial}-${condition}`), work = path.join(dir, 'work');
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(root, 'bin'), path.join(dir, 'mom/bin'), { recursive: true });
  const bin = path.join(dir, 'mom/bin/mom.js');
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(bin)).update(fs.readFileSync(path.join(dir, 'mom/bin/codex.js'))).digest('hex');
  fs.cpSync(path.join(__dirname, 'fixture'), work, { recursive: true });
  command('git', ['init', '-q'], work);
  if (condition.startsWith('mom-')) {
    command(process.execPath, [bin, 'init', '--no-hooks', '--no-skill'], work);
    command(process.execPath, [bin, 'init-codex'], work);
  }
  command('git', ['add', '--all'], work);
  command('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'fixture'], work);
  const start = Date.now();
  const results = await Promise.all(tasks.agents.map((agent, i) => new Promise(resolve => {
    setTimeout(() => {
      const common = '\nDo not launch subagents. Do not modify .codex or .mom. Work only in this checkout.';
      const instruction = condition === 'instructions' ? '\nCoordinate by announcing planned files, rereading before edits, avoiding whole-file overwrites, and staging no changes. Release conceptual ownership promptly.' : '';
      const argv = ['exec', '--json', '--ephemeral', '--ignore-user-config', '-s', 'workspace-write', '-C', work,
        ...(condition.startsWith('mom-') ? ['--dangerously-bypass-hook-trust', '-c', `projects.${JSON.stringify(work)}.trust_level="trusted"`, ...Object.entries(JSON.parse(fs.readFileSync(path.join(work, '.codex/hooks.json'))).hooks).flatMap(([event, entries]) => ['-c', `hooks.${event}=[${entries.map(e => `{${e.matcher ? 'matcher=' + JSON.stringify(e.matcher) + ',' : ''}hooks=[${e.hooks.map(h => `{type="command",command=${JSON.stringify(h.command)},timeout=10}`).join(',')}]} `).join(',')}]`])] : []),
        ...(model ? ['--model', model] : []), agent.prompt + tasks.shared_suffix + common + instruction];
      const logfile = path.join(dir, `${agent.name}.jsonl`), fd = fs.openSync(logfile, 'w'), err = fs.openSync(logfile + '.stderr', 'w');
      const child = cp.spawn('codex', argv, { cwd: work, detached: true, stdio: ['ignore', fd, err],
        env: { ...process.env, MOM_AGENT: '', MOM_ROOT: '', MOM_DISABLE: condition.startsWith('mom-') ? '' : '1', MOM_MODE: condition === 'mom-strict' ? 'strict' : 'advisory' } });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, timeout * 1000);
      const killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, (timeout + 5) * 1000);
      const finish = (code, error) => {
        clearTimeout(timer); clearTimeout(killTimer); fs.closeSync(fd); fs.closeSync(err);
        const events = fs.readFileSync(logfile, 'utf8').split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
        const usage = events.filter(e => e.type === 'turn.completed').map(e => e.usage);
        resolve({ agent: agent.name, code, error, timedOut, usage, log: logfile });
      };
      child.on('error', e => finish(null, String(e))); child.on('exit', code => finish(code));
    }, i * Number(opt('stagger', 5)) * 1000);
  })));
  const checked = cp.spawnSync(process.execPath, [checker, work], { encoding: 'utf8', timeout: 180000 });
  let acceptance; try { acceptance = JSON.parse(checked.stdout); } catch { acceptance = { error: checked.stderr || checked.error?.message }; }
  const log = path.join(work, '.mom/log.jsonl');
  const events = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
  const row = { source_sha256: sourceHash, condition, trial, model: model || 'CLI default (--ignore-user-config)', cli: command('codex', ['--version'], work).trim(),
    task_sha256: crypto.createHash('sha256').update(JSON.stringify(tasks)).digest('hex'), wall_ms: Date.now() - start,
    valid: results.every(r => r.code === 0 && !r.timedOut) && (!condition.startsWith('mom-') || events.length > 0), agents: results, hook_events: events.length, blocks: events.filter(e => e.type === 'blocked').length, acceptance };
  fs.appendFileSync(output, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
}
(async () => {
  for (let trial = 0; trial < trials; trial++) {
    // Counterbalance order across paired trials; preserve order in the result file.
    const order = trial % 2 ? [...conditions].reverse() : conditions;
    for (const condition of order) await run(condition, trial);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
