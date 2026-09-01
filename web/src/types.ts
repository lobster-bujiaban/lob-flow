export interface Workspace {
  id: string;
  name: string;
}

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";

export interface User {
  id: string;
  name: string;
  email: string;
  is_super_admin: boolean;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  workspace_id: string;
  user_id: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  created_at: string;
  updated_at: string;
}

export interface AccountInvitation {
  id: string;
  email: string;
  name: string;
  is_super_admin: boolean;
  expires_at: string;
  invite_token?: string | null;
}

export interface ModelConfig {
  provider: "openai_compatible";
  model: string;
  provider_config_id: string | null;
  temperature: number;
  max_tokens: number;
  timeout_seconds: number;
}

export interface DraftDefinition {
  system_prompt: string;
  user_prompt_template: string;
  model: ModelConfig;
}

export interface App {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  app_type: AppType;
  draft: DraftDefinition;
  created_at: string;
  updated_at: string;
}

export type AppType = "workflow" | "chatflow" | "chat_assistant" | "agent" | "text_generation";

export interface ProviderConfig {
  id: string;
  workspace_id: string;
  provider: "openai_compatible";
  name: string;
  base_url: string;
  has_api_key: boolean;
}

export interface RunEvent {
  run_id: string;
  sequence: number;
  type: string;
  data: Record<string, unknown>;
}

export type WorkflowNodeType = "start" | "template" | "llm" | "knowledge" | "tool" | "condition" | "switch" | "answer";

export interface StartInputVariable {
  name: string;
  label: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  default?: string | number | boolean;
  description?: string;
}

export interface AnswerOutputVariable {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "object";
  value: string;
  required: boolean;
  description?: string;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  name: string;
  config: Record<string, unknown>;
  position: { x?: number; y?: number };
}

export interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: Array<{ source: string; target: string; source_handle?: string | null }>;
}

export interface WorkflowDraft {
  app_id: string;
  definition: WorkflowDefinition;
  updated_at: string;
}

export interface WorkflowVersion {
  id: string;
  app_id: string;
  version: number;
  definition: WorkflowDefinition;
  created_at: string;
}

export interface PluginCredential {
  id: string;
  workspace_id: string;
  plugin_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface PluginRuntimeState {
  workspace_id: string;
  plugin_id: string;
  enabled: boolean;
  misfire_policy: "skip" | "run_once";
  updated_at: string;
}

export interface WorkflowEvent {
  workflow_run_id: string;
  sequence: number;
  type: string;
  node_id: string | null;
  data: Record<string, unknown>;
}

export interface WorkflowRun {
  id: string;
  app_id: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  input: string;
  inputs: Record<string, unknown>;
  output: string | null;
  outputs: Record<string, unknown>;
  error: string | null;
  error_code: string | null;
  created_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  trigger_source: string;
}

export interface ScheduleTrigger {
  id: string;
  app_id: string;
  name: string;
  cron: string;
  timezone: string;
  input: string;
  enabled: boolean;
  misfire_policy: "skip" | "run_once";
  last_triggered_at: string | null;
  next_trigger_at: string | null;
  last_error: string | null;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export type ScheduleTriggerInput = Pick<ScheduleTrigger, "name" | "cron" | "timezone" | "input" | "enabled" | "misfire_policy">;

export interface NodeRun {
  id: string;
  workflow_run_id: string;
  node_id: string;
  node_type: WorkflowNodeType;
  status: "running" | "succeeded" | "failed" | "cancelled";
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  attempts: Array<{ id: string; attempt: number; status: "running" | "succeeded" | "failed"; error: string | null; started_at: string; finished_at: string | null; duration_ms: number | null }>;
}

export interface ServiceApiKey {
  id: string;
  app_id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  api_key?: string;
}

export interface ToolDeclaration {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, { type: string; required?: boolean }>;
}

export interface PluginManifest {
  plugin_id: string;
  name: string;
  author: string;
  version: string;
  category: "tool";
  description: string;
  icon: string;
  verified: boolean;
  credential_schema: Record<string, { type: string; required?: boolean }>;
  tools: ToolDeclaration[];
}

export interface PluginCatalogItem {
  manifest: PluginManifest;
  installed: boolean;
  enabled: boolean;
  installation_id: string | null;
  has_credentials: boolean;
}

export interface DifyToolProvider {
  plugin_id: string;
  provider_name: string;
  name: string;
  description: string;
  icon: string;
  credential_schema: Record<string, { type: string; required?: boolean; label?: string }>;
  tools: ToolDeclaration[];
}

export interface Dataset {
  id: string; workspace_id: string; name: string; description: string; icon: string;
  indexing_technique: string; search_method: string; top_k: number; score_threshold: number;
  document_count: number; segment_count: number; created_at: string; updated_at: string;
}

export interface DatasetDocument {
  id: string; dataset_id: string; name: string; status: string; word_count: number;
  segment_count: number; enabled: boolean; error: string | null; created_at: string; updated_at: string;
}

export interface DocumentSegment {
  id: string; dataset_id: string; document_id: string; document_name: string; position: number;
  content: string; word_count: number; token_count: number; keywords: string[];
  enabled: boolean; hit_count: number; created_at: string; updated_at: string;
}

export interface RetrievalResult {
  segment_id: string; document_id: string; document_name: string; content: string; position: number; score: number;
}
