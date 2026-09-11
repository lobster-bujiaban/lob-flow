"""Classify applications by runtime experience."""

from alembic import op


revision = "0009_app_types"
down_revision = "0008_knowledge_base"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE apps ADD COLUMN IF NOT EXISTS app_type TEXT NOT NULL DEFAULT 'chatflow';
        ALTER TABLE apps ADD CONSTRAINT apps_app_type_check
            CHECK (app_type IN ('workflow', 'chatflow', 'chat_assistant', 'agent', 'text_generation'));
        CREATE INDEX IF NOT EXISTS apps_workspace_type_idx ON apps(workspace_id, app_type, created_at);
    """)


def downgrade() -> None:
    op.execute("""
        DROP INDEX IF EXISTS apps_workspace_type_idx;
        ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_app_type_check;
        ALTER TABLE apps DROP COLUMN IF EXISTS app_type;
    """)
