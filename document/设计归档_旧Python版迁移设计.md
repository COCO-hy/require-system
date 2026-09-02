# Python 版需求管理系统 — 设计文档

> 目标：用 Python 标准库把 `require-system`（Node/Express 版）重写为功能等价的单文件后端，
> 复用同一份 `data/requirements.db` 数据与同一套 `public/` 前端静态资源。
> 本次范围只包含「需求管理系统」本身，不集成 DSH/AgentTeams 引擎；`execute` 一律走本地模拟（4 步，每步写一条日志）。

---

## 1. 目标与范围

| 项目 | 说明 |
| --- | --- |
| 复刻对象 | `require-system/server.js` + `routes/requirements.js` + `routes/systems.js` + `db.js` + `utils.js` |
| 数据库 | 复用 `require-system/data/requirements.db`，schema 与 Node 版 `db.js` 完全一致 |
| 前端 | 复用 `require-system/public/**`，Python 版只负责 API + 静态文件 |
| 执行引擎 | **本地模拟**（4 步：解析需求 → Gitee → 数据源 → 报告），不拉起 DSH |
| 交付物 | `py/app.py`（单文件实现，本仓库下一步产出）+ 本设计文档 `py/DESIGN.md` + `py/README.md` |

**明确不做**：DSH headless 引擎拉起（`spawnHeadlessEngine` / `armBootGuard` / `finalizeEngineRun` / `writeEngineTask`）、
真实 AgentTeams 协作。这些在 Python 版中一律降级为本地模拟，保证「点击执行 → 轮询进度 → 得到结果」闭环可用。

---

## 2. 技术选型

**默认方案（不允许额外依赖，除非另有说明）：纯 Python 标准库，单文件 `app.py`。**

| 能力 | 选型 |
| --- | --- |
| 数据库 | `sqlite3`（标准库，开启 WAL） |
| HTTP 服务 | `http.server.ThreadingHTTPServer` + 自定义 `BaseHTTPRequestHandler` |
| 后台执行 | `threading.Thread`（每步 `time.sleep` 模拟耗时） |
| JSON | `json` |
| 时间 | `datetime`（**UTC**，与 Node `now()` 对齐） |
| 文件上传 multipart 解析 | 手写最小解析器（见 §9.4），不用已移除的 `cgi` 模块 |
| 运行环境 | conda base（本机 `D:\Copaw\miniforge3\python.exe`，Python 3.13.x），**零 pip 安装** |

> 备选：若确实想用 Flask，需在 conda base 之外安装 `flask`，属于额外依赖，默认**不允许**。
> 本设计按标准库落地，Flask 仅作为被否决的备选记录。

---

## 3. 目录与文件结构

```
require-system/
├── server.js                # Node 版（保留，不删除）
├── db.js / utils.js / routes/…
├── data/
│   └── requirements.db      # 共用 SQLite（Node 与 Python 共用同一份）
├── public/                  # 前端（Python 版复用，不改动）
├── uploads/                 # 附件（Python 版写入同一目录）
└── py/
    ├── app.py               # 单文件后端（Python 版唯一实现）
    ├── DESIGN.md            # 本设计文档
    └── README.md            # 启动说明（PORT 默认 3002，可改回 3001）
```

**路径约定（`app.py` 内）**：以脚本自身位置推导仓库根目录：

```python
ROOT = Path(__file__).resolve().parent.parent   # require-system/
DB_PATH     = ROOT / "data" / "requirements.db"
PUBLIC_DIR  = ROOT / "public"
UPLOAD_DIR  = ROOT / "uploads"
```

启动时 `mkdir` 确保 `data/`、`uploads/` 存在；`data/requirements.db` 与 Node 版共用，
SQLite WAL 模式天然支持 Node/Python 并发访问（同一时刻不建议两个进程同时写同一行，但本系统场景无冲突）。

---

## 4. 数据层：SQLite schema（与 `db.js` 兼容）

### 4.1 建表语句（照搬 `db.js`，逐字符等价）

```sql
CREATE TABLE IF NOT EXISTS systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  gitee_repo TEXT DEFAULT '',
  description TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER DEFAULT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  project_number TEXT NOT NULL DEFAULT '',
  gitee_repo TEXT DEFAULT '',
  file_path TEXT DEFAULT '',
  file_original_name TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (system_id) REFERENCES systems(id)
);

CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL,
  status TEXT DEFAULT 'running',
  result_data TEXT DEFAULT '',
  logs TEXT DEFAULT '[]',
  agent_teams_data TEXT DEFAULT '',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (requirement_id) REFERENCES requirements(id)
);
```

### 4.2 兼容既有 `data/requirements.db`（重要）

实测当前 `data/requirements.db` 的 `executions` 表已比 `db.js` 多出三列（历史版本遗留）：

```
executions 实际列顺序：
id, requirement_id, status, result_data, logs, started_at, completed_at,
dsh_team_id TEXT DEFAULT '', dsh_session_id TEXT DEFAULT '', agent_teams_data TEXT DEFAULT '{}'
```

且 `agent_teams_data` 默认值是 `'{}'` 而非 `''`。因此 Python 版必须：

1. 用 §4.1 的 `CREATE TABLE IF NOT EXISTS`（对新库建出 db.js 同款 schema）；
2. 再用**幂等 ALTER**补齐任何缺列（沿用 `db.js` 第 58–60 行的升级思路），覆盖全部已知列：

```python
ALTER_COLUMNS = [
    ("requirements", "system_id", "INTEGER DEFAULT NULL"),
    ("executions",   "logs",       "TEXT DEFAULT '[]'"),
    ("executions",   "agent_teams_data", "TEXT DEFAULT ''"),
    ("executions",   "dsh_team_id",      "TEXT DEFAULT ''"),
    ("executions",   "dsh_session_id",   "TEXT DEFAULT ''"),
]
# 对每个 (table, column, decl)：若 PRAGMA table_info(table) 不含该列，则
# ALTER TABLE <table> ADD COLUMN <column> <decl>  （已存在则忽略）
```

3. **所有 INSERT 一律显式写列名**，绝不依赖列顺序（因为旧库列序与 `db.js` 不同）：

```sql
INSERT INTO executions (requirement_id, status, logs, started_at) VALUES (?, ?, ?, ?)
INSERT INTO requirements (system_id, title, description, project_number, gitee_repo, file_path, file_original_name) VALUES (?, ?, ?, ?, ?, ?, ?)
INSERT INTO systems (name, gitee_repo, description) VALUES (?, ?, ?)
```

4. 读取时对 `logs / result_data / agent_teams_data` 做 `safe_parse`（`json.loads`，失败回退），
   同时兼容 `''`、`'[]'`、`'{}'` 三种空形态：
   - `logs`：空 → `[]`
   - `result_data`：空 → `None`
   - `agent_teams_data`：空/`{}` → `None`（接口返回 JSON `null`，前端 `renderAgentTeams` 据此隐藏团队面板）

### 4.3 `now()` 时间格式

Node 版 `now()` = `new Date().toISOString().replace('T',' ').slice(0,19)`，即 **UTC** 的 `YYYY-MM-DD HH:MM:SS`。
Python 版等价实现：

```python
from datetime import datetime, timezone
def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
```

> SQLite 的 `DEFAULT CURRENT_TIMESTAMP` 本身就是 UTC 的 `YYYY-MM-DD HH:MM:SS`，两者一致，
> 前端 `formatDate()` 按本地时区展示，无需再换算。

---

## 5. API 契约（与 Node 版一一对应）

### 5.1 通用约定

- 统一 JSON 响应：成功 `{"success": true, "data": …}`；失败 `{"success": false, "error": "…"}`。
- `Content-Type: application/json; charset=utf-8`（Node 默认 utf-8）。
- CORS：`Access-Control-Allow-Origin: *`，支持 `OPTIONS` 预检（§9.3）。
- 错误码与文案**逐字对齐** Node 版（见下表），前端 `api()` 会抛 `data.error` 展示给用户。

### 5.2 系统 `/api/systems`

| 方法+路径 | 请求 | 响应 | 特殊分支 |
| --- | --- | --- | --- |
| `GET /api/systems` | — | `{success:true, data:[sys…]}`，`ORDER BY name ASC`，返回全部列 | — |
| `GET /api/systems/:id` | — | `{success:true, data:{...sys, requirement_count}}`；`requirement_count` = 该 system 下的需求数 | 404 `error:"系统不存在"` |
| `POST /api/systems` | `{name, gitee_repo, description}` | `{success:true, data:{id}}` | name 空 → 400 `error:"系统名称不能为空"`；UNIQUE → 400 `error:"系统名称已存在"`；`gitee_repo` 走 `normalizeGiteeRepo` |
| `PUT /api/systems/:id` | `{name, gitee_repo, description}` | `{success:true}`；`updated_at=now()` | 404 `error:"系统不存在"`；UNIQUE → 400 同上；`name` 为空回退旧值；`gitee_repo` 仅当 `!== undefined` 才更新（空串会写成 `''`）；`description` 仅当 `!== undefined` 才更新 |
| `DELETE /api/systems/:id` | — | `{success:true}`；先 `UPDATE requirements SET system_id=NULL WHERE system_id=?` 再删除系统 | 404 `error:"系统不存在"` |

### 5.3 需求 `/api/requirements`

| 方法+路径 | 请求 | 响应 | 特殊分支 |
| --- | --- | --- | --- |
| `GET /api/requirements` | — | `{success:true, data:[r…]}`；`SELECT r.id,title,project_number,gitee_repo,status,file_original_name,created_at,updated_at,system_id, s.name AS system_name FROM requirements r LEFT JOIN systems s … ORDER BY r.created_at DESC` | — |
| `GET /api/requirements/:id` | — | `{success:true, data:{...r, system_name, executions:[…]}}`；`executions` = `SELECT * FROM executions WHERE requirement_id=? ORDER BY started_at DESC LIMIT 1` 的**数组**（最多 1 条，字段为原始字符串） | 404 `error:"需求不存在"` |
| `POST /api/requirements` | multipart：`title`(必填)、`description`、`project_number`、`gitee_repo`、`system_id`、`file`(可选) | `{success:true, data:{id}}` | title 空 → 400 `error:"需求标题不能为空"`；文件类型不允许 → 400；`system_id` 存在时，若系统有 `gitee_repo` 且需求未填，则自动填充系统仓库 |
| `POST /api/requirements/dispatch` | JSON：`{title, description, project_number?, system_id?}` | 见下方 | title/description 缺失 → 400 `error:"title 和 description 为必填"`；同名 pending/running → 409 `error:"存在同名进行中的需求 #<id>，请先等它完成或换标题"` |
| `DELETE /api/requirements/:id` | — | `{success:true}`；删文件（若 `file_path` 存在）→ 删 executions → 删需求 | 404 `error:"需求不存在"` |

**`POST /api/requirements` 的 `system_id` 自动填充逻辑（复刻）**：

```
finalSystemId = system_id ? int(system_id) : None
finalGiteeRepo = normalizeGiteeRepo(gitee_repo)
若 finalSystemId 存在且系统行存在：finalGiteeRepo = normalizeGiteeRepo(sys.gitee_repo) or finalGiteeRepo
文件字段：有 file → file_path=绝对路径, file_original_name=原始文件名；无 → 空串
```

**`POST /api/requirements/dispatch`（Python 版简化）**：创建需求 + 建一条 `status='pending'` 的 execution，
随后置 `running` 并跑本地模拟。响应统一为「模拟兜底」形态（无引擎，必然 fallback）：

```json
{
  "success": true,
  "data": {
    "requirement_id": 123,
    "execution_id": 456,
    "mode": "simulate-fallback",
    "poll_url": "/api/requirements/123/execution/progress"
  },
  "message": "已切换本地模拟执行（未集成 DSH 引擎）"
}
```

### 5.4 执行 `/api/requirements`

| 方法+路径 | 请求 | 响应 | 特殊分支 |
| --- | --- | --- | --- |
| `POST /api/requirements/:id/execute` | JSON `{mode?}` 或 query `?mode=` | 见下方 | 需求不存在 → 404 `error:"需求不存在"`；`status==='running'` → 400 `error:"该需求正在执行中"` |
| `GET /api/requirements/:id/execution/progress` | — | 见下方 | 无 execution → `{success:true, data:{status:"none", logs:[]}}` |
| `GET /api/requirements/:id/executions` | — | `{success:true, data:[exec…]}`；`SELECT * FROM executions WHERE requirement_id=? ORDER BY started_at DESC`（**原始字符串**，不解析） | — |
| `GET /api/requirements/executions/:id` | — | `{success:true, data:exec}`，其中 `logs/result_data/agent_teams_data` 已解析 | 404 `error:"执行记录不存在"` |
| `PUT /api/requirements/executions/:id` | JSON `{status?, logs?, result_data?, agent_teams_data?}` | `{success:true}` | 404 `error:"执行记录不存在"` |

**`POST /:id/execute` 响应**：

- 默认（无 mode，或 `mode !== 'dsh'`）→ `mode:"simulate"`，`message:"需求执行已启动"`；
- `mode === 'dsh'` → Python 版不拉起引擎，**直接 fallback**：`mode:"simulate-fallback"`，`message:"引擎拉起失败，已切换本地模拟执行"`。

两者均返回 `{success:true, data:{execution_id, mode}, message:…}` 并立即返回，由前端轮询。

> 前端 `app.js` 实际固定发送 `{mode:'dsh'}`，因此 Python 版运行时 `mode` 恒为 `simulate-fallback`；
> 前端只消费 `data.execution_id`，不受影响。

**`GET /:id/execution/progress` 响应**（取该需求最新一条 execution，显式列）：

```json
{
  "success": true,
  "data": {
    "execution_id": 456,
    "status": "running | completed | failed | pending",
    "logs": [ {"level":"info","message":"…","timestamp":"2025-…"} , {"step":"parsing","label":"解析需求文档","status":"completed","timestamp":"…"} ],
    "result": { … } | null,
    "agent_teams": { … } | null
  }
}
```

**`PUT /executions/:id` 回写语义（复刻）**：

- 仅更新请求中出现的字段：`status`（非空才更新）；`logs` / `result_data` / `agent_teams_data`（`!== undefined` 才更新，非字符串则 `json.dumps`）。
- 若 `status ∈ {completed, failed}` → 同时写 `completed_at = now()`。
- **同步需求状态**：`completed→completed`，`failed→failed`，其它（如 `running`/`pending`）→`running`，并刷新 `requirements.updated_at`。

> 该接口是 DSH/引擎回写通道（Node 版 `engine-helpers.js` 调它）。Python 版保留完整实现，
> 以便未来接入引擎时无需改接口；当前本地模拟直接写库，不经过 HTTP。

---

## 6. `normalizeGiteeRepo` 逻辑（`utils.js` 复刻）

输入 → 输出均为 `owner/repo`（无首尾斜杠、无 `.git`）；空值返回 `''`。

| 输入 | 输出 |
| --- | --- |
| `'' / null / undefined / '   '` | `''` |
| `https://gitee.com/owner/repo` | `owner/repo` |
| `https://gitee.com/owner/repo.git` | `owner/repo` |
| `http://gitee.com/owner/repo` | `owner/repo` |
| `git@gitee.com:owner/repo.git`（SSH） | `owner/repo` |
| `owner/repo` | `owner/repo` |
| `owner/repo.git` | `owner/repo` |

Python 等价实现：

```python
import re
from urllib.parse import urlparse

def normalize_gitee_repo(value) -> str:
    if not value:
        return ""
    repo = str(value).strip()
    if not repo:
        return ""
    if re.match(r"^git@[^:]+:[^/]+/", repo):          # SSH: git@host:owner/repo…
        repo = repo[repo.index(":") + 1:]
    elif re.match(r"^https?://", repo, re.I):          # URL: 取 pathname
        try:
            repo = urlparse(repo).path
        except Exception:
            pass
    repo = re.sub(r"^/+|/+$", "", repo)                # 去首尾斜杠
    repo = re.sub(r"\.git$", "", repo, flags=re.I)     # 去尾部 .git
    return repo.strip()
```

---

## 7. 执行记录日志读写（`logs` 结构）

`executions.logs` 是 **JSON 数组**，元素分两类（前端据此双视图渲染）：

1. **富日志行**（`renderLogFeed` 用 `l.level && l.message` 过滤）：
   `{"level": "system|info|success|warn|error", "message": "…", "timestamp": "YYYY-MM-DD HH:MM:SS"}`
2. **步骤标记**（`renderProgressSteps` 用 `l.step` 识别）：
   `{"step": "parsing|gitee|datasource|summarize", "label": "中文步骤名", "status": "running|completed", "timestamp": "…"}`

**写入方式（每次 append，读-改-写）**：

```python
def append_log(conn, exec_id, entry):
    row = conn.execute("SELECT logs FROM executions WHERE id=?", (exec_id,)).fetchone()
    if not row: return
    logs = safe_parse(row["logs"], [])
    entry = dict(entry)
    entry.setdefault("timestamp", now())
    logs.append(entry)
    conn.execute("UPDATE executions SET logs=? WHERE id=?", (json.dumps(logs, ensure_ascii=False), exec_id))
    conn.commit()
```

> `json.dumps(ensure_ascii=False)` 保证中文/emoji 直接存 UTF-8，与 Node `JSON.stringify` 行为一致；
> 读回时 `json.loads` 恢复 Unicode。**每步至少 append 一次**，进度接口即可返回中间日志。

---

## 8. 本地模拟执行（4 步）

### 8.1 步骤定义（与 Node `EXECUTION_STEPS` 一致）

| 顺序 | step id | label | 模拟耗时 |
| --- | --- | --- | --- |
| 1 | `parsing` | 解析需求文档 | 1200ms |
| 2 | `gitee` | 获取 Gitee 仓库信息 | 1500ms |
| 3 | `datasource` | 关联数据源 | 1000ms |
| 4 | `summarize` | 生成执行报告 | 800ms |

**单步流程**（在后台线程顺序执行）：

1. `append_log({step, label, status:"running"})`
2. `append_log({level:"info", message:"▶ 开始「{label}」..."})`
3. `time.sleep(duration/1000)`
4. `append_log({step, label, status:"completed"})`
5. `append_log({level:"success", message:"✅「{label}」完成 — {STEP_DETAIL}"})`

开头先写两条 system 日志（复刻 Node）：

- `{"level":"system","message":"🚀 AgentTeams 团队已创建：developer（前端开发工程师）+ reviewer（代码审查员）"}`
- `{"level":"system","message":"任务拆解：t1 解析需求文档 → t2 获取 Gitee 仓库信息 → t3 关联数据源 → t4 生成执行报告"}`

**STEP_DETAIL 文案（复刻）**：

```
parsing    = 解析需求文档完成 — 标题「{title}」，项目号 {project_number or '未填写'}
gitee      = 已关联 Gitee 仓库 {gitee_repo}（分支 main / develop）   |  无仓库时: 未配置 Gitee 仓库，已跳过该步骤
datasource = 数据源就绪：Gitee API https://gitee.com/api/v5/repos/{gitee_repo}   |  无仓库时: 数据源就绪：未配置 Gitee，外部数据源待配置
summarize  = 执行报告已生成 — 需求「{title}」可交付
```

### 8.2 收尾：`result_data` 结构（复刻 Node）

```json
{
  "requirement": {
    "id": 1, "title": "…", "description": "…",
    "project_number": "…", "gitee_repo": "…"
  },
  "file_attachment": { "name": "原文名或空", "content": "文件内容（utf-8；读不到则'[无法读取文件内容]'）" },
  "data_sources": {
    "gitee": { "repo":"…", "project_number":"…", "api_endpoint":"https://gitee.com/api/v5/repos/…", "branches":["main","develop"] },
    "external": { "type":"待配置", "note":"可根据项目号对接更多数据源" }
  },
  "execution_summary": "需求「…」执行完成，项目号 …，已关联 Gitee 仓库 … 或 未配置仓库。",
  "executed_at": "YYYY-MM-DD HH:MM:SS"
}
```

> `gitee_repo` 为空时 `data_sources.gitee = null`（前端显示「未配置」）。

### 8.3 收尾：`agent_teams_data` 结构（复刻 Node `buildTeamData`）

```json
{
  "team": {
    "name": "autopilot-req-{reqId}",
    "status": "completed",
    "members": [
      {"name":"developer","role":"前端开发工程师","activity":"completed"},
      {"name":"reviewer","role":"代码审查员","activity":"completed"}
    ],
    "tasks": [
      {"id":"t1","subject":"步骤一：解析需求文档","assignee":"developer","status":"completed","output":"…"},
      {"id":"t2","subject":"步骤二：获取 Gitee 仓库信息","assignee":"developer","status":"completed","output":"…"},
      {"id":"t3","subject":"步骤三：关联数据源","assignee":"developer","status":"completed","output":"…"},
      {"id":"t4","subject":"步骤四：生成执行报告","assignee":"reviewer","status":"completed","output":"…"}
    ]
  }
}
```

> 每步 `output` = 该步 `STEP_DETAIL`。前端 `renderAgentTeams` 据此渲染团队面板。

### 8.4 状态流转与并发模型

- 建 execution：`status='running'`（默认 simulate）或先 `'pending'` 再置 `'running'`（dispatch）。
- 需求 `status`：`pending → running → completed | failed`（执行成功置 `completed`，异常置 `failed` 并写 error 日志 + `completed_at`）。
- 后台用 `threading.Thread(daemon=True)` 跑 `run_execution_steps`，整体 try/except 包裹，异常时 `append_log(error…)` + 置 failed（复刻 Node `runExecutionSteps` 的包装）。
- SQLite 连接：**每线程独立连接**（`sqlite3.connect` 不跨线程共享；`check_same_thread=False` 仅用于同一线程复用）。写操作串行靠 SQLite 锁 + WAL 保证。

---

## 9. HTTP 服务实现要点（`http.server`）

### 9.1 路由表与匹配顺序

用一个 `BaseHTTPRequestHandler` 子类，`do_GET/do_POST/do_PUT/do_DELETE/do_OPTIONS` 统一分发。
**匹配顺序：先精确/更多段，后参数段**（避免 `/:id` 吞掉 `/executions/:id` 等固定段）。

需求侧（`/api/requirements`）匹配顺序：

```
POST /api/requirements                  → create（multipart）
POST /api/requirements/dispatch         → dispatch
GET  /api/requirements                  → list
GET  /api/requirements/executions/{id}  → 执行详情（固定段优先）
PUT  /api/requirements/executions/{id}  → 回写
GET  /api/requirements/{id}/execution/progress → 进度
POST /api/requirements/{id}/execute     → 执行
GET  /api/requirements/{id}/executions  → 执行历史
GET  /api/requirements/{id}             → 详情
DELETE /api/requirements/{id}           → 删除
```

系统侧（`/api/systems`）：

```
GET  /api/systems      → 列表
POST /api/systems      → 创建
GET  /api/systems/{id} → 详情
PUT  /api/systems/{id} → 更新
DELETE /api/systems/{id} → 删除
```

> 上面把 `GET /api/requirements/executions/{id}` 放在 `GET /{id}` 之前，本质是因为它有两段、
> `/{id}` 只有一段——但建议实现成「先按固定字面段匹配，再按参数段匹配」的正则/分派表，保证无歧义。

### 9.2 静态文件与 SPA fallback

- 非 `/api` 的 `GET` → 映射到 `PUBLIC_DIR`（`../public`）：
  - 文件存在 → 按扩展名给 MIME（`.html→text/html`、`.css→text/css`、`.js→application/javascript`、`.json`、`.png/.jpg/.svg/.ico/.md/.txt` 等），`utf-8` 读取返回 200。
  - 不存在但看起来像 SPA 路由（`/`、`/detail/123`）→ 返回 `public/index.html`（保证刷新详情页不 404）。
- 目录穿越防护：`resolve` 后校验路径仍在 `PUBLIC_DIR` 内，否则 404。
- `public/js/app.js?v=2.0` 这类带 query 的请求，路由时先剥掉 `?`。

### 9.3 CORS / OPTIONS

- 所有响应加 `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`、`Access-Control-Allow-Headers: Content-Type`。
- `do_OPTIONS`：直接 204 + 上述头（前端跨端口访问不报 CORS）。

### 9.4 multipart 文件上传解析（`POST /api/requirements`）

标准库无内置 multipart 解码（`cgi` 已移除），手写最小解析器：

1. 从 `Content-Type` 提取 `boundary=…`。
2. 读取 `Content-Length` 字节到内存，按 `--boundary` 切分 part。
3. 每个 part 解析 `Content-Disposition: form-data; name="…"; filename="…"` 与 `Content-Type`。
4. 普通字段（title/description/…）→ `bytes.decode('utf-8')`。
5. `name="file"` 的 part：
   - 校验扩展名 ∈ `{.md,.txt,.pdf,.doc,.docx,.json,.yaml,.yml,.csv}`（小写比较），否则 400（文案同 multer：`不支持的文件类型，请上传: .md, .txt, …`）。
   - 校验大小 ≤ 10MB（`limits.fileSize`），超限 400。
   - 文件名：`{int(time.time()*1000)}-{random.randint(0, 999999999)}{ext}`，写入 `UPLOAD_DIR`，`file_path` 存**绝对路径**、`file_original_name` 存原始文件名（`Content-Disposition` 里 `filename` 可能带引号/中文，需按 RFC 处理 `filename*=utf-8''…` 情况，至少覆盖引号形式）。

> 简化提示：实现时对 `filename` 只做「去首尾双引号」即可覆盖现有前端行为；Node multer 也只存原始名。

### 9.5 JSON 请求体解析

- `POST/PUT /api/*` 读 `Content-Length` 字节，`json.loads`；空 body → `{}`；解析失败 → 400 `{"success":false,"error":"Invalid JSON"}`（Node `express.json()` 也会 400）。

---

## 10. 启动方式与端口

```bash
cd py
python app.py          # 默认 PORT=3002，避免与 Node 版 3001 冲突
# 或
PORT=3001 python app.py
```

- 端口：`PORT` 环境变量，默认 **3002**。
- `README.md` 说明：若想完全替代 Node 版，`set PORT=3001`（Windows）/ `export PORT=3001`（Linux）后启动即可，前端无需改动（API 相对路径，端口随服务走）。
- 启动横幅打印（对齐 Node 版体验）：`http://localhost:{PORT}` 与 `/api/requirements` 地址。
- 初始化顺序：建目录 → 开 SQLite（`PRAGMA journal_mode=WAL`）→ 建表 + 幂等补列 → **seed 4 个默认系统**（仅当 systems 表为空，名称/仓库/描述与 `db.js` 完全一致）→ 起 `ThreadingHTTPServer`。

**seed 默认系统（复刻 `db.js`）**：

```
认证服务 / myteam/auth-service / 用户认证、权限管理相关
数据看板 / myteam/dashboard     / 数据可视化与报表系统
支付中心 / myteam/payment       / 支付流程、账单管理
消息推送 / myteam/notification  / 推送通知、消息队列服务
```

---

## 11. 实现 checklist（验收要点）

- [ ] `cd py && python app.py` 后，`http://localhost:3002` 可打开前端（复用 `../public`）。
- [ ] `GET /api/systems` / `GET /api/requirements` 返回与 Node 版一致的数据（含已存在的 6 系统 / 8 需求 / 13 执行记录）。
- [ ] 新建需求（含上传 .md 附件）→ 列表出现、`file_original_name` 显示附件名、`uploads/` 生成文件。
- [ ] 详情页点「开始执行」→ `POST /:id/execute` 返回 `execution_id`；轮询 `GET /:id/execution/progress` 能看到 4 步日志逐步推进（status 从 running → completed）。
- [ ] 完成后 `result_data` / `agent_teams_data` 结构满足前端渲染（执行结果面板 + AgentTeams 面板均正常显示）。
- [ ] `GET /api/requirements/executions/:id` 与 `PUT /api/requirements/executions/:id` 手动 curl 验证（详情解析、回写 status/logs、需求状态同步）。
- [ ] 系统增删改查：新增/编辑/删除，删除系统后关联需求的 `system_id` 置 NULL。
- [ ] 需求删除：级联删除其 executions 与附件文件。
- [ ] `normalize_gitee_repo` 对 URL / SSH / owner-repo / .git / 空值 六类输入结果正确。
- [ ] 不引入任何 pip 依赖；`python` 来自 conda base。
