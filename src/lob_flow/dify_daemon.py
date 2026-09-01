from __future__ import annotations

import json
import os
import uuid
from dotenv import load_dotenv
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class DifyDaemonError(RuntimeError):
    pass


class DifyDaemonClient:
    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    @classmethod
    def from_env(cls) -> "DifyDaemonClient":
        load_dotenv(".env.dify")
        return cls(
            os.getenv("DIFY_PLUGIN_DAEMON_URL", "http://127.0.0.1:5002"),
            os.getenv("DIFY_PLUGIN_DAEMON_KEY", ""),
        )

    def available(self) -> bool:
        try:
            self.list_plugins("00000000-0000-0000-0000-000000000000")
            return True
        except DifyDaemonError:
            return False

    def upload_package(self, tenant_id: str, package: bytes) -> dict:
        boundary = f"lob-{uuid.uuid4().hex}"
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"dify_pkg\"; filename=\"dify_pkg\"\r\n"
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode() + package + (
            f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"verify_signature\"\r\n\r\n"
            f"true\r\n--{boundary}--\r\n"
        ).encode()
        return self._request(
            tenant_id, "POST", "management/install/upload/package", body,
            f"multipart/form-data; boundary={boundary}",
        )

    def install_identifier(self, tenant_id: str, identifier: str, source: str = "package") -> dict:
        return self._json_request(tenant_id, "POST", "management/install/identifiers", {
            "plugin_unique_identifiers": [identifier],
            "source": source,
            "metas": [{"plugin_unique_identifier": identifier}],
        })

    def list_plugins(self, tenant_id: str) -> dict:
        return self._request(tenant_id, "GET", "management/list?page=1&page_size=100")

    def installed_plugin_ids(self, tenant_id: str) -> list[str]:
        response = self.list_plugins(tenant_id)
        data = response.get("data", response)
        entries = data.get("list", []) if isinstance(data, dict) else []
        result: list[str] = []
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict):
                continue
            identifier = str(
                entry.get("plugin_unique_identifier")
                or entry.get("unique_identifier")
                or entry.get("plugin_id")
                or ""
            )
            plugin_id = str(entry.get("plugin_id") or identifier.split(":", 1)[0])
            if plugin_id:
                result.append(plugin_id)
        return sorted(set(result))

    def list_tools(self, tenant_id: str) -> dict:
        return self._request(tenant_id, "GET", "management/tools?page=1&page_size=256")

    def normalized_tools(self, tenant_id: str) -> list[dict]:
        response = self.list_tools(tenant_id)
        providers = response.get("data", [])
        result: list[dict] = []
        for item in providers if isinstance(providers, list) else []:
            if not isinstance(item, dict):
                continue
            declaration = item.get("declaration") or {}
            identity = declaration.get("identity") or {}
            plugin_id = str(item.get("plugin_id") or "")
            provider_name = str(identity.get("name") or "")
            label = identity.get("label") or {}
            description = identity.get("description") or {}
            tools: list[dict] = []
            for tool in declaration.get("tools") or []:
                tool_identity = tool.get("identity") or {}
                tool_label = tool_identity.get("label") or {}
                human = (tool.get("description") or {}).get("human") or {}
                parameters = {
                    str(parameter.get("name")): {"type": str(parameter.get("type") or "string"), "required": bool(parameter.get("required"))}
                    for parameter in (tool.get("parameters") or []) if parameter.get("name")
                }
                tools.append({"name": str(tool_identity.get("name") or ""), "label": tool_label.get("zh_Hans") or tool_label.get("en_US") or tool_identity.get("name") or "Tool", "description": human.get("zh_Hans") or human.get("en_US") or "", "parameters": parameters})
            if plugin_id and provider_name and tools:
                result.append({"plugin_id": plugin_id, "provider_name": provider_name, "name": label.get("zh_Hans") or label.get("en_US") or provider_name, "description": description.get("zh_Hans") or description.get("en_US") or "", "icon": identity.get("icon") or "⌘", "tools": tools})
        return result

    def get_tool(self, tenant_id: str, plugin_id: str, provider: str) -> dict:
        query = urlencode({"plugin_id": plugin_id, "provider": provider})
        return self._request(tenant_id, "GET", f"management/tool?{query}")

    def invoke_tool(self, tenant_id: str, payload: dict) -> list[dict]:
        response = self._json_request(tenant_id, "POST", "dispatch/tool/invoke", payload)
        data = response.get("data", response)
        return data if isinstance(data, list) else [data]

    def invoke_installed_tool(self, tenant_id: str, plugin_id: str, provider: str, tool_name: str, parameters: dict) -> str:
        payload = {"user_id": "lob-flow", "data": {"provider": provider, "tool": tool_name, "credentials": {}, "credential_type": "unauthorized", "tool_parameters": parameters}}
        request = Request(f"{self.base_url}/plugin/{tenant_id}/dispatch/tool/invoke", data=json.dumps(payload).encode(), method="POST", headers={"X-Api-Key": self.api_key, "X-Plugin-ID": plugin_id, "Content-Type": "application/json"})
        messages: list[str] = []
        try:
            with urlopen(request, timeout=300) as response:
                for raw_line in response:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if line.startswith("data:"):
                        line = line[5:].strip()
                    if not line:
                        continue
                    event = json.loads(line)
                    if event.get("code") not in (None, 0):
                        raise DifyDaemonError(str(event.get("message") or event))
                    data = event.get("data", event)
                    message = data.get("message", {}) if isinstance(data, dict) else {}
                    if isinstance(message, dict) and "text" in message:
                        messages.append(str(message["text"]))
                    elif isinstance(data, dict) and data.get("type") in {"json", "log"}:
                        messages.append(json.dumps(message, ensure_ascii=False))
        except DifyDaemonError:
            raise
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise DifyDaemonError(f"Dify tool invocation failed: {exc}") from exc
        return "\n".join(messages)

    def _json_request(self, tenant_id: str, method: str, path: str, payload: dict) -> dict:
        return self._request(tenant_id, method, path, json.dumps(payload).encode(), "application/json")

    def _request(
        self, tenant_id: str, method: str, path: str, body: bytes | None = None,
        content_type: str | None = None,
    ) -> dict:
        headers = {"X-Api-Key": self.api_key}
        if content_type:
            headers["Content-Type"] = content_type
        request = Request(
            f"{self.base_url}/plugin/{tenant_id}/{path}", data=body,
            headers=headers, method=method,
        )
        try:
            with urlopen(request, timeout=300) as response:
                result = json.loads(response.read())
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise DifyDaemonError(f"Dify Plugin Daemon request failed: {exc}") from exc
        if isinstance(result, dict) and result.get("code") not in (None, 0):
            raise DifyDaemonError(str(result.get("message") or result))
        return result if isinstance(result, dict) else {"data": result}
