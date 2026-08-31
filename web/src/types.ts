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

export type WorkflowNodeType = "start" | "template" | "llm" | "answer";

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
