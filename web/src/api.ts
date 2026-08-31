import type { App, Dataset, DatasetDocument, DocumentSegment, DraftDefinition, PluginCatalogItem, ProviderConfig, RetrievalResult, RunEvent, WorkflowDefinition, WorkflowDraft, WorkflowEvent, Workspace } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail ?? `请求失败：${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  listWorkspaces: () => request<Workspace[]>("/api/workspaces"),
  createWorkspace: (name: string) =>
    request<Workspace>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name })
    }),
  deleteWorkspace: (workspaceId: string) =>
    request<void>(`/api/workspaces/${workspaceId}`, { method: "DELETE" }),
  listDatasets: (workspaceId: string) => request<Dataset[]>(`/api/workspaces/${workspaceId}/datasets`),
  createDataset: (workspaceId: string, body: { name: string; description: string; icon: string }) => request<Dataset>(`/api/workspaces/${workspaceId}/datasets`, { method: "POST", body: JSON.stringify(body) }),
  deleteDataset: (datasetId: string) => request<void>(`/api/datasets/${datasetId}`, { method: "DELETE" }),
  listDocuments: (datasetId: string) => request<DatasetDocument[]>(`/api/datasets/${datasetId}/documents`),
  addDocument: (datasetId: string, body: { name: string; content: string; separator?: string; max_chars?: number; overlap?: number }) => request<DatasetDocument>(`/api/datasets/${datasetId}/documents`, { method: "POST", body: JSON.stringify(body) }),
  deleteDocument: (documentId: string) => request<void>(`/api/documents/${documentId}`, { method: "DELETE" }),
  enableDocument: (documentId: string, enabled: boolean) => request<DatasetDocument>(`/api/documents/${documentId}/enabled`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  listSegments: (documentId: string) => request<DocumentSegment[]>(`/api/documents/${documentId}/segments`),
  updateSegment: (segmentId: string, content: string) => request<DocumentSegment>(`/api/segments/${segmentId}`, { method: "PUT", body: JSON.stringify({ content }) }),
  enableSegment: (segmentId: string, enabled: boolean) => request<DocumentSegment>(`/api/segments/${segmentId}/enabled`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  retrieveDataset: (datasetId: string, query: string, topK = 3) => request<{ query: string; results: RetrievalResult[]; duration_ms: number }>(`/api/datasets/${datasetId}/retrieve`, { method: "POST", body: JSON.stringify({ query, top_k: topK }) }),
  listApps: (workspaceId: string) =>
    request<App[]>(`/api/workspaces/${workspaceId}/apps`),
  createApp: (workspaceId: string, name: string) =>
    request<App>(`/api/workspaces/${workspaceId}/apps`, {
      method: "POST",
      body: JSON.stringify({ name })
    }),
  deleteApp: (appId: string) =>
    request<void>(`/api/apps/${appId}`, { method: "DELETE" }),
  updateDraft: (appId: string, draft: DraftDefinition) =>
    request<App>(`/api/apps/${appId}/draft`, {
      method: "PUT",
      body: JSON.stringify(draft)
    }),
  listProviders: (workspaceId: string) =>
    request<ProviderConfig[]>(`/api/workspaces/${workspaceId}/model-provider-configs`),
  createProvider: (
    workspaceId: string,
    body: { name: string; base_url: string; api_key: string }
  ) =>
    request<ProviderConfig>(`/api/workspaces/${workspaceId}/model-provider-configs`, {
      method: "POST",
      body: JSON.stringify(body)
    }),
  listPlugins: (workspaceId: string) =>
    request<PluginCatalogItem[]>(`/api/workspaces/${workspaceId}/plugins`),
  daemonStatus: () => request<{ available: boolean }>("/api/dify-plugin-daemon/status"),
  exploreMarketplace: (query = "") =>
    request<Array<{ org: string; name: string; label: string; description: string; category: string; icon_url: string; install_count: number; verified: boolean; version: string; identifier: string; updated_at: string }>>(`/api/dify-marketplace/plugins?q=${encodeURIComponent(query)}&limit=36`),
  installMarketplacePlugin: (workspaceId: string, identifier: string) =>
    request<{ identifier: string; installation: unknown }>(`/api/workspaces/${workspaceId}/dify-marketplace/install`, {
      method: "POST", body: JSON.stringify({ identifier })
    }),
  uploadDifyPlugin: async (workspaceId: string, file: File) => {
    const response = await fetch(`/api/workspaces/${workspaceId}/dify-plugins/upload`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail ?? `插件安装失败：${response.status}`);
    }
    return response.json();
  },
  installPlugin: (workspaceId: string, pluginId: string, credentials: Record<string, string> = {}) =>
    request(`/api/workspaces/${workspaceId}/plugins/${pluginId}/install`, {
      method: "POST", body: JSON.stringify({ credentials })
    }),
  enablePlugin: (workspaceId: string, pluginId: string, enabled: boolean) =>
    request(`/api/workspaces/${workspaceId}/plugins/${pluginId}/enabled`, {
      method: "PUT", body: JSON.stringify({ enabled })
    }),
  uninstallPlugin: (workspaceId: string, pluginId: string) =>
    fetch(`/api/workspaces/${workspaceId}/plugins/${pluginId}`, { method: "DELETE" }).then((response) => {
      if (!response.ok) throw new Error(`卸载失败：${response.status}`);
    }),
  getWorkflow: (appId: string) =>
    request<WorkflowDraft>(`/api/apps/${appId}/workflow`),
  updateWorkflow: (appId: string, definition: WorkflowDefinition) =>
    request<WorkflowDraft>(`/api/apps/${appId}/workflow`, {
      method: "PUT",
      body: JSON.stringify(definition)
    }),
  async streamRun(appId: string, input: string, onEvent: (event: RunEvent) => void) {
    const response = await fetch(`/api/apps/${appId}/runs/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input })
    });
    if (!response.ok || !response.body) throw new Error(`运行失败：${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (data) onEvent(JSON.parse(data) as RunEvent);
      }
      if (done) break;
    }
  },
  async streamWorkflow(appId: string, input: string, onEvent: (event: WorkflowEvent) => void) {
    const response = await fetch(`/api/apps/${appId}/workflow-runs/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input })
    });
    if (!response.ok || !response.body) throw new Error(`工作流运行失败：${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (data) onEvent(JSON.parse(data) as WorkflowEvent);
      }
      if (done) break;
    }
  }
};
