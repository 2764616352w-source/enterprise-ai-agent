# -*- coding: utf-8 -*-
"""Milvus RAG 检索客户端包装：将 MilvusManager 封装为 MultiRetriever 兼容对象。

``MultiRetriever._search_milvus`` 期望 ``milvus_client.search`` 返回一组 hit 对象，
每个 hit 具有 ``entity``（含 ``text``/``id`` 字段与 ``to_dict()``）、``distance`` 与 ``id`` 属性。
本模块提供该契约，同时复用 ``MilvusManager`` 的连接与索引管理。
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from app.infrastructure.vectordb.milvus_client import MilvusManager


class _Entity(dict):
    """映射字段的实体对象，兼容 dict.get 与 to_dict()。"""

    def to_dict(self) -> dict[str, Any]:
        return dict(self)


class _Hit:
    """单条检索命中，暴露 entity/distance/id 属性。"""

    def __init__(self, entity: dict[str, Any], distance: float, hit_id: str) -> None:
        self._entity = _Entity(entity)
        self._distance = distance
        self._id = hit_id

    @property
    def entity(self) -> _Entity:
        return self._entity

    @property
    def distance(self) -> float:
        return self._distance

    @property
    def id(self) -> str:
        return self._id


class MilvusRAGClient:
    """MultiRetriever 兼容的 Milvus 检索客户端。"""

    anns_field: str = "embedding"
    text_field: str = "text"
    id_field: str = "id"

    def __init__(
        self,
        manager: MilvusManager,
        collection_name: str,
        *,
        metric_type: str = "L2",
        nprobe: int = 16,
    ) -> None:
        self._manager = manager
        self._collection = collection_name
        self._metric_type = metric_type
        self._nprobe = nprobe

    async def ensure_ready(self, dim: int) -> None:
        """确保已连接且集合存在（幂等）。"""
        await self._manager.create_collection(self._collection, dim)

    async def insert_vectors(
        self,
        vectors: list[list[float]],
        metadata: list[dict[str, Any]],
    ) -> list[str]:
        """写入向量与元数据，返回主键列表。"""
        return await self._manager.insert(self._collection, vectors, metadata)

    def search(
        self,
        data: list[list[float]],
        anns_field: str = "embedding",
        param: dict[str, Any] | None = None,
        limit: int = 10,
        output_fields: list[str] | None = None,
        **kwargs: Any,
    ) -> list[list[_Hit]]:
        """同步检索并返回 MultiRetriever 期望的 hit 列表格式。

        注意：MultiRetriever 在 ``asyncio.to_thread`` 中调用本方法（无线程内事件循环），
        故此处用 ``asyncio.run`` 驱动内部异步检索，避免跨线程事件循环冲突。
        """
        import asyncio

        params = param or {"metric_type": self._metric_type, "params": {"nprobe": self._nprobe}}
        rows = asyncio.run(
            self._manager.search(
                self._collection,
                data[0],
                top_k=limit,
                params=params,
            )
        )
        hits = [
            _Hit(
                entity={"id": r.get("id", ""), "text": r.get("text", ""), "doc_id": r.get("doc_id", "")},
                distance=r.get("distance", 0.0),
                hit_id=str(r.get("id", "")),
            )
            for r in rows
        ]
        return [hits]
