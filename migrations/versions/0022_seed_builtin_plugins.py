"""Seed the immutable built-in plugin catalog once."""

import json
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op


revision = "0022_seed_builtin_plugins"
down_revision = "0021_remove_local_identities"
branch_labels = None
depends_on = None


PLUGINS = (
    {
        "plugin_id": "lob/text-tools", "name": "Text Tools", "author": "lob", "version": "1.0.0",
        "category": "tool", "description": "文本大小写、裁剪与替换工具。", "icon": "Aa", "verified": True,
        "credential_schema": {},
        "tools": [
            {"name": "uppercase", "label": "转为大写", "description": "将输入文本转为大写。", "parameters": {"text": {"type": "string", "required": True}}},
            {"name": "lowercase", "label": "转为小写", "description": "将输入文本转为小写。", "parameters": {"text": {"type": "string", "required": True}}},
            {"name": "replace", "label": "文本替换", "description": "替换文本中的指定内容。", "parameters": {"text": {"type": "string", "required": True}, "old": {"type": "string", "required": True}, "new": {"type": "string", "required": False}}},
        ],
    },
    {
        "plugin_id": "lob/json-tools", "name": "JSON Tools", "author": "lob", "version": "1.0.0",
        "category": "tool", "description": "解析 JSON 并提取点路径字段。", "icon": "{}", "verified": True,
        "credential_schema": {},
        "tools": [{"name": "extract", "label": "提取 JSON 字段", "description": "按 user.profile.name 一类路径提取值。", "parameters": {"json": {"type": "string", "required": True}, "path": {"type": "string", "required": True}}}],
    },
    {
        "plugin_id": "lob/http-request", "name": "HTTP Request", "author": "lob", "version": "1.0.0",
        "category": "tool", "description": "向公网 HTTPS API 发起受限请求，默认阻止本机和私网地址。", "icon": "↗", "verified": True,
        "credential_schema": {"bearer_token": {"type": "secret", "required": False}},
        "tools": [{"name": "request", "label": "HTTP 请求", "description": "调用公网 HTTPS API。", "parameters": {"url": {"type": "string", "required": True}, "method": {"type": "string", "required": False}, "body": {"type": "string", "required": False}}}],
    },
)


def upgrade() -> None:
    statement = sa.text("""
        INSERT INTO plugin_catalog
            (plugin_id, name, author, version, category, description, icon, verified, manifest_json, created_at)
        VALUES
            (:plugin_id, :name, :author, :version, :category, :description, :icon, :verified, :manifest_json, :created_at)
        ON CONFLICT (plugin_id) DO UPDATE SET
            name = EXCLUDED.name, author = EXCLUDED.author, version = EXCLUDED.version,
            category = EXCLUDED.category, description = EXCLUDED.description, icon = EXCLUDED.icon,
            verified = EXCLUDED.verified, manifest_json = EXCLUDED.manifest_json
    """)
    created_at = datetime.now(UTC).isoformat()
    connection = op.get_bind()
    for plugin in PLUGINS:
        connection.execute(statement, {**plugin, "manifest_json": json.dumps(plugin, ensure_ascii=False), "created_at": created_at})


def downgrade() -> None:
    # Catalog rows may be referenced by installations, so rollback keeps the seeded data.
    pass
