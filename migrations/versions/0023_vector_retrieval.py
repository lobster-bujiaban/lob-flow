"""Add embeddings and metadata-filtered retrieval."""

from alembic import op


revision = "0023_vector_retrieval"
down_revision = "0022_seed_builtin_plugins"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE datasets
            ADD COLUMN embedding_model TEXT NOT NULL DEFAULT 'lob-hash-embedding-v1',
            ADD COLUMN embedding_dimension INTEGER NOT NULL DEFAULT 256,
            ADD COLUMN vector_weight DOUBLE PRECISION NOT NULL DEFAULT 0.7;

        ALTER TABLE dataset_documents
            ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

        ALTER TABLE document_segments
            ADD COLUMN embedding_json TEXT,
            ADD COLUMN embedding_model TEXT;

        ALTER TABLE dataset_queries
            ADD COLUMN search_method TEXT NOT NULL DEFAULT 'hybrid_search',
            ADD COLUMN metadata_filter_json TEXT NOT NULL DEFAULT '[]';

        CREATE INDEX dataset_documents_metadata_idx
            ON dataset_documents(dataset_id, metadata_json);
    """)


def downgrade() -> None:
    op.execute("""
        DROP INDEX IF EXISTS dataset_documents_metadata_idx;
        ALTER TABLE dataset_queries
            DROP COLUMN IF EXISTS metadata_filter_json,
            DROP COLUMN IF EXISTS search_method;
        ALTER TABLE document_segments
            DROP COLUMN IF EXISTS embedding_model,
            DROP COLUMN IF EXISTS embedding_json;
        ALTER TABLE dataset_documents DROP COLUMN IF EXISTS metadata_json;
        ALTER TABLE datasets
            DROP COLUMN IF EXISTS vector_weight,
            DROP COLUMN IF EXISTS embedding_dimension,
            DROP COLUMN IF EXISTS embedding_model;
    """)
