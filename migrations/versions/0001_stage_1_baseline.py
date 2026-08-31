"""Stage 1 baseline."""

from alembic import op


revision = "0001_stage_1"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS apps (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id),
            name TEXT NOT NULL, description TEXT NOT NULL, draft_json TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_provider_configs (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            provider TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL,
            api_key_encrypted TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS published_versions (
            id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id),
            version INTEGER NOT NULL, definition_json TEXT NOT NULL, created_at TEXT NOT NULL,
            UNIQUE(app_id, version)
        );
        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id),
            status TEXT NOT NULL, input TEXT NOT NULL, output TEXT, error TEXT,
            error_code TEXT, model_provider TEXT NOT NULL, model TEXT NOT NULL,
            prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER,
            finish_reason TEXT, duration_ms INTEGER, draft_snapshot_json TEXT NOT NULL,
            created_at TEXT NOT NULL, finished_at TEXT
        );
        CREATE TABLE IF NOT EXISTS run_events (
            run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER NOT NULL,
            type TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY(run_id, sequence)
        );
    """)


def downgrade() -> None:
    pass
