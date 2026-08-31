from __future__ import annotations

import json
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse

from lob_flow.database import Database
from lob_flow.models import (
    App,
    AppCreate,
    DraftDefinition,
    Run,
    RunCreate,
    RunEvent,
    Workspace,
    WorkspaceCreate,
)
from lob_flow.service import FlowService, NotFoundError


def create_app(database: Database | None = None) -> FastAPI:
    database = database or Database.from_env()
    service = FlowService(database)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        database.initialize()
        yield

    application = FastAPI(title="LOB Flow", version="0.1.0", lifespan=lifespan)
    application.state.service = service

    @application.exception_handler(NotFoundError)
    async def not_found_handler(_, exc: NotFoundError):
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @application.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/", include_in_schema=False)
    def index() -> RedirectResponse:
        return RedirectResponse(url="/docs")

    @application.post("/api/workspaces", response_model=Workspace, status_code=201)
    def create_workspace(request: WorkspaceCreate) -> Workspace:
        return service.create_workspace(request)

    @application.post(
        "/api/workspaces/{workspace_id}/apps", response_model=App, status_code=201
    )
    def create_chat_app(workspace_id: str, request: AppCreate) -> App:
        return service.create_app(workspace_id, request)

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

    return application


app = create_app(Database())
