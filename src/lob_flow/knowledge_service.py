from __future__ import annotations

import json
import hashlib
import math
import re
from time import monotonic
from uuid import uuid4

from lob_flow.database import Database
from lob_flow.models import (
    Dataset,
    DatasetCreate,
    DatasetDocument,
    DocumentCreate,
    DocumentSegment,
    RetrievalRequest,
    RetrievalResponse,
    RetrievalResult,
    SegmentUpdate,
)
from lob_flow.service import NotFoundError, now


class KnowledgeService:
    EMBEDDING_MODEL = "lob-hash-embedding-v1"
    EMBEDDING_DIMENSION = 256

    def __init__(self, database: Database) -> None:
        self.database = database

    def create_dataset(self, workspace_id: str, request: DatasetCreate) -> Dataset:
        dataset_id, timestamp = str(uuid4()), now()
        with self.database.connect() as connection:
            if connection.execute("SELECT 1 FROM workspaces WHERE id = %s", (workspace_id,)).fetchone() is None:
                raise NotFoundError(f"Workspace {workspace_id} not found")
            connection.execute(
                """INSERT INTO datasets
                   (id, workspace_id, name, description, icon, search_method, top_k,
                    score_threshold, embedding_model, embedding_dimension, vector_weight,
                    created_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (dataset_id, workspace_id, request.name.strip(), request.description.strip(), request.icon,
                 request.search_method, request.top_k, request.score_threshold, self.EMBEDDING_MODEL,
                 self.EMBEDDING_DIMENSION, request.vector_weight, timestamp.isoformat(), timestamp.isoformat()),
            )
        return self.get_dataset(dataset_id)

    def list_datasets(self, workspace_id: str) -> list[Dataset]:
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT d.*, COUNT(DISTINCT doc.id) AS document_count,
                          COUNT(seg.id) AS segment_count
                   FROM datasets d
                   LEFT JOIN dataset_documents doc ON doc.dataset_id = d.id
                   LEFT JOIN document_segments seg ON seg.document_id = doc.id
                   WHERE d.workspace_id = %s
                   GROUP BY d.id ORDER BY d.updated_at DESC""", (workspace_id,),
            ).fetchall()
        return [Dataset(**dict(row)) for row in rows]

    def get_dataset(self, dataset_id: str) -> Dataset:
        with self.database.connect() as connection:
            row = connection.execute(
                """SELECT d.*, COUNT(DISTINCT doc.id) AS document_count,
                          COUNT(seg.id) AS segment_count
                   FROM datasets d
                   LEFT JOIN dataset_documents doc ON doc.dataset_id = d.id
                   LEFT JOIN document_segments seg ON seg.document_id = doc.id
                   WHERE d.id = %s GROUP BY d.id""", (dataset_id,),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Dataset {dataset_id} not found")
        return Dataset(**dict(row))

    def delete_dataset(self, dataset_id: str) -> None:
        with self.database.connect() as connection:
            result = connection.execute("DELETE FROM datasets WHERE id = %s", (dataset_id,))
            if result.rowcount == 0:
                raise NotFoundError(f"Dataset {dataset_id} not found")

    def add_document(self, dataset_id: str, request: DocumentCreate) -> DatasetDocument:
        self.get_dataset(dataset_id)
        document_id, timestamp = str(uuid4()), now()
        segments = self._chunk(request.content.strip(), request.separator, request.max_chars, request.overlap)
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO dataset_documents
                   (id, dataset_id, name, content, status, word_count, segment_count,
                    metadata_json, created_at, updated_at) VALUES (%s, %s, %s, %s, 'ready', %s, %s, %s, %s, %s)""",
                (document_id, dataset_id, request.name.strip(), request.content.strip(), self._word_count(request.content),
                 len(segments), json.dumps(request.metadata, ensure_ascii=False), timestamp.isoformat(), timestamp.isoformat()),
            )
            for position, content in enumerate(segments, 1):
                connection.execute(
                    """INSERT INTO document_segments
                       (id, dataset_id, document_id, position, content, word_count,
                        token_count, keywords_json, embedding_json, embedding_model,
                        created_at, updated_at)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (str(uuid4()), dataset_id, document_id, position, content, self._word_count(content),
                     self._token_count(content), json.dumps(self._keywords(content), ensure_ascii=False),
                     json.dumps(self._embed(content)), self.EMBEDDING_MODEL, timestamp.isoformat(), timestamp.isoformat()),
                )
            connection.execute("UPDATE datasets SET updated_at = %s WHERE id = %s", (timestamp.isoformat(), dataset_id))
        return self._get_document(document_id)

    def list_documents(self, dataset_id: str) -> list[DatasetDocument]:
        self.get_dataset(dataset_id)
        with self.database.connect() as connection:
            rows = connection.execute("SELECT * FROM dataset_documents WHERE dataset_id = %s ORDER BY created_at DESC", (dataset_id,)).fetchall()
        return [self._document(row) for row in rows]

    def set_document_enabled(self, document_id: str, enabled: bool) -> DatasetDocument:
        with self.database.connect() as connection:
            row = connection.execute("UPDATE dataset_documents SET enabled = %s, updated_at = %s WHERE id = %s RETURNING *", (enabled, now().isoformat(), document_id)).fetchone()
        if row is None:
            raise NotFoundError(f"Document {document_id} not found")
        return self._document(row)

    def delete_document(self, document_id: str) -> None:
        with self.database.connect() as connection:
            row = connection.execute("DELETE FROM dataset_documents WHERE id = %s RETURNING dataset_id", (document_id,)).fetchone()
            if row is None:
                raise NotFoundError(f"Document {document_id} not found")
            connection.execute("UPDATE datasets SET updated_at = %s WHERE id = %s", (now().isoformat(), row["dataset_id"]))

    def list_segments(self, document_id: str) -> list[DocumentSegment]:
        self._get_document(document_id)
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT s.*, d.name AS document_name, d.metadata_json FROM document_segments s
                   JOIN dataset_documents d ON d.id = s.document_id
                   WHERE s.document_id = %s ORDER BY s.position""", (document_id,),
            ).fetchall()
        return [self._segment(row) for row in rows]

    def update_segment(self, segment_id: str, request: SegmentUpdate) -> DocumentSegment:
        content, timestamp = request.content.strip(), now().isoformat()
        with self.database.connect() as connection:
            row = connection.execute(
                """UPDATE document_segments SET content = %s, word_count = %s,
                   token_count = %s, keywords_json = %s, embedding_json = %s,
                   embedding_model = %s, updated_at = %s WHERE id = %s
                   RETURNING *""",
                (content, self._word_count(content), self._token_count(content),
                 json.dumps(self._keywords(content), ensure_ascii=False), json.dumps(self._embed(content)),
                 self.EMBEDDING_MODEL, timestamp, segment_id),
            ).fetchone()
            if row is not None:
                document = connection.execute("SELECT name, metadata_json FROM dataset_documents WHERE id = %s", (row["document_id"],)).fetchone()
        if row is None:
            raise NotFoundError(f"Segment {segment_id} not found")
        values = dict(row); values["document_name"] = document["name"]; values["metadata_json"] = document["metadata_json"]
        return self._segment(values)

    def set_segment_enabled(self, segment_id: str, enabled: bool) -> DocumentSegment:
        with self.database.connect() as connection:
            row = connection.execute("UPDATE document_segments SET enabled = %s, updated_at = %s WHERE id = %s RETURNING *", (enabled, now().isoformat(), segment_id)).fetchone()
            if row is not None:
                document = connection.execute("SELECT name, metadata_json FROM dataset_documents WHERE id = %s", (row["document_id"],)).fetchone()
        if row is None:
            raise NotFoundError(f"Segment {segment_id} not found")
        values = dict(row); values["document_name"] = document["name"]; values["metadata_json"] = document["metadata_json"]
        return self._segment(values)

    def retrieve(self, dataset_id: str, request: RetrievalRequest) -> RetrievalResponse:
        started = monotonic()
        dataset = self.get_dataset(dataset_id)
        top_k = request.top_k or dataset.top_k
        threshold = dataset.score_threshold if request.score_threshold is None else request.score_threshold
        search_method = request.search_method or dataset.search_method
        vector_weight = dataset.vector_weight if request.vector_weight is None else request.vector_weight
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT s.*, d.name AS document_name, d.metadata_json FROM document_segments s
                   JOIN dataset_documents d ON d.id = s.document_id
                   WHERE s.dataset_id = %s AND s.enabled = TRUE AND d.enabled = TRUE""", (dataset_id,),
            ).fetchall()
        rows = [row for row in rows if self._matches_metadata(json.loads(row["metadata_json"] or "{}"), request.metadata_filter)]
        query_embedding = self._embed(request.query)
        scored = []
        missing_embeddings: list[tuple[str, list[float]]] = []
        for row in rows:
            keyword_score = self._score(request.query, row["content"])
            embedding = json.loads(row["embedding_json"]) if row.get("embedding_json") else self._embed(row["content"])
            if not row.get("embedding_json"):
                missing_embeddings.append((row["id"], embedding))
            vector_score = max(0.0, self._cosine(query_embedding, embedding))
            if search_method == "keyword_search":
                score = keyword_score
            elif search_method == "vector_search":
                score = vector_score
            else:
                score = vector_score * vector_weight + keyword_score * (1 - vector_weight)
            scored.append((score, keyword_score, vector_score, row))
        scored.sort(key=lambda item: item[0], reverse=True)
        results = [RetrievalResult(
            segment_id=row["id"], document_id=row["document_id"], document_name=row["document_name"],
            content=row["content"], position=row["position"], score=round(score, 4),
            keyword_score=round(keyword_score, 4), vector_score=round(vector_score, 4),
            metadata=json.loads(row["metadata_json"] or "{}"),
        ) for score, keyword_score, vector_score, row in scored[:top_k] if score >= threshold and score > 0]
        duration = int((monotonic() - started) * 1000)
        with self.database.connect() as connection:
            for segment_id, embedding in missing_embeddings:
                connection.execute(
                    "UPDATE document_segments SET embedding_json = %s, embedding_model = %s WHERE id = %s",
                    (json.dumps(embedding), self.EMBEDDING_MODEL, segment_id),
                )
            if results:
                connection.execute("UPDATE document_segments SET hit_count = hit_count + 1 WHERE id = ANY(%s)", ([item.segment_id for item in results],))
            connection.execute(
                """INSERT INTO dataset_queries
                   (id, dataset_id, query, results_json, duration_ms, search_method,
                    metadata_filter_json, created_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                (str(uuid4()), dataset_id, request.query, json.dumps([item.model_dump() for item in results], ensure_ascii=False),
                 duration, search_method, json.dumps([item.model_dump() for item in request.metadata_filter], ensure_ascii=False), now().isoformat()),
            )
        return RetrievalResponse(query=request.query, results=results, duration_ms=duration, search_method=search_method, embedding_model=dataset.embedding_model)

    def _get_document(self, document_id: str) -> DatasetDocument:
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM dataset_documents WHERE id = %s", (document_id,)).fetchone()
        if row is None:
            raise NotFoundError(f"Document {document_id} not found")
        return self._document(row)

    @staticmethod
    def _document(row: dict) -> DatasetDocument:
        values = dict(row); values.pop("content", None); values["metadata"] = json.loads(values.pop("metadata_json", "{}") or "{}")
        return DatasetDocument(**values)

    @staticmethod
    def _segment(row: dict) -> DocumentSegment:
        values = dict(row); values["keywords"] = json.loads(values.pop("keywords_json")); values["metadata"] = json.loads(values.pop("metadata_json", "{}") or "{}")
        values.pop("embedding_json", None)
        return DocumentSegment(**values)

    @classmethod
    def _embed(cls, text: str) -> list[float]:
        """Create a deterministic multilingual feature-hash embedding without external services."""
        normalized = re.sub(r"\s+", " ", text.lower().strip())
        latin = re.findall(r"[a-z0-9_]+", normalized)
        chinese = re.findall(r"[\u4e00-\u9fff]", normalized)
        features = [*latin, *chinese, *("".join(chinese[index:index + 2]) for index in range(len(chinese) - 1))]
        vector = [0.0] * cls.EMBEDDING_DIMENSION
        for feature in features:
            digest = hashlib.sha256(feature.encode("utf-8")).digest()
            index = int.from_bytes(digest[:4], "big") % cls.EMBEDDING_DIMENSION
            vector[index] += 1.0 if digest[4] & 1 else -1.0
        norm = math.sqrt(sum(value * value for value in vector))
        return [round(value / norm, 8) for value in vector] if norm else vector

    @staticmethod
    def _cosine(left: list[float], right: list[float]) -> float:
        return sum(a * b for a, b in zip(left, right))

    @staticmethod
    def _matches_metadata(metadata: dict, conditions: list) -> bool:
        for condition in conditions:
            current = metadata
            for part in condition.key.split("."):
                if not isinstance(current, dict) or part not in current:
                    current = None
                    break
                current = current[part]
            if condition.operator == "exists":
                matched = current is not None
            elif condition.operator == "equals":
                matched = current == condition.value
            elif condition.operator == "not_equals":
                matched = current != condition.value
            elif condition.operator == "contains":
                matched = condition.value in current if isinstance(current, (str, list)) else False
            else:
                matched = current in condition.value if isinstance(condition.value, list) else False
            if not matched:
                return False
        return True

    @classmethod
    def _chunk(cls, text: str, separator: str, max_chars: int, overlap: int) -> list[str]:
        parts = [part.strip() for part in text.split(separator) if part.strip()] if separator else [text]
        chunks: list[str] = []
        current = ""
        for part in parts:
            if len(part) > max_chars:
                if current: chunks.append(current); current = ""
                step = max(1, max_chars - overlap)
                chunks.extend(part[index:index + max_chars] for index in range(0, len(part), step) if part[index:index + max_chars])
            elif not current:
                current = part
            elif len(current) + len(separator) + len(part) <= max_chars:
                current += separator + part
            else:
                chunks.append(current)
                prefix = current[-overlap:] if overlap else ""
                current = (prefix + separator + part).strip() if prefix else part
        if current: chunks.append(current)
        return chunks or [text]

    @staticmethod
    def _word_count(text: str) -> int:
        return len(re.findall(r"[\u4e00-\u9fff]|[A-Za-z0-9_]+", text))

    @staticmethod
    def _token_count(text: str) -> int:
        return max(1, (len(text) + 3) // 4)

    @staticmethod
    def _keywords(text: str) -> list[str]:
        return list(dict.fromkeys(re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,8}", text.lower())))[:20]

    @staticmethod
    def _score(query: str, content: str) -> float:
        def grams(value: str) -> set[str]:
            normalized = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", value.lower())
            return {normalized[i:i + 2] for i in range(max(0, len(normalized) - 1))}
        query_normalized, content_normalized = query.lower().strip(), content.lower()
        q, c = grams(query), grams(content)
        overlap = len(q & c) / max(1, len(q))
        substring = 1.0 if query_normalized in content_normalized else 0.0
        terms = re.findall(r"[a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}", query_normalized)
        term_score = sum(1 for term in terms if term in content_normalized) / max(1, len(terms))
        return min(1.0, overlap * 0.7 + substring * 0.2 + term_score * 0.1)
