# -*- coding: utf-8 -*-
"""REQ-2025-002 UI 端到端测试（Playwright + 系统 Chrome，无头）

覆盖：列表渲染 / 新建需求（表单→详情）/ 详情图幅 / 检索 / 系统台账 / 删除 / 控制台零报错
运行前提：python3 app.py 已在 3001 端口启动
"""
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3001"
TITLE = f"E2E图纸_{int(time.time())}"

ok = fail = 0
console_errors = []


def check(name, cond, detail=""):
    global ok, fail
    mark = "PASS" if cond else "FAIL"
    if cond:
        ok += 1
    else:
        fail += 1
    print(f"[{mark}] {name} {detail}")


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

    # 1. 列表页
    page.goto(BASE, wait_until="networkidle")
    check("UI-1 页面标题", "图纸目录" in page.content() or "需求管理" in page.title() + page.content(), page.title())
    check("UI-2 统计条渲染", page.locator(".stats-strip .stat-cell").count() == 4)
    check("UI-3 新建按钮存在", page.locator("text=登记新图纸").count() >= 1)
    body_len = len(page.content())
    check("UI-4 样式已生效(非裸HTML)", page.evaluate("getComputedStyle(document.querySelector('.desk-bar')).position") == "sticky", "")

    # 2. 新建需求（含附件）
    page.click("text=登记新图纸")
    page.wait_for_selector("#modalOverlay.open", state="attached")
    page.fill("#title", TITLE)
    page.fill("#project_number", "REQ-E2E-9")
    page.fill("#description", "端到端测试用技术要求：验证表单提交与详情渲染。")
    page.set_input_files("#file", {
        "name": "e2e附件.md",
        "mimeType": "text/markdown",
        "buffer": b"# E2E\nattachment content",
    })
    check("UI-5 附件选中态", "picked" in (page.get_attribute("#fileLabel", "class") or ""))
    page.click("#createSubmitBtn")
    page.wait_for_selector(".detail-sheet", timeout=8000)
    check("UI-6 提交后跳详情", TITLE in page.locator(".detail-title").inner_text())
    check("UI-7 图幅标题块", page.locator(".detail-titleblock .tb-cell").count() == 6)
    check("UI-8 附件名显示", "e2e附件.md" in page.content())
    check("UI-9 附件内容预览", "attachment content" in page.content())

    # 3. 返回列表 → 新卡片可见
    page.click("text=返回图纸目录")
    page.wait_for_selector(".req-card", timeout=8000)
    check("UI-10 列表出现新卡片", TITLE in page.content())
    n_cards = page.locator(".req-card").count()

    # 4. 检索
    page.fill("#searchInput", TITLE)
    page.wait_for_timeout(600)
    check("UI-11 检索命中1张", page.locator(".req-card").count() == 1, f"n={page.locator('.req-card').count()}")
    page.fill("#searchInput", "绝不存在的关键词xyz123")
    page.wait_for_timeout(600)
    check("UI-12 无结果空态", page.locator(".empty-state").count() == 1)
    page.fill("#searchInput", "")
    page.wait_for_timeout(600)

    # 5. 系统台账
    page.click(".desk-actions >> text=系统台账")
    page.wait_for_selector(".ledger-table", timeout=8000)
    check("UI-13 台账表格", page.locator(".ledger-table tbody tr").count() >= 4)
    page.click("#systemModalOverlay .modal-close")

    # 6. Escape 关闭台账（兼容弹层可能已不在的竞态）
    try:
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
    except Exception:
        pass
    browser.close()

# 重新打开处理删除（进详情页 → 接受 confirm → 作废）
with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page()
    page.goto(BASE, wait_until="networkidle")
    page.fill("#searchInput", TITLE)
    page.wait_for_timeout(600)
    if page.locator(".req-card").count() == 1:
        page.click(".req-card")                       # 进详情
        page.wait_for_selector(".detail-sheet", timeout=8000)
        page.once("dialog", lambda d: d.accept())
        page.click("text=作废并归档")
        page.wait_for_timeout(1200)
        check("UI-14 删除后列表消失", page.locator(".req-card").count() == 0)
    else:
        check("UI-14 删除后列表消失", False, "卡片未找到，删除流程未执行")
    browser.close()

check("UI-15 控制台零报错", not [e for e in console_errors if "404" not in e], "; ".join(console_errors[:3]))

print(f"\n===== 结果: {ok} 通过 / {fail} 失败 =====")
sys.exit(0 if fail == 0 else 1)
