"""翻译接口测试（方案第 16.2 节、第 86.5 节）。"""

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api.v1.translate import get_llm_client
from app.clients.mock import MOCK_PREFIX, MockLLMClient
from app.core.config import MockMode
from app.main import app
from app.prompts.translation import PROMPT_VERSION


def build_client(mode: MockMode = "ok") -> TestClient:
    """构造注入了 Mock LLM 客户端的测试客户端。

    用依赖覆盖而不是真客户端——测试绝不发起网络请求（方案第 86.9 节）。
    """
    app.dependency_overrides[get_llm_client] = lambda: MockLLMClient(mode=mode)
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_overrides() -> Iterator[None]:
    yield
    app.dependency_overrides.clear()


def make_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "target_language": "zh-CN",
        "style": "technical",
        "items": [
            {"id": "block-001", "text": "AI engineering is changing software development."},
            {"id": "block-002", "text": "Read the <0>documentation</0> first."},
            {"id": "block-003", "text": "Line one<0/>Line two."},
        ],
    }
    payload.update(overrides)
    return payload


class TestTranslateSuccess:
    def test_三个条目返回三个结果且_id_一一对应(self) -> None:
        response = build_client().post("/api/v1/translate", json=make_payload())

        assert response.status_code == 200
        body = response.json()
        assert [item["id"] for item in body["items"]] == [
            "block-001",
            "block-002",
            "block-003",
        ]

    def test_回填原文与译文(self) -> None:
        body = build_client().post("/api/v1/translate", json=make_payload()).json()
        first = body["items"][0]

        assert first["source"] == "AI engineering is changing software development."
        assert first["translation"] == MOCK_PREFIX + first["source"]

    def test_成对占位符原样保留(self) -> None:
        body = build_client().post("/api/v1/translate", json=make_payload()).json()

        assert "<0>documentation</0>" in body["items"][1]["translation"]

    def test_原子占位符原样保留(self) -> None:
        body = build_client().post("/api/v1/translate", json=make_payload()).json()

        assert "<0/>" in body["items"][2]["translation"]

    def test_响应含_prompt_version_与_model(self) -> None:
        body = build_client().post("/api/v1/translate", json=make_payload()).json()

        assert body["prompt_version"] == PROMPT_VERSION
        assert body["model"] == "mock"

    def test_context_id_原样回传(self) -> None:
        payload = make_payload(context_id="art-001", context="Full article context.")
        body = build_client().post("/api/v1/translate", json=payload).json()

        assert body["context_id"] == "art-001"

    def test_无_context_id_时为_null(self) -> None:
        body = build_client().post("/api/v1/translate", json=make_payload()).json()

        assert body["context_id"] is None

    def test_单条目也能工作(self) -> None:
        payload = make_payload(items=[{"id": "block-001", "text": "Hello world."}])
        response = build_client().post("/api/v1/translate", json=payload)

        assert response.status_code == 200
        assert len(response.json()["items"]) == 1


class TestTranslateFailure:
    """失败时必须返回明确错误，且**不返回半结构化内容**（方案第 72 节）。"""

    def test_缺占位符返回_502(self) -> None:
        response = build_client("drop-placeholder").post("/api/v1/translate", json=make_payload())

        assert response.status_code == 502
        assert "占位符" in response.json()["detail"]

    def test_缺_id返回_502(self) -> None:
        response = build_client("missing-id").post("/api/v1/translate", json=make_payload())

        assert response.status_code == 502
        assert "block-003" in response.json()["detail"]

    def test_重复_id返回_502(self) -> None:
        response = build_client("duplicate-id").post("/api/v1/translate", json=make_payload())

        assert response.status_code == 502
        assert "重复" in response.json()["detail"]

    def test_非_JSON_输出返回_502(self) -> None:
        response = build_client("invalid-json").post("/api/v1/translate", json=make_payload())

        assert response.status_code == 502
        assert "结构校验失败" in response.json()["detail"]

    def test_非_JSON_输出的报错可读(self) -> None:
        """不应把 Pydantic 的调试信息（input_value 等）直接透给调用方。"""
        response = build_client("invalid-json").post("/api/v1/translate", json=make_payload())
        detail = response.json()["detail"]

        assert "模型输出不符合约定结构" in detail
        assert "input_value" not in detail

    def test_失败时不返回任何条目(self) -> None:
        response = build_client("missing-id").post("/api/v1/translate", json=make_payload())

        assert "items" not in response.json()

    def test_失败信息说明已重试次数(self) -> None:
        response = build_client("missing-id").post("/api/v1/translate", json=make_payload())

        assert "已尝试 2 次" in response.json()["detail"]


class TestRequestValidation:
    """请求本身的校验交给 Pydantic，返回 422。"""

    def test_空_items_被拒(self) -> None:
        response = build_client().post("/api/v1/translate", json=make_payload(items=[]))

        assert response.status_code == 422

    def test_缺少_items_被拒(self) -> None:
        response = build_client().post("/api/v1/translate", json={"target_language": "zh-CN"})

        assert response.status_code == 422

    def test_条目缺少_text_被拒(self) -> None:
        payload = make_payload(items=[{"id": "block-001"}])
        response = build_client().post("/api/v1/translate", json=payload)

        assert response.status_code == 422

    def test_未知风格被拒(self) -> None:
        response = build_client().post("/api/v1/translate", json=make_payload(style="poetic"))

        assert response.status_code == 422

    def test_未知字段被忽略(self) -> None:
        """Pydantic 默认忽略多余字段——扩展端升级时不会因此报错。"""
        payload = make_payload(unknown_field="whatever")
        response = build_client().post("/api/v1/translate", json=payload)

        assert response.status_code == 200
