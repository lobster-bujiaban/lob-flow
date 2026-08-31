"""Add Dify-style knowledge base entities."""

from alembic import op


revision = "0008_knowledge_base"
down_revision = "0007_dify_daemon"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE datasets (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            icon TEXT NOT NULL DEFAULT '📖',
            indexing_technique TEXT NOT NULL DEFAULT 'high_quality',
            search_method TEXT NOT NULL DEFAULT 'hybrid_search',
            top_k INTEGER NOT NULL DEFAULT 3,
            score_threshold DOUBLE PRECISION NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX datasets_workspace_idx ON datasets(workspace_id, updated_at DESC);

        CREATE TABLE dataset_documents (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'ready',
            word_count INTEGER NOT NULL DEFAULT 0,
            segment_count INTEGER NOT NULL DEFAULT 0,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX dataset_documents_dataset_idx ON dataset_documents(dataset_id, created_at DESC);

        CREATE TABLE document_segments (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            document_id TEXT NOT NULL REFERENCES dataset_documents(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            content TEXT NOT NULL,
            word_count INTEGER NOT NULL DEFAULT 0,
            token_count INTEGER NOT NULL DEFAULT 0,
            keywords_json TEXT NOT NULL DEFAULT '[]',
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            hit_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(document_id, position)
        );
        CREATE INDEX document_segments_dataset_idx ON document_segments(dataset_id, enabled);
        CREATE INDEX document_segments_document_idx ON document_segments(document_id, position);

        CREATE TABLE dataset_queries (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            query TEXT NOT NULL,
            results_json TEXT NOT NULL,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE INDEX dataset_queries_dataset_idx ON dataset_queries(dataset_id, created_at DESC);
    """)


def downgrade() -> None:
    op.execute("""
        DROP TABLE IF EXISTS dataset_queries;
        DROP TABLE IF EXISTS document_segments;
        DROP TABLE IF EXISTS dataset_documents;
        DROP TABLE IF EXISTS datasets;
    """)
