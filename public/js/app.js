/* ═══════════════════════════════════════════════
   需求管理系统 - Frontend Application
   ═══════════════════════════════════════════════ */

const API_BASE = '/api/requirements';

// ── State ──
let currentReqId = null;

// ── DOM refs ──
const app = document.getElementById('app');

// ── Toast ──
function toast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(40px)'; el.style.transition = '300ms ease'; }, 3000);
  setTimeout(() => el.remove(), 3500);
}

// ── API helpers ──
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API_BASE + url, opts);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '请求失败');
  return data.data;
}

// ── Router ──
function navigate(path) {
  window.history.pushState({}, '', path);
  route();
}

window.addEventListener('popstate', route);

function route() {
  const path = window.location.pathname;
  if (path.startsWith('/detail/')) {
    const id = path.split('/')[2];
    currentReqId = id;
    renderDetail(id);
  } else {
    renderList();
  }
}

// ── List auto-refresh ──
let listRefreshTimer = null;
function scheduleListRefresh() {
  if (listRefreshTimer) clearTimeout(listRefreshTimer);
  listRefreshTimer = setTimeout(() => {
    const p = window.location.pathname;
    if (p === '/' || p === '') renderList();
  }, 3000);
}

// ── Render: List ──
async function renderList() {
  app.innerHTML = '<div class="loading-overlay"><div class="loading-spinner"></div> 加载中...</div>';

  let data;
  try {
    data = await api('GET', '');
  } catch (e) {
    app.innerHTML = `<div class="empty-state"><p style="color:var(--danger)">${e.message}</p></div>`;
    return;
  }

  const total = data.length;
  const pending = data.filter(r => r.status === 'pending').length;
  const running = data.filter(r => r.status === 'running').length;
  const completed = data.filter(r => r.status === 'completed').length;
  const runningReq = data.find(r => r.status === 'running');

  let cardsHtml = '';
  if (data.length === 0) {
    cardsHtml = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <h3>还没有需求</h3>
        <p>点击「新建需求」按钮上传你的第一个需求文档</p>
      </div>`;
  } else {
    cardsHtml = data.map(r => {
      const statusClass = r.status;
      let statusText = { pending: '待执行', running: '执行中', completed: '已完成', failed: '失败' }[r.status] || r.status;
      const giteeTag = r.gitee_repo
        ? `<span class="tag gitee"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg> ${r.gitee_repo}</span>`
        : '';
      const projectTag = r.project_number
        ? `<span class="tag project">#${r.project_number}</span>`
        : '';
      const systemTag = r.system_name
        ? `<span class="tag system">${escapeHtml(r.system_name)}</span>`
        : '';
      return `
      <a class="req-card" href="/detail/${r.id}" onclick="event.preventDefault(); navigate('/detail/${r.id}')">
        <div class="req-card-main">
          <div class="req-card-title">${escapeHtml(r.title)}</div>
          <div class="req-card-meta">
            ${systemTag}
            ${projectTag}
            ${giteeTag}
            <span>${r.file_original_name ? '📎 ' + escapeHtml(r.file_original_name) : ''}</span>
            <span>${formatDate(r.created_at)}</span>
          </div>
        </div>
        <div class="req-card-actions">
          <span class="status-badge ${statusClass}"><span class="status-dot"></span>${statusText}</span>
          <span class="btn btn-ghost">→</span>
        </div>
      </a>`;
    }).join('');
  }

  app.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">需求列表</h1>
        <p class="page-subtitle">共 ${total} 个需求 · 管理你的项目需求</p>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        ${runningReq ? `<button class="btn btn-accent btn-lg" onclick="navigate('/detail/${runningReq.id}')">⏭ 跳转到执行中</button>` : ''}
        <button class="btn btn-secondary btn-lg" onclick="showSystemsManager()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          系统管理
        </button>
        <button class="btn btn-primary btn-lg" onclick="showCreateModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          新建需求
        </button>
      </div>
    </div>

    <div class="stats-bar">
      <div class="stat-card">
        <div class="stat-label">总需求</div>
        <div class="stat-value">${total}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">待执行</div>
        <div class="stat-value warning">${pending}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">执行中</div>
        <div class="stat-value info">${running}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">已完成</div>
        <div class="stat-value accent">${completed}</div>
      </div>
    </div>

    <div class="req-list">${cardsHtml}</div>
  `;

  scheduleListRefresh();
}

// ── Render: Detail ──
async function renderDetail(id) {
  app.innerHTML = '<div class="loading-overlay"><div class="loading-spinner"></div> 加载中...</div>';

  let reqData;
  try {
    reqData = await api('GET', '/' + id);
  } catch (e) {
    app.innerHTML = `
      <a class="back-link" href="/" onclick="event.preventDefault(); navigate('/')">← 返回列表</a>
      <div class="empty-state"><p style="color:var(--danger)">${escapeHtml(e.message)}</p></div>`;
    return;
  }

  const isRunning = reqData.status === 'running';
  const isCompleted = reqData.status === 'completed';
  const lastExec = reqData.executions && reqData.executions.length > 0 ? reqData.executions[0] : null;
  let resultHtml = '';

  if (lastExec && lastExec.result_data) {
    try {
      const result = JSON.parse(lastExec.result_data);
      resultHtml = renderExecutionResult(result);
    } catch (e) {
      resultHtml = `<div class="result-block">${escapeHtml(lastExec.result_data)}</div>`;
    }
  }

  const execBtnHtml = isRunning
    ? `<button class="btn btn-secondary btn-lg" disabled style="opacity:0.55;cursor:not-allowed;">
        <div class="loading-spinner" style="width:14px;height:14px;border-width:2px;"></div>
        执行中...
       </button>`
    : `<button class="btn btn-primary btn-lg" onclick="executeAndPoll(${id})">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        开始执行
       </button>`;

  const statusText = { pending: '待执行', running: '执行中', completed: '已完成', failed: '失败' }[reqData.status] || reqData.status;

  app.innerHTML = `
    <a class="back-link" href="/" onclick="event.preventDefault(); navigate('/')">← 返回列表</a>

    <div class="detail-actions">
      ${execBtnHtml}
      <button class="btn btn-secondary btn-sm" onclick="deleteRequirement(${id})">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        删除
      </button>
    </div>

    <div class="detail-header">
      <div>
        <h1 class="detail-title">${escapeHtml(reqData.title)}</h1>
        <div class="detail-meta">
          ${reqData.system_name ? `
          <div class="detail-meta-item">
            <span class="label">所属系统</span>
            <span style="color:var(--accent);font-weight:500;">${escapeHtml(reqData.system_name)}</span>
          </div>` : ''}
          <div class="detail-meta-item">
            <span class="label">需求号</span>
            <span style="font-family:var(--font-mono);color:var(--blue)">${reqData.project_number || '-'}</span>
          </div>
          ${reqData.gitee_repo ? `
          <div class="detail-meta-item">
            <span class="label">Gitee</span>
            <span style="color:var(--green);font-family:var(--font-mono);font-size:0.78rem;">${escapeHtml(reqData.gitee_repo)}</span>
          </div>` : ''}
          <div class="detail-meta-item">
            <span class="label">状态</span>
            <span class="status-badge ${reqData.status}" style="font-size:0.8rem;"><span class="status-dot"></span>${statusText}</span>
          </div>
          <div class="detail-meta-item">
            <span class="label">创建时间</span>
            <span>${formatDate(reqData.created_at)}</span>
          </div>
          <div class="detail-meta-item">
            <span class="label">更新时间</span>
            <span>${formatDate(reqData.updated_at)}</span>
          </div>
        </div>
      </div>
      ${execBtnHtml}
    </div>

    <div class="section-card">
      <div class="section-title">📄 需求描述</div>
      <div class="section-content">${escapeHtml(reqData.description) || '<span style="color:var(--text-tertiary);font-style:italic;">暂无描述</span>'}</div>
    </div>

    ${reqData.file_original_name ? `
    <div class="section-card">
      <div class="section-title">📎 附件</div>
      <div class="section-content">
        <span style="display:flex;align-items:center;gap:8px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          ${escapeHtml(reqData.file_original_name)}
        </span>
      </div>
    </div>` : ''}

    <div class="section-card" style="border-color: ${isCompleted ? 'var(--accent)' : 'var(--border)'}">
      <div class="section-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        执行记录
      </div>
      <div class="section-content">
        ${lastExec ? '' : '<span style="color:var(--text-tertiary);font-style:italic;">暂无执行记录</span>'}
        <div id="execProgressPanel"></div>
      </div>
    </div>

    ${resultHtml ? `<div class="execution-panel">${resultHtml}</div>` : ''}
  `;

  // Auto-poll progress if running or has a completed execution
  if (isRunning || (lastExec && lastExec.status === 'completed')) {
    setTimeout(() => pollExecutionProgress(id), 300);
  }
}

// ── Render Execution Result ──
function renderExecutionResult(result) {
  let dataSourcesHtml = '';

  if (result.data_sources) {
    const ds = result.data_sources;
    let rows = '';
    for (const [key, val] of Object.entries(ds)) {
      if (val) {
        rows += `<div style="margin-bottom:8px;">
          <div style="font-weight:600;font-size:0.82rem;color:var(--text-primary);text-transform:capitalize;">${key}</div>
          <div class="result-block">${renderJson(val)}</div>
        </div>`;
      } else {
        rows += `<div style="margin-bottom:8px;">
          <div style="font-weight:600;font-size:0.82rem;color:var(--text-tertiary);text-transform:capitalize;">${key}</div>
          <div class="result-block" style="color:var(--text-tertiary);font-style:italic;">未配置</div>
        </div>`;
      }
    }
    dataSourcesHtml = `
      <div class="section-title" style="margin-top:1.5rem;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
        数据源
      </div>
      ${rows}`;
  }

  let fileHtml = '';
  if (result.file_attachment && result.file_attachment.content) {
    fileHtml = `
      <div class="section-title" style="margin-top:1.5rem;">
        📄 附件内容
      </div>
      <div class="result-block" style="max-height:300px;overflow-y:auto;white-space:pre-wrap;">${escapeHtml(result.file_attachment.content)}</div>`;
  }

  return `
    <div class="section-title">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      执行结果
      <span style="font-size:0.75rem;font-weight:400;color:var(--text-tertiary);margin-left:8px;">${result.executed_at || ''}</span>
    </div>

    <div class="section-content" style="margin-bottom:1rem;">
      <div class="result-block" style="border-left:3px solid var(--accent);">
        ${escapeHtml(result.execution_summary || '')}
      </div>
    </div>

    <div class="section-title">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
      需求详情
    </div>
    <div class="result-block">${renderJson(result.requirement || {})}</div>

    ${fileHtml}
    ${dataSourcesHtml}
  `;
}

// ── Render JSON helper ──
function renderJson(obj) {
  const str = JSON.stringify(obj, null, 2);
  return syntaxHighlight(str);
}

function syntaxHighlight(json) {
  json = escapeHtml(json);
  json = json.replace(/"([^"]+)":/g, '<span class="key">"$1"</span>:');
  json = json.replace(/: "([^"]+)"/g, ': <span class="string">"$1"</span>');
  json = json.replace(/: (\d+)/g, ': <span class="number">$1</span>');
  json = json.replace(/: (null|true|false)/g, ': <span class="null">$1</span>');
  return json;
}

// ── Execute and poll progress ──
async function executeAndPoll(id) {
  try {
    toast('正在执行需求...', 'info');

    // Disable button immediately
    const btn = document.querySelector('.detail-actions .btn-primary');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<div class="loading-spinner" style="width:14px;height:14px;border-width:2px;"></div> 执行中...';
      btn.className = 'btn btn-secondary btn-lg';
      btn.style.opacity = '0.55';
      btn.style.cursor = 'not-allowed';
      btn.onclick = null;
    }

    // Update status badge
    const badge = document.querySelector('.status-badge');
    if (badge) {
      badge.className = 'status-badge running';
      badge.innerHTML = '<span class="status-dot"></span>执行中';
    }

    // Start execution — 默认走 DSH 模式（pending 执行交给 DSH 桥接器/AI 引擎）
    const data = await api('POST', '/' + id + '/execute', { mode: 'dsh' });
    const execId = data.execution_id;

    // Insert live progress panel（极简占位，轮询开始后由座舱接管）
    const panel = document.getElementById('execProgressPanel');
    if (panel) {
      panel.innerHTML = `
        <div class="section-title" style="margin-top:0.5rem;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          📜 执行日志
          <span style="margin-left:8px;font-size:0.75rem;font-weight:400;color:var(--text-tertiary);">已发起，正在建立执行...</span>
        </div>`;
    }

    // Start polling for progress
    setTimeout(() => pollExecutionProgress(id), 1500);
  } catch (e) {
    toast('执行失败: ' + e.message, 'error');
  }
}

// ── Poll execution progress (live) ──
function pollExecutionProgress(reqId) {
  const panel = document.getElementById('execProgressPanel');
  if (!panel) return;

  fetch(API_BASE + '/' + reqId + '/execution/progress')
    .then(r => r.json())
    .then(data => {
      if (!data.success) return;
      const d = data.data;
      if (d.status === 'none') return;

      // Render full cockpit: steps + logs + agent teams (+ result when done)
      renderCockpit(panel, d);

      if (d.status === 'running' || d.status === 'pending') {
        // Poll again in 1.2s
        setTimeout(() => pollExecutionProgress(reqId), 1200);
      } else if (d.status === 'completed' || d.status === 'failed') {
        // Update the button and status badge in the header
        setTimeout(() => updateDetailAfterCompletion(reqId), 300);
      }
    })
    .catch(() => {
      // Retry after delay
      setTimeout(() => pollExecutionProgress(reqId), 2000);
    });
}

// ── Execution cockpit: 日志流 + AgentTeams 团队 + 结果（执行进度区块暂不展示）──
function renderCockpit(panel, d) {
  let html = renderLogFeed(d.logs, d.status)
    + renderAgentTeams(d.agent_teams);
  if (d.status === 'completed' && d.result) {
    html += renderExecutionResult(d.result);
  }
  panel.innerHTML = html;
}

function renderLogFeed(logs, status) {
  const rich = (logs || []).filter(l => l.level && l.message);
  const chip = {
    pending: '<span style="margin-left:8px;font-size:0.75rem;font-weight:400;color:var(--text-tertiary);">等待 DSH 引擎领取...</span>',
    running: '<span style="margin-left:8px;font-size:0.75rem;font-weight:400;color:var(--blue);">执行中</span>',
    completed: '<span style="margin-left:8px;font-size:0.75rem;font-weight:400;color:var(--green);">已完成</span>',
    failed: '<span style="margin-left:8px;font-size:0.75rem;font-weight:400;color:var(--red, #dc2626);">失败</span>',
  }[status] || '';
  if (!rich.length) {
    return `
      <div class="section-title" style="margin-top:0.5rem;">📜 执行日志 ${chip}</div>
      <div class="log-feed"><div class="log-line log-info"><span class="log-msg">暂无日志</span></div></div>`;
  }
  const levelClass = { system: 'log-system', info: 'log-info', success: 'log-success', error: 'log-error', warn: 'log-warn' };
  const items = rich.map(l => `
    <div class="log-line ${levelClass[l.level] || 'log-info'}">
      <span class="log-time">${formatTime(l.timestamp)}</span>
      <span class="log-level">${escapeHtml(l.level)}</span>
      <span class="log-msg">${escapeHtml(l.message)}</span>
    </div>`).join('');
  return `
    <div class="section-title" style="margin-top:0.5rem;">📜 执行日志 ${chip}</div>
    <div class="log-feed">${items}</div>`;
}

function renderAgentTeams(data) {
  if (!data) return '';
  const team = (data && data.team) ? data.team : data;
  if (!team || !team.name) return '';

  const members = (team.members || []).map(m => {
    const act = m.activity || m.status || '';
    return `<span class="team-member"><span class="member-dot"></span>${escapeHtml(m.name)} · ${escapeHtml(m.role || '')}${act ? ` · ${escapeHtml(act)}` : ''}</span>`;
  }).join('');

  const tasks = (team.tasks || []).map(t => {
    const st = t.status === 'completed' ? '<span class="task-status done">✅ 已完成</span>'
      : t.status === 'running' ? '<span class="task-status running">⏳ 进行中</span>'
      : '<span class="task-status pending">⬜ 待执行</span>';
    return `
      <div class="team-task">
        <div class="team-task-head">
          <span class="task-id">${escapeHtml(t.id)}</span>
          <span class="task-subject">${escapeHtml(t.subject || t.label || '')}</span>
          <span class="task-assignee">@${escapeHtml(t.assignee || '')}</span>
          ${st}
        </div>
        ${t.output ? `<div class="team-task-output">${escapeHtml(t.output)}</div>` : ''}
      </div>`;
  }).join('');

  const desc = team.description || '';
  return `
    <div class="section-title" style="margin-top:1.5rem;">👥 AgentTeams 团队</div>
    <div class="team-panel">
      <div class="team-head">
        <span class="team-name">${escapeHtml(team.name)}</span>
        ${team.status ? `<span class="team-desc">状态：${escapeHtml(team.status)}</span>` : ''}
        ${desc ? `<span class="team-desc">${escapeHtml(desc)}</span>` : ''}
      </div>
      <div class="team-members">${members}</div>
      <div class="team-tasks">${tasks}</div>
    </div>`;
}

function renderProgressSteps(logs, status) {
  const stepIcons = {
    'parsing':    { icon: '📄', label: '解析需求文档' },
    'gitee':      { icon: '🔗', label: '获取 Gitee 仓库信息' },
    'datasource': { icon: '🗄️', label: '关联数据源' },
    'summarize':  { icon: '📋', label: '生成执行报告' },
  };

  let stepsHtml = '';
  for (const [stepId, info] of Object.entries(stepIcons)) {
    const log = logs.find(l => l.step === stepId);
    let statusIcon = '⬜';
    let statusClass = 'pending';

    if (log) {
      if (log.status === 'running') {
        statusIcon = `<div class="loading-spinner" style="width:14px;height:14px;border-width:2px;"></div>`;
        statusClass = 'running';
      } else if (log.status === 'completed') {
        statusIcon = '✅';
        statusClass = 'completed';
      }
    }

    stepsHtml += `
      <div class="progress-step ${statusClass}">
        <div class="step-icon">${statusIcon}</div>
        <div class="step-info">
          <div class="step-label">${info.icon} ${info.label}</div>
          ${log ? `<div class="step-time">${formatDate(log.timestamp)}</div>` : ''}
        </div>
      </div>`;
  }

  return `
    <div style="margin-bottom:1.5rem;">
      <div class="section-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        执行进度
        ${status === 'pending' ? '<span style="margin-left:8px;font-size:0.75rem;font-weight:400;color:var(--text-tertiary);">等待 DSH 引擎领取...（超时将自动切换本地模拟）</span>' : ''}
        ${status === 'running' ? '<span style="margin-left:8px;font-size:0.75rem;font-weight:400;color:var(--blue);">进行中...</span>' : ''}
        ${status === 'completed' ? '<span style="margin-left:8px;font-size:0.75rem;font-weight:400;color:var(--green);">已完成</span>' : ''}
        ${status === 'failed' ? '<span style="margin-left:8px;font-size:0.75rem;font-weight:400;color:var(--red, #dc2626);">失败</span>' : ''}
      </div>
      <div class="progress-steps">${stepsHtml}</div>
    </div>
  `;
}

function updateDetailAfterCompletion(reqId) {
  // Refresh the detail view to update button and status
  api('GET', '/' + reqId).then(data => {
    // Update status badge
    const badge = document.querySelector('.status-badge');
    if (badge) {
      badge.className = 'status-badge completed';
      badge.innerHTML = '<span class="status-dot"></span>已完成';
    }
    // Swap execute button
    const actions = document.querySelector('.detail-actions');
    if (actions) {
      const oldBtn = actions.querySelector('button');
      if (oldBtn) oldBtn.remove();
    }
  }).catch(() => {});
}

// ── Create Requirement Modal ──
async function showCreateModal() {
  const overlay = document.getElementById('modalOverlay');
  overlay.classList.add('open');

  // Load systems into dropdown
  const select = document.getElementById('system_id');
  try {
    const res = await fetch('/api/systems');
    const data = await res.json();
    if (data.success) {
      select.innerHTML = '<option value="">— 请选择系统 —</option>';
      data.data.forEach(sys => {
        const opt = document.createElement('option');
        opt.value = sys.id;
        opt.textContent = `${sys.name} ${sys.gitee_repo ? '(' + sys.gitee_repo + ')' : ''}`;
        opt.dataset.repo = sys.gitee_repo || '';
        select.appendChild(opt);
      });
    }
  } catch (e) {
    // Keep existing options
  }
}

function hideCreateModal() {
  const overlay = document.getElementById('modalOverlay');
  overlay.classList.remove('open');
  document.getElementById('createForm').reset();
  document.getElementById('fileLabel').textContent = '选择文件 (支持 .md .txt .pdf .json 等)';
}

function handleFileSelect(input) {
  const label = document.getElementById('fileLabel');
  if (input.files && input.files[0]) {
    label.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ${escapeHtml(input.files[0].name)}`;
  } else {
    label.textContent = '选择文件 (支持 .md .txt .pdf .json 等)';
  }
}

async function submitCreate() {
  const form = document.getElementById('createForm');
  const formData = new FormData(form);
  const title = formData.get('title');

  if (!title || !title.trim()) {
    toast('请输入需求标题', 'error');
    return;
  }

  const btn = document.querySelector('#createForm .btn-primary');
  btn.disabled = true;
  btn.textContent = '提交中...';

  try {
    await api('POST', '', formData);
    toast('需求创建成功！', 'success');
    hideCreateModal();
    renderList();
  } catch (e) {
    toast('创建失败: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '创建需求';
  }
}

// ── Delete Requirement ──
async function deleteRequirement(id) {
  if (!confirm('确定要删除这个需求吗？此操作不可撤销。')) return;
  try {
    await api('DELETE', '/' + id);
    toast('需求已删除', 'success');
    navigate('/');
  } catch (e) {
    toast('删除失败: ' + e.message, 'error');
  }
}

// ── Helpers ──
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00'));
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// ── System Manager ──
function showSystemsManager() {
  const overlay = document.getElementById('systemModalOverlay');
  overlay.classList.add('open');
  loadSystemsList();
}

function hideSystemsManager() {
  document.getElementById('systemModalOverlay').classList.remove('open');
  cancelAddSystem();
}

async function loadSystemsList() {
  const container = document.getElementById('systemsList');
  container.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--text-secondary);"><div class="loading-spinner" style="margin:0 auto 0.5rem;"></div>加载中...</div>';
  try {
    const res = await fetch('/api/systems');
    const data = await res.json();
    if (!data.success) throw new Error(data.message || '加载失败');
    if (data.data.length === 0) {
      container.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-secondary);">暂无系统配置，请添加</div>';
      return;
    }
    let html = `<table class="systems-table">
      <thead><tr>
        <th style="width:30px;">#</th>
        <th>系统名称</th>
        <th>Gitee 仓库</th>
        <th>需求数</th>
        <th style="width:90px;"></th>
      </tr></thead><tbody>`;
    data.data.forEach((sys, i) => {
      html += `<tr>
        <td style="color:var(--text-secondary);font-size:0.8rem;">${i + 1}</td>
        <td><strong>${escapeHtml(sys.name)}</strong>
          ${sys.description ? `<div style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px;">${escapeHtml(sys.description)}</div>` : ''}
        </td>
        <td class="repo-cell">${sys.gitee_repo ? escapeHtml(sys.gitee_repo) : '<span style="color:var(--text-tertiary);">未配置</span>'}</td>
        <td>${sys.requirement_count != null ? sys.requirement_count : '-'}</td>
        <td class="actions-cell">
          <button class="btn btn-outline btn-xs" onclick="showEditSystem(${sys.id})">编辑</button>
          <button class="btn btn-outline btn-xs" style="color:var(--red);border-color:var(--red);" onclick="deleteSystem(${sys.id})">删除</button>
        </td>
      </tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div style="padding:1rem;text-align:center;color:var(--red);">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function showAddSystemForm() {
  document.getElementById('addSystemForm').style.display = 'block';
  document.getElementById('addSystemForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelAddSystem() {
  document.getElementById('addSystemForm').style.display = 'none';
  document.getElementById('sysName').value = '';
  document.getElementById('sysGitee').value = '';
  document.getElementById('sysDesc').value = '';
  // Hide any inline edit forms too
  const editForm = document.getElementById('editSystemForm');
  if (editForm) editForm.remove();
}

async function saveNewSystem() {
  const name = document.getElementById('sysName').value.trim();
  if (!name) { toast('请输入系统名称', 'error'); return; }
  const gitee_repo = document.getElementById('sysGitee').value.trim();
  const description = document.getElementById('sysDesc').value.trim();

  const btn = document.querySelector('#addSystemForm .btn-primary');
  btn.disabled = true;
  btn.textContent = '保存中...';

  try {
    const res = await api('POST', '/api/systems', null, { name, gitee_repo, description });
    toast('系统添加成功！', 'success');
    cancelAddSystem();
    loadSystemsList();
    // Refresh create modal systems dropdown if it's open
    refreshSystemDropdown();
  } catch (e) {
    toast('添加失败: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

async function showEditSystem(id) {
  // Remove any existing edit form
  const existing = document.getElementById('editSystemForm');
  if (existing) existing.remove();
  // Hide add form if open
  document.getElementById('addSystemForm').style.display = 'none';

  try {
    const res = await fetch('/api/systems/' + id);
    const data = await res.json();
    if (!data.success) throw new Error(data.message);

    const sys = data.data;
    const container = document.getElementById('systemsList');
    const form = document.createElement('div');
    form.id = 'editSystemForm';
    form.style.cssText = 'background:var(--bg-card);border-radius:8px;padding:1rem;margin-bottom:1rem;border:1px solid var(--accent);';
    form.innerHTML = `
      <h4 style="margin:0 0 0.75rem;font-family:var(--font-display);">编辑系统 — ${escapeHtml(sys.name)}</h4>
      <div class="form-group">
        <label class="form-label" for="editSysName">系统名称 *</label>
        <input class="form-input" type="text" id="editSysName" value="${escapeHtml(sys.name)}">
      </div>
      <div class="form-group">
        <label class="form-label" for="editSysGitee">Gitee 仓库地址</label>
        <input class="form-input" type="text" id="editSysGitee" value="${escapeHtml(sys.gitee_repo || '')}">
      </div>
      <div class="form-group">
        <label class="form-label" for="editSysDesc">系统描述</label>
        <textarea class="form-textarea" id="editSysDesc" style="min-height:60px;">${escapeHtml(sys.description || '')}</textarea>
      </div>
      <div class="form-actions" style="justify-content:flex-end;">
        <button class="btn btn-secondary btn-sm" onclick="cancelEditSystem()">取消</button>
        <button class="btn btn-primary btn-sm" onclick="saveEditSystem(${id})">保存</button>
      </div>
    `;
    container.parentNode.insertBefore(form, container);
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    toast('加载系统信息失败: ' + e.message, 'error');
  }
}

function cancelEditSystem() {
  const form = document.getElementById('editSystemForm');
  if (form) form.remove();
}

async function saveEditSystem(id) {
  const name = document.getElementById('editSysName').value.trim();
  if (!name) { toast('请输入系统名称', 'error'); return; }
  const gitee_repo = document.getElementById('editSysGitee').value.trim();
  const description = document.getElementById('editSysDesc').value.trim();

  const btn = document.querySelector('#editSystemForm .btn-primary');
  btn.disabled = true;
  btn.textContent = '保存中...';

  try {
    await api('PUT', '/api/systems/' + id, null, { name, gitee_repo, description });
    toast('系统更新成功！', 'success');
    cancelEditSystem();
    loadSystemsList();
    refreshSystemDropdown();
  } catch (e) {
    toast('更新失败: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

async function deleteSystem(id) {
  if (!confirm('确定要删除这个系统吗？已关联该系统的需求会自动取消关联。')) return;
  try {
    await api('DELETE', '/api/systems/' + id);
    toast('系统已删除', 'success');
    loadSystemsList();
    refreshSystemDropdown();
  } catch (e) {
    toast('删除失败: ' + e.message, 'error');
  }
}

async function refreshSystemDropdown() {
  const select = document.getElementById('system_id');
  if (!select) return;
  try {
    const res = await fetch('/api/systems');
    const data = await res.json();
    if (data.success) {
      const current = select.value;
      select.innerHTML = '<option value="">— 请选择系统 —</option>';
      data.data.forEach(sys => {
        const opt = document.createElement('option');
        opt.value = sys.id;
        opt.textContent = `${sys.name} ${sys.gitee_repo ? '(' + sys.gitee_repo + ')' : ''}`;
        if (String(sys.id) === current) opt.selected = true;
        select.appendChild(opt);
      });
    }
  } catch (e) { /* ignore */ }
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  route();
});
