import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Dataset, DatasetDocument, DocumentSegment, RetrievalResult } from "./types";

export function KnowledgeBase({ workspaceId, onError }: { workspaceId: string; onError: (reason: unknown) => void }) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [active, setActive] = useState<Dataset | null>(null);
  const [documents, setDocuments] = useState<DatasetDocument[]>([]);
  const [segments, setSegments] = useState<DocumentSegment[]>([]);
  const [documentId, setDocumentId] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RetrievalResult[]>([]);
  const [duration, setDuration] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<"dataset" | "document" | null>(null);

  function refresh() { api.listDatasets(workspaceId).then(setDatasets).catch(onError); }
  useEffect(refresh, [workspaceId]);
  useEffect(() => { if (active) api.listDocuments(active.id).then(setDocuments).catch(onError); }, [active?.id]);
  useEffect(() => { if (documentId) api.listSegments(documentId).then(setSegments).catch(onError); else setSegments([]); }, [documentId]);
  const filtered = useMemo(() => datasets.filter((item) => `${item.name}${item.description}`.toLowerCase().includes(search.toLowerCase())), [datasets, search]);

  async function createDataset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    try { await api.createDataset(workspaceId, { name: String(data.get("name")), description: String(data.get("description") ?? ""), icon: String(data.get("icon") || "📖") }); setModal(null); refresh(); } catch (reason) { onError(reason); }
  }
  async function addDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!active) return; const data = new FormData(event.currentTarget);
    try { await api.addDocument(active.id, { name: String(data.get("name")), content: String(data.get("content")), separator: "\n\n", max_chars: 1200, overlap: 150 }); setModal(null); setDocuments(await api.listDocuments(active.id)); refresh(); } catch (reason) { onError(reason); }
  }
  async function retrieve() { if (!active || !query.trim()) return; try { const response = await api.retrieveDataset(active.id, query.trim()); setResults(response.results); setDuration(response.duration_ms); } catch (reason) { onError(reason); } }

  if (!active) return <section className="knowledge-wrap">
    <div className="knowledge-head"><div><div className="eyebrow">RAG KNOWLEDGE</div><h2>知识库</h2><p>导入文本、自动分段，并在工作流中检索可信上下文。</p></div><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索知识库" /></div>
    <div className="dataset-grid"><button className="dataset-create" onClick={() => setModal("dataset")}><span>＋</span><strong>创建知识库</strong><small>创建新的知识集合</small></button>{filtered.map((item) => <button className="dataset-card" key={item.id} onClick={() => setActive(item)}><span className="dataset-icon">{item.icon}</span><div><strong>{item.name}</strong><p>{item.description || "暂无描述"}</p></div><footer><span>{item.document_count} 文档 · {item.segment_count} 分段</span><time>{new Date(item.updated_at).toLocaleDateString()}</time></footer></button>)}</div>
    {!filtered.length && datasets.length > 0 && <div className="knowledge-empty">没有匹配的知识库</div>}
    {modal === "dataset" && <div className="modal-backdrop"><form className="modal" onSubmit={createDataset}><div className="modal-head"><div><h3>创建知识库</h3><p>类似 Dify Dataset 的知识集合</p></div><button type="button" onClick={() => setModal(null)}>×</button></div><label>图标</label><input name="icon" defaultValue="📖" maxLength={20} /><label>名称</label><input name="name" required placeholder="例如：LOB Flow 产品文档" /><label>描述</label><textarea name="description" rows={3} placeholder="这个知识库包含什么？" /><button className="primary wide">创建</button></form></div>}
  </section>;

  return <section className="knowledge-detail">
    <div className="knowledge-detail-head"><button className="back-button" onClick={() => { setActive(null); setDocumentId(""); setResults([]); }}>← 返回知识库</button><div><span className="dataset-icon">{active.icon}</span><div><h2>{active.name}</h2><p>{active.description || "暂无描述"}</p></div></div><div className="knowledge-actions"><button className="danger-button" onClick={async () => { if (confirm(`删除知识库“${active.name}”？`)) { await api.deleteDataset(active.id); setActive(null); refresh(); } }}>删除</button><button className="primary" onClick={() => setModal("document")}>＋ 添加文本</button></div></div>
    <div className="knowledge-columns"><div className="document-panel"><h3>文档 <span>{documents.length}</span></h3>{documents.map((doc) => <div className={`document-row ${documentId === doc.id ? "active" : ""}`} key={doc.id} onClick={() => setDocumentId(doc.id)}><div><strong>{doc.name}</strong><span>{doc.segment_count} 分段 · {doc.word_count} 字</span></div><button onClick={async (event) => { event.stopPropagation(); await api.enableDocument(doc.id, !doc.enabled); setDocuments(await api.listDocuments(active.id)); }}>{doc.enabled ? "已启用" : "已停用"}</button><button className="row-delete" onClick={async (event) => { event.stopPropagation(); if (confirm(`删除文档“${doc.name}”？`)) { await api.deleteDocument(doc.id); setDocuments(await api.listDocuments(active.id)); if (documentId === doc.id) setDocumentId(""); refresh(); } }}>×</button></div>)}{!documents.length && <div className="knowledge-empty">还没有文档，添加一段文本开始。</div>}</div>
      <div className="segment-panel"><h3>分段预览 <span>{segments.length}</span></h3>{segments.map((segment) => <article className="segment-card" key={segment.id}><header><span>#{segment.position}</span><span>{segment.word_count} 字 · 命中 {segment.hit_count}</span><button onClick={async () => { await api.enableSegment(segment.id, !segment.enabled); setSegments(await api.listSegments(segment.document_id)); }}>{segment.enabled ? "启用" : "停用"}</button></header><textarea value={segment.content} rows={5} onChange={(event) => setSegments((items) => items.map((item) => item.id === segment.id ? { ...item, content: event.target.value } : item))} onBlur={async () => { await api.updateSegment(segment.id, segment.content); }} /></article>)}{!documentId && <div className="knowledge-empty">选择文档查看和编辑分段</div>}</div>
      <aside className="retrieval-panel"><div className="inspector-title"><span>TEST</span><h3>召回测试</h3></div><p>输入问题，检查当前知识库能否返回正确片段。</p><textarea rows={5} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入检索问题" /><button className="primary wide" onClick={retrieve} disabled={!query.trim()}>测试检索</button>{duration !== null && <small>{results.length} 条结果 · {duration} ms</small>}{results.map((result) => <article className="retrieval-result" key={result.segment_id}><header><strong>{result.document_name}</strong><span>{result.score.toFixed(4)}</span></header><p>{result.content}</p></article>)}</aside>
    </div>
    {modal === "document" && <div className="modal-backdrop"><form className="modal document-modal" onSubmit={addDocument}><div className="modal-head"><div><h3>添加文本</h3><p>系统会按段落自动切分并建立索引</p></div><button type="button" onClick={() => setModal(null)}>×</button></div><label>文档名称</label><input name="name" required placeholder="例如：产品介绍" /><label>文本内容</label><textarea name="content" rows={12} required placeholder="粘贴需要检索的文本…" /><div className="chunk-note">自动分段：最多 1200 字符 · 重叠 150 字符</div><button className="primary wide">处理并添加</button></form></div>}
  </section>;
}
