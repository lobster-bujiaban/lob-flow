import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { PluginCatalogItem } from "./types";

type ToolEntry = {
  plugin: PluginCatalogItem;
  tool: PluginCatalogItem["manifest"]["tools"][number];
};

export function ToolsLibrary({ workspaceId, onError }: { workspaceId: string; onError: (reason: unknown) => void }) {
  const [plugins, setPlugins] = useState<PluginCatalogItem[]>([]);
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<"tools" | "custom" | "workflow" | "mcp">("tools");
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [selected, setSelected] = useState<PluginCatalogItem | null>(null);
  const [busy, setBusy] = useState("");

  function refresh() { api.listPlugins(workspaceId).then(setPlugins).catch(onError); }
  useEffect(refresh, [workspaceId]);

  const tools = useMemo<ToolEntry[]>(() => plugins.flatMap((plugin) => plugin.manifest.tools.map((tool) => ({ plugin, tool }))).filter(({ plugin, tool }) => {
    const matchesQuery = `${tool.label} ${tool.name} ${tool.description} ${plugin.manifest.name} ${plugin.manifest.author}`.toLowerCase().includes(query.toLowerCase());
    const matchesFilter = filter === "all" || (filter === "enabled" ? plugin.installed && plugin.enabled : plugin.installed && !plugin.enabled);
    return matchesQuery && matchesFilter;
  }), [plugins, query, filter]);

  async function install(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return;
    const form = new FormData(event.currentTarget);
    const credentials = Object.fromEntries(Object.keys(selected.manifest.credential_schema).map((key) => [key, String(form.get(key) ?? "")]));
    setBusy(selected.manifest.plugin_id);
    try { await api.installPlugin(workspaceId, selected.manifest.plugin_id, credentials); setSelected(null); refresh(); } catch (reason) { onError(reason); } finally { setBusy(""); }
  }
  async function toggle(plugin: PluginCatalogItem) {
    setBusy(plugin.manifest.plugin_id);
    try { await api.enablePlugin(workspaceId, plugin.manifest.plugin_id, !plugin.enabled); refresh(); } catch (reason) { onError(reason); } finally { setBusy(""); }
  }
  async function uninstall(plugin: PluginCatalogItem) {
    if (!confirm(`卸载工具包“${plugin.manifest.name}”？其工具将从工作流节点库中移除。`)) return;
    setBusy(plugin.manifest.plugin_id);
    try { await api.uninstallPlugin(workspaceId, plugin.manifest.plugin_id); refresh(); } catch (reason) { onError(reason); } finally { setBusy(""); }
  }

  return <section className="tools-wrap">
    <div className="tools-head"><div><div className="eyebrow">WORKSPACE CAPABILITIES</div><h2>工具</h2><p>管理当前空间可在工作流中调用的能力。</p></div><div className="tools-search"><select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工具…" /></div></div>
    <div className="tools-tabs"><button className={section === "tools" ? "active" : ""} onClick={() => setSection("tools")}>工具</button><button className={section === "custom" ? "active" : ""} onClick={() => setSection("custom")}>自定义</button><button className={section === "workflow" ? "active" : ""} onClick={() => setSection("workflow")}>工作流</button><button className={section === "mcp" ? "active" : ""} onClick={() => setSection("mcp")}>MCP</button></div>
    {section === "tools" ? <><div className="tools-summary"><span>{tools.length} 个工具</span><span>{plugins.filter((item) => item.installed && item.enabled).length} 个工具包已启用</span></div><div className="tools-grid">{tools.map(({ plugin, tool }) => <article className="tool-card" key={`${plugin.manifest.plugin_id}/${tool.name}`}>
      <div className="tool-card-main"><div className="plugin-icon">{plugin.manifest.icon}</div><div><h3>{tool.label} {plugin.manifest.verified && <span className="verified">✓</span>}</h3><span>{plugin.manifest.author}/{plugin.manifest.plugin_id.split("/").pop()}</span></div><i className={plugin.installed && plugin.enabled ? "tool-state online" : "tool-state"}>{plugin.installed ? (plugin.enabled ? "已启用" : "已停用") : "未安装"}</i></div>
      <p>{tool.description || plugin.manifest.description}</p><div className="tool-tags"><span># 工具</span>{Object.keys(tool.parameters).slice(0, 2).map((name) => <span key={name}># {name}</span>)}</div>
      <footer>{!plugin.installed ? <button className="primary" onClick={() => setSelected(plugin)}>安装工具包</button> : <><button onClick={() => toggle(plugin)} disabled={busy === plugin.manifest.plugin_id}>{plugin.enabled ? "停用" : "启用"}</button><button className="danger-link" onClick={() => uninstall(plugin)} disabled={busy === plugin.manifest.plugin_id}>卸载</button></>}</footer>
    </article>)}</div>{!tools.length && <div className="knowledge-empty">没有匹配的工具</div>}</> : <div className="tools-coming"><span>{section === "custom" ? "◇" : section === "workflow" ? "⌘" : "↔"}</span><h3>{section === "custom" ? "自定义工具" : section === "workflow" ? "工作流工具" : "MCP 工具"}</h3><p>{section === "custom" ? "后续可通过 OpenAPI Schema 创建自定义工具。" : section === "workflow" ? "后续可将已发布工作流封装为可复用工具。" : "后续可连接 MCP Server，并将其能力加入工作流。"}</p></div>}
    {selected && <div className="modal-backdrop"><form className="modal" onSubmit={install}><div className="modal-head"><div><h3>安装 {selected.manifest.name}</h3><p>{selected.manifest.description}</p></div><button type="button" onClick={() => setSelected(null)}>×</button></div>{Object.entries(selected.manifest.credential_schema).map(([key, schema]) => <div key={key}><label>{key}</label><input name={key} type={schema.type === "secret" ? "password" : "text"} required={schema.required} placeholder={schema.required ? "必填" : "可选"} /></div>)}{!Object.keys(selected.manifest.credential_schema).length && <div className="security-note">此工具包无需凭据，安装后可直接在工作流中使用。</div>}<button className="primary wide" disabled={busy === selected.manifest.plugin_id}>确认安装</button></form></div>}
  </section>;
}
