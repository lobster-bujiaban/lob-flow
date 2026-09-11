from __future__ import annotations

import argparse
import getpass
import json
import uvicorn

from lob_flow.api import create_app
from lob_flow.auth_service import AuthService
from lob_flow.database import Database
from lob_flow.models import AdminUserCreate, AppCreate, RunCreate, WorkspaceCreate
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

    subparsers.add_parser("migrate", help="apply production database migrations")

    create_admin = subparsers.add_parser("create-admin", help="provision a platform super administrator")
    create_admin.add_argument("email")
    create_admin.add_argument("--name", default="平台管理员")

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

    if args.command == "migrate":
        Database.from_env().initialize()
        print("数据库迁移已完成")
        return

    if args.command == "create-admin":
        password = getpass.getpass("管理员密码（至少 8 位）：")
        confirm = getpass.getpass("再次输入密码：")
        if password != confirm:
            parser.error("两次输入的密码不一致")
        database = Database.from_env()
        database.initialize()
        result = AuthService(database).ensure_super_admin(args.email, password, args.name)
        print(json.dumps(result.model_dump(mode="json"), ensure_ascii=False, indent=2))
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
