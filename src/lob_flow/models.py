from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


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


AppType = Literal["workflow", "chatflow", "chat_assistant", "agent", "text_generation"]


class AppCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=500)
    app_type: AppType = "chatflow"
    draft: DraftDefinition = Field(default_factory=DraftDefinition)


class AppUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=500)
    app_type: AppType


class App(BaseModel):
    id: str
    workspace_id: str
    name: str
    description: str
    app_type: AppType
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


class ModelProviderSecret(BaseModel):
    api_key: str


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


NodeType = Literal["start", "template", "llm", "knowledge", "tool", "condition", "switch", "answer"]


class WorkflowNode(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    type: NodeType
    name: str = Field(min_length=1, max_length=100)
    config: dict[str, Any] = Field(default_factory=dict)
    position: dict[str, float] = Field(default_factory=dict)


class WorkflowEdge(BaseModel):
    source: str
    target: str
    source_handle: str | None = Field(default=None, max_length=100)


class WorkflowDefinition(BaseModel):
    nodes: list[WorkflowNode]
    edges: list[WorkflowEdge]


class WorkflowDraft(BaseModel):
    app_id: str
    definition: WorkflowDefinition
    updated_at: datetime


class WorkflowVersion(BaseModel):
    id: str
    app_id: str
    version: int
    definition: WorkflowDefinition
    created_at: datetime


class PluginCredentialCreate(BaseModel):
    plugin_id: str = Field(min_length=1, max_length=200)
    name: str = Field(default="默认授权", min_length=1, max_length=100)
    credentials: dict[str, str]


class PluginCredential(BaseModel):
    id: str
    workspace_id: str
    plugin_id: str
    name: str
    created_at: datetime
    updated_at: datetime


class PluginRuntimeState(BaseModel):
    workspace_id: str
    plugin_id: str
    enabled: bool
    updated_at: datetime


class WorkflowRunCreate(BaseModel):
    input: str | None = Field(default=None, min_length=1, max_length=20_000)
    inputs: dict[str, Any] | None = None

    @model_validator(mode="after")
    def require_input(self) -> "WorkflowRunCreate":
        if self.input is None and self.inputs is None:
            raise ValueError("请提供 input 或 inputs")
        return self

    def payload(self) -> str | dict[str, Any]:
        return self.inputs if self.inputs is not None else self.input or ""


class ScheduleTriggerCreate(BaseModel):
    name: str = Field(default="定时触发器", min_length=1, max_length=100)
    cron: str = Field(min_length=5, max_length=100)
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=100)
    input: str = Field(min_length=1, max_length=20_000)
    enabled: bool = False
    misfire_policy: Literal["skip", "run_once"] = "skip"


class ScheduleTriggerUpdate(ScheduleTriggerCreate):
    pass


class ScheduleTrigger(BaseModel):
    id: str
    app_id: str
    name: str
    cron: str
    timezone: str
    input: str
    enabled: bool
    misfire_policy: Literal["skip", "run_once"] = "skip"
    last_triggered_at: datetime | None = None
    next_trigger_at: datetime | None = None
    last_error: str | None = None
    last_run_id: str | None = None
    created_at: datetime
    updated_at: datetime


class WorkflowRun(BaseModel):
    id: str
    app_id: str
    status: Literal["running", "succeeded", "failed"]
    input: str
    inputs: dict[str, Any] = Field(default_factory=dict)
    output: str | None = None
    error: str | None = None
    error_code: str | None = None
    definition_snapshot: WorkflowDefinition
    created_at: datetime
    finished_at: datetime | None = None
    duration_ms: int | None = None
    trigger_source: str = "debug"


class ServiceApiKey(BaseModel):
    id: str
    app_id: str
    name: str
    key_prefix: str
    created_at: datetime
    last_used_at: datetime | None = None


class ServiceApiKeyCreated(ServiceApiKey):
    api_key: str


class ServiceApiKeyCreate(BaseModel):
    name: str = Field(default="默认密钥", min_length=1, max_length=100)


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


class ToolDeclaration(BaseModel):
    name: str
    label: str
    description: str
    parameters: dict[str, Any]


class PluginManifest(BaseModel):
    plugin_id: str
    name: str
    author: str
    version: str
    category: Literal["tool"] = "tool"
    description: str
    icon: str
    verified: bool = False
    credential_schema: dict[str, Any] = Field(default_factory=dict)
    tools: list[ToolDeclaration]


class PluginCatalogItem(BaseModel):
    manifest: PluginManifest
    installed: bool = False
    enabled: bool = False
    installation_id: str | None = None
    has_credentials: bool = False


class PluginInstallRequest(BaseModel):
    credentials: dict[str, str] = Field(default_factory=dict)


class PluginInstallation(BaseModel):
    id: str
    workspace_id: str
    plugin_id: str
    version: str
    enabled: bool
    has_credentials: bool
    created_at: datetime
    updated_at: datetime


class PluginEnableRequest(BaseModel):
    enabled: bool


class DatasetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=1000)
    icon: str = Field(default="📖", max_length=20)


class Dataset(BaseModel):
    id: str
    workspace_id: str
    name: str
    description: str
    icon: str
    indexing_technique: str
    search_method: str
    top_k: int
    score_threshold: float
    document_count: int = 0
    segment_count: int = 0
    created_at: datetime
    updated_at: datetime


class DocumentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    content: str = Field(min_length=1, max_length=2_000_000)
    separator: str = Field(default="\n\n", max_length=20)
    max_chars: int = Field(default=1200, ge=100, le=10_000)
    overlap: int = Field(default=150, ge=0, le=2000)


class DatasetDocument(BaseModel):
    id: str
    dataset_id: str
    name: str
    status: str
    word_count: int
    segment_count: int
    enabled: bool
    error: str | None = None
    created_at: datetime
    updated_at: datetime


class EnableRequest(BaseModel):
    enabled: bool


class SegmentUpdate(BaseModel):
    content: str = Field(min_length=1, max_length=50_000)


class DocumentSegment(BaseModel):
    id: str
    dataset_id: str
    document_id: str
    document_name: str = ""
    position: int
    content: str
    word_count: int
    token_count: int
    keywords: list[str] = Field(default_factory=list)
    enabled: bool
    hit_count: int
    created_at: datetime
    updated_at: datetime


class RetrievalRequest(BaseModel):
    query: str = Field(min_length=1, max_length=20_000)
    top_k: int | None = Field(default=None, ge=1, le=20)
    score_threshold: float | None = Field(default=None, ge=0, le=1)


class RetrievalResult(BaseModel):
    segment_id: str
    document_id: str
    document_name: str
    content: str
    position: int
    score: float


class RetrievalResponse(BaseModel):
    query: str
    results: list[RetrievalResult]
    duration_ms: int
