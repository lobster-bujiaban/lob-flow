from __future__ import annotations

import ipaddress
import json
import socket
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from uuid import uuid4

from lob_flow.database import Database
from lob_flow.encryption import CredentialCipher
from lob_flow.models import (
    PluginCatalogItem,
    PluginInstallRequest,
    PluginInstallation,
    PluginManifest,
)
from lob_flow.service import NotFoundError


BUILTIN_PLUGINS = [
    {
        "plugin_id": "lob/text-tools",
        "name": "Text Tools",
        "author": "lob",
        "version": "1.0.0",
        "description": "文本大小写、裁剪与替换工具。",
        "icon": "Aa",
        "verified": True,
        "tools": [
            {"name": "uppercase", "label": "转为大写", "description": "将输入文本转为大写。", "parameters": {"text": {"type": "string", "required": True}}},
            {"name": "lowercase", "label": "转为小写", "description": "将输入文本转为小写。", "parameters": {"text": {"type": "string", "required": True}}},
            {"name": "replace", "label": "文本替换", "description": "替换文本中的指定内容。", "parameters": {"text": {"type": "string", "required": True}, "old": {"type": "string", "required": True}, "new": {"type": "string", "required": False}}},
        ],
    },
    {
        "plugin_id": "lob/json-tools",
        "name": "JSON Tools",
        "author": "lob",
        "version": "1.0.0",
        "description": "解析 JSON 并提取点路径字段。",
        "icon": "{}",
        "verified": True,
        "tools": [
            {"name": "extract", "label": "提取 JSON 字段", "description": "按 user.profile.name 一类路径提取值。", "parameters": {"json": {"type": "string", "required": True}, "path": {"type": "string", "required": True}}},
        ],
    },
    {
        "plugin_id": "lob/http-request",
        "name": "HTTP Request",
        "author": "lob",
        "version": "1.0.0",
        "description": "向公网 HTTPS API 发起受限请求，默认阻止本机和私网地址。",
        "icon": "↗",
        "verified": True,
        "credential_schema": {"bearer_token": {"type": "secret", "required": False}},
        "tools": [
            {"name": "request", "label": "HTTP 请求", "description": "调用公网 HTTPS API。", "parameters": {"url": {"type": "string", "required": True}, "method": {"type": "string", "required": False}, "body": {"type": "string", "required": False}}},
        ],
    },
]


@dataclass(frozen=True)
class ToolResult:
    installation_id: str
    value: str


class PluginExecutionError(RuntimeError):
    pass


class PluginService:
    def __init__(self, database: Database, cipher: CredentialCipher) -> None:
        self.database = database
        self.cipher = cipher

    def ensure_catalog(self) -> None:
        timestamp = datetime.now(UTC).isoformat()
        with self.database.connect() as connection:
            for raw in BUILTIN_PLUGINS:
                manifest = PluginManifest.model_validate(raw)
                connection.execute(
                    """INSERT INTO plugin_catalog
                       (plugin_id, name, author, version, category, description, icon,
                        verified, manifest_json, created_at)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (plugin_id) DO UPDATE
                       SET name = EXCLUDED.name, version = EXCLUDED.version,
                           description = EXCLUDED.description,
                           manifest_json = EXCLUDED.manifest_json""",
                    (
                        manifest.plugin_id, manifest.name, manifest.author,
                        manifest.version, manifest.category, manifest.description,
                        manifest.icon, manifest.verified, manifest.model_dump_json(), timestamp,
                    ),
                )

    def marketplace(self, workspace_id: str) -> list[PluginCatalogItem]:
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT catalog.manifest_json, installation.id AS installation_id,
                          installation.enabled, installation.credentials_encrypted
                   FROM plugin_catalog AS catalog
                   LEFT JOIN plugin_installations AS installation
                     ON installation.plugin_id = catalog.plugin_id
                    AND installation.workspace_id = %s
                   ORDER BY catalog.verified DESC, catalog.name""",
                (workspace_id,),
            ).fetchall()
        return [PluginCatalogItem(
            manifest=PluginManifest.model_validate_json(row["manifest_json"]),
            installed=row["installation_id"] is not None,
            enabled=bool(row["enabled"]),
            installation_id=row["installation_id"],
            has_credentials=bool(row["credentials_encrypted"]),
        ) for row in rows]

    def install(self, workspace_id: str, plugin_id: str, request: PluginInstallRequest) -> PluginInstallation:
        with self.database.connect() as connection:
            catalog = connection.execute(
                "SELECT version FROM plugin_catalog WHERE plugin_id = %s", (plugin_id,)
            ).fetchone()
        if catalog is None:
            raise NotFoundError(f"Plugin {plugin_id} not found")
        timestamp = datetime.now(UTC)
        encrypted = self.cipher.encrypt(json.dumps(request.credentials)) if request.credentials else None
        installation_id = str(uuid4())
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO plugin_installations
                   (id, workspace_id, plugin_id, version, enabled, credentials_encrypted,
                    created_at, updated_at)
                   VALUES (%s, %s, %s, %s, TRUE, %s, %s, %s)
                   ON CONFLICT (workspace_id, plugin_id) DO UPDATE
                   SET version = EXCLUDED.version, enabled = TRUE,
                       credentials_encrypted = COALESCE(EXCLUDED.credentials_encrypted, plugin_installations.credentials_encrypted),
                       updated_at = EXCLUDED.updated_at""",
                (installation_id, workspace_id, plugin_id, catalog["version"], encrypted, timestamp.isoformat(), timestamp.isoformat()),
            )
            row = connection.execute(
                "SELECT * FROM plugin_installations WHERE workspace_id = %s AND plugin_id = %s",
                (workspace_id, plugin_id),
            ).fetchone()
        return self._installation(row)

    def set_enabled(self, workspace_id: str, plugin_id: str, enabled: bool) -> PluginInstallation:
        with self.database.connect() as connection:
            row = connection.execute(
                """UPDATE plugin_installations SET enabled = %s, updated_at = %s
                   WHERE workspace_id = %s AND plugin_id = %s RETURNING *""",
                (enabled, datetime.now(UTC).isoformat(), workspace_id, plugin_id),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Plugin {plugin_id} is not installed")
        return self._installation(row)

    def uninstall(self, workspace_id: str, plugin_id: str) -> None:
        with self.database.connect() as connection:
            row = connection.execute(
                "DELETE FROM plugin_installations WHERE workspace_id = %s AND plugin_id = %s RETURNING id",
                (workspace_id, plugin_id),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Plugin {plugin_id} is not installed")

    def execute(self, workspace_id: str, plugin_id: str, tool_name: str, parameters: dict) -> ToolResult:
        with self.database.connect() as connection:
            row = connection.execute(
                """SELECT installation.id, installation.credentials_encrypted
                   FROM plugin_installations AS installation
                   WHERE installation.workspace_id = %s AND installation.plugin_id = %s
                     AND installation.enabled = TRUE""",
                (workspace_id, plugin_id),
            ).fetchone()
        if row is None:
            raise PluginExecutionError(f"Plugin {plugin_id} is not installed or enabled")
        credentials = json.loads(self.cipher.decrypt(row["credentials_encrypted"])) if row["credentials_encrypted"] else {}
        if plugin_id == "lob/text-tools":
            text = str(parameters.get("text", ""))
            if tool_name == "uppercase": value = text.upper()
            elif tool_name == "lowercase": value = text.lower()
            elif tool_name == "replace": value = text.replace(str(parameters.get("old", "")), str(parameters.get("new", "")))
            else: raise PluginExecutionError(f"Unknown tool {tool_name}")
        elif plugin_id == "lob/json-tools" and tool_name == "extract":
            value_obj = json.loads(str(parameters.get("json", "")))
            for part in str(parameters.get("path", "")).split("."):
                value_obj = value_obj[int(part)] if isinstance(value_obj, list) else value_obj[part]
            value = value_obj if isinstance(value_obj, str) else json.dumps(value_obj, ensure_ascii=False)
        elif plugin_id == "lob/http-request" and tool_name == "request":
            value = self._http_request(parameters, credentials)
        else:
            raise PluginExecutionError(f"Unknown plugin tool {plugin_id}/{tool_name}")
        return ToolResult(installation_id=row["id"], value=value)

    @staticmethod
    def _http_request(parameters: dict, credentials: dict) -> str:
        url = str(parameters.get("url", ""))
        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise PluginExecutionError("HTTP Request only allows public HTTPS URLs")
        for result in socket.getaddrinfo(parsed.hostname, parsed.port or 443):
            address = ipaddress.ip_address(result[4][0])
            if not address.is_global:
                raise PluginExecutionError("HTTP Request blocks local and private network addresses")
        method = str(parameters.get("method", "GET")).upper()
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            raise PluginExecutionError("Unsupported HTTP method")
        headers = {"Accept": "application/json", "User-Agent": "LOB-Flow/1.0"}
        if credentials.get("bearer_token"):
            headers["Authorization"] = f"Bearer {credentials['bearer_token']}"
        body = str(parameters.get("body", ""))
        data = body.encode() if body and method != "GET" else None
        request = Request(url, data=data, headers=headers, method=method)
        with urlopen(request, timeout=15) as response:
            return response.read(1_000_000).decode("utf-8", errors="replace")

    @staticmethod
    def _installation(row) -> PluginInstallation:
        values = dict(row)
        values["has_credentials"] = bool(values.pop("credentials_encrypted"))
        return PluginInstallation(**values)
