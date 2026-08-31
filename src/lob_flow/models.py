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
    provider: Literal["openai_compatible"] = "openai_compatible"
    model: str = "gpt-5.4"
    provider_config_id: str | None = None
    temperature: float = Field(default=0.2, ge=0, le=2)
    max_tokens: int = Field(default=1024, ge=1, le=32_768)
    timeout_seconds: float = Field(default=30, ge=1, le=300)

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


class ModelProviderConfigCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    base_url: str = Field(min_length=8, max_length=500)
    api_key: str = Field(min_length=1, max_length=1000)


class ModelProviderConfigUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    base_url: str = Field(min_length=8, max_length=500)
    api_key: str | None = Field(default=None, min_length=1, max_length=1000)


class ModelProviderConfig(BaseModel):
    id: str
    workspace_id: str
    provider: Literal["openai_compatible"] = "openai_compatible"
    name: str
    base_url: str
    has_api_key: bool = True
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
    error_code: str | None = None
    model_provider: str
    model: str
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    finish_reason: str | None = None
    duration_ms: int | None = None
    draft_snapshot: DraftDefinition
    created_at: datetime
    finished_at: datetime | None = None


EventType = Literal[
    "run_started",
    "model_started",
    "message_delta",
    "model_completed",
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


NodeType = Literal["start", "template", "llm", "answer"]


class WorkflowNode(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    type: NodeType
    name: str = Field(min_length=1, max_length=100)
    config: dict[str, Any] = Field(default_factory=dict)


class WorkflowEdge(BaseModel):
    source: str
    target: str


class WorkflowDefinition(BaseModel):
    nodes: list[WorkflowNode]
    edges: list[WorkflowEdge]


class WorkflowDraft(BaseModel):
    app_id: str
    definition: WorkflowDefinition
    updated_at: datetime


class WorkflowRunCreate(BaseModel):
    input: str = Field(min_length=1, max_length=20_000)


class WorkflowRun(BaseModel):
    id: str
    app_id: str
    status: Literal["running", "succeeded", "failed"]
    input: str
    output: str | None = None
    error: str | None = None
    error_code: str | None = None
    definition_snapshot: WorkflowDefinition
    created_at: datetime
    finished_at: datetime | None = None
    duration_ms: int | None = None


class NodeRun(BaseModel):
    id: str
    workflow_run_id: str
    node_id: str
    node_type: NodeType
    status: Literal["running", "succeeded", "failed"]
    input: dict[str, Any]
    output: dict[str, Any] | None = None
    error: str | None = None
    started_at: datetime
    finished_at: datetime | None = None
    duration_ms: int | None = None


class WorkflowEvent(BaseModel):
    workflow_run_id: str
    sequence: int
    type: Literal[
        "workflow_started",
        "node_started",
        "node_delta",
        "node_succeeded",
        "node_failed",
        "workflow_succeeded",
        "workflow_failed",
    ]
    node_id: str | None = None
    data: dict[str, Any]
    created_at: datetime
