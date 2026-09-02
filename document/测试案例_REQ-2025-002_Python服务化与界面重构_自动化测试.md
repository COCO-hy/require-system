# 测试案例 · REQ-2025-002 Python 服务化与界面重构 · 自动化测试（接口级）

> 运行前提：`python3 app.py` 已在 3001 端口启动（临时 DB）
> 执行器：`python3 smoke_test.py`（标准库，exit 0 = 全过）

## AC-01 静态托管与界面

| 用例 | 请求 | 预期 |
|---|---|---|
| 01 首页 | `GET /` | 200，HTML 含「需求管理」标识与新样式表引用 |
| 02 样式 | `GET /css/style.css` | 200，Content-Type 为 text/css |

## AC-02 系统 CRUD（Gitee 绑定）

| 用例 | 请求 | 预期 |
|---|---|---|
| 01 列表 | `GET /api/systems` | 200，data 为数组且含 seed 系统 |
| 02 创建 | `POST /api/systems {name, gitee_repo: URL}` | 200，gitee_repo 被规范化为 owner/repo |
| 03 重名 | `POST /api/systems {同名}` | 400 `系统名称已存在` |
| 04 更新 | `PUT /api/systems/:id` | 200，字段更新 |
| 05 删除 | `DELETE /api/systems/:id` | 200，关联需求 system_id 置 NULL |

## AC-03 需求 CRUD 与附件

| 用例 | 请求 | 预期 |
|---|---|---|
| 01 创建(JSON) | `POST /api/requirements {title...}` | 200，返回 id |
| 02 标题为空 | `POST /api/requirements {}` | 400 `需求标题不能为空` |
| 03 创建(multipart+附件) | `POST /api/requirements` multipart 含 .md 文件 | 200，uploads/ 落盘，file_original_name 正确 |
| 04 拒绝非法类型 | multipart 含 .exe | 400 `不支持的文件类型` |
| 05 系统联动仓库 | 带 system_id 创建（系统有仓库、需求未填） | gitee_repo 自动取系统仓库 |
| 06 列表 | `GET /api/requirements` | 200，含 system_name 联查 |
| 07 详情 | `GET /api/requirements/:id` | 200，字段完整 |
| 08 404 | `GET /api/requirements/999999` | 404 `需求不存在` |
| 09 删除级联 | `DELETE /api/requirements/:id` | 200，附件文件同步删除 |

## AC-04 纯净化裁剪（负向验证）

| 用例 | 请求 | 预期 |
|---|---|---|
| 01 execute 已移除 | `POST /api/requirements/:id/execute` | 404 |
| 02 dispatch 已移除 | `POST /api/requirements/dispatch` | 404 |
| 03 progress 已移除 | `GET /api/requirements/:id/execution/progress` | 404 |
| 04 executions 已移除 | `GET /api/requirements/executions/1` | 404 |

## AC-05 兼容与健壮性

| 用例 | 请求 | 预期 |
|---|---|---|
| 01 CORS 预检 | `OPTIONS /api/requirements` | 204 + Allow-Origin 头 |
| 02 非法 JSON | `POST /api/systems` body=`{bad` | 400 |
| 03 中文无乱码 | 创建含中文标题/描述 | 读写回显一致（UTF-8） |
