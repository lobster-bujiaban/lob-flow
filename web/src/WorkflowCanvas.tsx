import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "./api";
import type { App, Dataset, DifyToolProvider, PluginCatalogItem, ProviderConfig, ScheduleTrigger, ScheduleTriggerInput, WorkflowDefinition, WorkflowEvent, WorkflowNode, WorkflowNodeType, WorkflowVersion } from "./types";

type CanvasData = {
  workflow: WorkflowNode;
  status?: string;
  output?: string;
  openNodeLibrary?: (sourceId: string) => void;
};
type CanvasNode = Node<CanvasData, "workflow">;

const labels: Record<WorkflowNodeType, string> = {
  start: "开始",
  template: "Prompt 模板",
  llm: "LLM",
  knowledge: "知识检索",
  tool: "工具",
  answer: "回答"
};

function CanvasNodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const { workflow, status, output } = data;
  return <div className={`canvas-node node-${workflow.type} ${status ?? ""} ${selected ? "selected" : ""}`}>
    {workflow.type !== "start" && <Handle type="target" position={Position.Left} />}
    <div className="canvas-node-title"><span>{workflow.type.toUpperCase()}</span><strong>{workflow.name}</strong></div>
    <p>{status === "running" ? "运行中…" : status === "succeeded" ? "运行完成" : labels[workflow.type]}</p>
    {output && <div className="canvas-node-preview">{output}</div>}
    {workflow.type !== "answer" && <Handle type="source" position={Position.Right} onClick={(event) => { event.stopPropagation(); data.openNodeLibrary?.(workflow.id); }} title="点击添加下游节点，或拖拽连线" />}
  </div>;
}

const nodeTypes = { workflow: CanvasNodeCard };

export function WorkflowCanvas(props: { app: App; workspaceId: string; providers: ProviderConfig[]; onError: (reason: unknown) => void; onOpenLogs: () => void }) {
  return <ReactFlowProvider><WorkflowCanvasInner {...props} /></ReactFlowProvider>;
}

function WorkflowCanvasInner({ app, workspaceId, providers, onError, onOpenLogs }: { app: App; workspaceId: string; providers: ProviderConfig[]; onError: (reason: unknown) => void; onOpenLogs: () => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [input, setInput] = useState("用一句话说明这个工作流");
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState("");
  const [plugins, setPlugins] = useState<PluginCatalogItem[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [difyTools, setDifyTools] = useState<DifyToolProvider[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteSourceId, setPaletteSourceId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<"node" | "run" | null>(null);
  const [lastSaved, setLastSaved] = useState("");
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleTriggers, setScheduleTriggers] = useState<ScheduleTrigger[]>([]);

  useEffect(() => {
    api.getWorkflow(app.id).then((draft) => loadDefinition(draft.definition)).catch(onError);
  }, [app.id]);
  useEffect(() => { api.listPlugins(workspaceId).then(setPlugins).catch(onError); }, [workspaceId]);
  useEffect(() => { api.listDatasets(workspaceId).then(setDatasets).catch(onError); }, [workspaceId]);
  useEffect(() => { api.listDifyTools(workspaceId).then(setDifyTools).catch(onError); }, [workspaceId]);
  useEffect(() => { api.listScheduleTriggers(app.id).then(setScheduleTriggers).catch(onError); }, [app.id]);

  function loadDefinition(definition: WorkflowDefinition) {
    setNodes(definition.nodes.map((workflow, index) => ({
      id: workflow.id,
      type: "workflow",
      position: { x: workflow.position.x ?? 80 + index * 280, y: workflow.position.y ?? 220 },
      data: { workflow, openNodeLibrary: openLibraryFromNode },
      deletable: workflow.type !== "start",
      selected: false
    })));
    setEdges(definition.edges.map((edge, index) => ({
      id: `edge-${index}-${edge.source}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      markerEnd: { type: MarkerType.ArrowClosed },
      animated: false
    })));
    setSelectedId(null);
    setPanelMode(null);
  }

  const selected = useMemo(() => nodes.find((node) => node.id === selectedId) ?? null, [nodes, selectedId]);
  const availableVariables = useMemo(() => {
    if (!selectedId) return [];
    const upstream = new Set<string>();
    const pending = [selectedId];
    while (pending.length) {
      const target = pending.pop()!;
      for (const edge of edges) {
        if (edge.target !== target || upstream.has(edge.source)) continue;
        upstream.add(edge.source);
        pending.push(edge.source);
      }
    }
    return nodes.filter((node) => upstream.has(node.id)).map((node) => node.data.workflow);
  }, [nodes, edges, selectedId]);
  const definition = useCallback((): WorkflowDefinition => ({
    nodes: nodes.map((node) => ({ ...node.data.workflow, position: node.position })),
    edges: edges.map((edge) => ({ source: edge.source, target: edge.target }))
  }), [nodes, edges]);

  const connect = useCallback((connection: Connection) => setEdges((current) => addEdge({
    ...connection,
    markerEnd: { type: MarkerType.ArrowClosed }
  }, current)), [setEdges]);

  function openLibraryFromNode(sourceId: string) {
    setPaletteSourceId(sourceId);
    setPaletteOpen(true);
    setPanelMode(null);
    setSelectedId(null);
  }

  function addNode(type: WorkflowNodeType, selectedPlugin?: PluginCatalogItem, selectedToolName?: string, selectedDify?: DifyToolProvider, selectedDataset?: Dataset) {
    if (type === "start" && nodes.some((node) => node.data.workflow.type === "start")) return;
    const id = `${type}-${crypto.randomUUID().slice(0, 8)}`;
    const config = type === "template"
      ? { template: "{input}" }
      : type === "llm"
        ? { system_prompt: "你是一个有帮助的 AI 助手。", provider_config_id: providers[0]?.id ?? "", model: "gpt-5.4", temperature: 0.2, max_tokens: 512, timeout_seconds: 30 }
        : type === "tool"
          ? (() => { if (selectedDify) { const tool = selectedDify.tools.find((item) => item.name === selectedToolName) ?? selectedDify.tools[0]; return { runtime: "dify", plugin_id: selectedDify.plugin_id, provider_name: selectedDify.provider_name, tool_name: tool?.name ?? "", credential_schema: selectedDify.credential_schema ?? {}, credentials: {}, parameters: Object.fromEntries(Object.keys(tool?.parameters ?? {}).map((key) => [key, key === "text" || key === "body" ? "{input}" : ""])) }; } const plugin = selectedPlugin ?? plugins.find((item) => item.installed && item.enabled); const tool = plugin?.manifest.tools.find((item) => item.name === selectedToolName) ?? plugin?.manifest.tools[0]; return { runtime: "builtin", plugin_id: plugin?.manifest.plugin_id ?? "", tool_name: tool?.name ?? "", parameters: Object.fromEntries(Object.keys(tool?.parameters ?? {}).map((key) => [key, key === "text" || key === "json" ? "{input}" : ""])) }; })()
        : type === "knowledge"
          ? { dataset_id: selectedDataset?.id ?? datasets[0]?.id ?? "", query: "{input}", top_k: 3, score_threshold: 0 }
          : {};
    const tool = type === "tool" ? (selectedDify?.tools.find((item) => item.name === selectedToolName) ?? selectedPlugin?.manifest.tools.find((item) => item.name === selectedToolName)) : undefined;
    const sourceNode = paletteSourceId ? nodes.find((item) => item.id === paletteSourceId) : undefined;
    const node: CanvasNode = {
      id,
      type: "workflow",
      position: sourceNode ? { x: sourceNode.position.x + 320, y: sourceNode.position.y } : { x: 360 + nodes.length * 35, y: 160 + nodes.length * 35 },
      data: { workflow: { id, type, name: selectedDataset ? `检索 · ${selectedDataset.name}` : tool?.label ?? labels[type], config, position: {} }, openNodeLibrary: openLibraryFromNode },
      deletable: type !== "start"
    };
    setNodes((current) => [...current, node]);
    if (paletteSourceId) setEdges((current) => addEdge({ id: `edge-${paletteSourceId}-${id}`, source: paletteSourceId, target: id, markerEnd: { type: MarkerType.ArrowClosed } }, current));
    setSelectedId(id);
    setPanelMode("node");
    setPaletteOpen(false);
    setPaletteSourceId(null);
  }

  function deleteSelected() {
    if (!selected || selected.data.workflow.type === "start") return;
    setNodes((current) => current.filter((node) => node.id !== selected.id));
    setEdges((current) => current.filter((edge) => edge.source !== selected.id && edge.target !== selected.id));
    setSelectedId(null);
  }

  function updateSelected(patch: Partial<WorkflowNode>, configPatch?: Record<string, unknown>) {
    if (!selectedId) return;
    setNodes((current) => current.map((node) => node.id === selectedId ? {
      ...node,
      data: {
        ...node.data,
        workflow: {
          ...node.data.workflow,
          ...patch,
          config: configPatch ? { ...node.data.workflow.config, ...configPatch } : node.data.workflow.config
        }
      }
    } : node));
  }

  async function save(): Promise<boolean> {
    setSaving(true);
    try {
      const current = definition();
      for (const node of current.nodes) {
        const credentials = node.config.credentials as Record<string, string> | undefined;
        if (node.type === "tool" && credentials && Object.values(credentials).some(Boolean)) {
          const item = await api.createPluginCredential(workspaceId, String(node.config.plugin_id ?? ""), `${node.name} 授权`, credentials);
          node.config = { ...node.config, credential_id: item.id };
          delete node.config.credentials;
        }
      }
      await api.updateWorkflow(app.id, current);
      loadDefinition(current);
      setLastSaved(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      setEdges((current) => current.map((edge) => ({ ...edge, animated: false })));
      return true;
    } catch (reason) {
      onError(reason);
      return false;
    } finally { setSaving(false); }
  }

  async function publish() {
    if (!(await save())) return;
    try { const version = await api.publishWorkflow(app.id); setLastSaved(`已发布 v${version.version}`); }
    catch (reason) { onError(reason); }
  }
  async function openVersions() { try { setVersions(await api.listWorkflowVersions(app.id)); setShowVersions(true); } catch (reason) { onError(reason); } }
  async function rollback(version: WorkflowVersion) { try { const draft = await api.rollbackWorkflow(app.id, version.id); loadDefinition(draft.definition); setShowVersions(false); setLastSaved(`已回滚到 v${version.version}，请重新发布`); } catch (reason) { onError(reason); } }

  async function runSelectedNode(nodeId: string) {
    if (!input.trim() || running || !(await save())) return;
    setRunning(true);
    try {
      await api.streamWorkflowNode(app.id, nodeId, input.trim(), (event) => {
        if (event.node_id) setNodes((current) => current.map((node) => node.id === event.node_id ? { ...node, data: { ...node.data, status: event.type === "node_started" ? "running" : event.type === "node_succeeded" ? "succeeded" : event.type === "node_failed" ? "failed" : node.data.status, output: event.type === "node_delta" ? (node.data.output ?? "") + String(event.data.delta ?? "") : event.type === "node_succeeded" ? String((event.data.output as { value?: string })?.value ?? "") : node.data.output } } : node));
        if (event.type === "workflow_failed") onError(`${event.data.error_code}: ${event.data.error}`);
      });
    } catch (reason) { onError(reason); } finally { setRunning(false); }
  }

  async function run() {
    if (!input.trim() || running || !(await save())) return;
    setRunning(true); setAnswer("");
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, status: undefined, output: undefined } })));
    try {
      await api.streamWorkflow(app.id, input.trim(), (event: WorkflowEvent) => {
        if (event.node_id) setNodes((current) => current.map((node) => node.id === event.node_id ? {
          ...node,
          data: {
            ...node.data,
            status: event.type === "node_started" ? "running" : event.type === "node_succeeded" ? "succeeded" : event.type === "node_failed" ? "failed" : node.data.status,
            output: event.type === "node_delta" ? (node.data.output ?? "") + String(event.data.delta ?? "") : event.type === "node_succeeded" ? String((event.data.output as { value?: string })?.value ?? node.data.output ?? "") : node.data.output
          }
        } : node));
        if (event.type === "workflow_succeeded") setAnswer(String(event.data.output ?? ""));
        if (event.type === "workflow_failed") onError(`${event.data.error_code}: ${event.data.error}`);
      });
    } catch (reason) { onError(reason); }
    finally { setRunning(false); }
  }

  return <section className="flow-canvas-shell">
    <div className="flow-toolbar">
      <div><strong>{app.name}</strong><span>{saving ? "正在保存…" : lastSaved ? `已保存 ${lastSaved}` : "未保存的草稿"}</span></div>
      <div className="flow-toolbar-actions"><button onClick={() => { setSelectedId(null); setPanelMode("run"); }}>▷ 测试运行</button><button onClick={openVersions}>版本</button><button onClick={() => save()} disabled={saving}>{saving ? "保存中" : "保存草稿"}</button><button className="primary" onClick={publish} disabled={saving}>发布</button></div>
    </div>
    <div className={`flow-canvas-main ${panelMode ? "panel-open" : ""}`}>
      <div className="flow-board">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={connect}
          onNodeClick={(_, node) => { setSelectedId(node.id); setPanelMode("node"); }}
          onPaneClick={() => { setSelectedId(null); setPanelMode(null); setPaletteOpen(false); setPaletteSourceId(null); }}
          deleteKeyCode={["Backspace", "Delete"]}
          proOptions={{ hideAttribution: true }}
          fitView
          minZoom={0.35}
          maxZoom={1.8}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.3} color="#d7cfc2" />
          <MiniMap nodeColor={(node) => (node.data as CanvasData).workflow.type === "llm" ? "#ed5a2a" : (node.data as CanvasData).workflow.type === "answer" ? "#24855b" : "#17335e"} />
          <Controls />
        </ReactFlow>
        <div className="flow-palette"><button className={paletteOpen && !paletteSourceId ? "active" : ""} onClick={() => { setPaletteSourceId(null); setPaletteOpen((open) => !open); }} title="添加节点">＋</button><button onClick={() => setPanelMode("run")} title="测试运行">▷</button></div>
        {paletteOpen && <UnifiedNodeLibrary plugins={plugins} difyTools={difyTools} datasets={datasets} addNode={addNode} scheduleCount={scheduleTriggers.length} openSchedules={() => { setPaletteOpen(false); setScheduleOpen(true); }} selectStart={() => {
          const start = nodes.find((node) => node.data.workflow.type === "start");
          if (!start) { addNode("start"); return; }
          setSelectedId(start.id);
          setPanelMode("node");
          setPaletteOpen(false);
        }} close={() => { setPaletteOpen(false); setPaletteSourceId(null); }} />}
      </div>
      {panelMode && <aside className="flow-inspector"><button className="inspector-close" onClick={() => { setPanelMode(null); setSelectedId(null); }}>×</button>{panelMode === "node" && selected ? <NodeInspector node={selected.data.workflow} variables={availableVariables} providers={providers} plugins={plugins} difyTools={difyTools} datasets={datasets} update={updateSelected} remove={deleteSelected} runNode={() => runSelectedNode(selected.id)} running={running} /> : <RunInspector input={input} setInput={setInput} run={run} running={running} answer={answer} />}</aside>}
    </div>
    {showVersions && <div className="modal-backdrop"><div className="modal workflow-version-modal"><div className="modal-head"><div><h3>发布版本</h3><p>API 执行最新发布版本；恢复后需重新发布才会生效。</p></div><button onClick={() => setShowVersions(false)}>×</button></div>{versions.map((version) => <div className="workflow-version-row" key={version.id}><div><strong>v{version.version}</strong><small>{new Date(version.created_at).toLocaleString()}</small></div><button onClick={() => rollback(version)}>恢复为草稿</button></div>)}{!versions.length && <p className="inspector-hint">尚未发布任何版本。</p>}</div></div>}
    {scheduleOpen && <ScheduleManagerModal appId={app.id} triggers={scheduleTriggers} onChange={setScheduleTriggers} close={() => setScheduleOpen(false)} onError={onError} onOpenLogs={onOpenLogs} />}
  </section>;
}

function UnifiedNodeLibrary({ plugins, difyTools, datasets, addNode, selectStart, openSchedules, scheduleCount, close }: { plugins: PluginCatalogItem[]; difyTools: DifyToolProvider[]; datasets: Dataset[]; addNode: (type: WorkflowNodeType, plugin?: PluginCatalogItem, toolName?: string, dify?: DifyToolProvider, dataset?: Dataset) => void; selectStart: () => void; openSchedules: () => void; scheduleCount: number; close: () => void }) {
  const [tab, setTab] = useState<"nodes" | "knowledge" | "tools" | "start">("nodes");
  const [query, setQuery] = useState("");
  const [hoveredTrigger, setHoveredTrigger] = useState("user-input");
  const needle = query.trim().toLowerCase();
  const builtin = plugins.filter((item) => item.installed && item.enabled);
  const nodeItems = ([
    { type: "llm", icon: "AI", label: "LLM", description: "调用大语言模型处理自然语言", group: "基础" },
    { type: "knowledge", icon: "⌕", label: "知识检索", description: "从知识库召回相关片段", group: "基础" },
    { type: "answer", icon: "✓", label: "回答", description: "输出工作流最终结果", group: "基础" },
    { type: "template", icon: "T", label: "模板转换", description: "组合和转换上游变量", group: "转换" },
  ] satisfies Array<{ type: Exclude<WorkflowNodeType, "start">; icon: string; label: string; description: string; group: string }>).filter((item) => !needle || `${item.label}${item.description}`.toLowerCase().includes(needle));
  const triggers = [
    { id: "user-input", icon: "⌁", label: "用户输入", badge: "最常用", description: "定义当工作流按需启动时，需要向终端用户收集的输入。", author: "LOB Flow", enabled: true },
    { id: "schedule", icon: "◷", label: "定时触发器", badge: scheduleCount ? `已配置 ${scheduleCount}` : "可配置", description: "按照预设的时间计划，使用最新发布版本自动启动工作流。", author: "LOB Flow", enabled: true },
    { id: "webhook", icon: "⌘", label: "Webhook 触发器", badge: "即将支持", description: "收到外部系统的 Webhook 请求时启动工作流。", author: "LOB Flow", enabled: false }
  ].filter((item) => !needle || `${item.label}${item.description}`.toLowerCase().includes(needle));
  const activeTrigger = triggers.find((item) => item.id === hoveredTrigger);
  return <div className="unified-node-library">
    <header><nav><button className={tab === "nodes" ? "active" : ""} onClick={() => setTab("nodes")}>节点</button><button className={tab === "knowledge" ? "active" : ""} onClick={() => setTab("knowledge")}>知识库</button><button className={tab === "tools" ? "active" : ""} onClick={() => setTab("tools")}>工具</button><button className={tab === "start" ? "active" : ""} onClick={() => setTab("start")}>开始</button></nav><button onClick={close}>×</button></header>
    <div className="node-library-search">⌕<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === "tools" ? "搜索已安装工具" : tab === "knowledge" ? "搜索知识库" : tab === "start" ? "搜索触发器…" : "搜索节点"} /></div>
    {tab === "nodes" && <div className="node-library-scroll">{["基础", "转换"].map((group) => { const items = nodeItems.filter((item) => item.group === group); return items.length ? <section key={group}><strong>{group}</strong>{items.map((item) => <button key={item.type} onClick={() => addNode(item.type)}><i>{item.icon}</i><span><b>{item.label}</b><small>{item.description}</small></span></button>)}</section> : null; })}</div>}
    {tab === "knowledge" && <div className="node-library-scroll knowledge-node-library"><section><strong>当前空间的知识库</strong>{datasets.filter((dataset) => !needle || `${dataset.name}${dataset.description}`.toLowerCase().includes(needle)).map((dataset) => <button key={dataset.id} onClick={() => addNode("knowledge", undefined, undefined, undefined, dataset)}><i>{dataset.icon}</i><span><b>{dataset.name}</b><small>{dataset.document_count} 文档 · {dataset.segment_count} 分段</small></span></button>)}{!datasets.length && <p>还没有知识库，请先在顶部“知识库”中创建并添加文档。</p>}</section></div>}
    {tab === "tools" && <div className="node-library-scroll tool-library-scroll">{difyTools.map((provider) => { const tools = provider.tools.filter((tool) => !needle || `${tool.label}${tool.description}`.toLowerCase().includes(needle)); return tools.length ? <section key={provider.plugin_id}><strong>{provider.name}<em>Daemon</em></strong>{tools.map((tool) => <button key={tool.name} onClick={() => addNode("tool", undefined, tool.name, provider)}><i>{provider.name.slice(0, 2)}</i><span><b>{tool.label}</b><small>{tool.description}</small></span></button>)}</section> : null; })}{builtin.map((plugin) => { const tools = plugin.manifest.tools.filter((tool) => !needle || `${tool.label}${tool.description}`.toLowerCase().includes(needle)); return tools.length ? <section key={plugin.manifest.plugin_id}><strong>{plugin.manifest.name}<em>LOB</em></strong>{tools.map((tool) => <button key={tool.name} onClick={() => addNode("tool", plugin, tool.name)}><i>{plugin.manifest.icon}</i><span><b>{tool.label}</b><small>{tool.description}</small></span></button>)}</section> : null; })}{!difyTools.length && !builtin.length && <p>还没有已安装工具，请先到插件市场安装。</p>}</div>}
    {tab === "start" && <div className="start-trigger-list">{triggers.map((item) => <button key={item.id} className={!item.enabled ? "disabled" : ""} onMouseEnter={() => setHoveredTrigger(item.id)} onFocus={() => setHoveredTrigger(item.id)} onClick={item.id === "user-input" ? selectStart : item.id === "schedule" ? openSchedules : undefined}><i>{item.icon}</i><span>{item.label}</span><em>{item.badge}</em></button>)}{!triggers.length && <p>没有匹配的触发器</p>}</div>}
    {tab === "start" && activeTrigger && <aside className="start-trigger-tip"><i>{activeTrigger.icon}</i><strong>{activeTrigger.label}</strong><p>{activeTrigger.description}</p><small>作者 {activeTrigger.author}</small></aside>}
  </div>;
}

const emptySchedule: ScheduleTriggerInput = { name: "定时触发器", cron: "0 9 * * 1-5", timezone: "Asia/Shanghai", input: "请执行定时工作流", enabled: false, misfire_policy: "skip" };

function describeCron(expression: string) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute, hour, day, month, weekday] = parts;
  if (day === "*" && month === "*" && weekday === "*" && hour === "*") return minute.startsWith("*/") ? `每 ${minute.slice(2)} 分钟` : `每小时第 ${minute} 分钟`;
  if (day === "*" && month === "*" && weekday === "*") return `每天 ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (day === "*" && month === "*" && weekday === "1-5") return `工作日 ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (day === "*" && month === "*" && weekday === "1") return `每周一 ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  return expression;
}

function ScheduleManagerModal({ appId, triggers, onChange, close, onError, onOpenLogs }: { appId: string; triggers: ScheduleTrigger[]; onChange: (items: ScheduleTrigger[]) => void; close: () => void; onError: (reason: unknown) => void; onOpenLogs: () => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ScheduleTriggerInput>(emptySchedule);
  const [saving, setSaving] = useState(false);
  const editing = triggers.find((item) => item.id === editingId);

  function edit(item?: ScheduleTrigger) {
    setEditingId(item?.id ?? "");
    setForm(item ? { name: item.name, cron: item.cron, timezone: item.timezone, input: item.input, enabled: item.enabled, misfire_policy: item.misfire_policy } : { ...emptySchedule });
  }
  async function refresh() { onChange(await api.listScheduleTriggers(appId)); }
  async function saveTrigger() {
    if (!form.name.trim() || !form.cron.trim() || !form.input.trim()) return;
    setSaving(true);
    try {
      if (editing) await api.updateScheduleTrigger(appId, editing.id, form);
      else await api.createScheduleTrigger(appId, form);
      await refresh();
      setEditingId(null);
    } catch (reason) { onError(reason); }
    finally { setSaving(false); }
  }
  async function toggle(item: ScheduleTrigger) {
    try {
      await api.updateScheduleTrigger(appId, item.id, { name: item.name, cron: item.cron, timezone: item.timezone, input: item.input, enabled: !item.enabled, misfire_policy: item.misfire_policy });
      await refresh();
    } catch (reason) { onError(reason); }
  }
  async function remove(item: ScheduleTrigger) {
    if (!confirm(`删除定时触发器“${item.name}”？`)) return;
    try { await api.deleteScheduleTrigger(appId, item.id); await refresh(); if (editingId === item.id) setEditingId(null); }
    catch (reason) { onError(reason); }
  }
  async function runNow(item: ScheduleTrigger) {
    setSaving(true);
    try { await api.runScheduleTrigger(appId, item.id); await refresh(); }
    catch (reason) { onError(reason); }
    finally { setSaving(false); }
  }

  return <div className="modal-backdrop schedule-modal-backdrop" onClick={close}><div className="modal schedule-modal" onClick={(event) => event.stopPropagation()}>
    <div className="modal-head"><div><h3>定时触发器</h3><p>按照计划自动执行最新发布的工作流版本。</p></div><button onClick={close}>×</button></div>
    {editingId === null ? <>
      <div className="schedule-toolbar"><span>{triggers.length} 个计划</span><button className="primary" onClick={() => edit()}>＋ 新建计划</button></div>
      <div className="schedule-list">{triggers.map((item) => <article key={item.id}>
        <i>◷</i><div><strong>{item.name}<em className={item.enabled ? "enabled" : "paused"}>{item.enabled ? "运行中" : "已暂停"}</em></strong><code>{describeCron(item.cron)} · <span>{item.cron}</span></code><small>{item.timezone} · {item.next_trigger_at ? `下次 ${new Date(item.next_trigger_at).toLocaleString()}` : "暂无下次执行"}</small><small>{item.last_triggered_at ? `上次 ${new Date(item.last_triggered_at).toLocaleString()}` : "尚未执行"} · {item.misfire_policy === "run_once" ? "错过后补跑一次" : "错过后跳过"}</small>{item.last_error && <em title={item.last_error}>上次执行失败：{item.last_error}</em>}</div>
        <button onClick={() => runNow(item)} disabled={saving}>立即运行</button><button className={item.enabled ? "schedule-switch active" : "schedule-switch"} onClick={() => toggle(item)}>{item.enabled ? "暂停" : "启用"}</button>
        {item.last_run_id && <button onClick={() => { close(); onOpenLogs(); }}>查看日志</button>}<button onClick={() => edit(item)}>编辑</button><button className="row-delete" onClick={() => remove(item)}>删除</button>
      </article>)}{!triggers.length && <div className="schedule-empty"><span>◷</span><strong>还没有定时计划</strong><p>创建计划后，可以按分钟、每天或每周自动运行工作流。</p><button className="primary" onClick={() => edit()}>创建第一个计划</button></div>}</div>
    </> : <div className="schedule-form">
      <button className="schedule-back" onClick={() => setEditingId(null)}>← 返回计划列表</button>
      <label>名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label>执行频率<select value={form.cron} onChange={(event) => setForm({ ...form, cron: event.target.value })}><option value="*/5 * * * *">每 5 分钟</option><option value="0 * * * *">每小时</option><option value="0 9 * * *">每天 09:00</option><option value="0 9 * * 1-5">工作日 09:00</option><option value="0 9 * * 1">每周一 09:00</option><option value={form.cron}>自定义 Cron：{form.cron}</option></select></label>
      <label>Cron 表达式<input value={form.cron} onChange={(event) => setForm({ ...form, cron: event.target.value })} placeholder="0 9 * * 1-5" /><small>使用标准 5 段 Cron：分钟 小时 日期 月份 星期</small></label>
      <label>时区<select value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })}><option value="Asia/Shanghai">Asia/Shanghai</option><option value="UTC">UTC</option><option value="Asia/Tokyo">Asia/Tokyo</option><option value="America/New_York">America/New_York</option><option value="Europe/London">Europe/London</option></select></label>
      <label>错过执行<select value={form.misfire_policy} onChange={(event) => setForm({ ...form, misfire_policy: event.target.value as "skip" | "run_once" })}><option value="skip">跳过错过的执行</option><option value="run_once">恢复后立即补跑一次</option></select><small>服务停止或计划暂停期间可能错过执行时间。</small></label>
      <label>工作流输入<textarea rows={5} value={form.input} onChange={(event) => setForm({ ...form, input: event.target.value })} placeholder="定时运行时传入开始节点的内容" /></label>
      <label className="schedule-enabled"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span><strong>保存后立即启用</strong><small>启用前必须先发布工作流。</small></span></label>
      <div className="schedule-form-actions"><button onClick={() => setEditingId(null)}>取消</button><button className="primary" disabled={saving || !form.name.trim() || !form.cron.trim() || !form.input.trim()} onClick={saveTrigger}>{saving ? "保存中…" : editing ? "保存修改" : "创建计划"}</button></div>
    </div>}
  </div></div>;
}

function VariablePicker({ nodes, currentId, onInsert }: { nodes: WorkflowNode[]; currentId: string; onInsert: (variable: string) => void }) {
  return <select className="variable-picker" value="" onChange={(event) => { if (event.target.value) onInsert(event.target.value); }}><option value="">＋ 插入变量</option><option value="{{start.input}}">开始 / 用户输入</option>{nodes.filter((item) => item.id !== currentId && item.type !== "start").map((item) => <option key={item.id} value={`{{${item.id}.output}}`}>{item.name} / 输出</option>)}</select>;
}

function ToolVariablePicker({ parameters, nodes, currentId, onChange }: { parameters: Record<string, unknown>; nodes: WorkflowNode[]; currentId: string; onChange: (parameters: Record<string, unknown>) => void }) {
  const keys = Object.keys(parameters);
  const [parameter, setParameter] = useState(keys[0] ?? "");
  if (!keys.length) return null;
  const active = keys.includes(parameter) ? parameter : keys[0];
  return <div className="tool-variable-picker"><label>插入变量到参数</label><select value={active} onChange={(event) => setParameter(event.target.value)}>{keys.map((key) => <option key={key} value={key}>{key}</option>)}</select><VariablePicker nodes={nodes} currentId={currentId} onInsert={(variable) => onChange({ ...parameters, [active]: `${String(parameters[active] ?? "")}${variable}` })} /></div>;
}

function NodeInspector({ node, variables, providers, plugins, difyTools, datasets, update, remove, runNode, running }: { node: WorkflowNode; variables: WorkflowNode[]; providers: ProviderConfig[]; plugins: PluginCatalogItem[]; difyTools: DifyToolProvider[]; datasets: Dataset[]; update: (patch: Partial<WorkflowNode>, config?: Record<string, unknown>) => void; remove: () => void; runNode: () => void; running: boolean }) {
  const installed = plugins.filter((item) => item.installed && item.enabled);
  const activePlugin = installed.find((item) => item.manifest.plugin_id === node.config.plugin_id);
  const activeTool = activePlugin?.manifest.tools.find((tool) => tool.name === node.config.tool_name);
  const difyProvider = difyTools.find((item) => item.plugin_id === node.config.plugin_id && item.provider_name === node.config.provider_name);
  const difyCredentialSchema = difyProvider?.credential_schema ?? node.config.credential_schema as DifyToolProvider["credential_schema"] ?? {};
  return <div className="inspector-content">
    <div className="inspector-title"><span>{node.type.toUpperCase()}</span><h3>节点配置</h3></div>
    <label>节点名称</label><input value={node.name} onChange={(event) => update({ name: event.target.value })} />
    <button className="node-debug-button" onClick={runNode} disabled={running}>{running ? "运行中…" : "▷ 单独运行此节点"}</button>
    {node.type === "start" && <p className="inspector-hint">Start 是工作流唯一入口，不能删除。</p>}
    {node.type === "template" && <><label>Prompt 模板</label><textarea rows={6} value={String(node.config.template ?? "")} onChange={(event) => update({}, { template: event.target.value })} /><VariablePicker nodes={variables} currentId={node.id} onInsert={(variable) => update({}, { template: `${String(node.config.template ?? "")}${variable}` })} /><p className="inspector-hint">可插入开始输入或任意已执行节点的输出。</p></>}
    {node.type === "llm" && <><label>模型配置</label><select value={String(node.config.provider_config_id ?? "")} onChange={(event) => update({}, { provider_config_id: event.target.value })}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><label>模型</label><input value={String(node.config.model ?? "gpt-5.4")} onChange={(event) => update({}, { model: event.target.value })} /><label>System Prompt</label><textarea rows={6} value={String(node.config.system_prompt ?? "")} onChange={(event) => update({}, { system_prompt: event.target.value })} /><VariablePicker nodes={variables} currentId={node.id} onInsert={(variable) => update({}, { system_prompt: `${String(node.config.system_prompt ?? "")}${variable}` })} /><div className="inspector-grid"><div><label>温度</label><input type="number" step="0.1" min="0" max="2" value={Number(node.config.temperature ?? 0.2)} onChange={(event) => update({}, { temperature: Number(event.target.value) })} /></div><div><label>最大 Token</label><input type="number" min="1" value={Number(node.config.max_tokens ?? 512)} onChange={(event) => update({}, { max_tokens: Number(event.target.value) })} /></div></div></>}
    {node.type === "knowledge" && <><label>知识库</label><select value={String(node.config.dataset_id ?? "")} onChange={(event) => update({}, { dataset_id: event.target.value })}><option value="">请选择知识库</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.icon} {dataset.name}</option>)}</select><label>检索 Query</label><textarea rows={4} value={String(node.config.query ?? "{input}")} onChange={(event) => update({}, { query: event.target.value })} /><VariablePicker nodes={variables} currentId={node.id} onInsert={(variable) => update({}, { query: `${String(node.config.query ?? "")}${variable}` })} /><p className="inspector-hint">选择开始输入或上游节点输出作为检索内容。</p><div className="inspector-grid"><div><label>Top K</label><input type="number" min="1" max="20" value={Number(node.config.top_k ?? 3)} onChange={(event) => update({}, { top_k: Number(event.target.value) })} /></div><div><label>分数阈值</label><input type="number" min="0" max="1" step="0.05" value={Number(node.config.score_threshold ?? 0)} onChange={(event) => update({}, { score_threshold: Number(event.target.value) })} /></div></div>{!datasets.length && <p className="inspector-hint">请先在知识库页面创建知识库并添加文档。</p>}</>}
    {node.type === "tool" && node.config.runtime !== "dify" && <><label>已安装插件</label><select value={String(node.config.plugin_id ?? "")} onChange={(event) => { const plugin = installed.find((item) => item.manifest.plugin_id === event.target.value); const tool = plugin?.manifest.tools[0]; update({}, { plugin_id: event.target.value, tool_name: tool?.name ?? "", parameters: Object.fromEntries(Object.keys(tool?.parameters ?? {}).map((key) => [key, key === "text" || key === "json" ? "{input}" : ""])) }); }}><option value="">请选择插件</option>{installed.map((item) => <option key={item.manifest.plugin_id} value={item.manifest.plugin_id}>{item.manifest.name}</option>)}</select><label>工具</label><select value={String(node.config.tool_name ?? "")} onChange={(event) => { const tool = activePlugin?.manifest.tools.find((item) => item.name === event.target.value); update({}, { tool_name: event.target.value, parameters: Object.fromEntries(Object.keys(tool?.parameters ?? {}).map((key) => [key, key === "text" || key === "json" ? "{input}" : ""])) }); }}>{activePlugin?.manifest.tools.map((tool) => <option key={tool.name} value={tool.name}>{tool.label}</option>)}</select>{activeTool && Object.entries(activeTool.parameters).map(([key, schema]) => <div key={key}><label>{key}{schema.required ? " *" : ""}</label><input value={String((node.config.parameters as Record<string, unknown> | undefined)?.[key] ?? "")} onChange={(event) => update({}, { parameters: { ...(node.config.parameters as Record<string, unknown> ?? {}), [key]: event.target.value } })} placeholder={key === "text" || key === "json" ? "{input}" : ""} /></div>)}{!installed.length && <p className="inspector-hint">请先到插件市场安装并启用 Tool 插件。</p>}</>}
    {node.type === "tool" && node.config.runtime === "dify" && <div className="dify-node-config"><p className="inspector-hint">Daemon 插件：<code>{String(node.config.plugin_id)}</code> / <code>{String(node.config.tool_name)}</code></p>{Object.keys(difyCredentialSchema).length > 0 && <div className="dify-credentials"><strong>插件授权</strong><small>凭据用于调用插件，不会显示在运行日志中。</small>{Object.entries(difyCredentialSchema).map(([key, schema]) => <div key={key}><label>{schema.label || key}{schema.required ? " *" : ""}</label><input type={schema.type?.includes("secret") ? "password" : "text"} value={String((node.config.credentials as Record<string, unknown> ?? {})[key] ?? "")} onChange={(event) => update({}, { credential_schema: difyCredentialSchema, credentials: { ...(node.config.credentials as Record<string, unknown> ?? {}), [key]: event.target.value } })} placeholder={`请输入 ${schema.label || key}`} /></div>)}</div>}{Object.entries(node.config.parameters as Record<string, unknown> ?? {}).map(([key, value]) => <div key={key}><label>{key}</label><input value={String(value ?? "")} onChange={(event) => update({}, { parameters: { ...(node.config.parameters as Record<string, unknown> ?? {}), [key]: event.target.value } })} placeholder="可使用 {input}" /></div>)}</div>}
    {node.type === "tool" && <ToolVariablePicker parameters={node.config.parameters as Record<string, unknown> ?? {}} nodes={variables} currentId={node.id} onChange={(parameters) => update({}, { parameters })} />}
    {node.type === "answer" && <p className="inspector-hint">把所有上游节点完成后的值作为最终回答。</p>}
    {node.type !== "start" && <button className="danger-button" onClick={remove}>删除节点</button>}
  </div>;
}

function RunInspector({ input, setInput, run, running, answer }: { input: string; setInput: (value: string) => void; run: () => void; running: boolean; answer: string }) {
  return <div className="inspector-content"><div className="inspector-title"><span>DEBUG</span><h3>运行调试</h3></div><p className="inspector-hint">运行前会自动保存并执行 DAG 校验。</p><label>工作流输入</label><textarea rows={7} value={input} onChange={(event) => setInput(event.target.value)} /><button className="primary wide" onClick={run} disabled={running || !input.trim()}>{running ? "执行中" : "运行工作流"}</button>{answer && <div className="workflow-answer"><span>最终回答</span><p>{answer}</p></div>}</div>;
}
