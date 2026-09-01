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
import type { AnswerOutputVariable, App, Dataset, DifyToolProvider, PluginCatalogItem, ProviderConfig, ScheduleTrigger, ScheduleTriggerInput, StartInputVariable, WorkflowDefinition, WorkflowEvent, WorkflowNode, WorkflowNodeType, WorkflowVersion } from "./types";

type CanvasData = {
  workflow: WorkflowNode;
  status?: string;
  output?: string;
  openNodeLibrary?: (sourceId: string, sourceHandle?: string) => void;
};
type CanvasNode = Node<CanvasData, "workflow">;

const labels: Record<WorkflowNodeType, string> = {
  start: "开始",
  template: "Prompt 模板",
  llm: "LLM",
  knowledge: "知识检索",
  tool: "工具",
  condition: "条件分支",
  switch: "多路分支",
  answer: "回答"
};

function CanvasNodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const { workflow, status, output } = data;
  const switchCases = workflow.type === "switch" ? (workflow.config.cases as Array<{ id: string; label: string; value: string }> | undefined) ?? [] : [];
  const switchHandles = workflow.type === "switch" ? [...switchCases.map((item) => ({ id: item.id, label: item.label || item.value })), { id: "default", label: "DEFAULT" }] : [];
  const reliable = workflow.type === "llm" || workflow.type === "tool" || workflow.type === "knowledge";
  return <div className={`canvas-node node-${workflow.type} ${status ?? ""} ${selected ? "selected" : ""}`} style={workflow.type === "switch" ? { minHeight: Math.max(110, 64 + switchHandles.length * 26) } : undefined}>
    {workflow.type !== "start" && <Handle type="target" position={Position.Left} />}
    <div className="canvas-node-title"><span>{workflow.type.toUpperCase()}</span><strong>{workflow.name}</strong></div>
    <p>{status === "running" ? "运行中…" : status === "succeeded" ? "运行完成" : labels[workflow.type]}</p>
    {output && <div className="canvas-node-preview">{output}</div>}
    {workflow.type === "condition" ? <><span className="condition-handle-label true">TRUE</span><Handle id="true" className="condition-handle true" type="source" position={Position.Right} style={{ top: "35%" }} onClick={(event) => { event.stopPropagation(); data.openNodeLibrary?.(workflow.id, "true"); }} /><span className="condition-handle-label false">FALSE</span><Handle id="false" className="condition-handle false" type="source" position={Position.Right} style={{ top: "72%" }} onClick={(event) => { event.stopPropagation(); data.openNodeLibrary?.(workflow.id, "false"); }} /></> : workflow.type === "switch" ? <>{switchHandles.map((item, index) => { const top = 70 + index * 26; return <span key={item.id}><span className={`switch-handle-label ${item.id === "default" ? "default" : ""}`} style={{ top }}>{item.label}</span><Handle id={item.id} className={`switch-handle ${item.id === "default" ? "default" : ""}`} type="source" position={Position.Right} style={{ top }} onClick={(event) => { event.stopPropagation(); data.openNodeLibrary?.(workflow.id, item.id); }} /></span>; })}</> : reliable ? <><span className="reliable-handle-label success">SUCCESS</span><Handle className="reliable-handle success" type="source" position={Position.Right} style={{ top: "35%" }} onClick={(event) => { event.stopPropagation(); data.openNodeLibrary?.(workflow.id); }} /><span className="reliable-handle-label error">ERROR</span><Handle id="error" className="reliable-handle error" type="source" position={Position.Right} style={{ top: "72%" }} onClick={(event) => { event.stopPropagation(); data.openNodeLibrary?.(workflow.id, "error"); }} /></> : workflow.type !== "answer" && <Handle type="source" position={Position.Right} onClick={(event) => { event.stopPropagation(); data.openNodeLibrary?.(workflow.id); }} title="点击添加下游节点，或拖拽连线" />}
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
  const [runInputs, setRunInputs] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState("");
  const [answer, setAnswer] = useState("");
  const [runOutputs, setRunOutputs] = useState<Record<string, unknown>>({});
  const [plugins, setPlugins] = useState<PluginCatalogItem[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [difyTools, setDifyTools] = useState<DifyToolProvider[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteSourceId, setPaletteSourceId] = useState<string | null>(null);
  const [paletteSourceHandle, setPaletteSourceHandle] = useState<string | null>(null);
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
      sourceHandle: edge.source_handle ?? undefined,
      markerEnd: { type: MarkerType.ArrowClosed },
      animated: false
    })));
    setSelectedId(null);
    setPanelMode(null);
  }

  const selected = useMemo(() => nodes.find((node) => node.id === selectedId) ?? null, [nodes, selectedId]);
  const startVariables = useMemo(() => (nodes.find((node) => node.data.workflow.type === "start")?.data.workflow.config.variables as StartInputVariable[] | undefined) ?? [], [nodes]);
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
    edges: edges.map((edge) => ({ source: edge.source, target: edge.target, source_handle: edge.sourceHandle ?? null }))
  }), [nodes, edges]);

  const connect = useCallback((connection: Connection) => setEdges((current) => addEdge({
    ...connection,
    markerEnd: { type: MarkerType.ArrowClosed }
  }, current)), [setEdges]);

  function openLibraryFromNode(sourceId: string, sourceHandle?: string) {
    setPaletteSourceId(sourceId);
    setPaletteSourceHandle(sourceHandle ?? null);
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
          : type === "condition"
            ? { left: "{{start.input}}", operator: "equals", right: "" }
          : type === "switch"
            ? { expression: "{{start.input}}", cases: [{ id: `case_${crypto.randomUUID().slice(0, 6)}`, label: "Case 1", value: "" }] }
          : type === "start"
            ? { variables: [{ name: "input", label: "用户输入", type: "string", required: true, default: "", description: "工作流的主要输入" }] }
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
    if (paletteSourceId) setEdges((current) => addEdge({ id: `edge-${paletteSourceId}-${paletteSourceHandle ?? "default"}-${id}`, source: paletteSourceId, sourceHandle: paletteSourceHandle, target: id, markerEnd: { type: MarkerType.ArrowClosed } }, current));
    setSelectedId(id);
    setPanelMode("node");
    setPaletteOpen(false);
    setPaletteSourceId(null);
    setPaletteSourceHandle(null);
  }

  function deleteSelected() {
    if (!selected || selected.data.workflow.type === "start") return;
    setNodes((current) => current.filter((node) => node.id !== selected.id));
    setEdges((current) => current.filter((edge) => edge.source !== selected.id && edge.target !== selected.id));
    setSelectedId(null);
  }

  function updateSelected(patch: Partial<WorkflowNode>, configPatch?: Record<string, unknown>) {
    if (!selectedId) return;
    if (configPatch?.cases) {
      const validHandles = new Set([...(configPatch.cases as Array<{ id: string }>).map((item) => item.id), "default"]);
      setEdges((current) => current.filter((edge) => edge.source !== selectedId || !edge.sourceHandle || validHandles.has(edge.sourceHandle)));
    }
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
    const payload = startVariables.length ? runInputs : input.trim();
    if ((!startVariables.length && !input.trim()) || running || !(await save())) return;
    setRunning(true);
    try {
      await api.streamWorkflowNode(app.id, nodeId, payload, (event) => {
        if (event.node_id) setNodes((current) => current.map((node) => node.id === event.node_id ? { ...node, data: { ...node.data, status: event.type === "node_started" ? "running" : event.type === "node_succeeded" ? "succeeded" : event.type === "node_failed" ? "failed" : node.data.status, output: event.type === "node_delta" ? (node.data.output ?? "") + String(event.data.delta ?? "") : event.type === "node_succeeded" ? String((event.data.output as { value?: string })?.value ?? "") : node.data.output } } : node));
        if (event.type === "workflow_failed") onError(`${event.data.error_code}: ${event.data.error}`);
      });
    } catch (reason) { onError(reason); } finally { setRunning(false); }
  }

  async function run() {
    const payload = startVariables.length ? runInputs : input.trim();
    if ((!startVariables.length && !input.trim()) || running || !(await save())) return;
    setRunning(true); setAnswer(""); setRunOutputs({});
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, status: undefined, output: undefined } })));
    try {
      await api.streamWorkflow(app.id, payload, (event: WorkflowEvent) => {
        if (event.type === "workflow_started") setActiveRunId(event.workflow_run_id);
        if (event.node_id) setNodes((current) => current.map((node) => node.id === event.node_id ? {
          ...node,
          data: {
            ...node.data,
            status: event.type === "node_started" ? "running" : event.type === "node_succeeded" ? "succeeded" : event.type === "node_failed" ? "failed" : node.data.status,
            output: event.type === "node_delta" ? (node.data.output ?? "") + String(event.data.delta ?? "") : event.type === "node_succeeded" ? String((event.data.output as { value?: string })?.value ?? node.data.output ?? "") : node.data.output
          }
        } : node));
        if (event.type === "workflow_succeeded") { setAnswer(String(event.data.output ?? "")); setRunOutputs(event.data.outputs as Record<string, unknown> ?? {}); }
        if (event.type === "workflow_failed") onError(`${event.data.error_code}: ${event.data.error}`);
      });
    } catch (reason) { onError(reason); }
    finally { setRunning(false); setActiveRunId(""); }
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
          onPaneClick={() => { setSelectedId(null); setPanelMode(null); setPaletteOpen(false); setPaletteSourceId(null); setPaletteSourceHandle(null); }}
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
        <div className="flow-palette"><button className={paletteOpen && !paletteSourceId ? "active" : ""} onClick={() => { setPaletteSourceId(null); setPaletteSourceHandle(null); setPaletteOpen((open) => !open); }} title="添加节点">＋</button><button onClick={() => setPanelMode("run")} title="测试运行">▷</button></div>
        {paletteOpen && <UnifiedNodeLibrary plugins={plugins} difyTools={difyTools} datasets={datasets} addNode={addNode} scheduleCount={scheduleTriggers.length} openSchedules={() => { setPaletteOpen(false); setScheduleOpen(true); }} selectStart={() => {
          const start = nodes.find((node) => node.data.workflow.type === "start");
          if (!start) { addNode("start"); return; }
          setSelectedId(start.id);
          setPanelMode("node");
          setPaletteOpen(false);
        }} close={() => { setPaletteOpen(false); setPaletteSourceId(null); setPaletteSourceHandle(null); }} />}
      </div>
      {panelMode && <aside className="flow-inspector"><button className="inspector-close" onClick={() => { setPanelMode(null); setSelectedId(null); }}>×</button>{panelMode === "node" && selected ? <NodeInspector node={selected.data.workflow} variables={availableVariables} providers={providers} plugins={plugins} difyTools={difyTools} datasets={datasets} update={updateSelected} remove={deleteSelected} runNode={() => runSelectedNode(selected.id)} running={running} /> : <RunInspector variables={startVariables} values={runInputs} setValues={setRunInputs} input={input} setInput={setInput} run={run} cancel={activeRunId ? async () => { await api.cancelWorkflowRun(activeRunId); } : undefined} running={running} answer={answer} outputs={runOutputs} />}</aside>}
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
    { type: "condition", icon: "IF", label: "条件分支", description: "根据变量判断执行 TRUE 或 FALSE 路径", group: "转换" },
    { type: "switch", icon: "SW", label: "多路分支", description: "根据一个变量匹配多个 Case 和默认路径", group: "转换" },
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
  const startVariables = (nodes.find((item) => item.type === "start")?.config.variables as StartInputVariable[] | undefined) ?? [];
  return <select className="variable-picker" value="" onChange={(event) => { if (event.target.value) onInsert(event.target.value); }}><option value="">＋ 插入变量</option>{startVariables.map((variable) => <option key={variable.name} value={`{{start.${variable.name}}}`}>开始 / {variable.label || variable.name}</option>)}{nodes.filter((item) => item.id !== currentId && item.type !== "start").flatMap((item) => [<option key={`${item.id}-output`} value={`{{${item.id}.output}}`}>{item.name} / 输出</option>, ...(item.type === "condition" || item.type === "switch" ? [<option key={`${item.id}-branch`} value={`{{${item.id}.output.branch}}`}>{item.name} / 命中分支</option>] : [])])}</select>;
}

function ToolVariablePicker({ parameters, nodes, currentId, onChange }: { parameters: Record<string, unknown>; nodes: WorkflowNode[]; currentId: string; onChange: (parameters: Record<string, unknown>) => void }) {
  const keys = Object.keys(parameters);
  const [parameter, setParameter] = useState(keys[0] ?? "");
  if (!keys.length) return null;
  const active = keys.includes(parameter) ? parameter : keys[0];
  return <div className="tool-variable-picker"><label>插入变量到参数</label><select value={active} onChange={(event) => setParameter(event.target.value)}>{keys.map((key) => <option key={key} value={key}>{key}</option>)}</select><VariablePicker nodes={nodes} currentId={currentId} onInsert={(variable) => onChange({ ...parameters, [active]: `${String(parameters[active] ?? "")}${variable}` })} /></div>;
}

function StartVariablesEditor({ variables, onChange }: { variables: StartInputVariable[]; onChange: (variables: StartInputVariable[]) => void }) {
  function update(index: number, patch: Partial<StartInputVariable>) { onChange(variables.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)); }
  return <div className="start-variables"><div className="start-variables-head"><div><strong>接口输入参数</strong><small>调用 API 时通过 inputs 对象传入</small></div><button onClick={() => onChange([...variables, { name: `field_${variables.length + 1}`, label: "新参数", type: "string", required: false, default: "" }])}>＋ 添加参数</button></div>{variables.map((variable, index) => <article key={index}><div><label>参数名</label><input value={variable.name} onChange={(event) => update(index, { name: event.target.value.replace(/[^A-Za-z0-9_]/g, "") })} placeholder="topic" /></div><div><label>显示名称</label><input value={variable.label} onChange={(event) => update(index, { label: event.target.value })} placeholder="主题" /></div><div><label>类型</label><select value={variable.type} onChange={(event) => update(index, { type: event.target.value as StartInputVariable["type"] })}><option value="string">文本</option><option value="number">数字</option><option value="boolean">布尔值</option></select></div><label className="start-required"><input type="checkbox" checked={variable.required} onChange={(event) => update(index, { required: event.target.checked })} />必填</label><button className="row-delete" onClick={() => onChange(variables.filter((_, itemIndex) => itemIndex !== index))}>×</button><div className="start-variable-wide"><label>默认值</label><input value={String(variable.default ?? "")} onChange={(event) => update(index, { default: event.target.value })} placeholder="可选" /></div><div className="start-variable-wide"><label>说明</label><input value={variable.description ?? ""} onChange={(event) => update(index, { description: event.target.value })} placeholder="向接口调用者说明该参数" /></div></article>)}{!variables.length && <p>尚未定义输入参数。添加后，API 和调试面板会自动生成对应字段。</p>}</div>;
}

type SwitchCase = { id: string; label: string; value: string };

function SwitchCasesEditor({ cases, onChange }: { cases: SwitchCase[]; onChange: (cases: SwitchCase[]) => void }) {
  function update(index: number, patch: Partial<SwitchCase>) { onChange(cases.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)); }
  return <div className="switch-cases"><div className="switch-cases-head"><strong>Case 分支</strong><button onClick={() => onChange([...cases, { id: `case_${crypto.randomUUID().slice(0, 6)}`, label: `Case ${cases.length + 1}`, value: "" }])}>＋ 添加 Case</button></div>{cases.map((item, index) => <article key={item.id}><span>{index + 1}</span><div><label>分支名称</label><input value={item.label} onChange={(event) => update(index, { label: event.target.value })} placeholder={`Case ${index + 1}`} /></div><div><label>匹配值</label><input value={item.value} onChange={(event) => update(index, { value: event.target.value })} placeholder="例如 article" /></div><button className="row-delete" onClick={() => onChange(cases.filter((_, itemIndex) => itemIndex !== index))}>×</button></article>)}<div className="switch-default"><i>DEFAULT</i><span>没有 Case 命中时执行</span></div></div>;
}

function AnswerOutputsEditor({ outputs, variables, currentId, onChange }: { outputs: AnswerOutputVariable[]; variables: WorkflowNode[]; currentId: string; onChange: (outputs: AnswerOutputVariable[]) => void }) {
  function update(index: number, patch: Partial<AnswerOutputVariable>) { onChange(outputs.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item)); }
  return <div className="answer-outputs"><div className="start-variables-head"><div><strong>结构化输出</strong><small>API 将通过 outputs 对象返回</small></div><button onClick={() => onChange([...outputs, { name: `result_${outputs.length + 1}`, label: "输出结果", type: "string", value: "", required: false }])}>＋ 添加字段</button></div>{outputs.map((output, index) => <article key={index}><div><label>字段名</label><input value={output.name} onChange={(event) => update(index, { name: event.target.value.replace(/[^A-Za-z0-9_]/g, "") })} /></div><div><label>显示名称</label><input value={output.label} onChange={(event) => update(index, { label: event.target.value })} /></div><div><label>类型</label><select value={output.type} onChange={(event) => update(index, { type: event.target.value as AnswerOutputVariable["type"] })}><option value="string">文本</option><option value="number">数字</option><option value="boolean">布尔值</option><option value="object">对象</option></select></div><label className="start-required"><input type="checkbox" checked={output.required} onChange={(event) => update(index, { required: event.target.checked })} />必填</label><button className="row-delete" onClick={() => onChange(outputs.filter((_, itemIndex) => itemIndex !== index))}>×</button><div className="answer-output-value"><label>变量映射</label><input value={output.value} onChange={(event) => update(index, { value: event.target.value })} placeholder="选择上游节点输出" /><VariablePicker nodes={variables} currentId={currentId} onInsert={(variable) => update(index, { value: variable })} /></div><div className="answer-output-description"><label>说明</label><input value={output.description ?? ""} onChange={(event) => update(index, { description: event.target.value })} placeholder="向接口调用者说明该字段" /></div></article>)}{!outputs.length && <p className="inspector-hint">未配置时继续使用原来的字符串 output；添加字段后同时返回 outputs。</p>}</div>;
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
    {["llm", "tool", "knowledge"].includes(node.type) && <details className="reliability-config"><summary>可靠性设置</summary><div className="inspector-grid"><div><label>超时（秒）</label><input type="number" min="1" max="600" value={Number(node.config.node_timeout_seconds ?? 30)} onChange={(event) => update({}, { node_timeout_seconds: Number(event.target.value) })} /></div><div><label>重试次数</label><input type="number" min="0" max="5" value={Number(node.config.retry_count ?? 0)} onChange={(event) => update({}, { retry_count: Number(event.target.value) })} /></div></div><label>首次重试间隔（秒）</label><input type="number" min="0" max="60" step="0.5" value={Number(node.config.retry_backoff_seconds ?? 1)} onChange={(event) => update({}, { retry_backoff_seconds: Number(event.target.value) })} /><p>后续重试按 2 倍指数退避。连接 ERROR 端口后，最终失败会进入降级分支。</p></details>}
    {node.type === "start" && <><p className="inspector-hint">开始节点是工作流唯一入口。定义参数后，可通过 <code>inputs</code> 对象调用接口。</p><StartVariablesEditor variables={(node.config.variables as StartInputVariable[] | undefined) ?? []} onChange={(variables) => update({}, { variables })} /></>}
    {node.type === "template" && <><label>Prompt 模板</label><textarea rows={6} value={String(node.config.template ?? "")} onChange={(event) => update({}, { template: event.target.value })} /><VariablePicker nodes={variables} currentId={node.id} onInsert={(variable) => update({}, { template: `${String(node.config.template ?? "")}${variable}` })} /><p className="inspector-hint">可插入开始输入或任意已执行节点的输出。</p></>}
    {node.type === "llm" && <><label>模型配置</label><select value={String(node.config.provider_config_id ?? "")} onChange={(event) => update({}, { provider_config_id: event.target.value })}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><label>模型</label><input value={String(node.config.model ?? "gpt-5.4")} onChange={(event) => update({}, { model: event.target.value })} /><label>System Prompt</label><textarea rows={6} value={String(node.config.system_prompt ?? "")} onChange={(event) => update({}, { system_prompt: event.target.value })} /><VariablePicker nodes={variables} currentId={node.id} onInsert={(variable) => update({}, { system_prompt: `${String(node.config.system_prompt ?? "")}${variable}` })} /><div className="inspector-grid"><div><label>温度</label><input type="number" step="0.1" min="0" max="2" value={Number(node.config.temperature ?? 0.2)} onChange={(event) => update({}, { temperature: Number(event.target.value) })} /></div><div><label>最大 Token</label><input type="number" min="1" value={Number(node.config.max_tokens ?? 512)} onChange={(event) => update({}, { max_tokens: Number(event.target.value) })} /></div></div></>}
    {node.type === "knowledge" && <><label>知识库</label><select value={String(node.config.dataset_id ?? "")} onChange={(event) => update({}, { dataset_id: event.target.value })}><option value="">请选择知识库</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.icon} {dataset.name}</option>)}</select><label>检索 Query</label><textarea rows={4} value={String(node.config.query ?? "{input}")} onChange={(event) => update({}, { query: event.target.value })} /><VariablePicker nodes={variables} currentId={node.id} onInsert={(variable) => update({}, { query: `${String(node.config.query ?? "")}${variable}` })} /><p className="inspector-hint">选择开始输入或上游节点输出作为检索内容。</p><div className="inspector-grid"><div><label>Top K</label><input type="number" min="1" max="20" value={Number(node.config.top_k ?? 3)} onChange={(event) => update({}, { top_k: Number(event.target.value) })} /></div><div><label>分数阈值</label><input type="number" min="0" max="1" step="0.05" value={Number(node.config.score_threshold ?? 0)} onChange={(event) => update({}, { score_threshold: Number(event.target.value) })} /></div></div>{!datasets.length && <p className="inspector-hint">请先在知识库页面创建知识库并添加文档。</p>}</>}
    {node.type === "condition" && <div className="condition-config"><label>判断变量</label><input value={String(node.config.left ?? "")} onChange={(event) => update({}, { left: event.target.value })} placeholder="选择或输入变量" /><VariablePicker nodes={variables} currentId={node.id} onInsert={(variable) => update({}, { left: variable })} /><label>判断方式</label><select value={String(node.config.operator ?? "equals")} onChange={(event) => update({}, { operator: event.target.value })}><option value="equals">等于</option><option value="not_equals">不等于</option><option value="contains">包含</option><option value="not_contains">不包含</option><option value="greater_than">大于</option><option value="less_than">小于</option><option value="is_empty">为空</option><option value="is_not_empty">不为空</option></select>{!["is_empty", "is_not_empty"].includes(String(node.config.operator)) && <><label>比较值</label><input value={String(node.config.right ?? "")} onChange={(event) => update({}, { right: event.target.value })} placeholder="输入固定值或变量" /><VariablePicker nodes={variables} currentId={node.id} onInsert={(variable) => update({}, { right: variable })} /></>}<div className="condition-branches"><span><i>TRUE</i>条件成立时执行</span><span><i>FALSE</i>条件不成立时执行</span></div></div>}
    {node.type === "switch" && <div className="condition-config"><label>判断变量</label><input value={String(node.config.expression ?? "")} onChange={(event) => update({}, { expression: event.target.value })} placeholder="选择枚举型变量" /><VariablePicker nodes={variables} currentId={node.id} onInsert={(variable) => update({}, { expression: variable })} /><p className="inspector-hint">按顺序精确匹配 Case 值；没有命中时进入 DEFAULT。</p><SwitchCasesEditor cases={(node.config.cases as SwitchCase[] | undefined) ?? []} onChange={(cases) => update({}, { cases })} /></div>}
    {node.type === "tool" && node.config.runtime !== "dify" && <><label>已安装插件</label><select value={String(node.config.plugin_id ?? "")} onChange={(event) => { const plugin = installed.find((item) => item.manifest.plugin_id === event.target.value); const tool = plugin?.manifest.tools[0]; update({}, { plugin_id: event.target.value, tool_name: tool?.name ?? "", parameters: Object.fromEntries(Object.keys(tool?.parameters ?? {}).map((key) => [key, key === "text" || key === "json" ? "{input}" : ""])) }); }}><option value="">请选择插件</option>{installed.map((item) => <option key={item.manifest.plugin_id} value={item.manifest.plugin_id}>{item.manifest.name}</option>)}</select><label>工具</label><select value={String(node.config.tool_name ?? "")} onChange={(event) => { const tool = activePlugin?.manifest.tools.find((item) => item.name === event.target.value); update({}, { tool_name: event.target.value, parameters: Object.fromEntries(Object.keys(tool?.parameters ?? {}).map((key) => [key, key === "text" || key === "json" ? "{input}" : ""])) }); }}>{activePlugin?.manifest.tools.map((tool) => <option key={tool.name} value={tool.name}>{tool.label}</option>)}</select>{activeTool && Object.entries(activeTool.parameters).map(([key, schema]) => <div key={key}><label>{key}{schema.required ? " *" : ""}</label><input value={String((node.config.parameters as Record<string, unknown> | undefined)?.[key] ?? "")} onChange={(event) => update({}, { parameters: { ...(node.config.parameters as Record<string, unknown> ?? {}), [key]: event.target.value } })} placeholder={key === "text" || key === "json" ? "{input}" : ""} /></div>)}{!installed.length && <p className="inspector-hint">请先到插件市场安装并启用 Tool 插件。</p>}</>}
    {node.type === "tool" && node.config.runtime === "dify" && <div className="dify-node-config"><p className="inspector-hint">Daemon 插件：<code>{String(node.config.plugin_id)}</code> / <code>{String(node.config.tool_name)}</code></p>{Object.keys(difyCredentialSchema).length > 0 && <div className="dify-credentials"><strong>插件授权</strong><small>凭据用于调用插件，不会显示在运行日志中。</small>{Object.entries(difyCredentialSchema).map(([key, schema]) => <div key={key}><label>{schema.label || key}{schema.required ? " *" : ""}</label><input type={schema.type?.includes("secret") ? "password" : "text"} value={String((node.config.credentials as Record<string, unknown> ?? {})[key] ?? "")} onChange={(event) => update({}, { credential_schema: difyCredentialSchema, credentials: { ...(node.config.credentials as Record<string, unknown> ?? {}), [key]: event.target.value } })} placeholder={`请输入 ${schema.label || key}`} /></div>)}</div>}{Object.entries(node.config.parameters as Record<string, unknown> ?? {}).map(([key, value]) => <div key={key}><label>{key}</label><input value={String(value ?? "")} onChange={(event) => update({}, { parameters: { ...(node.config.parameters as Record<string, unknown> ?? {}), [key]: event.target.value } })} placeholder="可使用 {input}" /></div>)}</div>}
    {node.type === "tool" && <ToolVariablePicker parameters={node.config.parameters as Record<string, unknown> ?? {}} nodes={variables} currentId={node.id} onChange={(parameters) => update({}, { parameters })} />}
    {node.type === "answer" && <><p className="inspector-hint">默认把上游值作为字符串 output，也可以映射为结构化 outputs。</p><AnswerOutputsEditor outputs={(node.config.outputs as AnswerOutputVariable[] | undefined) ?? []} variables={variables} currentId={node.id} onChange={(outputs) => update({}, { outputs })} /></>}
    {node.type !== "start" && <button className="danger-button" onClick={remove}>删除节点</button>}
  </div>;
}

function RunInspector({ variables, values, setValues, input, setInput, run, cancel, running, answer, outputs }: { variables: StartInputVariable[]; values: Record<string, unknown>; setValues: (value: Record<string, unknown>) => void; input: string; setInput: (value: string) => void; run: () => void; cancel?: () => void; running: boolean; answer: string; outputs: Record<string, unknown> }) {
  const missing = variables.some((variable) => variable.required && (values[variable.name] ?? variable.default ?? "") === "");
  return <div className="inspector-content"><div className="inspector-title"><span>DEBUG</span><h3>运行调试</h3></div><p className="inspector-hint">运行前会自动保存并执行 DAG 校验。</p>{variables.length ? <div className="structured-run-inputs">{variables.map((variable) => <label key={variable.name}>{variable.label || variable.name}{variable.required ? " *" : ""}<small>{variable.name} · {variable.type === "string" ? "文本" : variable.type === "number" ? "数字" : "布尔值"}</small>{variable.type === "boolean" ? <select value={String(values[variable.name] ?? variable.default ?? "false")} onChange={(event) => setValues({ ...values, [variable.name]: event.target.value === "true" })}><option value="false">否</option><option value="true">是</option></select> : <input type={variable.type === "number" ? "number" : "text"} value={String(values[variable.name] ?? variable.default ?? "")} onChange={(event) => setValues({ ...values, [variable.name]: event.target.value })} placeholder={variable.description || variable.name} />}</label>)}</div> : <><label>工作流输入</label><textarea rows={7} value={input} onChange={(event) => setInput(event.target.value)} /></>}{running && cancel ? <button className="cancel-workflow-button wide" onClick={cancel}>■ 停止运行</button> : <button className="primary wide" onClick={run} disabled={running || missing || (!variables.length && !input.trim())}>{running ? "执行中" : "运行工作流"}</button>}{Object.keys(outputs).length > 0 ? <div className="structured-output-result"><span>结构化输出</span>{Object.entries(outputs).map(([key, value]) => <div key={key}><code>{key}</code><pre>{typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}</pre></div>)}</div> : answer && <div className="workflow-answer"><span>最终回答</span><p>{answer}</p></div>}</div>;
}
