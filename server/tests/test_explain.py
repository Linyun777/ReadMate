"""解释接口测试（方案第 41 节）。"""

from collections.abc import AsyncIterator

import pytest
from fastapi.testclient import TestClient

from app.api.v1.deps import get_llm_client
from app.clients.base import ChatMessage, Completion, LLMError
from app.clients.mock import MOCK_EXPLAIN_PREFIX, MockLLMClient
from app.main import app
from app.prompts.explain import (
    MAX_CONTEXT_CHARS,
    build_explain_system_prompt,
    build_explain_user_prompt,
)

EXPLAIN_URL = "/api/v1/explain"


class FailingLLMClient:
    """总是失败的替身，用于验证 502 路径。"""

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
    app.dependency_overrides[get_llm_client] = lambda: client or MockLLMClient()
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_overrides():
    yield
    app.dependency_overrides.clear()


def payload(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "selection": "high-agency ownership",
        "context": "We look for engineers with high-agency ownership who can drive work.",
        "language": "zh-CN",
    }
    base.update(overrides)
    return base


class TestExplainEndpoint:
    def test_正常返回解释(self) -> None:
        response = build_client().post(EXPLAIN_URL, json=payload())

        assert response.status_code == 200
        body = response.json()
        assert body["explanation"] == f"{MOCK_EXPLAIN_PREFIX}high-agency ownership"
        assert body["prompt_version"] == "v1"
        assert body["model"]

    def test_不带_context_也能解释(self) -> None:
        response = build_client().post(EXPLAIN_URL, json={"selection": "RAG"})

        assert response.status_code == 200
        assert response.json()["explanation"] == f"{MOCK_EXPLAIN_PREFIX}RAG"

    def test_空白_selection_返回_422(self) -> None:
        assert build_client().post(EXPLAIN_URL, json={"selection": "   "}).status_code == 422

    def test_缺少_selection_返回_422(self) -> None:
        assert build_client().post(EXPLAIN_URL, json={}).status_code == 422

    def test_超长_selection_返回_422(self) -> None:
        response = build_client().post(EXPLAIN_URL, json={"selection": "x" * 5000})

        assert response.status_code == 422

    def test_语言为空时回落默认(self) -> None:
        response = build_client().post(EXPLAIN_URL, json=payload(language="   "))

        assert response.status_code == 200

    def test_上游失败返回_502(self) -> None:
        response = build_client(FailingLLMClient()).post(EXPLAIN_URL, json=payload())

        assert response.status_code == 502
        assert "上游不可用" in response.json()["detail"]

    def test_与翻译接口互不影响(self) -> None:
        client = build_client()

        explained = client.post(EXPLAIN_URL, json=payload())
        translated = client.post(
            "/api/v1/translate",
            json={"target_language": "zh-CN", "items": [{"id": "b1", "text": "Hello."}]},
        )

        assert explained.status_code == 200
        assert translated.status_code == 200
        # 解释返回的是自由文本，翻译返回的是结构化条目
        assert "explanation" in explained.json()
        assert "items" in translated.json()


class TestExplainPrompts:
    def test_system_prompt_填入目标语言(self) -> None:
        prompt = build_explain_system_prompt("ja")

        assert "ja" in prompt
        assert "{language}" not in prompt

    def test_system_prompt_要求简洁且不加前言(self) -> None:
        prompt = build_explain_system_prompt("zh-CN")

        assert "Be concise" in prompt
        assert "preamble" in prompt

    def test_user_prompt_包住选中文本(self) -> None:
        prompt = build_explain_user_prompt(selection="RAG", context=None)

        assert "<selection>" in prompt
        assert "RAG" in prompt
        assert "<context>" not in prompt

    def test_user_prompt_带上下文(self) -> None:
        prompt = build_explain_user_prompt(selection="RAG", context="  Some context.  ")

        assert "<context>" in prompt
        assert "Some context." in prompt

    def test_空白上下文不产生空标签(self) -> None:
        prompt = build_explain_user_prompt(selection="RAG", context="   ")

        assert "<context>" not in prompt

    def test_超长上下文被截断(self) -> None:
        prompt = build_explain_user_prompt(selection="RAG", context="x" * 5000)

        assert len(prompt) < MAX_CONTEXT_CHARS + 200

    def test_选中文本两端空白被去掉(self) -> None:
        prompt = build_explain_user_prompt(selection="  RAG  ", context=None)

        assert "<selection>\nRAG\n</selection>" in prompt


class TestMockExplain:
    def test_mock_解释带确定性前缀(self) -> None:
        client = MockLLMClient()
        messages = [
            ChatMessage(role="system", content="whatever"),
            ChatMessage(role="user", content="<selection>RAG</selection>"),
        ]

        import asyncio

        raw = asyncio.run(client.complete(messages))

        assert raw == f"{MOCK_EXPLAIN_PREFIX}RAG"

    def test_没有_selection_时仍走翻译路径(self) -> None:
        """回归防线：加了 explain 分支后，翻译路径不能被误判。"""
        client = MockLLMClient()
        messages = [
            ChatMessage(role="system", content="whatever"),
            ChatMessage(
                role="user",
                content='<items>\n[{"id":"b1","text":"Hello."}]\n</items>',
            ),
        ]

        import asyncio

        raw = asyncio.run(client.complete(messages))

        assert "translations" in raw
        assert MOCK_EXPLAIN_PREFIX not in raw
