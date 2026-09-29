"""学习笔记接口测试（方案第 32 节）。"""

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.api.v1.deps import get_llm_client, get_summary_llm_client
from app.clients.base import ChatMessage, Completion, LLMError
from app.clients.mock import MOCK_NOTE_PREFIX, MockLLMClient
from app.main import app
from app.prompts.note import MIN_ARTICLE_CHARS, NOTE_PROMPT_VERSION
from app.schemas.note import NoteRequest, NoteResponse
from app.services.note_service import NoteFailedError, NoteService

NOTE_URL = "/api/v1/note"

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

    def complete_stream(self, messages: list[ChatMessage], *, json_mode: bool = False):
        raise NotImplementedError


class FailingLLMClient:
    model_name = "failing"

    async def complete(self, messages: list[ChatMessage], *, json_mode: bool = False) -> str:
        raise LLMError("上游不可用", retryable=True)

    async def complete_with_usage(
        self, messages: list[ChatMessage], *, json_mode: bool = False
    ) -> Completion:
        raise LLMError("上游不可用", retryable=True)

    def complete_stream(self, messages: list[ChatMessage], *, json_mode: bool = False):
        raise LLMError("上游不可用", retryable=True)


def build_client(client: object | None = None) -> TestClient:
    # 笔记与总结共用「理解型」客户端，两个依赖都要覆盖
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


def make_note(raw: str) -> NoteResponse:
    service = NoteService(ScriptedLLMClient(raw))
    request = NoteRequest.model_validate(payload())

    return asyncio.run(service.make_note(request))


class TestNoteEndpoint:
    def test_正常返回完整笔记(self) -> None:
        response = build_client().post(NOTE_URL, json=payload())

        assert response.status_code == 200
        body = response.json()

        assert body["positioning"].startswith(MOCK_NOTE_PREFIX)
        assert len(body["concepts"]) == 2
        assert len(body["outline"]) == 2
        assert len(body["takeaways"]) == 2
        assert body["prompt_version"] == NOTE_PROMPT_VERSION
        assert body["model"]

    def test_概念是键值对而不是一列要点(self) -> None:
        """学习笔记最有价值的部分是「术语 → 解释」这个映射。"""
        body = build_client().post(NOTE_URL, json=payload()).json()

        for concept in body["concepts"]:
            assert set(concept) == {"term", "explanation"}
            assert concept["term"]
            assert concept["explanation"]

    def test_大纲保留分节(self) -> None:
        body = build_client().post(NOTE_URL, json=payload()).json()

        for section in body["outline"]:
            assert section["heading"]
            assert len(section["points"]) > 0

    def test_正文过短返回_422(self) -> None:
        response = build_client().post(NOTE_URL, json={"text": "x" * (MIN_ARTICLE_CHARS - 1)})

        assert response.status_code == 422

    def test_缺少正文返回_422(self) -> None:
        assert build_client().post(NOTE_URL, json={}).status_code == 422

    def test_上游失败返回_502(self) -> None:
        response = build_client(FailingLLMClient()).post(NOTE_URL, json=payload())

        assert response.status_code == 502
        assert "上游不可用" in response.json()["detail"]

    def test_与总结互不影响(self) -> None:
        client = build_client()

        note = client.post(NOTE_URL, json=payload())
        summary = client.post("/api/v1/summary", json=payload())

        assert note.status_code == 200
        assert summary.status_code == 200
        # 两者的字段完全不同——这正是它们不共用 Prompt 的原因
        assert "positioning" in note.json()
        assert "gist" in summary.json()
        assert "gist" not in note.json()


class TestNoteParsing:
    """模型输出畸形时的行为。

    尺度与总结一致：**只有定位缺失才报错，其余字段宽容**。
    笔记比总结更长，因为某一节格式不对就整篇失败，代价太高。
    """

    def test_缺少_positioning_报错(self) -> None:
        with pytest.raises(NoteFailedError, match="positioning"):
            make_note('{"concepts": []}')

    def test_positioning_为空白报错(self) -> None:
        with pytest.raises(NoteFailedError, match="positioning"):
            make_note('{"positioning": "   "}')

    def test_非法_json_报错(self) -> None:
        with pytest.raises(NoteFailedError, match="JSON"):
            make_note("抱歉，我无法完成这个请求。")

    def test_顶层不是对象报错(self) -> None:
        with pytest.raises(NoteFailedError, match="对象"):
            make_note('["positioning"]')

    def test_只有定位也能返回(self) -> None:
        note = make_note('{"positioning": "一句话定位"}')

        assert note.positioning == "一句话定位"
        assert note.concepts == []
        assert note.outline == []
        assert note.takeaways == []

    def test_概念缺字段时被丢弃(self) -> None:
        raw = (
            '{"positioning": "定位", "concepts": ['
            '{"term": "好", "explanation": "解释"},'
            '{"term": "缺解释"},'
            '{"explanation": "缺术语"},'
            '"不是对象",'
            '{"term": "  ", "explanation": "空术语"}'
            "]}"
        )

        note = make_note(raw)

        assert [c.term for c in note.concepts] == ["好"]

    def test_大纲缺标题或要点时被丢弃(self) -> None:
        raw = (
            '{"positioning": "定位", "outline": ['
            '{"heading": "好", "points": ["要点"]},'
            '{"heading": "", "points": ["要点"]},'
            '{"heading": "没有要点", "points": []},'
            '{"heading": "要点非数组", "points": "不是数组"}'
            "]}"
        )

        note = make_note(raw)

        assert [s.heading for s in note.outline] == ["好"]

    def test_要点里的非字符串被丢弃(self) -> None:
        raw = '{"positioning": "定位", "outline": [{"heading": "节", "points": ["好", 42, null, "  ", "也行"]}]}'

        note = make_note(raw)

        assert note.outline[0].points == ["好", "也行"]

    def test_结论非数组时返回空(self) -> None:
        note = make_note('{"positioning": "定位", "takeaways": "不是数组"}')

        assert note.takeaways == []

    def test_两端空白被去掉(self) -> None:
        note = make_note('{"positioning": "  定位  ", "takeaways": ["  结论  "]}')

        assert note.positioning == "定位"
        assert note.takeaways == ["结论"]


class TestMockNote:
    def test_mock_笔记结构合法(self) -> None:
        import json

        client = MockLLMClient()
        messages = [
            ChatMessage(role="system", content="You are a reading assistant. study notes"),
            ChatMessage(role="user", content="<article>Some article text.</article>"),
        ]

        parsed = json.loads(asyncio.run(client.complete(messages, json_mode=True)))

        assert parsed["positioning"].startswith(MOCK_NOTE_PREFIX)
        assert parsed["concepts"]
        assert parsed["outline"]

    def test_没有笔记标记时仍走总结路径(self) -> None:
        """回归防线：笔记与总结共用 `<article>` 块，靠 system prompt 区分。"""
        import json

        client = MockLLMClient()
        messages = [
            ChatMessage(role="system", content="You are a reading assistant."),
            ChatMessage(role="user", content="<article>Some article text.</article>"),
        ]

        parsed = json.loads(asyncio.run(client.complete(messages, json_mode=True)))

        # 走的是总结：有 gist，没有 positioning
        assert "gist" in parsed
        assert "positioning" not in parsed
