# -*- coding: utf-8 -*-
"""RAG 服务：统一编排 Embedding / Milvus / 检索，供上传与对话路由复用。"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from loguru import logger

from app.config import get_settings
from app.infrastructure.llm.embeddings import DashScopeEmbeddings
from app.infrastructure.vectordb.milvus_client import MilvusManager
from app.infrastructure.vectordb.milvus_rag import MilvusRAGClient
from app.models.schemas import RetrievalResult


@lru_cache
def get_milvus_manager() -> MilvusManager:
    settings = get_settings()
    return MilvusManager(
        host=settings.milvus_host,
        port=str(settings.milvus_port),
    )


@lru_cache
def get_embeddings() -> DashScopeEmbeddings:
    return DashScopeEmbeddings()


@lru_cache
def get_rag_client() -> MilvusRAGClient:
    settings = get_settings()
    return MilvusRAGClient(
        manager=get_milvus_manager(),
        collection_name=settings.milvus_collection_name,
    )


async def ensure_rag_ready() -> int | None:
    """确保 Milvus 集合就绪；返回向量维度。失败则返回 None（不阻塞核心链路）。"""
    try:
        emb = get_embeddings()
        client = get_rag_client()
        await client.ensure_ready(emb.dimension)
        return emb.dimension
    except Exception as exc:
        logger.warning("RAG 初始化失败（检索功能不可用）: {}", exc)
        return None


async def index_chunks(
    chunks: list[str],
    *,
    doc_id: str,
) -> list[str] | None:
    """将文本分块向量化并写入 Milvus，返回向量主键列表。失败返回 None。"""
    if not chunks:
        return None
    try:
        emb = get_embeddings()
        vectors = await emb.aembed_documents(chunks)
        metadata = [
            {"id": f"{doc_id}-{i}", "text": text, "doc_id": doc_id}
            for i, text in enumerate(chunks)
        ]
        client = get_rag_client()
        ids = await client.insert_vectors(vectors, metadata)
        logger.info("已写入 Milvus 向量 doc_id={} chunks={}", doc_id, len(chunks))
        return ids
    except Exception as exc:
        logger.warning("文档向量入库失败 doc_id={}: {}", doc_id, exc)
        return None


async def retrieve_context(
    query: str,
    top_k: int = 5,
    mode: str = "hybrid",
) -> list[RetrievalResult]:
    """执行向量检索，返回相关分块。失败返回空列表（不阻塞对话）。"""
    try:
        from app.core.rag.retriever import MultiRetriever

        retriever = MultiRetriever(
            milvus_client=get_rag_client(),
            embedding_model=get_embeddings(),
        )
        results = await retriever.retrieve(query, top_k=top_k, mode=mode)
        logger.info(
            "RAG 检索 mode={} query_len={} hits={}",
            mode,
            len(query),
            len(results),
        )
        return results
    except Exception as exc:
        logger.warning("RAG 检索失败（本轮不携带上下文）: {}", exc)
        return []
