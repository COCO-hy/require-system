#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
需求管理系统 — Python 版（单文件实现）

用 Python 标准库（sqlite3 + http.server）复刻 Node/Express 版后端：
  - 复用 ../data/requirements.db（与 Node 版同一份数据，schema 兼容，WAL）
  - 复用 ../public 静态前端
  - execute 本地模拟 4 步（解析需求 → Gitee → 数据源 → 报告），每步写日志
  - 不集成 DSH / AgentTeams 引擎

启动：cd py && python app.py   （PORT 环境变量，默认 3002）
"""

import json
import mimetypes
import os
import random
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

# ──────────────────────────────────────────────────────────────
# 路径（以脚本位置推导 require-system 仓库根目录）
# ──────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent          # require-system/
DB_PATH = ROOT / "data" / "requirements.db"
PUBLIC_DIR = ROOT / "public"
UPLOAD_DIR = ROOT / "uploads"

API_REQ = "/api/requirements"
API_SYS = "/api/systems"

# 附件白名单（与 server.js multer fileFilter 一致）
ALLOWED_EXTS = {".md", ".txt", ".pdf", ".doc", ".docx", ".json", ".yaml", ".yml", ".csv"}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB

MIME = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
}

# ──────────────────────────────────────────────────────────────
# Schema（与 db.js 逐字等价）
# ──────────────────────────────────────────────────────────────
SCHEMA = """
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
"""

# 幂等补列：覆盖 db.js 的 ALTER 与既有库中历史遗留的额外列
ALTER_COLUMNS = [
    ("requirements", "system_id", "INTEGER DEFAULT NULL"),
    ("executions", "logs", "TEXT DEFAULT '[]'"),
    ("executions", "agent_teams_data", "TEXT DEFAULT ''"),
    ("executions", "dsh_team_id", "TEXT DEFAULT ''"),
    ("executions", "dsh_session_id", "TEXT DEFAULT ''"),
]

SEED_SYSTEMS = [
    ("认证服务", "myteam/auth-service", "用户认证、权限管理相关"),
    ("数据看板", "myteam/dashboard", "数据可视化与报表系统"),
    ("支付中心", "myteam/payment", "支付流程、账单管理"),
    ("消息推送", "myteam/notification", "推送通知、消息队列服务"),
]

# ──────────────────────────────────────────────────────────────
# 模拟执行的步骤定义（与 Node EXECUTION_STEPS 一致）
# ──────────────────────────────────────────────────────────────
EXECUTION_STEPS = [
    {"id": "parsing", "label": "解析需求文档", "duration": 1200},
    {"id": "gitee", "label": "获取 Gitee 仓库信息", "duration": 1500},
    {"id": "datasource", "label": "关联数据源", "duration": 1000},
    {"id": "summarize", "label": "生成执行报告", "duration": 800},
]


def step_detail(step_id, req):
    t = req.get("title")
    pn = req.get("project_number") or "未填写"
    repo = req.get("gitee_repo")
    return {
        "parsing": f"解析需求文档完成 — 标题「{t}」，项目号 {pn}",
        "gitee": f"已关联 Gitee 仓库 {repo}（分支 main / develop）" if repo else "未配置 Gitee 仓库，已跳过该步骤",
        "datasource": f"数据源就绪：Gitee API https://gitee.com/api/v5/repos/{repo}" if repo else "数据源就绪：未配置 Gitee，外部数据源待配置",
        "summarize": f"执行报告已生成 — 需求「{t}」可交付",
    }[step_id]


# ──────────────────────────────────────────────────────────────
# 基础工具
# ──────────────────────────────────────────────────────────────
def now():
    """Node now(): new Date().toISOString().replace('T',' ').slice(0,19) → UTC 'YYYY-MM-DD HH:MM:SS'"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def safe_parse(text, fallback):
    if text is None:
        return fallback
    try:
        return json.loads(text)
    except Exception:
        return fallback


def normalize_gitee_repo(value):
    """复刻 utils.js normalizeGiteeRepo：URL / SSH / owner/repo / .git → owner/repo；空→''"""
    if not value:
        return ""
    repo = str(value).strip()
    if not repo:
        return ""
    if re.match(r"^git@[^:]+:[^/]+/", repo):          # SSH: git@gitee.com:owner/repo…
        repo = repo[repo.index(":") + 1:]
    elif re.match(r"^https?://", repo, re.IGNORECASE):  # URL：取 pathname
        try:
            repo = urlparse(repo).path
        except Exception:
            pass
    repo = re.sub(r"^/+|/+$", "", repo)                # 去首尾斜杠
    repo = re.sub(r"\.git$", "", repo, flags=re.IGNORECASE)  # 去尾部 .git
    return repo.strip()


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def is_unique_error(err):
    return isinstance(err, sqlite3.IntegrityError) and "UNIQUE" in str(err).upper()


def append_log(conn, exec_id, entry):
    """executions.logs 是 JSON 数组；每次 append 读-改-写并立即提交（等价 better-sqlite3 的即时可见）"""
    row = conn.execute("SELECT logs FROM executions WHERE id = ?", (exec_id,)).fetchone()
    if not row:
        return
    logs = safe_parse(row["logs"], [])
    if not isinstance(logs, list):
        logs = []
    entry = dict(entry)
    entry.setdefault("timestamp", now())
    logs.append(entry)
    conn.execute(
        "UPDATE executions SET logs = ? WHERE id = ?",
        (json.dumps(logs, ensure_ascii=False), exec_id),
    )
    conn.commit()


def build_team_data(req):
    steps = [
        {"id": "t1", "subject": "步骤一：解析需求文档", "assignee": "developer"},
        {"id": "t2", "subject": "步骤二：获取 Gitee 仓库信息", "assignee": "developer"},
        {"id": "t3", "subject": "步骤三：关联数据源", "assignee": "developer"},
        {"id": "t4", "subject": "步骤四：生成执行报告", "assignee": "reviewer"},
    ]
    tasks = []
    for i, st in enumerate(steps):
        task = dict(st)
        task["status"] = "completed"
        task["output"] = step_detail(EXECUTION_STEPS[i]["id"], req)
        tasks.append(task)
    return {
        "team": {
            "name": f"autopilot-req-{req.get('id')}",
            "status": "completed",
            "members": [
                {"name": "developer", "role": "前端开发工程师", "activity": "completed"},
                {"name": "reviewer", "role": "代码审查员", "activity": "completed"},
            ],
            "tasks": tasks,
        }
    }


# ──────────────────────────────────────────────────────────────
# 本地模拟执行（后台线程）
# ──────────────────────────────────────────────────────────────
def run_execution_steps(exec_id, req_data):
    conn = db()
    try:
        team = build_team_data(req_data)

        def log(level, message):
            append_log(conn, exec_id, {"level": level, "message": message})

        log("system", "🚀 AgentTeams 团队已创建：developer（前端开发工程师）+ reviewer（代码审查员）")
        log("system", "任务拆解：" + " → ".join(f"t{i + 1} {s['label']}" for i, s in enumerate(EXECUTION_STEPS)))

        for i, step in enumerate(EXECUTION_STEPS):
            append_log(conn, exec_id, {"step": step["id"], "label": step["label"], "status": "running"})
            log("info", f"▶ 开始「{step['label']}」...")
            time.sleep(step["duration"] / 1000.0)
            append_log(conn, exec_id, {"step": step["id"], "label": step["label"], "status": "completed"})
            log("success", f"✅「{step['label']}」完成 — {step_detail(step['id'], req_data)}")

        # 构建 result_data（复刻 Node）
        file_content = ""
        if req_data.get("file_path"):
            try:
                if os.path.exists(req_data["file_path"]):
                    with open(req_data["file_path"], "r", encoding="utf-8") as f:
                        file_content = f.read()
            except Exception:
                file_content = "[无法读取文件内容]"

        repo = req_data.get("gitee_repo")
        result_data = {
            "requirement": {
                "id": req_data["id"],
                "title": req_data.get("title"),
                "description": req_data.get("description"),
                "project_number": req_data.get("project_number"),
                "gitee_repo": repo,
            },
            "file_attachment": {
                "name": req_data.get("file_original_name"),
                "content": file_content,
            },
            "data_sources": {
                "gitee": {
                    "repo": repo,
                    "project_number": req_data.get("project_number"),
                    "api_endpoint": f"https://gitee.com/api/v5/repos/{repo}",
                    "branches": ["main", "develop"],
                } if repo else None,
                "external": {
                    "type": "待配置",
                    "note": "可根据项目号对接更多数据源",
                },
            },
            "execution_summary": (
                f"需求「{req_data.get('title')}」执行完成，项目号 {req_data.get('project_number')}"
                + (f"，已关联 Gitee 仓库 {repo}" if repo else "，未配置仓库") + "。"
            ),
            "executed_at": now(),
        }

        conn.execute(
            "UPDATE executions SET status = 'completed', result_data = ?, agent_teams_data = ?, completed_at = ? WHERE id = ?",
            (json.dumps(result_data, ensure_ascii=False), json.dumps(team, ensure_ascii=False), now(), exec_id),
        )
        conn.execute(
            "UPDATE requirements SET status = 'completed', updated_at = ? WHERE id = ?",
            (now(), req_data["id"]),
        )
        conn.commit()
    except Exception as e:
        try:
            msg = getattr(e, "message", None) or str(e)
            append_log(conn, exec_id, {"level": "error", "message": f"❌ 执行失败：{msg}"})
            conn.execute("UPDATE executions SET status = 'failed', completed_at = ? WHERE id = ?", (now(), exec_id))
            conn.execute("UPDATE requirements SET status = 'failed', updated_at = ? WHERE id = ?", (now(), req_data["id"]))
            conn.commit()
        except Exception:
            pass
    finally:
        conn.close()


# ──────────────────────────────────────────────────────────────
# 初始化数据库
# ──────────────────────────────────────────────────────────────
def init_db():
    os.makedirs(DB_PATH.parent, exist_ok=True)
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        for table, column, decl in ALTER_COLUMNS:
            cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
            if column not in cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        count = conn.execute("SELECT COUNT(*) AS c FROM systems").fetchone()[0]
        if count == 0:
            conn.executemany(
                "INSERT INTO systems (name, gitee_repo, description) VALUES (?, ?, ?)", SEED_SYSTEMS
            )
            print("[DB] Seeded 4 default systems")
        conn.commit()
    finally:
        conn.close()


# ──────────────────────────────────────────────────────────────
# HTTP 工具
# ──────────────────────────────────────────────────────────────
def send_json(handler, status, obj):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_body(handler):
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except ValueError:
        length = 0
    if length <= 0:
        return b""
    return handler.rfile.read(length)


def read_json(handler):
    """返回 dict；空 body → {}；非法 JSON → None"""
    raw = read_body(handler)
    if not raw.strip():
        return {}
    try:
        obj = json.loads(raw.decode("utf-8"))
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return None


def parse_multipart(handler):
    """最小 multipart/form-data 解析器；返回 (fields, file_info|None)"""
    ctype = handler.headers.get("Content-Type", "")
    m = re.search(r'boundary="?([^";]+)"?', ctype)
    if not m:
        raise ValueError("multipart: missing boundary")
    boundary = m.group(1)
    body = read_body(handler)
    delimiter = ("--" + boundary).encode("utf-8")
    chunks = body.split(delimiter)
    fields = {}
    file_info = None

    for chunk in chunks[1:]:
        if not chunk:
            continue
        if chunk.startswith(b"--"):       # 结尾边界 --boundary--
            break
        if chunk.startswith(b"\r\n"):
            chunk = chunk[2:]
        if not chunk:
            continue
        if b"\r\n\r\n" in chunk:
            head, content = chunk.split(b"\r\n\r\n", 1)
        else:
            head, content = chunk, b""
        if content.endswith(b"\r\n"):
            content = content[:-2]

        cd = ""
        for line in head.split(b"\r\n"):
            if b":" in line:
                k, v = line.split(b":", 1)
                if k.decode("utf-8", "replace").strip().lower() == "content-disposition":
                    cd = v.decode("utf-8", "replace").strip()

        name = None
        filename = None
        for part in cd.split(";"):
            part = part.strip()
            low = part.lower()
            if low.startswith("name="):
                name = part[5:].strip().strip('"')
            elif low.startswith("filename*="):
                raw = part[10:].strip().strip('"')
                if "''" in raw:
                    _, enc = raw.split("''", 1)
                    filename = unquote(enc)
            elif low.startswith("filename="):
                filename = part[9:].strip().strip('"')

        if name is None:
            continue

        if filename is not None:
            if name == "file":
                ext = os.path.splitext(filename)[1].lower()
                if ext not in ALLOWED_EXTS:
                    raise ValueError("不支持的文件类型，请上传: " + ", ".join(sorted(ALLOWED_EXTS)))
                if len(content) > MAX_FILE_SIZE:
                    raise ValueError("文件大小超过 10MB 限制")
                unique = f"{int(time.time() * 1000)}-{random.randint(0, 999999999)}{ext}"
                dest = UPLOAD_DIR / unique
                dest.write_bytes(content)
                file_info = {"file_path": str(dest.resolve()), "file_original_name": filename}
        else:
            fields[name] = content.decode("utf-8", "replace")

    return fields, file_info


def serve_file(handler, path):
    ext = path.suffix.lower()
    ctype = MIME.get(ext) or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    try:
        data = path.read_bytes()
    except Exception:
        handler.send_error(404)
        return
    handler.send_response(200)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(data)


def serve_static(handler):
    parsed = urlparse(handler.path)
    rel = parsed.path.lstrip("/") or "index.html"
    target = (PUBLIC_DIR / rel).resolve()
    public_resolved = PUBLIC_DIR.resolve()
    if not str(target).startswith(str(public_resolved)):
        handler.send_error(404)
        return
    if target.is_file():
        return serve_file(handler, target)
    index = PUBLIC_DIR / "index.html"
    if index.is_file():                 # SPA fallback（/detail/123 等前端路由）
        return serve_file(handler, index)
    handler.send_error(404)


# ──────────────────────────────────────────────────────────────
# 需求 handlers
# ──────────────────────────────────────────────────────────────
def handle_list_requirements(h):
    conn = db()
    try:
        rows = conn.execute(
            """SELECT r.id, r.title, r.project_number, r.gitee_repo, r.status,
                      r.file_original_name, r.created_at, r.updated_at,
                      r.system_id, s.name AS system_name
               FROM requirements r
               LEFT JOIN systems s ON r.system_id = s.id
               ORDER BY r.created_at DESC"""
        ).fetchall()
        send_json(h, 200, {"success": True, "data": [dict(r) for r in rows]})
    except Exception as e:
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def handle_get_requirement(h, req_id):
    conn = db()
    try:
        row = conn.execute(
            """SELECT r.*, s.name AS system_name
               FROM requirements r LEFT JOIN systems s ON r.system_id = s.id
               WHERE r.id = ?""",
            (req_id,),
        ).fetchone()
        if not row:
            return send_json(h, 404, {"success": False, "error": "需求不存在"})
        ex = conn.execute(
            "SELECT * FROM executions WHERE requirement_id = ? ORDER BY started_at DESC LIMIT 1", (req_id,)
        ).fetchall()
        data = dict(row)
        data["executions"] = [dict(x) for x in ex]
        send_json(h, 200, {"success": True, "data": data})
    except Exception as e:
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def handle_create_requirement(h):
    ctype = h.headers.get("Content-Type", "")
    file_info = None
    if "multipart/form-data" in ctype:
        try:
            fields, file_info = parse_multipart(h)
        except ValueError as e:
            return send_json(h, 400, {"success": False, "error": str(e)})
    else:
        fields = read_json(h)
        if fields is None:
            return send_json(h, 400, {"success": False, "error": "Invalid JSON"})

    title = fields.get("title", "")
    if not title or not str(title).strip():
        return send_json(h, 400, {"success": False, "error": "需求标题不能为空"})

    description = fields.get("description", "")
    project_number = fields.get("project_number", "")
    gitee_repo = fields.get("gitee_repo", "")
    system_id = fields.get("system_id", "")

    final_gitee = normalize_gitee_repo(gitee_repo)
    final_system_id = int(system_id) if system_id else None

    conn = db()
    try:
        if final_system_id:
            sys_row = conn.execute("SELECT gitee_repo FROM systems WHERE id = ?", (final_system_id,)).fetchone()
            if sys_row:
                final_gitee = normalize_gitee_repo(sys_row["gitee_repo"]) or final_gitee
        file_path = file_info["file_path"] if file_info else ""
        file_original = file_info["file_original_name"] if file_info else ""
        cur = conn.execute(
            """INSERT INTO requirements
               (system_id, title, description, project_number, gitee_repo, file_path, file_original_name)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (final_system_id, title, description or "", project_number or "", final_gitee, file_path, file_original),
        )
        conn.commit()
        send_json(h, 200, {"success": True, "data": {"id": cur.lastrowid}})
    except Exception as e:
        conn.rollback()
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def handle_dispatch(h):
    body = read_json(h)
    if body is None:
        return send_json(h, 400, {"success": False, "error": "Invalid JSON"})
    title = body.get("title")
    description = body.get("description")
    if not title or not description:
        return send_json(h, 400, {"success": False, "error": "title 和 description 为必填"})
    project_number = body.get("project_number") or ""
    system_id = body.get("system_id") or None

    conn = db()
    try:
        dup = conn.execute(
            "SELECT id FROM requirements WHERE title = ? AND status IN ('pending','running')", (title,)
        ).fetchone()
        if dup:
            return send_json(
                h, 409,
                {"success": False, "error": f"存在同名进行中的需求 #{dup['id']}，请先等它完成或换标题"},
            )

        final_gitee = ""
        final_system_id = int(system_id) if system_id else None
        if final_system_id:
            sys_row = conn.execute("SELECT gitee_repo FROM systems WHERE id = ?", (final_system_id,)).fetchone()
            if sys_row:
                final_gitee = normalize_gitee_repo(sys_row["gitee_repo"]) or final_gitee

        cur = conn.execute(
            "INSERT INTO requirements (system_id, title, description, project_number, gitee_repo) VALUES (?, ?, ?, ?, ?)",
            (final_system_id, title, description, project_number or "", final_gitee),
        )
        req_id = cur.lastrowid
        req_data = dict(conn.execute("SELECT * FROM requirements WHERE id = ?", (req_id,)).fetchone())

        cur2 = conn.execute(
            "INSERT INTO executions (requirement_id, status, logs, started_at) VALUES (?, 'pending', '[]', ?)",
            (req_id, now()),
        )
        exec_id = cur2.lastrowid
        conn.execute("UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?", ("running", now(), req_id))
        conn.execute("UPDATE executions SET status = 'running' WHERE id = ?", (exec_id,))
        append_log(conn, exec_id, {"level": "system", "message": f"📡 后端调度：任务「{title}」已接收，本地模拟执行（未集成 DSH 引擎）"})
        conn.commit()
    except Exception as e:
        conn.rollback()
        return send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()

    threading.Thread(target=run_execution_steps, args=(exec_id, req_data), daemon=True).start()
    send_json(h, 200, {
        "success": True,
        "data": {
            "requirement_id": req_id,
            "execution_id": exec_id,
            "mode": "simulate-fallback",
            "poll_url": f"/api/requirements/{req_id}/execution/progress",
        },
        "message": "已切换本地模拟执行（未集成 DSH 引擎）",
    })


def handle_execute(h, req_id, query):
    body = read_json(h)
    if body is None:
        return send_json(h, 400, {"success": False, "error": "Invalid JSON"})
    qmode = (query.get("mode") or [None])[0]
    mode = (body.get("mode") if body else None) or qmode

    conn = db()
    try:
        row = conn.execute("SELECT * FROM requirements WHERE id = ?", (req_id,)).fetchone()
        if not row:
            return send_json(h, 404, {"success": False, "error": "需求不存在"})
        req_data = dict(row)
        if req_data["status"] == "running":
            return send_json(h, 400, {"success": False, "error": "该需求正在执行中"})

        if mode == "dsh":
            cur = conn.execute(
                "INSERT INTO executions (requirement_id, status, logs, started_at) VALUES (?, 'pending', '[]', ?)",
                (req_id, now()),
            )
            exec_id = cur.lastrowid
            conn.execute("UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?", ("running", now(), req_id))
            conn.execute("UPDATE executions SET status = 'running' WHERE id = ?", (exec_id,))
            append_log(conn, exec_id, {"level": "warn", "message": "⚠️ 引擎拉起失败，自动切换本地模拟执行"})
            conn.commit()
            result_mode = "simulate-fallback"
            message = "引擎拉起失败，已切换本地模拟执行"
        else:
            cur = conn.execute(
                "INSERT INTO executions (requirement_id, status, logs, started_at) VALUES (?, 'running', '[]', ?)",
                (req_id, now()),
            )
            exec_id = cur.lastrowid
            conn.execute("UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?", ("running", now(), req_id))
            conn.commit()
            result_mode = "simulate"
            message = "需求执行已启动"
    except Exception as e:
        conn.rollback()
        return send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()

    threading.Thread(target=run_execution_steps, args=(exec_id, req_data), daemon=True).start()
    send_json(h, 200, {"success": True, "data": {"execution_id": exec_id, "mode": result_mode}, "message": message})


def handle_progress(h, req_id):
    conn = db()
    try:
        row = conn.execute(
            "SELECT id, status, logs, result_data, agent_teams_data FROM executions WHERE requirement_id = ? ORDER BY started_at DESC LIMIT 1",
            (req_id,),
        ).fetchone()
        if not row:
            return send_json(h, 200, {"success": True, "data": {"status": "none", "logs": []}})
        send_json(h, 200, {
            "success": True,
            "data": {
                "execution_id": row["id"],
                "status": row["status"],
                "logs": safe_parse(row["logs"], []),
                "result": safe_parse(row["result_data"], None),
                "agent_teams": safe_parse(row["agent_teams_data"], None),
            },
        })
    except Exception as e:
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def handle_execution_history(h, req_id):
    conn = db()
    try:
        rows = conn.execute(
            "SELECT * FROM executions WHERE requirement_id = ? ORDER BY started_at DESC", (req_id,)
        ).fetchall()
        send_json(h, 200, {"success": True, "data": [dict(r) for r in rows]})
    except Exception as e:
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def handle_get_execution(h, exec_id):
    conn = db()
    try:
        row = conn.execute("SELECT * FROM executions WHERE id = ?", (exec_id,)).fetchone()
        if not row:
            return send_json(h, 404, {"success": False, "error": "执行记录不存在"})
        data = dict(row)
        data["logs"] = safe_parse(data.get("logs"), [])
        data["result_data"] = safe_parse(data.get("result_data"), None)
        data["agent_teams_data"] = safe_parse(data.get("agent_teams_data"), None)
        send_json(h, 200, {"success": True, "data": data})
    except Exception as e:
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def handle_update_execution(h, exec_id):
    body = read_json(h)
    if body is None:
        return send_json(h, 400, {"success": False, "error": "Invalid JSON"})
    conn = db()
    try:
        row = conn.execute("SELECT * FROM executions WHERE id = ?", (exec_id,)).fetchone()
        if not row:
            return send_json(h, 404, {"success": False, "error": "执行记录不存在"})

        fields = []
        values = []
        if body.get("status"):
            fields.append("status = ?")
            values.append(body["status"])
        if "logs" in body:
            v = body["logs"]
            fields.append("logs = ?")
            values.append(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
        if "result_data" in body:
            v = body["result_data"]
            fields.append("result_data = ?")
            values.append(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
        if "agent_teams_data" in body:
            v = body["agent_teams_data"]
            fields.append("agent_teams_data = ?")
            values.append(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))

        status = body.get("status")
        if status in ("completed", "failed"):
            fields.append("completed_at = ?")
            values.append(now())
        if fields:
            conn.execute(f"UPDATE executions SET {', '.join(fields)} WHERE id = ?", (*values, exec_id))

        if status:
            req_status = "completed" if status == "completed" else ("failed" if status == "failed" else "running")
            conn.execute(
                "UPDATE requirements SET status = ?, updated_at = ? WHERE id = ?",
                (req_status, now(), row["requirement_id"]),
            )
        conn.commit()
        send_json(h, 200, {"success": True})
    except Exception as e:
        conn.rollback()
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def handle_delete_requirement(h, req_id):
    conn = db()
    try:
        row = conn.execute("SELECT file_path FROM requirements WHERE id = ?", (req_id,)).fetchone()
        if not row:
            return send_json(h, 404, {"success": False, "error": "需求不存在"})
        if row["file_path"]:
            try:
                if os.path.exists(row["file_path"]):
                    os.unlink(row["file_path"])
            except Exception:
                pass
        conn.execute("DELETE FROM executions WHERE requirement_id = ?", (req_id,))
        conn.execute("DELETE FROM requirements WHERE id = ?", (req_id,))
        conn.commit()
        send_json(h, 200, {"success": True})
    except Exception as e:
        conn.rollback()
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


# ──────────────────────────────────────────────────────────────
# 系统 handlers
# ──────────────────────────────────────────────────────────────
def handle_list_systems(h):
    conn = db()
    try:
        rows = conn.execute("SELECT * FROM systems ORDER BY name ASC").fetchall()
        send_json(h, 200, {"success": True, "data": [dict(r) for r in rows]})
    except Exception as e:
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def handle_get_system(h, sid):
    conn = db()
    try:
        row = conn.execute("SELECT * FROM systems WHERE id = ?", (sid,)).fetchone()
        if not row:
            return send_json(h, 404, {"success": False, "error": "系统不存在"})
        count = conn.execute("SELECT COUNT(*) AS c FROM requirements WHERE system_id = ?", (sid,)).fetchone()["c"]
        data = dict(row)
        data["requirement_count"] = count
        send_json(h, 200, {"success": True, "data": data})
    except Exception as e:
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def handle_create_system(h):
    body = read_json(h)
    if body is None:
        return send_json(h, 400, {"success": False, "error": "Invalid JSON"})
    name = body.get("name", "")
    if not name or not str(name).strip():
        return send_json(h, 400, {"success": False, "error": "系统名称不能为空"})
    gitee_repo = body.get("gitee_repo")
    description = body.get("description")
    conn = db()
    try:
        cur = conn.execute(
            "INSERT INTO systems (name, gitee_repo, description) VALUES (?, ?, ?)",
            (str(name).strip(), normalize_gitee_repo(gitee_repo), description or ""),
        )
        conn.commit()
        send_json(h, 200, {"success": True, "data": {"id": cur.lastrowid}})
    except Exception as e:
        conn.rollback()
        if is_unique_error(e):
            return send_json(h, 400, {"success": False, "error": "系统名称已存在"})
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def handle_update_system(h, sid):
    body = read_json(h)
    if body is None:
        return send_json(h, 400, {"success": False, "error": "Invalid JSON"})
    conn = db()
    try:
        existing = conn.execute("SELECT * FROM systems WHERE id = ?", (sid,)).fetchone()
        if not existing:
            return send_json(h, 404, {"success": False, "error": "系统不存在"})
        name = body.get("name") or existing["name"]
        gitee_repo = normalize_gitee_repo(body["gitee_repo"]) if "gitee_repo" in body else existing["gitee_repo"]
        description = body["description"] if "description" in body else existing["description"]
        conn.execute(
            "UPDATE systems SET name = ?, gitee_repo = ?, description = ?, updated_at = ? WHERE id = ?",
            (name, gitee_repo, description, now(), sid),
        )
        conn.commit()
        send_json(h, 200, {"success": True})
    except Exception as e:
        conn.rollback()
        if is_unique_error(e):
            return send_json(h, 400, {"success": False, "error": "系统名称已存在"})
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def handle_delete_system(h, sid):
    conn = db()
    try:
        existing = conn.execute("SELECT * FROM systems WHERE id = ?", (sid,)).fetchone()
        if not existing:
            return send_json(h, 404, {"success": False, "error": "系统不存在"})
        conn.execute("UPDATE requirements SET system_id = NULL WHERE system_id = ?", (sid,))
        conn.execute("DELETE FROM systems WHERE id = ?", (sid,))
        conn.commit()
        send_json(h, 200, {"success": True})
    except Exception as e:
        conn.rollback()
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


# ──────────────────────────────────────────────────────────────
# 路由
# ──────────────────────────────────────────────────────────────
def route_requirements(h, method, rel, query):
    if rel in ("", "/"):
        if method == "GET":
            return handle_list_requirements(h)
        if method == "POST":
            return handle_create_requirement(h)
        return send_json(h, 404, {"success": False, "error": "Not Found"})

    if rel == "/dispatch":
        if method == "POST":
            return handle_dispatch(h)
        return send_json(h, 404, {"success": False, "error": "Not Found"})

    m = re.fullmatch(r"/executions/(\d+)", rel)
    if m:
        exec_id = int(m.group(1))
        if method == "GET":
            return handle_get_execution(h, exec_id)
        if method == "PUT":
            return handle_update_execution(h, exec_id)
        return send_json(h, 404, {"success": False, "error": "Not Found"})

    m = re.fullmatch(r"/(\d+)/execution/progress", rel)
    if m and method == "GET":
        return handle_progress(h, int(m.group(1)))

    m = re.fullmatch(r"/(\d+)/execute", rel)
    if m and method == "POST":
        return handle_execute(h, int(m.group(1)), query)

    m = re.fullmatch(r"/(\d+)/executions", rel)
    if m and method == "GET":
        return handle_execution_history(h, int(m.group(1)))

    m = re.fullmatch(r"/(\d+)", rel)
    if m:
        req_id = int(m.group(1))
        if method == "GET":
            return handle_get_requirement(h, req_id)
        if method == "DELETE":
            return handle_delete_requirement(h, req_id)
        return send_json(h, 404, {"success": False, "error": "Not Found"})

    return send_json(h, 404, {"success": False, "error": "Not Found"})


def route_systems(h, method, rel):
    if rel in ("", "/"):
        if method == "GET":
            return handle_list_systems(h)
        if method == "POST":
            return handle_create_system(h)
        return send_json(h, 404, {"success": False, "error": "Not Found"})

    m = re.fullmatch(r"/(\d+)", rel)
    if m:
        sid = int(m.group(1))
        if method == "GET":
            return handle_get_system(h, sid)
        if method == "PUT":
            return handle_update_system(h, sid)
        if method == "DELETE":
            return handle_delete_system(h, sid)
        return send_json(h, 404, {"success": False, "error": "Not Found"})

    return send_json(h, 404, {"success": False, "error": "Not Found"})


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _dispatch(self):
        method = self.command
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == API_SYS or path.startswith(API_SYS + "/"):
            return route_systems(self, method, path[len(API_SYS):])
        if path == API_REQ or path.startswith(API_REQ + "/"):
            return route_requirements(self, method, path[len(API_REQ):], query)
        if path.startswith("/api/"):
            return send_json(self, 404, {"success": False, "error": "Not Found"})

        if method in ("GET", "HEAD"):
            return serve_static(self)
        return send_json(self, 404, {"success": False, "error": "Not Found"})

    def _safe(self):
        try:
            self._dispatch()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                send_json(self, 500, {"success": False, "error": str(e)})
            except Exception:
                pass

    def do_GET(self):
        self._safe()

    def do_HEAD(self):
        self._safe()

    def do_POST(self):
        self._safe()

    def do_PUT(self):
        self._safe()

    def do_DELETE(self):
        self._safe()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt, *args):  # 精简访问日志
        pass


# ──────────────────────────────────────────────────────────────
# 入口
# ──────────────────────────────────────────────────────────────
def main():
    init_db()
    port = int(os.environ.get("PORT") or 3002)
    httpd = ThreadingHTTPServer(("0.0.0.0", port), RequestHandler)
    httpd.daemon_threads = True
    print("=" * 60)
    print("需求管理系统已启动 (Python 版)")
    print(f"本地访问: http://localhost:{port}")
    print(f"API地址: http://localhost:{port}/api/requirements")
    print("=" * 60)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
