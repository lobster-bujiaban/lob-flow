from __future__ import annotations

import os

from alembic import context
from dotenv import load_dotenv
from sqlalchemy import create_engine, pool
from sqlalchemy.engine import URL


load_dotenv()
config = context.config


def database_url() -> URL:
    return URL.create(
        "postgresql+psycopg",
        username=os.environ["PGUSER"],
        password=os.environ["PGPASSWORD"],
        host=os.environ["PGHOST"],
        port=int(os.getenv("PGPORT", "5432")),
        database=os.environ["PGDATABASE"],
        query={"sslmode": os.getenv("PGSSLMODE", "prefer")},
    )


def run_migrations_online() -> None:
    engine = create_engine(database_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        connection.exec_driver_sql("CREATE SCHEMA IF NOT EXISTS lob_flow")
        connection.commit()
        context.configure(
            connection=connection,
            target_metadata=None,
            version_table_schema="lob_flow",
        )
        with context.begin_transaction():
            connection.exec_driver_sql("SET search_path TO lob_flow")
            context.run_migrations()


run_migrations_online()
