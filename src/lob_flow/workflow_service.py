from __future__ import annotations

import json
import psycopg
from collections.abc import Iterator
from time import monotonic
from uuid import uuid4

from lob_flow.database import Database
from lob_flow.dify_daemon import DifyDaemonClient
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
from lob_flow.plugin_service import PluginExecutionError, PluginService
from lob_flow.knowledge_service import KnowledgeService
from lob_flow.models import RetrievalRequest
from lob_flow.service import NotFoundError, now
from lob_flow.workflow import WorkflowValidationError, default_workflow, validate_and_sort


class WorkflowService:
    def __init__(self, database: Database, model_gateway: ModelGateway) -> None:
        self.database = database
        self.model_gateway = model_gateway
        self.plugin_service: PluginService | None = None
        self.knowledge_service: KnowledgeService | None = None
        self.dify_daemon: DifyDaemonClient | None = None

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
            elif node.type == "knowledge":
                self._validate_dataset(app["workspace_id"], str(node.config["dataset_id"]))
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
        predecessors: dict[str, list[str]] = {node.id: [] for node in ordered}
        for edge in draft.definition.edges:
            predecessors[edge.target].append(edge.source)
        node_values: dict[str, str] = {}
        value = user_input
        run_started = monotonic()
        current_node_id: str | None = None
        current_node_run_id: str | None = None

        try:
            for node in ordered:
                if node.type == "start":
                    value = user_input
                else:
                    upstream_values = [node_values[node_id] for node_id in predecessors[node.id]]
                    value = upstream_values[0] if len(upstream_values) == 1 else "\n".join(upstream_values)
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
                elif node.type == "tool":
                    parameters = self._resolve_parameters(
                        node.config.get("parameters", {}), value
                    )
                    if node.config.get("runtime") == "dify":
                        if self.dify_daemon is None:
                            raise PluginExecutionError("Dify Plugin Daemon is unavailable")
                        value = self.dify_daemon.invoke_installed_tool(
                            app["workspace_id"],
                            str(node.config["plugin_id"]),
                            str(node.config["provider_name"]),
                            str(node.config["tool_name"]),
                            parameters,
                        )
                        node_values[node.id] = value
                        node_duration = int((monotonic() - node_started) * 1000)
                        node_output = {"value": value}
                        with self.database.connect() as connection:
                            connection.execute(
                                """UPDATE node_runs SET status = 'succeeded', output_json = %s,
                                   finished_at = %s, duration_ms = %s WHERE id = %s""",
                                (json.dumps(node_output, ensure_ascii=False), now().isoformat(), node_duration, node_run_id),
                            )
                        sequence += 1
                        yield self._event(run_id, sequence, "node_succeeded", node.id, {"output": node_output, "duration_ms": node_duration})
                        current_node_id = None
                        current_node_run_id = None
                        continue
                    if self.plugin_service is None:
                        raise PluginExecutionError("Plugin service is unavailable")
                    invocation_id = str(uuid4())
                    invocation_started = now()
                    invocation_clock = monotonic()
                    result = self.plugin_service.execute(
                        app["workspace_id"],
                        node.config["plugin_id"],
                        node.config["tool_name"],
                        parameters,
                    )
                    value = result.value
                    with self.database.connect() as connection:
                        connection.execute(
                            """INSERT INTO tool_invocations
                               (id, workflow_run_id, node_id, installation_id, plugin_id,
                                tool_name, status, input_json, output_json, started_at,
                                finished_at, duration_ms)
                               VALUES (%s, %s, %s, %s, %s, %s, 'succeeded', %s, %s, %s, %s, %s)""",
                            (
                                invocation_id, run_id, node.id, result.installation_id,
                                node.config["plugin_id"], node.config["tool_name"],
                                json.dumps(parameters, ensure_ascii=False),
                                json.dumps({"value": value}, ensure_ascii=False),
                                invocation_started.isoformat(), now().isoformat(),
                                int((monotonic() - invocation_clock) * 1000),
                            ),
                        )
                elif node.type == "knowledge":
                    if self.knowledge_service is None:
                        raise RuntimeError("Knowledge service is unavailable")
                    query = str(node.config.get("query", "{input}")).replace("{input}", value)
                    response = self.knowledge_service.retrieve(
                        str(node.config["dataset_id"]),
                        RetrievalRequest(
                            query=query,
                            top_k=int(node.config.get("top_k", 3)),
                            score_threshold=float(node.config.get("score_threshold", 0)),
                        ),
                    )
                    value = "\n\n".join(
                        f"[知识片段 {index} | {item.document_name} | score {item.score:.4f}]\n{item.content}"
                        for index, item in enumerate(response.results, 1)
                    )

                node_values[node.id] = value

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

            answer_nodes = [node for node in ordered if node.type == "answer"]
            value = node_values[answer_nodes[-1].id]
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
            is_database_error = isinstance(exc, psycopg.OperationalError)
            error_code = "database_unavailable" if is_database_error else (
                exc.code if isinstance(exc, ProviderError) else (
                    "plugin_error" if isinstance(exc, PluginExecutionError) else "workflow_error"
                )
            )
            error_message = (
                "PostgreSQL 连接暂时中断，工作流已停止，请稍后重新运行。"
                if is_database_error else str(exc)
            )
            duration = int((monotonic() - run_started) * 1000)
            try:
                with self.database.connect() as connection:
                    if current_node_run_id:
                        connection.execute(
                            """UPDATE node_runs
                               SET status = 'failed', error = %s, finished_at = %s
                               WHERE id = %s""",
                            (error_message, now().isoformat(), current_node_run_id),
                        )
                    connection.execute(
                        """UPDATE workflow_runs
                           SET status = 'failed', error = %s, error_code = %s,
                               finished_at = %s, duration_ms = %s WHERE id = %s""",
                        (error_message, error_code, now().isoformat(), duration, run_id),
                    )
            except psycopg.OperationalError:
                pass
            sequence += 1
            if current_node_id:
                yield self._event(
                    run_id,
                    sequence,
                    "node_failed",
                    current_node_id,
                    {"error": error_message, "error_code": error_code},
                )
                sequence += 1
            yield self._event(
                run_id,
                sequence,
                "workflow_failed",
                None,
                {"error": error_message, "error_code": error_code, "duration_ms": duration},
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
        try:
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
        except psycopg.OperationalError:
            pass
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

    def _validate_dataset(self, workspace_id: str, dataset_id: str) -> None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM datasets WHERE id = %s AND workspace_id = %s",
                (dataset_id, workspace_id),
            ).fetchone()
        if row is None:
            raise WorkflowValidationError(["Knowledge 节点引用的知识库不存在或不属于当前空间"])

    @staticmethod
    def _resolve_parameters(parameters: dict, value: str) -> dict:
        def resolve(item):
            if isinstance(item, str):
                return item.replace("{input}", value)
            if isinstance(item, dict):
                return {key: resolve(child) for key, child in item.items()}
            if isinstance(item, list):
                return [resolve(child) for child in item]
            return item
        return resolve(parameters)
