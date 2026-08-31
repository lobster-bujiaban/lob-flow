from __future__ import annotations

import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import psycopg
from alembic import command
from alembic.config import Config
from dotenv import load_dotenv
from psycopg.rows import dict_row


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
            raise RuntimeError(f"Missing PostgreSQL configuration: {', '.join(missing)}")
        return cls()

    def initialize(self) -> None:
        project_root = Path(__file__).resolve().parents[2]
        config = Config(project_root / "alembic.ini")
        config.set_main_option("script_location", str(project_root / "migrations"))
        with self.connect() as connection:
            existing = connection.execute("SELECT to_regclass('lob_flow.apps') AS name").fetchone()
            version = connection.execute(
                "SELECT to_regclass('lob_flow.alembic_version') AS name"
            ).fetchone()
        if existing["name"] and not version["name"]:
            command.stamp(config, "0001_stage_1")
        command.upgrade(config, "head")

    @contextmanager
    def connect(self) -> Iterator[psycopg.Connection]:
        last_error: psycopg.OperationalError | None = None
        connection = None
        for attempt in range(3):
            try:
                connection = psycopg.connect(
                    self.conninfo, row_factory=dict_row, connect_timeout=10
                )
                break
            except psycopg.OperationalError as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(0.5 * (attempt + 1))
        if connection is None:
            assert last_error is not None
            raise last_error
        try:
            connection.execute("CREATE SCHEMA IF NOT EXISTS lob_flow")
            connection.execute("SET search_path TO lob_flow")
            yield connection
            connection.commit()
        except Exception:
            if not connection.closed:
                connection.rollback()
            raise
        finally:
            connection.close()
