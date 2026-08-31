"""Cap existing workflow LLM output for interactive debugging."""

from alembic import op


revision = "0003_workflow_cap"
down_revision = "0002_workflow"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        UPDATE workflow_drafts
        SET definition_json = jsonb_set(
            definition_json::jsonb,
            '{nodes}',
            (
                SELECT jsonb_agg(
                    CASE
                        WHEN node ->> 'type' = 'llm'
                        THEN jsonb_set(node, '{config,max_tokens}', '512'::jsonb)
                        ELSE node
                    END
                    ORDER BY position
                )
                FROM jsonb_array_elements(definition_json::jsonb -> 'nodes')
                     WITH ORDINALITY AS item(node, position)
            )
        )::text
    """)


def downgrade() -> None:
    pass
