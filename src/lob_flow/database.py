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
    draft_snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT
);

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
