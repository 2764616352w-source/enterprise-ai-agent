# -*- coding: utf-8 -*-
"""对话 API：非流式与流式输出。"""

from __future__ import annotations

import json
import uuid
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from loguru import logger
from openai import AsyncOpenAI

from app.config import get_settings
from app.core.intent.recognizer import IntentRecognizer
from app.core.rag.service import retrieve_context
from app.infrastructure.llm.model_router import ModelConfig, ModelRouter
from app.infrastructure.trace.tracer import Tracer
from app.models.schemas import ChatRequest, ChatResponse, RetrievalResult

router = APIRouter(tags=["chat"])

_tracer = Tracer()
_intent = IntentRecognizer()


def _build_router() -> ModelRouter:
    """根据配置构造模型路由器。"""
    settings = get_settings()
    if not settings.openai_api_key:
        raise HTTPException(status_code=503, detail="未配置 OPENAI_API_KEY，无法调用模型")
    cfg = ModelConfig(
        model_id=settings.openai_model,
        api_key=settings.openai_api_key,
        base_url=settings.openai_api_base or None,
        priority=0,
        weight=1.0,
    )
    return ModelRouter([cfg])


def _build_messages(
    messages: list[dict],
    contexts: list[RetrievalResult],
) -> list[dict]:
    """将检索上下文拼接进 messages；无上下文则原样返回。"""
    if not contexts:
        return messages
    ctx_lines = []
    for i, c in enumerate(contexts, start=1):
        ctx_lines.append(f"[{i}] (id={c.id})\n{c.content}")
    context_block = "\n\n".join(ctx_lines)
    rag_system = (
        "你是企业知识助手。请优先依据下方「检索上下文」作答，并在引用处标注 [编号]。"
        "若上下文不足以回答，请如实说明。\n\n"
        f"## 检索上下文\n{context_block}"
    )
    out = [{"role": "system", "content": rag_system}]
    # 去掉已有 system 消息，保留 user/assistant 历史
    for m in messages:
        if m.get("role") == "system":
            continue
        out.append(m)
    return out


def _contexts_to_raw(contexts: list[RetrievalResult]) -> list[RetrievalResult]:
    """返回可直接序列化的检索上下文（供 raw_contexts）。"""
    return contexts


def _extract_citations(
    answer: str,
    contexts: list[RetrievalResult],
) -> list[dict[str, object]]:
    """从回答解析 [n] 引用并映射到检索结果。"""
    import re

    refs = [int(x) for x in re.findall(r"\[(\d+)\]", answer)]
    seen: set[int] = set()
    citations: list[dict[str, object]] = []
    for idx in refs:
        if idx in seen or idx < 1 or idx > len(contexts):
            continue
        seen.add(idx)
        c = contexts[idx - 1]
        citations.append(
            {
                "index": idx,
                "result_id": c.id,
                "snippet": (c.content[:200] + ("..." if len(c.content) > 200 else "")),
            }
        )
    return citations


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    """非流式对话：经意图识别与链路追踪后返回完整回复。"""
    trace_id = str(uuid.uuid4())
    span = _tracer.start_trace(trace_id, "chat")

    try:
        user_text = request.messages[-1].content if request.messages else ""
        intent = await _intent.recognize(user_text)
        clarify = await _intent.clarify(user_text, intent)
        logger.info(
            "意图 intent={} conf={} sub={}",
            intent.intent,
            intent.confidence,
            intent.sub_intent,
        )

        router_llm = _build_router()
        messages = [m.model_dump() for m in request.messages]

        # RAG 检索（失败降级为空上下文，不阻断对话）
        contexts = await retrieve_context(user_text, top_k=5, mode="hybrid")
        messages = _build_messages(messages, contexts)

        if clarify and intent.confidence < _intent.confidence_threshold:
            messages.append(
                {
                    "role": "system",
                    "content": f"（系统提示：{clarify}）",
                }
            )

        resp = await router_llm.chat(
            messages,
            model_preference=request.model,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )

        citations = _extract_citations(resp.content, contexts)

        _tracer.end_span(
            span,
            result={
                "model": resp.model_id,
                "usage": resp.usage,
                "retrieve_hits": len(contexts),
            },
        )

        return ChatResponse(
            id=str(uuid.uuid4()),
            model=resp.model_id,
            content=resp.content,
            trace_id=trace_id,
            usage=resp.usage,
            citations=citations,
            raw_contexts=_contexts_to_raw(contexts),
            retrieve_mode="hybrid" if contexts else None,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("chat 失败: {}", exc)
        _tracer.end_span(span, error=str(exc))
        raise HTTPException(status_code=500, detail=f"对话失败: {exc!s}") from exc


async def _stream_generator(
    request: ChatRequest,
    trace_id: str,
) -> AsyncIterator[bytes]:
    """SSE 风格流：每行 data: {json}\\n\\n。"""
    settings = get_settings()
    if not settings.openai_api_key:
        yield b"data: " + json.dumps({"error": "未配置 API Key"}, ensure_ascii=False).encode() + b"\n\n"
        return

    client = AsyncOpenAI(
        api_key=settings.openai_api_key,
        base_url=settings.openai_api_base or None,
    )
    messages = [m.model_dump() for m in request.messages] or []
    user_text = messages[-1].get("content", "") if messages else ""
    contexts = await retrieve_context(user_text, top_k=5, mode="hybrid")
    messages = _build_messages(messages, contexts)
    model = request.model or settings.openai_model

    try:
        stream = await client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            stream=True,
        )
        acc = ""
        async for chunk in stream:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta:
                acc += delta
                payload = {"content": delta, "trace_id": trace_id}
                yield b"data: " + json.dumps(payload, ensure_ascii=False).encode() + b"\n\n"
        citations = _extract_citations(acc, contexts)
        raw = _contexts_to_raw(contexts)
        payload = {
            "done": True,
            "trace_id": trace_id,
            "retrieve_mode": "hybrid" if contexts else None,
            "citations": citations,
            "raw_contexts": [c.model_dump() for c in raw],
        }
        yield b"data: " + json.dumps(payload, ensure_ascii=False).encode() + b"\n\n"
    except Exception as exc:
        logger.exception("chat_stream 失败: {}", exc)
        yield b"data: " + json.dumps({"error": str(exc)}, ensure_ascii=False).encode() + b"\n\n"


@router.post("/chat/stream")
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    """流式输出（Server-Sent Events 兼容格式）。"""
    trace_id = str(uuid.uuid4())
    span = _tracer.start_trace(trace_id, "chat_stream")
    _tracer.end_span(span, result={"mode": "stream"})

    return StreamingResponse(
        _stream_generator(request, trace_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Trace-Id": trace_id,
        },
    )
