import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { PluginCatalogItem } from "./types";

export function PluginMarketplace({ workspaceId, onError }: { workspaceId: string; onError: (reason: unknown) => void }) {
  const [plugins, setPlugins] = useState<PluginCatalogItem[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PluginCatalogItem | null>(null);
  const [busy, setBusy] = useState("");
  const [daemonAvailable, setDaemonAvailable] = useState(false);
  const [notice, setNotice] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const [marketPlugins, setMarketPlugins] = useState<Array<{ org: string; name: string; label: string; description: string; category: string; icon_url: string; install_count: number; verified: boolean; version: string; identifier: string }>>([]);
  const [category, setCategory] = useState("all");

  function refresh() { api.listPlugins(workspaceId).then(setPlugins).catch(onError); }
  useEffect(refresh, [workspaceId]);
  useEffect(() => { api.daemonStatus().then((result) => setDaemonAvailable(result.available)).catch(() => setDaemonAvailable(false)); }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => api.exploreMarketplace(query).then(setMarketPlugins).catch(onError), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const filtered = useMemo(() => plugins.filter((item) => `${item.manifest.name} ${item.manifest.description}`.toLowerCase().includes(query.toLowerCase())), [plugins, query]);
  const visibleMarketPlugins = useMemo(() => category === "all" ? marketPlugins : marketPlugins.filter((item) => item.category === category), [marketPlugins, category]);
  const categories = [{ id: "all", label: "全部" }, { id: "model", label: "模型" }, { id: "tool", label: "工具" }, { id: "datasource", label: "数据源" }, { id: "trigger", label: "触发器" }, { id: "agent-strategy", label: "Agent 策略" }, { id: "extension", label: "扩展" }, { id: "bundle", label: "插件集" }];

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

  async function uploadDifypkg(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy("difypkg"); setNotice("");
    try {
      const result = await api.uploadDifyPlugin(workspaceId, file);
      setNotice(`已提交安装：${String(result.identifier)}。Daemon 正在初始化插件依赖。`);
    } catch (reason) { onError(reason); }
    finally { setBusy(""); event.target.value = ""; }
  }

  async function installFromMarketplace(identifier: string) {
    setBusy(identifier); setNotice("");
    try {
      const result = await api.installMarketplacePlugin(workspaceId, identifier);
      setNotice(`已提交安装：${result.identifier}。依赖初始化完成后会进入工作流节点库。`);
    } catch (reason) { onError(reason); }
    finally { setBusy(""); }
  }

  return <section className="marketplace-wrap">
    <div className="marketplace-head"><div><div className="eyebrow">DIFY PLUGIN MARKETPLACE</div><h2>插件市场</h2><p><span className={daemonAvailable ? "daemon-dot online" : "daemon-dot"} />{daemonAvailable ? "Dify Plugin Daemon 已连接" : "Dify Plugin Daemon 未连接"}</p></div><div className="marketplace-controls"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索插件…" /><input ref={uploadRef} className="file-input" type="file" accept=".difypkg" onChange={uploadDifypkg} /><button onClick={() => uploadRef.current?.click()} disabled={!daemonAvailable || busy === "difypkg"}>{busy === "difypkg" ? "安装中…" : "＋ 安装 .difypkg"}</button></div></div>
    {notice && <div className="marketplace-notice">{notice}</div>}
    <div className="marketplace-categories">{categories.map((item) => <button key={item.id} className={category === item.id ? "active" : ""} onClick={() => setCategory(item.id)}>{item.label}</button>)}</div>
    <div className="marketplace-section-title"><strong>探索 Marketplace</strong><span>{visibleMarketPlugins.length} 个结果</span></div>
    <div className="marketplace-grid">{visibleMarketPlugins.map((item) => <article className="plugin-card market-card" key={item.identifier}>
      <span className="plugin-category">{categories.find((entry) => entry.id === item.category)?.label ?? item.category}</span>
      <div className="plugin-card-head"><div className="plugin-icon">{item.icon_url ? <img src={item.icon_url} alt="" /> : item.name.slice(0, 2).toUpperCase()}</div><div><h3>{item.label} {item.verified && <span className="verified">✓</span>}</h3><p>{item.org}/{item.name} · v{item.version}</p></div></div>
      <p className="plugin-description">{item.description || "来自 Dify Marketplace"}</p>
      <div className="plugin-install-count">⇩ {item.install_count.toLocaleString()}</div>
      <div className="plugin-actions"><button className="primary" onClick={() => installFromMarketplace(item.identifier)} disabled={!daemonAvailable || busy === item.identifier}>{busy === item.identifier ? "安装中…" : "安装"}</button></div>
    </article>)}</div>
    {!!plugins.length && <div className="marketplace-section-title"><strong>LOB 内置工具</strong><span>{plugins.length} 个</span></div>}
    <div className="marketplace-grid">{filtered.map((item) => <article className="plugin-card" key={item.manifest.plugin_id}>
      <div className="plugin-card-head"><div className="plugin-icon">{item.manifest.icon}</div><div><h3>{item.manifest.name} {item.manifest.verified && <span className="verified">✓ 官方</span>}</h3><p>{item.manifest.author} · v{item.manifest.version}</p></div></div>
      <p className="plugin-description">{item.manifest.description}</p>
      <div className="plugin-tools">{item.manifest.tools.map((tool) => <span key={tool.name}>{tool.label}</span>)}</div>
      <div className="plugin-actions">{!item.installed ? <button className="primary" onClick={() => setSelected(item)}>安装</button> : <><button onClick={() => toggle(item)} disabled={busy === item.manifest.plugin_id}>{item.enabled ? "停用" : "启用"}</button><button className="danger-link" onClick={() => uninstall(item)}>卸载</button></>}</div>
    </article>)}</div>
    {selected && <div className="modal-backdrop"><form className="modal" onSubmit={install}><div className="modal-head"><div><h3>安装 {selected.manifest.name}</h3><p>{selected.manifest.description}</p></div><button type="button" onClick={() => setSelected(null)}>×</button></div>{Object.entries(selected.manifest.credential_schema).map(([key, schema]) => <div key={key}><label>{key}</label><input name={key} type={schema.type === "secret" ? "password" : "text"} required={schema.required} placeholder={schema.required ? "必填" : "可选"} /></div>)}{!Object.keys(selected.manifest.credential_schema).length && <div className="security-note">此插件无需凭据，安装后可直接在工作流中使用。</div>}<button className="primary wide" disabled={busy === selected.manifest.plugin_id}>确认安装</button></form></div>}
  </section>;
}
