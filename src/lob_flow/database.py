from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import psycopg
from alembic import command
from alembic.config import Config
from dotenv import load_dotenv
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolTimeout


class Database:
    def __init__(self, conninfo: str = "") -> None:
        load_dotenv()
        self.conninfo = conninfo
        self._pool: ConnectionPool | None = None
        self._pool_lock = threading.Lock()

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
        pool = self._get_pool()
        try:
            with pool.connection(timeout=10) as connection:
                yield connection
        except PoolTimeout as exc:
            raise psycopg.OperationalError("PostgreSQL 连接池暂时没有可用连接") from exc

    def close(self) -> None:
        with self._pool_lock:
            if self._pool is not None:
                self._pool.close()
                self._pool = None

    def _get_pool(self) -> ConnectionPool:
        if self._pool is not None:
            return self._pool
        with self._pool_lock:
            if self._pool is None:
                minimum = max(0, int(os.getenv("PGPOOL_MIN_SIZE", "2")))
                maximum = max(minimum or 1, int(os.getenv("PGPOOL_MAX_SIZE", "10")))
                self._pool = ConnectionPool(
                    conninfo=self.conninfo,
                    min_size=minimum,
                    max_size=maximum,
                    open=False,
                    timeout=10,
                    max_waiting=32,
                    max_idle=300,
                    max_lifetime=1800,
                    reconnect_timeout=30,
                    check=ConnectionPool.check_connection,
                    kwargs={
                        "row_factory": dict_row,
                        "application_name": "lob-flow",
                        "connect_timeout": 10,
                        "keepalives": 1,
                        "keepalives_idle": 15,
                        "keepalives_interval": 5,
                        "keepalives_count": 3,
                        "tcp_user_timeout": 15_000,
                        "options": "-c search_path=lob_flow -c idle_in_transaction_session_timeout=30000",
                    },
                )
                self._pool.open(wait=False)
            return self._pool
