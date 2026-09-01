import type { AccountInvitation, App, AppType, Dataset, DatasetDocument, DifyToolProvider, DocumentSegment, DraftDefinition, NodeRun, PluginCatalogItem, PluginCredential, PluginRuntimeState, ProviderConfig, RetrievalResult, RunEvent, ScheduleTrigger, ScheduleTriggerInput, ServiceApiKey, User, WorkflowDefinition, WorkflowDraft, WorkflowEvent, WorkflowRun, WorkflowVersion, Workspace, WorkspaceMember, WorkspaceRole } from "./types";

const tokenKey = "lob-flow-management-token";

async function managementToken(): Promise<string> {
  const existing = localStorage.getItem(tokenKey);
  if (existing) return existing;
  throw new Error("请先登录");
}

async function authenticatedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await managementToken();
  return fetch(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init?.headers } });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const attempts = method === "GET" ? 3 : 1;
  let response: Response | undefined;
  let networkError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      response = await authenticatedFetch(path, {
        ...init,
        headers: { "Content-Type": "application/json", ...init?.headers }
      });
      if (response.status !== 503 || attempt === attempts - 1) break;
    } catch (reason) {
      networkError = reason;
      if (attempt === attempts - 1) throw reason;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 300 * (attempt + 1)));
  }
  if (!response) throw networkError ?? new Error("网络连接暂时不可用");
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail ?? `请求失败：${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  hasSession: () => !!localStorage.getItem(tokenKey),
  clearSession: () => localStorage.removeItem(tokenKey),
  login: async (email: string, password: string) => {
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail ?? "登录失败");
    localStorage.setItem(tokenKey, payload.token);
    return payload as { user: User; token: string };
  },
  setupStatus: () => fetch("/api/auth/setup-status").then((response) => response.json() as Promise<{ initialized: boolean }>),
  initialize: async (name: string, email: string, password: string) => {
    const response = await fetch("/api/auth/initialize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, password }) });
    const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.detail ?? "初始化失败"); localStorage.setItem(tokenKey, payload.token); return payload;
  },
  invitationInfo: async (token: string) => { const response = await fetch(`/api/auth/invitations/${encodeURIComponent(token)}`); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.detail ?? "邀请链接无效"); return payload as AccountInvitation; },
  acceptInvitation: async (token: string, name: string, password: string) => { const response = await fetch("/api/auth/invitations/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, name, password }) }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.detail ?? "注册失败"); localStorage.setItem(tokenKey, payload.token); return payload; },
  logout: async () => { try { await request<void>("/api/auth/logout", { method: "POST" }); } finally { localStorage.removeItem(tokenKey); } },
  currentUser: () => request<User>("/api/auth/me"),
  listPlatformUsers: () => request<User[]>("/api/admin/users"),
  createInvitation: (body: { name: string; email: string; is_super_admin: boolean }) => request<AccountInvitation>("/api/admin/invitations", { method: "POST", body: JSON.stringify(body) }),
  updatePlatformUser: (userId: string, body: { is_super_admin?: boolean; status?: "active" | "disabled" }) => request<User>(`/api/admin/users/${userId}`, { method: "PUT", body: JSON.stringify(body) }),
  listWorkspaces: () => request<Workspace[]>("/api/workspaces"),
  createWorkspace: (name: string) =>
    request<Workspace>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name })
    }),
  deleteWorkspace: (workspaceId: string) =>
    request<void>(`/api/workspaces/${workspaceId}`, { method: "DELETE" }),
  listMembers: (workspaceId: string) => request<WorkspaceMember[]>(`/api/workspaces/${workspaceId}/members`),
  listMemberCandidates: (workspaceId: string) => request<User[]>(`/api/workspaces/${workspaceId}/member-candidates`),
  addMember: (workspaceId: string, userId: string, role: WorkspaceRole) => request<WorkspaceMember>(`/api/workspaces/${workspaceId}/members`, { method: "POST", body: JSON.stringify({ user_id: userId, role }) }),
  updateMember: (workspaceId: string, userId: string, role: WorkspaceRole) => request<WorkspaceMember>(`/api/workspaces/${workspaceId}/members/${userId}`, { method: "PUT", body: JSON.stringify({ role }) }),
  removeMember: (workspaceId: string, userId: string) => request<void>(`/api/workspaces/${workspaceId}/members/${userId}`, { method: "DELETE" }),
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
  createApp: (workspaceId: string, name: string, appType: AppType) =>
    request<App>(`/api/workspaces/${workspaceId}/apps`, {
      method: "POST",
      body: JSON.stringify({ name, app_type: appType })
    }),
  deleteApp: (appId: string) =>
    request<void>(`/api/apps/${appId}`, { method: "DELETE" }),
  updateApp: (appId: string, body: { name: string; description: string; app_type: AppType }) =>
    request<App>(`/api/apps/${appId}`, { method: "PUT", body: JSON.stringify(body) }),
  duplicateApp: (appId: string) =>
    request<App>(`/api/apps/${appId}/duplicate`, { method: "POST" }),
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
  revealProviderKey: (workspaceId: string, configId: string) =>
    request<{ api_key: string }>(`/api/workspaces/${workspaceId}/model-provider-configs/${configId}/secret`),
  updateProvider: (workspaceId: string, configId: string, body: { name: string; base_url: string; api_key?: string }) =>
    request<ProviderConfig>(`/api/workspaces/${workspaceId}/model-provider-configs/${configId}`, {
      method: "PUT", body: JSON.stringify(body)
    }),
  deleteProvider: (workspaceId: string, configId: string) => request<void>(`/api/workspaces/${workspaceId}/model-provider-configs/${configId}`, { method: "DELETE" }),
  listPlugins: (workspaceId: string) =>
    request<PluginCatalogItem[]>(`/api/workspaces/${workspaceId}/plugins`),
  daemonStatus: () => request<{ available: boolean }>("/api/dify-plugin-daemon/status"),
  listInstalledDifyPlugins: (workspaceId: string) =>
    request<{ plugin_ids: string[] }>(`/api/workspaces/${workspaceId}/dify-plugins/installed`),
  listDifyTools: (workspaceId: string) =>
    request<DifyToolProvider[]>(`/api/workspaces/${workspaceId}/dify-tools`),
  uninstallDifyPlugin: (workspaceId: string, pluginId: string) => request<void>(`/api/workspaces/${workspaceId}/dify-plugins/${pluginId}`, { method: "DELETE" }),
  exploreMarketplace: (query = "") =>
    request<Array<{ org: string; name: string; label: string; description: string; category: string; icon_url: string; install_count: number; verified: boolean; version: string; identifier: string; updated_at: string }>>(`/api/dify-marketplace/plugins?q=${encodeURIComponent(query)}&limit=200`),
  installMarketplacePlugin: (workspaceId: string, identifier: string) =>
    request<{ identifier: string; installation: unknown }>(`/api/workspaces/${workspaceId}/dify-marketplace/install`, {
      method: "POST", body: JSON.stringify({ identifier })
    }),
  uploadDifyPlugin: async (workspaceId: string, file: File) => {
    const response = await authenticatedFetch(`/api/workspaces/${workspaceId}/dify-plugins/upload`, {
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
    authenticatedFetch(`/api/workspaces/${workspaceId}/plugins/${pluginId}`, { method: "DELETE" }).then((response) => {
      if (!response.ok) throw new Error(`卸载失败：${response.status}`);
    }),
  getWorkflow: (appId: string) =>
    request<WorkflowDraft>(`/api/apps/${appId}/workflow`),
  updateWorkflow: (appId: string, definition: WorkflowDefinition) =>
    request<WorkflowDraft>(`/api/apps/${appId}/workflow`, {
      method: "PUT",
      body: JSON.stringify(definition)
    }),
  publishWorkflow: (appId: string) => request<WorkflowVersion>(`/api/apps/${appId}/workflow/publish`, { method: "POST" }),
  listWorkflowVersions: (appId: string) => request<WorkflowVersion[]>(`/api/apps/${appId}/workflow/versions`),
  rollbackWorkflow: (appId: string, versionId: string) => request<WorkflowDraft>(`/api/apps/${appId}/workflow/versions/${versionId}/rollback`, { method: "POST" }),
  listPluginCredentials: (workspaceId: string, pluginId = "") => request<PluginCredential[]>(`/api/workspaces/${workspaceId}/plugin-credentials?plugin_id=${encodeURIComponent(pluginId)}`),
  createPluginCredential: (workspaceId: string, pluginId: string, name: string, credentials: Record<string, string>) => request<PluginCredential>(`/api/workspaces/${workspaceId}/plugin-credentials`, { method: "POST", body: JSON.stringify({ plugin_id: pluginId, name, credentials }) }),
  deletePluginCredential: (workspaceId: string, credentialId: string) => request<void>(`/api/workspaces/${workspaceId}/plugin-credentials/${credentialId}`, { method: "DELETE" }),
  listPluginRuntimeStates: (workspaceId: string) => request<PluginRuntimeState[]>(`/api/workspaces/${workspaceId}/plugin-runtime-states`),
  setDifyPluginEnabled: (workspaceId: string, pluginId: string, enabled: boolean) => request<PluginRuntimeState>(`/api/workspaces/${workspaceId}/dify-plugins/${pluginId}/enabled`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  listWorkflowRuns: (appId: string) => request<WorkflowRun[]>(`/api/apps/${appId}/workflow-runs`).then((items) => items.map((item) => Object.keys(item.outputs ?? {}).length ? { ...item, output: JSON.stringify(item.outputs, null, 2) } : item)),
  listScheduleTriggers: (appId: string) => request<ScheduleTrigger[]>(`/api/apps/${appId}/schedule-triggers`),
  createScheduleTrigger: (appId: string, body: ScheduleTriggerInput) => request<ScheduleTrigger>(`/api/apps/${appId}/schedule-triggers`, { method: "POST", body: JSON.stringify(body) }),
  updateScheduleTrigger: (appId: string, triggerId: string, body: ScheduleTriggerInput) => request<ScheduleTrigger>(`/api/apps/${appId}/schedule-triggers/${triggerId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteScheduleTrigger: (appId: string, triggerId: string) => request<void>(`/api/apps/${appId}/schedule-triggers/${triggerId}`, { method: "DELETE" }),
  runScheduleTrigger: (appId: string, triggerId: string) => request<WorkflowRun>(`/api/apps/${appId}/schedule-triggers/${triggerId}/run`, { method: "POST" }),
  listWorkflowNodeRuns: (runId: string) => request<NodeRun[]>(`/api/workflow-runs/${runId}/nodes`).then((items) => items.map((item) => item.attempts?.length ? { ...item, output: { ...(item.output ?? {}), attempts: item.attempts } } : item)),
  retryWorkflowRun: (runId: string) => request<WorkflowRun>(`/api/workflow-runs/${runId}/retry`, { method: "POST" }),
  cancelWorkflowRun: (runId: string) => request<WorkflowRun>(`/api/workflow-runs/${runId}/cancel`, { method: "POST" }),
  listApiKeys: (appId: string) => request<ServiceApiKey[]>(`/api/apps/${appId}/api-keys`),
  createApiKey: (appId: string, name: string) => request<ServiceApiKey>(`/api/apps/${appId}/api-keys`, { method: "POST", body: JSON.stringify({ name }) }),
  deleteApiKey: (appId: string, keyId: string) => request<void>(`/api/apps/${appId}/api-keys/${keyId}`, { method: "DELETE" }),
  async streamRun(appId: string, input: string, onEvent: (event: RunEvent) => void) {
    const response = await authenticatedFetch(`/api/apps/${appId}/runs/stream`, {
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
  async streamWorkflow(appId: string, input: string | Record<string, unknown>, onEvent: (event: WorkflowEvent) => void) {
    const response = await authenticatedFetch(`/api/apps/${appId}/workflow-runs/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(typeof input === "string" ? { input } : { inputs: input })
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
  },
  async streamWorkflowNode(appId: string, nodeId: string, input: string | Record<string, unknown>, onEvent: (event: WorkflowEvent) => void) {
    const response = await authenticatedFetch(`/api/apps/${appId}/workflow-nodes/${nodeId}/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(typeof input === "string" ? { input } : { inputs: input }) });
    if (!response.ok || !response.body) throw new Error(`节点运行失败：${response.status}`);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    while (true) { const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done }); const blocks = buffer.split("\n\n"); buffer = blocks.pop() ?? ""; for (const block of blocks) { const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6); if (data) onEvent(JSON.parse(data) as WorkflowEvent); } if (done) break; }
  }
};
