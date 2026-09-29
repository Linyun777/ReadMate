"""流式翻译测试（方案第 86.9 节）。"""

import asyncio
import json
from collections.abc import Coroutine
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api.v1.translate import get_llm_client
from app.clients.mock import MOCK_PREFIX, MockLLMClient
from app.core.config import MockMode
from app.main import app
from app.prompts.translation import PROMPT_VERSION
from app.schemas.translation import TranslateRequest
from app.services.translation_service import StreamEvent, TranslationService

STREAM_URL = "/api/v1/translate/stream"


def build_client(mode: MockMode = "ok") -> TestClient:
    app.dependency_overrides[get_llm_client] = lambda: MockLLMClient(mode=mode)
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_overrides():
    yield
    app.dependency_overrides.clear()


def make_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "target_language": "zh-CN",
        "items": [
            {"id": "block-001", "text": "First paragraph."},
            {"id": "block-002", "text": "Read the <0>documentation</0> first."},
            {"id": "block-003", "text": "Third paragraph."},
        ],
    }
    payload.update(overrides)
    return payload


def parse_ndjson(body: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in body.splitlines() if line.strip()]


def run(coro: Coroutine[Any, Any, Any]) -> Any:
    """在同步测试里跑协程，避免依赖 pytest-asyncio 的配置。"""
    return asyncio.run(coro)


class TestTranslateStreamService:
    """服务层：逐条下发 + 最终权威校验。"""

    def collect(self, payload: dict[str, Any]) -> list[StreamEvent]:
        service = TranslationService(MockLLMClient())
        request = TranslateRequest.model_validate(payload)

        async def drain() -> list[StreamEvent]:
            return [event async for event in service.translate_stream(request)]

        return run(drain())

    def test_逐条下发后以_done_结束(self) -> None:
        events = self.collect(make_payload())

        assert [event.type for event in events] == ["item", "item", "item", "done"]

    def test_每个条目都是完整的(self) -> None:
        events = self.collect(make_payload())
        items = [event.item for event in events if event.type == "item"]

        assert [item.id for item in items if item] == ["block-001", "block-002", "block-003"]
        assert all(item.translation.startswith(MOCK_PREFIX) for item in items if item)

    def test_done_事件带_prompt_版本与模型名(self) -> None:
        events = self.collect(make_payload())
        done = events[-1]

        assert done.type == "done"
        assert done.prompt_version == PROMPT_VERSION
        assert done.model == "mock"

    def test_占位符损坏的条目不下发_最终报错(self) -> None:
        """宁可整批失败，也不下发结构损坏的条目。"""
        service = TranslationService(MockLLMClient(mode="drop-placeholder"))
        request = TranslateRequest.model_validate(make_payload())

        async def drain() -> list[StreamEvent]:
            return [event async for event in service.translate_stream(request)]

        events = run(drain())

        # block-002 的占位符被破坏 → 不下发
        delivered = [event.item.id for event in events if event.type == "item"]
        assert "block-002" not in delivered

        # 最终权威校验发现 id 缺失 → error
        assert events[-1].type == "error"
        assert "block-002" in (events[-1].reason or "")

    def test_缺_id_时最终报错(self) -> None:
        service = TranslationService(MockLLMClient(mode="missing-id"))
        request = TranslateRequest.model_validate(make_payload())

        async def drain() -> list[StreamEvent]:
            return [event async for event in service.translate_stream(request)]

        events = run(drain())

        assert events[-1].type == "error"
        assert "block-003" in (events[-1].reason or "")

    def test_重复_id_时最终报错(self) -> None:
        """与非流式路径保持一致：重复 id 视为结构异常，整批失败。"""
        service = TranslationService(MockLLMClient(mode="duplicate-id"))
        request = TranslateRequest.model_validate(make_payload())

        async def drain() -> list[StreamEvent]:
            return [event async for event in service.translate_stream(request)]

        events = run(drain())

        assert events[-1].type == "error"
        assert "重复" in (events[-1].reason or "")

    def test_非法_json_输出下发_error(self) -> None:
        service = TranslationService(MockLLMClient(mode="invalid-json"))
        request = TranslateRequest.model_validate(make_payload())

        async def drain() -> list[StreamEvent]:
            return [event async for event in service.translate_stream(request)]

        events = run(drain())

        # 没有任何完整条目 → 最终校验报缺 id
        assert [event.type for event in events] == ["error"]


class TestTranslateStreamEndpoint:
    def test_返回_ndjson(self) -> None:
        response = build_client().post(STREAM_URL, json=make_payload())

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        assert response.headers["cache-control"] == "no-store"

    def test_事件序列正确(self) -> None:
        response = build_client().post(STREAM_URL, json=make_payload())
        events = parse_ndjson(response.text)

        assert [event["type"] for event in events] == ["item", "item", "item", "done"]
        assert [event["id"] for event in events if event["type"] == "item"] == [
            "block-001",
            "block-002",
            "block-003",
        ]

    def test_每行都是合法_json(self) -> None:
        response = build_client().post(STREAM_URL, json=make_payload())

        for line in response.text.splitlines():
            if line.strip():
                assert isinstance(json.loads(line), dict)

    def test_条目带_source_与_translation(self) -> None:
        response = build_client().post(STREAM_URL, json=make_payload())
        events = parse_ndjson(response.text)
        first = events[0]

        assert first["source"] == "First paragraph."
        assert first["translation"] == f"{MOCK_PREFIX}First paragraph."

    def test_占位符在流式输出中保留(self) -> None:
        response = build_client().post(STREAM_URL, json=make_payload())
        events = parse_ndjson(response.text)
        second = next(event for event in events if event.get("id") == "block-002")

        assert "<0>documentation</0>" in second["translation"]

    def test_失败时下发_error_行(self) -> None:
        response = build_client("missing-id").post(STREAM_URL, json=make_payload())
        events = parse_ndjson(response.text)

        assert events[-1]["type"] == "error"
        assert "block-003" in events[-1]["reason"]

    def test_请求体非法时返回_422(self) -> None:
        response = build_client().post(STREAM_URL, json={"items": []})

        assert response.status_code == 422
