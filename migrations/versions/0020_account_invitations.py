"""Add invitation-only account registration."""

from alembic import op


revision = "0020_account_invitations"
down_revision = "0019_production_accounts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE account_invitations (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            is_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
            token_hash TEXT NOT NULL UNIQUE,
            invited_by TEXT NOT NULL REFERENCES users(id),
            expires_at TEXT NOT NULL,
            accepted_at TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX account_invitations_email_idx ON account_invitations(LOWER(email), created_at DESC);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE account_invitations")
