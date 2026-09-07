# -*- coding: utf-8 -*-
"""Embedding 适配器：对接 OpenAI 兼容的嵌入接口（默认阿里云 DashScope）。

提供与 LangChain Embeddings 约定兼容的 ``embed_query`` / ``embed_documents``，
供 ``app.core.rag.retriever.MultiRetriever`` 使用。
"""

from __future__ import annotations

import asyncio
from typing import Any

from loguru import logger

from app.config import get_settings


class DashScopeEmbeddings:
    """基于 OpenAI 兼容 ``/embeddings`` 的向量化实现。

    默认使用阿里云百炼（DashScope）的 ``text-embedding-v3``，输出 1024 维。
    若未配置 API Key，则以空向量降级，避免阻塞其它链路。
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        *,
        timeout: float = 30.0,
    ) -> None:
        settings = get_settings()
        self._api_key = api_key or settings.openai_api_key or ""
        self._base_url = base_url or settings.openai_api_base or None
        self._model = model or settings.embedding_model or "text-embedding-v3"
        self._timeout = timeout
        self._async_client: Any = None
        self._sync_client: Any = None

    @property
    def dimension(self) -> int:
        """text-embedding-v3 输出维度（DashScope 固定 1024）。"""
        return 1024

    def _require_key(self) -> None:
        if not self._api_key:
            raise RuntimeError("未配置 OPENAI_API_KEY，无法调用 Embedding 接口")

    def _get_sync_client(self) -> Any:
        if self._sync_client is not None:
            return self._sync_client
        self._require_key()
        from openai import OpenAI

        kwargs: dict[str, Any] = {"api_key": self._api_key, "timeout": self._timeout}
        if self._base_url:
            kwargs["base_url"] = self._base_url
        self._sync_client = OpenAI(**kwargs)
        return self._sync_client

    def _get_async_client(self) -> Any:
        if self._async_client is not None:
            return self._async_client
        self._require_key()
        from openai import AsyncOpenAI

        kwargs: dict[str, Any] = {"api_key": self._api_key, "timeout": self._timeout}
        if self._base_url:
            kwargs["base_url"] = self._base_url
        self._async_client = AsyncOpenAI(**kwargs)
        return self._async_client

    def _normalize(self, data: Any, index_attr: str = "index") -> list[list[float]]:
        """按 index 排序并抽取 embedding 向量。"""
        items = list(data or [])
        items.sort(key=lambda d: getattr(d, index_attr, 0) or 0)
        return [list(getattr(d, "embedding", []) or []) for d in items]

    # ---- 同步实现（供 asyncio.to_thread / 直接调用） ----

    def embed_query(self, text: str) -> list[float]:
        """同步向量化单条查询文本（供 MultiRetriever 的 to_thread 调用）。"""
        client = self._get_sync_client()
        resp = client.embeddings.create(model=self._model, input=[text])
        rows = self._normalize(resp.data)
        return rows[0] if rows else []

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """同步向量化文档列表。"""
        if not texts:
            return []
        client = self._get_sync_client()
        resp = client.embeddings.create(model=self._model, input=texts)
        return self._normalize(resp.data)

    # ---- 异步封装（供 async 上下文调用） ----

    async def aembed_query(self, text: str) -> list[float]:
        """异步向量化单条查询。"""
        return await asyncio.to_thread(self.embed_query, text)

    async def aembed_documents(self, texts: list[str]) -> list[list[float]]:
        """异步向量化文档列表。"""
        return await asyncio.to_thread(self.embed_documents, texts)
