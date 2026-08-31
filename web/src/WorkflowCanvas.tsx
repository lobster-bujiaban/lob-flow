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
import type { App, PluginCatalogItem, ProviderConfig, WorkflowDefinition, WorkflowEvent, WorkflowNode, WorkflowNodeType } from "./types";

type CanvasData = {
  workflow: WorkflowNode;
  status?: string;
  output?: string;
};
type CanvasNode = Node<CanvasData, "workflow">;

const labels: Record<WorkflowNodeType, string> = {
  start: "开始",
  template: "Prompt 模板",
  llm: "LLM",
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
    {workflow.type !== "answer" && <Handle type="source" position={Position.Right} />}
  </div>;
}

const nodeTypes = { workflow: CanvasNodeCard };

export function WorkflowCanvas(props: { app: App; workspaceId: string; providers: ProviderConfig[]; onError: (reason: unknown) => void }) {
  return <ReactFlowProvider><WorkflowCanvasInner {...props} /></ReactFlowProvider>;
}

function WorkflowCanvasInner({ app, workspaceId, providers, onError }: { app: App; workspaceId: string; providers: ProviderConfig[]; onError: (reason: unknown) => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [input, setInput] = useState("用一句话说明这个工作流");
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState("");
  const [plugins, setPlugins] = useState<PluginCatalogItem[]>([]);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);

  useEffect(() => {
    api.getWorkflow(app.id).then((draft) => loadDefinition(draft.definition)).catch(onError);
  }, [app.id]);
  useEffect(() => { api.listPlugins(workspaceId).then(setPlugins).catch(onError); }, [workspaceId]);

  function loadDefinition(definition: WorkflowDefinition) {
    setNodes(definition.nodes.map((workflow, index) => ({
      id: workflow.id,
      type: "workflow",
      position: { x: workflow.position.x ?? 80 + index * 280, y: workflow.position.y ?? 220 },
      data: { workflow },
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
  }

  const selected = useMemo(() => nodes.find((node) => node.id === selectedId) ?? null, [nodes, selectedId]);
  const definition = useCallback((): WorkflowDefinition => ({
    nodes: nodes.map((node) => ({ ...node.data.workflow, position: node.position })),
    edges: edges.map((edge) => ({ source: edge.source, target: edge.target }))
  }), [nodes, edges]);

  const connect = useCallback((connection: Connection) => setEdges((current) => addEdge({
    ...connection,
    markerEnd: { type: MarkerType.ArrowClosed }
  }, current)), [setEdges]);

  function addNode(type: Exclude<WorkflowNodeType, "start">, selectedPlugin?: PluginCatalogItem, selectedToolName?: string) {
    const id = `${type}-${crypto.randomUUID().slice(0, 8)}`;
    const config = type === "template"
      ? { template: "{input}" }
      : type === "llm"
        ? { system_prompt: "你是一个有帮助的 AI 助手。", provider_config_id: providers[0]?.id ?? "", model: "gpt-5.4", temperature: 0.2, max_tokens: 512, timeout_seconds: 30 }
        : type === "tool"
          ? (() => { const plugin = selectedPlugin ?? plugins.find((item) => item.installed && item.enabled); const tool = plugin?.manifest.tools.find((item) => item.name === selectedToolName) ?? plugin?.manifest.tools[0]; return { plugin_id: plugin?.manifest.plugin_id ?? "", tool_name: tool?.name ?? "", parameters: Object.fromEntries(Object.keys(tool?.parameters ?? {}).map((key) => [key, key === "text" || key === "json" ? "{input}" : ""])) }; })()
        : {};
    const tool = type === "tool" ? selectedPlugin?.manifest.tools.find((item) => item.name === selectedToolName) : undefined;
    const node: CanvasNode = {
      id,
      type: "workflow",
      position: { x: 360 + nodes.length * 35, y: 160 + nodes.length * 35 },
      data: { workflow: { id, type, name: tool?.label ?? labels[type], config, position: {} } },
      deletable: true
    };
    setNodes((current) => [...current, node]);
    setSelectedId(id);
    setToolMenuOpen(false);
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

  async function save(showSuccess = true): Promise<boolean> {
    setSaving(true);
    try {
      const saved = await api.updateWorkflow(app.id, definition());
      if (showSuccess) loadDefinition(saved.definition);
      return true;
    } catch (reason) {
      onError(reason);
      return false;
    } finally { setSaving(false); }
  }

  async function run() {
    if (!input.trim() || running || !(await save(false))) return;
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
      <div><strong>工作流画布</strong><span>拖拽节点 · 端口连线 · Delete 删除</span></div>
      <div className="flow-add-buttons"><button onClick={() => addNode("template")}>＋ Template</button><button onClick={() => addNode("llm")}>＋ LLM</button><div className="tool-node-picker"><button className={toolMenuOpen ? "active" : ""} onClick={() => setToolMenuOpen((open) => !open)}>＋ 已安装工具 <span>⌄</span></button>{toolMenuOpen && <div className="tool-node-menu">{plugins.filter((item) => item.installed && item.enabled).map((plugin) => <div className="tool-node-group" key={plugin.manifest.plugin_id}><strong><span>{plugin.manifest.icon}</span>{plugin.manifest.name}</strong>{plugin.manifest.tools.map((tool) => <button key={tool.name} onClick={() => addNode("tool", plugin, tool.name)}><span>{tool.label}</span><small>{tool.description}</small></button>)}</div>)}{!plugins.some((item) => item.installed && item.enabled) && <div className="tool-menu-empty">还没有启用的插件，请先到插件市场安装。</div>}</div>}</div><button onClick={() => addNode("answer")}>＋ Answer</button></div>
      <button className="primary" onClick={() => save()} disabled={saving}>{saving ? "保存中" : "保存工作流"}</button>
    </div>
    <div className="flow-canvas-main">
      <div className="flow-board">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={connect}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
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
      </div>
      <aside className="flow-inspector">
        {selected ? <NodeInspector node={selected.data.workflow} providers={providers} plugins={plugins} update={updateSelected} remove={deleteSelected} /> : <RunInspector input={input} setInput={setInput} run={run} running={running} answer={answer} />}
      </aside>
    </div>
  </section>;
}

function NodeInspector({ node, providers, plugins, update, remove }: { node: WorkflowNode; providers: ProviderConfig[]; plugins: PluginCatalogItem[]; update: (patch: Partial<WorkflowNode>, config?: Record<string, unknown>) => void; remove: () => void }) {
  const installed = plugins.filter((item) => item.installed && item.enabled);
  const activePlugin = installed.find((item) => item.manifest.plugin_id === node.config.plugin_id);
  const activeTool = activePlugin?.manifest.tools.find((tool) => tool.name === node.config.tool_name);
  return <div className="inspector-content">
    <div className="inspector-title"><span>{node.type.toUpperCase()}</span><h3>节点配置</h3></div>
    <label>节点名称</label><input value={node.name} onChange={(event) => update({ name: event.target.value })} />
    {node.type === "start" && <p className="inspector-hint">Start 是工作流唯一入口，不能删除。</p>}
    {node.type === "template" && <><label>Prompt 模板</label><textarea rows={6} value={String(node.config.template ?? "")} onChange={(event) => update({}, { template: event.target.value })} /><p className="inspector-hint">使用 <code>{"{input}"}</code> 引用上游输入。</p></>}
    {node.type === "llm" && <><label>模型配置</label><select value={String(node.config.provider_config_id ?? "")} onChange={(event) => update({}, { provider_config_id: event.target.value })}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><label>模型</label><input value={String(node.config.model ?? "gpt-5.4")} onChange={(event) => update({}, { model: event.target.value })} /><label>System Prompt</label><textarea rows={6} value={String(node.config.system_prompt ?? "")} onChange={(event) => update({}, { system_prompt: event.target.value })} /><div className="inspector-grid"><div><label>温度</label><input type="number" step="0.1" min="0" max="2" value={Number(node.config.temperature ?? 0.2)} onChange={(event) => update({}, { temperature: Number(event.target.value) })} /></div><div><label>最大 Token</label><input type="number" min="1" value={Number(node.config.max_tokens ?? 512)} onChange={(event) => update({}, { max_tokens: Number(event.target.value) })} /></div></div></>}
    {node.type === "tool" && <><label>已安装插件</label><select value={String(node.config.plugin_id ?? "")} onChange={(event) => { const plugin = installed.find((item) => item.manifest.plugin_id === event.target.value); const tool = plugin?.manifest.tools[0]; update({}, { plugin_id: event.target.value, tool_name: tool?.name ?? "", parameters: Object.fromEntries(Object.keys(tool?.parameters ?? {}).map((key) => [key, key === "text" || key === "json" ? "{input}" : ""])) }); }}><option value="">请选择插件</option>{installed.map((item) => <option key={item.manifest.plugin_id} value={item.manifest.plugin_id}>{item.manifest.name}</option>)}</select><label>工具</label><select value={String(node.config.tool_name ?? "")} onChange={(event) => { const tool = activePlugin?.manifest.tools.find((item) => item.name === event.target.value); update({}, { tool_name: event.target.value, parameters: Object.fromEntries(Object.keys(tool?.parameters ?? {}).map((key) => [key, key === "text" || key === "json" ? "{input}" : ""])) }); }}>{activePlugin?.manifest.tools.map((tool) => <option key={tool.name} value={tool.name}>{tool.label}</option>)}</select>{activeTool && Object.entries(activeTool.parameters).map(([key, schema]) => <div key={key}><label>{key}{schema.required ? " *" : ""}</label><input value={String((node.config.parameters as Record<string, unknown> | undefined)?.[key] ?? "")} onChange={(event) => update({}, { parameters: { ...(node.config.parameters as Record<string, unknown> ?? {}), [key]: event.target.value } })} placeholder={key === "text" || key === "json" ? "{input}" : ""} /></div>)}{!installed.length && <p className="inspector-hint">请先到插件市场安装并启用 Tool 插件。</p>}</>}
    {node.type === "answer" && <p className="inspector-hint">把所有上游节点完成后的值作为最终回答。</p>}
    {node.type !== "start" && <button className="danger-button" onClick={remove}>删除节点</button>}
  </div>;
}

function RunInspector({ input, setInput, run, running, answer }: { input: string; setInput: (value: string) => void; run: () => void; running: boolean; answer: string }) {
  return <div className="inspector-content"><div className="inspector-title"><span>DEBUG</span><h3>运行调试</h3></div><p className="inspector-hint">运行前会自动保存并执行 DAG 校验。</p><label>工作流输入</label><textarea rows={7} value={input} onChange={(event) => setInput(event.target.value)} /><button className="primary wide" onClick={run} disabled={running || !input.trim()}>{running ? "执行中" : "运行工作流"}</button>{answer && <div className="workflow-answer"><span>最终回答</span><p>{answer}</p></div>}</div>;
}
