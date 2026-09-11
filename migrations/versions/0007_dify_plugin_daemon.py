"""Replace custom plugin packages with Dify Plugin Daemon metadata."""

from alembic import op


revision = "0007_dify_daemon"
down_revision = "0006_plugin_versions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        DROP TABLE IF EXISTS plugin_versions;
        ALTER TABLE plugin_catalog DROP COLUMN IF EXISTS package_data;
        ALTER TABLE plugin_catalog DROP COLUMN IF EXISTS package_sha256;
        ALTER TABLE plugin_catalog DROP COLUMN IF EXISTS updated_at;
        ALTER TABLE plugin_catalog DROP COLUMN IF EXISTS source;
        ALTER TABLE plugin_catalog ADD COLUMN IF NOT EXISTS
            plugin_unique_identifier TEXT;
        ALTER TABLE plugin_catalog ADD COLUMN IF NOT EXISTS
            provider_name TEXT;
        ALTER TABLE plugin_installations ADD COLUMN IF NOT EXISTS
            daemon_installation_id TEXT;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE plugin_installations DROP COLUMN IF EXISTS daemon_installation_id;
        ALTER TABLE plugin_catalog DROP COLUMN IF EXISTS provider_name;
        ALTER TABLE plugin_catalog DROP COLUMN IF EXISTS plugin_unique_identifier;
        ALTER TABLE plugin_catalog ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin';
        ALTER TABLE plugin_catalog ADD COLUMN package_data BYTEA;
        ALTER TABLE plugin_catalog ADD COLUMN package_sha256 TEXT;
        ALTER TABLE plugin_catalog ADD COLUMN updated_at TEXT;
    """)
