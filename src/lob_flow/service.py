from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from time import monotonic
from uuid import uuid4

from lob_flow.database import Database
from lob_flow.encryption import CredentialCipher
from lob_flow.models import (
    App,
    AppCreate,
    DraftDefinition,
    ModelProviderConfig,
    ModelProviderConfigCreate,
    ModelProviderConfigUpdate,
    Run,
    RunEvent,
    Workspace,
    WorkspaceCreate,
)
from lob_flow.provider import ModelGateway, ProviderError, TokenUsage


class NotFoundError(LookupError):
    pass


def now() -> datetime:
    return datetime.now(UTC)


class FlowService:
    def __init__(self, database: Database) -> None:
        self.database = database
        self.cipher = CredentialCipher.from_env()
        self.model_gateway = ModelGateway(database, self.cipher)

    def list_workspaces(self) -> list[Workspace]:
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM workspaces ORDER BY created_at"
            ).fetchall()
        return [Workspace(**dict(row)) for row in rows]

    def create_workspace(self, request: WorkspaceCreate) -> Workspace:
        workspace = Workspace(id=str(uuid4()), name=request.name, created_at=now())
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO workspaces (id, name, created_at) VALUES (%s, %s, %s)",
                (workspace.id, workspace.name, workspace.created_at.isoformat()),
            )
        return workspace

    def delete_workspace(self, workspace_id: str) -> None:
        self.get_workspace(workspace_id)
        with self.database.connect() as connection:
            app_rows = connection.execute(
                "SELECT id FROM apps WHERE workspace_id = %s", (workspace_id,)
            ).fetchall()
            for row in app_rows:
                self._delete_app(connection, row["id"])
            connection.execute("DELETE FROM workspaces WHERE id = %s", (workspace_id,))

    def create_app(self, workspace_id: str, request: AppCreate) -> App:
        self.get_workspace(workspace_id)
        self._validate_provider_reference(workspace_id, request.draft)
        timestamp = now()
        app = App(
            id=str(uuid4()),
            workspace_id=workspace_id,
            name=request.name,
            description=request.description,
            app_type=request.app_type,
            draft=request.draft,
            created_at=timestamp,
            updated_at=timestamp,
        )
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO apps
                   (id, workspace_id, name, description, app_type, draft_json, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    app.id,
                    app.workspace_id,
                    app.name,
                    app.description,
                    app.app_type,
                    app.draft.model_dump_json(),
                    app.created_at.isoformat(),
                    app.updated_at.isoformat(),
                ),
            )
        return app

    def delete_app(self, app_id: str) -> None:
        self.get_app(app_id)
        with self.database.connect() as connection:
            self._delete_app(connection, app_id)

    @staticmethod
    def _delete_app(connection, app_id: str) -> None:
        connection.execute(
            "DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE app_id = %s)",
            (app_id,),
        )
        connection.execute("DELETE FROM runs WHERE app_id = %s", (app_id,))
        connection.execute("DELETE FROM published_versions WHERE app_id = %s", (app_id,))
        connection.execute("DELETE FROM workflow_runs WHERE app_id = %s", (app_id,))
        connection.execute("DELETE FROM apps WHERE id = %s", (app_id,))

    def list_apps(self, workspace_id: str) -> list[App]:
        self.get_workspace(workspace_id)
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM apps WHERE workspace_id = %s ORDER BY created_at",
                (workspace_id,),
            ).fetchall()
        return [self._app_from_row(row) for row in rows]

    def create_model_provider_config(
        self, workspace_id: str, request: ModelProviderConfigCreate
    ) -> ModelProviderConfig:
        self.get_workspace(workspace_id)
        timestamp = now()
        config_id = str(uuid4())
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO model_provider_configs
                   (id, workspace_id, provider, name, base_url, api_key_encrypted,
                    created_at, updated_at)
                   VALUES (%s, %s, 'openai_compatible', %s, %s, %s, %s, %s)""",
                (
                    config_id,
                    workspace_id,
                    request.name,
                    request.base_url.rstrip("/"),
                    self.cipher.encrypt(request.api_key),
                    timestamp.isoformat(),
                    timestamp.isoformat(),
                ),
            )
        return self.get_model_provider_config(workspace_id, config_id)

    def list_model_provider_configs(
        self, workspace_id: str
    ) -> list[ModelProviderConfig]:
        self.get_workspace(workspace_id)
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT id, workspace_id, provider, name, base_url,
                          created_at, updated_at
                   FROM model_provider_configs
                   WHERE workspace_id = %s ORDER BY created_at""",
                (workspace_id,),
            ).fetchall()
        return [ModelProviderConfig(**dict(row), has_api_key=True) for row in rows]

    def get_model_provider_config(
        self, workspace_id: str, config_id: str
    ) -> ModelProviderConfig:
        with self.database.connect() as connection:
            row = connection.execute(
                """SELECT id, workspace_id, provider, name, base_url,
                          created_at, updated_at
                   FROM model_provider_configs
                   WHERE id = %s AND workspace_id = %s""",
                (config_id, workspace_id),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Model provider config {config_id} not found")
        return ModelProviderConfig(**dict(row), has_api_key=True)

    def update_model_provider_config(
        self,
        workspace_id: str,
        config_id: str,
        request: ModelProviderConfigUpdate,
    ) -> ModelProviderConfig:
        self.get_model_provider_config(workspace_id, config_id)
        timestamp = now()
        with self.database.connect() as connection:
            if request.api_key is None:
                connection.execute(
                    """UPDATE model_provider_configs
                       SET name = %s, base_url = %s, updated_at = %s
                       WHERE id = %s AND workspace_id = %s""",
                    (
                        request.name,
                        request.base_url.rstrip("/"),
                        timestamp.isoformat(),
                        config_id,
                        workspace_id,
                    ),
                )
            else:
                connection.execute(
                    """UPDATE model_provider_configs
                       SET name = %s, base_url = %s, api_key_encrypted = %s,
                           updated_at = %s
                       WHERE id = %s AND workspace_id = %s""",
                    (
                        request.name,
                        request.base_url.rstrip("/"),
                        self.cipher.encrypt(request.api_key),
                        timestamp.isoformat(),
                        config_id,
                        workspace_id,
                    ),
                )
        return self.get_model_provider_config(workspace_id, config_id)

    def get_workspace(self, workspace_id: str) -> Workspace:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM workspaces WHERE id = %s", (workspace_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Workspace {workspace_id} not found")
        return Workspace(**dict(row))

    def get_app(self, app_id: str) -> App:
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM apps WHERE id = %s", (app_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"App {app_id} not found")
        return self._app_from_row(row)

    def update_draft(self, app_id: str, draft: DraftDefinition) -> App:
        app = self.get_app(app_id)
        self._validate_provider_reference(app.workspace_id, draft)
        timestamp = now()
        with self.database.connect() as connection:
            connection.execute(
                "UPDATE apps SET draft_json = %s, updated_at = %s WHERE id = %s",
                (draft.model_dump_json(), timestamp.isoformat(), app_id),
            )
        return self.get_app(app_id)

    def stream_run(self, app_id: str, user_input: str) -> Iterator[RunEvent]:
        app = self.get_app(app_id)
        run_id = str(uuid4())
        created_at = now()
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO runs
                   (id, app_id, status, input, model_provider, model,
                    draft_snapshot_json, created_at)
                   VALUES (%s, %s, 'running', %s, %s, %s, %s, %s)""",
                (
                    run_id,
                    app_id,
                    user_input,
                    app.draft.model.provider,
                    app.draft.model.model,
                    app.draft.model_dump_json(),
                    created_at.isoformat(),
                ),
            )

        sequence = 1
        started = self._save_event(
            run_id,
            sequence,
            "run_started",
            {
                "app_id": app_id,
                "provider": app.draft.model.provider,
                "model": app.draft.model.model,
            },
        )
        yield started
        output_parts: list[str] = []
        usage: TokenUsage | None = None
        finish_reason: str | None = None
        started_at = monotonic()

        try:
            provider = self.model_gateway.get_provider(app.draft, app.workspace_id)
            sequence += 1
            yield self._save_event(
                run_id,
                sequence,
                "model_started",
                {"provider": app.draft.model.provider, "model": app.draft.model.model},
            )
            for chunk in provider.stream(app.draft, user_input):
                if chunk.usage is not None:
                    usage = chunk.usage
                if chunk.finish_reason is not None:
                    finish_reason = chunk.finish_reason
                if not chunk.delta:
                    continue
                output_parts.append(chunk.delta)
                sequence += 1
                yield self._save_event(
                    run_id, sequence, "message_delta", {"delta": chunk.delta}
                )

            output = "".join(output_parts)
            finished_at = now()
            duration_ms = int((monotonic() - started_at) * 1000)
            prompt_tokens = usage.prompt_tokens if usage else None
            completion_tokens = usage.completion_tokens if usage else None
            total_tokens = usage.total_tokens if usage else None
            with self.database.connect() as connection:
                connection.execute(
                    """UPDATE runs
                       SET status = 'succeeded', output = %s, prompt_tokens = %s,
                           completion_tokens = %s, total_tokens = %s, finish_reason = %s,
                           duration_ms = %s, finished_at = %s
                       WHERE id = %s""",
                    (
                        output,
                        prompt_tokens,
                        completion_tokens,
                        total_tokens,
                        finish_reason,
                        duration_ms,
                        finished_at.isoformat(),
                        run_id,
                    ),
                )
            sequence += 1
            yield self._save_event(
                run_id,
                sequence,
                "model_completed",
                {
                    "finish_reason": finish_reason,
                    "usage": {
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "total_tokens": total_tokens,
                    },
                    "duration_ms": duration_ms,
                },
            )
            sequence += 1
            yield self._save_event(
                run_id, sequence, "run_succeeded", {"output": output}
            )
        except Exception as exc:
            error = str(exc)
            error_code = exc.code if isinstance(exc, ProviderError) else "internal_error"
            finished_at = now()
            duration_ms = int((monotonic() - started_at) * 1000)
            with self.database.connect() as connection:
                connection.execute(
                    """UPDATE runs SET status = 'failed', error = %s, error_code = %s,
                                      duration_ms = %s, finished_at = %s
                       WHERE id = %s""",
                    (error, error_code, duration_ms, finished_at.isoformat(), run_id),
                )
            sequence += 1
            yield self._save_event(
                run_id,
                sequence,
                "run_failed",
                {"error": error, "error_code": error_code, "duration_ms": duration_ms},
            )

    def run(self, app_id: str, user_input: str) -> Run:
        events = list(self.stream_run(app_id, user_input))
        return self.get_run(events[0].run_id)

    def get_run(self, run_id: str) -> Run:
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM runs WHERE id = %s", (run_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"Run {run_id} not found")
        values = dict(row)
        values["draft_snapshot"] = DraftDefinition.model_validate_json(
            values.pop("draft_snapshot_json")
        )
        return Run(**values)

    def list_run_events(self, run_id: str) -> list[RunEvent]:
        self.get_run(run_id)
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM run_events WHERE run_id = %s ORDER BY sequence", (run_id,)
            ).fetchall()
        return [
            RunEvent(
                run_id=row["run_id"],
                sequence=row["sequence"],
                type=row["type"],
                data=json.loads(row["data_json"]),
                created_at=row["created_at"],
            )
            for row in rows
        ]

    def _save_event(self, run_id: str, sequence: int, event_type: str, data: dict) -> RunEvent:
        event = RunEvent(
            run_id=run_id,
            sequence=sequence,
            type=event_type,
            data=data,
            created_at=now(),
        )
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO run_events (run_id, sequence, type, data_json, created_at)
                   VALUES (%s, %s, %s, %s, %s)""",
                (
                    event.run_id,
                    event.sequence,
                    event.type,
                    json.dumps(event.data, ensure_ascii=False),
                    event.created_at.isoformat(),
                ),
            )
        return event

    @staticmethod
    def _app_from_row(row) -> App:
        values = dict(row)
        values["draft"] = DraftDefinition.model_validate_json(values.pop("draft_json"))
        return App(**values)

    def _validate_provider_reference(
        self, workspace_id: str, draft: DraftDefinition
    ) -> None:
        config_id = draft.model.provider_config_id
        if draft.model.provider == "openai_compatible" and config_id:
            self.get_model_provider_config(workspace_id, config_id)
