from __future__ import annotations

from datetime import datetime, timezone
from html.parser import HTMLParser
from io import BytesIO
import json
import re
import zipfile
from collections import Counter
from typing import Any
from xml.etree import ElementTree as ET

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.db.utils import new_id
from app.models.character import Character
from app.models.chapter import Chapter
from app.models.knowledge_base import KnowledgeBase
from app.models.llm_preset import LLMPreset
from app.models.outline import Outline
from app.models.project import Project
from app.models.project_membership import ProjectMembership
from app.models.project_source_document import ProjectSourceDocument, ProjectSourceDocumentChunk
from app.models.project_settings import ProjectSettings
from app.models.prompt_block import PromptBlock
from app.models.prompt_preset import PromptPreset
from app.models.story_memory import StoryMemory
from app.models.structured_memory import MemoryEntity, MemoryEvent, MemoryEvidence, MemoryForeshadow, MemoryRelation
from app.models.worldbook_entry import WorldBookEntry
from app.services.vector_embedding_overrides import vector_embedding_overrides
from app.services.vector_rag_service import VectorChunk, ingest_chunks, purge_project_vectors


_TOKEN_RE = re.compile(r"[A-Za-z0-9\u4e00-\u9fff]{2,}")

MAX_IMPORT_BYTES = 5_000_000
MAX_IMPORT_CHARS = 5_000_000
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
EPUB_MIME = "application/epub+zip"


class _HtmlTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"br"}:
            self._push_break()
            return
        if tag in {"p", "div", "section", "article", "header", "footer", "aside", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self._push_block()
        if tag in {"li"}:
            self._push_block()
            self._parts.append("- ")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"p", "div", "section", "article", "header", "footer", "aside", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self._push_block()
        if tag in {"li", "ul", "ol"}:
            self._push_block()

    def handle_data(self, data: str) -> None:
        if not data:
            return
        self._parts.append(data)

    def _push_break(self) -> None:
        if not self._parts:
            self._parts.append("\n")
            return
        if self._parts[-1].endswith("\n"):
            return
        self._parts.append("\n")

    def _push_block(self) -> None:
        if not self._parts:
            self._parts.append("\n\n")
            return
        tail = self._parts[-1]
        if tail.endswith("\n\n"):
            return
        if tail.endswith("\n"):
            self._parts.append("\n")
            return
        self._parts.append("\n\n")

    def get_text(self) -> str:
        return "".join(self._parts)


def _normalize_import_text(text: str) -> str:
    if not text:
        return ""
    s = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.strip() for line in s.split("\n")]
    out: list[str] = []
    empty_run = 0
    for line in lines:
        if not line:
            empty_run += 1
            if empty_run > 1:
                continue
            out.append("")
            continue
        empty_run = 0
        out.append(line)
    return "\n".join(out).strip()


def normalize_import_content_type(filename: str, content_type: str | None) -> str:
    name = str(filename or "").lower()
    raw = str(content_type or "").strip().lower()

    if raw in {"md", "markdown", "text/markdown"} or name.endswith((".md", ".markdown")):
        return "md"
    if raw in {"docx", DOCX_MIME} or name.endswith(".docx"):
        return "docx"
    if raw in {"epub", EPUB_MIME} or name.endswith(".epub"):
        return "epub"
    if raw in {"txt", "text/plain"} or name.endswith(".txt"):
        return "txt"
    if raw.startswith("text/"):
        return "txt"
    return "txt"


def _extract_docx_text(data: bytes) -> str:
    with zipfile.ZipFile(BytesIO(data)) as zf:
        xml_bytes: bytes | None = None
        for candidate in ("word/document.xml", "word/document2.xml"):
            try:
                xml_bytes = zf.read(candidate)
                break
            except KeyError:
                continue
        if xml_bytes is None:
            for name in zf.namelist():
                if name.lower().endswith("document.xml") and name.lower().startswith("word/"):
                    xml_bytes = zf.read(name)
                    break
        if xml_bytes is None:
            return ""

    root = ET.fromstring(xml_bytes)
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paras: list[str] = []
    for p in root.findall(".//w:p", ns):
        parts: list[str] = []
        for node in p.iter():
            tag = node.tag
            if tag == f"{{{ns['w']}}}t":
                parts.append(node.text or "")
            elif tag == f"{{{ns['w']}}}tab":
                parts.append("\t")
            elif tag in {f"{{{ns['w']}}}br", f"{{{ns['w']}}}cr"}:
                parts.append("\n")
        joined = "".join(parts).strip()
        if joined:
            paras.append(joined)
    return "\n\n".join(paras)


def _extract_epub_text(data: bytes) -> str:
    with zipfile.ZipFile(BytesIO(data)) as zf:
        html_files = [
            name
            for name in zf.namelist()
            if name.lower().endswith((".xhtml", ".html", ".htm")) and not name.lower().startswith("meta-inf/")
        ]
        html_files = [name for name in html_files if "toc" not in name.lower() and "nav" not in name.lower()]
        parts: list[str] = []
        for name in sorted(html_files):
            raw = zf.read(name)
            try:
                text = raw.decode("utf-8", errors="ignore")
            except Exception:
                text = raw.decode(errors="ignore")
            parser = _HtmlTextExtractor()
            parser.feed(text)
            extracted = _normalize_import_text(parser.get_text())
            if extracted:
                parts.append(extracted)
        return "\n\n".join(parts)


def extract_import_text(filename: str, content_type: str | None, data: bytes) -> tuple[str, str]:
    kind = normalize_import_content_type(filename, content_type)
    if kind in {"docx", "epub"}:
        try:
            if kind == "docx":
                text = _extract_docx_text(data)
            else:
                text = _extract_epub_text(data)
        except Exception:
            return "", kind
        text = _normalize_import_text(text)
    else:
        try:
            text = data.decode("utf-8", errors="ignore")
        except Exception:
            text = data.decode(errors="ignore")

    if not text.strip():
        return "", kind

    if len(text) > MAX_IMPORT_CHARS:
        text = text[:MAX_IMPORT_CHARS]
    return text, kind


def _chunk_text(text: str, *, chunk_size: int, overlap: int) -> list[str]:
    s = (text or "").strip()
    if not s:
        return []
    if chunk_size <= 0:
        return [s]

    out: list[str] = []
    start = 0
    overlap = max(0, min(int(overlap), int(chunk_size) - 1)) if chunk_size > 1 else 0
    while start < len(s):
        end = min(len(s), start + chunk_size)
        piece = s[start:end].strip()
        if piece:
            out.append(piece)
        if end >= len(s):
            break
        start = max(0, end - overlap)
    return out


def _base_filename(name: str) -> str:
    raw = str(name or "").strip()
    if not raw:
        return "import"
    if "." in raw:
        raw = raw.rsplit(".", 1)[0]
    raw = raw.strip()
    return raw[:80] if raw else "import"


def _extract_keywords(text: str, *, limit: int) -> list[str]:
    tokens = [t.lower() for t in _TOKEN_RE.findall(text or "") if t]
    if not tokens:
        return []
    counts = Counter(tokens)
    out: list[str] = []
    for token, _ in counts.most_common(max(1, int(limit)) * 3):
        if len(out) >= int(limit):
            break
        if token in {"the", "and", "that", "with", "this", "from", "were", "have", "has"}:
            continue
        out.append(token[:64])
    return out


def _build_worldbook_proposal(*, filename: str, content_text: str) -> dict[str, Any]:
    title = _base_filename(filename)[:255]
    summary = (content_text or "").strip()
    if len(summary) > 5000:
        summary = summary[:5000].rstrip() + "…"
    keywords = _extract_keywords(f"{filename}\n{content_text}", limit=12)

    entry = {
        "title": title,
        "content_md": f"## 导入摘要\n\n{summary}".strip(),
        "enabled": True,
        "constant": False,
        "keywords": keywords,
        "exclude_recursion": False,
        "prevent_recursion": False,
        "char_limit": 12000,
        "priority": "important",
    }
    return {"schema_version": "worldbook_export_all_v1", "entries": [entry]}


def _build_story_memory_proposal(*, filename: str, content_text: str) -> dict[str, Any]:
    title = _base_filename(filename)[:255]
    summary = (content_text or "").strip()
    if len(summary) > 800:
        summary = summary[:800].rstrip() + "…"
    return {
        "schema_version": "story_memory_import_v1",
        "memories": [
            {
                "memory_type": "import_summary",
                "title": title,
                "content": summary,
                "importance_score": 0.6,
                "story_timeline": 0,
                "is_foreshadow": 0,
            }
        ],
    }


def run_import_task(task_id: str) -> None:
    """
    ProjectSourceDocument import worker.

    The task_id is the ProjectSourceDocument.id (so it can be scheduled via TaskQueue without a separate task table).
    """

    doc_id = str(task_id or "").strip()
    if not doc_id:
        return

    db = SessionLocal()
    try:
        doc = db.get(ProjectSourceDocument, doc_id)
        if doc is None:
            return

        project_id = str(doc.project_id)
        filename = str(doc.filename or "").strip()
        content_text = str(doc.content_text or "")

        doc.status = "running"
        doc.progress = 0
        doc.progress_message = "切分文本..."
        doc.error_message = None
        db.commit()

        chunk_size = int(getattr(settings, "vector_chunk_size", 800) or 800)
        overlap = int(getattr(settings, "vector_chunk_overlap", 120) or 120)
        chunks = _chunk_text(content_text, chunk_size=chunk_size, overlap=overlap)

        db.execute(delete(ProjectSourceDocumentChunk).where(ProjectSourceDocumentChunk.document_id == doc_id))
        db.flush()

        rows: list[ProjectSourceDocumentChunk] = []
        vector_chunks: list[VectorChunk] = []
        for idx, chunk in enumerate(chunks):
            vector_chunk_id = f"source_doc:{doc_id}:{idx}"
            rows.append(
                ProjectSourceDocumentChunk(
                    id=new_id(),
                    document_id=doc_id,
                    chunk_index=int(idx),
                    content_text=chunk,
                    vector_chunk_id=vector_chunk_id,
                )
            )
            vector_chunks.append(
                VectorChunk(
                    id=vector_chunk_id,
                    text=chunk,
                    metadata={
                        "project_id": project_id,
                        # NOTE: reuse existing VectorSource label to avoid protocol breakage.
                        "source": "chapter",
                        "source_id": doc_id,
                        "title": filename,
                        "chunk_index": int(idx),
                    },
                )
            )

        if rows:
            db.add_all(rows)

        doc.chunk_count = int(len(chunks))
        doc.progress = 35
        doc.progress_message = f"已切分 {len(chunks)} 个 chunk"

        worldbook_proposal = _build_worldbook_proposal(filename=filename, content_text=content_text)
        story_memory_proposal = _build_story_memory_proposal(filename=filename, content_text=content_text)
        doc.worldbook_proposal_json = json.dumps(worldbook_proposal, ensure_ascii=False)
        doc.story_memory_proposal_json = json.dumps(story_memory_proposal, ensure_ascii=False)

        embedding = vector_embedding_overrides(db.get(ProjectSettings, project_id))
        kb_id = str(doc.kb_id or "").strip() or None

        db.commit()
    except Exception as exc:
        try:
            doc = db.get(ProjectSourceDocument, doc_id)
            if doc is not None:
                doc.status = "failed"
                doc.progress_message = "导入失败"
                doc.error_message = f"{type(exc).__name__}"
                db.commit()
        except Exception:
            pass
        return
    finally:
        db.close()

    # external calls (embedding/vector) must happen without holding DB transactions.
    ingest_result: dict[str, Any] = {}
    try:
        ingest_result = ingest_chunks(project_id=project_id, kb_id=kb_id, chunks=vector_chunks, embedding=embedding)
    except Exception as exc:
        ingest_result = {"enabled": False, "skipped": True, "disabled_reason": "error", "error_type": type(exc).__name__}

    db2 = SessionLocal()
    try:
        doc2 = db2.get(ProjectSourceDocument, doc_id)
        if doc2 is None:
            return
        doc2.vector_ingest_result_json = json.dumps(ingest_result, ensure_ascii=False)
        doc2.progress = 100
        doc2.progress_message = "完成"
        doc2.status = "done"
        db2.commit()
    finally:
        db2.close()


def retry_import_task(*, project_id: str, document_id: str) -> dict[str, Any]:
    """
    Best-effort cleanup for retries:
    - delete previous chunks
    - purge vectors for the document kb_id (if any)
    """

    doc_id = str(document_id or "").strip()
    if not doc_id:
        return {"ok": False, "reason": "document_id_missing"}

    kb_id: str | None = None
    db = SessionLocal()
    try:
        doc = db.get(ProjectSourceDocument, doc_id)
        if doc is None or str(doc.project_id) != str(project_id):
            return {"ok": False, "reason": "not_found"}
        kb_id = str(doc.kb_id or "").strip() or None

        doc.status = "queued"
        doc.progress = 0
        doc.progress_message = "queued"
        doc.error_message = None
        doc.vector_ingest_result_json = None
        db.execute(delete(ProjectSourceDocumentChunk).where(ProjectSourceDocumentChunk.document_id == doc_id))
        db.commit()
    finally:
        db.close()

    purge_out: dict[str, Any] = {}
    if kb_id:
        try:
            purge_out = purge_project_vectors(project_id=str(project_id), kb_id=kb_id)
        except Exception as exc:
            purge_out = {"enabled": True, "skipped": True, "deleted": False, "error_type": type(exc).__name__}

    return {"ok": True, "purge": purge_out, "kb_id": kb_id}


def _dt_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    dt = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _safe_json_list(raw: str | None) -> list:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except Exception:
        return []
    return value if isinstance(value, list) else []


def _safe_json_dict(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def export_project_bundle(db: Session, *, project_id: str) -> dict[str, Any]:
    project_id_norm = str(project_id or "").strip()
    project = db.get(Project, project_id_norm)
    if project is None:
        return {"schema_version": "project_bundle_v1", "error": "project_not_found"}

    settings_row = db.get(ProjectSettings, project_id_norm)
    llm_preset = db.get(LLMPreset, project_id_norm)

    outlines = db.execute(select(Outline).where(Outline.project_id == project_id_norm).order_by(Outline.updated_at.desc())).scalars().all()
    chapters = db.execute(select(Chapter).where(Chapter.project_id == project_id_norm).order_by(Chapter.updated_at.desc())).scalars().all()
    characters = (
        db.execute(select(Character).where(Character.project_id == project_id_norm).order_by(Character.updated_at.desc()))
        .scalars()
        .all()
    )

    worldbook_entries = (
        db.execute(select(WorldBookEntry).where(WorldBookEntry.project_id == project_id_norm).order_by(WorldBookEntry.updated_at.desc()))
        .scalars()
        .all()
    )

    prompt_presets = (
        db.execute(select(PromptPreset).where(PromptPreset.project_id == project_id_norm).order_by(PromptPreset.updated_at.desc()))
        .scalars()
        .all()
    )
    blocks_by_preset: dict[str, list[PromptBlock]] = {}
    for preset in prompt_presets:
        blocks = (
            db.execute(select(PromptBlock).where(PromptBlock.preset_id == preset.id).order_by(PromptBlock.injection_order.asc()))
            .scalars()
            .all()
        )
        blocks_by_preset[preset.id] = blocks

    entities = (
        db.execute(
            select(MemoryEntity)
            .where(MemoryEntity.project_id == project_id_norm, MemoryEntity.deleted_at.is_(None))
            .order_by(MemoryEntity.updated_at.desc())
        )
        .scalars()
        .all()
    )
    relations = (
        db.execute(
            select(MemoryRelation)
            .where(MemoryRelation.project_id == project_id_norm, MemoryRelation.deleted_at.is_(None))
            .order_by(MemoryRelation.updated_at.desc())
        )
        .scalars()
        .all()
    )
    events = (
        db.execute(
            select(MemoryEvent).where(MemoryEvent.project_id == project_id_norm, MemoryEvent.deleted_at.is_(None)).order_by(MemoryEvent.updated_at.desc())
        )
        .scalars()
        .all()
    )
    foreshadows = (
        db.execute(
            select(MemoryForeshadow)
            .where(MemoryForeshadow.project_id == project_id_norm, MemoryForeshadow.deleted_at.is_(None))
            .order_by(MemoryForeshadow.updated_at.desc())
        )
        .scalars()
        .all()
    )
    evidence = (
        db.execute(
            select(MemoryEvidence)
            .where(MemoryEvidence.project_id == project_id_norm, MemoryEvidence.deleted_at.is_(None))
            .order_by(MemoryEvidence.created_at.desc())
        )
        .scalars()
        .all()
    )

    story_memories = (
        db.execute(select(StoryMemory).where(StoryMemory.project_id == project_id_norm).order_by(StoryMemory.updated_at.desc()))
        .scalars()
        .all()
    )

    knowledge_bases = (
        db.execute(select(KnowledgeBase).where(KnowledgeBase.project_id == project_id_norm).order_by(KnowledgeBase.order_index.asc()))
        .scalars()
        .all()
    )

    source_docs = (
        db.execute(select(ProjectSourceDocument).where(ProjectSourceDocument.project_id == project_id_norm).order_by(ProjectSourceDocument.updated_at.desc()))
        .scalars()
        .all()
    )

    return {
        "schema_version": "project_bundle_v1",
        "exported_at": _dt_iso(getattr(project, "updated_at", None)),
        "project": {
            "id": project.id,
            "name": project.name,
            "genre": project.genre,
            "logline": project.logline,
            "active_outline_id": project.active_outline_id,
            "created_at": _dt_iso(getattr(project, "created_at", None)),
            "updated_at": _dt_iso(getattr(project, "updated_at", None)),
        },
        "settings": {
            "world_setting": (settings_row.world_setting if settings_row else "") or "",
            "style_guide": (settings_row.style_guide if settings_row else "") or "",
            "constraints": (settings_row.constraints if settings_row else "") or "",
            "vector_embedding": {
                "provider": getattr(settings_row, "vector_embedding_provider", None) if settings_row else None,
                "base_url": getattr(settings_row, "vector_embedding_base_url", None) if settings_row else None,
                "model": getattr(settings_row, "vector_embedding_model", None) if settings_row else None,
                "azure_deployment": getattr(settings_row, "vector_embedding_azure_deployment", None) if settings_row else None,
                "azure_api_version": getattr(settings_row, "vector_embedding_azure_api_version", None) if settings_row else None,
                "sentence_transformers_model": getattr(settings_row, "vector_embedding_sentence_transformers_model", None) if settings_row else None,
                "has_api_key": bool(getattr(settings_row, "vector_embedding_api_key_ciphertext", None) or "") if settings_row else False,
                "masked_api_key": getattr(settings_row, "vector_embedding_api_key_masked", None) if settings_row else "",
            },
            "vector_rerank": {
                "enabled": getattr(settings_row, "vector_rerank_enabled", None) if settings_row else None,
                "method": getattr(settings_row, "vector_rerank_method", None) if settings_row else None,
                "top_k": getattr(settings_row, "vector_rerank_top_k", None) if settings_row else None,
            },
            "query_preprocessing_json": getattr(settings_row, "query_preprocessing_json", None) if settings_row else None,
            "context_optimizer_enabled": bool(getattr(settings_row, "context_optimizer_enabled", False)) if settings_row else False,
        },
        "llm_preset": (
            {
                "provider": llm_preset.provider,
                "base_url": llm_preset.base_url,
                "model": llm_preset.model,
                "temperature": llm_preset.temperature,
                "top_p": llm_preset.top_p,
                "max_tokens": llm_preset.max_tokens,
                "presence_penalty": llm_preset.presence_penalty,
                "frequency_penalty": llm_preset.frequency_penalty,
                "top_k": llm_preset.top_k,
                "stop_json": llm_preset.stop_json,
                "timeout_seconds": llm_preset.timeout_seconds,
            }
            if llm_preset is not None
            else None
        ),
        "outlines": [
            {
                "id": o.id,
                "title": o.title,
                "content_md": o.content_md,
                "structure_json": o.structure_json,
                "created_at": _dt_iso(getattr(o, "created_at", None)),
                "updated_at": _dt_iso(getattr(o, "updated_at", None)),
            }
            for o in outlines
        ],
        "chapters": [
            {
                "id": ch.id,
                "outline_id": ch.outline_id,
                "number": ch.number,
                "title": ch.title,
                "plan": ch.plan,
                "content_md": ch.content_md,
                "summary": ch.summary,
                "status": ch.status,
                "updated_at": _dt_iso(getattr(ch, "updated_at", None)),
            }
            for ch in chapters
        ],
        "characters": [{"id": c.id, "name": c.name, "role": c.role, "profile": c.profile, "notes": c.notes} for c in characters],
        "worldbook": {
            "schema_version": "worldbook_export_all_v1",
            "entries": [
                {
                    "title": e.title,
                    "content_md": e.content_md,
                    "enabled": bool(e.enabled),
                    "constant": bool(e.constant),
                    "keywords": _safe_json_list(e.keywords_json),
                    "exclude_recursion": bool(e.exclude_recursion),
                    "prevent_recursion": bool(e.prevent_recursion),
                    "char_limit": int(e.char_limit),
                    "priority": str(e.priority or "important"),
                }
                for e in worldbook_entries
            ],
        },
        "prompt_presets": {
            "schema_version": "prompt_presets_export_all_v1",
            "presets": [
                {
                    "preset": {
                        "name": p.name,
                        "category": p.category,
                        "scope": p.scope,
                        "version": p.version,
                        "resource_key": p.resource_key,
                        "active_for": _safe_json_list(p.active_for_json),
                    },
                    "blocks": [
                        {
                            "identifier": b.identifier,
                            "name": b.name,
                            "role": b.role,
                            "enabled": bool(b.enabled),
                            "template": b.template,
                            "marker_key": b.marker_key,
                            "injection_position": b.injection_position,
                            "injection_depth": b.injection_depth,
                            "injection_order": b.injection_order,
                            "triggers": _safe_json_list(b.triggers_json),
                            "forbid_overrides": bool(b.forbid_overrides),
                            "budget": _safe_json_dict(b.budget_json),
                            "cache": _safe_json_dict(b.cache_json),
                        }
                        for b in (blocks_by_preset.get(p.id) or [])
                    ],
                }
                for p in prompt_presets
            ],
        },
        "structured_memory": {
            "schema_version": "structured_memory_export_v1",
            "entities": [
                {
                    "id": e.id,
                    "entity_type": e.entity_type,
                    "name": e.name,
                    "summary_md": e.summary_md,
                    "attributes_json": e.attributes_json,
                }
                for e in entities
            ],
            "relations": [
                {
                    "id": r.id,
                    "from_entity_id": r.from_entity_id,
                    "to_entity_id": r.to_entity_id,
                    "relation_type": r.relation_type,
                    "description_md": r.description_md,
                    "attributes_json": r.attributes_json,
                }
                for r in relations
            ],
            "events": [
                {
                    "id": e.id,
                    "chapter_id": e.chapter_id,
                    "event_type": e.event_type,
                    "title": e.title,
                    "content_md": e.content_md,
                    "attributes_json": e.attributes_json,
                }
                for e in events
            ],
            "foreshadows": [
                {
                    "id": f.id,
                    "chapter_id": f.chapter_id,
                    "resolved_at_chapter_id": f.resolved_at_chapter_id,
                    "title": f.title,
                    "content_md": f.content_md,
                    "resolved": int(f.resolved),
                    "attributes_json": f.attributes_json,
                }
                for f in foreshadows
            ],
            "evidence": [
                {
                    "id": ev.id,
                    "source_type": ev.source_type,
                    "source_id": ev.source_id,
                    "quote_md": ev.quote_md,
                    "attributes_json": ev.attributes_json,
                }
                for ev in evidence
            ],
        },
        "story_memory": {
            "schema_version": "story_memory_export_v1",
            "memories": [
                {
                    "id": m.id,
                    "chapter_id": m.chapter_id,
                    "memory_type": m.memory_type,
                    "title": m.title,
                    "content": m.content,
                    "full_context_md": m.full_context_md,
                    "importance_score": float(m.importance_score),
                    "tags_json": m.tags_json,
                    "story_timeline": int(m.story_timeline),
                    "text_position": int(m.text_position),
                    "text_length": int(m.text_length),
                    "is_foreshadow": int(m.is_foreshadow),
                    "foreshadow_resolved_at_chapter_id": m.foreshadow_resolved_at_chapter_id,
                    "metadata_json": m.metadata_json,
                }
                for m in story_memories
            ],
        },
        "knowledge_bases": {
            "schema_version": "knowledge_bases_export_v1",
            "kbs": [
                {
                    "kb_id": kb.kb_id,
                    "name": kb.name,
                    "enabled": bool(kb.enabled),
                    "weight": float(kb.weight),
                    "order": int(kb.order_index),
                    "priority_group": str(getattr(kb, "priority_group", "normal") or "normal"),
                }
                for kb in knowledge_bases
            ],
        },
        "source_documents": {
            "schema_version": "project_source_documents_export_v1",
            "docs": [
                {
                    "id": d.id,
                    "filename": d.filename,
                    "content_type": d.content_type,
                    "content_text": d.content_text,
                    "kb_id": d.kb_id,
                    "worldbook_proposal_json": d.worldbook_proposal_json,
                    "story_memory_proposal_json": d.story_memory_proposal_json,
                }
                for d in source_docs
            ],
        },
    }


def import_project_bundle(
    db: Session,
    *,
    owner_user_id: str,
    bundle: dict[str, Any],
    rebuild_vectors: bool = False,
) -> dict[str, Any]:
    schema = str(bundle.get("schema_version") or "").strip()
    if schema != "project_bundle_v1":
        return {"ok": False, "reason": "unsupported_schema_version", "schema_version": schema}

    project_in = bundle.get("project")
    project_obj = project_in if isinstance(project_in, dict) else {}
    name = str(project_obj.get("name") or "").strip() or "Imported Project"
    genre = str(project_obj.get("genre") or "").strip() or None
    logline = str(project_obj.get("logline") or "").strip() or None
    active_outline_id = str(project_obj.get("active_outline_id") or "").strip() or None

    new_project_id = new_id()
    db.add(Project(id=new_project_id, owner_user_id=str(owner_user_id), name=name[:255], genre=genre, logline=logline))
    db.add(ProjectMembership(project_id=new_project_id, user_id=str(owner_user_id), role="owner"))
    db.flush()

    report: dict[str, Any] = {"created": {}, "warnings": []}

    settings_in = bundle.get("settings")
    settings_obj = settings_in if isinstance(settings_in, dict) else {}
    settings_row = ProjectSettings(project_id=new_project_id)
    settings_row.world_setting = str(settings_obj.get("world_setting") or "") or None
    settings_row.style_guide = str(settings_obj.get("style_guide") or "") or None
    settings_row.constraints = str(settings_obj.get("constraints") or "") or None

    embedding_in = settings_obj.get("vector_embedding")
    embedding_obj = embedding_in if isinstance(embedding_in, dict) else {}
    settings_row.vector_embedding_provider = str(embedding_obj.get("provider") or "") or None
    settings_row.vector_embedding_base_url = str(embedding_obj.get("base_url") or "") or None
    settings_row.vector_embedding_model = str(embedding_obj.get("model") or "") or None
    settings_row.vector_embedding_azure_deployment = str(embedding_obj.get("azure_deployment") or "") or None
    settings_row.vector_embedding_azure_api_version = str(embedding_obj.get("azure_api_version") or "") or None
    settings_row.vector_embedding_sentence_transformers_model = str(embedding_obj.get("sentence_transformers_model") or "") or None

    has_key = bool(embedding_obj.get("has_api_key"))
    settings_row.vector_embedding_api_key_ciphertext = None
    settings_row.vector_embedding_api_key_masked = str(embedding_obj.get("masked_api_key") or "") if has_key else None
    if has_key:
        report["warnings"].append("api_key_not_imported")

    rerank_in = settings_obj.get("vector_rerank")
    rerank_obj = rerank_in if isinstance(rerank_in, dict) else {}
    settings_row.vector_rerank_enabled = rerank_obj.get("enabled")
    settings_row.vector_rerank_method = str(rerank_obj.get("method") or "") or None
    settings_row.vector_rerank_top_k = int(rerank_obj.get("top_k")) if isinstance(rerank_obj.get("top_k"), int) else None

    settings_row.query_preprocessing_json = str(settings_obj.get("query_preprocessing_json") or "") or None
    settings_row.context_optimizer_enabled = bool(settings_obj.get("context_optimizer_enabled", False))

    db.add(settings_row)
    report["created"]["project_settings"] = 1

    llm_in = bundle.get("llm_preset")
    llm_obj = llm_in if isinstance(llm_in, dict) else {}
    if llm_obj:
        db.add(
            LLMPreset(
                project_id=new_project_id,
                provider=str(llm_obj.get("provider") or "openai"),
                base_url=str(llm_obj.get("base_url") or "") or None,
                model=str(llm_obj.get("model") or "gpt-4o-mini"),
                temperature=llm_obj.get("temperature"),
                top_p=llm_obj.get("top_p"),
                max_tokens=llm_obj.get("max_tokens"),
                presence_penalty=llm_obj.get("presence_penalty"),
                frequency_penalty=llm_obj.get("frequency_penalty"),
                top_k=llm_obj.get("top_k"),
                stop_json=str(llm_obj.get("stop_json") or "") or None,
                timeout_seconds=llm_obj.get("timeout_seconds"),
            )
        )
        report["created"]["llm_preset"] = 1

    outline_id_map: dict[str, str] = {}
    outlines_in = bundle.get("outlines")
    outlines_list = outlines_in if isinstance(outlines_in, list) else []
    for o in outlines_list:
        if not isinstance(o, dict):
            continue
        old_id = str(o.get("id") or "").strip()
        new_outline_id = new_id()
        outline_id_map[old_id] = new_outline_id
        db.add(
            Outline(
                id=new_outline_id,
                project_id=new_project_id,
                title=str(o.get("title") or "Outline")[:255],
                content_md=str(o.get("content_md") or "") or None,
                structure_json=str(o.get("structure_json") or "") or None,
            )
        )
    report["created"]["outlines"] = len(outline_id_map)

    chapter_id_map: dict[str, str] = {}
    chapters_in = bundle.get("chapters")
    chapters_list = chapters_in if isinstance(chapters_in, list) else []
    for ch in chapters_list:
        if not isinstance(ch, dict):
            continue
        old_id = str(ch.get("id") or "").strip()
        old_outline_id = str(ch.get("outline_id") or "").strip()
        outline_new = outline_id_map.get(old_outline_id)
        if not outline_new:
            continue
        new_ch_id = new_id()
        chapter_id_map[old_id] = new_ch_id
        try:
            number = int(ch.get("number") or 0)
        except Exception:
            number = 0
        db.add(
            Chapter(
                id=new_ch_id,
                project_id=new_project_id,
                outline_id=outline_new,
                number=max(0, int(number)),
                title=str(ch.get("title") or "") or None,
                plan=str(ch.get("plan") or "") or None,
                content_md=str(ch.get("content_md") or "") or None,
                summary=str(ch.get("summary") or "") or None,
                status=str(ch.get("status") or "planned")[:32],
            )
        )
    report["created"]["chapters"] = len(chapter_id_map)

    if active_outline_id:
        mapped = outline_id_map.get(active_outline_id)
        if mapped:
            project_row = db.get(Project, new_project_id)
            if project_row is not None:
                project_row.active_outline_id = mapped

    characters_in = bundle.get("characters")
    characters_list = characters_in if isinstance(characters_in, list) else []
    created_chars = 0
    for c in characters_list:
        if not isinstance(c, dict):
            continue
        created_chars += 1
        db.add(
            Character(
                id=new_id(),
                project_id=new_project_id,
                name=str(c.get("name") or "")[:255] or "角色",
                role=str(c.get("role") or "") or None,
                profile=str(c.get("profile") or "") or None,
                notes=str(c.get("notes") or "") or None,
            )
        )
    report["created"]["characters"] = created_chars

    worldbook_in = bundle.get("worldbook")
    worldbook_obj = worldbook_in if isinstance(worldbook_in, dict) else {}
    entries_in = worldbook_obj.get("entries")
    entries_list = entries_in if isinstance(entries_in, list) else []
    created_entries = 0
    for e in entries_list:
        if not isinstance(e, dict):
            continue
        created_entries += 1
        db.add(
            WorldBookEntry(
                id=new_id(),
                project_id=new_project_id,
                title=str(e.get("title") or "")[:255] or "WorldBook",
                content_md=str(e.get("content_md") or ""),
                enabled=bool(e.get("enabled", True)),
                constant=bool(e.get("constant", False)),
                keywords_json=json.dumps(e.get("keywords") or [], ensure_ascii=False),
                exclude_recursion=bool(e.get("exclude_recursion", False)),
                prevent_recursion=bool(e.get("prevent_recursion", False)),
                char_limit=int(e.get("char_limit") or 12000),
                priority=str(e.get("priority") or "important")[:32],
            )
        )
    report["created"]["worldbook_entries"] = created_entries

    presets_in = bundle.get("prompt_presets")
    presets_obj = presets_in if isinstance(presets_in, dict) else {}
    presets_list = presets_obj.get("presets")
    presets_items = presets_list if isinstance(presets_list, list) else []
    created_presets = 0
    created_blocks = 0
    for item in presets_items:
        if not isinstance(item, dict):
            continue
        preset_in = item.get("preset")
        preset_obj = preset_in if isinstance(preset_in, dict) else {}
        blocks_in = item.get("blocks")
        blocks_list = blocks_in if isinstance(blocks_in, list) else []

        preset_id = new_id()
        created_presets += 1
        db.add(
            PromptPreset(
                id=preset_id,
                project_id=new_project_id,
                name=str(preset_obj.get("name") or "")[:255] or "Preset",
                category=str(preset_obj.get("category") or "")[:64] or None,
                scope=str(preset_obj.get("scope") or "project")[:32] or "project",
                version=int(preset_obj.get("version") or 1),
                resource_key=str(preset_obj.get("resource_key") or "") or None,
                active_for_json=json.dumps(preset_obj.get("active_for") or [], ensure_ascii=False),
            )
        )
        db.flush()

        for b in blocks_list:
            if not isinstance(b, dict):
                continue
            created_blocks += 1
            db.add(
                PromptBlock(
                    id=new_id(),
                    preset_id=preset_id,
                    identifier=str(b.get("identifier") or "")[:255],
                    name=str(b.get("name") or "")[:255],
                    role=str(b.get("role") or "user")[:32],
                    enabled=bool(b.get("enabled", True)),
                    template=str(b.get("template") or ""),
                    marker_key=str(b.get("marker_key") or "") or None,
                    injection_position=str(b.get("injection_position") or "relative")[:32],
                    injection_depth=b.get("injection_depth"),
                    injection_order=int(b.get("injection_order") or 0),
                    triggers_json=json.dumps(b.get("triggers") or [], ensure_ascii=False),
                    forbid_overrides=bool(b.get("forbid_overrides", False)),
                    budget_json=json.dumps(b.get("budget") or {}, ensure_ascii=False) if b.get("budget") is not None else None,
                    cache_json=json.dumps(b.get("cache") or {}, ensure_ascii=False) if b.get("cache") is not None else None,
                )
            )
    report["created"]["prompt_presets"] = created_presets
    report["created"]["prompt_blocks"] = created_blocks

    entity_id_map: dict[str, str] = {}
    sm_in = bundle.get("structured_memory")
    sm_obj = sm_in if isinstance(sm_in, dict) else {}
    entities_list = sm_obj.get("entities")
    for e in (entities_list if isinstance(entities_list, list) else []):
        if not isinstance(e, dict):
            continue
        old_id = str(e.get("id") or "").strip()
        new_entity_id = new_id()
        entity_id_map[old_id] = new_entity_id
        db.add(
            MemoryEntity(
                id=new_entity_id,
                project_id=new_project_id,
                entity_type=str(e.get("entity_type") or "generic")[:64] or "generic",
                name=str(e.get("name") or "")[:255] or "Entity",
                summary_md=str(e.get("summary_md") or "") or None,
                attributes_json=str(e.get("attributes_json") or "") or None,
            )
        )

    created_relations = 0
    relations_list = sm_obj.get("relations")
    for r in (relations_list if isinstance(relations_list, list) else []):
        if not isinstance(r, dict):
            continue
        from_id = entity_id_map.get(str(r.get("from_entity_id") or "").strip())
        to_id = entity_id_map.get(str(r.get("to_entity_id") or "").strip())
        if not from_id or not to_id:
            continue
        created_relations += 1
        db.add(
            MemoryRelation(
                id=new_id(),
                project_id=new_project_id,
                from_entity_id=from_id,
                to_entity_id=to_id,
                relation_type=str(r.get("relation_type") or "related_to")[:64] or "related_to",
                description_md=str(r.get("description_md") or "") or None,
                attributes_json=str(r.get("attributes_json") or "") or None,
            )
        )

    created_events = 0
    events_list = sm_obj.get("events")
    for e in (events_list if isinstance(events_list, list) else []):
        if not isinstance(e, dict):
            continue
        ch_old = str(e.get("chapter_id") or "").strip() or None
        created_events += 1
        db.add(
            MemoryEvent(
                id=new_id(),
                project_id=new_project_id,
                chapter_id=chapter_id_map.get(ch_old) if ch_old else None,
                event_type=str(e.get("event_type") or "event")[:64] or "event",
                title=str(e.get("title") or "")[:255] or None,
                content_md=str(e.get("content_md") or ""),
                attributes_json=str(e.get("attributes_json") or "") or None,
            )
        )

    created_foreshadows = 0
    foreshadows_list = sm_obj.get("foreshadows")
    for f in (foreshadows_list if isinstance(foreshadows_list, list) else []):
        if not isinstance(f, dict):
            continue
        ch_old = str(f.get("chapter_id") or "").strip() or None
        resolved_old = str(f.get("resolved_at_chapter_id") or "").strip() or None
        created_foreshadows += 1
        db.add(
            MemoryForeshadow(
                id=new_id(),
                project_id=new_project_id,
                chapter_id=chapter_id_map.get(ch_old) if ch_old else None,
                resolved_at_chapter_id=chapter_id_map.get(resolved_old) if resolved_old else None,
                title=str(f.get("title") or "")[:255] or None,
                content_md=str(f.get("content_md") or ""),
                resolved=int(f.get("resolved") or 0),
                attributes_json=str(f.get("attributes_json") or "") or None,
            )
        )

    created_evidence = 0
    evidence_list = sm_obj.get("evidence")
    for ev in (evidence_list if isinstance(evidence_list, list) else []):
        if not isinstance(ev, dict):
            continue
        source_type = str(ev.get("source_type") or "unknown")[:32] or "unknown"
        source_id = str(ev.get("source_id") or "").strip() or None
        if source_type == "chapter" and source_id:
            source_id = chapter_id_map.get(source_id) or source_id
        created_evidence += 1
        db.add(
            MemoryEvidence(
                id=new_id(),
                project_id=new_project_id,
                source_type=source_type,
                source_id=source_id,
                quote_md=str(ev.get("quote_md") or ""),
                attributes_json=str(ev.get("attributes_json") or "") or None,
            )
        )

    report["created"]["memory_entities"] = len(entity_id_map)
    report["created"]["memory_relations"] = created_relations
    report["created"]["memory_events"] = created_events
    report["created"]["memory_foreshadows"] = created_foreshadows
    report["created"]["memory_evidence"] = created_evidence

    sm2_in = bundle.get("story_memory")
    sm2_obj = sm2_in if isinstance(sm2_in, dict) else {}
    memories_in = sm2_obj.get("memories")
    memories_list = memories_in if isinstance(memories_in, list) else []
    created_story_memories = 0
    for m in memories_list:
        if not isinstance(m, dict):
            continue
        ch_old = str(m.get("chapter_id") or "").strip() or None
        resolved_old = str(m.get("foreshadow_resolved_at_chapter_id") or "").strip() or None
        created_story_memories += 1
        db.add(
            StoryMemory(
                id=new_id(),
                project_id=new_project_id,
                chapter_id=chapter_id_map.get(ch_old) if ch_old else None,
                memory_type=str(m.get("memory_type") or "note")[:64] or "note",
                title=str(m.get("title") or "")[:255] or None,
                content=str(m.get("content") or ""),
                full_context_md=str(m.get("full_context_md") or "") or None,
                importance_score=float(m.get("importance_score") or 0.0),
                tags_json=str(m.get("tags_json") or "") or None,
                story_timeline=int(m.get("story_timeline") or 0),
                text_position=int(m.get("text_position") or -1),
                text_length=int(m.get("text_length") or 0),
                is_foreshadow=int(m.get("is_foreshadow") or 0),
                foreshadow_resolved_at_chapter_id=chapter_id_map.get(resolved_old) if resolved_old else None,
                metadata_json=str(m.get("metadata_json") or "") or None,
            )
        )
    report["created"]["story_memories"] = created_story_memories

    kb_in = bundle.get("knowledge_bases")
    kb_obj = kb_in if isinstance(kb_in, dict) else {}
    kbs_in = kb_obj.get("kbs")
    kbs_list = kbs_in if isinstance(kbs_in, list) else []
    created_kbs = 0
    for kb in kbs_list:
        if not isinstance(kb, dict):
            continue
        created_kbs += 1
        kb_id = str(kb.get("kb_id") or "").strip() or "default"
        db.add(
            KnowledgeBase(
                id=new_id(),
                project_id=new_project_id,
                kb_id=kb_id[:64],
                name=str(kb.get("name") or kb_id)[:255] or kb_id,
                enabled=bool(kb.get("enabled", True)),
                weight=float(kb.get("weight") or 1.0),
                order_index=int(kb.get("order") or 0),
                priority_group=str(kb.get("priority_group") or "normal")[:16] or "normal",
            )
        )
    report["created"]["knowledge_bases"] = created_kbs

    docs_in = bundle.get("source_documents")
    docs_obj = docs_in if isinstance(docs_in, dict) else {}
    docs_list = docs_obj.get("docs")
    docs_items = docs_list if isinstance(docs_list, list) else []
    created_docs = 0
    for d in docs_items:
        if not isinstance(d, dict):
            continue
        created_docs += 1
        kb_id = str(d.get("kb_id") or "").strip() or None
        db.add(
            ProjectSourceDocument(
                id=new_id(),
                project_id=new_project_id,
                actor_user_id=str(owner_user_id),
                filename=str(d.get("filename") or "")[:255],
                content_type=str(d.get("content_type") or "txt")[:32] or "txt",
                content_text=str(d.get("content_text") or ""),
                status="done",
                progress=100,
                progress_message="imported",
                chunk_count=0,
                kb_id=kb_id[:64] if kb_id else None,
                vector_ingest_result_json=None,
                worldbook_proposal_json=str(d.get("worldbook_proposal_json") or "") or None,
                story_memory_proposal_json=str(d.get("story_memory_proposal_json") or "") or None,
                error_message=None,
            )
        )
    report["created"]["source_documents"] = created_docs

    db.commit()

    from app.services.prompt_presets import ensure_default_chapter_preset, ensure_default_outline_preset
    from app.services.vector_kb_service import ensure_default_kb as ensure_default_vector_kb

    ensure_default_outline_preset(db, project_id=new_project_id, activate=True)
    ensure_default_chapter_preset(db, project_id=new_project_id, activate=True)
    ensure_default_vector_kb(db, project_id=new_project_id)
    db.commit()

    vector_rebuild_result: dict[str, Any] | None = None
    if rebuild_vectors:
        from app.services.vector_rag_service import build_project_chunks, rebuild_project

        db2 = SessionLocal()
        try:
            chunks = build_project_chunks(db=db2, project_id=new_project_id, sources=["worldbook", "outline", "chapter"])
            embedding = vector_embedding_overrides(db2.get(ProjectSettings, new_project_id))
            selected_kbs = [str(k.get("kb_id") or "").strip() for k in kbs_list if isinstance(k, dict)] or ["default"]
        finally:
            db2.close()

        per_kb: dict[str, dict[str, Any]] = {}
        for kid in selected_kbs:
            if not kid:
                continue
            try:
                per_kb[kid] = rebuild_project(project_id=new_project_id, kb_id=kid, chunks=chunks, embedding=embedding)
            except Exception as exc:  # pragma: no cover - env dependent
                per_kb[kid] = {"enabled": False, "skipped": True, "disabled_reason": "error", "error_type": type(exc).__name__}
        vector_rebuild_result = {"kbs": {"selected": selected_kbs, "per_kb": per_kb}}

    return {"ok": True, "project_id": new_project_id, "report": report, "vector_rebuild": vector_rebuild_result}
