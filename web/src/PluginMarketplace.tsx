import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

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

  useEffect(() => { api.daemonStatus().then((result) => setDaemonAvailable(result.available)).catch(() => setDaemonAvailable(false)); }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => api.exploreMarketplace(query).then(setMarketPlugins).catch(onError), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const visibleMarketPlugins = useMemo(() => category === "all" ? marketPlugins : marketPlugins.filter((item) => item.category === category), [marketPlugins, category]);
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
      <div className="plugin-card-head"><MarketplaceIcon src={item.icon_url} name={item.name} /><div><h3>{item.label} {item.verified && <span className="verified">✓</span>}</h3><p>{item.org}/{item.name} · v{item.version}</p></div></div>
      <p className="plugin-description">{item.description || "来自 Dify Marketplace"}</p>
      <div className="plugin-install-count">⇩ {item.install_count.toLocaleString()}</div>
      <div className="plugin-actions"><button className="primary" onClick={() => installFromMarketplace(item.identifier)} disabled={!daemonAvailable || busy === item.identifier}>{busy === item.identifier ? "安装中…" : "安装"}</button></div>
    </article>)}</div>
  </section>;
}
