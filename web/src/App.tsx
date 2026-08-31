import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { App as FlowApp, AppType, DraftDefinition, ProviderConfig, WorkflowDefinition, WorkflowEvent, WorkflowNode, Workspace } from "./types";
import lobsterLogo from "./assets/lobster-logo.png";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { PluginMarketplace } from "./PluginMarketplace";
import { KnowledgeBase } from "./KnowledgeBase";
import { ToolsLibrary } from "./ToolsLibrary";

type Tab = "chat" | "workflow" | "knowledge" | "tools" | "plugins" | "settings";
type AppFilter = "all" | AppType;

const appTypes: Array<{ id: AppType; label: string; icon: string; description: string }> = [
  { id: "workflow", label: "工作流", icon: "⌘", description: "面向自动化与批处理的可视化编排" },
  { id: "chatflow", label: "Chatflow", icon: "▣", description: "带会话体验的可视化工作流" },
  { id: "chat_assistant", label: "聊天助手", icon: "◉", description: "由 Prompt 驱动的多轮对话助手" },
  { id: "agent", label: "Agent", icon: "♙", description: "可自主选择工具完成任务的智能体" },
  { id: "text_generation", label: "文本生成", icon: "T", description: "单次输入、结构化生成文本" }
];

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [apps, setApps] = useState<FlowApp[]>([]);
  const [appId, setAppId] = useState("");
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [tab, setTab] = useState<Tab>("chat");
  const [error, setError] = useState("");
  const [appFilter, setAppFilter] = useState<AppFilter>("all");
  const [showCreateApp, setShowCreateApp] = useState(false);

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
    setError(reason instanceof Error ? reason.message : String(reason));
  }

  async function createWorkspace() {
    const name = window.prompt("空间名称");
    if (!name?.trim()) return;
    try {
      const created = await api.createWorkspace(name.trim());
      setWorkspaces((items) => [...items, created]);
      setWorkspaceId(created.id);
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
    if (!workspace || !window.confirm(`确定删除空间“${workspace.name}”吗？\n该空间内的应用、工作流、运行记录和插件配置都会永久删除。`)) return;
    try {
      await api.deleteWorkspace(workspace.id);
      const remaining = workspaces.filter((item) => item.id !== workspace.id);
      setWorkspaces(remaining);
      setWorkspaceId(remaining[0]?.id ?? "");
      setApps([]);
      setAppId("");
      setError("");
    } catch (reason) { showError(reason); }
  }

  async function deleteApp(item: FlowApp) {
    if (!window.confirm(`确定删除应用“${item.name}”吗？\n相关工作流和全部运行记录都会永久删除。`)) return;
    try {
      await api.deleteApp(item.id);
      const remaining = apps.filter((app) => app.id !== item.id);
      setApps(remaining);
      if (appId === item.id) setAppId(remaining[0]?.id ?? "");
      setError("");
    } catch (reason) { showError(reason); }
  }

  function replaceApp(updated: FlowApp) {
    setApps((items) => items.map((item) => item.id === updated.id ? updated : item));
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><img className="brand-logo" src={lobsterLogo} alt="LOB" /><span className="brand-copy"><strong>LOB Flow</strong><small>AI 应用编排</small></span></div>
        <div className="section-label">工作空间</div>
        <div className="select-row">
          <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            <option value="">选择空间</option>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <button className="icon-button" onClick={createWorkspace} title="新建空间">＋</button>
          <button className="icon-button danger-icon" onClick={deleteWorkspace} disabled={!workspaceId} title="删除当前空间">×</button>
        </div>
        <div className="section-title"><span>应用</span><button className="text-button" onClick={createApp}>新建</button></div>
        <div className="app-type-filter"><button className={appFilter === "all" ? "active" : ""} onClick={() => setAppFilter("all")}>全部</button>{appTypes.map((type) => <button key={type.id} title={type.label} className={appFilter === type.id ? "active" : ""} onClick={() => setAppFilter(type.id)}>{type.icon}</button>)}</div>
        <nav className="app-list">
          {visibleApps.map((item) => <div key={item.id} className={item.id === appId ? "app-row active" : "app-row"}>
            <button className="app-item" onClick={() => setAppId(item.id)}><span className="app-icon">{appTypes.find((type) => type.id === item.app_type)?.icon ?? "✦"}</span><span><strong>{item.name}</strong><small>{appTypes.find((type) => type.id === item.app_type)?.label}</small></span></button>
            <button className="app-delete" onClick={() => deleteApp(item)} title={`删除 ${item.name}`}>×</button>
          </div>)}
          {!visibleApps.length && <div className="empty-small">{apps.length ? "此分类暂无应用" : "还没有应用"}</div>}
        </nav>
        <div className="sidebar-foot"><span className="status-dot" />PostgreSQL 已连接</div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div><div className="eyebrow">AI APPLICATION</div><h1>{tab === "knowledge" ? "知识库" : tab === "tools" ? "工具" : activeApp?.name ?? "选择或创建应用"}</h1></div>
          {workspaceId && <div className="tabs">
            <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>调试</button>
            <button className={tab === "workflow" ? "active" : ""} onClick={() => setTab("workflow")}>工作流</button>
            <button className={tab === "knowledge" ? "active" : ""} onClick={() => setTab("knowledge")}>知识库</button>
            <button className={tab === "tools" ? "active" : ""} onClick={() => setTab("tools")}>工具</button>
            <button className={tab === "plugins" ? "active" : ""} onClick={() => setTab("plugins")}>插件市场</button>
            <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>模型设置</button>
          </div>}
        </header>
        {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
        {tab === "knowledge" ? <KnowledgeBase workspaceId={workspaceId} onError={showError} /> : tab === "tools" ? <ToolsLibrary workspaceId={workspaceId} onError={showError} /> : !activeApp ? <Welcome onCreate={createApp} disabled={!workspaceId} /> : tab === "chat" ? (
          <ChatPanel app={activeApp} onError={showError} />
        ) : tab === "workflow" ? (
          <WorkflowCanvas app={activeApp} workspaceId={workspaceId} providers={providers} onError={showError} />
        ) : tab === "plugins" ? (
          <PluginMarketplace workspaceId={workspaceId} onError={showError} />
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
      {showCreateApp && <div className="modal-backdrop"><form className="modal app-create-modal" onSubmit={submitCreateApp}><div className="modal-head"><div><h3>创建应用</h3><p>应用类型决定默认运行方式，创建后仍可使用工作流编排。</p></div><button type="button" onClick={() => setShowCreateApp(false)}>×</button></div><label>应用名称</label><input name="name" required autoFocus placeholder="例如：客户支持 Agent" /><label>应用类型</label><div className="app-type-options">{appTypes.map((type, index) => <label key={type.id}><input type="radio" name="app_type" value={type.id} defaultChecked={index === 1} /><span><i>{type.icon}</i><strong>{type.label}</strong><small>{type.description}</small></span></label>)}</div><button className="primary wide">创建应用</button></form></div>}
    </div>
  );
}

function Welcome({ onCreate, disabled }: { onCreate: () => void; disabled: boolean }) {
  return <div className="welcome"><div className="welcome-icon">⌁</div><h2>构建第一个 AI 应用</h2><p>先配置模型，再从一条真实对话开始理解应用运行链路。</p><button className="primary" onClick={onCreate} disabled={disabled}>创建应用</button></div>;
}

function ChatPanel({ app, onError }: { app: FlowApp; onError: (reason: unknown) => void }) {
  const [input, setInput] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [running, setRunning] = useState(false);
  const [meta, setMeta] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!input.trim() || running) return;
    const message = input.trim();
    setQuestion(message); setInput(""); setAnswer(""); setMeta(""); setRunning(true);
    try {
      await api.streamRun(app.id, message, (item) => {
        if (item.type === "message_delta") setAnswer((value) => value + String(item.data.delta ?? ""));
        if (item.type === "model_completed") {
          const usage = item.data.usage as Record<string, number | null>;
          setMeta(`${item.data.duration_ms} ms · ${usage.total_tokens ?? "--"} tokens · ${item.data.finish_reason ?? "完成"}`);
        }
        if (item.type === "run_failed") onError(`${item.data.error_code}: ${item.data.error}`);
      });
    } catch (reason) { onError(reason); } finally { setRunning(false); }
  }

  return <section className="chat-layout">
    <div className="chat-stage">
      <div className="chat-heading"><div><h2>对话调试</h2><p>{app.draft.model.model}</p></div><span className="draft-badge">DRAFT</span></div>
      <div className="conversation">
        {!question && !answer && !running && <div className="conversation-empty"><span>✦</span><h3>测试你的应用</h3><p>输入一条消息，观察模型输出和运行指标。</p></div>}
        {question && <div className="message user-message"><div><div className="bubble">{question}</div></div><div className="avatar user-avatar">你</div></div>}
        {(answer || running) && <div className="message ai-message"><div className="avatar ai-avatar"><img src={lobsterLogo} alt="LOB AI" /></div><div><div className="bubble">{answer || <span className="typing">正在思考</span>}</div>{meta && <div className="message-meta">{meta}</div>}</div></div>}
      </div>
      <form className="composer" onSubmit={submit}>
        <textarea
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
        />
        <button className="send" disabled={running || !input.trim()}>{running ? "运行中" : "发送"}</button>
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

  useEffect(() => setDraft(app.draft), [app]);

  async function save() {
    setSaving(true);
    try { onSaved(await api.updateDraft(app.id, draft)); }
    catch (reason) { onError(reason); }
    finally { setSaving(false); }
  }

  async function createCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const created = await api.createProvider(workspaceId, {
        name: String(data.get("name")), base_url: String(data.get("base_url")), api_key: String(data.get("api_key"))
      });
      const model = String(data.get("model"));
      setProviders([...providers, created]);
      setDraft((value) => ({ ...value, model: { ...value.model, provider: "openai_compatible", provider_config_id: created.id, model } }));
      setShowCredential(false);
    } catch (reason) { onError(reason); }
  }

  return <section className="settings-wrap">
    <div className="settings-main">
      <div className="panel-title"><div><h2>模型与 Prompt</h2><p>配置只影响当前草稿，凭据由工作空间统一管理。</p></div><button className="primary" onClick={save} disabled={saving}>{saving ? "保存中" : "保存草稿"}</button></div>
      <div className="card">
        <div className="form-grid two">
          <div><label>模型供应商</label><select value={draft.model.provider_config_id ?? ""} onChange={(e) => setDraft({ ...draft, model: { ...draft.model, provider_config_id: e.target.value || null } })}><option value="">请选择真实模型配置</option>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
          <div><label>模型名称</label><input value={draft.model.model} onChange={(e) => setDraft({ ...draft, model: { ...draft.model, model: e.target.value } })} /></div>
        </div>
        {!providers.length && <button className="text-button provider-add" onClick={() => setShowCredential(true)}>＋ 添加真实模型配置</button>}
      </div>
      <div className="card form-grid">
        <div><label>System Prompt</label><textarea rows={5} value={draft.system_prompt} onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })} /></div>
        <div><label>用户 Prompt 模板</label><textarea rows={4} value={draft.user_prompt_template} onChange={(e) => setDraft({ ...draft, user_prompt_template: e.target.value })} /><span className="hint">使用 <code>{"{input}"}</code> 引用用户输入</span></div>
      </div>
    </div>
    <aside className="provider-panel">
      <div className="panel-title compact"><div><h3>模型供应商</h3><p>API Key 加密保存</p></div><button className="icon-button" onClick={() => setShowCredential(true)}>＋</button></div>
      {providers.map((item) => <div className="provider-item" key={item.id}><div className="provider-logo">AI</div><div><strong>{item.name}</strong><span>{item.base_url}</span></div><span className="secure">已加密</span></div>)}
      {!providers.length && <div className="empty-provider">尚未配置真实模型</div>}
    </aside>
    {showCredential && <div className="modal-backdrop"><form className="modal" onSubmit={createCredential}><div className="modal-head"><div><h3>添加 OpenAI 配置</h3><p>OpenAI Chat Completions API</p></div><button type="button" onClick={() => setShowCredential(false)}>×</button></div><label>配置名称</label><input name="name" placeholder="例如：OpenAI" required /><label>Base URL</label><input name="base_url" defaultValue="https://api.openai.com/v1" required /><label>模型名称</label><input name="model" defaultValue="gpt-5.4" required /><label>API Key</label><input name="api_key" type="password" autoComplete="new-password" placeholder="仅在提交时传给后端" required /><div className="security-note">🔒 密钥由服务端加密，保存后不会再次返回明文。</div><button className="primary wide">保存配置</button></form></div>}
  </section>;
}

const nodeTypeLabel = { start: "START", template: "TEMPLATE", llm: "LLM", knowledge: "KNOWLEDGE", tool: "TOOL", answer: "ANSWER" } as const;

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
