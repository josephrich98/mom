#!/usr/bin/env node
'use strict';
/*
 * mom — keep concurrent AI coding agents from stepping on each other.
 *
 * Zero dependencies. State is plain files, kept per checkout:
 *   ~/.mom/repos/<hash of repo root>/   by default (nothing is written into your repo), or
 *   <repo>/.mom/                        if you ran `mom init` there (shared with other tools, git-ignored)
 *     agents/<id>.json   one record per live agent (pid, heartbeat, inbox cursor, files edited)
 *     claims/<path>.json one record per claimed file; created with O_EXCL so
 *                        "check and claim" is a single atomic filesystem operation
 *     log.jsonl          append-only event log (notes, handoffs)
 *     snap/<agent>/      the text of each file as that agent last read it, and just before its current write
 *
 * Agents never need to read these files; they use `mom <cmd>` and the
 * Claude Code hooks (`mom hook <event>`) do the rest automatically.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const { merge3 } = require('./merge3');

const VERSION = '0.6.0';
const MOM_HOME = process.env.MOM_HOME || path.join(os.homedir(), '.mom');
const TTL_SEC = parseInt(process.env.MOM_TTL_SEC || '', 10) || 900; // reservation TTL
const TTL_MS = TTL_SEC * 1000;
// A hook-observed claim with edits stays "hot" (blocking, shown as mid-edit) only while its holder keeps editing that
// file. In headless runs and long turns the turn never ends, so holding until end-of-turn serialized agents behind
// files their holder had finished with minutes earlier.
const IDLE_MS = (parseInt(process.env.MOM_IDLE_SEC || '', 10) || 90) * 1000;
const HOST = os.hostname();
const NOW = () => Date.now();

// ---------------------------------------------------------------- utilities
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSONAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file); // atomic replace on POSIX & modern Windows
}
function ago(ts) {
  const s = Math.max(0, Math.round((NOW() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}
function short(id) { const value = String(id || ''); return value.length <= 8 ? value.replace(/-/g, '').slice(0, 4) : crypto.createHash('sha256').update(value).digest('hex').slice(0, 6); }
function encPath(rel) { return encodeURIComponent(rel).replace(/\./g, '%2E') + '.json'; }
function decPath(name) { return decodeURIComponent(name.replace(/\.json$/, '')); }
function pidAlive(pid) {
  if (!pid) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM' ? true : false; }
}
function out(s) { if (s) process.stdout.write(s.endsWith('\n') ? s : s + '\n'); }
function die(msg, code = 1) { process.stderr.write(`mom: ${msg}\n`); process.exit(code); }

// ---------------------------------------------------------------- root / state dir
function globalDir(root) {
  let real = root; try { real = fs.realpathSync(root); } catch {}
  return path.join(MOM_HOME, 'repos', crypto.createHash('sha1').update(real).digest('hex').slice(0, 16));
}
/**
 * Where is the checkout, and where does its state live?
 *   MOM_ROOT                      → that directory (state in its .mom/ if present, else ~/.mom/repos/<hash>)
 *   nearest ancestor with .mom/   → in-repo state (opted in with `mom init`; shareable with non-Claude tools)
 *   nearest ancestor with .git    → ~/.mom/repos/<hash>: zero footprint in the repo, works with no setup
 *   neither                       → not a repo; hooks stay silent
 */
function locate(start) {
  const cwd = path.resolve(start || process.cwd());
  if (process.env.MOM_ROOT) {
    const root = path.resolve(process.env.MOM_ROOT);
    const local = path.join(root, '.mom');
    return { root, dir: fs.existsSync(local) ? local : globalDir(root) };
  }
  // nearest marker wins; the global state home (~/.mom) is never an in-repo marker
  for (let d = cwd; ; d = path.dirname(d)) {
    const local = path.join(d, '.mom');
    if (local !== MOM_HOME && fs.existsSync(path.join(local, 'agents')) && !fs.existsSync(path.join(local, 'repos'))) return { root: d, dir: local };
    if (fs.existsSync(path.join(d, '.git'))) return { root: d, dir: globalDir(d) };
    if (path.dirname(d) === d) return { root: cwd, dir: null };
  }
}
class State {
  constructor(loc) {
    if (typeof loc === 'string') loc = { root: loc, dir: path.join(loc, '.mom') };
    this.root = loc.root;
    this.dir = loc.dir;
    this.agentsDir = this.dir && path.join(this.dir, 'agents');
    this.claimsDir = this.dir && path.join(this.dir, 'claims');
    this.logFile = this.dir && path.join(this.dir, 'log.jsonl');
    this._cfg = null;
  }
  get cfg() {
    if (!this._cfg) this._cfg = { ...readJSON(path.join(MOM_HOME, 'config.json'), {}), ...(this.dir ? readJSON(path.join(this.dir, 'config.json'), {}) : {}) };
    return this._cfg;
  }
  saveCfg(patch) { this.ensure(); this._cfg = null; writeJSONAtomic(path.join(this.dir, 'config.json'), { ...readJSON(path.join(this.dir, 'config.json'), {}), ...patch }); }
  /** How agents should invoke mom in this repo (same prefix the hooks use). */
  get cmd() { return this.cfg.cmd || 'mom'; }
  /** 'advisory' (default): surgical Edits to a file someone else holds are allowed with a warning; only destructive
   *  operations are blocked (whole-file Write / shell rewrite of a held file, tree-wide git ops).
   *  'strict': any edit to a file another agent holds is blocked. */
  get mode() { return process.env.MOM_MODE || this.cfg.mode || 'advisory'; }
  /** Enabled in any git checkout (or anywhere with a .mom/) unless MOM_DISABLE is set. */
  get enabled() { return !!this.dir && !process.env.MOM_DISABLE; }
  ensure() {
    if (!this.dir) die('not inside a git repository (or a directory with .mom/). Run `mom init` here, or set MOM_ROOT.');
    fs.mkdirSync(this.agentsDir, { recursive: true });
    fs.mkdirSync(this.claimsDir, { recursive: true });
    fs.closeSync(fs.openSync(this.logFile, 'a')); // never truncate a concurrent append
  }
  // Serialize claim mutation, including expiry checks. Never reap this mutex by
  // pathname: doing so would reintroduce the ABA race it protects against.
  locked(fn) {
    if (this._locked) return fn();
    this.ensure();
    const lock = path.join(this.dir, 'mutation.lock');
    const deadline = NOW() + 5000;
    for (;;) {
      try { fs.mkdirSync(lock); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (NOW() >= deadline) throw new Error(`State mutex busy: ${lock}. If its process crashed, stop all mom users before removing this directory.`);
        sleepMs(10);
      }
    }
    this._locked = true;
    try { return fn(); }
    finally { this._locked = false; fs.rmdirSync(lock); }
  }
  rel(p) {
    const abs = path.isAbsolute(p) ? p : path.resolve(this.root, p);
    const r = path.relative(this.root, abs);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return null; // outside repo
    return r.split(path.sep).join('/');
  }
  // ---- agents
  agentFile(id) { return path.join(this.agentsDir, `${id}.json`); }
  getAgent(id) { return readJSON(this.agentFile(id), null); }
  saveAgent(a) { writeJSONAtomic(this.agentFile(a.id), a); }
  removeAgent(id) { try { fs.unlinkSync(this.agentFile(id)); } catch {} }
  agents() {
    let names = [];
    try { names = fs.readdirSync(this.agentsDir); } catch {}
    return names.filter(n => n.endsWith('.json')).map(n => readJSON(path.join(this.agentsDir, n), null)).filter(Boolean);
  }
  isPresent(a) {
    if (!a) return false;
    if (a.host === HOST && a.pid) {
      const alive = pidAlive(a.pid);
      if (alive === false) return false;
      if (alive === true) return true;
    }
    return NOW() - (a.heartbeat || 0) < TTL_MS;
  }
  liveAgents() { return this.agents().filter(a => this.isPresent(a)); }
  // ---- claims
  claimFile(rel) { return path.join(this.claimsDir, encPath(rel)); }
  getClaim(rel) { return readJSON(this.claimFile(rel), null); }
  claims() {
    let names = [];
    try { names = fs.readdirSync(this.claimsDir); } catch {}
    return names.filter(n => n.endsWith('.json')).map(n => readJSON(path.join(this.claimsDir, n), null)).filter(Boolean);
  }
  /** A claim is valid if its owner is present and (it's dirty or not yet expired). */
  claimValid(c, agentsById) {
    if (!c) return false;
    const owner = agentsById ? agentsById[c.agent] : this.getAgent(c.agent);
    if (!this.isPresent(owner)) return false;
    if (c.modified) {
      // hookless claims (`mom begin`) report no edit times: hold until release or owner death.
      // Hook-observed claims go cold once their holder has not touched the file for IDLE_MS.
      return !c.lastEdit || NOW() - c.lastEdit < IDLE_MS;
    }
    return (c.expires || 0) > NOW();
  }
  /**
   * Try to claim `rel` for `me`. Returns {ok:true, claim} or {ok:false, claim(holder), owner}.
   * Atomic: creation uses O_EXCL; stale replacement is serialized by the state mutex.
   */
  tryClaim(rel, me, { modified = false, steal = false, observed = false } = {}) {
    if (!this._locked) return this.locked(() => this.tryClaim(rel, me, { modified, steal, observed }));
    const file = this.claimFile(rel);
    for (let attempt = 0; attempt < 5; attempt++) {
      const fresh = { path: rel, agent: me, since: NOW(), expires: NOW() + TTL_MS, modified, renewed: NOW(), ...(observed ? { lastEdit: NOW() } : {}) };
      try {
        const fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, JSON.stringify(fresh));
        fs.closeSync(fd);
        return { ok: true, claim: fresh, fresh: true };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const existing = readJSON(file, null);
      if (!existing) continue; // vanished between open and read: retry
      if (existing.agent === me) {
        existing.expires = NOW() + TTL_MS; existing.renewed = NOW();
        if (modified) { existing.modified = true; existing.edits = (existing.edits || 0) + 1; }
        if (observed) existing.lastEdit = NOW();
        writeJSONAtomic(file, existing);
        return { ok: true, claim: existing, fresh: false };
      }
      if (this.claimValid(existing) && !steal) {
        return { ok: false, claim: existing, owner: this.getAgent(existing.agent) };
      }
      // Stale replacement is protected by the state mutex. A cold claim with edits is a handoff: whoever takes it next re-reads.
      if (existing.modified && existing.lastEdit) this.log({ agent: existing.agent, type: 'handoff', released: [rel], modified: [rel], idle: true });
      const tomb = `${file}.reap.${process.pid}.${Math.random().toString(36).slice(2)}`;
      try { fs.renameSync(file, tomb); fs.unlinkSync(tomb); } catch { /* someone else reaped; loop */ }
    }
    return { ok: false, claim: this.getClaim(rel), owner: null };
  }
  release(rel, me) {
    if (!this._locked) return this.locked(() => this.release(rel, me));
    const file = this.claimFile(rel);
    const c = readJSON(file, null);
    if (!c || c.agent !== me) return null;
    try { fs.unlinkSync(file); } catch {}
    return c;
  }
  renewAll(me) {
    if (!this._locked) return this.locked(() => this.renewAll(me));
    for (const c of this.claims()) {
      if (c.agent === me && NOW() - (c.renewed || 0) > TTL_MS / 4) {
        c.expires = NOW() + TTL_MS; c.renewed = NOW();
        writeJSONAtomic(this.claimFile(c.path), c);
      }
    }
  }
  // ---- log
  log(ev) { fs.appendFileSync(this.logFile, JSON.stringify({ ts: NOW(), ...ev }) + '\n'); }
  logSize() { try { return fs.statSync(this.logFile).size; } catch { return 0; } }
  readLog(from = 0) {
    let buf;
    try { buf = fs.readFileSync(this.logFile); } catch { return { events: [], end: 0 }; }
    const slice = buf.subarray(Math.min(from, buf.length)).toString('utf8');
    const events = slice.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return { events, end: buf.length };
  }
  gc() {
    if (!this._locked) return this.locked(() => this.gc());
    const agents = this.agents();
    const present = {};
    for (const a of agents) { if (this.isPresent(a)) present[a.id] = a; else this.removeAgent(a.id); }
    for (const c of this.claims()) {
      if (!this.claimValid(c, present)) {
        try { fs.unlinkSync(this.claimFile(c.path)); } catch {}
        if (c.modified && c.lastEdit && present[c.agent]) this.log({ agent: c.agent, type: 'handoff', released: [c.path], modified: [c.path], idle: true });
      }
    }
    return present;
  }
}

// ---------------------------------------------------------------- identity
/** Is this process an agent CLI? Judge by the executable (or, for node/python launchers, the script) name only:
 *  the rest of the command line can mention anything, including mom itself (hook flags, a checkout called mom). */
const AGENT_EXE = /^(claude|codex|cursor|cursor-agent|aider|gemini|copilot|opencode)(\.(js|mjs|cjs|exe|py))?$/i;
function isAgentHost(cmdline) {
  const argv = cmdline.trim().split(/\s+/);
  const base = x => path.basename(String(x || ''));
  if (AGENT_EXE.test(base(argv[0]))) return true;
  return /^(node|nodejs|bun|deno|python3?)(\.exe)?$/i.test(base(argv[0])) && AGENT_EXE.test(base(argv.find((x, i) => i > 0 && !x.startsWith('-'))));
}
function hostPidFromAncestors() {
  // Walk up the process tree looking for the agent host (claude, codex, cursor…).
  let pid = process.ppid, found = null, first = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    let cmd = '', ppid = 0;
    try {
      if (process.platform === 'linux') {
        cmd = fs.readFileSync(`/proc/${pid}/cmdline`).toString().replace(/\0/g, ' ');
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        ppid = parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1], 10);
      } else {
        const line = cp.execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        ppid = parseInt(line, 10); cmd = line.replace(/^\s*\d+\s*/, '');
      }
    } catch { break; }
    if (isAgentHost(cmd)) { found = pid; break; }
    pid = ppid;
  }
  return found || first;
}
function resolveSelf(st, hookInput, flags) {
  if (flags.as) return flags.as;
  if (hookInput && hookInput.session_id) {
    return hookInput.agent_id ? `${hookInput.session_id}.${hookInput.agent_id}` : hookInput.session_id;
  }
  if (process.env.MOM_AGENT) return process.env.MOM_AGENT;
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID;
  // match an ancestor pid against registered agents
  const hostPid = hostPidFromAncestors();
  const byPid = st.agents().find(a => a.host === HOST && a.pid === hostPid);
  if (byPid) return byPid.id;
  return null;
}
function ensureAgent(st, id, extra = {}) {
  if (!st._locked) return st.locked(() => ensureAgent(st, id, extra));
  let a = st.getAgent(id);
  const fresh = !a;
  if (!a) {
    a = { id, host: HOST, pid: parseInt(process.env.CLAUDE_PID, 10) || hostPidFromAncestors(), started: NOW(), cursor: st.logSize() };
  }
  a.heartbeat = NOW();
  Object.assign(a, extra);
  st.saveAgent(a);
  if (fresh) st.log({ agent: id, type: 'join' });
  return a;
}
function label(a, me) {
  const tag = `[${short(a.id)}]`;
  if (a.id === me) return `${tag} you`;
  return a.plan ? `${tag} "${a.plan}"` : tag;
}

/**
 * Wait-for cycle detection. Returns {holder, wants} if the holder of `claim` is (transitively)
 * waiting for a file that `me` holds. Deterministic tie-break: the agent that joined later yields.
 */
function detectDeadlock(st, me, claim) {
  let holderId = claim && claim.agent, seen = new Set();
  for (let depth = 0; holderId && depth < 8 && !seen.has(holderId); depth++) {
    seen.add(holderId);
    const holder = st.getAgent(holderId);
    if (!holder || !st.isPresent(holder) || !holder.waiting_for) return null;
    const wc = st.getClaim(holder.waiting_for);
    if (!wc || !st.claimValid(wc)) return null;
    if (wc.agent === me) return { holder: st.getAgent(claim.agent), wants: holder.waiting_for, direct: depth === 0 };
    holderId = wc.agent;
  }
  return null;
}
function iYield(me, other) {
  const a = (me && me.started) || 0, b = (other && other.started) || 0;
  return a !== b ? a > b : String(me.id) > String(other.id);
}

// ---------------------------------------------------------------- rendering
function renderStatus(st, me, { compact = false } = {}) {
  const present = st.gc();
  const others = Object.values(present).filter(a => a.id !== me);
  const claims = st.claims().filter(c => present[c.agent]);
  const byAgent = {};
  for (const c of claims) (byAgent[c.agent] = byAgent[c.agent] || []).push(c);
  const lines = [];
  const n = Object.keys(present).length;
  lines.push(`mom (${st.mode}): ${n} agent${n === 1 ? '' : 's'} active in ${path.basename(st.root)}${others.length ? '' : ' (just you)'}`);
  const order = [...(present[me] ? [present[me]] : []), ...others];
  for (const a of order) {
    const cs = (byAgent[a.id] || []).sort((x, y) => x.path.localeCompare(y.path));
    const files = cs.map(c => c.path + (c.modified ? '*' : '')).join(' ');
    const idle = a.id === me ? '' : `, active ${ago(a.heartbeat)}`;
    const waiting = a.waiting_for ? ` — waiting for ${a.waiting_for}` : '';
    lines.push(`  ${label(a, me)}${idle}${cs.length ? ` — ${cs.length} file${cs.length === 1 ? '' : 's'}: ${files}` : ' — no files claimed'}${waiting}`);
  }
  if (claims.some(c => c.modified)) lines.push('  (* = has uncommitted edits by that agent; wait for release before touching)');
  // recent notes from others
  const { events } = st.readLog(0);
  const notes = events.filter(e => e.type === 'note' && present[e.agent] && e.agent !== me).slice(-5);
  if (notes.length && !compact) {
    lines.push('  Notes from other agents:');
    for (const e of notes) lines.push(`    ${label(present[e.agent], me)} ${ago(e.ts)}: ${e.text}`);
  }
  return lines.join('\n');
}
function renderInbox(st, me) {
  const meRec = st.getAgent(me);
  // Only files this agent has edited, holds, or is waiting for concern it.
  const mine = { ...((meRec && meRec.edited) || {}) };
  for (const c of st.claims()) if (c.agent === me) mine[c.path] = 1;
  if (meRec && meRec.waiting_for) mine[meRec.waiting_for] = 1;
  const from = meRec ? (meRec.cursor || 0) : 0;
  const { events, end } = st.readLog(from);
  if (meRec && end !== from) { meRec.cursor = end; st.saveAgent(meRec); }
  const present = st.gc();
  const sharesFile = id => Object.keys((present[id] && present[id].edited) || {}).some(f => mine[f]);
  const lines = [];
  for (const e of events) {
    if (e.agent === me) continue;
    const who = present[e.agent] ? label(present[e.agent], me) : `[${short(e.agent)}]`;
    if (e.type === 'note') {
      if (sharesFile(e.agent)) lines.push(`${who} note: ${e.text}`);
    } else if (e.type === 'handoff') {
      const files = (e.modified || []).filter(f => mine[f]);
      if (files.length) lines.push(`${who} released edited file${files.length === 1 ? '' : 's'}: ${files.join(' ')} — re-read before editing (your earlier read is stale).`);
    } else if (e.type === 'overlap' && e.holder === me) {
      const held = st.getClaim(e.path);
      if (held && held.agent === me) lines.push(`${who} also edited ${e.path}, which you hold — re-Read it before your next edit to it.`);
    }
  }
  return lines.length ? `mom — updates from other agents:\n- ${lines.join('\n- ')}` : '';
}

const COLLIDE_TIP = cmd => `If you change an interface other code calls (signature, field, flag, export), tell the others: \`${cmd} note "<what changed>"\`. \`${cmd} status\` shows who holds what.`;

// ---------------------------------------------------------------- commands
function parseArgs(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-') && ['as', 'timeout', 'command', 'settings', 'root', 'n', 'mode'].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

function needSelf(st, flags) {
  st.ensure();
  const me = resolveSelf(st, null, flags);
  if (!me) die('cannot tell which agent you are. Set MOM_AGENT=<id> or pass --as <id>.');
  ensureAgent(st, me);
  return me;
}
/** Files this agent has edited in this session (never released; used to scope commits). */
function myEdits(st, me) { const a = st.getAgent(me); return Object.keys((a && a.edited) || {}).sort(); }
function noteEdit(st, me, rel) { if (!st._locked) return st.locked(() => noteEdit(st, me, rel)); const a = st.getAgent(me); if (!a) return; a.edited = a.edited || {}; a.edited[rel] = NOW(); st.saveAgent(a); }
/** Remember when this agent last looked at these files; a later write by someone else makes that read stale. */
function noteSeen(st, me, files) {
  if (!files.length) return;
  if (!st._locked) return st.locked(() => noteSeen(st, me, files));
  const a = st.getAgent(me); if (!a) return;
  a.seen = a.seen || {};
  for (const f of files) a.seen[f] = NOW();
  st.saveAgent(a);
}
function recordWrite(st, me, rel) { noteEdit(st, me, rel); noteSeen(st, me, [rel]); st.log({ agent: me, type: 'write', path: rel }); }
/** The first write by another agent to one of `files` since this agent last read that file, or null. An agent with no
 *  recorded read (it may have read through a glob, or not at all) counts from when it started: overwriting a file that
 *  someone changed since then, without reading it again, is exactly how their work gets lost. */
function lastWriteSinceRead(st, me, files) {
  const a = st.getAgent(me); if (!a || !files.length) return null;
  const seen = a.seen || {}, since = f => seen[f] || a.started || 0;
  const e = st.readLog(0).events.find(e => e.type === 'write' && e.agent !== me && files.includes(e.path) && e.ts > since(e.path));
  return e ? { ...e, unread: !seen[e.path] } : null;
}
// Lost-update repair. mom keeps each file as the agent last read it in full ("view") and as it was just before the
// agent's write ("pre"). If the write put back text that someone else changed in between, the change is restored.
function snapFile(st, me, kind, rel) { return path.join(st.dir, 'snap', encodeURIComponent(me), `${kind}-${encPath(rel)}`); }
function getSnap(st, me, kind, rel) { try { return fs.readFileSync(snapFile(st, me, kind, rel), 'utf8'); } catch { return null; } }
function putSnap(st, me, kind, rel, text) {
  const f = snapFile(st, me, kind, rel);
  if (text == null) { try { fs.unlinkSync(f); } catch {} return; }
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text);
}
function readText(st, rel) {
  try { const p = path.join(st.root, rel); return fs.statSync(p).size <= 1 << 20 ? fs.readFileSync(p, 'utf8') : null; } catch { return null; }
}
function noteView(st, me, files) { for (const f of files) { const t = readText(st, f); if (t != null) putSnap(st, me, 'view', f, t); } }
function beforeWrite(st, me, files) { for (const f of files) if (getSnap(st, me, 'view', f) != null) { const t = readText(st, f); if (t != null) putSnap(st, me, 'pre', f, t); } }
/** After a tool call: repair what this agent's writes undid. Returns messages for the agent. */
function afterWrite(st, me) {
  const dir = path.join(st.dir, 'snap', encodeURIComponent(me)), msgs = [];
  let names = []; try { names = fs.readdirSync(dir).filter(n => n.startsWith('pre-')); } catch {}
  for (const n of names) {
    const rel = decPath(n.slice(4)), pre = getSnap(st, me, 'pre', rel), view = getSnap(st, me, 'view', rel), post = readText(st, rel);
    putSnap(st, me, 'pre', rel, null);
    if (pre == null || view == null || post == null) continue;
    if (post === pre) { // the write did nothing, maybe because the text it expected had changed: say why, once per file
      if (pre !== view && getSnap(st, me, 'told', rel) == null) {
        putSnap(st, me, 'told', rel, '');
        msgs.push(`mom: other agents are editing ${rel} at the same time as you, so it has changed since you read it. That is expected: re-read it and apply your change to its current text, leaving their edits in place.`);
      }
      continue;
    }
    if (pre === view) { putSnap(st, me, 'view', rel, post); continue; } // nobody else changed it: the agent knows this text
    const m = merge3(view, pre, post);
    if (!m || readText(st, rel) !== post) continue;
    fs.writeFileSync(path.join(st.root, rel), m.text);
    putSnap(st, me, 'view', rel, m.text);
    st.log({ agent: me, type: 'restored', path: rel, n: m.restored.length });
    const q = s => JSON.stringify(s.length > 70 ? s.slice(0, 67) + '...' : s);
    const eg = m.restored.slice(0, 3).map(([a, b]) => `${q(a)} → ${q(b)}`).join('; ');
    msgs.push(`mom: your last command wrote ${rel} from an out-of-date copy and undid ${m.restored.length} change${m.restored.length === 1 ? '' : 's'} another agent made since you last read it (${eg}${m.restored.length > 3 ? '; …' : ''}). mom put ${m.restored.length === 1 ? 'it' : 'them'} back and kept your own changes. If you undid any on purpose, undo it again now that you've seen it; otherwise carry on, and re-read ${rel} before writing it from memory again.`);
  }
  return msgs;
}
function gitStaged(root) {
  try { return cp.execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch { return []; }
}
/** Other live agents with edits to `rel` in their *current* turn (a claim with edits, or an advisory overlap edit). */
function activeEditors(st, rel, me, present) {
  const c = st.getClaim(rel);
  const out = [];
  for (const a of Object.values(present)) {
    if (a.id === me) continue;
    const holds = c && c.agent === a.id && c.modified && st.claimValid(c, present);
    const inTurn = a.edited && a.edited[rel] && a.edited[rel] > Math.max(a.turn_ended || 0, a.released?.[rel] || 0) && NOW() - a.edited[rel] < IDLE_MS;
    if (holds || inTurn) out.push(a);
  }
  return out;
}

const commands = {
  init(st, { flags }) {
    const root = flags.root ? path.resolve(flags.root) : gitRootOrCwd();
    st = new State(root); // in-repo state: opt this checkout in explicitly, shareable with non-Claude tools
    st.ensure();
    const done = [`created ${path.relative(process.cwd(), st.dir) || '.mom'}/`];
    // .gitignore
    const gi = path.join(root, '.gitignore');
    const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!/^\.mom\/?$/m.test(cur)) { fs.writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '.mom/\n'); done.push('added .mom/ to .gitignore'); }
    if (!flags['no-hooks']) {
      const settingsPath = flags.settings ? path.resolve(flags.settings) : path.join(root, '.claude', 'settings.json');
      const cmd = flags.command || hookCommand();
      const res = installHooks(settingsPath, cmd);
      writeJSONAtomic(path.join(st.dir, 'config.json'), { ...readJSON(path.join(st.dir, 'config.json'), {}), cmd, mode: flags.mode === 'strict' ? 'strict' : 'advisory' });
      done.push(`${res} hooks in ${path.relative(process.cwd(), settingsPath)} (command: ${cmd} hook <event>)`);
    }
    if (!flags['no-skill']) {
      const src = path.join(__dirname, '..', 'skills', 'mom', 'SKILL.md');
      const dst = path.join(root, '.claude', 'skills', 'mom', 'SKILL.md');
      if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); done.push(`installed skill at ${path.relative(process.cwd(), dst)}`); }
    }
    out('mom: ' + done.join('; ') + `; mode: ${flags.mode === 'strict' ? 'strict' : 'advisory'}` + '\nStart two agents in this repo and run `mom status` to watch them coordinate.');
  },
  status(st, { flags }) {
    st.ensure();
    const me = resolveSelf(st, null, flags);
    if (flags.json) {
      const present = st.gc();
      return out(JSON.stringify({ root: st.root, me, agents: Object.values(present), claims: st.claims().filter(c => present[c.agent]) }, null, 2));
    }
    out(renderStatus(st, me));
  },
  plan(st, { flags, pos }) {
    const me = needSelf(st, flags);
    const text = pos[0];
    if (!text) die('usage: mom plan "<one-line goal>" [files...]');
    const files = pos.slice(1).map(f => st.rel(f)).filter(Boolean);
    ensureAgent(st, me, { plan: text });
    const got = [], held = [];
    for (const f of files) {
      const r = st.tryClaim(f, me);
      if (r.ok) got.push(f); else held.push({ f, owner: r.owner });
    }
    st.log({ agent: me, type: 'plan', text, files });
    const lines = [`plan recorded for [${short(me)}]: "${text}"`];
    if (got.length) lines.push(`claimed: ${got.join(' ')}`);
    for (const h of held) lines.push(`NOT claimed: ${h.f} is held by ${h.owner ? label(h.owner, me) : 'another agent'} — do that file last, or \`${st.cmd} wait ${h.f}\``);
    const others = st.liveAgents().filter(a => a.id !== me);
    if (others.length) lines.push(renderStatus(st, me, { compact: true }));
    out(lines.join('\n'));
  },
  claim(st, { flags, pos }) {
    const me = needSelf(st, flags);
    const files = pos.map(f => st.rel(f)).filter(Boolean);
    if (!files.length) die('usage: mom claim <files...> [--wait] [--timeout SEC] [--steal]');
    const deadline = NOW() + (parseInt(flags.timeout, 10) || 180) * 1000;
    const lines = [];
    for (const f of files) {
      let r = st.tryClaim(f, me, { steal: !!flags.steal, modified: !!flags.modified });
      if (!r.ok && flags.wait) {
        process.stderr.write(`mom: waiting for ${f} (held by ${r.owner ? label(r.owner, me) : '?'})…\n`);
        const meRec = ensureAgent(st, me, { waiting_for: f });
        let deadlocked = null;
        while (!r.ok && NOW() < deadline) {
          const dl = detectDeadlock(st, me, r.claim);
          if (dl && iYield(meRec, dl.holder)) { deadlocked = dl; break; }
          sleepMs(1500); r = st.tryClaim(f, me, { modified: !!flags.modified });
        }
        ensureAgent(st, me, { waiting_for: null });
        if (deadlocked) {
          st.log({ agent: me, type: 'deadlock', path: f, wants: deadlocked.wants, holder: deadlocked.holder.id });
          lines.push([
            `DEADLOCK on ${f}: it is held by ${label(deadlocked.holder, me)}, who is waiting for ${deadlocked.wants}, which YOU hold. You joined later, so you yield.`,
            `Do now: finish any in-progress edit to ${deadlocked.wants}, run \`${st.cmd} release ${deadlocked.wants}\`, then run \`${st.cmd} wait ${f}\` again (they will release it when their turn ends).`,
          ].join('\n'));
          process.exitCode = 4;
          continue;
        }
      }
      if (r.ok && flags.wait) {
        // Holding the claim is not enough if someone is mid-way through an advisory edit on it: wait for their turn to end.
        let editors = activeEditors(st, f, me, st.gc());
        if (editors.length) process.stderr.write(`mom: ${f} has in-progress edits by ${editors.map(a => label(a, me)).join(', ')}; waiting for their turn to end…\n`);
        ensureAgent(st, me, { waiting_for: f });
        while (editors.length && NOW() < deadline) {
          // Mutual wait: return blocked so the caller can release and retry.
          if (editors.some(a => a.waiting_for)) break;
          sleepMs(1500); editors = activeEditors(st, f, me, st.gc());
        }
        ensureAgent(st, me, { waiting_for: null });
        if (editors.length) {
          if (r.fresh) st.release(f, me);
          lines.push(`BLOCKED ${f}: another worker still has edits in progress; release other files and retry later.`);
          process.exitCode = 3;
          continue;
        }
      }
      if (r.ok) {
        if (flags.modified) noteEdit(st, me, f);
        const handed = st.readLog(0).events.some(e => e.type === 'handoff' && e.agent !== me && (e.modified || []).includes(f));
        lines.push(`claimed ${f}${handed ? ' — another agent edited this file earlier; re-read it before editing' : ''}`);
      } else {
        lines.push(`BLOCKED ${f}: held by ${r.owner ? label(r.owner, me) : 'another agent'}${r.claim && r.claim.modified ? ' (has uncommitted edits)' : ''}. Try \`${st.cmd} wait ${f}\` or work on other files first.`);
        process.exitCode = 3;
      }
    }
    out(lines.join('\n'));
  },
  begin(st, args) {
    args.flags.modified = true;
    return commands.claim(st, args);
  },
  wait(st, args) { args.flags.wait = true; return commands.claim(st, args); },
  release(st, { flags, pos }) {
    const me = needSelf(st, flags);
    const files = flags.all ? [...new Set([...st.claims().filter(c => c.agent === me).map(c => c.path), ...myEdits(st, me)])] : pos.map(f => st.rel(f)).filter(Boolean);
    if (!files.length && !flags.all) die('usage: mom release <files...> | --all');
    const released = [], modified = [];
    for (const f of files) { const c = st.release(f, me); if (c) { released.push(f); if (c.modified) modified.push(f); } }
    const a = st.getAgent(me);
    a.released ||= {};
    for (const f of files) {
      if (a.edited?.[f] && !released.includes(f) && a.edited[f] > (a.released[f] || 0)) { released.push(f); modified.push(f); }
      a.released[f] = NOW();
    }
    st.saveAgent(a);
    if (released.length) st.log({ agent: me, type: 'handoff', released, modified });
    out(released.length ? `released ${released.join(' ')}` : 'nothing to release');
  },
  note(st, { flags, pos }) {
    const me = needSelf(st, flags);
    if (!pos[0]) die('usage: mom note "<what changed and what others must do>"');
    st.log({ agent: me, type: 'note', text: pos[0] });
    const others = st.liveAgents().filter(a => a.id !== me).length;
    out(`note posted to ${others} other agent${others === 1 ? '' : 's'}.`);
  },
  who(st, { flags, pos }) {
    st.ensure();
    const me = resolveSelf(st, null, flags);
    for (const p of pos) {
      const rel = st.rel(p); const c = rel && st.getClaim(rel);
      if (c && st.claimValid(c)) out(`${rel}: held by ${label(st.getAgent(c.agent), me)} since ${ago(c.since)}${c.modified ? ' (uncommitted edits)' : ''}`);
      else out(`${rel || p}: free`);
    }
  },
  inbox(st, { flags }) {
    const me = needSelf(st, flags);
    out(renderInbox(st, me) || 'no updates from other agents.');
  },
  mine(st, { flags }) {
    // Registered filenames are not hunk ownership or an isolated Git index.
    const me = needSelf(st, flags);
    const files = myEdits(st, me);
    if (flags.json) out(JSON.stringify(files));
    else if (flags.null) process.stdout.write(files.map(f => f + '\0').join(''));
    else out(files.length ? files.join('\n') : '');
    if (!files.length) process.stderr.write('mom: you have not edited any files yet this session.\n');
  },
  log(st, { flags }) {
    st.ensure();
    const n = parseInt(flags.n, 10) || 30;
    const { events } = st.readLog(0);
    for (const e of events.slice(-n)) out(`${new Date(e.ts).toISOString()} [${short(e.agent)}] ${e.type}${e.text ? ` ${JSON.stringify(e.text)}` : ''}${e.files ? ' ' + e.files.join(' ') : ''}${e.released ? ' ' + e.released.join(' ') : ''}${e.path ? ' ' + e.path : ''}`);
  },
  leave(st, { flags }) {
    const me = needSelf(st, flags);
    leave(st, me); out(`[${short(me)}] left.`);
  },
  where(st) { out(st.dir || '(not in a repo)'); },
  hook(st, { pos }) { return runHook(st, pos[0]); },
  'init-codex'(st) { require('./codex').install(st.root, __filename); },
  'codex-hook'(st) { try { require('./codex').hook(__filename); } catch (e) { die(String(e), 2); } },
  version() { out(VERSION); },
  help() { out(HELP); },
};

function leave(st, me) {
  const mine = st.claims().filter(c => c.agent === me);
  const modified = mine.filter(c => c.modified).map(c => c.path);
  for (const c of mine) st.release(c.path, me);
  if (mine.length) st.log({ agent: me, type: 'handoff', released: mine.map(c => c.path), modified });
  st.log({ agent: me, type: 'leave' });
  try { fs.rmSync(path.join(st.dir, 'snap', encodeURIComponent(me)), { recursive: true, force: true }); } catch {}
  st.removeAgent(me);
}
function sleepMs(ms) {
  // synchronous sleep without busy-waiting (Atomics.wait on a shared buffer)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function gitRootOrCwd() {
  try { return cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return process.cwd(); }
}
function hookCommand() {
  // Prefer a PATH-resolvable `mom`; otherwise call this file by absolute path.
  try {
    const w = cp.execFileSync(process.platform === 'win32' ? 'where' : 'which', ['mom'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (w) return 'mom';
  } catch {}
  return `node ${JSON.stringify(fs.realpathSync(__filename))}`.replace(/^node "([^ "]+)"$/, 'node $1');
}
const HOOK_EVENTS = [
  ['SessionStart', '', 'session-start', 15],
  ['UserPromptSubmit', '', 'prompt', 10],
  ['PreToolUse', 'Edit|Write|MultiEdit|NotebookEdit', 'pre-edit', 10],
  ['PreToolUse', 'Bash', 'pre-bash', 10],
  ['PreToolUse', 'Read', 'pre-read', 10],
  ['PostToolUse', 'Edit|Write|MultiEdit|NotebookEdit|Bash|Task|Agent', 'post-tool', 10],
  ['Stop', '', 'stop', 10],
  ['SubagentStop', '', 'session-end', 10],
  ['SessionEnd', '', 'session-end', 10],
];
function installHooks(settingsPath, cmd) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const settings = readJSON(settingsPath, {});
  settings.hooks = settings.hooks || {};
  let added = 0;
  for (const [event, matcher, sub, timeout] of HOOK_EVENTS) {
    const list = (settings.hooks[event] = settings.hooks[event] || []);
    const command = `${cmd} hook ${sub}`;
    const exists = list.some(e => (e.hooks || []).some(h => typeof h.command === 'string' && / hook (session-start|prompt|pre-edit|pre-read|pre-bash|post-tool|stop|session-end)$/.test(h.command) && h.command.endsWith(` hook ${sub}`)));
    if (exists) continue;
    const entry = { hooks: [{ type: 'command', command, timeout }] };
    if (matcher) entry.matcher = matcher;
    list.push(entry); added++;
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return added ? `installed ${added}` : 'already had';
}

// ---------------------------------------------------------------- hooks
function readStdinJSON() {
  try { const s = fs.readFileSync(0, 'utf8'); return s.trim() ? JSON.parse(s) : {}; } catch { return {}; }
}
function hookOut(event, additionalContext) {
  if (!additionalContext) return;
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
}
const INLINE_WRITE = /(<<\s*['"]?\w+|\bopen\([^)]*,\s*(?:mode\s*=\s*)?['"][wa]|writeFile|appendFile|unlinkSync|renameSync|write_text|\.write\(|fs\.(promises\.)?writeFile)/;
const WRITEY = /(\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|>{1,2}\s*(?!&|\/dev\/null)|\btee\b|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bdd\b|\bpatch\b|\bgit\s+(apply|checkout|restore)\b|\bprettier\b.*--write|\beslint\b.*--fix|\bblack\b|\bruff\b.*(format|--fix)|\bgofmt\s+-w|\brustfmt\b)/;
// A script that writes a file. A heredoc alone proves nothing: `python3 - <<E` is a common way to read.
const SCRIPT_WRITE = /\bopen\([^)]*,\s*(?:mode\s*=\s*)?['"][wa]|writeFile|appendFile|renameSync|write_text|\.write\(/;
const SCRIPT_READ = /\.read\(|readFileSync|readFile\(|read_text|readlines/;
/** Which files would `cmd` replace wholesale with text the agent wrote earlier (`cat > f`, `tee f`, `cp x f`, a script
 *  that writes without reading)? Returns a list of path tokens, or 'all' when it cannot tell. In-place edits (`sed -i`,
 *  `perl -i`, a script that reads the file then writes it, `>>`) apply to the file's current text, so they cannot
 *  discard another agent's change and need no stale-read check. Heredoc bodies and quoted strings are not shell:
 *  `=>` or `a > b` inside them is not a redirect. */
function overwriteTargets(cmd) {
  // interpreter scripts (`python3 - <<E ... E`, `node -e "..."`), each judged on its own; a `cat > f <<E` body is data
  const scripts = [];
  for (const m of cmd.matchAll(/^([^\n]*<<-?\s*['"]?(\w+)['"]?[^\n]*)\n([\s\S]*?)\n\s*\2[ \t]*(?=\n|$)/gm)) if (/\b(python3?|node|perl|ruby|bun|deno)\b/.test(m[1])) scripts.push(m[3]);
  for (const m of cmd.matchAll(/\b(?:python3?|node|perl|ruby)\s+(?:-\w+\s+)*-[ce]\s+("(?:[^"\\]|\\.)*"|'[^']*')/g)) scripts.push(m[1]);
  if (scripts.some(s => SCRIPT_WRITE.test(s) && !SCRIPT_READ.test(s))) return 'all';
  const shell = cmd.replace(/(<<-?\s*['"]?(\w+)['"]?[^\n]*)\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, '$1')
    .replace(/(>\s*)?('[^']*'|"[^"]*")/g, (m, redir) => redir ? m : "''")
    .replace(/\bsed\s+(-[a-zA-Z]*i|--in-place)\S*/g, ' ').replace(/\bperl\s+-[a-zA-Z]*i\S*/g, ' ').replace(/>>/g, ' ');
  const out = [];
  for (const m of shell.matchAll(/(?:^|[^&\d])>\s*(?!&|\/dev\/null)("[^"]+"|'[^']+'|[^\s;&|<>()]+)/g)) out.push(m[1]);
  for (const m of shell.matchAll(/\btee\s+((?:-\S+\s+)*)([^\s;&|<>()]+)/g)) if (!/-\w*a|--append/.test(m[1])) out.push(m[2]);
  for (const m of shell.matchAll(/\b(?:cp|mv)\s+[^;&|\n]*?([^\s;&|<>()]+)\s*(?=$|[;&|\n])/g)) out.push(m[1]);
  for (const m of shell.matchAll(/\brm\s+([^;&|\n]*)/g)) out.push(...m[1].split(/\s+/).filter(t => t && !t.startsWith('-')));
  if (/\btruncate\b|\bdd\b|\bpatch\b|\bgit\s+(apply|checkout)\b|\bgit\s+restore\b(?![^;&|\n]*--staged)|\bprettier\b.*--write|\beslint\b.*--fix|\bblack\b|\bruff\b.*(format|--fix)|\bgofmt\s+-w|\brustfmt\b/.test(shell)) return 'all';
  return out.map(t => t.replace(/^["']|["']$/g, ''));
}
const GIT_TREEWIDE = [
  [/\bgit\s+stash\b(?!\s+(list|show))/, 'git stash would hide other agents\' uncommitted edits'],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, 'tree-wide checkout/restore would discard other agents\' edits'],
  [/\bgit\s+checkout\s+(?!--|-b\b|\S+\s+--\s+)\S+\s*$/, 'switching branches would move other agents\' working tree under them'],
  [/\bgit\s+switch\b/, 'switching branches would move other agents\' working tree under them'],
  [/\bgit\s+reset\s+--(hard|merge)\b/, 'hard reset would discard other agents\' edits'],
  [/\bgit\s+reset\b(?!.*\s--\s|.*\s(src|test|lib|\w+\/|\w+\.\w+)\b)/, 'a reset without a pathspec unstages or moves the branch under other agents; use `git restore --staged <your files>`'],
  [/\bgit\s+(update-ref|symbolic-ref)\b/, 'moving refs under a shared working tree strands other agents\' work'],
  [/\bgit\s+clean\b/, 'git clean would delete other agents\' new files'],
  [/\bgit\s+(rebase|merge|pull)\b/, 'rewriting the working tree while other agents edit it causes conflicts'],
  [/\bgit\s+add\s+(-A|--all|\.|\*)(\s|$)/, 'stage only your own files: `git add <files>`; other agents\' half-done work is in this tree'],
  [/\bgit\s+commit\s+(-[a-zA-Z]*a|--all)\b/, 'commit only your own files: `git add <files> && git commit`; other agents\' half-done work is in this tree'],
];
function onPath(name) {
  try { return !!cp.execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return false; }
}
/** Does every git invocation in `cmd` run outside this checkout (leading `cd <dir>`, or `git -C <dir>`)? */
function targetsOtherTree(st, cmd, cwd) {
  const unq = x => x.replace(/^["']|["']$/g, '');
  if ((cmd.match(/(^|[;&|]\s*)cd\s/g) || []).length > 1) return false; // several cds: too clever to judge, stay strict
  const cdm = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(&&|;)/.exec(cmd);
  const base = cdm ? path.resolve(cwd, unq(cdm[1])) : cwd;
  const gits = [...cmd.matchAll(/\bgit\s+(?:-C\s+("[^"]+"|'[^']+'|\S+)\s+)?/g)];
  if (!gits.length) return false;
  return gits.every(m => !st.rel(path.join(m[1] ? path.resolve(base, unq(m[1])) : base, '.x')));
}
function runHook(st, event) {
  const input = readStdinJSON();
  if (input.cwd) st = new State(locate(input.cwd));
  if (!st.enabled) return; // not a repo (or MOM_DISABLE): silent no-op, safe to install globally
  const me = resolveSelf(st, input, {});
  if (!me) return;
  st.ensure();
  switch (event) {
    case 'session-start': {
      ensureAgent(st, me, { pid: hostPidFromAncestors() });
      // Make `mom` callable from the agent's shell even when installed only as a plugin: put our bin/ on PATH.
      let cmd = 'mom';
      if (process.env.CLAUDE_ENV_FILE) {
        try {
          fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export MOM_AGENT=${JSON.stringify(me)}\n`);
          if (!onPath('mom') && process.platform !== 'win32') fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export PATH=${JSON.stringify(path.dirname(fs.realpathSync(__filename)))}:"$PATH"\n`);
        } catch {}
      } else if (!onPath('mom')) cmd = `node ${fs.realpathSync(__filename)}`;
      if (st.cfg.cmd !== cmd) st.saveCfg({ cmd });
      return; // silent: mom only speaks once agents touch the same files
    }
    case 'prompt': {
      ensureAgent(st, me); st.renewAll(me);
      out(renderInbox(st, me));
      return;
    }
    case 'pre-edit': {
      ensureAgent(st, me); st.renewAll(me);
      const ti = input.tool_input || {};
      const p = ti.file_path || ti.notebook_path || ti.path;
      if (!p) return;
      const rel = st.rel(p);
      if (!rel || rel.startsWith('.mom/')) return;
      const r = st.tryClaim(rel, me, { modified: true, observed: true });
      if (r.ok) { recordWrite(st, me, rel); beforeWrite(st, me, [rel]); return; }
      const owner = r.owner;
      const c = r.claim || {};
      const wholeFile = input.tool_name === 'Write';
      if (st.mode !== 'strict' && !wholeFile) {
        // advisory: allow the surgical edit, warn once per file, and tell the holder afterwards.
        const a = st.getAgent(me) || {};
        a.overlaps = a.overlaps || {};
        const first = !a.overlaps[rel];
        a.overlaps[rel] = NOW(); st.saveAgent(a);
        recordWrite(st, me, rel); beforeWrite(st, me, [rel]);
        st.log({ agent: me, type: 'overlap', path: rel, holder: c.agent });
        if (first) hookOut('PreToolUse', `mom: heads-up — ${rel} is also being edited right now by ${owner ? label(owner, me) : '[' + short(c.agent) + ']'}. Keep this edit small and local, don't reformat or rewrite the file, and re-Read it before further edits (its contents may change under you).${!Object.keys(a.overlaps).some(k => k !== rel) ? ' ' + COLLIDE_TIP(st.cmd) : ''}`);
        return;
      }
      st.log({ agent: me, type: 'blocked', path: rel, holder: c.agent });
      const msg = [
        `mom: BLOCKED — ${rel} is currently held by agent ${owner ? label(owner, me) : '[' + short(c.agent) + ']'} (claimed ${ago(c.since)}${c.edits ? `, ${c.edits} edit${c.edits === 1 ? '' : 's'} so far` : ''}).${wholeFile ? ' Rewriting the whole file would discard their edits; use the Edit tool for a surgical change instead.' : ''}`,
        `Do not edit this file now. Options: (a) do your other files first and come back; (b) run \`${st.cmd} wait ${rel}\` to block until it is released, then Read it again before editing; (c) if that agent is clearly gone, \`${st.cmd} claim --steal ${rel}\`.`,
      ].join('\n');
      process.stderr.write(msg + '\n');
      process.exit(2);
    }
    case 'pre-read': {
      ensureAgent(st, me);
      const rel = st.rel(String((input.tool_input || {}).file_path || ''));
      if (rel) noteSeen(st, me, [rel]);
      const ti = input.tool_input || {};
      if (rel && ti.offset == null && ti.limit == null) noteView(st, me, [rel]);
      return;
    }
    case 'pre-bash': {
      ensureAgent(st, me); st.renewAll(me);
      const raw = String((input.tool_input || {}).command || '');
      // `$(mom mine)` inside a git command stands for this agent's own files; a command that *is* a mom call is ours.
      const cmd = raw.replace(/\$\(\s*(?:node\s+\S*mom(?:\.js)?|mom)\s+mine\s*\)/g, 'MOM_MINE');
      if (!cmd.trim() || (/^\s*(?:cd\s+\S+\s*(?:;|&&)\s*)?(?:node\s+\S*mom(?:\.js)?|mom)\s/.test(cmd) && !/[;&|]\s*(?:git|sed|mv|cp|rm|tee|python3?|node|perl)\b/.test(cmd))) return;
      // Compare resolved paths, not substrings: `test/cli.test.js` must not match someone's `fixture/test/cli.test.js`.
      let cwd = input.cwd || st.root;
      const cdm = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(&&|;)/.exec(cmd);
      if (cdm) cwd = path.resolve(cwd, cdm[1].replace(/^["']|["']$/g, ''));
      const named = new Set(cmd.split(/[\s'"`;&|<>()=,]+/).filter(t => t && /[\w.]/.test(t) && !t.startsWith('-'))
        .map(t => st.rel(path.resolve(cwd, t.replace(/^\.\//, '')))).filter(Boolean));
      const files = [...named].filter(f => { try { return fs.statSync(path.join(st.root, f)).isFile(); } catch { return false; } });
      const writes = WRITEY.test(cmd) || SCRIPT_WRITE.test(cmd) ? files : [];
      // Shell overwrites skip the Edit tool's stale-file check, so make the same check here. It needs no live holder: the agent that changed the file may have finished already.
      const ow = writes.length ? overwriteTargets(cmd) : [];
      const owFiles = ow === 'all' ? writes : ow.map(t => st.rel(path.resolve(cwd, t.replace(/^\.\//, '')))).filter(f => writes.includes(f));
      const changed = lastWriteSinceRead(st, me, owFiles);
      if (changed) {
        st.log({ agent: me, type: 'blocked', kind: 'stale', path: changed.path, holder: changed.agent });
        process.stderr.write(`mom: BLOCKED — ${changed.path} was changed by another agent [${short(changed.agent)}] ${changed.unread ? 'since you started, and you have not read it since' : 'after you last read it'}, so this command could overwrite their edit. Nothing was written. Read the file again, then redo your change against its current text.\n`);
        process.exit(2);
      }
      noteSeen(st, me, files);
      // `cat f` on its own (not piped into head etc.) shows the agent the whole file
      const catted = cmd.split(/&&|\|\||;|\n/).filter(seg => /^\s*cat\s+[^|<>]+$/.test(seg)).join(' ');
      if (catted) noteView(st, me, files.filter(f => catted.split(/\s+/).some(t => t && st.rel(path.resolve(cwd, t.replace(/^\.\//, ''))) === f)));
      for (const f of writes) recordWrite(st, me, f);
      beforeWrite(st, me, writes);
      // Only agents with files in play can be affected by this command.
      const claimed = new Set(st.claims().map(c => c.agent));
      const others = st.liveAgents().filter(a => a.id !== me && (claimed.has(a.id) || Object.keys(a.edited || {}).length));
      if (!others.length) return;
      // A command aimed at another repository (`cd /elsewhere && git add -A`, `git -C /elsewhere ...`) is not ours to police.
      if (targetsOtherTree(st, cmd, input.cwd || st.root)) return;
      // `git -C dir -c k=v stash` is still `git stash`: drop git's global options before matching
      const gitCmd = cmd.replace(/\bgit((?:\s+-[Cc]\s+("[^"]+"|'[^']+'|\S+))+)/g, 'git');
      for (const [re, why] of GIT_TREEWIDE) {
        if (re.test(gitCmd)) {
          const mine = myEdits(st, me);
          const fix = /\bgit\s+(add|commit)\b/.test(cmd) && mine.length ? ` Your files this session: ${mine.join(' ')}. Do: \`git add ${mine.join(' ')} && git commit -m "..."\` (or \`git add $(${st.cmd} mine)\`).` : '';
          st.log({ agent: me, type: 'blocked', kind: 'git' });
          process.stderr.write(`mom: BLOCKED — ${others.length} other agent${others.length === 1 ? ' is' : 's are'} working on files in this tree; ${why}.${fix}\n`);
          process.exit(2);
        }
      }
      if (/\bgit\s+commit\b/.test(cmd)) {
        // Commit gate. Files in the index that another live agent is editing *right now* (holds with uncommitted edits)
        // would put their half-finished work into your commit: block, and say exactly how to proceed.
        // Files others edited earlier this session but released: one heads-up, then allow.
        const present = st.gc();
        // what the index will hold when `git commit` runs: what is staged now, plus anything a `git add` earlier in this command adds
        const cwd = input.cwd || st.root;
        const willAdd = [...cmd.matchAll(/\bgit\s+add\s+([^;&|\n]+)/g)].flatMap(m => m[1].trim().split(/\s+/))
          .filter(a => a && !a.startsWith('-') && a !== '--').flatMap(a => a === 'MOM_MINE' ? myEdits(st, me) : [st.rel(path.resolve(cwd, a.replace(/^["']|["']$/g, '')))]).filter(Boolean);
        const staged = [...new Set([...gitStaged(st.root), ...willAdd])];
        const busy = staged.map(f => ({ f, who: activeEditors(st, f, me, present) })).filter(x => x.who.length);
        const a = st.getAgent(me) || {};
        if (busy.length) {
          // Someone is mid-edit on a file you are committing: their half-finished hunks will ride along. In a shared tree
          // that is often unavoidable (v0.4 tried blocking here; agents waited out their timeouts and gave up, for no
          // fewer broken commits), so advisory mode warns once and lets the commit through. Strict mode blocks.
          const files = busy.map(h => h.f);
          const who = [...new Set(busy.flatMap(h => h.who.map(x => label(x, me))))].join(', ');
          const advice = `Make sure the tests are green right now, or \`git restore --staged ${files.join(' ')}\` and commit the rest; \`${st.cmd} wait ${files.join(' ')}\` returns when they are done.`;
          if (st.mode === 'strict') {
            st.log({ agent: me, type: 'blocked', path: files.join(' '), holder: busy[0].who[0].id, kind: 'commit' });
            process.stderr.write(`mom: BLOCKED — ${files.join(' ')} ${files.length === 1 ? 'has' : 'have'} edits in progress by ${who}; committing now would bake their half-finished changes into your commit. ${advice}\n`);
            process.exit(2);
          }
          const key = files.join(' ');
          if (a.commit_warned !== key) {
            a.commit_warned = key; st.saveAgent(a);
            hookOut('PreToolUse', `mom: heads-up — ${key} ${files.length === 1 ? 'has' : 'have'} edits in progress by ${who}; this commit will include their half-finished changes. ${advice}`);
          }
          return;
        }
        return;
      }
      if (WRITEY.test(cmd) || INLINE_WRITE.test(cmd)) {
        const present = st.gc();
        const theirs = st.claims().filter(c => c.agent !== me && present[c.agent]);
        const hit = theirs.find(c => named.has(c.path));
        if (hit) {
          const owner = present[hit.agent];
          // Advisory: an in-place shell edit (sed -i, a read-modify-write script) to a held file is the shell form of a
          // surgical Edit, so it gets the same treatment: allowed, with one heads-up per file. Overwrites stay blocked.
          const ow = overwriteTargets(cmd);
          const overwrites = ow === 'all' || ow.some(t => st.rel(path.resolve(cwd, t.replace(/^\.\//, ''))) === hit.path);
          if (st.mode !== 'strict' && !overwrites) {
            const a = st.getAgent(me); a.overlaps = a.overlaps || {};
            const first = !a.overlaps[hit.path];
            a.overlaps[hit.path] = NOW(); st.saveAgent(a);
            st.log({ agent: me, type: 'overlap', path: hit.path, holder: hit.agent });
            if (first) hookOut('PreToolUse', `mom: heads-up — ${hit.path} is also being edited right now by ${label(owner, me)}. Keep this edit small and local, and re-read the file before further edits (its contents may change under you).`);
            return;
          }
          st.log({ agent: me, type: 'blocked', kind: 'shell', path: hit.path, holder: hit.agent });
          process.stderr.write(`mom: BLOCKED — this command looks like it writes ${hit.path}, which is held by ${label(owner, me)}. Use the Edit tool (so ownership is tracked), do other work first, or \`${st.cmd} wait ${hit.path}\`.\n`);
          process.exit(2);
        }
      }
      return;
    }
    case 'post-tool': {
      ensureAgent(st, me);
      const parts = afterWrite(st, me);
      const inbox = renderInbox(st, me);
      if (inbox) parts.push(inbox);
      if (parts.length) hookOut('PostToolUse', parts.join('\n'));
      return;
    }
    case 'stop': {
      // Turn finished: release everything so idle agents never block others. Claims are re-acquired automatically on the next edit.
      const a = st.getAgent(me); if (!a) return;
      a.turn_ended = NOW(); st.saveAgent(a); // edits before this point are no longer "in progress"
      const mine = st.claims().filter(c => c.agent === me);
      if (!mine.length) return;
      const modified = mine.filter(c => c.modified).map(c => c.path);
      for (const c of mine) st.release(c.path, me);
      st.log({ agent: me, type: 'handoff', released: mine.map(c => c.path), modified });
      return;
    }
    case 'session-end': {
      if (st.getAgent(me)) leave(st, me);
      return;
    }
    default:
      die(`unknown hook event ${event}`);
  }
}

const HELP = `mom ${VERSION} — keep concurrent AI coding agents from stepping on each other.

Install: as a Claude Code plugin (/plugin marketplace add josephrich98/mom; /plugin install mom@mom) — works in every
git checkout with no further setup; state lives in ~/.mom/. Or per repo: \`mom init\` (.mom/ in the repo, hooks in
.claude/settings.json, skill), which other tools (Codex, Cursor, humans) can share.

Agent protocol:
  mom init-codex                 install Codex project hooks (review in /hooks)
  mom plan "<goal>" [files...]   announce what you're doing; reserve files
  mom status                     who is here, who holds what, recent notes
  mom note "<interface change>"  broadcast something others must know
  mom begin <files...> [--wait]  claim and mark files as being edited (hookless agents)
  mom mine [--json|--null]         files registered for editing, not hunk ownership
  mom claim <files...>           reserve files (hooks do this for Edit/Write automatically)
  mom wait <file> [--timeout S]  block until a file is free, then claim it
  mom release <files...>|--all   hand files back (hooks do this at end of turn)
  mom who <file>                 who holds a file
  mom inbox                      updates from other agents since you last looked
  mom log [--n N]                raw event log
  mom leave                      deregister yourself
  mom where                      where this checkout's state lives
Hooks:  mom hook <session-start|prompt|pre-edit|pre-read|pre-bash|post-tool|stop|session-end>
Modes:  mom init --mode advisory (default) | strict      (or MOM_MODE=...)
Env:    MOM_AGENT (identity), MOM_ROOT (repo root), MOM_HOME (state root, default ~/.mom),
        MOM_TTL_SEC (reservation TTL, default 900), MOM_IDLE_SEC (an edited file stops counting as mid-edit after this
        many seconds without edits by its holder, default 90; claims taken with \`mom begin\` are held until release), MOM_DISABLE=1 (hooks do nothing)
`;

// ---------------------------------------------------------------- main
(function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const cmd = pos.shift() || 'help';
  if (flags.version || cmd === '--version') return out(VERSION);
  const fn = commands[cmd];
  if (!fn) die(`unknown command "${cmd}"\n${HELP}`);
  const st = new State(locate(flags.root));
  try { fn(st, { flags, pos }); }
  catch (e) { die(e && e.stack || String(e)); }
})();
