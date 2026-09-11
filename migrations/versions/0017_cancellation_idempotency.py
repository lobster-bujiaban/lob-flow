"""Add workflow cancellation and API idempotency support."""

from alembic import op


revision = "0017_cancellation_idempotency"
down_revision = "0016_node_reliability"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE workflow_runs ADD COLUMN idempotency_key TEXT;
        CREATE UNIQUE INDEX workflow_runs_app_idempotency_idx
            ON workflow_runs(app_id, idempotency_key)
            WHERE idempotency_key IS NOT NULL;
    """)


def downgrade() -> None:
    op.execute("""
        DROP INDEX workflow_runs_app_idempotency_idx;
        ALTER TABLE workflow_runs DROP COLUMN idempotency_key;
    """)
