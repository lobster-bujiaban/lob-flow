"""Add Service API keys and workflow trigger source."""

from alembic import op

revision = "0010_service_api"
down_revision = "0009_app_types"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE service_api_keys (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            key_prefix TEXT NOT NULL,
            key_hash TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            last_used_at TEXT
        );
        ALTER TABLE workflow_runs ADD COLUMN trigger_source TEXT NOT NULL DEFAULT 'debug';
        CREATE INDEX service_api_keys_app_id_idx ON service_api_keys(app_id);
        CREATE INDEX workflow_runs_app_created_idx ON workflow_runs(app_id, created_at DESC);
    """)


def downgrade() -> None:
    op.execute("""
        DROP INDEX workflow_runs_app_created_idx;
        DROP INDEX service_api_keys_app_id_idx;
        ALTER TABLE workflow_runs DROP COLUMN trigger_source;
        DROP TABLE service_api_keys;
    """)
