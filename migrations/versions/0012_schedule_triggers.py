"""Add persistent workflow schedule triggers."""

from alembic import op


revision = "0012_schedule_triggers"
down_revision = "0011_production_workflows"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE workflow_schedule_triggers (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            cron TEXT NOT NULL,
            timezone TEXT NOT NULL,
            input TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT FALSE,
            last_triggered_at TEXT,
            next_trigger_at TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX workflow_schedule_due_idx
            ON workflow_schedule_triggers(enabled, next_trigger_at);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE workflow_schedule_triggers")
