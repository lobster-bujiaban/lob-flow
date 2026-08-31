"""Workflow draft and runtime tables."""

from alembic import op


revision = "0002_workflow"
down_revision = "0001_stage_1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE workflow_drafts (
            app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
            definition_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE workflow_runs (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES apps(id),
            status TEXT NOT NULL,
            input TEXT NOT NULL,
            output TEXT,
            error TEXT,
            error_code TEXT,
            definition_snapshot_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            finished_at TEXT,
            duration_ms INTEGER
        );
        CREATE TABLE node_runs (
            id TEXT PRIMARY KEY,
            workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
            node_id TEXT NOT NULL,
            node_type TEXT NOT NULL,
            status TEXT NOT NULL,
            input_json TEXT NOT NULL,
            output_json TEXT,
            error TEXT,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            duration_ms INTEGER,
            UNIQUE(workflow_run_id, node_id)
        );
        CREATE TABLE workflow_events (
            workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL,
            type TEXT NOT NULL,
            node_id TEXT,
            data_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(workflow_run_id, sequence)
        );
    """)


def downgrade() -> None:
    op.execute("DROP TABLE workflow_events, node_runs, workflow_runs, workflow_drafts")
