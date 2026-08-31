from __future__ import annotations

import argparse
import json
import uvicorn

from lob_flow.api import create_app
from lob_flow.database import Database
from lob_flow.models import AppCreate, RunCreate, WorkspaceCreate
from lob_flow.service import FlowService


def _service() -> FlowService:
    database = Database.from_env()
    database.initialize()
    return FlowService(database)


def main() -> None:
    parser = argparse.ArgumentParser(prog="lob-flow")
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="start the FastAPI server")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)

    workspace = subparsers.add_parser("create-workspace")
    workspace.add_argument("name")

    app = subparsers.add_parser("create-app")
    app.add_argument("workspace_id")
    app.add_argument("name")

    run = subparsers.add_parser("run")
    run.add_argument("app_id")
    run.add_argument("input")

    args = parser.parse_args()
    if args.command == "serve":
        uvicorn.run(create_app(), host=args.host, port=args.port)
        return

    service = _service()
    if args.command == "create-workspace":
        result = service.create_workspace(WorkspaceCreate(name=args.name))
    elif args.command == "create-app":
        result = service.create_app(args.workspace_id, AppCreate(name=args.name))
    else:
        request = RunCreate(input=args.input)
        result = service.run(args.app_id, request.input)
    print(json.dumps(result.model_dump(mode="json"), ensure_ascii=False, indent=2))
