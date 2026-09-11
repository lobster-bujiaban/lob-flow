English | [中文](README.cn.md)

# LOB Flow

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

**Status: research** — FastAPI + PostgreSQL workflow MVP. Not a Dify substitute. There is **no Redis** in `pyproject.toml`; the scheduler is an in-process `ScheduleWorker` (`src/lob_flow/schedule_service.py`).

CLI: `src/lob_flow/cli.py`.

## What

Workspace / app / draft / published version / run, DAG workflow, knowledge retrieval, tool plugins, service API keys, cron triggers, and RBAC — persisted in PostgreSQL schema `lob_flow`.

## Run in 3 commands

Python 3.12+, `uv`, PostgreSQL. `Database.from_env()` requires `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` (`.env` via python-dotenv).

```bash
uv sync
uv run lob-flow migrate
uv run lob-flow serve
```

`migrate` runs Alembic through `Database.initialize()`. **`serve` does not migrate**; it only `uvicorn.run(create_app())`. Default `127.0.0.1:8000`. Optional: `--host` / `--port`.

First DB role (idempotent):

```bash
psql -h <host> -U postgres -d postgres \
  -v app_password='<strong-password>' -f deploy/postgres-init.sql
```

Then `cp .env.example .env` and set the same password. Fernet key for provider secrets: `LOB_FLOW_ENCRYPTION_KEY`.

## Architecture

```text
lob-flow CLI / FastAPI (src/lob_flow/api.py)
  → AuthService, FlowService, WorkflowService, KnowledgeService, PluginService
  → ModelGateway / OpenAICompatibleProvider (src/lob_flow/provider.py)
  → PostgreSQL (psycopg pool, schema lob_flow)
  → optional DifyDaemonClient (src/lob_flow/dify_daemon.py)
```

`create_app` lifespan starts `ScheduleWorker` only. CORS allows `127.0.0.1:5173` for Vite.

### Workflow graph (`src/lob_flow/models.py`)

`NodeType`: `start` | `template` | `llm` | `knowledge` | `tool` | `condition` | `switch` | `answer`

`validate_and_sort` (`src/lob_flow/workflow.py`) requires exactly one `start` and at least one `answer`, unique ids, and DAG order. Knowledge `search_method`: `keyword_search` | `vector_search` | `hybrid_search`.

### Other CLI

```text
lob-flow create-admin <email> [--name ...]   # password via getpass; disaster-recovery
lob-flow create-workspace <name>
lob-flow create-app <workspace_id> <name>
lob-flow run <app_id> <input>
```

Signup is not public: first user hits `/api/auth/initialize`, then invites (`src/lob_flow/auth_service.py`). Apps fail with `provider_config_missing` until a workspace model config exists.

Static admin UI is served from `web/dist` if present (`npm install && npm run build` in `web/`). Dev: `web/` Vite on 5173.

## What this is not

- No agent-loop node in `NodeType`.
- No Redis / separate worker process: cron runs inside the API process.
- Plugin types beyond tools (Model / Agent Strategy / Datasource / Trigger) are not in this tree.

## License

Apache License 2.0. See [LICENSE](LICENSE).

## Contact

[chishishuan@gmail.com](mailto:chishishuan@gmail.com) · [GitHub Issues](https://github.com/lobster-bujiaban/lob-flow/issues)
