#!/usr/bin/env python3
"""
需求管理系统 — FastAPI 版
启动：uvicorn app:app --reload --port 3001
"""

import json
import os
import random
import re
import sqlite3
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

# ── 路径 ──
ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "requirements.db"
PUBLIC_DIR = ROOT / "public"
UPLOAD_DIR = ROOT / "uploads"

ALLOWED_EXTS = {".md", ".txt", ".pdf", ".doc", ".docx", ".json", ".yaml", ".yml", ".csv"}
MAX_FILE_SIZE = 10 * 1024 * 1024

app = FastAPI(title="需求管理系统", version="2.0", docs_url="/docs")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def ok(data=None) -> dict:
    return {"success": True, "data": data}


def err(msg: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"success": False, "error": msg}, status_code=status)


def normalize_gitee_repo(value):
    if not value:
        return ""
    repo = str(value).strip()
    if not repo:
        return ""
    if re.match(r"^git@[^:]+:[^/]+/", repo):
        repo = repo[repo.index(":") + 1:]
    elif re.match(r"^https?://", repo, re.IGNORECASE):
        try:
            repo = urlparse(repo).path
        except Exception:
            pass
    repo = re.sub(r"^/+|/+$", "", repo)
    repo = re.sub(r"\.git$", "", repo, flags=re.IGNORECASE)
    return repo.strip()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ── 初始化 ──
def startup():
    os.makedirs(DB_PATH.parent, exist_ok=True)
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    conn = get_db()
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(
            """
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
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT DEFAULT ''
            );
            """
        )
        for table, column, decl in [("requirements", "system_id", "INTEGER DEFAULT NULL")]:
            cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
            if column not in cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        count = conn.execute("SELECT COUNT(*) AS c FROM systems").fetchone()[0]
        if count == 0:
            conn.executemany(
                "INSERT INTO systems (name, gitee_repo, description) VALUES (?, ?, ?)",
                [
                    ("认证服务", "myteam/auth-service", "用户认证、权限管理相关"),
                    ("数据看板", "myteam/dashboard", "数据可视化与报表系统"),
                    ("支付中心", "myteam/payment", "支付流程、账单管理"),
                    ("消息推送", "myteam/notification", "推送通知、消息队列服务"),
                ],
            )
        conn.commit()
    finally:
        conn.close()


# lifespan：服务启动时初始化 DB（替代弃用的 on_event）
@asynccontextmanager
async def lifespan(_app):
    startup()
    yield


app.router.lifespan_context = lifespan


# ── 请求模型 ──
class SystemBody(BaseModel):
    name: str = ""
    gitee_repo: str = ""
    description: str = ""


class RequirementBody(BaseModel):
    title: str = ""
    description: str = ""
    project_number: str = ""
    gitee_repo: str = ""
    system_id: str = ""


# ──────────────── 系统 CRUD ────────────────
@app.get("/api/systems")
def list_systems():
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM systems ORDER BY name ASC").fetchall()
        return ok([dict(r) for r in rows])
    finally:
        conn.close()


@app.get("/api/systems/{sid}")
def get_system(sid: int):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM systems WHERE id = ?", (sid,)).fetchone()
        if not row:
            return err("系统不存在", 404)
        data = dict(row)
        data["requirement_count"] = conn.execute(
            "SELECT COUNT(*) AS c FROM requirements WHERE system_id = ?", (sid,)
        ).fetchone()["c"]
        return ok(data)
    finally:
        conn.close()


@app.post("/api/systems")
def create_system(body: SystemBody):
    name = body.name.strip()
    if not name:
        return err("系统名称不能为空")
    repo = normalize_gitee_repo(body.gitee_repo)
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO systems (name, gitee_repo, description) VALUES (?, ?, ?)",
            (name, repo, body.description.strip()),
        )
        conn.commit()
        return ok({"id": cur.lastrowid})
    except sqlite3.IntegrityError:
        return err("系统名称已存在")
    finally:
        conn.close()


@app.put("/api/systems/{sid}")
def update_system(sid: int, body: SystemBody):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM systems WHERE id = ?", (sid,)).fetchone()
        if not row:
            return err("系统不存在", 404)
        new_name = body.name.strip() or row["name"]
        new_repo = normalize_gitee_repo(body.gitee_repo) if body.gitee_repo else row["gitee_repo"]
        new_desc = body.description if body.description else row["description"]
        conn.execute(
            "UPDATE systems SET name = ?, gitee_repo = ?, description = ?, updated_at = ? WHERE id = ?",
            (new_name, new_repo, new_desc, now(), sid),
        )
        conn.commit()
        return ok()
    except sqlite3.IntegrityError:
        return err("系统名称已存在")
    finally:
        conn.close()


@app.delete("/api/systems/{sid}")
def delete_system(sid: int):
    conn = get_db()
    try:
        if not conn.execute("SELECT id FROM systems WHERE id = ?", (sid,)).fetchone():
            return err("系统不存在", 404)
        conn.execute("UPDATE requirements SET system_id = NULL WHERE system_id = ?", (sid,))
        conn.execute("DELETE FROM systems WHERE id = ?", (sid,))
        conn.commit()
        return ok()
    finally:
        conn.close()


# ──────────────── 需求 CRUD ────────────────
@app.get("/api/requirements")
def list_requirements():
    conn = get_db()
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
        return ok([dict(r) for r in rows])
    finally:
        conn.close()


@app.get("/api/requirements/{rid}")
def get_requirement(rid: int):
    conn = get_db()
    try:
        row = conn.execute(
            """SELECT r.*, s.name AS system_name
               FROM requirements r
               LEFT JOIN systems s ON r.system_id = s.id
               WHERE r.id = ?""",
            (rid,),
        ).fetchone()
        if not row:
            return err("需求不存在", 404)
        data = dict(row)
        if data.get("file_path") and os.path.exists(data["file_path"]):
            ext = os.path.splitext(data["file_path"])[1].lower()
            if ext in {".md", ".txt", ".json", ".yaml", ".yml", ".csv"}:
                try:
                    with open(data["file_path"], encoding="utf-8") as f:
                        data["file_content"] = f.read(64 * 1024)
                except Exception:
                    data["file_content"] = None
            else:
                data["file_content"] = "[二进制文件，不纳入预览]"
        else:
            data["file_content"] = None
        data.pop("file_path", None)
        return ok(data)
    finally:
        conn.close()


@app.get("/api/requirements/{rid}/export")
def export_requirement(rid: int):
    """提取图纸数据——返回裸 JSON，供前端 console.log 或下游消费"""
    conn = get_db()
    try:
        row = conn.execute(
            """SELECT r.*, s.name AS system_name
               FROM requirements r
               LEFT JOIN systems s ON r.system_id = s.id
               WHERE r.id = ?""",
            (rid,),
        ).fetchone()
        if not row:
            return err("需求不存在", 404)
        data = dict(row)
        if data.get("file_path") and os.path.exists(data["file_path"]):
            ext = os.path.splitext(data["file_path"])[1].lower()
            if ext in {".md", ".txt", ".json", ".yaml", ".yml", ".csv"}:
                try:
                    with open(data["file_path"], encoding="utf-8") as f:
                        data["file_content"] = f.read(64 * 1024)
                except Exception:
                    data["file_content"] = None
            else:
                data["file_content"] = "[二进制文件，不纳入文本导出]"
        else:
            data["file_content"] = None
        data.pop("file_path", None)
        data.pop("system_id", None)
        data.pop("system_name", None)
        return data
    finally:
        conn.close()


# ──────────────── 中继：需求详情 → 下游接口 ────────────────
@app.get("/api/settings")
def get_settings():
    conn = get_db()
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return ok({r["key"]: r["value"] for r in rows})
    finally:
        conn.close()


@app.put("/api/settings")
def update_settings(body: dict):
    conn = get_db()
    try:
        for k, v in (body or {}).items():
            if not isinstance(k, str):
                continue
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (k, str(v)),
            )
        conn.commit()
        return ok()
    except Exception as e:
        conn.rollback()
        return err(str(e), 500)
    finally:
        conn.close()


@app.post("/api/requirements/{rid}/relay")
def relay_requirement(rid: int):
    """把需求完整数据 POST 到配置的中继目标地址，返回下游响应"""
    conn = get_db()
    try:
        # 1. 需求数据（复用 export 逻辑）——先校验资源存在
        rrow = conn.execute(
            """SELECT r.*, s.name AS system_name
               FROM requirements r
               LEFT JOIN systems s ON r.system_id = s.id
               WHERE r.id = ?""",
            (rid,),
        ).fetchone()
        if not rrow:
            return err("需求不存在", 404)
        data = dict(rrow)
        if data.get("file_path") and os.path.exists(data["file_path"]):
            ext = os.path.splitext(data["file_path"])[1].lower()
            if ext in {".md", ".txt", ".json", ".yaml", ".yml", ".csv"}:
                try:
                    with open(data["file_path"], encoding="utf-8") as f:
                        data["file_content"] = f.read(64 * 1024)
                except Exception:
                    data["file_content"] = None
            else:
                data["file_content"] = "[二进制文件，不纳入转发]"
        else:
            data["file_content"] = None
        data.pop("file_path", None)

        # 2. 目标地址
        row = conn.execute("SELECT value FROM settings WHERE key = 'relay_url'").fetchone()
        target = (row["value"] if row else "") or ""
    finally:
        conn.close()

    if not target.strip():
        return err("未配置中继目标地址：请先在「中继设置」里填写下游接口 URL", 400)

    # 3. 转发（连接已释放，避免长耗时占连接）
    payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        target.strip(),
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return ok({"status": resp.status, "body": resp.read().decode("utf-8", "replace")[:8192]})
    except urllib.error.HTTPError as e:
        # 下游返回非 2xx：仍是成功的中继，把下游状态与报文带回去
        return ok({"status": e.code, "body": e.read().decode("utf-8", "replace")[:8192]})
    except Exception as e:
        return err(f"中继失败：{e}", 502)


def _apply_system_repo(conn, system_id, gitee_repo):
    fid = int(system_id) if str(system_id or "").strip().isdigit() else None
    frepo = normalize_gitee_repo(gitee_repo)
    if fid:
        row = conn.execute("SELECT gitee_repo FROM systems WHERE id = ?", (fid,)).fetchone()
        if row:
            frepo = normalize_gitee_repo(row["gitee_repo"]) or frepo
    return fid, frepo


@app.post("/api/requirements")
async def create_requirement(request: Request, file: UploadFile = File(None)):
    """统一入口：JSON body 或 multipart/form-data 均可"""
    ctype = request.headers.get("content-type", "")
    if file or "multipart" in ctype:
        form = await request.form()
        title = str(form.get("title") or "").strip()
        desc = str(form.get("description") or "")
        pn = str(form.get("project_number") or "")
        gr = str(form.get("gitee_repo") or "")
        sid = str(form.get("system_id") or "")
        file_path = ""
        file_name = ""
        if file and file.filename:
            ext = os.path.splitext(file.filename)[1].lower()
            if ext not in ALLOWED_EXTS:
                return err("不支持的文件类型，请上传: " + ", ".join(sorted(ALLOWED_EXTS)))
            content = await file.read()
            if len(content) > MAX_FILE_SIZE:
                return err("文件大小超过 10MB 限制")
            unique = f"{int(time.time() * 1000)}-{random.randint(0, 999999999)}{ext}"
            dest = UPLOAD_DIR / unique
            dest.write_bytes(content)
            file_path = str(dest.resolve())
            file_name = file.filename
    else:
        body = await request.json()
        title = str(body.get("title") or "").strip()
        desc = str(body.get("description") or "")
        pn = str(body.get("project_number") or "")
        gr = str(body.get("gitee_repo") or "")
        sid = str(body.get("system_id") or "")
        file_path = ""
        file_name = ""

    if not title:
        return err("需求标题不能为空")
    conn = get_db()
    try:
        fid, frepo = _apply_system_repo(conn, sid, gr)
        cur = conn.execute(
            """INSERT INTO requirements
               (system_id, title, description, project_number, gitee_repo, file_path, file_original_name)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (fid, title, desc.strip(), pn.strip(), frepo, file_path, file_name),
        )
        conn.commit()
        return ok({"id": cur.lastrowid})
    except Exception as e:
        conn.rollback()
        return err(str(e), 500)
    finally:
        conn.close()


@app.delete("/api/requirements/{rid}")
def delete_requirement(rid: int):
    conn = get_db()
    try:
        row = conn.execute("SELECT file_path FROM requirements WHERE id = ?", (rid,)).fetchone()
        if not row:
            return err("需求不存在", 404)
        if row["file_path"]:
            try:
                p = Path(row["file_path"]).resolve()
                if p.exists() and p.parent == UPLOAD_DIR.resolve():
                    p.unlink()
            except Exception:
                pass
        conn.execute("DELETE FROM requirements WHERE id = ?", (rid,))
        conn.commit()
        return ok()
    finally:
        conn.close()


# ── 静态文件 + SPA fallback ──
@app.get("/")
def root():
    return FileResponse(PUBLIC_DIR / "index.html")


# 通配静态路由 / 404
@app.api_route("/{path:path}", methods=["GET", "HEAD", "OPTIONS"])
async def catch_all(path: str, request: Request):
    if request.method == "OPTIONS":
        return Response(status_code=204,
            headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
                     "Access-Control-Allow-Headers": "Content-Type"})
    if path.startswith("api/"):
        return err("not found", 404)
    target = (PUBLIC_DIR / path).resolve() if path else None
    if target and target.is_relative_to(PUBLIC_DIR.resolve()) and target.is_file():
        return FileResponse(target)
    return FileResponse(PUBLIC_DIR / "index.html")


# 422 → 400 统一为前端友好格式
@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    return JSONResponse({"success": False, "error": "Invalid JSON"}, status_code=400)


# ── 直接启动：python3 app.py ──
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT") or 3001)
    print(f"""
  ╔═══════════════════════════════════════════╗
  ║    需求管理系统（FastAPI）已启动 🚀      ║
  ║                                           ║
  ║  本地访问: http://localhost:{port}        ║
  ║  接口文档: http://localhost:{port}/docs   ║
  ╚═══════════════════════════════════════════╝
  """)
    uvicorn.run(app, host="0.0.0.0", port=port)