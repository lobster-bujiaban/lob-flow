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

    def list_tools(self, tenant_id: str) -> dict:
        return self._request(tenant_id, "GET", "management/tools")

    def get_tool(self, tenant_id: str, plugin_id: str, provider: str) -> dict:
        query = urlencode({"plugin_id": plugin_id, "provider": provider})
        return self._request(tenant_id, "GET", f"management/tool?{query}")

    def invoke_tool(self, tenant_id: str, payload: dict) -> list[dict]:
        response = self._json_request(tenant_id, "POST", "dispatch/tool/invoke", payload)
        data = response.get("data", response)
        return data if isinstance(data, list) else [data]

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
