"""Persist structured workflow outputs."""

from alembic import op


revision = "0015_structured_outputs"
down_revision = "0014_structured_inputs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE workflow_runs ADD COLUMN outputs_json TEXT NOT NULL DEFAULT '{}'")


def downgrade() -> None:
    op.execute("ALTER TABLE workflow_runs DROP COLUMN outputs_json")
