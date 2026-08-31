export interface Workspace {
  id: string;
  name: string;
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
  draft: DraftDefinition;
}

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

export type WorkflowNodeType = "start" | "template" | "llm" | "knowledge" | "tool" | "answer";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  name: string;
  config: Record<string, unknown>;
  position: { x?: number; y?: number };
}

export interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: Array<{ source: string; target: string }>;
}

export interface WorkflowDraft {
  app_id: string;
  definition: WorkflowDefinition;
  updated_at: string;
}

export interface WorkflowEvent {
  workflow_run_id: string;
  sequence: number;
  type: string;
  node_id: string | null;
  data: Record<string, unknown>;
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
