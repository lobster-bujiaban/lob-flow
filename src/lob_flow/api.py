from __future__ import annotations

import json
import psycopg
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from lob_flow.database import Database
from lob_flow.dify_daemon import DifyDaemonClient, DifyDaemonError
from lob_flow.dify_marketplace import DifyMarketplaceClient
from lob_flow.knowledge_service import KnowledgeService
from lob_flow.models import (
    App,
    AppCreate,
    AppUpdate,
    DraftDefinition,
    ModelProviderConfig,
    ModelProviderConfigCreate,
    ModelProviderConfigUpdate,
    ModelProviderSecret,
    PluginCatalogItem,
    PluginEnableRequest,
    PluginInstallRequest,
    PluginInstallation,
    Run,
    RunCreate,
    RunEvent,
    NodeRun,
    WorkflowDefinition,
    WorkflowDraft,
    WorkflowEvent,
    WorkflowRun,
    WorkflowRunCreate,
    ServiceApiKey,
    ServiceApiKeyCreate,
    ServiceApiKeyCreated,
    Workspace,
    WorkspaceCreate,
    Dataset, DatasetCreate, DatasetDocument, DocumentCreate, DocumentSegment,
    EnableRequest, RetrievalRequest, RetrievalResponse, SegmentUpdate,
)
from lob_flow.plugin_service import PluginService
from lob_flow.service import FlowService, NotFoundError
from lob_flow.workflow import WorkflowValidationError
from lob_flow.workflow_service import WorkflowService


def create_app(database: Database | None = None) -> FastAPI:
    database = database or Database.from_env()
    service = FlowService(database)
    workflow_service = WorkflowService(database, service.model_gateway)
    knowledge_service = KnowledgeService(database)
    plugin_service = PluginService(database, service.cipher)
    dify_daemon = DifyDaemonClient.from_env()
    dify_marketplace = DifyMarketplaceClient(dify_daemon)
    workflow_service.plugin_service = plugin_service
    workflow_service.knowledge_service = knowledge_service
    workflow_service.dify_daemon = dify_daemon
    web_dist = Path(__file__).resolve().parents[2] / "web" / "dist"

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        database.initialize()
        plugin_service.ensure_catalog()
        yield

    application = FastAPI(title="LOB Flow", version="0.1.0", lifespan=lifespan)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.state.service = service

    @application.exception_handler(NotFoundError)
    async def not_found_handler(_, exc: NotFoundError):
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @application.exception_handler(WorkflowValidationError)
    async def workflow_validation_handler(_, exc: WorkflowValidationError):
        return JSONResponse(status_code=422, content={"detail": exc.errors})

    @application.exception_handler(DifyDaemonError)
    async def dify_daemon_handler(_, exc: DifyDaemonError):
        message = str(exc)
        if "no such file" in message.lower():
            message = "插件安装包临时文件不存在，请重新点击安装；如果仍然失败，请重启 Plugin Daemon 后重试。"
        return JSONResponse(status_code=502, content={"detail": message})

    @application.exception_handler(psycopg.OperationalError)
    async def database_connection_handler(_, exc: psycopg.OperationalError):
        return JSONResponse(
            status_code=503,
            content={"detail": "PostgreSQL 连接暂时中断，系统已自动重试，请稍后再次操作。"},
        )

    @application.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/", include_in_schema=False, response_model=None)
    def index() -> FileResponse | RedirectResponse:
        if (web_dist / "index.html").exists():
            return FileResponse(web_dist / "index.html")
        return RedirectResponse(url="/docs")

    @application.post("/api/workspaces", response_model=Workspace, status_code=201)
    def create_workspace(request: WorkspaceCreate) -> Workspace:
        return service.create_workspace(request)

    @application.get("/api/workspaces", response_model=list[Workspace])
    def list_workspaces() -> list[Workspace]:
        return service.list_workspaces()

    @application.delete("/api/workspaces/{workspace_id}", status_code=204)
    def delete_workspace(workspace_id: str) -> None:
        service.delete_workspace(workspace_id)

    @application.post(
        "/api/workspaces/{workspace_id}/apps", response_model=App, status_code=201
    )
    def create_chat_app(workspace_id: str, request: AppCreate) -> App:
        return service.create_app(workspace_id, request)

    @application.get("/api/workspaces/{workspace_id}/apps", response_model=list[App])
    def list_apps(workspace_id: str) -> list[App]:
        return service.list_apps(workspace_id)

    @application.get("/api/workspaces/{workspace_id}/datasets", response_model=list[Dataset])
    def list_datasets(workspace_id: str) -> list[Dataset]:
        service.get_workspace(workspace_id)
        return knowledge_service.list_datasets(workspace_id)

    @application.post("/api/workspaces/{workspace_id}/datasets", response_model=Dataset, status_code=201)
    def create_dataset(workspace_id: str, request: DatasetCreate) -> Dataset:
        return knowledge_service.create_dataset(workspace_id, request)

    @application.get("/api/datasets/{dataset_id}", response_model=Dataset)
    def get_dataset(dataset_id: str) -> Dataset:
        return knowledge_service.get_dataset(dataset_id)

    @application.delete("/api/datasets/{dataset_id}", status_code=204)
    def delete_dataset(dataset_id: str) -> None:
        knowledge_service.delete_dataset(dataset_id)

    @application.get("/api/datasets/{dataset_id}/documents", response_model=list[DatasetDocument])
    def list_documents(dataset_id: str) -> list[DatasetDocument]:
        return knowledge_service.list_documents(dataset_id)

    @application.post("/api/datasets/{dataset_id}/documents", response_model=DatasetDocument, status_code=201)
    def add_document(dataset_id: str, request: DocumentCreate) -> DatasetDocument:
        return knowledge_service.add_document(dataset_id, request)

    @application.put("/api/documents/{document_id}/enabled", response_model=DatasetDocument)
    def enable_document(document_id: str, request: EnableRequest) -> DatasetDocument:
        return knowledge_service.set_document_enabled(document_id, request.enabled)

    @application.delete("/api/documents/{document_id}", status_code=204)
    def delete_document(document_id: str) -> None:
        knowledge_service.delete_document(document_id)

    @application.get("/api/documents/{document_id}/segments", response_model=list[DocumentSegment])
    def list_segments(document_id: str) -> list[DocumentSegment]:
        return knowledge_service.list_segments(document_id)

    @application.put("/api/segments/{segment_id}", response_model=DocumentSegment)
    def update_segment(segment_id: str, request: SegmentUpdate) -> DocumentSegment:
        return knowledge_service.update_segment(segment_id, request)

    @application.put("/api/segments/{segment_id}/enabled", response_model=DocumentSegment)
    def enable_segment(segment_id: str, request: EnableRequest) -> DocumentSegment:
        return knowledge_service.set_segment_enabled(segment_id, request.enabled)

    @application.post("/api/datasets/{dataset_id}/retrieve", response_model=RetrievalResponse)
    def retrieve_dataset(dataset_id: str, request: RetrievalRequest) -> RetrievalResponse:
        return knowledge_service.retrieve(dataset_id, request)

    @application.get(
        "/api/workspaces/{workspace_id}/model-provider-configs",
        response_model=list[ModelProviderConfig],
    )
    def list_model_provider_configs(workspace_id: str) -> list[ModelProviderConfig]:
        return service.list_model_provider_configs(workspace_id)

    @application.get(
        "/api/workspaces/{workspace_id}/model-provider-configs/{config_id}/secret",
        response_model=ModelProviderSecret,
    )
    def get_model_provider_secret(
        workspace_id: str, config_id: str
    ) -> ModelProviderSecret:
        return service.get_model_provider_secret(workspace_id, config_id)

    @application.post(
        "/api/workspaces/{workspace_id}/model-provider-configs",
        response_model=ModelProviderConfig,
        status_code=201,
    )
    def create_model_provider_config(
        workspace_id: str, request: ModelProviderConfigCreate
    ) -> ModelProviderConfig:
        return service.create_model_provider_config(workspace_id, request)

    @application.put(
        "/api/workspaces/{workspace_id}/model-provider-configs/{config_id}",
        response_model=ModelProviderConfig,
    )
    def update_model_provider_config(
        workspace_id: str,
        config_id: str,
        request: ModelProviderConfigUpdate,
    ) -> ModelProviderConfig:
        return service.update_model_provider_config(workspace_id, config_id, request)

    @application.get(
        "/api/workspaces/{workspace_id}/plugins",
        response_model=list[PluginCatalogItem],
    )
    def plugin_marketplace(workspace_id: str) -> list[PluginCatalogItem]:
        service.get_workspace(workspace_id)
        return plugin_service.marketplace(workspace_id)

    @application.get("/api/dify-plugin-daemon/status")
    def dify_plugin_daemon_status() -> dict[str, bool]:
        return {"available": dify_daemon.available()}

    @application.get("/api/workspaces/{workspace_id}/dify-plugins/installed")
    def installed_dify_plugins(workspace_id: str) -> dict[str, list[str]]:
        return {"plugin_ids": dify_daemon.installed_plugin_ids(workspace_id)}

    @application.get("/api/workspaces/{workspace_id}/dify-tools")
    def installed_dify_tools(workspace_id: str) -> list[dict]:
        return dify_daemon.normalized_tools(workspace_id)

    @application.get("/api/dify-marketplace/plugins")
    def explore_dify_marketplace(q: str = "", limit: int = 60) -> list[dict]:
        return dify_marketplace.explore(q, limit)

    @application.get("/api/dify-marketplace/icons/{icon_path:path}", response_model=None)
    def dify_marketplace_icon(icon_path: str) -> Response:
        content, media_type = dify_marketplace.load_icon(icon_path)
        return Response(
            content=content,
            media_type=media_type,
            headers={"Cache-Control": "public, max-age=14400"},
        )

    @application.post("/api/workspaces/{workspace_id}/dify-marketplace/install")
    def install_dify_marketplace_plugin(workspace_id: str, request: dict) -> dict:
        service.get_workspace(workspace_id)
        identifier = str(request.get("identifier", ""))
        if not identifier:
            return JSONResponse(status_code=422, content={"detail": "缺少插件 identifier"})
        return dify_marketplace.install(workspace_id, identifier)

    @application.post("/api/workspaces/{workspace_id}/dify-plugins/upload")
    async def upload_dify_plugin(workspace_id: str, request: Request) -> dict:
        service.get_workspace(workspace_id)
        package = await request.body()
        if not package or len(package) > 52_428_800:
            return JSONResponse(status_code=422, content={"detail": "difypkg 大小必须在 1B 到 50MB 之间"})
        decoded = dify_daemon.upload_package(workspace_id, package)
        data = decoded.get("data", decoded)
        identifier = data.get("unique_identifier") if isinstance(data, dict) else None
        if not identifier:
            raise DifyDaemonError("Daemon 未返回 plugin unique identifier")
        installation = dify_daemon.install_identifier(workspace_id, str(identifier))
        return {"identifier": identifier, "decode": data, "installation": installation.get("data", installation)}

    @application.post(
        "/api/workspaces/{workspace_id}/plugins/{plugin_id:path}/install",
        response_model=PluginInstallation,
    )
    def install_plugin(
        workspace_id: str, plugin_id: str, request: PluginInstallRequest
    ) -> PluginInstallation:
        service.get_workspace(workspace_id)
        return plugin_service.install(workspace_id, plugin_id, request)

    @application.put(
        "/api/workspaces/{workspace_id}/plugins/{plugin_id:path}/enabled",
        response_model=PluginInstallation,
    )
    def enable_plugin(
        workspace_id: str, plugin_id: str, request: PluginEnableRequest
    ) -> PluginInstallation:
        return plugin_service.set_enabled(workspace_id, plugin_id, request.enabled)

    @application.delete(
        "/api/workspaces/{workspace_id}/plugins/{plugin_id:path}", status_code=204
    )
    def uninstall_plugin(workspace_id: str, plugin_id: str) -> None:
        plugin_service.uninstall(workspace_id, plugin_id)

    @application.get("/api/apps/{app_id}", response_model=App)
    def get_chat_app(app_id: str) -> App:
        return service.get_app(app_id)

    @application.delete("/api/apps/{app_id}", status_code=204)
    def delete_chat_app(app_id: str) -> None:
        service.delete_app(app_id)

    @application.put("/api/apps/{app_id}", response_model=App)
    def update_chat_app(app_id: str, request: AppUpdate) -> App:
        return service.update_app(app_id, request)

    @application.post("/api/apps/{app_id}/duplicate", response_model=App, status_code=201)
    def duplicate_chat_app(app_id: str) -> App:
        return service.duplicate_app(app_id)

    @application.put("/api/apps/{app_id}/draft", response_model=App)
    def update_draft(app_id: str, request: DraftDefinition) -> App:
        return service.update_draft(app_id, request)

    @application.post("/api/apps/{app_id}/runs", response_model=Run, status_code=201)
    def run_chat_app(app_id: str, request: RunCreate) -> Run:
        return service.run(app_id, request.input)

    @application.post("/api/apps/{app_id}/runs/stream")
    def stream_chat_app(app_id: str, request: RunCreate) -> StreamingResponse:
        def generate():
            for event in service.stream_run(app_id, request.input):
                payload = json.dumps(event.model_dump(mode="json"), ensure_ascii=False)
                yield f"event: {event.type}\ndata: {payload}\n\n"

        return StreamingResponse(generate(), media_type="text/event-stream")

    @application.get("/api/runs/{run_id}", response_model=Run)
    def get_run(run_id: str) -> Run:
        return service.get_run(run_id)

    @application.get("/api/runs/{run_id}/events", response_model=list[RunEvent])
    def list_run_events(run_id: str) -> list[RunEvent]:
        return service.list_run_events(run_id)

    @application.get("/api/apps/{app_id}/workflow", response_model=WorkflowDraft)
    def get_workflow(app_id: str) -> WorkflowDraft:
        return workflow_service.get_draft(app_id)

    @application.put("/api/apps/{app_id}/workflow", response_model=WorkflowDraft)
    def update_workflow(app_id: str, request: WorkflowDefinition) -> WorkflowDraft:
        return workflow_service.update_draft(app_id, request)

    @application.post("/api/apps/{app_id}/workflow-runs/stream")
    def stream_workflow(app_id: str, request: WorkflowRunCreate) -> StreamingResponse:
        def generate():
            for event in workflow_service.stream_run(app_id, request.input):
                payload = json.dumps(event.model_dump(mode="json"), ensure_ascii=False)
                yield f"event: {event.type}\ndata: {payload}\n\n"

        return StreamingResponse(generate(), media_type="text/event-stream")

    @application.get("/api/apps/{app_id}/workflow-runs", response_model=list[WorkflowRun])
    def list_workflow_runs(app_id: str, limit: int = 100) -> list[WorkflowRun]:
        return workflow_service.list_runs(app_id, limit)

    @application.get("/api/apps/{app_id}/api-keys", response_model=list[ServiceApiKey])
    def list_service_api_keys(app_id: str) -> list[ServiceApiKey]:
        return workflow_service.list_api_keys(app_id)

    @application.post("/api/apps/{app_id}/api-keys", response_model=ServiceApiKeyCreated, status_code=201)
    def create_service_api_key(app_id: str, request: ServiceApiKeyCreate) -> ServiceApiKeyCreated:
        return workflow_service.create_api_key(app_id, request.name)

    @application.delete("/api/apps/{app_id}/api-keys/{key_id}", status_code=204)
    def delete_service_api_key(app_id: str, key_id: str) -> Response:
        workflow_service.delete_api_key(app_id, key_id)
        return Response(status_code=204)

    @application.post("/v1/workflows/run")
    def run_workflow_api(request: WorkflowRunCreate, authorization: str = Header(default="")) -> dict:
        if not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="请在 Authorization Header 中提供 Bearer API Key")
        try:
            app_id = workflow_service.authenticate_api_key(authorization[7:].strip())
        except NotFoundError as exc:
            raise HTTPException(status_code=401, detail="API Key 无效或已被删除") from exc
        events = list(workflow_service.stream_run(app_id, request.input, "api"))
        run = workflow_service.get_run(events[0].workflow_run_id)
        return {"workflow_run_id": run.id, "status": run.status, "output": run.output, "error": run.error, "duration_ms": run.duration_ms}

    @application.get("/api/workflow-runs/{run_id}", response_model=WorkflowRun)
    def get_workflow_run(run_id: str) -> WorkflowRun:
        return workflow_service.get_run(run_id)

    @application.get("/api/workflow-runs/{run_id}/nodes", response_model=list[NodeRun])
    def list_workflow_node_runs(run_id: str) -> list[NodeRun]:
        return workflow_service.list_node_runs(run_id)

    if (web_dist / "assets").exists():
        application.mount("/assets", StaticFiles(directory=web_dist / "assets"), name="web-assets")

    return application


app = create_app(Database())
