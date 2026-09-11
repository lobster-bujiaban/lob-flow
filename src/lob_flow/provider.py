from __future__ import annotations

import json
import psycopg
import socket
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from lob_flow.database import Database
from lob_flow.encryption import CredentialCipher
from lob_flow.models import DraftDefinition


@dataclass(frozen=True)
class TokenUsage:
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


@dataclass(frozen=True)
class ModelChunk:
    delta: str = ""
    finish_reason: str | None = None
    usage: TokenUsage | None = None


class ProviderError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ModelProvider(Protocol):
    def stream(self, definition: DraftDefinition, user_input: str) -> Iterator[ModelChunk]: ...


def render_user_prompt(definition: DraftDefinition, user_input: str) -> str:
    try:
        return definition.user_prompt_template.format(input=user_input)
    except (KeyError, ValueError) as exc:
        raise ProviderError("invalid_prompt", f"Invalid user prompt template: {exc}") from exc


class OpenAICompatibleProvider:
    def __init__(self, api_key: str, base_url: str, max_attempts: int = 2) -> None:
        self.api_key = api_key
        self.base_url = base_url
        self.max_attempts = max_attempts

    def stream(self, definition: DraftDefinition, user_input: str) -> Iterator[ModelChunk]:
        config = definition.model
        rendered = render_user_prompt(definition, user_input)
        payload = {
            "model": config.model,
            "messages": [
                {"role": "system", "content": definition.system_prompt},
                {"role": "user", "content": rendered},
            ],
            "temperature": config.temperature,
            "max_tokens": config.max_tokens,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        url = f"{self.base_url.rstrip('/')}/chat/completions"
        request = Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
            method="POST",
        )

        response = self._open(request, config.timeout_seconds)
        try:
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    payload = json.loads(data)
                except json.JSONDecodeError as exc:
                    raise ProviderError("invalid_response", "Provider returned invalid SSE JSON") from exc

                choices = payload.get("choices") or []
                choice = choices[0] if choices else {}
                delta = choice.get("delta", {}).get("content") or ""
                usage_data = payload.get("usage")
                usage = None
                if usage_data:
                    usage = TokenUsage(
                        prompt_tokens=usage_data.get("prompt_tokens", 0),
                        completion_tokens=usage_data.get("completion_tokens", 0),
                        total_tokens=usage_data.get("total_tokens", 0),
                    )
                yield ModelChunk(
                    delta=delta,
                    finish_reason=choice.get("finish_reason"),
                    usage=usage,
                )
        except (TimeoutError, socket.timeout) as exc:
            raise ProviderError("timeout", "Model stream timed out") from exc
        except OSError as exc:
            raise ProviderError("network_error", f"Model stream failed: {exc}") from exc
        finally:
            response.close()

    def _open(self, request: Request, timeout: float):
        for attempt in range(1, self.max_attempts + 1):
            try:
                return urlopen(request, timeout=timeout)
            except HTTPError as exc:
                code = self._http_error_code(exc.code)
                retryable = exc.code == 429 or exc.code >= 500
                if retryable and attempt < self.max_attempts:
                    time.sleep(0.25 * attempt)
                    continue
                body = exc.read(500).decode("utf-8", errors="replace")
                raise ProviderError(code, f"Model provider returned HTTP {exc.code}: {body}") from exc
            except (TimeoutError, socket.timeout) as exc:
                if attempt < self.max_attempts:
                    time.sleep(0.25 * attempt)
                    continue
                raise ProviderError("timeout", "Model request timed out") from exc
            except URLError as exc:
                if attempt < self.max_attempts:
                    time.sleep(0.25 * attempt)
                    continue
                raise ProviderError("network_error", f"Model request failed: {exc.reason}") from exc
        raise ProviderError("provider_error", "Model request failed")

    @staticmethod
    def _http_error_code(status: int) -> str:
        if status in {401, 403}:
            return "authentication_error"
        if status == 429:
            return "rate_limit"
        if status == 408:
            return "timeout"
        return "provider_error"


class ModelGateway:
    def __init__(self, database: Database, cipher: CredentialCipher) -> None:
        self.database = database
        self.cipher = cipher

    def get_provider(
        self, definition: DraftDefinition, workspace_id: str
    ) -> ModelProvider:
        config_id = definition.model.provider_config_id
        if not config_id:
            raise ProviderError(
                "provider_config_missing",
                "Configure a real model provider before running the app",
            )
        row = None
        last_error: psycopg.OperationalError | None = None
        for attempt in range(3):
            try:
                with self.database.connect() as connection:
                    row = connection.execute(
                        """SELECT base_url, api_key_encrypted
                           FROM model_provider_configs
                           WHERE id = %s AND workspace_id = %s""",
                        (config_id, workspace_id),
                    ).fetchone()
                last_error = None
                break
            except psycopg.OperationalError as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(0.4 * (attempt + 1))
        if last_error is not None and row is None:
            raise ProviderError(
                "database_unavailable",
                "PostgreSQL 连接暂时中断，模型配置读取失败，请稍后重试。",
            ) from last_error
        if row is None:
            raise ProviderError(
                "provider_config_not_found",
                "Model provider configuration was not found in this workspace",
            )
        return OpenAICompatibleProvider(
            api_key=self.cipher.decrypt(row["api_key_encrypted"]),
            base_url=row["base_url"],
        )
