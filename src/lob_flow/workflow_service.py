from __future__ import annotations

import json
from collections.abc import Iterator
from time import monotonic
from uuid import uuid4

from lob_flow.database import Database
from lob_flow.models import (
    DraftDefinition,
    ModelConfig,
    NodeRun,
    WorkflowDefinition,
    WorkflowDraft,
    WorkflowEvent,
    WorkflowRun,
)
from lob_flow.provider import ModelGateway, ProviderError
from lob_flow.service import NotFoundError, now
from lob_flow.workflow import WorkflowValidationError, default_workflow, validate_and_sort


class WorkflowService:
    def __init__(self, database: Database, model_gateway: ModelGateway) -> None:
        self.database = database
        self.model_gateway = model_gateway

    def get_draft(self, app_id: str) -> WorkflowDraft:
        app = self._get_app(app_id)
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM workflow_drafts WHERE app_id = %s", (app_id,)
            ).fetchone()
            if row is None:
                definition = default_workflow(app["draft"])
                timestamp = now()
                connection.execute(
                    """INSERT INTO workflow_drafts (app_id, definition_json, updated_at)
                       VALUES (%s, %s, %s)""",
                    (app_id, definition.model_dump_json(), timestamp.isoformat()),
                )
                return WorkflowDraft(app_id=app_id, definition=definition, updated_at=timestamp)
        return WorkflowDraft(
            app_id=app_id,
            definition=WorkflowDefinition.model_validate_json(row["definition_json"]),
            updated_at=row["updated_at"],
        )

    def update_draft(self, app_id: str, definition: WorkflowDefinition) -> WorkflowDraft:
        app = self._get_app(app_id)
        validate_and_sort(definition)
        for node in definition.nodes:
            if node.type == "llm":
                self._validate_provider(app["workspace_id"], node.config["provider_config_id"])
        timestamp = now()
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO workflow_drafts (app_id, definition_json, updated_at)
                   VALUES (%s, %s, %s)
                   ON CONFLICT (app_id) DO UPDATE
                   SET definition_json = EXCLUDED.definition_json,
                       updated_at = EXCLUDED.updated_at""",
                (app_id, definition.model_dump_json(), timestamp.isoformat()),
            )
        return WorkflowDraft(app_id=app_id, definition=definition, updated_at=timestamp)

    def stream_run(self, app_id: str, user_input: str) -> Iterator[WorkflowEvent]:
        app = self._get_app(app_id)
        draft = self.get_draft(app_id)
        ordered = validate_and_sort(draft.definition)
        run_id = str(uuid4())
        created_at = now()
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO workflow_runs
                   (id, app_id, status, input, definition_snapshot_json, created_at)
                   VALUES (%s, %s, 'running', %s, %s, %s)""",
                (
                    run_id,
                    app_id,
                    user_input,
                    draft.definition.model_dump_json(),
                    created_at.isoformat(),
                ),
            )
        sequence = 1
        yield self._event(run_id, sequence, "workflow_started", None, {"input": user_input})
        value = user_input
        run_started = monotonic()
        current_node_id: str | None = None
        current_node_run_id: str | None = None

        try:
            for node in ordered:
                node_run_id = str(uuid4())
                current_node_id = node.id
                current_node_run_id = node_run_id
                node_started_at = now()
                node_started = monotonic()
                node_input = {"value": value}
                with self.database.connect() as connection:
                    connection.execute(
                        """INSERT INTO node_runs
                           (id, workflow_run_id, node_id, node_type, status, input_json, started_at)
                           VALUES (%s, %s, %s, %s, 'running', %s, %s)""",
                        (
                            node_run_id,
                            run_id,
                            node.id,
                            node.type,
                            json.dumps(node_input, ensure_ascii=False),
                            node_started_at.isoformat(),
                        ),
                    )
                sequence += 1
                yield self._event(
                    run_id,
                    sequence,
                    "node_started",
                    node.id,
                    {"name": node.name, "type": node.type, "input": node_input},
                )

                if node.type == "template":
                    value = node.config["template"].format(input=value)
                elif node.type == "llm":
                    definition = DraftDefinition(
                        system_prompt=node.config.get("system_prompt", ""),
                        user_prompt_template="{input}",
                        model=ModelConfig(
                            provider_config_id=node.config["provider_config_id"],
                            model=node.config["model"],
                            temperature=node.config.get("temperature", 0.2),
                            max_tokens=node.config.get("max_tokens", 1024),
                            timeout_seconds=node.config.get("timeout_seconds", 30),
                        ),
                    )
                    parts: list[str] = []
                    provider = self.model_gateway.get_provider(definition, app["workspace_id"])
                    for chunk in provider.stream(definition, value):
                        if chunk.delta:
                            parts.append(chunk.delta)
                            sequence += 1
                            yield self._event(
                                run_id,
                                sequence,
                                "node_delta",
                                node.id,
                                {"delta": chunk.delta},
                            )
                    value = "".join(parts)

                node_duration = int((monotonic() - node_started) * 1000)
                node_output = {"value": value}
                with self.database.connect() as connection:
                    connection.execute(
                        """UPDATE node_runs
                           SET status = 'succeeded', output_json = %s,
                               finished_at = %s, duration_ms = %s
                           WHERE id = %s""",
                        (
                            json.dumps(node_output, ensure_ascii=False),
                            now().isoformat(),
                            node_duration,
                            node_run_id,
                        ),
                    )
                sequence += 1
                yield self._event(
                    run_id,
                    sequence,
                    "node_succeeded",
                    node.id,
                    {"output": node_output, "duration_ms": node_duration},
                )
                current_node_id = None
                current_node_run_id = None

            duration = int((monotonic() - run_started) * 1000)
            with self.database.connect() as connection:
                connection.execute(
                    """UPDATE workflow_runs
                       SET status = 'succeeded', output = %s, finished_at = %s, duration_ms = %s
                       WHERE id = %s""",
                    (value, now().isoformat(), duration, run_id),
                )
            sequence += 1
            yield self._event(
                run_id, sequence, "workflow_succeeded", None, {"output": value, "duration_ms": duration}
            )
        except Exception as exc:
            error_code = exc.code if isinstance(exc, ProviderError) else "workflow_error"
            duration = int((monotonic() - run_started) * 1000)
            with self.database.connect() as connection:
                if current_node_run_id:
                    connection.execute(
                        """UPDATE node_runs
                           SET status = 'failed', error = %s, finished_at = %s
                           WHERE id = %s""",
                        (str(exc), now().isoformat(), current_node_run_id),
                    )
                connection.execute(
                    """UPDATE workflow_runs
                       SET status = 'failed', error = %s, error_code = %s,
                           finished_at = %s, duration_ms = %s WHERE id = %s""",
                    (str(exc), error_code, now().isoformat(), duration, run_id),
                )
            sequence += 1
            if current_node_id:
                yield self._event(
                    run_id,
                    sequence,
                    "node_failed",
                    current_node_id,
                    {"error": str(exc), "error_code": error_code},
                )
                sequence += 1
            yield self._event(
                run_id,
                sequence,
                "workflow_failed",
                None,
                {"error": str(exc), "error_code": error_code, "duration_ms": duration},
            )

    def get_run(self, run_id: str) -> WorkflowRun:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT * FROM workflow_runs WHERE id = %s", (run_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Workflow run {run_id} not found")
        values = dict(row)
        values["definition_snapshot"] = WorkflowDefinition.model_validate_json(
            values.pop("definition_snapshot_json")
        )
        return WorkflowRun(**values)

    def list_node_runs(self, run_id: str) -> list[NodeRun]:
        self.get_run(run_id)
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM node_runs WHERE workflow_run_id = %s ORDER BY started_at",
                (run_id,),
            ).fetchall()
        result: list[NodeRun] = []
        for row in rows:
            values = dict(row)
            values["input"] = json.loads(values.pop("input_json"))
            output = values.pop("output_json")
            values["output"] = json.loads(output) if output else None
            result.append(NodeRun(**values))
        return result

    def _event(
        self,
        run_id: str,
        sequence: int,
        event_type: str,
        node_id: str | None,
        data: dict,
    ) -> WorkflowEvent:
        event = WorkflowEvent(
            workflow_run_id=run_id,
            sequence=sequence,
            type=event_type,
            node_id=node_id,
            data=data,
            created_at=now(),
        )
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO workflow_events
                   (workflow_run_id, sequence, type, node_id, data_json, created_at)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (
                    run_id,
                    sequence,
                    event_type,
                    node_id,
                    json.dumps(data, ensure_ascii=False),
                    event.created_at.isoformat(),
                ),
            )
        return event

    def _get_app(self, app_id: str) -> dict:
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM apps WHERE id = %s", (app_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"App {app_id} not found")
        values = dict(row)
        values["draft"] = DraftDefinition.model_validate_json(values.pop("draft_json"))
        return values

    def _validate_provider(self, workspace_id: str, config_id: str) -> None:
        with self.database.connect() as connection:
            row = connection.execute(
                """SELECT 1 FROM model_provider_configs
                   WHERE id = %s AND workspace_id = %s""",
                (config_id, workspace_id),
            ).fetchone()
        if row is None:
            raise WorkflowValidationError(["LLM 节点引用的模型配置不存在或不属于当前空间"])
