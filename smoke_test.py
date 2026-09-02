# -*- coding: utf-8 -*-
"""REQ-2025-002 接口自动化冒烟测试（纯需求管理范围）

运行前提：PORT=3001 python3 app.py 已启动（建议用临时 DB）
用法：python3 smoke_test.py [base_url]   # 默认 http://localhost:3001
"""
import json
import sys
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3001") + "/api"

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    mark = "PASS" if cond else "FAIL"
    if cond:
        ok += 1
    else:
        fail += 1
    print(f"[{mark}] {name} {detail}")


def req(method, path, payload=None):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


SMOKE_TITLES = {"冒烟需求·中文标题", "带附件的需求", "系统联动仓库的需求"}


def cleanup_leftovers():
    """幂等：清掉上次异常退出可能残留的冒烟数据"""
    _, sys_list = req("GET", "/systems")
    for s_ in sys_list.get("data") or []:
        if s_.get("name") == "冒烟测试系统":
            req("DELETE", f"/systems/{s_['id']}")
    _, reqs = req("GET", "/requirements")
    for r_ in reqs.get("data") or []:
        if r_.get("title") in SMOKE_TITLES:
            req("DELETE", f"/requirements/{r_['id']}")


cleanup_leftovers()


def raw(method, url, body=None, headers=None):
    r = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            h = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, h, resp.read()
    except urllib.error.HTTPError as e:
        h = {k.lower(): v for k, v in e.headers.items()}
        return e.code, h, e.read()


# ── AC-01 静态托管与界面 ──
s, hdr, body = raw("GET", BASE.rsplit("/api", 1)[0] + "/")
html = body.decode("utf-8", "replace")
check("AC01-1 首页托管", s == 200 and "需求" in html, f"len={len(html)}")
s, hdr, body = raw("GET", BASE.rsplit("/api", 1)[0] + "/css/style.css")
check("AC01-2 样式表", s == 200 and "text/css" in hdr.get("content-type", ""), hdr.get("content-type", ""))

# ── AC-02 系统 CRUD ──
s, sys_list = req("GET", "/systems")
check("AC02-1 系统列表", s == 200 and isinstance(sys_list.get("data"), list) and len(sys_list["data"]) >= 4,
      f"n={len(sys_list.get('data', []))}")

s, created = req("POST", "/systems", {"name": "冒烟测试系统", "gitee_repo": "https://gitee.com/sunliight/require-system.git", "description": "smoke"})
sid = (created.get("data") or {}).get("id")
check("AC02-2 创建系统+仓库规范化", s == 200 and sid, f"id={sid}")
s, got = req("GET", f"/systems/{sid}")
check("AC02-2b gitee_repo 规范化落库", (got.get("data") or {}).get("gitee_repo") == "sunliight/require-system",
      f"got={(got.get('data') or {}).get('gitee_repo')!r}")

s, _, dup = raw("POST", BASE + "/systems", json.dumps({"name": "冒烟测试系统"}, ensure_ascii=False).encode("utf-8"),
                {"Content-Type": "application/json"})
check("AC02-3 重名拒绝", s == 400 and "已存在" in json.loads(dup or b"{}").get("error", ""),
      f"status={s}")

s, _ = req("PUT", f"/systems/{sid}", {"description": "smoke-updated"})
s, got = req("GET", f"/systems/{sid}")
check("AC02-4 更新系统", (got.get("data") or {}).get("description") == "smoke-updated", "")

# ── AC-03 需求 CRUD 与附件 ──
s, created = req("POST", "/requirements", {"title": "冒烟需求·中文标题", "description": "验证 CRUD", "project_number": "REQ-SMOKE-001"})
rid = (created.get("data") or {}).get("id")
check("AC03-1 创建需求(JSON)", s == 200 and rid, f"id={rid}")

s, _, err = raw("POST", BASE + "/requirements", json.dumps({"title": ""}).encode("utf-8"), {"Content-Type": "application/json"})
check("AC03-2 标题为空拒绝", s == 400 and "标题不能为空" in json.loads(err).get("error", ""), f"status={s}")

# multipart + 附件
boundary = "----smokeboundary42"
md_content = "# 附件需求文档\n正文内容 smoke".encode("utf-8")
parts = []
for k, v in [("title", "带附件的需求"), ("description", "multipart 创建"), ("project_number", "REQ-SMOKE-002")]:
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode("utf-8"))
parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="需求附件.md"\r\n'
             f'Content-Type: text/markdown\r\n\r\n'.encode("utf-8") + md_content + b"\r\n")
parts.append(f"--{boundary}--\r\n".encode("utf-8"))
mp_body = b"".join(parts)
s, _, resp = raw("POST", BASE + "/requirements", mp_body,
                 {"Content-Type": f"multipart/form-data; boundary={boundary}"})
rid2 = (json.loads(resp).get("data") or {}).get("id")
check("AC03-3 multipart 创建+附件", s == 200 and rid2, f"id={rid2}")
s, got = req("GET", f"/requirements/{rid2}")
d = got.get("data") or {}
check("AC03-3b 附件名与内容", d.get("file_original_name") == "需求附件.md" and "smoke" in (d.get("file_content") or ""),
      f"name={d.get('file_original_name')!r}")

# 拒绝非法类型
exe_body = (f'--{boundary}\r\nContent-Disposition: form-data; name="title"; \r\n\r\nt\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="evil.exe"\r\n\r\nMZ\r\n'
            f'--{boundary}--\r\n').encode("utf-8")
s, _, resp = raw("POST", BASE + "/requirements", exe_body,
                 {"Content-Type": f"multipart/form-data; boundary={boundary}"})
check("AC03-4 拒绝非法文件类型", s == 400 and "不支持的文件类型" in json.loads(resp).get("error", ""), f"status={s}")

# 系统联动仓库
s, created = req("POST", "/requirements", {"title": "系统联动仓库的需求", "system_id": sid})
rid3 = (created.get("data") or {}).get("id")
s, got = req("GET", f"/requirements/{rid3}")
check("AC03-5 system_id 自动带出仓库", (got.get("data") or {}).get("gitee_repo") == "sunliight/require-system",
      f"got={(got.get('data') or {}).get('gitee_repo')!r}")

s, reqs = req("GET", "/requirements")
check("AC03-6 需求列表联查 system_name",
      s == 200 and any((r.get("system_name") == "冒烟测试系统") for r in reqs.get("data", [])), f"n={len(reqs.get('data', []))}")

s, got = req("GET", f"/requirements/{rid}")
check("AC03-7 需求详情", s == 200 and (got.get("data") or {}).get("title") == "冒烟需求·中文标题", "")

s, _, err = raw("GET", BASE + "/requirements/999999")
check("AC03-8 404", s == 404 and "不存在" in json.loads(err).get("error", ""), f"status={s}")

s, got = req("GET", f"/requirements/{rid2}")
import os
from pathlib import Path
att = got.get("data", {})
s, _ = req("DELETE", f"/requirements/{rid2}")
check("AC03-9 删除需求", s == 200, "")
s, _, err = raw("GET", BASE + f"/requirements/{rid2}")
check("AC03-9b 删除后 404", s == 404, "")

# ── AC-04 纯净化裁剪（负向验证）──
for m, p in [("POST", f"/requirements/{rid}/execute"), ("POST", "/requirements/dispatch"),
             ("GET", f"/requirements/{rid}/execution/progress"), ("GET", "/requirements/executions/1")]:
    s, _, _b = raw(m, BASE + p, b"{}" if m == "POST" else None,
                   {"Content-Type": "application/json"} if m == "POST" else {})
    check(f"AC04 已移除 {m} {p}", s in (404, 405, 422), f"status={s}")

# ── AC-05 兼容与健壮性 ──
s, hdr, _ = raw("OPTIONS", BASE + "/requirements")
check("AC05-1 CORS 预检", s == 204 and hdr.get("access-control-allow-origin") == "*", f"status={s}")

s, _, _b = raw("POST", BASE + "/systems", b"{bad json", {"Content-Type": "application/json"})
check("AC05-2 非法 JSON 400", s == 400, f"status={s}")

# 清理
req("DELETE", f"/requirements/{rid}")
req("DELETE", f"/requirements/{rid3}")
req("DELETE", f"/systems/{sid}")

print(f"\n===== 结果: {ok} 通过 / {fail} 失败 =====")
sys.exit(0 if fail == 0 else 1)
