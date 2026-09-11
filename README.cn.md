[English](README.md) | 中文

# LOB Flow

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

**状态：研究** — FastAPI + PostgreSQL 的工作流 MVP。不是 Dify 替代品。`pyproject.toml` **没有 Redis**；调度是进程内 `ScheduleWorker`（`src/lob_flow/schedule_service.py`）。

CLI：`src/lob_flow/cli.py`。

## What

Workspace / App / 草稿 / 发布版本 / Run、DAG 工作流、知识检索、工具插件、服务 API Key、cron、RBAC。数据在 PostgreSQL schema `lob_flow`。

## Run in 3 commands

Python 3.12+、`uv`、PostgreSQL。`Database.from_env()` 需要 `PGHOST`、`PGDATABASE`、`PGUSER`、`PGPASSWORD`（python-dotenv 读 `.env`）。

```bash
uv sync
uv run lob-flow migrate
uv run lob-flow serve
```

`migrate` 经 `Database.initialize()` 跑 Alembic。**`serve` 不迁移**，只 `uvicorn.run(create_app())`。默认 `127.0.0.1:8000`。可选 `--host` / `--port`。

首次建库账号（可重复执行）：

```bash
psql -h <host> -U postgres -d postgres \
  -v app_password='<strong-password>' -f deploy/postgres-init.sql
```

然后 `cp .env.example .env`，写入同一密码。供应商密钥加密：`LOB_FLOW_ENCRYPTION_KEY`。

## Architecture

```text
lob-flow CLI / FastAPI (src/lob_flow/api.py)
  → AuthService, FlowService, WorkflowService, KnowledgeService, PluginService
  → ModelGateway / OpenAICompatibleProvider (src/lob_flow/provider.py)
  → PostgreSQL (psycopg 连接池, schema lob_flow)
  → 可选 DifyDaemonClient (src/lob_flow/dify_daemon.py)
```

`create_app` 的 lifespan 只启动 `ScheduleWorker`。CORS 允许 Vite 的 `127.0.0.1:5173`。

### 工作流图（`src/lob_flow/models.py`）

`NodeType`：`start` | `template` | `llm` | `knowledge` | `tool` | `condition` | `switch` | `answer`

`validate_and_sort`（`src/lob_flow/workflow.py`）要求恰好一个 `start`、至少一个 `answer`、节点 id 唯一、DAG 可排序。知识节点 `search_method`：`keyword_search` | `vector_search` | `hybrid_search`。

### 其他 CLI

```text
lob-flow create-admin <email> [--name ...]   # getpass 输密码；灾备入口
lob-flow create-workspace <name>
lob-flow create-app <workspace_id> <name>
lob-flow run <app_id> <input>
```

不开放注册：首位用户走 `/api/auth/initialize`，之后靠邀请（`src/lob_flow/auth_service.py`）。没有 Workspace 级模型配置时，运行失败为 `provider_config_missing`。

管理端静态资源来自已构建的 `web/dist`（在 `web/` 执行 `npm install && npm run build`）。开发：`web/` Vite 5173。

## 代码里没有的东西

- `NodeType` 没有 agent-loop 节点。
- 没有 Redis、没有独立 worker：cron 跑在 API 进程里。
- 除 Tool 以外的插件类型（Model / Agent Strategy / Datasource / Trigger）不在本仓库。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。

## 联系

[chishishuan@gmail.com](mailto:chishishuan@gmail.com) · [GitHub Issues](https://github.com/lobster-bujiaban/lob-flow/issues)
