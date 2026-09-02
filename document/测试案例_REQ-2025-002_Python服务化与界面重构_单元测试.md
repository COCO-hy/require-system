# 测试案例 · REQ-2025-002 Python 服务化与界面重构 · 单元测试

> 被测对象：`app.py`（根目录，纯标准库）
> 框架：`python3 -m unittest discover tests`（标准库 unittest，零依赖）

## UC-01 normalize_gitee_repo 仓库地址规范化

| 用例 | 输入 | 预期 |
|---|---|---|
| 01 空值 | `''` / `None` / `'   '` | `''` |
| 02 HTTPS URL | `https://gitee.com/owner/repo` | `owner/repo` |
| 03 HTTPS+.git | `https://gitee.com/owner/repo.git` | `owner/repo` |
| 04 HTTP URL | `http://gitee.com/owner/repo` | `owner/repo` |
| 05 SSH | `git@gitee.com:owner/repo.git` | `owner/repo` |
| 06 短格式 | `owner/repo` / `owner/repo.git` | `owner/repo` |
| 07 带首尾斜杠 | `/owner/repo/` | `owner/repo` |

## UC-02 safe_parse 容错解析

| 用例 | 输入 | 预期 |
|---|---|---|
| 01 合法 JSON | `'{"a":1}'` | `{"a":1}` |
| 02 非法 JSON | `'not-json'` | 返回 fallback |
| 03 空值 | `''` / `None` | 返回 fallback |

## UC-03 init_db 幂等建库

| 用例 | 步骤 | 预期 |
|---|---|---|
| 01 建库 | 全新临时目录启动 | `systems` / `requirements` 表存在，seed 4 个默认系统 |
| 02 幂等 | 重复初始化 | 不报错、系统数仍为 4（不重复 seed） |

## UC-04 路由工具（path 归一化）

| 用例 | 输入 | 预期 |
|---|---|---|
| 01 静态路径 | `/css/style.css` | 命中 public 下真实文件 |
| 02 目录穿越 | `/../app.py` | 拒绝（404，不泄露源码） |
| 03 SPA 回退 | `/detail/3` | 返回 index.html |
