"""Dynamic plugin packages and marketplace metadata."""

from alembic import op


revision = "0005_dynamic_plugins"
down_revision = "0004_plugins"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE plugin_catalog ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin';
        ALTER TABLE plugin_catalog ADD COLUMN package_data BYTEA;
        ALTER TABLE plugin_catalog ADD COLUMN package_sha256 TEXT;
        ALTER TABLE plugin_catalog ADD COLUMN updated_at TEXT;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE plugin_catalog DROP COLUMN updated_at;
        ALTER TABLE plugin_catalog DROP COLUMN package_sha256;
        ALTER TABLE plugin_catalog DROP COLUMN package_data;
        ALTER TABLE plugin_catalog DROP COLUMN source;
    """)
