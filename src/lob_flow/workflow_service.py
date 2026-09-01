from __future__ import annotations

import json
import psycopg
import hashlib
import secrets
import re
from collections.abc import Iterator
from time import monotonic
from uuid import uuid4

from lob_flow.database import Database
from lob_flow.dify_daemon import DifyDaemonClient
from lob_flow.encryption import CredentialCipher
from lob_flow.models import (
    DraftDefinition,
    ModelConfig,
    NodeRun,
    WorkflowDefinition,
    WorkflowDraft,
    WorkflowEvent,
    WorkflowRun,
    ServiceApiKey,
    ServiceApiKeyCreated,
    PluginCredential,
    PluginCredentialCreate,
    WorkflowVersion,
    PluginRuntimeState,
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
        self.cipher = CredentialCipher.from_env()

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
        self._get_app(app_id)
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

    def stream_run(self, app_id: str, user_input: str | dict, trigger_source: str = "debug", use_published: bool = False, start_node_id: str | None = None) -> Iterator[WorkflowEvent]:
        app = self._get_app(app_id)
        version = self.get_latest_version(app_id) if use_published else None
        if use_published and version is None:
            raise WorkflowValidationError(["应用尚未发布工作流版本"])
        definition = version.definition if version else self.get_draft(app_id).definition
        ordered = validate_and_sort(definition)
        start = next(node for node in ordered if node.type == "start")
        start_inputs, input_text = self._normalize_inputs(start, user_input)
        if start_node_id:
            index = next((i for i, node in enumerate(ordered) if node.id == start_node_id), -1)
            if index < 0:
                raise WorkflowValidationError([f"节点 {start_node_id} 不存在"])
            ordered = [ordered[index]]
        run_id = str(uuid4())
        created_at = now()
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO workflow_runs
                   (id, app_id, status, input, inputs_json, definition_snapshot_json, created_at, trigger_source, workflow_version_id)
                   VALUES (%s, %s, 'running', %s, %s, %s, %s, %s, %s)""",
                (
                    run_id,
                    app_id,
                    input_text,
                    json.dumps(start_inputs, ensure_ascii=False),
                    definition.model_dump_json(),
                    created_at.isoformat(),
                    trigger_source,
                    version.id if version else None,
                ),
            )
        sequence = 1
        yield self._event(run_id, sequence, "workflow_started", None, {"input": input_text, "inputs": start_inputs})
        incoming_edges: dict[str, list] = {node.id: [] for node in ordered}
        for edge in definition.edges:
            if edge.target in incoming_edges:
                incoming_edges[edge.target].append(edge)
        node_values: dict[str, str] = {}
        active_nodes: set[str] = set()
        branch_results: dict[str, str] = {}
        value = input_text
        run_started = monotonic()
        current_node_id: str | None = None
        current_node_run_id: str | None = None

        try:
            for node in ordered:
                if node.type == "start" or (start_node_id and node.id == start_node_id):
                    value = input_text
                else:
                    active_edges = [edge for edge in incoming_edges[node.id] if edge.source in active_nodes and (edge.source_handle is None or branch_results.get(edge.source) == edge.source_handle)]
                    if not active_edges:
                        continue
                    upstream_values = [node_values[edge.source] for edge in active_edges if edge.source in node_values]
                    if not upstream_values:
                        upstream_values = [value]
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
                    value = self._resolve_text(str(node.config["template"]), value, node_values, start_inputs)
                elif node.type == "llm":
                    definition = DraftDefinition(
                        system_prompt=self._resolve_text(str(node.config.get("system_prompt", "")), value, node_values, start_inputs),
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
                        node.config.get("parameters", {}), value, node_values, start_inputs
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
                            self.resolve_plugin_credentials(app["workspace_id"], node.config),
                        )
                        node_values[node.id] = value
                        active_nodes.add(node.id)
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
                    query = self._resolve_text(str(node.config.get("query", "{input}")), value, node_values, start_inputs)
                    response = self.knowledge_service.retrieve(
                        str(node.config["dataset_id"]),
                        RetrievalRequest(
                            query=query,
                            top_k=int(node.config.get("top_k", 3)),
                            score_threshold=float(node.config.get("score_threshold", 0)),
                        ),
                    )
                    context = "\n\n".join(
                        f"[知识片段 {index} | {item.document_name} | score {item.score:.4f}]\n{item.content}"
                        for index, item in enumerate(response.results, 1)
                    )
                    value = f"用户问题：{query}\n\n检索到的知识：\n{context or '未检索到相关知识片段'}"
                elif node.type == "condition":
                    left = self._resolve_text(str(node.config.get("left", "")), value, node_values, start_inputs)
                    right = self._resolve_text(str(node.config.get("right", "")), value, node_values, start_inputs)
                    matched = self._evaluate_condition(left, str(node.config.get("operator")), right)
                    branch_results[node.id] = "true" if matched else "false"
                    value = left
                elif node.type == "switch":
                    expression = self._resolve_text(str(node.config.get("expression", "")), value, node_values, start_inputs)
                    matched_case = next((item for item in node.config.get("cases", []) if str(item.get("value", "")) == expression), None)
                    branch_results[node.id] = str(matched_case["id"]) if matched_case else "default"
                    value = expression

                node_values[node.id] = value
                active_nodes.add(node.id)

                node_duration = int((monotonic() - node_started) * 1000)
                node_output = {"value": value, **({"branch": branch_results[node.id]} if node.type in ("condition", "switch") else {})}
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
                    {"output": node_output, "duration_ms": node_duration, **({"branch": branch_results[node.id]} if node.type in ("condition", "switch") else {})},
                )
                current_node_id = None
                current_node_run_id = None

            answer_nodes = [node for node in ordered if node.type == "answer"]
            if answer_nodes:
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
        values["inputs"] = json.loads(values.pop("inputs_json", "{}"))
        return WorkflowRun(**values)

    def list_runs(self, app_id: str, limit: int = 100) -> list[WorkflowRun]:
        self._get_app(app_id)
        with self.database.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM workflow_runs WHERE app_id = %s ORDER BY created_at DESC LIMIT %s",
                (app_id, max(1, min(limit, 500))),
            ).fetchall()
        result: list[WorkflowRun] = []
        for row in rows:
            values = dict(row)
            values["definition_snapshot"] = WorkflowDefinition.model_validate_json(values.pop("definition_snapshot_json"))
            values["inputs"] = json.loads(values.pop("inputs_json", "{}"))
            result.append(WorkflowRun(**values))
        return result

    def publish(self, app_id: str) -> WorkflowVersion:
        draft = self.get_draft(app_id)
        validate_and_sort(draft.definition)
        app = self._get_app(app_id)
        for node in draft.definition.nodes:
            if node.type == "llm":
                self._validate_provider(app["workspace_id"], node.config["provider_config_id"])
            elif node.type == "knowledge":
                self._validate_dataset(app["workspace_id"], str(node.config["dataset_id"]))
        timestamp = now()
        with self.database.connect() as connection:
            row = connection.execute("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM workflow_versions WHERE app_id = %s", (app_id,)).fetchone()
            item = WorkflowVersion(id=str(uuid4()), app_id=app_id, version=int(row["version"]), definition=draft.definition, created_at=timestamp)
            connection.execute("INSERT INTO workflow_versions (id, app_id, version, definition_json, created_at) VALUES (%s, %s, %s, %s, %s)", (item.id, app_id, item.version, item.definition.model_dump_json(), timestamp.isoformat()))
        return item

    def list_versions(self, app_id: str) -> list[WorkflowVersion]:
        self._get_app(app_id)
        with self.database.connect() as connection:
            rows = connection.execute("SELECT * FROM workflow_versions WHERE app_id = %s ORDER BY version DESC", (app_id,)).fetchall()
        return [WorkflowVersion(id=row["id"], app_id=row["app_id"], version=row["version"], definition=WorkflowDefinition.model_validate_json(row["definition_json"]), created_at=row["created_at"]) for row in rows]

    def get_latest_version(self, app_id: str) -> WorkflowVersion | None:
        versions = self.list_versions(app_id)
        return versions[0] if versions else None

    def rollback(self, app_id: str, version_id: str) -> WorkflowDraft:
        with self.database.connect() as connection:
            row = connection.execute("SELECT definition_json FROM workflow_versions WHERE id = %s AND app_id = %s", (version_id, app_id)).fetchone()
        if row is None:
            raise NotFoundError("Workflow version not found")
        return self.update_draft(app_id, WorkflowDefinition.model_validate_json(row["definition_json"]))

    def create_plugin_credential(self, workspace_id: str, request: PluginCredentialCreate) -> PluginCredential:
        timestamp = now()
        item = PluginCredential(id=str(uuid4()), workspace_id=workspace_id, plugin_id=request.plugin_id, name=request.name, created_at=timestamp, updated_at=timestamp)
        encrypted = self.cipher.encrypt(json.dumps(request.credentials, ensure_ascii=False))
        with self.database.connect() as connection:
            connection.execute("INSERT INTO plugin_credentials (id, workspace_id, plugin_id, name, credentials_encrypted, created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s, %s)", (item.id, workspace_id, item.plugin_id, item.name, encrypted, timestamp.isoformat(), timestamp.isoformat()))
        return item

    def list_plugin_credentials(self, workspace_id: str, plugin_id: str = "") -> list[PluginCredential]:
        query = "SELECT id, workspace_id, plugin_id, name, created_at, updated_at FROM plugin_credentials WHERE workspace_id = %s"
        params: tuple = (workspace_id,)
        if plugin_id:
            query += " AND plugin_id = %s"
            params = (workspace_id, plugin_id)
        with self.database.connect() as connection:
            rows = connection.execute(query + " ORDER BY created_at DESC", params).fetchall()
        return [PluginCredential(**dict(row)) for row in rows]

    def delete_plugin_credential(self, workspace_id: str, credential_id: str) -> None:
        with self.database.connect() as connection:
            row = connection.execute("DELETE FROM plugin_credentials WHERE id = %s AND workspace_id = %s RETURNING id", (credential_id, workspace_id)).fetchone()
        if row is None:
            raise NotFoundError("Plugin credential not found")

    def resolve_plugin_credentials(self, workspace_id: str, config: dict) -> dict:
        with self.database.connect() as connection:
            state = connection.execute("SELECT enabled FROM plugin_runtime_states WHERE workspace_id = %s AND plugin_id = %s", (workspace_id, str(config.get("plugin_id") or ""))).fetchone()
        if state is not None and not state["enabled"]:
            raise PluginExecutionError("插件已停用")
        credential_id = str(config.get("credential_id") or "")
        if credential_id:
            with self.database.connect() as connection:
                row = connection.execute("SELECT credentials_encrypted FROM plugin_credentials WHERE id = %s AND workspace_id = %s", (credential_id, workspace_id)).fetchone()
            if row is None:
                raise PluginExecutionError("插件授权不存在或已删除")
            return json.loads(self.cipher.decrypt(row["credentials_encrypted"]))
        return dict(config.get("credentials") or {})

    def set_plugin_runtime_state(self, workspace_id: str, plugin_id: str, enabled: bool) -> PluginRuntimeState:
        timestamp = now()
        with self.database.connect() as connection:
            connection.execute("INSERT INTO plugin_runtime_states (workspace_id, plugin_id, enabled, updated_at) VALUES (%s, %s, %s, %s) ON CONFLICT (workspace_id, plugin_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at", (workspace_id, plugin_id, enabled, timestamp.isoformat()))
        return PluginRuntimeState(workspace_id=workspace_id, plugin_id=plugin_id, enabled=enabled, updated_at=timestamp)

    def list_plugin_runtime_states(self, workspace_id: str) -> list[PluginRuntimeState]:
        with self.database.connect() as connection:
            rows = connection.execute("SELECT * FROM plugin_runtime_states WHERE workspace_id = %s", (workspace_id,)).fetchall()
        return [PluginRuntimeState(**dict(row)) for row in rows]

    def migrate_inline_credentials(self) -> None:
        with self.database.connect() as connection:
            rows = connection.execute("SELECT draft.app_id, app.workspace_id, draft.definition_json FROM workflow_drafts draft JOIN apps app ON app.id = draft.app_id").fetchall()
        for row in rows:
            definition = WorkflowDefinition.model_validate_json(row["definition_json"])
            changed = False
            for node in definition.nodes:
                credentials = node.config.get("credentials")
                if node.type != "tool" or not credentials or node.config.get("credential_id"):
                    continue
                item = self.create_plugin_credential(row["workspace_id"], PluginCredentialCreate(plugin_id=str(node.config.get("plugin_id", "")), name=f"{node.name} 授权", credentials=dict(credentials)))
                node.config["credential_id"] = item.id
                node.config.pop("credentials", None)
                changed = True
            if changed:
                self.update_draft(row["app_id"], definition)

    def create_api_key(self, app_id: str, name: str) -> ServiceApiKeyCreated:
        self._get_app(app_id)
        token = f"lob-{secrets.token_urlsafe(32)}"
        item = ServiceApiKeyCreated(id=str(uuid4()), app_id=app_id, name=name, key_prefix=token[:12], api_key=token, created_at=now())
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO service_api_keys (id, app_id, name, key_prefix, key_hash, created_at) VALUES (%s, %s, %s, %s, %s, %s)",
                (item.id, app_id, name, item.key_prefix, hashlib.sha256(token.encode()).hexdigest(), item.created_at.isoformat()),
            )
        return item

    def list_api_keys(self, app_id: str) -> list[ServiceApiKey]:
        self._get_app(app_id)
        with self.database.connect() as connection:
            rows = connection.execute("SELECT id, app_id, name, key_prefix, created_at, last_used_at FROM service_api_keys WHERE app_id = %s ORDER BY created_at DESC", (app_id,)).fetchall()
        return [ServiceApiKey(**dict(row)) for row in rows]

    def delete_api_key(self, app_id: str, key_id: str) -> None:
        with self.database.connect() as connection:
            result = connection.execute("DELETE FROM service_api_keys WHERE id = %s AND app_id = %s", (key_id, app_id))
            if result.rowcount == 0:
                raise NotFoundError("API Key not found")

    def authenticate_api_key(self, token: str) -> str:
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.database.connect() as connection:
            row = connection.execute("SELECT id, app_id FROM service_api_keys WHERE key_hash = %s", (digest,)).fetchone()
            if row:
                connection.execute("UPDATE service_api_keys SET last_used_at = %s WHERE id = %s", (now().isoformat(), row["id"]))
        if row is None:
            raise NotFoundError("Invalid API Key")
        return str(row["app_id"])

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

    def retry_run(self, run_id: str) -> WorkflowRun:
        previous = self.get_run(run_id)
        events = list(self.stream_run(previous.app_id, previous.inputs or previous.input, "retry"))
        return self.get_run(events[0].workflow_run_id)

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
        if event_type == "node_delta":
            return event
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
    def _normalize_inputs(start: object, payload: str | dict) -> tuple[dict, str]:
        variables = getattr(start, "config", {}).get("variables", [])
        raw = payload if isinstance(payload, dict) else {"input": payload}
        if not variables:
            text = str(raw.get("input", payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)))
            return raw, text
        result: dict = {}
        errors: list[str] = []
        for variable in variables:
            name = str(variable["name"])
            value = raw.get(name, variable.get("default"))
            if value in (None, "") and variable.get("required"):
                errors.append(f"缺少必填输入：{variable.get('label') or name}")
                continue
            if value in (None, ""):
                result[name] = value
                continue
            try:
                if variable["type"] == "number":
                    value = float(value) if "." in str(value) else int(value)
                elif variable["type"] == "boolean":
                    if isinstance(value, str):
                        if value.lower() not in ("true", "false"):
                            raise ValueError
                        value = value.lower() == "true"
                    else:
                        value = bool(value)
                else:
                    value = str(value)
            except (TypeError, ValueError):
                errors.append(f"输入类型错误：{variable.get('label') or name}")
            result[name] = value
        if errors:
            raise WorkflowValidationError(errors)
        text = str(result.get("input")) if set(result) == {"input"} else json.dumps(result, ensure_ascii=False)
        return result, text

    @staticmethod
    def _resolve_text(text: str, value: str, node_values: dict[str, str] | None = None, start_inputs: dict | None = None) -> str:
        references = node_values or {}
        inputs = start_inputs or {}
        result = text.replace("{input}", value)

        def replace_variable(match: re.Match[str]) -> str:
            node_id, field = match.group(1), match.group(2)
            if node_id == "start":
                item = inputs.get(field, "")
                return item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)
            node_value = references.get(node_id, "")
            if field in ("output", "value"):
                return node_value
            if field.startswith("output."):
                try:
                    current = json.loads(node_value)
                    for part in field[7:].split("."):
                        current = current[int(part)] if isinstance(current, list) else current[part]
                    return current if isinstance(current, str) else json.dumps(current, ensure_ascii=False)
                except (json.JSONDecodeError, KeyError, IndexError, TypeError, ValueError):
                    return ""
            return ""

        result = re.sub(r"\{\{([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\}\}", replace_variable, result)
        for node_id, node_value in references.items():
            result = result.replace(f"{{{node_id}}}", node_value)
        return result

    @staticmethod
    def _resolve_parameters(parameters: dict, value: str, node_values: dict[str, str] | None = None, start_inputs: dict | None = None) -> dict:
        references = node_values or {}

        def resolve(item):
            if isinstance(item, str):
                result = WorkflowService._resolve_text(item, value, references, start_inputs)
                for node_id, node_value in references.items():
                    prefix = f"{{{node_id}."
                    while prefix in result:
                        start = result.index(prefix)
                        end = result.find("}", start)
                        if end < 0:
                            break
                        path = result[start + len(prefix):end]
                        try:
                            current = json.loads(node_value)
                            for part in path.split("."):
                                current = current[int(part)] if isinstance(current, list) else current[part]
                            replacement = current if isinstance(current, str) else json.dumps(current, ensure_ascii=False)
                        except (json.JSONDecodeError, KeyError, IndexError, TypeError, ValueError):
                            replacement = ""
                        result = result[:start] + str(replacement) + result[end + 1:]
                return result
            if isinstance(item, dict):
                return {key: resolve(child) for key, child in item.items()}
            if isinstance(item, list):
                return [resolve(child) for child in item]
            return item
        return resolve(parameters)

    @staticmethod
    def _evaluate_condition(left: str, operator: str, right: str = "") -> bool:
        if operator == "is_empty":
            return not left.strip()
        if operator == "is_not_empty":
            return bool(left.strip())
        if operator in ("greater_than", "less_than"):
            try:
                left_number, right_number = float(left), float(right)
            except ValueError:
                return False
            return left_number > right_number if operator == "greater_than" else left_number < right_number
        if operator == "contains":
            return right in left
        if operator == "not_contains":
            return right not in left
        if operator == "not_equals":
            return left != right
        return left == right
