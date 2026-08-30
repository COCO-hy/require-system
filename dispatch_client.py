#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
需求系统 — Python API 客户端
调用后端「一个命令 → 引擎执行 → 自动闭环」的完整示例。

用法（命令行）：
    python dispatch_client.py "优化登录页配色" "分析 style.css 配色并给出 3 条优化建议"

也提供了 dispatch() / wait_for_result() 两个函数，供你自己的程序 import 使用：
    from dispatch_client import dispatch, wait_for_result

纯标准库实现，无需 pip 安装任何依赖。
"""

import json
import sys
import time
import urllib.request

BASE = "http://localhost:3001/api/requirements"


def _post(url: str, payload: dict) -> dict:
    """发送 JSON POST 请求（自动 UTF-8 编码，中文不会乱码）。"""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get(url: str) -> dict:
    """发送 GET 请求。"""
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def dispatch(title: str, description: str, project_number: str = "") -> dict:
    """
    ① 投递任务：一条调用 = 建需求 + 拉起 DSH 引擎执行。
    返回包含 requirement_id / execution_id / engine_pid / poll_url。
    """
    payload = {
        "title": title,
        "description": description,
        "project_number": project_number,
    }
    result = _post(f"{BASE}/dispatch", payload)
    if not result.get("success"):
        raise RuntimeError(f"投递失败: {result}")
    return result["data"]


def get_progress(requirement_id: int) -> dict:
    """② 查询执行进度：返回 status / logs / result / agent_teams。"""
    result = _get(f"{BASE}/{requirement_id}/execution/progress")
    return result.get("data", {})


def wait_for_result(requirement_id: int, timeout: int = 600, interval: int = 5):
    """
    ③ 阻塞等待执行完成（status 变为 completed / failed），
    期间实时打印每步日志。返回最终进度数据。
    """
    deadline = time.time() + timeout
    shown = 0  # 已打印的日志条数
    while time.time() < deadline:
        data = get_progress(requirement_id)
        status = data.get("status", "none")

        # 实时打印新增日志
        logs = data.get("logs", [])
        rich = [l for l in logs if l.get("level") and l.get("message")]
        for l in rich[shown:]:
            print(f"  [{l['level']:7}] {l['message']}")
        shown = len(rich)

        if status in ("completed", "failed"):
            return data
        print(f"  ... 执行中（{status}），{interval}s 后再查 ...")
        time.sleep(interval)

    raise TimeoutError(f"等待超时（{timeout}s）")


def main():
    if len(sys.argv) < 3:
        print('用法: python dispatch_client.py "任务标题" "任务描述" [项目号]')
        sys.exit(1)

    title = sys.argv[1]
    description = sys.argv[2]
    project_number = sys.argv[3] if len(sys.argv) > 3 else ""

    print(f"① 投递任务: {title}")
    data = dispatch(title, description, project_number)
    print(f"   需求 #{data['requirement_id']} / 执行 #{data['execution_id']}"
          f" / 引擎 PID {data.get('engine_pid')} / 模式 {data['mode']}")

    print("② 等待执行（实时日志）:")
    final = wait_for_result(data["requirement_id"])

    print(f"\n③ 执行结束: status = {final.get('status')}")
    result = final.get("result") or {}
    summary = result.get("execution_summary") if isinstance(result, dict) else None
    if summary:
        print(f"   执行报告: {summary}")


if __name__ == "__main__":
    main()
