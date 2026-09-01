"""Secure plugin credentials and immutable workflow releases."""

from alembic import op

revision = "0011_production_workflows"
down_revision = "0010_service_api"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE plugin_credentials (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            plugin_id TEXT NOT NULL,
            name TEXT NOT NULL,
            credentials_encrypted TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX plugin_credentials_workspace_plugin_idx ON plugin_credentials(workspace_id, plugin_id);
        CREATE TABLE plugin_runtime_states (
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            plugin_id TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(workspace_id, plugin_id)
        );
        CREATE TABLE workflow_versions (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            definition_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(app_id, version)
        );
        ALTER TABLE workflow_runs ADD COLUMN workflow_version_id TEXT REFERENCES workflow_versions(id);
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE workflow_runs DROP COLUMN workflow_version_id;
        DROP TABLE workflow_versions;
        DROP TABLE plugin_runtime_states;
        DROP TABLE plugin_credentials;
    """)
