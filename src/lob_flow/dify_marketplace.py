from __future__ import annotations

import json
import time
from urllib.parse import quote
from urllib.request import Request, urlopen

from lob_flow.dify_daemon import DifyDaemonClient, DifyDaemonError


class DifyMarketplaceClient:
    def __init__(self, daemon: DifyDaemonClient) -> None:
        self.daemon = daemon
        self.base_url = "https://marketplace.dify.ai/api/v1"
        self._snapshot: list[dict] = []
        self._snapshot_at = 0.0

    def explore(self, query: str = "", limit: int = 60) -> list[dict]:
        plugins = self._load_snapshot()
        needle = query.strip().lower()
        if needle:
            plugins = [item for item in plugins if needle in f"{item.get('org', '')}/{item.get('name', '')}".lower()]
        else:
            preferred = [item for item in plugins if item.get("org") == "langgenius"]
            plugins = preferred + [item for item in plugins if item.get("org") != "langgenius"]
        selected = plugins[: max(1, min(limit, 60))]
        details = self._batch_details([f"{item.get('org', '')}/{item.get('name', '')}" for item in selected])
        detail_map = {item.get("plugin_id"): item for item in details}
        result = []
        for item in selected:
            plugin_id = f"{item.get('org', '')}/{item.get('name', '')}"
            detail = detail_map.get(plugin_id, {})
            label = detail.get("label", {})
            brief = detail.get("brief", {})
            icon = str(detail.get("icon", ""))
            result.append({
                "org": item.get("org", ""), "name": item.get("name", ""),
                "label": label.get("zh_Hans") or label.get("en_US") or item.get("name", ""),
                "description": brief.get("zh_Hans") or brief.get("en_US") or "",
                "category": detail.get("category", "extension"),
                "icon_url": f"/api/dify-marketplace/icons/{quote(plugin_id, safe='/')}" if icon else "",
                "install_count": detail.get("install_count", 0),
                "verified": detail.get("verification", {}).get("authorized_category") in {"langgenius", "partner"},
                "version": item.get("latest_version", ""),
                "identifier": item.get("latest_package_identifier", ""),
                "updated_at": item.get("updated_at", ""),
            })
        return result

    def load_icon(self, plugin_id: str) -> tuple[bytes, str]:
        clean = plugin_id.strip("/")
        parts = clean.split("/")
        if len(parts) != 2 or any(not part or part in {".", ".."} for part in parts):
            raise DifyDaemonError("Invalid Marketplace plugin id")
        request = Request(
            f"{self.base_url}/plugins/{quote(clean, safe='/')}/icon",
            headers={"X-Dify-Version": "1.14.2", "User-Agent": "LOB-Flow/0.1"},
        )
        try:
            data = self._read_with_retry(request, 20, 2_000_001)
        except Exception as exc:
            raise DifyDaemonError(f"Failed to load Marketplace icon: {exc}") from exc
        if len(data) > 2_000_000:
            raise DifyDaemonError("Marketplace icon exceeds 2 MB")
        stripped = data.lstrip()
        media_type = "image/svg+xml" if stripped.startswith((b"<svg", b"<?xml")) else (
            "image/png" if data.startswith(b"\x89PNG") else
            "image/webp" if data.startswith(b"RIFF") else "image/jpeg"
        )
        return data, media_type

    def _batch_details(self, plugin_ids: list[str]) -> list[dict]:
        body = json.dumps({"plugin_ids": plugin_ids}).encode()
        request = Request(
            f"{self.base_url}/plugins/batch", data=body, method="POST",
            headers={"Content-Type": "application/json", "X-Dify-Version": "1.14.2", "User-Agent": "LOB-Flow/0.1"},
        )
        try:
            payload = json.loads(self._read_with_retry(request, 30))
        except Exception as exc:
            raise DifyDaemonError(f"Failed to load Marketplace details: {exc}") from exc
        return payload.get("data", {}).get("plugins", []) if isinstance(payload, dict) else []

    def install(self, tenant_id: str, identifier: str) -> dict:
        item = next((entry for entry in self._load_snapshot() if entry.get("latest_package_identifier") == identifier), None)
        if item is None:
            raise DifyDaemonError("Marketplace plugin identifier not found")
        url = str(item.get("latest_package_url", ""))
        if not url.startswith("https://"):
            raise DifyDaemonError("Marketplace package URL is invalid")
        request = Request(url, headers={"X-Dify-Version": "1.14.2", "User-Agent": "LOB-Flow/0.1"})
        try:
            package = self._read_with_retry(request, 120, 52_428_801)
        except Exception as exc:
            raise DifyDaemonError(f"Failed to download Marketplace package: {exc}") from exc
        if len(package) > 52_428_800:
            raise DifyDaemonError("Marketplace package exceeds 50 MB")
        decoded = self.daemon.upload_package(tenant_id, package)
        data = decoded.get("data", decoded)
        uploaded_identifier = data.get("unique_identifier") if isinstance(data, dict) else None
        if not uploaded_identifier:
            raise DifyDaemonError("Daemon did not return plugin identifier")
        installation = self.daemon.install_identifier(
            tenant_id, str(uploaded_identifier), source="marketplace"
        )
        return {"identifier": uploaded_identifier, "installation": installation.get("data", installation)}

    def _load_snapshot(self) -> list[dict]:
        if self._snapshot and time.monotonic() - self._snapshot_at < 300:
            return self._snapshot
        request = Request(
            f"{self.base_url}/dist/plugins/manifest.json",
            headers={"X-Dify-Version": "1.14.2", "User-Agent": "LOB-Flow/0.1"},
        )
        try:
            payload = json.loads(self._read_with_retry(request, 30))
        except Exception as exc:
            raise DifyDaemonError(f"Failed to load Dify Marketplace: {exc}") from exc
        plugins = payload.get("plugins", []) if isinstance(payload, dict) else []
        if not isinstance(plugins, list):
            raise DifyDaemonError("Dify Marketplace returned invalid manifest")
        self._snapshot = [item for item in plugins if isinstance(item, dict)]
        self._snapshot_at = time.monotonic()
        return self._snapshot

    @staticmethod
    def _read_with_retry(request: Request, timeout: int, limit: int | None = None) -> bytes:
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                with urlopen(request, timeout=timeout) as response:
                    return response.read(limit) if limit else response.read()
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(0.5 * (attempt + 1))
        assert last_error is not None
        raise last_error
