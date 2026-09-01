"""Add schedule misfire policy and last run reference."""

from alembic import op


revision = "0013_schedule_usability"
down_revision = "0012_schedule_triggers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE workflow_schedule_triggers
            ADD COLUMN misfire_policy TEXT NOT NULL DEFAULT 'skip',
            ADD COLUMN last_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE workflow_schedule_triggers
            DROP COLUMN last_run_id,
            DROP COLUMN misfire_policy;
    """)
