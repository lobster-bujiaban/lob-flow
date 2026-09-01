"""Record node retry attempts."""

from alembic import op


revision = "0016_node_reliability"
down_revision = "0015_structured_outputs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE node_run_attempts (
            id TEXT PRIMARY KEY,
            workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
            node_id TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            status TEXT NOT NULL,
            error TEXT,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            duration_ms INTEGER,
            UNIQUE(workflow_run_id, node_id, attempt)
        );
        CREATE INDEX node_run_attempts_run_idx ON node_run_attempts(workflow_run_id, node_id);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE node_run_attempts")
