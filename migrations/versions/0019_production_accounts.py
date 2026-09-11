"""Add production accounts, expiring sessions and platform administrators."""

from alembic import op


revision = "0019_production_accounts"
down_revision = "0018_workspace_rbac"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE users ADD COLUMN email TEXT;
        ALTER TABLE users ADD COLUMN password_hash TEXT;
        ALTER TABLE users ADD COLUMN is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'disabled'));
        CREATE UNIQUE INDEX users_email_unique_idx ON users(LOWER(email)) WHERE email IS NOT NULL;
        ALTER TABLE user_sessions ADD COLUMN expires_at TEXT;
        UPDATE user_sessions SET expires_at = created_at WHERE expires_at IS NULL;
        ALTER TABLE user_sessions ALTER COLUMN expires_at SET NOT NULL;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE user_sessions DROP COLUMN expires_at;
        DROP INDEX users_email_unique_idx;
        ALTER TABLE users DROP COLUMN status;
        ALTER TABLE users DROP COLUMN is_super_admin;
        ALTER TABLE users DROP COLUMN password_hash;
        ALTER TABLE users DROP COLUMN email;
    """)
