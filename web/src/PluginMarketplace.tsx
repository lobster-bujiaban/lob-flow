import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { PluginCatalogItem } from "./types";

export function PluginMarketplace({ workspaceId, onError }: { workspaceId: string; onError: (reason: unknown) => void }) {
  const [plugins, setPlugins] = useState<PluginCatalogItem[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PluginCatalogItem | null>(null);
  const [busy, setBusy] = useState("");

  function refresh() { api.listPlugins(workspaceId).then(setPlugins).catch(onError); }
  useEffect(refresh, [workspaceId]);
  const filtered = useMemo(() => plugins.filter((item) => `${item.manifest.name} ${item.manifest.description}`.toLowerCase().includes(query.toLowerCase())), [plugins, query]);

  async function install(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    const credentials = Object.fromEntries(Object.keys(selected.manifest.credential_schema).map((key) => [key, String(form.get(key) ?? "")]));
    setBusy(selected.manifest.plugin_id);
    try { await api.installPlugin(workspaceId, selected.manifest.plugin_id, credentials); setSelected(null); refresh(); }
    catch (reason) { onError(reason); }
    finally { setBusy(""); }
  }

  async function toggle(item: PluginCatalogItem) {
    setBusy(item.manifest.plugin_id);
    try { await api.enablePlugin(workspaceId, item.manifest.plugin_id, !item.enabled); refresh(); }
    catch (reason) { onError(reason); }
    finally { setBusy(""); }
  }

  async function uninstall(item: PluginCatalogItem) {
    setBusy(item.manifest.plugin_id);
    try { await api.uninstallPlugin(workspaceId, item.manifest.plugin_id); refresh(); }
    catch (reason) { onError(reason); }
    finally { setBusy(""); }
  }

  return <section className="marketplace-wrap">
    <div className="marketplace-head"><div><div className="eyebrow">PLUGIN MARKETPLACE</div><h2>插件市场</h2><p>安装到当前 Workspace，工具会自动出现在工作流节点库。</p></div><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索插件…" /></div>
    <div className="marketplace-grid">{filtered.map((item) => <article className="plugin-card" key={item.manifest.plugin_id}>
      <div className="plugin-card-head"><div className="plugin-icon">{item.manifest.icon}</div><div><h3>{item.manifest.name} {item.manifest.verified && <span className="verified">✓ 官方</span>}</h3><p>{item.manifest.author} · v{item.manifest.version}</p></div></div>
      <p className="plugin-description">{item.manifest.description}</p>
      <div className="plugin-tools">{item.manifest.tools.map((tool) => <span key={tool.name}>{tool.label}</span>)}</div>
      <div className="plugin-actions">{!item.installed ? <button className="primary" onClick={() => setSelected(item)}>安装</button> : <><button onClick={() => toggle(item)} disabled={busy === item.manifest.plugin_id}>{item.enabled ? "停用" : "启用"}</button><button className="danger-link" onClick={() => uninstall(item)}>卸载</button></>}</div>
    </article>)}</div>
    {selected && <div className="modal-backdrop"><form className="modal" onSubmit={install}><div className="modal-head"><div><h3>安装 {selected.manifest.name}</h3><p>{selected.manifest.description}</p></div><button type="button" onClick={() => setSelected(null)}>×</button></div>{Object.entries(selected.manifest.credential_schema).map(([key, schema]) => <div key={key}><label>{key}</label><input name={key} type={schema.type === "secret" ? "password" : "text"} required={schema.required} placeholder={schema.required ? "必填" : "可选"} /></div>)}{!Object.keys(selected.manifest.credential_schema).length && <div className="security-note">此插件无需凭据，安装后可直接在工作流中使用。</div>}<button className="primary wide" disabled={busy === selected.manifest.plugin_id}>确认安装</button></form></div>}
  </section>;
}
