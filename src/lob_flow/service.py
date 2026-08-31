from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from uuid import uuid4

from lob_flow.database import Database
from lob_flow.models import (
    App,
    AppCreate,
    DraftDefinition,
    Run,
    RunEvent,
    Workspace,
    WorkspaceCreate,
)
from lob_flow.provider import FakeModelProvider


class NotFoundError(LookupError):
    pass


def now() -> datetime:
    return datetime.now(UTC)


class FlowService:
    def __init__(self, database: Database) -> None:
        self.database = database
        self.provider = FakeModelProvider()

    def create_workspace(self, request: WorkspaceCreate) -> Workspace:
        workspace = Workspace(id=str(uuid4()), name=request.name, created_at=now())
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO workspaces (id, name, created_at) VALUES (%s, %s, %s)",
                (workspace.id, workspace.name, workspace.created_at.isoformat()),
            )
        return workspace

    def create_app(self, workspace_id: str, request: AppCreate) -> App:
        self.get_workspace(workspace_id)
        timestamp = now()
        app = App(
            id=str(uuid4()),
            workspace_id=workspace_id,
            name=request.name,
            description=request.description,
            draft=request.draft,
            created_at=timestamp,
            updated_at=timestamp,
        )
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO apps
                   (id, workspace_id, name, description, draft_json, created_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (
                    app.id,
                    app.workspace_id,
                    app.name,
                    app.description,
                    app.draft.model_dump_json(),
                    app.created_at.isoformat(),
                    app.updated_at.isoformat(),
                ),
            )
        return app

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
        self.get_app(app_id)
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
                   (id, app_id, status, input, draft_snapshot_json, created_at)
                   VALUES (%s, %s, 'running', %s, %s, %s)""",
                (run_id, app_id, user_input, app.draft.model_dump_json(), created_at.isoformat()),
            )

        sequence = 1
        started = self._save_event(run_id, sequence, "run_started", {"app_id": app_id})
        yield started
        output_parts: list[str] = []

        try:
            for delta in self.provider.stream(app.draft, user_input):
                output_parts.append(delta)
                sequence += 1
                yield self._save_event(run_id, sequence, "message_delta", {"delta": delta})

            output = "".join(output_parts)
            finished_at = now()
            with self.database.connect() as connection:
                connection.execute(
                    """UPDATE runs SET status = 'succeeded', output = %s, finished_at = %s
                       WHERE id = %s""",
                    (output, finished_at.isoformat(), run_id),
                )
            sequence += 1
            yield self._save_event(run_id, sequence, "run_succeeded", {"output": output})
        except Exception as exc:
            error = str(exc)
            finished_at = now()
            with self.database.connect() as connection:
                connection.execute(
                    """UPDATE runs SET status = 'failed', error = %s, finished_at = %s
                       WHERE id = %s""",
                    (error, finished_at.isoformat(), run_id),
                )
            sequence += 1
            yield self._save_event(run_id, sequence, "run_failed", {"error": error})

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
