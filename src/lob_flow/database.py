from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Iterator

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row


SCHEMA = """
CREATE SCHEMA IF NOT EXISTS lob_flow;

SET search_path TO lob_flow;

CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    draft_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_provider_configs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

UPDATE apps AS app
SET draft_json = jsonb_set(
    jsonb_set(
        jsonb_set(app.draft_json::jsonb, '{model,provider}', '"openai_compatible"'),
        '{model,provider_config_id}',
        to_jsonb((
            SELECT config.id
            FROM model_provider_configs AS config
            WHERE config.workspace_id = app.workspace_id
            ORDER BY config.created_at
            LIMIT 1
        ))
    ),
    '{model,model}',
    '"gpt-5.4"'
)::text
WHERE app.draft_json::jsonb #>> '{model,provider}' = 'fake'
  AND EXISTS (
      SELECT 1 FROM model_provider_configs AS config
      WHERE config.workspace_id = app.workspace_id
  );

CREATE TABLE IF NOT EXISTS published_versions (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    version INTEGER NOT NULL,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(app_id, version)
);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    status TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT,
    error TEXT,
    error_code TEXT,
    model_provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    finish_reason TEXT,
    duration_ms INTEGER,
    draft_snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT
);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS model_provider TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS completion_tokens INTEGER;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS total_tokens INTEGER;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS finish_reason TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

UPDATE runs SET model_provider = 'openai_compatible' WHERE model_provider IS NULL;
UPDATE runs SET model = 'gpt-5.4' WHERE model IS NULL;

UPDATE runs AS run
SET draft_snapshot_json = jsonb_set(
        run.draft_snapshot_json::jsonb,
        '{model}',
        app.draft_json::jsonb -> 'model'
    )::text,
    model_provider = 'openai_compatible',
    model = 'gpt-5.4'
FROM apps AS app
WHERE run.app_id = app.id
  AND run.draft_snapshot_json::jsonb #>> '{model,provider}' = 'fake'
  AND app.draft_json::jsonb #>> '{model,provider}' = 'openai_compatible';

ALTER TABLE runs ALTER COLUMN model_provider SET NOT NULL;
ALTER TABLE runs ALTER COLUMN model SET NOT NULL;

CREATE TABLE IF NOT EXISTS run_events (
    run_id TEXT NOT NULL REFERENCES runs(id),
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(run_id, sequence)
);
"""


class Database:
    def __init__(self, conninfo: str = "") -> None:
        load_dotenv()
        self.conninfo = conninfo

    @classmethod
    def from_env(cls) -> "Database":
        required = ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"]
        load_dotenv()
        missing = [name for name in required if not os.getenv(name)]
        if missing:
            names = ", ".join(missing)
            raise RuntimeError(f"Missing PostgreSQL configuration: {names}")
        return cls()

    def initialize(self) -> None:
        with self.connect() as connection:
            connection.execute(SCHEMA)

    @contextmanager
    def connect(self) -> Iterator[psycopg.Connection]:
        connection = psycopg.connect(self.conninfo, row_factory=dict_row)
        try:
            connection.execute("CREATE SCHEMA IF NOT EXISTS lob_flow")
            connection.execute("SET search_path TO lob_flow")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
