from __future__ import annotations

import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from lob_flow.database import Database
from lob_flow.models import (
    App,
    AppCreate,
    DraftDefinition,
    ModelProviderConfig,
    ModelProviderConfigCreate,
    ModelProviderConfigUpdate,
    Run,
    RunCreate,
    RunEvent,
    NodeRun,
    WorkflowDefinition,
    WorkflowDraft,
    WorkflowEvent,
    WorkflowRun,
    WorkflowRunCreate,
    Workspace,
    WorkspaceCreate,
)
from lob_flow.service import FlowService, NotFoundError
from lob_flow.workflow import WorkflowValidationError
from lob_flow.workflow_service import WorkflowService


def create_app(database: Database | None = None) -> FastAPI:
    database = database or Database.from_env()
    service = FlowService(database)
    workflow_service = WorkflowService(database, service.model_gateway)
    web_dist = Path(__file__).resolve().parents[2] / "web" / "dist"

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        database.initialize()
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

    @application.post(
        "/api/workspaces/{workspace_id}/apps", response_model=App, status_code=201
    )
    def create_chat_app(workspace_id: str, request: AppCreate) -> App:
        return service.create_app(workspace_id, request)

    @application.get("/api/workspaces/{workspace_id}/apps", response_model=list[App])
    def list_apps(workspace_id: str) -> list[App]:
        return service.list_apps(workspace_id)

    @application.get(
        "/api/workspaces/{workspace_id}/model-provider-configs",
        response_model=list[ModelProviderConfig],
    )
    def list_model_provider_configs(workspace_id: str) -> list[ModelProviderConfig]:
        return service.list_model_provider_configs(workspace_id)

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

    @application.get("/api/apps/{app_id}", response_model=App)
    def get_chat_app(app_id: str) -> App:
        return service.get_app(app_id)

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
