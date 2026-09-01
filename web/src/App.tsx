import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { App as FlowApp, AppType, DraftDefinition, NodeRun, ProviderConfig, ServiceApiKey, StartInputVariable, WorkflowDefinition, WorkflowEvent, WorkflowNode, WorkflowRun, Workspace } from "./types";
import lobsterLogo from "./assets/lobster-logo.png";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { PluginMarketplace } from "./PluginMarketplace";
import { KnowledgeBase } from "./KnowledgeBase";
import { ToolsLibrary } from "./ToolsLibrary";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Tab = "studio" | "chat" | "workflow" | "api" | "logs" | "knowledge" | "tools" | "plugins" | "settings";
type AppFilter = "all" | AppType;

const appTypes: Array<{ id: AppType; label: string; icon: string; description: string }> = [
  { id: "workflow", label: "工作流", icon: "⌘", description: "面向自动化与批处理的可视化编排" },
  { id: "chatflow", label: "Chatflow", icon: "▣", description: "带会话体验的可视化工作流" },
  { id: "chat_assistant", label: "聊天助手", icon: "◉", description: "由 Prompt 驱动的多轮对话助手" },
  { id: "agent", label: "Agent", icon: "♙", description: "可自主选择工具完成任务的智能体" },
  { id: "text_generation", label: "文本生成", icon: "T", description: "单次输入、结构化生成文本" }
];

const providerPresets = [
  { id: "openai", label: "OpenAI", icon: "OA", baseUrl: "https://api.openai.com/v1", model: "gpt-5.4" },
  { id: "deepseek", label: "DeepSeek", icon: "DS", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "qwen", label: "通义千问", icon: "QW", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { id: "zhipu", label: "智谱 GLM", icon: "GL", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.5" },
  { id: "moonshot", label: "Moonshot", icon: "KM", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.5" },
  { id: "siliconflow", label: "SiliconFlow", icon: "SF", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen3-8B" },
  { id: "openrouter", label: "OpenRouter", icon: "OR", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1" },
  { id: "groq", label: "Groq", icon: "GQ", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { id: "ollama", label: "Ollama", icon: "OL", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2" }
] as const;

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [apps, setApps] = useState<FlowApp[]>([]);
  const [appId, setAppId] = useState("");
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [tab, setTab] = useState<Tab>("studio");
  const [error, setError] = useState("");
  const [appFilter, setAppFilter] = useState<AppFilter>("all");
  const [showCreateApp, setShowCreateApp] = useState(false);
  const [editingApp, setEditingApp] = useState<FlowApp | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FlowApp | null>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showDeleteWorkspace, setShowDeleteWorkspace] = useState(false);
  const [importTarget, setImportTarget] = useState<FlowApp | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const activeApp = useMemo(() => apps.find((item) => item.id === appId), [apps, appId]);
  const visibleApps = useMemo(() => appFilter === "all" ? apps : apps.filter((item) => item.app_type === appFilter), [apps, appFilter]);

  useEffect(() => {
    api.listWorkspaces().then((items) => {
      setWorkspaces(items);
      if (items[0]) setWorkspaceId(items[0].id);
    }).catch(showError);
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    Promise.all([api.listApps(workspaceId), api.listProviders(workspaceId)])
      .then(([appItems, providerItems]) => {
        setApps(appItems);
        setProviders(providerItems);
        setAppId((current) => appItems.some((item) => item.id === current) ? current : appItems[0]?.id ?? "");
      })
      .catch(showError);
  }, [workspaceId]);

  function showError(reason: unknown) {
    const message = reason instanceof Error ? reason.message : String(reason);
    setError(message.includes("provider_config_missing") ? "请先配置真实模型供应商和 API Key，再运行应用。" : message);
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!name) return;
    try {
      const created = await api.createWorkspace(name.trim());
      setWorkspaces((items) => [...items, created]);
      setWorkspaceId(created.id);
      setShowCreateWorkspace(false);
      setError("");
    } catch (reason) { showError(reason); }
  }

  function createApp() { if (workspaceId) setShowCreateApp(true); }

  async function submitCreateApp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!workspaceId) return;
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const appType = String(data.get("app_type") ?? "chatflow") as AppType;
    if (!name) return;
    try {
      const created = await api.createApp(workspaceId, name, appType);
      setApps((items) => [...items, created]);
      setAppId(created.id);
      setAppFilter(appType);
      setTab(appType === "workflow" ? "workflow" : "chat");
      setShowCreateApp(false);
      setError("");
    } catch (reason) { showError(reason); }
  }

  async function deleteWorkspace() {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    try {
      await api.deleteWorkspace(workspace.id);
      const remaining = workspaces.filter((item) => item.id !== workspace.id);
      setWorkspaces(remaining);
      setWorkspaceId(remaining[0]?.id ?? "");
      setApps([]);
      setAppId("");
      setShowDeleteWorkspace(false);
      setError("");
    } catch (reason) { showError(reason); }
  }

  async function deleteApp(item: FlowApp) {
    try {
      await api.deleteApp(item.id);
      const remaining = apps.filter((app) => app.id !== item.id);
      setApps(remaining);
      if (appId === item.id) setAppId(remaining[0]?.id ?? "");
      setDeleteTarget(null);
      setError("");
    } catch (reason) { showError(reason); }
  }

  function replaceApp(updated: FlowApp) {
    setApps((items) => items.map((item) => item.id === updated.id ? updated : item));
  }

  function openApp(item: FlowApp) {
    setAppId(item.id);
    setTab(item.app_type === "workflow" ? "workflow" : "chat");
  }

  async function submitEditApp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editingApp) return;
    const data = new FormData(event.currentTarget);
    try {
      const updated = await api.updateApp(editingApp.id, { name: String(data.get("name")), description: String(data.get("description") ?? ""), app_type: String(data.get("app_type")) as AppType });
      setApps((items) => items.map((item) => item.id === updated.id ? updated : item)); setEditingApp(null);
    } catch (reason) { showError(reason); }
  }

  async function duplicateApp(item: FlowApp) {
    try { const copy = await api.duplicateApp(item.id); setApps((items) => [...items, copy]); }
    catch (reason) { showError(reason); }
  }

  async function exportDsl(item: FlowApp) {
    try {
      const workflow = await api.getWorkflow(item.id);
      const content = JSON.stringify({ format: "lob-flow/v1", app: { name: item.name, description: item.description, app_type: item.app_type, draft: item.draft }, workflow: workflow.definition }, null, 2);
      const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${item.name.replace(/[^\w\u4e00-\u9fff-]+/g, "-")}.lobflow.json`; anchor.click(); URL.revokeObjectURL(url);
    } catch (reason) { showError(reason); }
  }

  async function importDsl(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !workspaceId) return;
    try {
      const payload = JSON.parse(await file.text()) as { format?: string; app?: Partial<FlowApp>; workflow?: WorkflowDefinition };
      if (payload.format !== "lob-flow/v1" || !payload.app || !payload.workflow || !Array.isArray(payload.workflow.nodes) || !Array.isArray(payload.workflow.edges)) throw new Error("不是有效的 LOB Flow DSL 文件");
      if (!payload.workflow.nodes.some((node) => node.type === "start") || !payload.workflow.nodes.some((node) => node.type === "answer")) throw new Error("DSL 必须包含开始和回答节点");
      const providerIds = new Set(providers.map((provider) => provider.id));
      const fallbackProvider = providers[0]?.id ?? "";
      const definition: WorkflowDefinition = {
        ...payload.workflow,
        nodes: payload.workflow.nodes.map((node) => node.type === "llm" && !providerIds.has(String(node.config.provider_config_id ?? "")) ? { ...node, config: { ...node.config, provider_config_id: fallbackProvider } } : node),
      };
      if (definition.nodes.some((node) => node.type === "llm" && !node.config.provider_config_id)) throw new Error("DSL 包含 LLM 节点，请先在当前空间配置模型供应商");
      let target = importTarget;
      if (!target) {
        target = await api.createApp(workspaceId, String(payload.app.name || file.name.replace(/\.lobflow\.json$/i, "")), (payload.app.app_type as AppType) || "workflow");
        setApps((items) => [...items, target!]);
      }
      const draft = payload.app.draft as DraftDefinition | undefined;
      if (draft) await api.updateDraft(target.id, { ...draft, model: { ...draft.model, provider_config_id: providerIds.has(String(draft.model.provider_config_id ?? "")) ? draft.model.provider_config_id : fallbackProvider || null } });
      await api.updateWorkflow(target.id, definition);
      const updated = await api.updateApp(target.id, { name: importTarget ? target.name : String(payload.app.name || target.name), description: importTarget ? target.description : String(payload.app.description || ""), app_type: importTarget ? target.app_type : (payload.app.app_type as AppType) || "workflow" });
      setApps((items) => items.map((item) => item.id === updated.id ? updated : item));
      setAppId(updated.id); setTab("workflow"); setImportTarget(null); setError("");
    } catch (reason) { setImportTarget(null); showError(reason); }
  }

  return (
    <div className="dify-shell">
      <header className="global-header">
        <div className="global-brand"><img src={lobsterLogo} alt="LOB" /><strong>LOB Flow</strong><span>/</span><div className="workspace-picker"><button className="workspace-picker-trigger" onClick={() => setWorkspaceMenuOpen((open) => !open)}><span>{workspaces.find((item) => item.id === workspaceId)?.name ?? "选择空间"}</span><i>⌄</i></button>{workspaceMenuOpen && <div className="workspace-menu"><small>空间</small>{workspaces.map((workspace) => <button key={workspace.id} className={workspace.id === workspaceId ? "active" : ""} onClick={() => { setWorkspaceId(workspace.id); setTab("studio"); setWorkspaceMenuOpen(false); }}><i>{workspace.name.slice(0, 1).toUpperCase()}</i><span>{workspace.name}</span>{workspace.id === workspaceId && <b>✓</b>}</button>)}<div className="workspace-menu-actions"><button onClick={() => { setShowCreateWorkspace(true); setWorkspaceMenuOpen(false); }}>＋ 新建空间</button><button className="danger" disabled={!workspaceId} onClick={() => { setShowDeleteWorkspace(true); setWorkspaceMenuOpen(false); }}>删除当前空间</button></div></div>}</div></div>
        <nav className="global-nav"><button className={tab === "studio" ? "active" : ""} onClick={() => setTab("studio")}>▦ 工作室</button><button className={tab === "knowledge" ? "active" : ""} onClick={() => setTab("knowledge")}>▤ 知识库</button><button className={tab === "tools" ? "active" : ""} onClick={() => setTab("tools")}>T 工具</button></nav>
        <div className="global-actions"><button className={tab === "plugins" ? "active" : ""} onClick={() => setTab("plugins")}>◈ 插件</button><button className="user-avatar-top">LOB</button></div>
      </header>
      <main className="main">
        {activeApp && ["chat", "workflow", "api", "logs", "settings"].includes(tab) && <header className="app-header"><button className="app-back" onClick={() => setTab("studio")}>←</button><div className="app-header-title"><span>{appTypes.find((type) => type.id === activeApp.app_type)?.icon}</span><div><strong>{activeApp.name}</strong><small>{appTypes.find((type) => type.id === activeApp.app_type)?.label}</small></div></div><nav><button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>调试</button><button className={tab === "workflow" ? "active" : ""} onClick={() => setTab("workflow")}>工作流</button><button className={tab === "api" ? "active" : ""} onClick={() => setTab("api")}>访问 API</button><button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>日志</button><button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>模型设置</button></nav></header>}
        {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
        {tab === "studio" ? <Studio apps={visibleApps} allApps={apps} filter={appFilter} setFilter={setAppFilter} onCreate={createApp} onImport={() => { setImportTarget(null); importRef.current?.click(); }} onImportInto={(app) => { if (window.confirm(`导入 DSL 将覆盖“${app.name}”当前的工作流草稿，是否继续？`)) { setImportTarget(app); importRef.current?.click(); } }} onOpen={openApp} onEdit={setEditingApp} onDuplicate={duplicateApp} onExport={exportDsl} onDelete={setDeleteTarget} onDeleteWorkspace={() => setShowDeleteWorkspace(true)} disabled={!workspaceId} /> : tab === "knowledge" ? <KnowledgeBase workspaceId={workspaceId} onError={showError} /> : tab === "tools" ? <ToolsLibrary workspaceId={workspaceId} onError={showError} /> : tab === "plugins" ? <PluginMarketplace workspaceId={workspaceId} onError={showError} /> : !activeApp ? <Welcome onCreate={createApp} disabled={!workspaceId} /> : tab === "chat" ? (
          <ChatPanel app={activeApp} providers={providers} onSettings={() => setTab("settings")} onError={showError} />
        ) : tab === "workflow" ? (
          <WorkflowCanvas app={activeApp} workspaceId={workspaceId} providers={providers} onError={showError} onOpenLogs={() => setTab("logs")} />
        ) : tab === "api" ? (
          <ApiAccessPanel app={activeApp} onError={showError} />
        ) : tab === "logs" ? (
          <AppLogsPanel app={activeApp} onError={showError} />
        ) : (
          <SettingsPanel
            app={activeApp}
            workspaceId={workspaceId}
            providers={providers}
            setProviders={setProviders}
            onSaved={replaceApp}
            onError={showError}
          />
        )}
      </main>
      <input ref={importRef} className="file-input" type="file" accept=".json,.lobflow.json,application/json" onChange={importDsl} />
      {showCreateWorkspace && <div className="modal-backdrop" onClick={() => setShowCreateWorkspace(false)}><form className="modal workspace-create-modal" onSubmit={createWorkspace} onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><h3>新建空间</h3><p>空间用于隔离应用、知识库、插件和运行记录。</p></div><button type="button" onClick={() => setShowCreateWorkspace(false)}>×</button></div><label>空间名称</label><input name="name" required autoFocus maxLength={100} placeholder="例如：产品研发团队" /><div className="workspace-modal-actions"><button type="button" onClick={() => setShowCreateWorkspace(false)}>取消</button><button className="primary">创建空间</button></div></form></div>}
      {showDeleteWorkspace && <div className="modal-backdrop" onClick={() => setShowDeleteWorkspace(false)}><div className="modal confirm-modal workspace-delete-modal" onClick={(event) => event.stopPropagation()}><div className="confirm-icon">!</div><h3>删除空间“{workspaces.find((item) => item.id === workspaceId)?.name}”？</h3><p>空间内的应用、工作流、运行记录和插件配置都会永久删除。此操作无法撤销。</p><div className="confirm-actions"><button onClick={() => setShowDeleteWorkspace(false)}>取消</button><button className="confirm-delete" onClick={deleteWorkspace}>确认删除</button></div></div></div>}
      {showCreateApp && <div className="modal-backdrop"><form className="modal app-create-modal" onSubmit={submitCreateApp}><div className="modal-head"><div><h3>创建应用</h3><p>应用类型决定默认运行方式，创建后仍可使用工作流编排。</p></div><button type="button" onClick={() => setShowCreateApp(false)}>×</button></div><label>应用名称</label><input name="name" required autoFocus placeholder="例如：客户支持 Agent" /><label>应用类型</label><div className="app-type-options">{appTypes.map((type, index) => <label key={type.id}><input type="radio" name="app_type" value={type.id} defaultChecked={index === 1} /><span><i>{type.icon}</i><strong>{type.label}</strong><small>{type.description}</small></span></label>)}</div><button className="primary wide">创建应用</button></form></div>}
      {editingApp && <div className="modal-backdrop"><form className="modal" onSubmit={submitEditApp}><div className="modal-head"><div><h3>编辑应用信息</h3><p>修改名称、描述和应用分类。</p></div><button type="button" onClick={() => setEditingApp(null)}>×</button></div><label>应用名称</label><input name="name" defaultValue={editingApp.name} required /><label>应用类型</label><select name="app_type" defaultValue={editingApp.app_type}>{appTypes.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}</select><label>应用描述</label><textarea name="description" rows={4} defaultValue={editingApp.description} /><button className="primary wide">保存修改</button></form></div>}
      {deleteTarget && <div className="modal-backdrop"><div className="modal confirm-modal"><div className="confirm-icon">!</div><h3>删除应用“{deleteTarget.name}”？</h3><p>相关工作流、运行记录和事件都会永久删除，此操作无法撤销。</p><div className="confirm-actions"><button onClick={() => setDeleteTarget(null)}>取消</button><button className="confirm-delete" onClick={() => deleteApp(deleteTarget)}>确认删除</button></div></div></div>}
    </div>
  );
}

function ApiAccessPanel({ app, onError }: { app: FlowApp; onError: (reason: unknown) => void }) {
  const [keys, setKeys] = useState<ServiceApiKey[]>([]);
  const [newKey, setNewKey] = useState("");
  const [creating, setCreating] = useState(false);
  const [inputVariables, setInputVariables] = useState<StartInputVariable[]>([]);
  const baseUrl = `${window.location.origin}/v1`;
  const load = () => api.listApiKeys(app.id).then(setKeys).catch(onError);
  useEffect(() => { void load(); }, [app.id]);
  useEffect(() => { api.getWorkflow(app.id).then((draft) => setInputVariables((draft.definition.nodes.find((node) => node.type === "start")?.config.variables as StartInputVariable[] | undefined) ?? [])).catch(onError); }, [app.id]);
  async function createKey() {
    try { setCreating(true); const item = await api.createApiKey(app.id, "默认密钥"); setNewKey(item.api_key ?? ""); await load(); }
    catch (reason) { onError(reason); } finally { setCreating(false); }
  }
  async function removeKey(id: string) { try { await api.deleteApiKey(app.id, id); await load(); } catch (reason) { onError(reason); } }
  const curl = `curl -X POST '${baseUrl}/workflows/run' \\\n  -H 'Authorization: Bearer {API_KEY}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"input":"请总结这段内容"}'`;
  return <section className="app-feature-page"><div className="feature-heading"><div><h2>Workflow 应用 API</h2><p>通过 Service API 调用当前工作流，适用于自动化、内容处理和后端服务集成。</p></div><button className="primary" onClick={createKey} disabled={creating}>{creating ? "创建中" : "＋ 创建 API Key"}</button></div>{newKey && <div className="api-key-once"><strong>请立即保存此密钥，仅显示一次</strong><code>{newKey}</code><button onClick={() => navigator.clipboard.writeText(newKey)}>复制</button><button onClick={() => setNewKey("")}>关闭</button></div>}<div className="api-doc-layout"><article className="api-doc"><h3>Base URL</h3><CodeBlock value={baseUrl} /><h3>Authentication</h3><p>所有请求都需要在 <code>Authorization</code> Header 中携带 Service API Key。</p><CodeBlock value="Authorization: Bearer {API_KEY}" /><h3>执行 Workflow</h3><p><code>POST /workflows/run</code> 同步执行当前应用工作流并返回最终输出。</p><CodeBlock value={curl} /><h3>返回示例</h3><CodeBlock value={'{"workflow_run_id":"...","status":"succeeded","output":"...","duration_ms":1234}'} /></article><aside className="api-key-panel"><header><strong>API 密钥</strong><span>{keys.length} 个</span></header>{keys.map((key) => <div className="api-key-row" key={key.id}><div><strong>{key.name}</strong><code>{key.key_prefix}••••••••</code><small>{key.last_used_at ? `最后使用 ${new Date(key.last_used_at).toLocaleString()}` : "尚未使用"}</small></div><button onClick={() => removeKey(key.id)}>删除</button></div>)}{!keys.length && <p>还没有 API Key，创建后即可调用。</p>}</aside></div></section>;
}

function CodeBlock({ value }: { value: string }) { return <div className="api-code"><button onClick={() => navigator.clipboard.writeText(value)}>复制</button><pre>{value}</pre></div>; }

function AppLogsPanel({ app, onError }: { app: FlowApp; onError: (reason: unknown) => void }) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<WorkflowRun | null>(null);
  const [nodeRuns, setNodeRuns] = useState<NodeRun[]>([]);
  const load = () => api.listWorkflowRuns(app.id).then(setRuns).catch(onError);
  useEffect(() => { void load(); }, [app.id]);
  async function openDetail(run: WorkflowRun) {
    setSelected(run); setNodeRuns([]);
    try { setNodeRuns(await api.listWorkflowNodeRuns(run.id)); } catch (reason) { onError(reason); }
  }
  const visible = runs.filter((run) => (status === "all" || run.status === status) && `${run.input} ${run.output ?? ""} ${run.error ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="app-feature-page logs-page"><div className="feature-heading"><div><h2>日志</h2><p>查看应用的工作流执行情况、触发来源和耗时。</p></div><button onClick={load}>↻ 刷新</button></div><div className="log-filters"><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="running">运行中</option></select><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索输入、输出或错误" /></div><div className="log-table"><header><span>开始时间</span><span>状态</span><span>运行时间</span><span>触发方式</span><span>输入</span></header>{visible.map((run) => <div key={run.id} role="button" tabIndex={0} onClick={() => openDetail(run)} onKeyDown={(event) => { if (event.key === "Enter") openDetail(run); }}><span>{new Date(run.created_at).toLocaleString()}</span><span className={`run-status ${run.status}`}>{run.status === "succeeded" ? "SUCCESS" : run.status === "failed" ? "FAILED" : "RUNNING"}</span><span>{run.duration_ms == null ? "—" : `${(run.duration_ms / 1000).toFixed(3)}s`}</span><span>{run.trigger_source === "api" ? "⌘ API" : "▷ 调试"}</span><span title={run.input}>{run.input}</span></div>)}{!visible.length && <p>暂无符合条件的运行日志。</p>}</div>{selected && <RunDetailModal run={selected} nodes={nodeRuns} close={() => setSelected(null)} />}</section>;
}

function RunDetailModal({ run, nodes, close }: { run: WorkflowRun; nodes: NodeRun[]; close: () => void }) {
  const [tab, setTab] = useState<"result" | "detail" | "trace">("trace");
  const [expanded, setExpanded] = useState("");
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  return <div className="run-detail-backdrop" onClick={close}><div className="run-detail-modal" onClick={(event) => event.stopPropagation()}><header><h3>日志详情</h3><button onClick={close}>×</button></header><nav><button className={tab === "result" ? "active" : ""} onClick={() => setTab("result")}>结果</button><button className={tab === "detail" ? "active" : ""} onClick={() => setTab("detail")}>详情</button><button className={tab === "trace" ? "active" : ""} onClick={() => setTab("trace")}>追踪</button></nav>{tab === "result" && <div className="run-result"><div className={`run-summary ${run.status}`}><span>状态<strong>{run.status.toUpperCase()}</strong></span><span>运行时间<strong>{run.duration_ms == null ? "—" : `${(run.duration_ms / 1000).toFixed(3)}s`}</strong></span><span>运行节点<strong>{nodes.length}</strong></span></div>{run.error ? <pre className="run-error">{run.error}</pre> : <pre>{run.output || "暂无输出"}</pre>}</div>}{tab === "detail" && <div className="run-detail-content"><div className={`run-summary ${run.status}`}><span>状态<strong>{run.status.toUpperCase()}</strong></span><span>运行时间<strong>{run.duration_ms == null ? "—" : `${(run.duration_ms / 1000).toFixed(3)}s`}</strong></span><span>触发方式<strong>{run.trigger_source === "api" ? "API" : "调试"}</strong></span></div><CodePanel title="输入" value={run.input} /><CodePanel title="输出" value={run.output ?? run.error ?? ""} /><dl><dt>运行 ID</dt><dd>{run.id}</dd><dt>开始时间</dt><dd>{new Date(run.created_at).toLocaleString()}</dd><dt>结束时间</dt><dd>{run.finished_at ? new Date(run.finished_at).toLocaleString() : "—"}</dd><dt>运行步数</dt><dd>{nodes.length}</dd></dl></div>}{tab === "trace" && <div className="run-trace">{nodes.map((node, index) => <section key={node.id} className={node.status}><button onClick={() => setExpanded((id) => id === node.id ? "" : node.id)}><i>{expanded === node.id ? "⌄" : "›"}</i><b>{index + 1}</b><strong>{node.node_type.toUpperCase()} · {node.node_id}</strong><span>{node.duration_ms == null ? "—" : `${node.duration_ms} ms`}</span><em>{node.status === "succeeded" ? "●" : node.status === "failed" ? "×" : "…"}</em></button>{expanded === node.id && <div><CodePanel title="输入" value={json(node.input)} /><CodePanel title="输出" value={node.error ?? json(node.output ?? {})} /></div>}</section>)}{!nodes.length && <p>正在加载节点追踪信息…</p>}</div>}</div></div>;
}

function CodePanel({ title, value }: { title: string; value: string }) { return <div className="run-code-panel"><header><strong>{title}</strong><button onClick={() => navigator.clipboard.writeText(value)}>复制</button></header><pre>{value || "—"}</pre></div>; }

function MarkdownResult({ content }: { content: string }) {
  return <div className="markdown-result"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>;
}

function Studio({ apps, allApps, filter, setFilter, onCreate, onImport, onImportInto, onOpen, onEdit, onDuplicate, onExport, onDelete, onDeleteWorkspace, disabled }: { apps: FlowApp[]; allApps: FlowApp[]; filter: AppFilter; setFilter: (value: AppFilter) => void; onCreate: () => void; onImport: () => void; onImportInto: (app: FlowApp) => void; onOpen: (app: FlowApp) => void; onEdit: (app: FlowApp) => void; onDuplicate: (app: FlowApp) => void; onExport: (app: FlowApp) => void; onDelete: (app: FlowApp) => void; onDeleteWorkspace: () => void; disabled: boolean }) {
  const [search, setSearch] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [menuId, setMenuId] = useState("");
  const visible = apps.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="studio-wrap"><div className="studio-controls"><nav><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>▦ 全部</button>{appTypes.map((type) => <button key={type.id} className={filter === type.id ? "active" : ""} onClick={() => setFilter(type.id)}>{type.icon} {type.label}</button>)}</nav><div><label className="mine-filter"><input type="checkbox" checked={mineOnly} onChange={(event) => setMineOnly(event.target.checked)} />我创建的</label><select className="tag-filter"><option>◇ 全部标签</option></select><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="⌕ 搜索" /><button className="studio-space-menu" onClick={onDeleteWorkspace} disabled={disabled}>•••</button></div></div><div className="studio-grid"><article className="studio-create-card"><strong>创建应用</strong><button onClick={onCreate} disabled={disabled}><span>＋</span><div>创建空白应用<small>选择类型，从零开始构建</small></div></button><button onClick={onCreate} disabled={disabled}><span>▤</span><div>从应用模板创建<small>使用预置场景快速开始</small></div></button><button onClick={onImport} disabled={disabled}><span>↪</span><div>导入 DSL 文件<small>恢复或迁移已有应用</small></div></button></article>{visible.map((item) => { const type = appTypes.find((entry) => entry.id === item.app_type); return <article className="studio-card" key={item.id} onClick={() => onOpen(item)}><header><span>{type?.icon ?? "✦"}<b>{item.app_type === "workflow" ? "⌘" : "◉"}</b></span><div><h3>{item.name}</h3><small>LOB Flow · 编辑于 {new Date(item.updated_at).toLocaleDateString()}</small></div><div className="studio-card-menu"><button onClick={(event) => { event.stopPropagation(); setMenuId((id) => id === item.id ? "" : item.id); }}>•••</button>{menuId === item.id && <div onClick={(event) => event.stopPropagation()}><button onClick={() => { onEdit(item); setMenuId(""); }}>编辑信息</button><button onClick={() => { onDuplicate(item); setMenuId(""); }}>复制</button><button onClick={() => { onExport(item); setMenuId(""); }}>导出 DSL</button><button onClick={() => { onImportInto(item); setMenuId(""); }}>导入 DSL</button><button onClick={() => { onOpen(item); setMenuId(""); }}>打开调试</button><button className="delete" onClick={() => { onDelete(item); setMenuId(""); }}>删除</button></div>}</div></header><p>{item.description || type?.description}</p><footer><span>◇ 添加标签</span><i>{type?.label}</i></footer></article>; })}</div>{!visible.length && allApps.length > 0 && <div className="knowledge-empty">没有匹配的应用</div>}</section>;
}

function Welcome({ onCreate, disabled }: { onCreate: () => void; disabled: boolean }) {
  return <div className="welcome"><div className="welcome-icon">⌁</div><h2>构建第一个 AI 应用</h2><p>先配置模型，再从一条真实对话开始理解应用运行链路。</p><button className="primary" onClick={onCreate} disabled={disabled}>创建应用</button></div>;
}

function ChatPanel({ app, providers, onSettings, onError }: { app: FlowApp; providers: ProviderConfig[]; onSettings: () => void; onError: (reason: unknown) => void }) {
  const [input, setInput] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [running, setRunning] = useState(false);
  const [meta, setMeta] = useState("");
  const [inputVariables, setInputVariables] = useState<StartInputVariable[]>([]);
  const [structuredInputs, setStructuredInputs] = useState<Record<string, unknown>>({});
  const [submittedInputs, setSubmittedInputs] = useState<Record<string, unknown> | null>(null);
  const usesWorkflow = app.app_type === "workflow" || app.app_type === "chatflow";
  const hasProvider = !!app.draft.model.provider_config_id && providers.some((item) => item.id === app.draft.model.provider_config_id);
  const canRun = usesWorkflow || hasProvider;
  useEffect(() => {
    if (!usesWorkflow) { setInputVariables([]); return; }
    api.getWorkflow(app.id).then((draft) => {
      const variables = (draft.definition.nodes.find((node) => node.type === "start")?.config.variables as StartInputVariable[] | undefined) ?? [];
      setInputVariables(variables);
      setStructuredInputs(Object.fromEntries(variables.filter((variable) => variable.default !== undefined && variable.default !== "").map((variable) => [variable.name, variable.default])));
    }).catch(onError);
  }, [app.id, usesWorkflow]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canRun) { onError("请先配置真实模型供应商和 API Key，再运行应用。"); return; }
    const missing = inputVariables.some((variable) => variable.required && (structuredInputs[variable.name] ?? variable.default ?? "") === "");
    if ((inputVariables.length ? missing : !input.trim()) || running) return;
    const payload = inputVariables.length ? structuredInputs : input.trim();
    const message = inputVariables.length ? JSON.stringify(structuredInputs, null, 2) : input.trim();
    setQuestion(message); setSubmittedInputs(inputVariables.length ? { ...structuredInputs } : null); if (!inputVariables.length) setInput(""); setAnswer(""); setMeta(""); setRunning(true);
    try {
      if (usesWorkflow) {
        await api.streamWorkflow(app.id, payload, (item) => {
          if (item.type === "workflow_succeeded") {
            setAnswer(String(item.data.output ?? ""));
            setMeta(`${item.data.duration_ms ?? "--"} ms · 工作流运行完成`);
          }
          if (item.type === "workflow_failed") onError(`${item.data.error_code}: ${item.data.error}`);
        });
      } else {
        await api.streamRun(app.id, message, (item) => {
          if (item.type === "message_delta") setAnswer((value) => value + String(item.data.delta ?? ""));
          if (item.type === "model_completed") {
            const usage = item.data.usage as Record<string, number | null>;
            setMeta(`${item.data.duration_ms} ms · ${usage.total_tokens ?? "--"} tokens · ${item.data.finish_reason ?? "完成"}`);
          }
          if (item.type === "run_failed") onError(`${item.data.error_code}: ${item.data.error}`);
        });
      }
    } catch (reason) { onError(reason); } finally { setRunning(false); }
  }

  return <section className="chat-layout">
    <div className="chat-stage">
      <div className="chat-heading"><div><h2>对话调试</h2><p>{usesWorkflow ? "执行当前工作流草稿" : app.draft.model.model}</p></div><span className="draft-badge">DRAFT</span></div>
      <div className="conversation">
        {!canRun && <div className="model-required"><span>AI</span><h3>还没有可用的真实模型</h3><p>配置 OpenAI-compatible API Key，并为当前应用选择模型后即可调试。</p><button className="primary" onClick={onSettings}>前往模型设置</button></div>}
        {canRun && !question && !answer && !running && <div className="conversation-empty"><span>✦</span><h3>测试你的应用</h3><p>{usesWorkflow ? "消息会从开始节点进入，并执行当前工作流中的全部节点。" : "输入一条消息，观察模型输出和运行指标。"}</p></div>}
        {question && <div className="message user-message"><div><div className="bubble">{submittedInputs ? <dl className="submitted-inputs">{Object.entries(submittedInputs).map(([key, value]) => <div key={key}><dt>{inputVariables.find((variable) => variable.name === key)?.label || key}</dt><dd>{typeof value === "boolean" ? value ? "是" : "否" : String(value)}</dd></div>)}</dl> : question}</div></div><div className="avatar user-avatar">你</div></div>}
        {(answer || running) && <div className="message ai-message"><div className="avatar ai-avatar"><img src={lobsterLogo} alt="LOB AI" /></div><div><div className="bubble">{answer ? <MarkdownResult content={answer} /> : <span className="typing">正在思考</span>}</div>{meta && <div className="message-meta">{meta}</div>}</div></div>}
      </div>
      <form className={`composer ${inputVariables.length ? "structured-composer" : ""}`} onSubmit={submit}>
        {inputVariables.length ? <div className="chat-structured-inputs"><header><div><strong>运行参数</strong><small>来自开始节点的输入定义</small></div><button type="button" onClick={() => setStructuredInputs({})}>清空</button></header><div>{inputVariables.map((variable) => <label key={variable.name}><span>{variable.label || variable.name}{variable.required ? <b>*</b> : null}</span><small>{variable.description || `${variable.name} · ${variable.type}`}</small>{variable.type === "boolean" ? <select value={String(structuredInputs[variable.name] ?? variable.default ?? "false")} onChange={(event) => setStructuredInputs({ ...structuredInputs, [variable.name]: event.target.value === "true" })}><option value="false">否</option><option value="true">是</option></select> : <input type={variable.type === "number" ? "number" : "text"} value={String(structuredInputs[variable.name] ?? variable.default ?? "")} onChange={(event) => setStructuredInputs({ ...structuredInputs, [variable.name]: event.target.value })} placeholder={`请输入${variable.label || variable.name}`} />}</label>)}</div></div> : <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="输入消息，Enter 发送，Shift + Enter 换行…"
          rows={3}
        />}
        <button className="send" disabled={!canRun || running || (inputVariables.length ? inputVariables.some((variable) => variable.required && (structuredInputs[variable.name] ?? variable.default ?? "") === "") : !input.trim())}>{running ? "运行中" : inputVariables.length ? "运行工作流" : "发送"}</button>
      </form>
    </div>
  </section>;
}

function SettingsPanel(props: {
  app: FlowApp; workspaceId: string; providers: ProviderConfig[];
  setProviders: (value: ProviderConfig[]) => void;
  onSaved: (app: FlowApp) => void; onError: (reason: unknown) => void;
}) {
  const { app, workspaceId, providers, setProviders, onSaved, onError } = props;
  const [draft, setDraft] = useState<DraftDefinition>(app.draft);
  const [showCredential, setShowCredential] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null);
  const [credentialKey, setCredentialKey] = useState("");
  const [showCredentialKey, setShowCredentialKey] = useState(false);
  const [credentialName, setCredentialName] = useState("OpenAI");
  const [credentialBaseUrl, setCredentialBaseUrl] = useState("https://api.openai.com/v1");
  const [credentialModel, setCredentialModel] = useState("gpt-5.4");
  const [providerPreset, setProviderPreset] = useState("openai");

  useEffect(() => {
    if (!app.draft.model.provider_config_id && providers[0]) {
      const nextDraft = { ...app.draft, model: { ...app.draft.model, provider_config_id: providers[0].id } };
      setDraft(nextDraft);
      api.updateDraft(app.id, nextDraft).then(onSaved).catch(onError);
    } else {
      setDraft(app.draft);
    }
  }, [app, providers]);

  async function save() {
    setSaving(true);
    try { onSaved(await api.updateDraft(app.id, draft)); }
    catch (reason) { onError(reason); }
    finally { setSaving(false); }
  }

  function openNewProvider() {
    const preset = providerPresets[0];
    setEditingProvider(null); setCredentialKey(""); setShowCredentialKey(false); setProviderPreset(preset.id); setCredentialName(preset.label); setCredentialBaseUrl(preset.baseUrl); setCredentialModel(preset.model); setShowCredential(true);
  }

  async function openProvider(item: ProviderConfig) {
    setEditingProvider(item); setCredentialKey(""); setShowCredentialKey(false); setProviderPreset(""); setCredentialName(item.name); setCredentialBaseUrl(item.base_url); setCredentialModel(draft.model.model || "gpt-5.4"); setShowCredential(true);
    try { setCredentialKey((await api.revealProviderKey(workspaceId, item.id)).api_key); }
    catch (reason) { onError(`现有密钥读取失败，仍可输入新密钥后保存：${reason instanceof Error ? reason.message : String(reason)}`); }
  }

  async function saveCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const body = { name: credentialName, base_url: credentialBaseUrl, api_key: credentialKey };
      const created = editingProvider
        ? await api.updateProvider(workspaceId, editingProvider.id, body)
        : await api.createProvider(workspaceId, body);
      const model = credentialModel;
      setProviders(editingProvider ? providers.map((item) => item.id === created.id ? created : item) : [...providers, created]);
      const appliesToDraft = !editingProvider || !draft.model.provider_config_id || draft.model.provider_config_id === editingProvider.id;
      const nextDraft = appliesToDraft ? { ...draft, model: { ...draft.model, provider: "openai_compatible" as const, provider_config_id: created.id, model } } : draft;
      setDraft(nextDraft);
      if (appliesToDraft) onSaved(await api.updateDraft(app.id, nextDraft));
      setShowCredential(false); setEditingProvider(null); setCredentialKey("");
    } catch (reason) { onError(reason); }
  }

  function applyProviderPreset(id: string) {
    const preset = providerPresets.find((item) => item.id === id);
    if (!preset) return;
    setProviderPreset(id); setCredentialName(preset.label); setCredentialBaseUrl(preset.baseUrl); setCredentialModel(preset.model);
  }

  return <section className="settings-wrap">
    <div className="settings-main">
      <div className="panel-title"><div><h2>模型与 Prompt</h2><p>配置只影响当前草稿，凭据由工作空间统一管理。</p></div><button className="primary" onClick={save} disabled={saving}>{saving ? "保存中" : "保存草稿"}</button></div>
      <div className="card">
        <div className="form-grid two">
          <div><label>模型供应商</label><select value={draft.model.provider_config_id ?? ""} onChange={(e) => setDraft({ ...draft, model: { ...draft.model, provider_config_id: e.target.value || null } })}><option value="">请选择真实模型配置</option>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
          <div><label>模型名称</label><input value={draft.model.model} onChange={(e) => setDraft({ ...draft, model: { ...draft.model, model: e.target.value } })} /></div>
        </div>
        {!providers.length && <button className="text-button provider-add" onClick={openNewProvider}>＋ 添加真实模型配置</button>}
      </div>
      <div className="card form-grid">
        <div><label>System Prompt</label><textarea rows={5} value={draft.system_prompt} onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })} /></div>
        <div><label>用户 Prompt 模板</label><textarea rows={4} value={draft.user_prompt_template} onChange={(e) => setDraft({ ...draft, user_prompt_template: e.target.value })} /><span className="hint">使用 <code>{"{input}"}</code> 引用用户输入</span></div>
      </div>
    </div>
    <aside className="provider-panel">
      <div className="panel-title compact"><div><h3>模型供应商</h3><p>API Key 加密保存</p></div><button className="icon-button" onClick={openNewProvider}>＋</button></div>
      {providers.map((item) => <button className="provider-item provider-edit" key={item.id} onClick={() => openProvider(item)}><div className="provider-logo">AI</div><div><strong>{item.name}</strong><span>{item.base_url}</span></div><span className="secure">编辑 ›</span></button>)}
      {!providers.length && <div className="empty-provider">尚未配置真实模型</div>}
    </aside>
    {showCredential && <div className="modal-backdrop"><form className="modal provider-modal" onSubmit={saveCredential}><div className="modal-head"><div><h3>{editingProvider ? "API 密钥授权配置" : "添加模型配置"}</h3><p>{editingProvider ? "修改凭据后，当前空间中的应用会继续使用此配置。" : "选择常见厂商或填写任意 OpenAI-compatible API"}</p></div><button type="button" onClick={() => setShowCredential(false)}>×</button></div><label>模型厂商</label><div className="provider-presets">{providerPresets.map((preset) => <button type="button" key={preset.id} className={providerPreset === preset.id ? "active" : ""} onClick={() => applyProviderPreset(preset.id)}><i>{preset.icon}</i><span>{preset.label}</span></button>)}</div><label>配置名称</label><input value={credentialName} onChange={(event) => setCredentialName(event.target.value)} placeholder="例如：OpenAI" required /><label>API Key</label><div className="secret-input"><input value={credentialKey} onChange={(event) => setCredentialKey(event.target.value)} type={showCredentialKey ? "text" : "password"} autoComplete="off" placeholder={editingProvider ? "正在解密…" : providerPreset === "ollama" ? "Ollama 可填写任意非空值" : "输入 API Key"} required /><button type="button" onClick={() => setShowCredentialKey((visible) => !visible)}>{showCredentialKey ? "隐藏" : "显示"}</button></div><label>Base URL</label><input value={credentialBaseUrl} onChange={(event) => { setCredentialBaseUrl(event.target.value); setProviderPreset(""); }} required /><label>模型名称</label><input value={credentialModel} onChange={(event) => setCredentialModel(event.target.value)} required /><div className="security-note">🔒 密钥仅在你主动编辑时解密显示，提交后仍以加密形式保存。</div><button className="primary wide">{editingProvider ? "保存修改" : "保存配置"}</button></form></div>}
  </section>;
}

const nodeTypeLabel = { start: "START", template: "TEMPLATE", llm: "LLM", knowledge: "KNOWLEDGE", tool: "TOOL", condition: "IF/ELSE", switch: "SWITCH", answer: "ANSWER" } as const;

function WorkflowPanel({ app, providers, onError }: { app: FlowApp; providers: ProviderConfig[]; onError: (reason: unknown) => void }) {
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [input, setInput] = useState("请介绍一下这个工作流");
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [answer, setAnswer] = useState("");

  useEffect(() => {
    setDefinition(null); setStatuses({}); setOutputs({}); setAnswer("");
    api.getWorkflow(app.id).then((draft) => setDefinition(draft.definition)).catch(onError);
  }, [app.id]);

  function updateNode(nodeId: string, patch: Record<string, unknown>) {
    setDefinition((current) => current ? {
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, config: { ...node.config, ...patch } } : node)
    } : current);
  }

  async function save() {
    if (!definition) return;
    setSaving(true);
    try { setDefinition((await api.updateWorkflow(app.id, definition)).definition); }
    catch (reason) { onError(reason); }
    finally { setSaving(false); }
  }

  async function run() {
    if (!definition || !input.trim() || running) return;
    setRunning(true); setStatuses({}); setOutputs({}); setAnswer("");
    try {
      await api.streamWorkflow(app.id, input.trim(), (event: WorkflowEvent) => {
        const nodeId = event.node_id;
        if (nodeId && event.type === "node_started") setStatuses((value) => ({ ...value, [nodeId]: "running" }));
        if (nodeId && event.type === "node_delta") setOutputs((value) => ({ ...value, [nodeId]: (value[nodeId] ?? "") + String(event.data.delta ?? "") }));
        if (nodeId && event.type === "node_succeeded") {
          setStatuses((value) => ({ ...value, [nodeId]: "succeeded" }));
          const output = event.data.output as { value?: string } | undefined;
          if (output?.value) setOutputs((value) => ({ ...value, [nodeId]: output.value! }));
        }
        if (event.type === "workflow_succeeded") setAnswer(String(event.data.output ?? ""));
        if (event.type === "workflow_failed") onError(`${event.data.error_code}: ${event.data.error}`);
      });
    } catch (reason) { onError(reason); }
    finally { setRunning(false); }
  }

  if (!definition) return <div className="workflow-loading">正在加载工作流…</div>;
  return <section className="workflow-wrap">
    <div className="workflow-editor">
      <div className="panel-title"><div><h2>工作流草稿</h2><p>按 DAG 顺序执行，每个节点都有独立状态与运行记录。</p></div><button className="primary" onClick={save} disabled={saving}>{saving ? "保存中" : "保存工作流"}</button></div>
      <div className="workflow-chain">
        {definition.nodes.map((node, index) => <div key={node.id} className="workflow-node-wrap">
          {index > 0 && <div className="workflow-arrow">↓</div>}
          <WorkflowNodeCard node={node} providers={providers} status={statuses[node.id]} output={outputs[node.id]} updateNode={updateNode} />
        </div>)}
      </div>
    </div>
    <aside className="workflow-debug">
      <div><h3>运行调试</h3><p>保存后输入一条消息，观察节点依次执行。</p></div>
      <textarea rows={6} value={input} onChange={(event) => setInput(event.target.value)} />
      <button className="primary wide" onClick={run} disabled={running || !input.trim()}>{running ? "执行中" : "运行工作流"}</button>
      {answer && <div className="workflow-answer"><span>最终回答</span><p>{answer}</p></div>}
    </aside>
  </section>;
}

function WorkflowNodeCard({ node, providers, status, output, updateNode }: { node: WorkflowNode; providers: ProviderConfig[]; status?: string; output?: string; updateNode: (id: string, patch: Record<string, unknown>) => void }) {
  return <article className={`workflow-node node-${node.type} ${status ?? ""}`}>
    <div className="workflow-node-head"><span className="node-type">{nodeTypeLabel[node.type]}</span><strong>{node.name}</strong><span className="node-status">{status === "running" ? "运行中" : status === "succeeded" ? "完成" : "待运行"}</span></div>
    {node.type === "start" && <p className="node-description">接收工作流输入并写入变量 <code>input</code></p>}
    {node.type === "template" && <div><label>Prompt 模板</label><textarea rows={3} value={String(node.config.template ?? "")} onChange={(event) => updateNode(node.id, { template: event.target.value })} /></div>}
    {node.type === "llm" && <div className="form-grid two"><div><label>模型配置</label><select value={String(node.config.provider_config_id ?? "")} onChange={(event) => updateNode(node.id, { provider_config_id: event.target.value })}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></div><div><label>模型</label><input value={String(node.config.model ?? "gpt-5.4")} onChange={(event) => updateNode(node.id, { model: event.target.value })} /></div><div className="node-system"><label>System Prompt</label><textarea rows={3} value={String(node.config.system_prompt ?? "")} onChange={(event) => updateNode(node.id, { system_prompt: event.target.value })} /></div></div>}
    {node.type === "answer" && <p className="node-description">将上游 LLM 输出作为工作流最终回答。</p>}
    {output && <div className="node-output"><span>输出</span><p>{output}</p></div>}
  </article>;
}
