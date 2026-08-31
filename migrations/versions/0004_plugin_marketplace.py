"""Plugin marketplace and tool invocation audit."""

from alembic import op


revision = "0004_plugins"
down_revision = "0003_workflow_cap"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE plugin_catalog (
            plugin_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            author TEXT NOT NULL,
            version TEXT NOT NULL,
            category TEXT NOT NULL,
            description TEXT NOT NULL,
            icon TEXT NOT NULL,
            verified BOOLEAN NOT NULL DEFAULT FALSE,
            manifest_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE plugin_installations (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            plugin_id TEXT NOT NULL REFERENCES plugin_catalog(plugin_id),
            version TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            credentials_encrypted TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(workspace_id, plugin_id)
        );
        CREATE TABLE tool_invocations (
            id TEXT PRIMARY KEY,
            workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
            node_id TEXT NOT NULL,
            installation_id TEXT NOT NULL REFERENCES plugin_installations(id),
            plugin_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            status TEXT NOT NULL,
            input_json TEXT NOT NULL,
            output_json TEXT,
            error TEXT,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            duration_ms INTEGER
        );
    """)


def downgrade() -> None:
    op.execute("DROP TABLE tool_invocations, plugin_installations, plugin_catalog")
