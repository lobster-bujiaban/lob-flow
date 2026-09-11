"""Persist structured workflow inputs."""

from alembic import op


revision = "0014_structured_inputs"
down_revision = "0013_schedule_usability"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE workflow_runs ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '{}'")


def downgrade() -> None:
    op.execute("ALTER TABLE workflow_runs DROP COLUMN inputs_json")
