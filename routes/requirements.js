const express = require('express');
const router = express.Router();
const path = require('path');
const { db, now } = require('../db');

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
    let finalGiteeRepo = gitee_repo || '';
    let finalSystemId = system_id ? parseInt(system_id) : null;

    if (finalSystemId) {
      const sys = db.prepare('SELECT gitee_repo FROM systems WHERE id = ?').get(finalSystemId);
      if (sys) {
        finalGiteeRepo = sys.gitee_repo || finalGiteeRepo;
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

function appendLog(execId, step) {
  const row = db.prepare('SELECT logs FROM executions WHERE id = ?').get(execId);
  if (!row) return;
  const logs = JSON.parse(row.logs || '[]');
  logs.push({ ...step, timestamp: now() });
  db.prepare('UPDATE executions SET logs = ? WHERE id = ?').run(JSON.stringify(logs), execId);
}

// POST /api/requirements/:id/execute — start async execution
router.post('/:id/execute', (req, res) => {
  try {
    const reqData = db.prepare('SELECT * FROM requirements WHERE id = ?').get(req.params.id);
    if (!reqData) {
      return res.status(404).json({ success: false, error: '需求不存在' });
    }
    if (reqData.status === 'running') {
      return res.status(400).json({ success: false, error: '该需求正在执行中' });
    }

    // Create execution record (status = running)
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
      data: { execution_id: execId },
      message: '需求执行已启动',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function runExecutionSteps(execId, reqData) {
  const steps = EXECUTION_STEPS.map(s => ({ ...s }));

  for (const [i, step] of steps.entries()) {
    // mark step as running
    appendLog(execId, { step: step.id, label: step.label, status: 'running' });

    await sleep(step.duration);

    // mark step as done
    appendLog(execId, { step: step.id, label: step.label, status: 'completed' });
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

  // Mark execution completed
  db.prepare(
    `UPDATE executions SET status = 'completed', result_data = ?, completed_at = ? WHERE id = ?`
  ).run(JSON.stringify(resultData), now(), execId);

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
      'SELECT id, status, logs, result_data FROM executions WHERE requirement_id = ? ORDER BY started_at DESC LIMIT 1'
    ).get(req.params.id);

    if (!exec) {
      return res.json({ success: true, data: { status: 'none', logs: [] } });
    }

    const logs = JSON.parse(exec.logs || '[]');
    let result = null;
    if (exec.result_data) {
      try { result = JSON.parse(exec.result_data); } catch (e) { result = exec.result_data; }
    }

    res.json({
      success: true,
      data: {
        execution_id: exec.id,
        status: exec.status,
        logs,
        result,
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

module.exports = router;
