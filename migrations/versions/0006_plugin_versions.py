"""Immutable plugin versions."""

from alembic import op


revision = "0006_plugin_versions"
down_revision = "0005_dynamic_plugins"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE plugin_versions (
            plugin_id TEXT NOT NULL REFERENCES plugin_catalog(plugin_id) ON DELETE CASCADE,
            version TEXT NOT NULL,
            manifest_json TEXT NOT NULL,
            package_data BYTEA NOT NULL,
            package_sha256 TEXT NOT NULL,
            signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TEXT NOT NULL,
            PRIMARY KEY(plugin_id, version)
        );
        INSERT INTO plugin_versions
            (plugin_id, version, manifest_json, package_data, package_sha256,
             signature_verified, created_at)
        SELECT plugin_id, version, manifest_json, package_data, package_sha256,
               verified, COALESCE(updated_at, created_at)
        FROM plugin_catalog WHERE source = 'package' AND package_data IS NOT NULL;
    """)


def downgrade() -> None:
    op.execute("DROP TABLE plugin_versions")
