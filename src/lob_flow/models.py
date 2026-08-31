from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class Workspace(BaseModel):
    id: str
    name: str
    created_at: datetime


class ModelConfig(BaseModel):
    provider: Literal["fake"] = "fake"
    model: str = "fake-chat-v1"
    temperature: float = Field(default=0.2, ge=0, le=2)


class DraftDefinition(BaseModel):
    system_prompt: str = "你是一个有帮助的 AI 助手。"
    user_prompt_template: str = "{input}"
    model: ModelConfig = Field(default_factory=ModelConfig)


class AppCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=500)
    draft: DraftDefinition = Field(default_factory=DraftDefinition)


class App(BaseModel):
    id: str
    workspace_id: str
    name: str
    description: str
    draft: DraftDefinition
    created_at: datetime
    updated_at: datetime


class PublishedVersion(BaseModel):
    id: str
    app_id: str
    version: int
    definition: DraftDefinition
    created_at: datetime


class RunCreate(BaseModel):
    input: str = Field(min_length=1, max_length=20_000)


RunStatus = Literal["running", "succeeded", "failed"]


class Run(BaseModel):
    id: str
    app_id: str
    status: RunStatus
    input: str
    output: str | None = None
    error: str | None = None
    draft_snapshot: DraftDefinition
    created_at: datetime
    finished_at: datetime | None = None


EventType = Literal[
    "run_started",
    "message_delta",
    "run_succeeded",
    "run_failed",
]


class RunEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str
    sequence: int
    type: EventType
    data: dict[str, Any]
    created_at: datetime
