"""总结接口测试（方案第 32 节）。"""

import asyncio
from collections.abc import AsyncIterator

import pytest
from fastapi.testclient import TestClient

from app.api.v1.deps import get_llm_client, get_summary_llm_client
from app.clients.base import ChatMessage, Completion, LLMError
from app.clients.mock import MOCK_SUMMARY_PREFIX, MockLLMClient
from app.main import app
from app.prompts.summary import (
    MAX_ARTICLE_CHARS,
    SUMMARY_PROMPT_VERSION,
    MIN_ARTICLE_CHARS,
    build_summary_system_prompt,
    build_summary_user_prompt,
)
from app.schemas.summary import MAX_POINTS, SummaryRequest, SummaryResponse
from app.services.summary_service import SummaryFailedError, SummaryService

SUMMARY_URL = "/api/v1/summary"

ARTICLE = (
    "Streaming lets each paragraph render as soon as it arrives instead of waiting for the "
    "whole batch. This changes how failures behave: a mid-stream error produces a partial "
    "result plus an error rather than a clean failure. The retry payload is then filtered "
    "down to the items that have not been delivered yet."
)


class ScriptedLLMClient:
    """返回预设文本的替身，用于覆盖各种畸形输出。"""

    model_name = "scripted"

    def __init__(self, raw: str) -> None:
        self._raw = raw

    async def complete(self, messages: list[ChatMessage], *, json_mode: bool = False) -> str:
        return self._raw

    async def complete_with_usage(
        self, messages: list[ChatMessage], *, json_mode: bool = False
    ) -> Completion:
        return Completion(text=self._raw)

    def complete_stream(
        self, messages: list[ChatMessage], *, json_mode: bool = False
    ) -> AsyncIterator[str]:
        raise NotImplementedError


class FailingLLMClient:
    model_name = "failing"

    async def complete(self, messages: list[ChatMessage], *, json_mode: bool = False) -> str:
        raise LLMError("上游不可用", retryable=True)

    def complete_stream(
        self, messages: list[ChatMessage], *, json_mode: bool = False
    ) -> AsyncIterator[str]:
        raise LLMError("上游不可用", retryable=True)

    async def complete_with_usage(
        self, messages: list[ChatMessage], *, json_mode: bool = False
    ) -> Completion:
        """接口新增方法后替身必须跟上——否则调用方直接 AttributeError。"""
        text = await self.complete(messages, json_mode=json_mode)
        return Completion(text=text)


def build_client(client: object | None = None) -> TestClient:
    # 总结走的是**专用客户端**（模型可单独配），与翻译不是同一个依赖，
    # 所以两个都要覆盖——只覆盖一个，另一个会去连真实 Provider
    stub = client or MockLLMClient()
    app.dependency_overrides[get_llm_client] = lambda: stub
    app.dependency_overrides[get_summary_llm_client] = lambda: stub
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_overrides():
    yield
    app.dependency_overrides.clear()


def payload(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {"text": ARTICLE, "title": "Why Streaming Matters"}
    base.update(overrides)
    return base


def summarize(raw: str) -> SummaryResponse:
    service = SummaryService(ScriptedLLMClient(raw))
    request = SummaryRequest.model_validate(payload())

    return asyncio.run(service.summarize(request))



class TestSummaryEndpoint:
    def test_正常返回_gist_与_points(self) -> None:
        response = build_client().post(SUMMARY_URL, json=payload())

        assert response.status_code == 200
        body = response.json()
        assert body["gist"].startswith(MOCK_SUMMARY_PREFIX)
        assert len(body["points"]) == 3
        # 版本号跟着 Prompt 走——改了 Prompt 就要升版本（缓存键含它）
        assert body["prompt_version"] == SUMMARY_PROMPT_VERSION
        assert body["model"]

    def test_不带标题也能总结(self) -> None:
        response = build_client().post(SUMMARY_URL, json={"text": ARTICLE})

        assert response.status_code == 200
        assert response.json()["gist"].startswith(MOCK_SUMMARY_PREFIX)

    def test_正文过短返回_422(self) -> None:
        response = build_client().post(SUMMARY_URL, json={"text": "x" * (MIN_ARTICLE_CHARS - 1)})

        assert response.status_code == 422

    def test_正文过长返回_422(self) -> None:
        response = build_client().post(SUMMARY_URL, json={"text": "x" * (MAX_ARTICLE_CHARS + 1)})

        assert response.status_code == 422

    def test_缺少正文返回_422(self) -> None:
        assert build_client().post(SUMMARY_URL, json={}).status_code == 422

    def test_语言为空时回落默认(self) -> None:
        response = build_client().post(SUMMARY_URL, json=payload(language="   "))

        assert response.status_code == 200

    def test_上游失败返回_502(self) -> None:
        response = build_client(FailingLLMClient()).post(SUMMARY_URL, json=payload())

        assert response.status_code == 502
        assert "上游不可用" in response.json()["detail"]

    def test_与翻译和解释互不影响(self) -> None:
        client = build_client()

        summarized = client.post(SUMMARY_URL, json=payload())
        explained = client.post("/api/v1/explain", json={"selection": "RAG"})
        translated = client.post(
            "/api/v1/translate",
            json={"target_language": "zh-CN", "items": [{"id": "b1", "text": "Hello."}]},
        )

        assert "gist" in summarized.json()
        assert "explanation" in explained.json()
        assert "items" in translated.json()


class TestSummaryParsing:
    """模型输出畸形时的行为。

    与翻译不同：总结是给人看的，**少一条要点比整次失败好得多**。
    所以只有 `gist` 缺失才报错，`points` 里的问题一律丢弃。
    """

    def test_缺少_gist_报错(self) -> None:
        with pytest.raises(SummaryFailedError, match="gist"):
            summarize('{"points": ["a"]}')

    def test_gist_为空白报错(self) -> None:
        with pytest.raises(SummaryFailedError, match="gist"):
            summarize('{"gist": "   ", "points": []}')

    def test_非法_json_报错(self) -> None:
        with pytest.raises(SummaryFailedError, match="JSON"):
            summarize("抱歉，我无法完成这个请求。")

    def test_顶层不是对象报错(self) -> None:
        with pytest.raises(SummaryFailedError, match="对象"):
            summarize('["gist", "points"]')

    def test_points_缺失时返回空数组(self) -> None:
        result = summarize('{"gist": "一句话"}')

        assert result.gist == "一句话"
        assert result.points == []

    def test_points_不是数组时返回空数组(self) -> None:
        result = summarize('{"gist": "一句话", "points": "不是数组"}')

        assert result.points == []

    def test_points_里的非字符串被丢弃(self) -> None:
        result = summarize('{"gist": "一句话", "points": ["好的", 42, null, "  ", "也行"]}')

        assert result.points == ["好的", "也行"]

    def test_points_超量时截断(self) -> None:
        raw = '{"gist": "一句话", "points": [' + ",".join(f'"p{i}"' for i in range(30)) + "]}"

        result = summarize(raw)

        assert len(result.points) == MAX_POINTS

    def test_gist_两端空白被去掉(self) -> None:
        assert summarize('{"gist": "  一句话  "}').gist == "一句话"


class TestSummaryPrompts:
    def test_system_prompt_填入目标语言(self) -> None:
        prompt = build_summary_system_prompt("ja")

        assert "ja" in prompt
        assert "{language}" not in prompt

    def test_system_prompt_要求区分主旨与要点(self) -> None:
        prompt = build_summary_system_prompt("zh-CN")

        assert "gist" in prompt
        assert "points" in prompt

    def test_user_prompt_包住正文(self) -> None:
        prompt = build_summary_user_prompt(text="正文内容")

        assert "<article>" in prompt
        assert "正文内容" in prompt

    def test_user_prompt_带标题(self) -> None:
        prompt = build_summary_user_prompt(text="正文", title="标题")

        assert "<title>" in prompt
        assert "标题" in prompt

    def test_空白标题不产生空标签(self) -> None:
        prompt = build_summary_user_prompt(text="正文", title="   ")

        assert "<title>" not in prompt

    def test_超长正文被截断(self) -> None:
        prompt = build_summary_user_prompt(text="x" * (MAX_ARTICLE_CHARS + 5000))

        assert len(prompt) < MAX_ARTICLE_CHARS + 200


class TestMockSummary:
    def test_mock_总结结构合法(self) -> None:
        client = MockLLMClient()
        messages = [
            ChatMessage(role="system", content="whatever"),
            ChatMessage(role="user", content="<article>Some article text.</article>"),
        ]

        raw = asyncio.run(client.complete(messages, json_mode=True))

        import json

        parsed = json.loads(raw)
        assert parsed["gist"].startswith(MOCK_SUMMARY_PREFIX)
        assert isinstance(parsed["points"], list)

    def test_没有_article_时仍走翻译路径(self) -> None:
        """回归防线：加了 summary 分支后，翻译路径不能被误判。"""
        client = MockLLMClient()
        messages = [
            ChatMessage(role="system", content="whatever"),
            ChatMessage(role="user", content='<items>\n[{"id":"b1","text":"Hello."}]\n</items>'),
        ]

        raw = asyncio.run(client.complete(messages))

        assert "translations" in raw
        assert MOCK_SUMMARY_PREFIX not in raw
