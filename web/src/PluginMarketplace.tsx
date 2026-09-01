import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { DifyToolProvider, PluginRuntimeState } from "./types";

function MarketplaceIcon({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="plugin-icon">{src && !failed ? <img src={src} alt={`${name} 图标`} onError={() => setFailed(true)} /> : <span>{name.slice(0, 2).toUpperCase()}</span>}</div>;
}

export function PluginMarketplace({ workspaceId, onError }: { workspaceId: string; onError: (reason: unknown) => void }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [daemonAvailable, setDaemonAvailable] = useState(false);
  const [notice, setNotice] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const [marketPlugins, setMarketPlugins] = useState<Array<{ org: string; name: string; label: string; description: string; category: string; icon_url: string; install_count: number; verified: boolean; version: string; identifier: string }>>([]);
  const [category, setCategory] = useState("all");
  const [view, setView] = useState<"installed" | "explore">("explore");
  const [installedIds, setInstalledIds] = useState<string[]>([]);
  const [installingIds, setInstallingIds] = useState<string[]>([]);
  const [toolProviders, setToolProviders] = useState<DifyToolProvider[]>([]);
  const [runtimeStates, setRuntimeStates] = useState<PluginRuntimeState[]>([]);
  const pollAttempts = useRef(0);

  async function refreshInstalled() {
    const result = await api.listInstalledDifyPlugins(workspaceId);
    setInstalledIds(result.plugin_ids);
    setInstallingIds((items) => items.filter((id) => !result.plugin_ids.includes(id)));
  }

  useEffect(() => { api.daemonStatus().then((result) => setDaemonAvailable(result.available)).catch(() => setDaemonAvailable(false)); }, []);
  useEffect(() => { refreshInstalled().catch(onError); api.listDifyTools(workspaceId).then(setToolProviders).catch(onError); api.listPluginRuntimeStates(workspaceId).then(setRuntimeStates).catch(onError); }, [workspaceId]);
  useEffect(() => {
    if (!installingIds.length) { pollAttempts.current = 0; return; }
    const timer = window.setInterval(() => {
      pollAttempts.current += 1;
      refreshInstalled().catch(onError);
      if (pollAttempts.current >= 24) setInstallingIds([]);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [installingIds.length, workspaceId]);
  useEffect(() => {
    const timer = window.setTimeout(() => api.exploreMarketplace(query).then(setMarketPlugins).catch(onError), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const visibleMarketPlugins = useMemo(() => {
    const source = view === "installed" ? marketPlugins.filter((item) => installedIds.includes(`${item.org}/${item.name}`)) : marketPlugins;
    return category === "all" ? source : source.filter((item) => item.category === category);
  }, [marketPlugins, category, installedIds, view]);
  const missingInstalledIds = useMemo(() => installedIds.filter((id) => !marketPlugins.some((item) => `${item.org}/${item.name}` === id)), [installedIds, marketPlugins]);
  const categories = [{ id: "all", label: "全部" }, { id: "model", label: "模型" }, { id: "tool", label: "工具" }, { id: "datasource", label: "数据源" }, { id: "trigger", label: "触发器" }, { id: "agent-strategy", label: "Agent 策略" }, { id: "extension", label: "扩展" }, { id: "bundle", label: "插件集" }];

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
    const pluginId = identifier.split(":", 1)[0];
    setInstallingIds((items) => items.includes(pluginId) ? items : [...items, pluginId]);
    setBusy(identifier); setNotice("");
    try {
      const result = await api.installMarketplacePlugin(workspaceId, identifier);
      setNotice(`已提交安装：${result.identifier}。依赖初始化完成后会进入工作流节点库。`);
    } catch (reason) { setInstallingIds((items) => items.filter((id) => id !== pluginId)); onError(reason); }
    finally { setBusy(""); }
  }

  async function configurePlugin(pluginId: string) {
    const provider = toolProviders.find((item) => item.plugin_id === pluginId);
    if (!provider || !Object.keys(provider.credential_schema).length) { setNotice("此插件不需要 API Key 授权。"); return; }
    const credentials: Record<string, string> = {};
    for (const [key, schema] of Object.entries(provider.credential_schema)) { const value = window.prompt(`请输入${schema.label || key}`); if (value == null) return; credentials[key] = value; }
    try { await api.createPluginCredential(workspaceId, pluginId, `${provider.name} 默认授权`, credentials); setNotice(`${provider.name} 授权已加密保存。`); } catch (reason) { onError(reason); }
  }
  async function togglePlugin(pluginId: string) { const current = runtimeStates.find((item) => item.plugin_id === pluginId)?.enabled !== false; try { const state = await api.setDifyPluginEnabled(workspaceId, pluginId, !current); setRuntimeStates((items) => [...items.filter((item) => item.plugin_id !== pluginId), state]); } catch (reason) { onError(reason); } }
  async function uninstallPlugin(pluginId: string) { if (!window.confirm(`确定卸载 ${pluginId} 吗？相关工作流节点将无法运行。`)) return; try { await api.uninstallDifyPlugin(workspaceId, pluginId); await refreshInstalled(); setNotice(`已卸载 ${pluginId}`); } catch (reason) { onError(reason); } }

  return <section className="marketplace-wrap">
    <div className="plugin-view-tabs"><button className={view === "installed" ? "active" : ""} onClick={() => { setView("installed"); setCategory("all"); }}>已安装 <span>{installedIds.length}</span></button><button className={view === "explore" ? "active" : ""} onClick={() => setView("explore")}>探索 Marketplace</button></div>
    <div className="marketplace-head"><div><div className="eyebrow">DIFY PLUGIN MARKETPLACE</div><h2>插件市场</h2><p><span className={daemonAvailable ? "daemon-dot online" : "daemon-dot"} />{daemonAvailable ? "Dify Plugin Daemon 已连接" : "Dify Plugin Daemon 未连接"}</p></div><div className="marketplace-controls"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索插件…" /><input ref={uploadRef} className="file-input" type="file" accept=".difypkg" onChange={uploadDifypkg} /><button onClick={() => uploadRef.current?.click()} disabled={!daemonAvailable || busy === "difypkg"}>{busy === "difypkg" ? "安装中…" : "＋ 安装 .difypkg"}</button></div></div>
    {notice && <div className="marketplace-notice">{notice}</div>}
    <div className="marketplace-categories">{categories.map((item) => <button key={item.id} className={category === item.id ? "active" : ""} onClick={() => setCategory(item.id)}>{item.label}</button>)}</div>
    <div className="marketplace-section-title"><strong>{view === "installed" ? "已安装插件" : "探索 Marketplace"}</strong><span>{visibleMarketPlugins.length + (view === "installed" ? missingInstalledIds.length : 0)} 个结果</span></div>
    {view === "installed" && missingInstalledIds.length > 0 && <div className="marketplace-grid installed-fallback-grid">{missingInstalledIds.map((pluginId) => <article className="plugin-card market-card installed" key={pluginId}><span className="plugin-state installed">✓ 已安装</span><div className="plugin-card-head"><MarketplaceIcon src="" name={pluginId.split("/").pop() ?? pluginId} /><div><h3>{pluginId.split("/").pop()}</h3><p>{pluginId}</p></div></div><p className="plugin-description">此插件已安装到 Plugin Daemon，Marketplace 暂无公开详情。</p><div className="plugin-actions"><button className="installed-button" disabled>已安装</button></div></article>)}</div>}
    <div className="marketplace-grid">{visibleMarketPlugins.map((item) => { const pluginId = `${item.org}/${item.name}`; const installed = installedIds.includes(pluginId); const installing = installingIds.includes(pluginId); return <article className={`plugin-card market-card ${installed ? "installed" : installing ? "installing" : ""}`} key={item.identifier}>
      <span className="plugin-category">{categories.find((entry) => entry.id === item.category)?.label ?? item.category}</span>
      {(installed || installing) && <span className={`plugin-state ${installed ? "installed" : "installing"}`}>{installed ? "✓ 已安装" : "◌ 安装中"}</span>}
      <div className="plugin-card-head"><MarketplaceIcon src={item.icon_url} name={item.name} /><div><h3>{item.label} {item.verified && <span className="verified">✓</span>}</h3><p>{item.org}/{item.name} · v{item.version}</p></div></div>
      <p className="plugin-description">{item.description || "来自 Dify Marketplace"}</p>
      <div className="plugin-install-count">⇩ {item.install_count.toLocaleString()}</div>
      <div className="plugin-actions">{installed && view === "installed" ? <><button onClick={() => configurePlugin(pluginId)}>配置授权</button><button onClick={() => togglePlugin(pluginId)}>{runtimeStates.find((state) => state.plugin_id === pluginId)?.enabled === false ? "启用" : "停用"}</button><button className="danger-link" onClick={() => uninstallPlugin(pluginId)}>卸载</button></> : <button className={installed ? "installed-button" : "primary"} onClick={() => installFromMarketplace(item.identifier)} disabled={installed || installing || !daemonAvailable || busy === item.identifier}>{installed ? "已安装" : installing || busy === item.identifier ? "安装中…" : "安装"}</button>}</div>
    </article>; })}</div>
  </section>;
}
