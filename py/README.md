# 需求管理系统 — Python 版

用 Python 标准库（`sqlite3` + `http.server`）实现的需求管理系统后端，与 Node 版功能等价：
复用同一份 `../data/requirements.db` 数据与 `../public` 前端静态资源。

## 启动

```bash
cd py
python app.py
```

- 默认端口 **3002**（避免与 Node 版 3001 冲突）。
- 通过环境变量改端口：

```bash
# Windows
set PORT=3001 && python app.py

# Linux / macOS
PORT=3001 python app.py
```

- 打开 http://localhost:3002 使用前端界面。
- API 地址：http://localhost:3002/api/requirements

## 说明

- 零 pip 依赖：仅使用 Python 标准库（建议使用 conda base 的 Python）。
- 执行模式：本地模拟 4 步（解析需求 → Gitee → 数据源 → 报告），每步写一条日志，前端实时轮询展示。
- 详细设计见 [`DESIGN.md`](DESIGN.md)。
