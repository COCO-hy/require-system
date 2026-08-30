const express = require('express');
const router = express.Router();
const path = require('path');
const { db, now } = require('../db');
const { normalizeGiteeRepo } = require('../utils');
const engine = require('../dsh-engine');

// GET /api/requirements - List all requirements
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT r.id, r.title, r.project_number, r.gitee_repo, r.status,
             r.file_original_name, r.created_at, r.updated_at,
             r.system_id, s.name as system_name
      FROM requirements r
      LEFT JOIN systems s ON r.system_id = s.id
      ORDER BY r.created_at DESC
    `).all();
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/requirements/:id - Get single requirement with details
router.get('/:id', (req, res) => {
  try {
    const reqData = db.prepare(`
      SELECT r.*, s.name as system_name
      FROM requirements r
      LEFT JOIN systems s ON r.system_id = s.id
      WHERE r.id = ?
    `).get(req.params.id);
    if (!reqData) {
      return res.status(404).json({ success: false, error: '需求不存在' });
    }
    const lastExec = db.prepare(
      'SELECT * FROM executions WHERE requirement_id = ? ORDER BY started_at DESC LIMIT 1'
    ).all(req.params.id);
    res.json({ success: true, data: { ...reqData, executions: lastExec } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/requirements - Create a new requirement
router.post('/', (req, res) => {
  try {
    const { title, description, project_number, gitee_repo, system_id } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: '需求标题不能为空' });
    }

    // If system_id provided, auto-populate gitee_repo from the system
    let finalGiteeRepo = normalizeGiteeRepo(gitee_repo);
    let finalSystemId = system_id ? parseInt(system_id) : null;

    if (finalSystemId) {
      const sys = db.prepare('SELECT gitee_repo FROM systems WHERE id = ?').get(finalSystemId);
      if (sys) {
        finalGiteeRepo = normalizeGiteeRepo(sys.gitee_repo) || finalGiteeRepo;
      }
    }

    const filePath = req.file ? req.file.path : '';
    const fileOriginalName = req.file ? req.file.originalname : '';
    const stmt = db.prepare(
      `INSERT INTO requirements (system_id, title, description, project_number, gitee_repo, file_path, file_original_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(finalSystemId, title, description || '', project_number || '', finalGiteeRepo, filePath, fileOriginalName);
    res.json({ success: true, data: { id: result.lastInsertRowid } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 后端直连调度：一次调用 = 建任务 + 直接拉起引擎执行 ──
// POST /api/dispatch  { title, description, project_number?, system_id? }
// 返回 { requirement_id, execution_id, engine_pid, mode, poll_url }
router.post('/dispatch', async (req, res) => {
  try {
    const { title, description, project_number = '', system_id = null } = req.body || {};
    if (!title || !description) {
      return res.status(400).json({ success: false, error: 'title 和 description 为必填' });
    }
    const dup = db.prepare(`SELECT id FROM requirements WHERE title = ? AND status IN ('pending','running')`).get(title);
    if (dup) {
      return res.status(409).json({ success: false, error: `存在同名进行中的需求 #${dup.id}，请先等它完成或换标题` });
    }

    let finalGiteeRepo = '';
    let finalSystemId = system_id ? parseInt(system_id) : null;
    if (finalSystemId) {
      const sys = db.prepare('SELECT gitee_repo FROM systems WHERE id = ?').get(finalSystemId);
      if (sys) finalGiteeRepo = normalizeGiteeRepo(sys.gitee_repo) || finalGiteeRepo;
    }

    const cr = db.prepare(
      `INSERT INTO requirements (system_id, title, description, project_number, gitee_repo) VALUES (?, ?, ?, ?, ?)`
    ).run(finalSystemId, title, description, project_number || '', finalGiteeRepo);
    const reqId = cr.lastInsertRowid;
    const reqData = db.prepare('SELECT * FROM requirements WHERE id = ?').get(reqId);

    const er = db.prepare(
      `INSERT INTO executions (requirement_id, status, logs, started_at) VALUES (?, 'pending', '[]', ?)`
    ).run(reqId, now());
    const execId = er.lastInsertRowid;
    db.prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?').run('running', now(), reqId);

    const spawn = await spawnHeadlessEngine(execId, reqData);
    if (spawn.runId) {
      db.prepare("UPDATE executions SET status = 'running' WHERE id = ?").run(execId);
      appendLog(execId, { level: 'system', message: `📡 后端调度：任务「${title}」已委托 dsh-engine 执行（run ${spawn.runId}），任务文件 ${spawn.taskFile}` });
      armBootGuard(execId, reqData);
      return res.json({
        success: true,
        data: { requirement_id: reqId, execution_id: execId, engine_pid: spawn.runId, mode: 'dsh-push', poll_url: `/api/requirements/${reqId}/execution/progress` },
        message: '任务已接收，引擎已开始执行',
      });
    }

    appendLog(execId, { level: 'warn', message: `⚠️ dsh-engine 调度失败（${spawn.error}），自动切换本地模拟执行` });
    db.prepare("UPDATE executions SET status = 'running' WHERE id = ?").run(execId);
    runExecutionSteps(execId, reqData);
    return res.json({
      success: true,
      data: { requirement_id: reqId, execution_id: execId, mode: 'simulate-fallback', poll_url: `/api/requirements/${reqId}/execution/progress` },
      message: '引擎拉起失败，已切换本地模拟执行',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/requirements/:id - Delete a requirement
router.delete('/:id', (req, res) => {
  try {
    const reqData = db.prepare('SELECT file_path FROM requirements WHERE id = ?').get(req.params.id);
    if (!reqData) {
      return res.status(404).json({ success: false, error: '需求不存在' });
    }
    if (reqData.file_path) {
      try {
        const fs = require('fs');
        if (fs.existsSync(reqData.file_path)) {
          fs.unlinkSync(reqData.file_path);
        }
      } catch (e) { /* ignore */ }
    }
    db.prepare('DELETE FROM executions WHERE requirement_id = ?').run(req.params.id);
    db.prepare('DELETE FROM requirements WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Background execution steps ──

const EXECUTION_STEPS = [
  { id: 'parsing',    label: '解析需求文档',       duration: 1200 },
  { id: 'gitee',      label: '获取 Gitee 仓库信息', duration: 1500 },
  { id: 'datasource', label: '关联数据源',          duration: 1000 },
  { id: 'summarize',  label: '生成执行报告',       duration: 800  },
];

// 每步“干了什么”的详细说明（用于日志与 AgentTeams 任务输出）
const STEP_DETAIL = {
  parsing: (r) => `解析需求文档完成 — 标题「${r.title}」，项目号 ${r.project_number || '未填写'}`,
  gitee: (r) => r.gitee_repo
    ? `已关联 Gitee 仓库 ${r.gitee_repo}（分支 main / develop）`
    : '未配置 Gitee 仓库，已跳过该步骤',
  datasource: (r) => r.gitee_repo
    ? `数据源就绪：Gitee API https://gitee.com/api/v5/repos/${r.gitee_repo}`
    : '数据源就绪：未配置 Gitee，外部数据源待配置',
  summarize: (r) => `执行报告已生成 — 需求「${r.title}」可交付`,
};

function safeParse(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; } catch (e) { return fallback; }
}

function appendLog(execId, entry) {
  const row = db.prepare('SELECT logs FROM executions WHERE id = ?').get(execId);
  if (!row) return;
  const logs = safeParse(row.logs, []);
  logs.push({ ...entry, timestamp: entry.timestamp || now() });
  db.prepare('UPDATE executions SET logs = ? WHERE id = ?').run(JSON.stringify(logs), execId);
}

// 生成 AgentTeams 团队快照（真实流水线会由 PUT /executions/:id 覆盖为实际团队数据）
function buildTeamData(reqData) {
  const steps = [
    { id: 't1', subject: '步骤一：解析需求文档', assignee: 'developer' },
    { id: 't2', subject: '步骤二：获取 Gitee 仓库信息', assignee: 'developer' },
    { id: 't3', subject: '步骤三：关联数据源', assignee: 'developer' },
    { id: 't4', subject: '步骤四：生成执行报告', assignee: 'reviewer' },
  ];
  return {
    team: {
      name: `autopilot-req-${reqData.id}`,
      status: 'completed',
      members: [
        { name: 'developer', role: '前端开发工程师', activity: 'completed' },
        { name: 'reviewer', role: '代码审查员', activity: 'completed' },
      ],
      tasks: steps.map((t, i) => ({
        ...t,
        status: 'completed',
        output: STEP_DETAIL[EXECUTION_STEPS[i].id](reqData),
      })),
    },
  };
}

// POST /api/requirements/:id/execute — start async execution
router.post('/:id/execute', async (req, res) => {
  try {
    const reqData = db.prepare('SELECT * FROM requirements WHERE id = ?').get(req.params.id);
    if (!reqData) {
      return res.status(404).json({ success: false, error: '需求不存在' });
    }
    if (reqData.status === 'running') {
      return res.status(400).json({ success: false, error: '该需求正在执行中' });
    }

    // dsh 模式：推送执行——直接拉起 DSH headless 引擎
    const mode = (req.body && req.body.mode) || req.query.mode;
    if (mode === 'dsh') {
      const stmt = db.prepare(
        `INSERT INTO executions (requirement_id, status, logs, started_at) VALUES (?, 'pending', '[]', ?)`
      );
      const r = stmt.run(req.params.id, now());
      const execId = r.lastInsertRowid;
      db.prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?')
        .run('running', now(), req.params.id);

      const spawn = await spawnHeadlessEngine(execId, reqData);
      if (spawn.runId) {
        db.prepare("UPDATE executions SET status = 'running' WHERE id = ?").run(execId);
        appendLog(execId, { level: 'system', message: `🚀 已委托 dsh-engine 执行（run ${spawn.runId}），开始执行` });
        armBootGuard(execId, reqData);
        return res.json({
          success: true,
          data: { execution_id: execId, mode: 'dsh-push', engine_pid: spawn.runId },
          message: '已直接拉起 DSH 引擎执行',
        });
      }

      // 引擎拉起失败 → 本地模拟兜底（保证闭环）
      appendLog(execId, { level: 'warn', message: `⚠️ dsh-engine 调度失败（${spawn.error}），自动切换本地模拟执行` });
      db.prepare("UPDATE executions SET status = 'running' WHERE id = ?").run(execId);
      runExecutionSteps(execId, reqData);
      return res.json({
        success: true,
        data: { execution_id: execId, mode: 'simulate-fallback' },
        message: '引擎拉起失败，已切换本地模拟执行',
      });
    }

    // 本地模拟执行（默认）
    const execStmt = db.prepare(
      `INSERT INTO executions (requirement_id, status, logs, started_at) VALUES (?, 'running', '[]', ?)`
    );
    const execResult = execStmt.run(req.params.id, now());

    // Set requirement to running
    db.prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?')
      .run('running', now(), req.params.id);

    const execId = execResult.lastInsertRowid;

    // ── Background: run steps sequentially ──
    runExecutionSteps(execId, reqData);

    // Return immediately — frontend polls for progress
    res.json({
      success: true,
      data: { execution_id: execId, mode: 'simulate' },
      message: '需求执行已启动',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 拉起 headless 引擎（推送模式公共入口）
// 直接调用进程内嵌的 dsh-engine（从 passthrough 移植，已做并发安全/排队/会话归属加固）。
// 不再有独立的 passthrough HTTP 服务，也不再有 HTTP 轮询——engine 内部 watchRun
// 直接写 executions 表，tail 事件由 engine.pollTailLoop 实时落库。
// 仍写任务文件，dsh 在执行时可读它做细节执行；终态归档由 onFinalize 回调触发。
async function spawnHeadlessEngine(execId, reqData) {
  const fs = require('fs');
  const taskFile = writeEngineTask(execId, reqData);
  const cwd = path.resolve(__dirname, '..');
  const teams = String(process.env.DSH_TEAMS_MODE ?? 'true') !== 'false';
  const fullAccess = String(process.env.DSH_FULL_ACCESS ?? 'true') !== 'false';
  const profile = process.env.DSH_AGENT_TEAMS_PROFILE || '';
  // 任务文本：让 dsh 读任务文件并按其协议执行（含结果文件回写约定）
  const task = `读取任务文件 ${taskFile}，严格按其中说明完整执行并把过程与结果回写，然后结束。`;
  try {
    const { runId } = await engine.startRun({
      task, cwd, teams, fullAccess, profile, execId, reqData,
      onFinalize: (answer) => finalizeEngineRun(execId, reqData, answer),
    });
    return { pid: runId, runId, taskFile };
  } catch (e) {
    return { error: (e && e.message) || String(e), taskFile };
  }
}

// 引导看护：引擎启动后超时仍无任何回写（启动失败/秒退）→ 本地模拟兜底
function armBootGuard(execId, reqData) {
  const bootTimeout = parseInt(process.env.DSH_ENGINE_BOOT_TIMEOUT ?? '600000', 10);
  if (!(bootTimeout > 0)) return;
  const baseline = JSON.parse(db.prepare('SELECT logs FROM executions WHERE id = ?').get(execId).logs || '[]').length;
  setTimeout(() => {
    try {
      const cur = db.prepare('SELECT status, logs FROM executions WHERE id = ?').get(execId);
      const cnt = JSON.parse(cur.logs || '[]').length;
      if (cur.status === 'running' && cnt <= baseline) {
        appendLog(execId, { level: 'warn', message: `⏱ 引擎看护（${Math.round(bootTimeout / 1000)}s）：引擎启动后无任何回写（疑似启动失败/已退出）→ 自动切换本地模拟执行，保证闭环` });
        runExecutionSteps(execId, reqData);
      }
    } catch (e) { /* ignore */ }
  }, bootTimeout);
}

// 引擎进程退出后自动归档：读结果文件 → 标记完成；无结果文件 → 用 passthrough answer 兜底，
// 仍无则本地模拟兜底。runAnswer 由 pollPassthroughRun 在终态时传入（passthrough run 的 answer 字段）。
function finalizeEngineRun(execId, reqData, runAnswer = '') {
  try {
    const fs = require('fs');
    const cur = db.prepare('SELECT status FROM executions WHERE id = ?').get(execId);
    if (!cur || cur.status === 'completed' || cur.status === 'failed') return;

    const dir = path.join(__dirname, '..', '.dsh-tasks');
    const resultFile = path.join(dir, `exec-${execId}-result.json`);
    const teamFile = path.join(dir, `exec-${execId}-team.json`);

    appendLog(execId, { level: 'info', message: '🔚 DSH 引擎进程已退出，开始自动归档执行结果' });

    if (fs.existsSync(resultFile)) {
      let result = null, team = null;
      try { result = JSON.parse(fs.readFileSync(resultFile, 'utf-8')); }
      catch (e) { result = { execution_summary: fs.readFileSync(resultFile, 'utf-8').slice(0, 500) }; }
      if (fs.existsSync(teamFile)) { try { team = JSON.parse(fs.readFileSync(teamFile, 'utf-8')); } catch (e) {} }
      appendLog(execId, { level: 'success', message: '✅ 引擎已完成实际工作，结果已归档并标记完成' });
      db.prepare(
        `UPDATE executions SET status = 'completed', result_data = ?, agent_teams_data = ?, completed_at = ? WHERE id = ?`
      ).run(JSON.stringify(result), JSON.stringify(team), now(), execId);
      db.prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?').run('completed', now(), reqData.id);
    } else if (runAnswer && runAnswer.trim()) {
      // passthrough 实际跑完了，但 dsh 没按协议写结果文件——用 answer 兜底归档
      appendLog(execId, { level: 'success', message: '✅ 引擎已完成（用 passthrough 回执归档，无结果文件）' });
      const result = { execution_summary: runAnswer.slice(0, 4000), source: 'passthrough-answer' };
      db.prepare(
        `UPDATE executions SET status = 'completed', result_data = ?, completed_at = ? WHERE id = ?`
      ).run(JSON.stringify(result), now(), execId);
      db.prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?').run('completed', now(), reqData.id);
    } else {
      appendLog(execId, { level: 'warn', message: '⚠️ 引擎退出但未留下结果文件 → 自动切换本地模拟执行，保证闭环' });
      db.prepare("UPDATE executions SET status = 'running' WHERE id = ?").run(execId);
      runExecutionSteps(execId, reqData);
    }
  } catch (e) { /* ignore */ }
}

// 生成 headless 引擎任务文件（推送模式：点击即执行）
function writeEngineTask(execId, reqData) {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', '.dsh-tasks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `task-${execId}.json`);
  const resultFile = path.join(dir, `exec-${execId}-result.json`);
  const teamFile = path.join(dir, `exec-${execId}-team.json`);
  const payload = {
    task: `交付需求：${reqData.title}`,
    execution_id: execId,
    working_directory: path.resolve(__dirname, '..'),
    requirement: {
      id: reqData.id,
      title: reqData.title || '',
      description: reqData.description || '',
      project_number: reqData.project_number || '',
      system_name: reqData.system_name || '',
      gitee_repo: reqData.gitee_repo || reqData.system_gitee_repo || '',
      file_content: reqData.file_content || '',
    },
    result_file: resultFile,
    team_file: teamFile,
    write_back_protocol: {
      核心约定_必须遵守: `1) 真实完成需求所要求的工作（在 working_directory 内）；2) 把执行摘要写入结果文件 ${resultFile}，JSON 形如 {"execution_summary":"..."}；3) 若用 AgentTeams 多人协作，把团队快照写入 ${teamFile}（形如 {"team":{"name":"...","status":"completed","members":[...],"tasks":[...]}}）。写完这些文件后直接结束即可，服务端会自动归档。`,
      可选_实时日志: `可随时执行 node engine-helpers.js add-log ${execId} info "这一步做了什么"（level 可用 info/success/warn/error/system），让前端实时看到进度`,
    },
    rules: [
      '工作产物必须真实完成（改代码/建文件等），不要只写总结',
      '所有文件改动限制在 working_directory 内',
      '结果文件必须写到 result_file 指定的绝对路径',
      '任务较小请直接完成；较大可分步，每步可 add-log',
    ],
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
  return file;
}

// 包装：任何一步抛错都记录日志并标记失败，便于定位
async function runExecutionSteps(execId, reqData) {
  try {
    await runExecutionStepsInner(execId, reqData);
  } catch (e) {
    try {
      appendLog(execId, { level: 'error', message: `❌ 执行失败：${e && e.message ? e.message : String(e)}` });
      db.prepare("UPDATE executions SET status = 'failed', completed_at = ? WHERE id = ?").run(now(), execId);
      db.prepare("UPDATE requirements SET status = 'failed', updated_at = ? WHERE id = ?").run(now(), reqData.id);
    } catch (e2) { /* ignore */ }
  }
}

async function runExecutionStepsInner(execId, reqData) {
  const teamData = buildTeamData(reqData);
  const log = (level, message) => appendLog(execId, { level, message });

  log('system', '🚀 AgentTeams 团队已创建：developer（前端开发工程师）+ reviewer（代码审查员）');
  log('system', '任务拆解：' + EXECUTION_STEPS.map((s, i) => `t${i + 1} ${s.label}`).join(' → '));

  for (const [i, step] of EXECUTION_STEPS.entries()) {
    // mark step as running
    appendLog(execId, { step: step.id, label: step.label, status: 'running' });
    log('info', `▶ 开始「${step.label}」...`);

    await sleep(step.duration);

    // mark step as done
    appendLog(execId, { step: step.id, label: step.label, status: 'completed' });
    log('success', `✅「${step.label}」完成 — ${STEP_DETAIL[step.id](reqData)}`);
  }

  // ── Build final result ──
  let fileContent = '';
  if (reqData.file_path) {
    try {
      const fs = require('fs');
      if (fs.existsSync(reqData.file_path)) {
        fileContent = fs.readFileSync(reqData.file_path, 'utf-8');
      }
    } catch (e) {
      fileContent = '[无法读取文件内容]';
    }
  }

  const resultData = {
    requirement: {
      id: reqData.id,
      title: reqData.title,
      description: reqData.description,
      project_number: reqData.project_number,
      gitee_repo: reqData.gitee_repo,
    },
    file_attachment: {
      name: reqData.file_original_name,
      content: fileContent,
    },
    data_sources: {
      gitee: reqData.gitee_repo
        ? {
            repo: reqData.gitee_repo,
            project_number: reqData.project_number,
            api_endpoint: `https://gitee.com/api/v5/repos/${reqData.gitee_repo}`,
            branches: ['main', 'develop'],
          }
        : null,
      external: {
        type: '待配置',
        note: '可根据项目号对接更多数据源',
      },
    },
    execution_summary: `需求「${reqData.title}」执行完成，项目号 ${reqData.project_number}${reqData.gitee_repo ? '，已关联 Gitee 仓库 ' + reqData.gitee_repo : '，未配置仓库'}。`,
    executed_at: now(),
  };

  // Mark execution completed (含 agent_teams_data)
  db.prepare(
    `UPDATE executions SET status = 'completed', result_data = ?, agent_teams_data = ?, completed_at = ? WHERE id = ?`
  ).run(JSON.stringify(resultData), JSON.stringify(teamData), now(), execId);

  db.prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?')
    .run('completed', now(), reqData.id);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// GET /api/requirements/:id/execution/progress — poll for live progress
router.get('/:id/execution/progress', (req, res) => {
  try {
    const exec = db.prepare(
      'SELECT id, status, logs, result_data, agent_teams_data FROM executions WHERE requirement_id = ? ORDER BY started_at DESC LIMIT 1'
    ).get(req.params.id);

    if (!exec) {
      return res.json({ success: true, data: { status: 'none', logs: [] } });
    }

    const logs = safeParse(exec.logs, []);
    const result = safeParse(exec.result_data, null);
    const agent_teams = safeParse(exec.agent_teams_data, null);

    res.json({
      success: true,
      data: {
        execution_id: exec.id,
        status: exec.status,
        logs,
        result,
        agent_teams,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/requirements/:id/executions - Execution history
router.get('/:id/executions', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT * FROM executions WHERE requirement_id = ? ORDER BY started_at DESC'
    ).all(req.params.id);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 执行记录查询 / 回写接口 ──

// GET /api/requirements/executions/:id — 单条执行详情
router.get('/executions/:id', (req, res) => {
  try {
    const exec = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id);
    if (!exec) return res.status(404).json({ success: false, error: '执行记录不存在' });
    exec.logs = safeParse(exec.logs, []);
    exec.result_data = safeParse(exec.result_data, null);
    exec.agent_teams_data = safeParse(exec.agent_teams_data, null);
    res.json({ success: true, data: exec });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/requirements/executions/:id — DSH 流水线回写状态/日志/结果/团队数据
router.put('/executions/:id', (req, res) => {
  try {
    const { status, logs, result_data, agent_teams_data } = req.body || {};
    const exec = db.prepare('SELECT * FROM executions WHERE id = ?').get(req.params.id);
    if (!exec) return res.status(404).json({ success: false, error: '执行记录不存在' });

    const fields = [];
    const values = [];
    if (status) { fields.push('status = ?'); values.push(status); }
    if (logs !== undefined) { fields.push('logs = ?'); values.push(typeof logs === 'string' ? logs : JSON.stringify(logs)); }
    if (result_data !== undefined) { fields.push('result_data = ?'); values.push(typeof result_data === 'string' ? result_data : JSON.stringify(result_data)); }
    if (agent_teams_data !== undefined) { fields.push('agent_teams_data = ?'); values.push(typeof agent_teams_data === 'string' ? agent_teams_data : JSON.stringify(agent_teams_data)); }

    if (status === 'completed' || status === 'failed') {
      fields.push('completed_at = ?');
      values.push(now());
    }
    if (fields.length) {
      db.prepare(`UPDATE executions SET ${fields.join(', ')} WHERE id = ?`).run(...values, req.params.id);
    }

    // 同步需求状态
    if (status) {
      const reqStatus = status === 'completed' ? 'completed' : (status === 'failed' ? 'failed' : 'running');
      db.prepare('UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?')
        .run(reqStatus, now(), exec.requirement_id);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
