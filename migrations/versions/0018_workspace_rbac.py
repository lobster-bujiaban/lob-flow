"""Add management identities and workspace RBAC."""

from alembic import op


revision = "0018_workspace_rbac"
down_revision = "0017_cancellation_idempotency"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE user_sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            last_used_at TEXT
        );
        CREATE INDEX user_sessions_user_idx ON user_sessions(user_id);
        CREATE TABLE workspace_members (
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(workspace_id, user_id)
        );
        CREATE INDEX workspace_members_user_idx ON workspace_members(user_id, workspace_id);
    """)


def downgrade() -> None:
    op.execute("""
        DROP TABLE workspace_members;
        DROP TABLE user_sessions;
        DROP TABLE users;
    """)
