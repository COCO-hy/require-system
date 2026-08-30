# -*- coding: utf-8 -*-
"""Python 版需求管理系统 冒烟测试"""
import json
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://localhost:3002/api"


def req(method, path, payload=None):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(r, timeout=15) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


ok = fail = 0
def check(name, cond, detail=""):
    global ok, fail
    mark = "PASS" if cond else "FAIL"
    if cond: ok += 1
    else: fail += 1
    print(f"[{mark}] {name} {detail}")


# 1. 静态首页
with urllib.request.urlopen("http://localhost:3002/", timeout=10) as r:
    html = r.read().decode("utf-8", "replace")
check("① 静态首页托管", "需求" in html or "<html" in html.lower(), f"len={len(html)}")

# 2. 系统列表
s, sys_list = req("GET", "/systems")
check("② GET /api/systems", s == 200 and isinstance(sys_list.get("data"), list), f"n={len(sys_list.get('data', []))}")

# 3. 需求列表（复用现有 DB）
s, reqs = req("GET", "/requirements")
n0 = len(reqs.get("data", []))
check("③ GET /api/requirements", s == 200 and isinstance(reqs.get("data"), list), f"n={n0}")

# 4. 建需求（中文 + gitee_repo 规范化）
s, created = req("POST", "/requirements", {
    "title": "Python版冒烟测试",
    "description": "验证 CRUD + 执行 + 日志读写闭环",
    "project_number": "PY001",
    "gitee_repo": "https://gitee.com/sunliight/require-system.git",
})
rid = (created.get("data") or {}).get("id")
check("④ POST /api/requirements", s in (200, 201) and rid, f"id={rid}")
if rid:
    s2, got = req("GET", f"/requirements/{rid}")
    d = (got.get("data") or {})
    check("⑤ gitee_repo 规范化", d.get("gitee_repo") == "sunliight/require-system",
          f"got={d.get('gitee_repo')!r}")

# 6. 执行 → 4 步模拟 + 日志
s, ex = req("POST", f"/requirements/{rid}/execute", {"mode": "dsh"})
eid = (ex.get("data") or {}).get("execution_id")
check("⑥ POST execute", s == 200 and eid, f"exec={eid} mode={(ex.get('data') or {}).get('mode')}")

# 7. 轮询 progress 到 completed
final = None
for _ in range(30):
    s, p = req("GET", f"/requirements/{rid}/execution/progress")
    final = p.get("data") or {}
    if final.get("status") in ("completed", "failed"):
        break
    time.sleep(1)
logs = final.get("logs") or []
check("⑦ progress completed", final.get("status") == "completed", f"status={final.get('status')}")
check("⑧ 日志逐步累积(≥4步)", len(logs) >= 4, f"n={len(logs)}")
print("    日志样例:", json.dumps(logs[:2], ensure_ascii=False)[:200])
check("⑨ result_data 有内容", bool(final.get("result")), str(final.get("result"))[:80])

# 8. 回写 PUT /executions/:id（契约：logs 为全量数组替换，与 Node 版一致）
s, before = req("GET", f"/requirements/executions/{eid}")
old_logs = (before.get("data") or {}).get("logs") or []
new_logs = old_logs + [{"level": "info", "message": "captain 冒烟回写验证", "timestamp": "2026-08-30 01:50:00"}]
s, w = req("PUT", f"/requirements/executions/{eid}", {"status": "completed", "logs": new_logs})
check("⑩ PUT 回写日志", s == 200 and w.get("success"), str(w)[:80])
s, p2 = req("GET", f"/requirements/executions/{eid}")
logs2 = (p2.get("data") or {}).get("logs") or []
check("⑪ 回写后日志可读", any("冒烟回写" in (l.get("message") or "") for l in logs2), f"n={len(logs2)}")

# 9. 清理测试需求
s, dele = req("DELETE", f"/requirements/{rid}")
check("⑫ DELETE 测试需求", s == 200, str(dele)[:60])

print(f"\n===== 结果: {ok} 通过 / {fail} 失败 =====")
