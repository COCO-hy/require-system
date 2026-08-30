// dsh-engine.js — dsh 任务执行内核（从 dsh-passthrough 移植，单进程内嵌）
//
// 职责：在 require-system 进程内直接管理 dsh headless 子进程，提供并发安全的
// 任务执行。不再有独立的 passthrough HTTP 服务——本模块被 requirements.js
// 直接 require 调用，状态/事件/结果直接写回 executions 表。
//
// 并发模型（与原 passthrough 一致）：
//   - 同时运行的 dsh 进程上限 DSH_MAX_CONCURRENT（默认 4），超出排队
//   - tail 解码 node 进程上限 DSH_MAX_TAIL_PROC（默认 8），每 run 2s 缓存合并
//   - 会话归属：cwd → sessions/<proj>/ 子目录 + 全局 CLAIMED 集合，不串台
//
// 残留限制：同一 cwd 的两个并发任务仍可能"错配"（A 认领 B 的会话），
// 但不会"串台"——dsh headless 不输出 session id 的固有约束。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname);
const DSH_HOME = process.env.DSH_HOME || path.resolve(__dirname, '..', '.dsh-home');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const GUI = (process.env.DSH_GUI_URL || 'http://127.0.0.1:3080').replace(/\/$/, '');
const CREATE_NO_WINDOW = process.platform === 'win32' ? 0x08000000 : 0;

const MAX_CONCURRENT = parseInt(process.env.DSH_MAX_CONCURRENT || '4', 10);
const MAX_TAIL_PROC = parseInt(process.env.DSH_MAX_TAIL_PROC || '8', 10);
const TAIL_CACHE_TTL = 2000;        // ms
const RUN_TTL = 2 * 3600 * 1000;    // 已结束 run 保留 2h 后清理

const AGENT_TEAMS_CMD = '/agent-teams';

// 全局状态（进程内单例）
const CLAIMED = new Set();           // 已认领的会话目录路径
const LOCK_QUEUE = [];               // 串行化锁（Node 单线程，但异步竞态仍需保护临界区）
let _lockHeld = false;

// 信号量：Node 无原生，用计数器 + 等待队列实现
class Semaphore {
  constructor(max) { this._max = max; this._n = 0; this._q = []; }
  async acquire() {
    if (this._n < this._max) { this._n++; return; }
    await new Promise((resolve) => this._q.push(resolve));
  }
  tryAcquire() {
    if (this._n < this._max) { this._n++; return true; }
    return false;
  }
  release() {
    if (this._q.length) { this._q.shift()(); return; }  // 唤醒一个等待者，计数不变
    if (this._n > 0) this._n--;
  }
}
const RUN_SEM = new Semaphore(MAX_CONCURRENT);
const TAIL_SEM = new Semaphore(MAX_TAIL_PROC);

// 串行锁：保证 claimNewSession / DB 写入等临界区不交错
async function withLock(fn) {
  if (_lockHeld) { await new Promise((r) => LOCK_QUEUE.push(r)); }
  _lockHeld = true;
  try { return await fn(); }
  finally {
    if (LOCK_QUEUE.length) { LOCK_QUEUE.shift()(); }
    else { _lockHeld = false; }
  }
}

let _db = null;
let _dbNow = null;
function setDb(db, nowFn) { _db = db; _dbNow = nowFn; }

// ─────────────── 工具 ───────────────

function nowStr() { return _dbNow ? _dbNow() : new Date().toISOString().replace('T', ' ').slice(0, 19); }

function findDsh() {
  // Windows 上 `where dsh` 可能返回无扩展名的 shell 脚本（spawn 会 ENOENT），
  // 优先选 .cmd/.bat/.exe；都没有才退回第一个。
  try {
    const raw = process.platform === 'win32'
      ? execFileSync('where', ['dsh'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)
      : [execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()];
    if (!raw.length) return null;
    const withExt = raw.find((p) => /\.(cmd|bat|exe)$/i.test(p));
    return withExt || raw[0];
  } catch (e) { return null; }
}

/** cwd → sessions 下的 proj 目录名（与 dsh 生成逻辑一致）。
 * 路径按非 [A-Za-z0-9_-] 字符拆段、过滤空、用 - 连接，首尾各加 --。 */
function projDirName(cwd) {
  const parts = (String(cwd).split(/[^A-Za-z0-9_-]+/)).filter(Boolean);
  return '--' + parts.join('-') + '--';
}

/** 快照该 cwd 对应 proj 目录下已存在的会话目录（per-run baseline）。 */
function snapshotProjSessions(cwd) {
  const proj = path.join(SESSIONS, projDirName(cwd));
  if (!fs.existsSync(proj) || !fs.statSync(proj).isDirectory()) return new Set();
  return new Set(fs.readdirSync(proj).filter((n) => fs.statSync(path.join(proj, n)).isDirectory()).map((n) => path.join(proj, n)));
}

/** 认领一个属于本 run 的新会话目录。锁内认领，保证并发下不重复抢。 */
async function claimNewSession(run) {
  const proj = path.join(SESSIONS, projDirName(run.cwd));
  let projDirs;
  if (fs.existsSync(proj) && fs.statSync(proj).isDirectory()) {
    projDirs = [proj];
  } else if (fs.existsSync(SESSIONS) && fs.statSync(SESSIONS).isDirectory()) {
    projDirs = fs.readdirSync(SESSIONS).filter((n) => fs.statSync(path.join(SESSIONS, n)).isDirectory()).map((n) => path.join(SESSIONS, n));
  } else {
    return null;
  }
  const started = run._started - 2000;
  const baseline = run._baseline;
  const candidates = [];
  for (const pd of projDirs) {
    let entries;
    try { entries = fs.readdirSync(pd); } catch (e) { continue; }
    for (const name of entries) {
      const sess = path.join(pd, name);
      let st;
      try { st = fs.statSync(sess); } catch (e) { continue; }
      if (!st.isDirectory() || baseline.has(sess)) continue;
      if (st.mtimeMs > started) candidates.push([st.mtimeMs, sess]);
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b[0] - a[0]);  // 最新的优先
  return await withLock(() => {
    for (const [, p] of candidates) {
      if (!CLAIMED.has(p)) { CLAIMED.add(p); return p; }
    }
    return null;
  });
}

/** 团队模式用 /agent-teams slash command 激活，否则原样返回。 */
function buildTask(task, teams, profile = '') {
  task = String(task || '').trim();
  if (!teams) return task;
  let cmd = AGENT_TEAMS_CMD;
  const p = String(profile || '').trim();
  if (p) {
    if (!/^[A-Za-z0-9_-]+$/.test(p)) throw new Error(`非法的 AgentTeams profile 名：${p}`);
    cmd += ` --profile ${p}`;
  }
  return `${cmd} ${task}`;
}

// ─────────────── GUI RPC ───────────────

async function guiRpc(method, payload, timeout = 5000) {
  const body = JSON.stringify({ type: 'client-request', rpcId: `pt-${Date.now()}-${Math.random().toString(36).slice(2)}`, method, payload });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${GUI}/api/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctrl.signal });
    const data = await res.json();
    const result = data.result || {};
    if (!result.ok) throw new Error(String(result.error || JSON.stringify(data)));
    return result.value || {};
  } finally { clearTimeout(timer); }
}

async function registerToGui(run) {
  run.engine_meta.gui_status = 'registering';
  const wsList = await guiRpc('workspace.list', {});
  let target = (wsList.items || []).find((w) => w.path === run.cwd);
  if (!target) {
    const val = await guiRpc('workspace.create', { path: run.cwd });
    target = val.workspaceId ? val : (val.workspace || val);
  }
  await guiRpc('session.create', { workspaceId: target.workspaceId, sessionId: run.engine_meta.session_id });
  run.engine_meta.gui_status = 'registered';
}

async function findWorkspace(cwd) {
  const wsList = await guiRpc('workspace.list', {});
  let target = (wsList.items || []).find((w) => w.path === cwd);
  if (!target) {
    const val = await guiRpc('workspace.create', { path: cwd });
    target = val.workspaceId ? val : (val.workspace || val);
  }
  return target;
}

// ─────────────── executions 表读写 ───────────────

function appendLog(execId, entry) {
  const row = _db.prepare('SELECT logs FROM executions WHERE id = ?').get(execId);
  if (!row) return;
  let logs = [];
  try { logs = row.logs ? JSON.parse(row.logs) : []; } catch (e) { logs = []; }
  logs.push({ ...entry, timestamp: entry.timestamp || nowStr() });
  _db.prepare('UPDATE executions SET logs = ? WHERE id = ?').run(JSON.stringify(logs), execId);
}

function saveMeta(execId, meta) {
  _db.prepare('UPDATE executions SET engine_meta = ? WHERE id = ?')
    .run(JSON.stringify(meta), execId);
}

function loadMeta(execId) {
  const row = _db.prepare('SELECT engine_meta FROM executions WHERE id = ?').get(execId);
  if (!row || !row.engine_meta) return {};
  try { return JSON.parse(row.engine_meta); } catch (e) { return {}; }
}

// ─────────────── tail 解码 ───────────────

async function tailEvents(run, n = 24) {
  const meta = run.engine_meta || {};
  if (!meta.session_dir) return { events: [], note: '等待 dsh 创建会话…' };
  const now = Date.now();
  if (meta._tail_cache && now - meta._tail_cache[0] < TAIL_CACHE_TTL) return meta._tail_cache[1];
  const f = path.join(meta.session_dir, 'session.jsonl.zstd');
  if (!fs.existsSync(f)) return { events: [], note: '日志尚未落盘…' };
  if (!TAIL_SEM.tryAcquire()) {
    return meta._tail_cache ? meta._tail_cache[1] : { events: [], note: '解码繁忙，稍后重试' };
  }
  let result;
  try {
    const out = execFileSync('node', [path.join(ROOT, 'tail-session.js'), f, String(n), '--json'], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
    });
    result = JSON.parse(out || '{}');
  } catch (e) {
    result = { events: [], note: `解码失败: ${e && e.message}` };
  } finally { TAIL_SEM.release(); }
  meta._tail_cache = [Date.now(), result];
  return result;
}

// ─────────────── watch + launcher ───────────────

async function watchRun(execId, reqData, run) {
  const proc = run._proc;
  // 认领会话目录
  while (proc.exitCode === null && proc.signalCode === null && !proc.killed) {
    const sess = await claimNewSession(run);
    if (sess) {
      await withLock(() => {
        run.engine_meta.session_dir = sess;
        run.engine_meta.session_id = path.basename(sess);
        saveMeta(execId, run.engine_meta);
      });
      try { await registerToGui(run); saveMeta(execId, run.engine_meta); }
      catch (e) { run.engine_meta.gui_status = `failed: ${e.message}`; saveMeta(execId, run.engine_meta); }
      break;
    }
    await sleep(1000);
  }
  // 等待退出
  const rc = await new Promise((resolve) => { proc.on('exit', (code, sig) => resolve(sig ? -1 : code)); });
  let answer = '';
  try { answer = fs.readFileSync(run.engine_meta.log_path, 'utf8'); } catch (e) {}
  answer = answer.trim().slice(-4000);

  // tail 事件同步到 logs（运行期间持续；这里再取一次最终事件）
  // 注：运行期间的事件由 pollTailLoop 负责，这里只归档终态

  await withLock(() => {
    run.engine_meta.ended = Date.now();
    run.engine_meta.returncode = rc;
    run.engine_meta.answer = answer;
    saveMeta(execId, run.engine_meta);
  });
  // 终态归档交给 requirements.js 的 finalizeEngineRun（保留结果文件协议）
  if (typeof run._onFinalize === 'function') {
    run._onFinalize(answer);
  }
}

// 后台 tail 事件 → logs 同步循环（运行期间）
const _lastTailSeen = {};
async function pollTailLoop(execId, run) {
  const tick = async () => {
    if (run._done) return;
    const meta = run.engine_meta;
    if (meta.session_dir) {
      try {
        const tail = await tailEvents(run);
        const events = (tail && tail.events) || [];
        if (events.length) {
          const last = _lastTailSeen[execId] || 0;
          const fresh = events.filter((e) => !e.t || e.t > last);
          if (fresh.length) {
            _lastTailSeen[execId] = Math.max(last, ...events.map((e) => e.t || 0));
            for (const ev of fresh) {
              const t = ev.t ? new Date(ev.t).toLocaleTimeString('zh-CN', { hour12: false }) : '';
              appendLog(execId, { level: 'info', message: `[dsh${t ? ' ' + t : ''}] ${ev.type || ''}  ${ev.text || ''}` });
            }
          }
        }
      } catch (e) { /* ignore */ }
    }
    if (!run._done) setTimeout(tick, 4000);
  };
  setTimeout(tick, 3000);
}

async function launcher(execId, reqData, run, argv, cwd, env) {
  await RUN_SEM.acquire();
  try {
    if (run._cancelled) return;  // 排队中被取消
    await withLock(() => {
      run.status = 'running';
      run._started = Date.now();
      _db.prepare('UPDATE executions SET status = ? WHERE id = ?').run('running', execId);
    });
    const logPath = path.join(ROOT, '.dsh-tasks', `engine-${execId}.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const outFd = fs.openSync(logPath, 'a');
    let proc;
    let spawnErr = null;
    try {
      proc = spawn(argv[0], argv.slice(1), {
        cwd, env, stdio: ['ignore', outFd, outFd], windowsHide: true,
        ...(CREATE_NO_WINDOW ? { windowsHide: true } : {}),
      });
      // spawn 的同步异常和异步 error 事件都要捕获，否则未处理的 'error' 会让进程崩
      proc.on('error', (e) => { spawnErr = e; });
    } catch (e) {
      spawnErr = e;
      proc = null;
    } finally { fs.closeSync(outFd); }
    if (spawnErr || !proc || !proc.pid) {
      appendLog(execId, { level: 'error', message: `启动 dsh 失败：${(spawnErr && spawnErr.message) || 'no pid'}` });
      await withLock(() => {
        _db.prepare("UPDATE executions SET status = 'failed', completed_at = ? WHERE id = ?").run(nowStr(), execId);
        _db.prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?').run('failed', nowStr(), reqData.id);
      });
      return;
    }
    run._proc = proc;
    run._baseline = snapshotProjSessions(cwd);
    run.engine_meta.pid = proc.pid;
    run.engine_meta.log_path = logPath;
    saveMeta(execId, run.engine_meta);
    pollTailLoop(execId, run);
    await watchRun(execId, reqData, run);
  } finally {
    run._done = true;
    RUN_SEM.release();
  }
}

// ─────────────── 公共 API ───────────────

/**
 * 提交任务，立即返回 runId。内部 launcher 异步排队+spawn+watch。
 * onFinalize(answer) 在 run 终态时被调用（由 requirements.js 实现，读结果文件归档）。
 */
async function startRun({ task, cwd, teams = true, fullAccess = true, profile = '', execId, reqData, onFinalize }) {
  const dsh = findDsh();
  if (!dsh) throw new Error('找不到 dsh 命令：请确认 dsh 在 PATH 上');
  cwd = path.resolve(cwd);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`工作目录不存在：${cwd}`);
  task = String(task || '').trim();
  if (!task) throw new Error('任务内容为空');
  const finalTask = buildTask(task, teams, profile);

  const env = { ...process.env };
  if (fullAccess) env.DSH_PERMISSION_MODE = 'danger-full-access';

  let argv;
  if (/^.*\.(cmd|bat)$/i.test(dsh)) argv = ['cmd', '/c', dsh, '--profile', 'headless', finalTask];
  else argv = [dsh, '--profile', 'headless', finalTask];

  const run = {
    execId, cwd, status: 'queued', _started: Date.now(), _proc: null,
    _baseline: new Set(), _cancelled: false, _done: false, _onFinalize: onFinalize,
    engine_meta: { pid: null, session_id: null, session_dir: null, log_path: '', returncode: null, answer: '', gui_status: null },
  };
  await withLock(() => {
    _db.prepare('UPDATE executions SET status = ? WHERE id = ?').run('pending', execId);
    saveMeta(execId, run.engine_meta);
  });
  setImmediate(() => launcher(execId, reqData, run, argv, cwd, env).catch((e) => {
    appendLog(execId, { level: 'error', message: `launcher 异常：${e && e.message}` });
  }));
  return { runId: String(execId) };
}

async function stopRun(runId, execId) {
  // runId === execId；从 meta 读 pid
  const meta = loadMeta(execId);
  if (meta.pid) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(meta.pid)], { windowsHide: true });
      else process.kill(meta.pid);
    } catch (e) { /* ignore */ }
  }
}

function getRun(execId) {
  const meta = loadMeta(execId);
  const exec = _db.prepare('SELECT id, status, started_at, completed_at FROM executions WHERE id = ?').get(execId);
  if (!exec) return null;
  return {
    id: String(execId),
    status: exec.status === 'pending' ? 'queued' : exec.status === 'completed' ? 'done' : exec.status === 'failed' ? 'failed' : 'running',
    pid: meta.pid, session_id: meta.session_id, session_dir: meta.session_dir,
    answer: meta.answer || '', returncode: meta.returncode,
  };
}

// ─────────────── 清理线程 ───────────────

function cleanupLoop() {
  setInterval(() => {
    const now = Date.now();
    const ended = _db.prepare("SELECT id, engine_meta, completed_at FROM executions WHERE status IN ('completed','failed') AND completed_at IS NOT NULL").all();
    for (const row of ended) {
      const t = Date.parse((row.completed_at || '').replace(' ', 'T'));
      if (!isFinite(t) || now - t <= RUN_TTL) continue;
      let meta = {};
      try { meta = JSON.parse(row.engine_meta || '{}'); } catch (e) {}
      if (meta.session_dir) CLAIMED.delete(meta.session_dir);
    }
  }, 600000);
}

function init(db, nowFn) {
  setDb(db, nowFn);
  cleanupLoop();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  init, startRun, stopRun, getRun, tailEvents,
  // 导出供测试
  _internal: { projDirName, buildTask, Semaphore, RUN_SEM, TAIL_SEM, withLock },
};
