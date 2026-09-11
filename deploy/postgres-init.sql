-- 使用 PostgreSQL 管理员账号执行，例如：
-- psql -h <host> -U postgres -d postgres \
--   -v app_password='<strong-password>' -f deploy/postgres-init.sql
\set ON_ERROR_STOP on

\if :{?app_password}
\else
\echo '缺少 app_password，请通过 -v app_password=... 传入数据库密码。'
\quit 1
\endif

SELECT format(
    'CREATE ROLE lob_flow LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
    :'app_password'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lob_flow')\gexec

SELECT format(
    'ALTER ROLE lob_flow WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
    :'app_password'
)\gexec

SELECT 'CREATE DATABASE lob_flow OWNER lob_flow ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'lob_flow')\gexec

\connect lob_flow

REVOKE ALL ON DATABASE lob_flow FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE lob_flow TO lob_flow;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO lob_flow;

-- 业务 Schema 和表由 `uv run lob-flow migrate` 创建。
