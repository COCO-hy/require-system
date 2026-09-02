/* ═══════════════════════════════════════
   需求管理系统 · 工程制图室 — 前端交互层
   纯需求管理：列表 / 详情 / 登记 / 系统台账
   ═══════════════════════════════════════ */

const API_BASE = '/api/requirements';
const SYS_BASE = '/api/systems';

// ── State ──
let currentReqId = null;
let systemsCache = [];
let filterSystemId = '';   // '' = 全部
let searchKeyword = '';

// ── DOM ──
const app = document.getElementById('app');

// ── API ──
async function api(method, url, body, base) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch((base || API_BASE) + url, opts);
  let data;
  try { data = await res.json(); }
  catch (e) { throw new Error(`响应异常（HTTP ${res.status}）`); }
  if (!data.success) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
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
    if (id && /^\d+$/.test(id)) { currentReqId = id; renderDetail(id); return; }
  }
  currentReqId = null;
  renderList();
}

// ── Helpers ──
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  if (isNaN(d)) return iso;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

function pad3(n) { return String(n).padStart(3, '0'); }

// ═══════════ 列表：图纸目录 ═══════════
async function renderList() {
  app.innerHTML = '<div class="loading-overlay"><div class="crosshair-spin"></div>展平图纸中…</div>';

  let reqs = [], systems = [];
  try {
    [reqs, systems] = await Promise.all([
      api('GET', ''),
      api('GET', '', undefined, SYS_BASE),
    ]);
  } catch (e) {
    app.innerHTML = `
      <div class="empty-state">
        <div class="empty-stamp">误</div>
        <h3>图纸目录调取失败</h3>
        <p>${escapeHtml(e.message)}</p>
      </div>`;
    return;
  }
  systemsCache = systems;
  updateDeskCount(reqs.length);

  // 统计
  const total = reqs.length;
  const withAtt = reqs.filter(r => r.file_original_name).length;
  const withRepo = reqs.filter(r => r.gitee_repo).length;

  // 过滤（搜索 + 系统筛选，客户端）
  const kw = searchKeyword.trim().toLowerCase();
  const shown = reqs.filter(r => {
    if (filterSystemId && String(r.system_id) !== filterSystemId) return false;
    if (!kw) return true;
    return [r.title, r.project_number, r.system_name, r.gitee_repo, r.description]
      .some(v => v && String(v).toLowerCase().includes(kw));
  });

  const chipsHtml = [
    `<button class="chip ${filterSystemId === '' ? 'on' : ''}" onclick="pickSystem('')">全部</button>`,
    ...systems.map(s => `
      <button class="chip ${filterSystemId === String(s.id) ? 'on' : ''}" onclick="pickSystem('${s.id}')">
        ${escapeHtml(s.name)} <span style="opacity:.55">${reqs.filter(r => String(r.system_id) === String(s.id)).length}</span>
      </button>`),
  ].join('');

  let cardsHtml;
  if (total === 0) {
    cardsHtml = `
      <div class="empty-state">
        <div class="empty-stamp">空</div>
        <h3>图柜尚空</h3>
        <p>点击右上「登记新图纸」，录入第一份需求</p>
      </div>`;
  } else if (shown.length === 0) {
    cardsHtml = `
      <div class="empty-state">
        <div class="empty-stamp">无</div>
        <h3>没有匹配的图纸</h3>
        <p>换个检索词，或清除系统筛选</p>
      </div>`;
  } else {
    cardsHtml = shown.map((r, i) => {
      const no = r.project_number || `REQ-${pad3(r.id)}`;
      return `
      <a class="req-card" href="/detail/${r.id}" style="--delay:${Math.min(i, 10) * 55}ms"
         onclick="event.preventDefault(); navigate('/detail/${r.id}')">
        <span class="reg-mark tl"></span><span class="reg-mark br"></span>
        <div class="req-card-body">
          <div class="req-card-no"><span>DWG. ${escapeHtml(no)}</span><span>№${pad3(r.id)}</span></div>
          <div class="req-card-title">${escapeHtml(r.title)}</div>
          ${r.description ? `<div class="req-card-desc">${escapeHtml(r.description)}</div>` : ''}
          <div class="req-card-tags">
            ${r.system_name ? `<span class="tag sys">${escapeHtml(r.system_name)}</span>` : ''}
            ${r.gitee_repo ? `<span class="tag git">◈ ${escapeHtml(r.gitee_repo)}</span>` : ''}
            ${r.file_original_name ? `<span class="tag att">📎 附件</span>` : ''}
          </div>
        </div>
        <div class="titleblock">
          <div class="tb-cell"><span class="tb-k">SYSTEM</span><span class="tb-v">${r.system_name ? escapeHtml(r.system_name) : '— 未指定 —'}</span></div>
          <div class="tb-cell"><span class="tb-k">DATE</span><span class="tb-v mono">${formatDate(r.created_at)}</span></div>
          <div class="tb-cell"><span class="tb-k">SHEET</span><span class="tb-v em">查看 →</span></div>
        </div>
      </a>`;
    }).join('');
  }

  app.innerHTML = `
    <div class="index-head">
      <div class="index-eyebrow">DRAWING INDEX · 图纸目录</div>
      <h1 class="index-title">图柜 <span class="no">/ ${total} SHEETS</span></h1>
      <div class="index-toolbar">
        <div class="search-box">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" id="searchInput" placeholder="检索图号 / 标题 / 系统 / 仓库…" value="${escapeHtml(searchKeyword)}"
                 oninput="onSearch(this.value)">
        </div>
        <div class="sys-filter">${chipsHtml}</div>
      </div>
    </div>

    <div class="stats-strip">
      <div class="stat-cell"><div class="stat-label">SHEETS · 图纸总量</div><div class="stat-value">${total}</div></div>
      <div class="stat-cell"><div class="stat-label">SYSTEMS · 在册系统</div><div class="stat-value blue">${systems.length}</div></div>
      <div class="stat-cell"><div class="stat-label">ATTACH · 含附件</div><div class="stat-value green">${withAtt}</div></div>
      <div class="stat-cell"><div class="stat-label">LINKED · 关联仓库</div><div class="stat-value accent">${withRepo}</div></div>
    </div>

    <div class="req-list">${cardsHtml}</div>
  `;

  const si = document.getElementById('searchInput');
  if (si && searchKeyword) { si.focus(); si.setSelectionRange(si.value.length, si.value.length); }
}

function updateDeskCount(n) {
  const el = document.getElementById('deskCount');
  if (el) el.textContent = pad3(n);
}

let searchTimer = null;
function onSearch(v) {
  searchKeyword = v;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    // 只重渲染卡片区域太碎，直接重渲染但保持焦点由 renderList 处理
    renderList();
  }, 200);
}

function pickSystem(id) {
  filterSystemId = id;
  renderList();
}

// ═══════════ 详情：完整图幅 ═══════════
async function renderDetail(id) {
  app.innerHTML = '<div class="loading-overlay"><div class="crosshair-spin"></div>展开图幅…</div>';

  let d;
  try {
    d = await api('GET', '/' + id);
  } catch (e) {
    app.innerHTML = `
      <a class="back-link" href="/" onclick="event.preventDefault(); navigate('/')">← BACK · 返回目录</a>
      <div class="empty-state"><div class="empty-stamp">误</div><h3>图纸调取失败</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }

  const no = d.project_number || `REQ-${pad3(d.id)}`;
  const repoUrl = d.gitee_repo ? `https://gitee.com/${d.gitee_repo}` : '';

  app.innerHTML = `
    <a class="back-link" href="/" onclick="event.preventDefault(); navigate('/')">← BACK · 返回图纸目录</a>

    <div class="detail-sheet">
      <span class="reg-mark tl"></span><span class="reg-mark br"></span>
      <div class="detail-inner">
        <div class="detail-stamp">在册</div>
        <div class="detail-no">DRAWING NO. ${escapeHtml(no)} · SHEET ${pad3(d.id)}</div>
        <h1 class="detail-title">${escapeHtml(d.title)}</h1>
        ${d.description ? '' : '<div class="detail-desc-line">（未附技术要求）</div>'}

        <div class="spec-section">
          <div class="spec-head"><span class="zh">技术要求</span><span class="en">SPECIFICATION</span></div>
          <div class="spec-body ${d.description ? '' : 'none'}">${d.description ? escapeHtml(d.description) : '暂无描述'}</div>
        </div>

        ${d.file_original_name ? `
        <div class="spec-section">
          <div class="spec-head"><span class="zh">附图文件</span><span class="en">ATTACHMENT</span></div>
          <div class="attachment-box">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            <span class="fname">${escapeHtml(d.file_original_name)}</span>
          </div>
          ${d.file_content ? `<div class="attachment-preview">${escapeHtml(d.file_content)}</div>` : '<div class="form-hint" style="margin-top:8px;">二进制附件不在线预览</div>'}
        </div>` : ''}

        <div class="detail-titleblock">
          <div class="tb-cell"><span class="tb-k">SYSTEM · 所属系统</span><span class="tb-v">${d.system_name ? escapeHtml(d.system_name) : '— 未指定 —'}</span></div>
          <div class="tb-cell"><span class="tb-k">DWG.NO · 需求号</span><span class="tb-v mono">${escapeHtml(no)}</span></div>
          <div class="tb-cell"><span class="tb-k">SHEET NO.</span><span class="tb-v mono">${pad3(d.id)}</span></div>
          <div class="tb-cell"><span class="tb-k">GITEE · 关联仓库</span><span class="tb-v mono">${d.gitee_repo
            ? `<a href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener" style="color:var(--patina);text-decoration:none;border-bottom:1px dashed var(--patina);">${escapeHtml(d.gitee_repo)} ↗</a>`
            : '— 未关联 —'}</span></div>
          <div class="tb-cell"><span class="tb-k">CREATED · 登记</span><span class="tb-v mono">${formatDate(d.created_at)}</span></div>
          <div class="tb-cell"><span class="tb-k">REVISED · 更新</span><span class="tb-v mono">${formatDate(d.updated_at)}</span></div>
        </div>
      </div>
    </div>

    <div class="detail-actions">
      <button class="draft-btn primary" onclick="extractRequirement(${d.id})">提取图纸数据</button>
      <button class="danger-btn" onclick="deleteRequirement(${d.id}, ${JSON.stringify(d.title).replace(/"/g, '&quot;')})">
        作废并归档（删除）
      </button>
    </div>
  `;
}

async function deleteRequirement(id, title) {
  if (!confirm(`确定作废图纸「${title}」？\n该操作会一并删除其附件，不可恢复。`)) return;
  try {
    await api('DELETE', '/' + id);
    navigate('/');
  } catch (e) {
    alert('删除失败：' + e.message);
  }
}

async function extractRequirement(id) {
  try {
    const res = await fetch(API_BASE + '/' + id + '/export');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    console.log('══════ 图纸数据 · REQ #' + id + ' ══════');
    console.log(JSON.stringify(data, null, 2));
    console.log('══════ 可复制以上 JSON 用于后续操作 ══════');
  } catch (e) {
    alert('提取失败：' + e.message);
  }
}

// ═══════════ 登记新图纸 ═══════════
function showCreateModal() {
  document.getElementById('modalOverlay').classList.add('open');
  hideFormError('createFormError');
  loadSystemOptions();
}
function hideCreateModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}
async function loadSystemOptions(selectedId) {
  try {
    const systems = await api('GET', '', undefined, SYS_BASE);
    systemsCache = systems;
    const sel = document.getElementById('system_id');
    const prev = selectedId ?? sel.value;
    sel.innerHTML = '<option value="">— 未指定 —</option>' +
      systems.map(s => `<option value="${s.id}">${escapeHtml(s.name)}${s.gitee_repo ? ' · ' + escapeHtml(s.gitee_repo) : ''}</option>`).join('');
    if (prev) sel.value = prev;
  } catch (e) { /* 静默：选择框保持未加载状态 */ }
}
function onSystemPicked() { /* 提示在 option 文案里已体现 */ }

function handleFileSelect(input) {
  const label = document.getElementById('fileLabel');
  const text = document.getElementById('fileLabelText');
  if (input.files && input.files[0]) {
    text.textContent = `已选择：${input.files[0].name}`;
    label.classList.add('picked');
  } else {
    text.textContent = '粘贴附件（.md / .txt / .pdf / .json 等）';
    label.classList.remove('picked');
  }
}

function showFormError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.hidden = false;
}
function hideFormError(id) {
  const el = document.getElementById(id);
  el.hidden = true;
}

async function submitCreate() {
  hideFormError('createFormError');
  const form = document.getElementById('createForm');
  const btn = document.getElementById('createSubmitBtn');
  const fd = new FormData(form);

  if (!String(fd.get('title') || '').trim()) {
    showFormError('createFormError', '需求标题为必填项');
    return;
  }

  btn.disabled = true;
  btn.textContent = '盖章中…';
  try {
    const data = await api('POST', '', fd);
    hideCreateModal();
    form.reset();
    handleFileSelect(document.getElementById('file'));
    navigate('/detail/' + data.id);
  } catch (e) {
    showFormError('createFormError', e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '盖章登记';
  }
}

// 点击遮罩关闭
document.getElementById('modalOverlay').addEventListener('mousedown', (e) => {
  if (e.target === e.currentTarget) hideCreateModal();
});
document.getElementById('systemModalOverlay').addEventListener('mousedown', (e) => {
  if (e.target === e.currentTarget) hideSystemsManager();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideCreateModal(); hideSystemsManager(); }
});

// ═══════════ 系统台账 ═══════════
async function showSystemsManager() {
  document.getElementById('systemModalOverlay').classList.add('open');
  hideFormError('systemFormError');
  cancelAddSystem();
  await renderSystemsList();
}
function hideSystemsManager() {
  document.getElementById('systemModalOverlay').classList.remove('open');
}

async function renderSystemsList() {
  const wrap = document.getElementById('systemsList');
  wrap.innerHTML = '<div class="loading-overlay" style="padding:30px 0;"><div class="crosshair-spin"></div></div>';
  let systems = [];
  let reqs = [];
  try {
    [systems, reqs] = await Promise.all([
      api('GET', '', undefined, SYS_BASE),
      api('GET', ''),
    ]);
    systemsCache = systems;
  } catch (e) {
    wrap.innerHTML = `<div class="form-error">台账调取失败：${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!systems.length) {
    wrap.innerHTML = '<div class="form-hint" style="padding:20px 0;">台账尚空，点右上「立新账」登记第一个系统</div>';
    return;
  }
  wrap.innerHTML = `
    <table class="ledger-table">
      <thead><tr><th>系统名称</th><th>GITEE 仓库</th><th>用途说明</th><th style="text-align:center">图纸数</th><th>操作</th></tr></thead>
      <tbody>
        ${systems.map(s => {
          const cnt = reqs.filter(r => String(r.system_id) === String(s.id)).length;
          return `
          <tr id="sys-row-${s.id}">
            <td class="ledger-name">${escapeHtml(s.name)}</td>
            <td class="ledger-repo ${s.gitee_repo ? '' : 'none'}">${s.gitee_repo
              ? `<a href="https://gitee.com/${escapeHtml(s.gitee_repo)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;border-bottom:1px dashed;">${escapeHtml(s.gitee_repo)} ↗</a>`
              : '未绑定'}</td>
            <td class="ledger-desc">${escapeHtml(s.description || '—')}</td>
            <td class="ledger-count">${cnt}</td>
            <td class="ledger-op">
              <button class="op-link" onclick="editSystem(${s.id})">改</button>
              <button class="op-link del" onclick="deleteSystem(${s.id}, ${JSON.stringify(s.name).replace(/"/g, '&quot;')})">销</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function showAddSystemForm() {
  document.getElementById('addSystemForm').hidden = false;
  document.getElementById('sysName').focus();
}
function cancelAddSystem() {
  const f = document.getElementById('addSystemForm');
  f.hidden = true;
  ['sysName', 'sysGitee', 'sysDesc'].forEach(id => { document.getElementById(id).value = ''; });
  hideFormError('systemFormError');
}

async function saveNewSystem() {
  hideFormError('systemFormError');
  const name = document.getElementById('sysName').value.trim();
  const gitee = document.getElementById('sysGitee').value.trim();
  const desc = document.getElementById('sysDesc').value.trim();
  if (!name) { showFormError('systemFormError', '系统名称为必填项'); return; }
  try {
    await api('POST', '', { name, gitee_repo: gitee, description: desc }, SYS_BASE);
    cancelAddSystem();
    await renderSystemsList();
  } catch (e) {
    showFormError('systemFormError', e.message);
  }
}

async function editSystem(sid) {
  const row = document.getElementById('sys-row-' + sid);
  if (!row) return;
  const sys = systemsCache.find(s => String(s.id) === String(sid));
  if (!sys) return;
  row.innerHTML = `
    <td colspan="5">
      <div class="ledger-edit">
        <div class="form-row">
          <div class="form-group"><label class="form-label">系统名称</label>
            <input id="edit-name-${sid}" value="${escapeHtml(sys.name)}"></div>
          <div class="form-group"><label class="form-label">Gitee 仓库</label>
            <input id="edit-gitee-${sid}" value="${escapeHtml(sys.gitee_repo || '')}"></div>
        </div>
        <div class="form-group"><label class="form-label">用途说明</label>
          <textarea id="edit-desc-${sid}">${escapeHtml(sys.description || '')}</textarea></div>
        <div class="form-actions">
          <button class="draft-btn sm" onclick="renderSystemsList()">取消</button>
          <button class="draft-btn primary sm" onclick="saveEditSystem(${sid})">保存</button>
        </div>
      </div>
    </td>`;
}

async function saveEditSystem(sid) {
  const body = {
    name: document.getElementById(`edit-name-${sid}`).value.trim(),
    gitee_repo: document.getElementById(`edit-gitee-${sid}`).value.trim(),
    description: document.getElementById(`edit-desc-${sid}`).value.trim(),
  };
  if (!body.name) { alert('系统名称不能为空'); return; }
  try {
    await api('PUT', '/' + sid, body, SYS_BASE);
    await renderSystemsList();
  } catch (e) {
    alert('保存失败：' + e.message);
  }
}

async function deleteSystem(sid, name) {
  if (!confirm(`销账系统「${name}」？\n其下需求将变为“未指定系统”，需求本身不受影响。`)) return;
  try {
    await api('DELETE', '/' + sid, undefined, SYS_BASE);
    await renderSystemsList();
  } catch (e) {
    alert('销账失败：' + e.message);
  }
}

// ── 启动 ──
route();
