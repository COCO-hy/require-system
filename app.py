#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
需求管理系统 — 纯 Python 服务（单文件，零第三方依赖）

最纯正的需求管理后端：需求 CRUD + 系统管理（Gitee 仓库绑定）+ 附件上传 + 静态前端托管。
不包含任何执行引擎 / DSH / AgentTeams 联动。

启动：python3 app.py   （PORT 环境变量，默认 3001）
"""

import json
import mimetypes
import os
import random
import re
import sqlite3
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

# ──────────────────────────────────────────────────────────────
# 路径（以脚本位置推导仓库根目录）
# ──────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent            # require-system/
DB_PATH = ROOT / "data" / "requirements.db"
PUBLIC_DIR = ROOT / "public"
UPLOAD_DIR = ROOT / "uploads"

API_REQ = "/api/requirements"
API_SYS = "/api/systems"

# 附件白名单
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
# Schema（systems + requirements；执行类表已随引擎一起移除）
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
"""

# 幂等补列（兼容历史库；executions 相关列不再维护）
ALTER_COLUMNS = [
    ("requirements", "system_id", "INTEGER DEFAULT NULL"),
]

SEED_SYSTEMS = [
    ("认证服务", "myteam/auth-service", "用户认证、权限管理相关"),
    ("数据看板", "myteam/dashboard", "数据可视化与报表系统"),
    ("支付中心", "myteam/payment", "支付流程、账单管理"),
    ("消息推送", "myteam/notification", "推送通知、消息队列服务"),
]


# ──────────────────────────────────────────────────────────────
# 基础工具
# ──────────────────────────────────────────────────────────────
def now():
    """UTC 'YYYY-MM-DD HH:MM:SS'（与 SQLite CURRENT_TIMESTAMP 一致）"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def safe_parse(text, fallback):
    if text is None:
        return fallback
    try:
        return json.loads(text)
    except Exception:
        return fallback


def normalize_gitee_repo(value):
    """URL / SSH / owner/repo / .git → owner/repo；空 → ''"""
    if not value:
        return ""
    repo = str(value).strip()
    if not repo:
        return ""
    if re.match(r"^git@[^:]+:[^/]+/", repo):            # SSH: git@gitee.com:owner/repo…
        repo = repo[repo.index(":") + 1:]
    elif re.match(r"^https?://", repo, re.IGNORECASE):  # URL：取 pathname
        try:
            repo = urlparse(repo).path
        except Exception:
            pass
    repo = re.sub(r"^/+|/+$", "", repo)                 # 去首尾斜杠
    repo = re.sub(r"\.git$", "", repo, flags=re.IGNORECASE)  # 去尾部 .git
    return repo.strip()


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def is_unique_error(err):
    return isinstance(err, sqlite3.IntegrityError) and "UNIQUE" in str(err).upper()


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


def resolve_public_path(raw_path):
    """静态路由解析：命中文件→Path；未命中但像页面路由→index.html；越界/不存在→None"""
    rel = unquote(urlparse(raw_path).path).lstrip("/") or "index.html"
    target = (PUBLIC_DIR / rel).resolve()
    if not str(target).startswith(str(PUBLIC_DIR.resolve())):
        return None
    if target.is_file():
        return target
    if "." not in target.name:            # 无扩展名 → 前端路由（SPA 回退）
        index = PUBLIC_DIR / "index.html"
        if index.is_file():
            return index
    return None


def serve_static(handler):
    target = resolve_public_path(handler.path)
    if target is None:
        handler.send_error(404)
        return
    ext = target.suffix.lower()
    ctype = MIME.get(ext) or mimetypes.guess_type(str(target))[0] or "application/octet-stream"
    try:
        data = target.read_bytes()
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


# ──────────────────────────────────────────────────────────────
# 需求 handlers
# ──────────────────────────────────────────────────────────────
def handle_list_requirements(h):
    conn = db()
    try:
        rows = conn.execute(
            """SELECT r.id, r.title, r.description, r.project_number, r.gitee_repo,
                      r.file_path, r.file_original_name, r.status,
                      r.created_at, r.updated_at,
                      r.system_id, s.name AS system_name
               FROM requirements r
               LEFT JOIN systems s ON r.system_id = s.id
               ORDER BY r.created_at DESC, r.id DESC"""
        ).fetchall()
        send_json(h, 200, {"success": True, "data": [dict(r) for r in rows]})
    except Exception as e:
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def _get_requirement(conn, req_id):
    row = conn.execute(
        """SELECT r.*, s.name AS system_name
           FROM requirements r
           LEFT JOIN systems s ON r.system_id = s.id
           WHERE r.id = ?""",
        (req_id,),
    ).fetchone()
    return dict(row) if row else None


def handle_get_requirement(h, req_id):
    conn = db()
    try:
        data = _get_requirement(conn, req_id)
        if not data:
            send_json(h, 404, {"success": False, "error": "需求不存在"})
            return
        # 附件内容预览（文本类直接读；二进制不读）
        content = None
        if data.get("file_path") and os.path.exists(data["file_path"]):
            if os.path.splitext(data["file_path"])[1].lower() in {".md", ".txt", ".json", ".yaml", ".yml", ".csv"}:
                try:
                    with open(data["file_path"], "r", encoding="utf-8") as f:
                        content = f.read(64 * 1024)
                except Exception:
                    content = None
        data["file_content"] = content
        data.pop("file_path", None)      # 不泄露服务器绝对路径
        send_json(h, 200, {"success": True, "data": data})
    except Exception as e:
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def _apply_system_repo(conn, body_fields):
    """system_id 存在且系统配了仓库、而需求未显式填仓库时，自动取系统仓库"""
    system_id = body_fields.get("system_id")
    final_system = int(system_id) if str(system_id or "").strip().isdigit() else None
    final_repo = normalize_gitee_repo(body_fields.get("gitee_repo"))
    if final_system:
        row = conn.execute("SELECT gitee_repo FROM systems WHERE id = ?", (final_system,)).fetchone()
        if row:
            final_repo = normalize_gitee_repo(row["gitee_repo"]) or final_repo
    return final_system, final_repo


def handle_create_requirement(h, body=None, multipart_file=None):
    """body 为 JSON dict（普通创建）或 multipart fields（含附件创建）"""
    conn = db()
    try:
        if body is None:
            body = {}
        title = str(body.get("title") or "").strip()
        if not title:
            send_json(h, 400, {"success": False, "error": "需求标题不能为空"})
            return
        final_system, final_repo = _apply_system_repo(conn, body)
        file_path = multipart_file["file_path"] if multipart_file else ""
        file_name = multipart_file["file_original_name"] if multipart_file else ""
        cur = conn.execute(
            """INSERT INTO requirements
               (system_id, title, description, project_number, gitee_repo, file_path, file_original_name)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (final_system, title, str(body.get("description") or ""),
             str(body.get("project_number") or ""), final_repo, file_path, file_name),
        )
        conn.commit()
        send_json(h, 200, {"success": True, "data": {"id": cur.lastrowid}})
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
            send_json(h, 404, {"success": False, "error": "需求不存在"})
            return
        if row["file_path"]:
            try:
                p = Path(row["file_path"]).resolve()
                if p.exists() and p.parent == UPLOAD_DIR.resolve():
                    p.unlink()
            except Exception:
                pass
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
            send_json(h, 404, {"success": False, "error": "系统不存在"})
            return
        data = dict(row)
        data["requirement_count"] = conn.execute(
            "SELECT COUNT(*) AS c FROM requirements WHERE system_id = ?", (sid,)
        ).fetchone()["c"]
        send_json(h, 200, {"success": True, "data": data})
    except Exception as e:
        send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def handle_create_system(h):
    body = read_json(h)
    if body is None:
        send_json(h, 400, {"success": False, "error": "Invalid JSON"})
        return
    name = str(body.get("name") or "").strip()
    if not name:
        send_json(h, 400, {"success": False, "error": "系统名称不能为空"})
        return
    repo = normalize_gitee_repo(body.get("gitee_repo"))
    conn = db()
    try:
        cur = conn.execute(
            "INSERT INTO systems (name, gitee_repo, description) VALUES (?, ?, ?)",
            (name, repo, str(body.get("description") or "")),
        )
        conn.commit()
        send_json(h, 200, {"success": True, "data": {"id": cur.lastrowid}})
    except Exception as e:
        conn.rollback()
        if is_unique_error(e):
            send_json(h, 400, {"success": False, "error": "系统名称已存在"})
        else:
            send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def handle_update_system(h, sid):
    body = read_json(h)
    if body is None:
        send_json(h, 400, {"success": False, "error": "Invalid JSON"})
        return
    conn = db()
    try:
        row = conn.execute("SELECT * FROM systems WHERE id = ?", (sid,)).fetchone()
        if not row:
            send_json(h, 404, {"success": False, "error": "系统不存在"})
            return
        name = str(body.get("name") or "").strip() or row["name"]
        repo = normalize_gitee_repo(body["gitee_repo"]) if body.get("gitee_repo") is not None else row["gitee_repo"]
        desc = str(body.get("description")) if body.get("description") is not None else row["description"]
        conn.execute(
            "UPDATE systems SET name = ?, gitee_repo = ?, description = ?, updated_at = ? WHERE id = ?",
            (name, repo, desc, now(), sid),
        )
        conn.commit()
        send_json(h, 200, {"success": True})
    except Exception as e:
        conn.rollback()
        if is_unique_error(e):
            send_json(h, 400, {"success": False, "error": "系统名称已存在"})
        else:
            send_json(h, 500, {"success": False, "error": str(e)})
    finally:
        conn.close()


def handle_delete_system(h, sid):
    conn = db()
    try:
        row = conn.execute("SELECT id FROM systems WHERE id = ?", (sid,)).fetchone()
        if not row:
            send_json(h, 404, {"success": False, "error": "系统不存在"})
            return
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
    seg = [s for s in rel.split("/") if s]
    if not seg:
        if method == "GET":
            return handle_list_requirements(h)
        if method == "POST":
            ctype = h.headers.get("Content-Type", "")
            if "multipart/form-data" in ctype:
                try:
                    fields, finfo = parse_multipart(h)
                except ValueError as e:
                    return send_json(h, 400, {"success": False, "error": str(e)})
                return handle_create_requirement(h, body=fields, multipart_file=finfo)
            body = read_json(h)
            if body is None:
                return send_json(h, 400, {"success": False, "error": "Invalid JSON"})
            return handle_create_requirement(h, body=body)
        return send_json(h, 405, {"success": False, "error": "Method Not Allowed"})

    if len(seg) == 1 and seg[0].isdigit():
        rid = int(seg[0])
        if method == "GET":
            return handle_get_requirement(h, rid)
        if method == "DELETE":
            return handle_delete_requirement(h, rid)
        return send_json(h, 405, {"success": False, "error": "Method Not Allowed"})

    return send_json(h, 404, {"success": False, "error": "not found"})


def route_systems(h, method, rel, query):
    seg = [s for s in rel.split("/") if s]
    if not seg:
        if method == "GET":
            return handle_list_systems(h)
        if method == "POST":
            return handle_create_system(h)
        return send_json(h, 405, {"success": False, "error": "Method Not Allowed"})
    if len(seg) == 1 and seg[0].isdigit():
        sid = int(seg[0])
        if method == "GET":
            return handle_get_system(h, sid)
        if method == "PUT":
            return handle_update_system(h, sid)
        if method == "DELETE":
            return handle_delete_system(h, sid)
    return send_json(h, 404, {"success": False, "error": "not found"})


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "ReqSystem/2.0"

    def _dispatch(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith(API_REQ):
                return route_requirements(self, self.command, path[len(API_REQ):], parsed.query)
            if path.startswith(API_SYS):
                tail = path[len(API_SYS):]
                if tail and not tail.startswith("/"):
                    return send_json(self, 404, {"success": False, "error": "not found"})
                return route_systems(self, self.command, tail.lstrip("/"), parsed.query)
            if self.command in ("GET", "HEAD"):
                return serve_static(self)
            return send_json(self, 404, {"success": False, "error": "not found"})
        except BrokenPipeError:
            pass
        except Exception as e:  # 兜底：任何未捕获异常都以 JSON 返回
            try:
                send_json(self, 500, {"success": False, "error": f"服务器内部错误: {e}"})
            except Exception:
                pass

    def do_GET(self):
        self._dispatch()

    def do_HEAD(self):
        self._dispatch()

    def do_POST(self):
        self._dispatch()

    def do_PUT(self):
        self._dispatch()

    def do_DELETE(self):
        self._dispatch()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, fmt, *args):  # 精简访问日志（仅 API）
        try:
            rendered = fmt % args
            if "/api/" in rendered:
                print(f"[{now()}] {self.address_string()} {rendered}")
        except Exception:
            pass


def main():
    init_db()
    port = int(os.environ.get("PORT") or 3001)
    srv = ThreadingHTTPServer(("0.0.0.0", port), RequestHandler)
    print(f"""
  ╔═══════════════════════════════════════════╗
  ║       需求管理系统（Python）已启动 🚀     ║
  ║                                           ║
  ║  本地访问: http://localhost:{port}        ║
  ║  API地址: http://localhost:{port}/api/requirements  ║
  ╚═══════════════════════════════════════════╝
  """)
    srv.serve_forever()


if __name__ == "__main__":
    main()
