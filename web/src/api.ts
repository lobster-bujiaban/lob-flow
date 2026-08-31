import type { App, DraftDefinition, ProviderConfig, RunEvent, Workspace } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail ?? `请求失败：${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  listWorkspaces: () => request<Workspace[]>("/api/workspaces"),
  createWorkspace: (name: string) =>
    request<Workspace>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name })
    }),
  listApps: (workspaceId: string) =>
    request<App[]>(`/api/workspaces/${workspaceId}/apps`),
  createApp: (workspaceId: string, name: string) =>
    request<App>(`/api/workspaces/${workspaceId}/apps`, {
      method: "POST",
      body: JSON.stringify({ name })
    }),
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
  }
};
