"""Remove legacy local identities from the production account system."""

from alembic import op


revision = "0021_remove_local_identities"
down_revision = "0020_account_invitations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        DELETE FROM users WHERE id IN (
            '91a75f7e-602d-4b18-acf7-7b3f3aa075fa',
            'cf6463cc-9956-40bd-a947-ec86538741a5'
        ) AND email IS NULL AND password_hash IS NULL;
        ALTER TABLE users ALTER COLUMN email SET NOT NULL;
        ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
        ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
    """)
